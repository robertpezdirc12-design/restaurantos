/**
 * Issue #13 (P1/P2, v1.110.0) — javni rezervacijski widget (/r/<token>):
 * ČISTI terminski motor (brez DB) — en vir resnice za javni API, testno
 * pokritost in (posredno) UI.
 *
 * Načrt (enak kot haccp-ops.ts):
 *  - VSI časi so izraženi v LOKALNEM pasu lokacije (Location.timezone,
 *    privzeto Europe/Ljubljana) — ne v pasu strežnika. Termin (dateKey +
 *    "HH:MM") se v UTC trenutek prevede z zonedTimeToUtc (DST-varno).
 *  - Odpiralni čas: tedenske vrstice + posebni dnevi (SpecialOpeningDay),
 *    enaka semantika kot outsideHoursFor (poseben dan NADOMESTI tedensko
 *    vrstico; isClosed = zaprto).
 *  - FAIL-CLOSED: dan brez podatka o odpiralnem času = ZAPRTO za spletno
 *    rezervacijo (interni POS lahko rezervira "brez omejitve", javni gost
 *    pa ne sme videti terminov, za katere ne vemo, kdaj je lokal odprt —
 *    ureditev urnika v zavihku Urniki takoj odpre widget).
 *  - Kapaciteta: seštevek sedežev vseh miz lokacije (fizikalna resnica),
 *    neobvezno prekrito s policy.maxCoversPerSlot (> 0). Obsegli termin =
 *    dejavna rezervacija (confirmed/seated), katere interval [start,
 *    start+duration] se prekriva s terminskim intervalom [t, t+dur).
 *  - Termin mreža: korak slotMinutes od odpiralnega časa (zaokroženo NAVZGOR
 *    na mrežo), zadnji termin dopušča celotno trajanje (t+dur <= closeMin;
 *    overnight closeMin > 1440 je podprt, termini čez polnoči pripadajo
 *    naslednjemu koledarskemu dnevu).
 *  - Trajanje javne rezervacije je FIKSNO 120 min (standardni obrat mize);
 *    osebje lahko trajanje naknadno prilagodi v POS.
 *  - Lead time: termin mora biti vsaj policy.leadMinutes v prihodnosti.
 *  - Napoved: slotMinutes ≤ 0 ali urnik brez podatka → closed (nikoli lažje
 *    "vse prosto" brez podatka).
 */

import { zonedDateParts, zonedTimeToUtc, localDateKey, type LocalDate } from './haccp-ops'
import type { OpeningRow, SpecialDay, ValidatedRow } from './openinghours'
import { DAY_NAMES_SL, parseHHMM } from './openinghours'

/** Privzete vrednosti politike (poravnane z DDL defaulti ReservationWidget). */
export const WIDGET_POLICY_DEFAULTS = {
  slotMinutes: 30,
  minParty: 1,
  maxParty: 12,
  leadMinutes: 60,
  maxAdvanceDays: 30,
  maxCoversPerSlot: 0, // 0 = dinamično (seštevek sedežev)
} as const

export interface WidgetPolicy {
  slotMinutes: number
  minParty: number
  maxParty: number
  leadMinutes: number
  maxAdvanceDays: number
  maxCoversPerSlot: number
}

/** Trajanje javne rezervacije (min) — fiksno, dokumentirano v API. */
export const PUBLIC_RESERVATION_DURATION_MIN = 120

/** Statični dan za izračun terminov (posredovan iz baze, brez DB tu). */
export interface DayHoursInput {
  /** tedenske vrstice lokacije (ali org default) */
  rows: OpeningRow[]
  /** posebni dnevi (nadomestijo tedensko vrstico za svoj datum) */
  specials: SpecialDay[]
}

/** Dejavna (kapaciteto zasedajoča) rezervacija na dan — interval v UTC. */
export interface ExistingReservation {
  start: Date
  durationMin: number
  partySize: number
  status: string
}

export interface SlotInfo {
  /** "HH:MM" v lokalnem pasu lokacije */
  time: string
  /** UTC trenutek začetka termina */
  start: Date
  /** ali je termin na voljo za izbrano št. oseb */
  available: boolean
  /** preostala mesta (kapaciteta − obsežene dezelve) */
  remaining: number
}

export interface SlotsForDateResult {
  dateKey: string
  /** ali je lokal tisti dan odprt (imamo urnik) */
  open: boolean
  /** razlog zaprtosti / opomba posebnega dneva (lokalizira UI) */
  note: string
  /** cela kapaciteta termina (mesta) */
  capacity: number
  slots: SlotInfo[]
}

/* ─────────────────── pomožniki (čisti) ─────────────────── */

