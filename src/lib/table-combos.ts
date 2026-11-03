/**
 * v1.245.0 (PRIMERJAVA-VMESNIKOV-2026 §19) — KOMBINACIJSKI VAL.
 *
 * Industrijska referenca: Lightspeed november 2026 (»Optimize dining room
 * capacity and seat larger groups effortlessly«) — »Automatic table
 * combinations let you seamlessly welcome larger parties« + Toast/OpenTable
 * table joining: družina 10 oseb na lokaciji, kjer je največja miza
 * 6 sedežev, je prej slišala »nimate mize za 10«; zdaj rezervacijski sistem
 * ponudi registrirano kombinacijo (Miza 5+6 = 8 sedežev).
 *
 * DVE plasti tega modula:
 *  1. REGISTR kombinacij (0 DDL): Integration vrstica name='table-combos-config'
 *     per lokacija — [{ id, tableIds }] (mize, ki jih osebje lahko rezervira
 *     SKUPAJ). Validacija ob pisanju (≥ 2 mize, vse iz iste lokacije);
 *     branje je defenzivno (jparse + filter neveljavnih).
 *  2. REZERVABILNE MIZE (0 DDL, walk-in rezerva — Lightspeed »choose specific
 *     bookable tables to preserve space for walk-ins«): Integration vrstica
 *     name='resv-bookable-config' — { excludedTableIds }: mize, ki se NE
 *     štejejo v spletno kapaciteto terminov (ostanejo za walk-in goste).
 *     Interna pot (telefon) NI omejena — samo spletna plast.
 *
 * KOMBINACIJSKA REZERVACIJA (DDL, mig ruta reservation-combo): Reservation
 * .comboTableIds = ',id1,id2,' (VSE mize vključno s primarno iz tableId).
 * Guardi v table-claim.ts blokirajo VSAKO članico prek
 * OR [{ tableId }, { comboTableIds contains ',id,' }].
 *
 * Vzorec shranjevanja: auto86-config (v1.230.0) / resv-pacing-config
 * (v1.244.0) — Integration vrstica per lokacija, 0 DDL; JSON niz prek
 * jparse (Integration.config Json polje se prebere kot string).
 */

import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'

/** Marker Integration vrstice s kombinacijami miz (per lokacija). */
export const TABLE_COMBOS_MARKER = 'table-combos-config'

/** Marker Integration vrstice z ne-rezervabilnimi mizami (walk-in rezerva). */
export const RESV_BOOKABLE_MARKER = 'resv-bookable-config'

/** Registrirana kombinacija miz (kanonična oblika). */
export interface TableCombo {
  id: string
  /** mize, ki jih kombinacija ZASEDA (2–5; vrstni red = prikaz). */
  tableIds: string[]
}

/** Minimalna oblika odjemalca za branje konfiguracij (db ali transakcija). */
type CombosReader = Pick<Prisma.TransactionClient, 'integration'>

/** Vrne ',id1,id2,' — kanonična oblika stolpca Reservation.comboTableIds. */
export function comboTableIdsOf(tableIds: string[]): string {
  const clean = [...new Set(tableIds.map((s) => String(s || '').trim()).filter(Boolean))]
  return clean.length === 0 ? '' : `,${clean.join(',')},`
}

