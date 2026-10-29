/**
 * P3 #20 (v1.193.0) — SEAT-LEVEL management (raven sedeža, Square vzorec).
 *
 * Čist, determinističen sloj (BREZ uvoza db — testirljiv s čistimi enotami brez baze):
 *  1. `parseSeatAssignments` — validacija načrta sedežev iz telesa zahteve
 *     (polni nadomestni semantiki: omenjene postavke dobijo sedež, neomenjene
 *     ga izgubijo — odjemalec pošlje CELoten načrt, idempotentno in napovedljivo).
 *  2. `seatOverview` — pregled po sedežih (ne-voided postavke, sedeži naraščajoče,
 *     »brez sedeža« ZADNJI; vsote r2).
 *  3. `buildSeatSplitPlan` — načrt za split izstavkov PO SEDEŽIH: vsak uporabljen
 *     sedež dobi svoj izstavek, neodeljene postavke ostanejo na baznem izstavku #1.
 *     Deterministično: sedeži naraščajoče, postavke znotraj sedeža po id.
 *
 * Meje (iskreno):
 *  - sedež je oznaka IZVORA postavke (kdo jo je naročil), ortogonalna checkId
 *    (izstavek = plačilna skupina) — dodelitev sedeža ne premika izstavkov;
 *  - split po sedežih PREBALANSIRA obstoječe neplačane izstavke (isti vzorec kot
 *    split po gostih v1.185.0) — zgubi prejšnjo ročno razdelitev izstavkov;
 *  - brez AI (vse deterministično), brez pravnih trditev, brez nove odvisnosti.
 */

export const MIN_SEAT = 1
export const MAX_SEAT = 10

export interface SeatAssignmentEntry {
  seat: number
  itemIds: string[]
}

export type SeatPlanParseResult =
  | { ok: true; assignments: SeatAssignmentEntry[] }
  | { ok: false; error: string }

/**
 * Validira telo `{ assignments: [{ seat, itemIds }] }`.
 *  - `assignments` je seznam (prazen = počisti vse sedeže — veljavno);
 *  - `seat` celo število v [MIN_SEAT..MAX_SEAT];
 *  - `itemIds` neprazen seznam nepraznih nizov (obrezanih);
 *  - vsaka postavka v NAJVEČ ENEM sedežu (prekříženi vnosi = 400, napaka odjemalca).
 */
export function parseSeatAssignments(body: unknown): SeatPlanParseResult {
  const raw = (body as { assignments?: unknown } | null)?.assignments
  if (!Array.isArray(raw)) return { ok: false, error: 'assignments (seznam dodelitev) je obvezen.' }

  const seen = new Map<string, number>()
  const assignments: SeatAssignmentEntry[] = []

  for (const entry of raw) {
    const seatRaw = (entry as { seat?: unknown } | null)?.seat
    const seat = Number(seatRaw)
    if (!Number.isInteger(seat) || seat < MIN_SEAT || seat > MAX_SEAT) {
      return { ok: false, error: `seat mora biti celo število med ${MIN_SEAT} in ${MAX_SEAT}.` }
    }
    const idsRaw = (entry as { itemIds?: unknown }).itemIds
    if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
      return { ok: false, error: 'itemIds (neprazen seznam postavk) je obvezen za vsak sedež.' }
    }
    const itemIds: string[] = []
    for (const id of idsRaw) {
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, error: 'itemIds vsebuje neveljaven vnos (prazen ali ne-niz).' }
      }
      const trimmed = id.trim()
      if (itemIds.includes(trimmed)) {
        return { ok: false, error: `Postavka ${trimmed} je v sedežu ${seat} navedena dvakrat.` }
      }
      const priorSeat = seen.get(trimmed)
      if (priorSeat !== undefined && priorSeat !== seat) {
        return { ok: false, error: `Postavka ${trimmed} je dodeljena več sedežem (${priorSeat} in ${seat}).` }
      }
      seen.set(trimmed, seat)
      itemIds.push(trimmed)
    }
    assignments.push({ seat, itemIds })
  }
  return { ok: true, assignments }
}

/**
 * N-27-1 (v1.195.0) — OPACIONALNI sedež pri naročanju: `addItems[i].seat`
 * (aktivni sedež tok — natakar izbere sedež, dodane postavke ga nosijo).
 *  - undefined / null / prazen niz → `{ ok: true, seat: null }` (BREZ sedeža —
 *    obstoječi klienti brez polja ostanejo nespremenjeni — nič tihe spremembe);
 *  - celo število v [MIN_SEAT..MAX_SEAT] → sedež;
 *  - karkoli drugega (0, 11, 1.5, 'abc') → napaka (400 na ruti, ne tihe ignoriranje).
 */