/** Normalizira tedenske vrstice v minute (isti ključ kot openinghours). */
function normalizeRows(rows: OpeningRow[]): Map<number, { openMin: number; closeMin: number; breakStart: number | null; breakEnd: number | null; closed: boolean; label: string }> {
  const map = new Map()
  for (const r of rows) {
    const o = parseHHMM(r.openTime)
    const c = parseHHMM(r.closeTime)
    if (o === null || c === null) continue
    const closeMin = c <= o ? c + 1440 : c // overnight
    let bs: number | null = null
    let be: number | null = null
    if (r.breakStart && r.breakEnd) {
      bs = parseHHMM(r.breakStart)
      be = parseHHMM(r.breakEnd)
      if (bs === null || be === null) { bs = null; be = null }
    }
    map.set(Number(r.dayOfWeek), { openMin: o, closeMin, breakStart: bs, breakEnd: be, closed: !!r.isClosed, label: `${r.openTime}–${r.closeTime}` })
  }
  return map
}

function specialForDate(specials: SpecialDay[], dateKey: string): SpecialDay | null {
  for (const s of specials) if (s.date === dateKey) return s
  return null
}

/** Intervalna prekrivnost [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. */
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** Vsota strank obseženih rezervacij za terminski interval [t, t+dur). */
function coversAt(reservations: ExistingReservation[], slotStartUtc: Date, durMin: number): number {
  const s = slotStartUtc.getTime()
  const e = s + durMin * 60_000
  let covers = 0
  for (const r of reservations) {
    if (r.status !== 'confirmed' && r.status !== 'seated') continue
    const rs = r.start.getTime()
    const re = rs + r.durationMin * 60_000
    if (intervalsOverlap(s, e, rs, re)) covers += r.partySize
  }
  return covers
}

/** Dan v tednu (0 = nedelja, konvencija OpeningRow) za lokalni datum v pasu. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()
}

/**
 * Terminska mreža za en dan. Vhod brez DB (rows/specials/reservations so
 * prebrani v rutu); now = trenutek strežnika; timeZone = pas lokacije.
 */