/** Parsed seznam miz kombinacijske rezervacije ('' → []). */
export function parseComboTableIds(raw: unknown): string[] {
  const s = String(raw ?? '').trim()
  if (!s) return []
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** Obrambna normalizacija registra kombinacij (jparse — JSON niz ali objekt). */
export function parseCombos(raw: unknown): TableCombo[] {
  const parsed = jparse<unknown>(raw, null)
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as { combos?: unknown }
  if (!Array.isArray(o.combos)) return []
  const out: TableCombo[] = []
  for (const c of o.combos) {
    if (!c || typeof c !== 'object') continue
    const row = c as { id?: unknown; tableIds?: unknown }
    const id = String(row.id ?? '').trim()
    const tableIds = Array.isArray(row.tableIds)
      ? row.tableIds.map((x) => String(x ?? '').trim()).filter(Boolean)
      : []
    if (!id || tableIds.length < 2) continue
    out.push({ id, tableIds: [...new Set(tableIds)] })
  }
  return out
}

/** Prebere kombinacije lokacije (brez vrstice → prazno). */
export async function loadTableCombos(client: CombosReader, locationId: string): Promise<TableCombo[]> {
  const row = await client.integration.findFirst({
    where: { name: TABLE_COMBOS_MARKER, type: 'other', locationId },
    select: { config: true },
  })
  return parseCombos(row?.config)
}

/** Obrambna normalizacija ne-rezervabilnih miz (walk-in rezerva). */
export function parseBookableExcluded(raw: unknown): string[] {
  const parsed = jparse<unknown>(raw, null)
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as { excludedTableIds?: unknown }
  if (!Array.isArray(o.excludedTableIds)) return []
  return [...new Set(o.excludedTableIds.map((x) => String(x ?? '').trim()).filter(Boolean))]
}

/** Prebere izključene (walk-in only) mize lokacije (brez vrstice → prazno). */
export async function loadBookableExcluded(client: CombosReader, locationId: string): Promise<string[]> {
  const row = await client.integration.findFirst({
    where: { name: RESV_BOOKABLE_MARKER, type: 'other', locationId },
    select: { config: true },
  })
  return parseBookableExcluded(row?.config)
}

/* ── ČISTI helperji za UI (avtododelitev + izbira v dialogu) ───────────── */

/** Miza za prikaz kandidata (enojna ali kombinacija) — enotna oblika. */
export interface SeatCandidate {
  /** tabela id-jev za POST (enojna: [id]; kombinacija: vse članice). */
  tableIds: string[]
  /** vsota sedežev. */
  seats: number
  /** človeško ime (»Miza 5« / »Miza 5+6«) — iz številk miz. */
  label: string
  /** id kombinacije (null = enojna miza) — za vrednost izbire v dialogu. */
  comboId: string | null
}

/**
 * Kandidati za družino: enojne mize + registrirane kombinacije, razvrščeni
 * po sedežih naraščajoče (vzorec autoAssignTable v1.231: najmanjša, ki ustreza).
 * Čista funkcija nad že naloženimi podatki — kuhinja UI in testi delijo isto
 * resnico o izbiri. `busyTableIds` = mize z AKTIVNO rezervacijo v oknu.
 */
export function seatCandidatesForParty(args: {
  tables: { id: string; number?: number; name?: string; seats: number; locationId?: string | null }[]
  combos: TableCombo[]
  party: number
  /** mize, ki jih v oknu drži druga rezervacija (blokirane). */
  busyTableIds: Set<string>
  /** omejitev na lokacijo dialoga (null = vse). */
  locationId?: string | null
}): SeatCandidate[] {
  const { tables, combos, party, busyTableIds, locationId } = args
  const byId = new Map(tables.map((t) => [t.id, t]))
  const inScope = (t: { locationId?: string | null }) => !locationId || !t.locationId || t.locationId === locationId
  const label = (t: { name?: string; number?: number }) => (t.name ? t.name.replace('Miza ', '') : String(t.number ?? '?'))

  const out: SeatCandidate[] = []
  // enojne mize (ista semantika kot autoAssignTable: sedežev ≥ oseb, prosta)
  for (const t of tables) {
    if (t.seats < party || busyTableIds.has(t.id) || !inScope(t)) continue
    out.push({ tableIds: [t.id], seats: t.seats, label: `Miza ${label(t)}`, comboId: null })
  }
  // registrirane kombinacije: vse članice obstajajo, prostе, sedeži ≥ oseb
  for (const c of combos) {
    const members = c.tableIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t)
    if (members.length !== c.tableIds.length) continue // zamujena izbrisana miza — preskoči
    if (members.some((t) => !inScope(t) || busyTableIds.has(t.id))) continue
    const seats = members.reduce((s, t) => s + t.seats, 0)
    if (seats < party) continue
    out.push({ tableIds: c.tableIds, seats, label: `Miza ${members.map((t) => label(t)).join('+')}`, comboId: c.id })
  }
  return out.sort((a, b) => a.seats - b.seats || a.label.localeCompare(b.label, 'sl'))
}

/** Kanonična referenca na db (en sam vir za teste/reputacijo). */
export const combosDb = db