export type SeatOptionParseResult =
  | { ok: true; seat: number | null }
  | { ok: false; error: string }

export function parseSeatOption(value: unknown): SeatOptionParseResult {
  if (value === undefined || value === null || value === '') return { ok: true, seat: null }
  const n = Number(value)
  if (!Number.isInteger(n) || n < MIN_SEAT || n > MAX_SEAT) {
    return { ok: false, error: `seat mora biti celo število med ${MIN_SEAT} in ${MAX_SEAT} ali pa izpuščen (brez sedeža).` }
  }
  return { ok: true, seat: n }
}

/* ───────────────────────── pregled po sedežih ───────────────────────── */

export interface SeatOverviewItem {
  id: string
  name: string
  quantity: number
  price: number
  seat: number | null
  voided: boolean
}

export interface SeatGroup {
  /** null = postavke brez dodeljenega sedeža (izpisane ZADNJE) */
  seat: number | null
  itemIds: string[]
  items: number
  total: number
}

/** Pregled po sedežih za UI: ne-voided postavke, skupine po sedežu (naraščajoče,
 *  null zadnji), znotraj skupine po id — deterministično. Vsota = r2(Σ količina × cena). */
export function seatOverview(items: SeatOverviewItem[]): SeatGroup[] {
  const buckets = new Map<number | 'none', { itemIds: string[]; total: number }>()
  for (const it of items) {
    if (it.voided) continue
    const key = it.seat === null ? 'none' : it.seat
    const b = buckets.get(key) ?? { itemIds: [], total: 0 }
    b.itemIds.push(it.id)
    b.total += it.quantity * it.price
    buckets.set(key, b)
  }
  const seats = [...buckets.keys()].filter((k): k is number => k !== 'none').sort((a, b) => a - b)
  const out: SeatGroup[] = []
  for (const s of seats) {
    const b = buckets.get(s)!
    out.push({ seat: s, itemIds: [...b.itemIds].sort((x, y) => x.localeCompare(y)), items: b.itemIds.length, total: r2Local(b.total) })
  }
  const none = buckets.get('none')
  if (none && none.itemIds.length > 0) {
    out.push({ seat: null, itemIds: [...none.itemIds].sort((x, y) => x.localeCompare(y)), items: none.itemIds.length, total: r2Local(none.total) })
  }
  return out
}

/* ───────────────────────── načrt splita po sedežih ───────────────────────── */

export interface SeatSplitItem {
  id: string
  quantity: number
  price: number
  seat: number | null
  voided: boolean
}

export type SeatSplitPlanResult =
  | {
      ok: true
      /** uporabljeni sedeži naraščajoče; znotraj sedeža postavke po id */
      groups: { seat: number; itemIds: string[]; total: number }[]
      /** postavke brez sedeža (ostanejo na baznem izstavku #1), po id */
      unassignedItemIds: string[]
    }
  | { ok: false; error: string }

/** Zahteva ZA vsaj dva zasedena sedeža — z enim ni ničesar razdeliti (409, ne 200-noop). */
export function buildSeatSplitPlan(items: SeatSplitItem[]): SeatSplitPlanResult {
  const bySeat = new Map<number, { itemIds: string[]; total: number }>()
  const unassigned: string[] = []
  for (const it of items) {
    if (it.voided) continue
    if (it.seat === null) {
      unassigned.push(it.id)
      continue
    }
    const b = bySeat.get(it.seat) ?? { itemIds: [], total: 0 }
    b.itemIds.push(it.id)
    b.total += it.quantity * it.price
    bySeat.set(it.seat, b)
  }
  if (bySeat.size < 2) {
    return { ok: false, error: 'Razdelitev po sedežih zahteva vsaj dva zasedena sedeža — postavke najprej dodeli sedežem.' }
  }
  const seats = [...bySeat.keys()].sort((a, b) => a - b)
  return {
    ok: true,
    groups: seats.map((s) => {
      const b = bySeat.get(s)!
      return { seat: s, itemIds: [...b.itemIds].sort((x, y) => x.localeCompare(y)), total: r2Local(b.total) }
    }),
    unassignedItemIds: unassigned.sort((x, y) => x.localeCompare(y)),
  }
}

/* ───────────────────────── lokalni pomožniki (brez uvoza map.ts — čista plast) ───────────────────────── */

/** Zaokroži na 2 decimalki (denar) — ista aritmetika kot src/lib/map.ts r2. */
function r2Local(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}