export function slotsForDate(
  policy: WidgetPolicy,
  hours: DayHoursInput,
  dateKey: string,
  now: Date,
  reservations: ExistingReservation[],
  tableSeatsTotal: number,
  timeZone: string,
): SlotsForDateResult {
  const slotMinutes = Math.max(5, Math.round(policy.slotMinutes || 0))
  const duration = PUBLIC_RESERVATION_DURATION_MIN

  // datum → LocalDate (dateKey je že "YYYY-MM-DD" v pasu lokacije)
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return { dateKey, open: false, note: '', capacity: 0, slots: [] }
  const date: LocalDate = { y, m, d }
  const dow = weekdayOf(date)

  // 1) okno dneva: poseben dan > tedenska vrstica
  const special = specialForDate(hours.specials, dateKey)
  let openMin: number
  let closeMin: number
  let breakStart: number | null = null
  let breakEnd: number | null = null
  let note = ''
  if (special) {
    if (special.isClosed) {
      return { dateKey, open: false, note: special.note || 'closed_special', capacity: 0, slots: [] }
    }
    const o = parseHHMM(special.openTime)
    const c = parseHHMM(special.closeTime)
    if (o === null || c === null) {
      return { dateKey, open: false, note: 'invalid_special_hours', capacity: 0, slots: [] }
    }
    openMin = o
    closeMin = c <= o ? c + 1440 : c
    note = special.note || ''
  } else {
    const row = normalizeRows(hours.rows).get(dow)
    if (!row || row.closed) {
      return { dateKey, open: false, note: row?.closed ? DAY_NAMES_SL[dow] : 'no_hours', capacity: 0, slots: [] }
    }
    openMin = row.openMin
    closeMin = row.closeMin
    breakStart = row.breakStart
    breakEnd = row.breakEnd
  }

  // 2) kapaciteta: override ali seštevek sedežev
  const capacity = policy.maxCoversPerSlot > 0 ? Math.floor(policy.maxCoversPerSlot) : Math.max(0, Math.floor(tableSeatsTotal))

  // 3) mreža terminov: prvi termin na mreži ≥ openMin; zadnji dopušča dur
  const slots: SlotInfo[] = []
  const firstSlot = Math.ceil(openMin / slotMinutes) * slotMinutes
  for (let t = firstSlot; t + duration <= closeMin; t += slotMinutes) {
    const start = zonedTimeToUtc(y, m, d, Math.floor(t / 60), t % 60, timeZone)
    // odmor: celoten interval termina mora biti izven odmora
    if (breakStart !== null && breakEnd !== null) {
      const bs = breakStart
      const be = breakEnd <= breakStart ? breakEnd + 1440 : breakEnd
      if (intervalsOverlap(t, t + duration, bs, be)) continue
    }
    // lead time (UTC primerjava — DST-varno)
    if (start.getTime() < now.getTime() + policy.leadMinutes * 60_000) continue
    const remaining = capacity - coversAt(reservations, start, duration)
    slots.push({
      time: `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
      start,
      available: remaining > 0,
      remaining: Math.max(0, remaining),
    })
  }

  return { dateKey, open: true, note, capacity, slots }
}

/**
 * Ali je izbrani termin (dateKey + "HH:MM") veljaven in prost za partySize.
 * Vrača { ok } ali { ok: false, code } — kode: slot_not_on_grid, slot_unavailable,
 * slot_past (lead time), day_closed, date_out_of_range.
 * Ta funkcija je STROGA resnica za POST /api/public/reservations (gost ne
 * more rezervirati termina, ki ga plošča ni pokazala kot prostega).
 */
export function validateSlot(
  policy: WidgetPolicy,
  hours: DayHoursInput,
  dateKey: string,
  timeHHMM: string,
  partySize: number,
  now: Date,
  reservations: ExistingReservation[],
  tableSeatsTotal: number,
  timeZone: string,
): { ok: true; start: Date; remaining: number } | { ok: false; code: string; message: string } {
  // datum v oknu [danes, +maxAdvanceDays] (v pasu lokacije)
  const today = zonedDateParts(now, timeZone)
  const todayKey = localDateKey(today)
  if (dateKey < todayKey) return { ok: false, code: 'date_in_past', message: 'Datum je v preteklosti.' }
  const maxDate = new Date(Date.UTC(today.y, today.m - 1, today.d + Math.max(0, Math.floor(policy.maxAdvanceDays))))
  if (dateKey > localDateKey({ y: maxDate.getUTCFullYear(), m: maxDate.getUTCMonth() + 1, d: maxDate.getUTCDate() })) {
    return { ok: false, code: 'date_out_of_range', message: `Rezervacije so možne največ ${policy.maxAdvanceDays} dni vnaprej.` }
  }

  const result = slotsForDate(policy, hours, dateKey, now, reservations, tableSeatsTotal, timeZone)
  if (!result.open) return { ok: false, code: 'day_closed', message: 'Ta dan je zaprt.' }

  const slot = result.slots.find((s) => s.time === timeHHMM)
  if (!slot) {
    // izpadel je zaradi odmora / lead time / zasedenosti mreže — enoten SL niz,
    // brez razkrivanja internih razlogov (gost vidi le "ni na voljo")
    return { ok: false, code: 'slot_not_available', message: result.slots.length === 0 ? 'Ni prostih terminov za ta dan.' : 'Termin ni na voljo.' }
  }
  if (slot.remaining < partySize) {
    return { ok: false, code: 'slot_unavailable', message: 'Termin je žal zaseden.' }
  }
  return { ok: true, start: slot.start, remaining: slot.remaining }
}

/** Če je treba dan še vedno izpisati po pogojih — lista naslednjih odprtih datumov (chip dnevi). */
export function nextOpenDateKeys(
  policy: WidgetPolicy,
  hours: DayHoursInput,
  now: Date,
  timeZone: string,
  maxDays = 14,
): string[] {
  const today = zonedDateParts(now, timeZone)
  const keys: string[] = []
  for (let off = 0; off < maxDays; off++) {
    const d = new Date(Date.UTC(today.y, today.m - 1, today.d + off))
    keys.push(localDateKey({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }))
  }
  return keys.filter((k) => {
    const r = slotsForDate(policy, hours, k, now, [], Number.MAX_SAFE_INTEGER / 2, timeZone)
    return r.slots.length > 0
  })
}

/* ─────────────────── sanitizacija javnega odgovora ─────────────────── */

/** Javni odgovor GET — brez gostovih PII, brez internih ID-jev. */
export function publicSlotsPayload(restaurant: string, result: SlotsForDateResult, policy: WidgetPolicy) {
  return {
    restaurant,
    date: result.dateKey,
    open: result.open,
    note: result.note,
    capacity: result.capacity,
    durationMinutes: PUBLIC_RESERVATION_DURATION_MIN,
    policy: { minParty: policy.minParty, maxParty: policy.maxParty, maxAdvanceDays: policy.maxAdvanceDays },
    slots: result.slots.map((s) => ({ time: s.time, available: s.available, remaining: s.remaining })),
  }
}

export type { OpeningRow, SpecialDay, ValidatedRow }
