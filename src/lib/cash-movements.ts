/**
 * Issue #16 (P1/P2, v1.108.0) — blagajniški premiki denarja: knjiga
 * neprodajnih gotovinskih premikov predala, vezana na obstoječo izmeno.
 *
 * Vzorec lot-governance / exception-policy:
 *  - NOVA tabela CashMovement (main + mirror schema) → produkcijski DDL korak
 *    /api/admin/migrate-cash-movements (konzola). Do DDL: rute 503/ddlPending
 *    (živa pot zaključka izmene NE pade — premiki se preprosto ne upoštevajo).
 *  - 2 politika stolpca na RestaurantSettings (MIRROR-ONLY do DDL, raw SQL +
 *    probe 60 s — vzorec exception-policy):
 *      cashVarianceThresholdCents INT     DEFAULT 0     — prag variance (0 = izklopljen)
 *      cashBlindCount             BOOLEAN DEFAULT false — slepi popis
 *  - 3 povzetek stolpci na ZReport (MIRROR-ONLY do DDL, raw UPDATE po typed
 *    create): cashPaidIn / cashPaidOut / cashGuestRefund. Obstoječi typed
 *    ZReport.cashDrops = ODVOD V SEF (prvič dejansko zapisan — ujema se z
 *    Square definicijo "cash drop" in poljem v shemi; brez dvojnega polja).
 *
 * USKLAJEVANJE (en vir formule, ista matematika kot zaključek izmene):
 *   pričakovano = začetni fond + gotovinska prodaja (Receipts okno, storno
 *   NETO negira) + Σ potrjeni vhodni premiki − Σ potrjeni izhodni premiki.
 *   Vračilo gostu: FISKALNI STORNO (gotovinski) že zmanjša prodajo v oknu →
 *   vrsta guest_refund je SAMO za vračila BREZ fiskalnega storna; API zavrne
 *   (409) navzkrižje z gotovinskim storno računom (prepreči dvojno štetje).
 */
import { db } from '@/lib/db'
import { num, r2 } from '@/lib/map'
import { isMissingSchemaError } from './prisma-missing'

/* ───────── tipi premikov ───────── */

export const CASH_MOVEMENT_TYPES = [
  'paid_in', // vplačilo (priliv drobnega v predal)
  'paid_out', // izplačilo iz predala (drobna poraba)
  'supplier_payment', // gotovinsko plačilo dobavitelju
  'safe_drop', // odvod v sef/banko
  'guest_refund', // gotovinsko vračilo gostu BREZ fiskalnega storna
  'change_fund', // prenos menjalnega fonda (smer izrecna)
] as const

export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number]

/** Smer, IZPELJANA iz tipa (change_fund izrecna iz telesa). */
const TYPE_DIRECTION: Record<CashMovementType, 'in' | 'out'> = {
  paid_in: 'in',
  paid_out: 'out',
  supplier_payment: 'out',
  safe_drop: 'out',
  guest_refund: 'out',
  change_fund: 'out',
}

/** Opomba (≥3) je obvezna za tipe z večjim zlorabnim potencialom (issue:
 *  "obvezno opombo pri izbranih tipih"). */
const NOTE_REQUIRED: Set<CashMovementType> = new Set(['supplier_payment', 'safe_drop', 'guest_refund'])

/** Meje posameznega premika (EUR). */
export const CASH_MOVEMENT_MIN = 0.01
export const CASH_MOVEMENT_MAX = 100_000

export function cashMovementDirection(type: string, explicit?: unknown): 'in' | 'out' | null {
  if (!(CASH_MOVEMENT_TYPES as readonly string[]).includes(type)) return null
  if (type === 'change_fund') {
    const d = explicit === 'in' || explicit === 'out' ? explicit : null
    return d
  }
  return TYPE_DIRECTION[type as CashMovementType]
}

export function noteRequiredForType(type: string): boolean {
  return NOTE_REQUIRED.has(type as CashMovementType)
}

/* ───────── capability probe (tabela) ───────── */

const PROBE_TTL_MS = 60_000
let tableCache: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL / v testih). Z vrednostjo jo vsili. */
export function resetCashMovementsProbe(value?: boolean): void {
  tableCache = value === undefined ? null : { value, at: Date.now() }
}

/** Ali tabela CashMovement obstaja? (memoizirano, 60 s — pre-DDL 503 gating) */
export async function cashMovementsAvailable(): Promise<boolean> {
  if (tableCache && Date.now() - tableCache.at < PROBE_TTL_MS) return tableCache.value
  try {
    await db.$queryRawUnsafe(`SELECT 1 FROM "CashMovement" LIMIT 1`)
    tableCache = { value: true, at: Date.now() }
  } catch (e) {
    tableCache = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return tableCache.value
}

/* ───────── politika (RestaurantSettings, MIRROR-ONLY do DDL) ───────── */

export interface CashPolicy {
  /** prag variance gotovine v centih; 0 = izklopljen (brez trenja) */
  varianceThresholdCents: number
  /** slepi popis: blagajnik NE vidi pričakovanega pred oddajo štetja */
  blindCount: boolean
}

export const DEFAULT_CASH_POLICY: CashPolicy = {
  varianceThresholdCents: 0,
  blindCount: false,
}

export const CASH_POLICY_COLUMNS = ['cashVarianceThresholdCents', 'cashBlindCount'] as const
export type CashPolicyColumn = (typeof CASH_POLICY_COLUMNS)[number]

export const CASH_POLICY_BOUNDS: Record<CashPolicyColumn, { min: number; max: number }> = {
  cashVarianceThresholdCents: { min: 0, max: 1_000_000 },
  cashBlindCount: { min: 0, max: 1 },
}

let policyCache: { value: boolean; at: number } | null = null

export function resetCashPolicyProbe(value?: boolean): void {
  policyCache = value === undefined ? null : { value, at: Date.now() }
}

/** Ali RestaurantSettings nosi politika stolpca? (memoizirano, 60 s) */
export async function cashPolicyAvailable(): Promise<boolean> {
  if (policyCache && Date.now() - policyCache.at < PROBE_TTL_MS) return policyCache.value
  try {
    await db.$queryRawUnsafe(`SELECT "cashBlindCount" FROM "RestaurantSettings" LIMIT 1`)
    policyCache = { value: true, at: Date.now() }
  } catch (e) {
    policyCache = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return policyCache.value
}

/** Prebere politiko (graceful: privzetek, kadar DDL še ni apliciran). */
export async function cashPolicy(): Promise<CashPolicy> {
  if (!(await cashPolicyAvailable())) return DEFAULT_CASH_POLICY
  const rows = await db.$queryRaw<{ cashVarianceThresholdCents: number; cashBlindCount: boolean | number }[]>`
    SELECT "cashVarianceThresholdCents", "cashBlindCount" FROM "RestaurantSettings" LIMIT 1`
  const r = rows?.[0]
  if (!r) return DEFAULT_CASH_POLICY
  return {
    varianceThresholdCents: Math.max(0, Math.round(num(r.cashVarianceThresholdCents))),
    blindCount: r.cashBlindCount === true || r.cashBlindCount === 1,
  }
}

/** Zapiše del politike (raw UPDATE, validirane vrednosti — vzorec exception-policy). Vrne napako ali null. */
export async function writeCashPolicy(
  values: Partial<Record<CashPolicyColumn, number | boolean>>
): Promise<string | null> {
  const keys = Object.keys(values) as CashPolicyColumn[]
  if (keys.length === 0) return null
  if (!(await cashPolicyAvailable())) {
    return 'Politika blagajne čaka DDL korak (migrate-cash-movements).'
  }
  for (const k of keys) {
    const v = values[k]
    if (k === 'cashBlindCount') {
      if (typeof v !== 'boolean') return 'cashBlindCount mora biti true/false.'
    } else {
      const n = Number(v)
      if (!Number.isFinite(n)) return `${k} mora biti število.`
      if (n < CASH_POLICY_BOUNDS[k].min || n > CASH_POLICY_BOUNDS[k].max) {
        return `${k} mora biti med ${CASH_POLICY_BOUNDS[k].min} in ${CASH_POLICY_BOUNDS[k].max}.`
      }
    }
  }
  const assigns = keys.map((k) => {
    const v = values[k]
    return `"${k}" = ${typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : Math.round(Number(v))}`
  })
  // posodobi VSE vrstice (singleton po konvenciji; varno tudi za legacy več)
  await db.$executeRawUnsafe(`UPDATE "RestaurantSettings" SET ${assigns.join(', ')}`)
  return null
}

/* ───────── ZReport povzetek stolpci (MIRROR-ONLY do DDL) ───────── */

let zrCache: { value: boolean; at: number } | null = null

export function resetZReportCashColumnsProbe(value?: boolean): void {
  zrCache = value === undefined ? null : { value, at: Date.now() }
}

/** Ali ZReport nosi povzetek stolpce? (memoizirano, 60 s) */
export async function zReportCashColumnsAvailable(): Promise<boolean> {
  if (zrCache && Date.now() - zrCache.at < PROBE_TTL_MS) return zrCache.value
  try {
    await db.$queryRawUnsafe(`SELECT "cashPaidIn" FROM "ZReport" LIMIT 1`)
    zrCache = { value: true, at: Date.now() }
  } catch (e) {
    zrCache = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return zrCache.value
}

/* ───────── povzetek premikov izmene (ČISTI motor — ena formula) ───────── */

export interface CashMovementRow {
  id: string
  shiftId: string
  locationId: string
  type: string
  direction: string
  amount: number
  currency: string
  reasonId: string | null
  reasonName: string
  reasonText: string
  note: string
  userId: string
  userName: string
  deviceId: string
  receiptRef: string
  status: string
  voidedByName: string
  voidedAt: Date | null
  voidReason: string
  reversalOfId: string | null
  expectedAfter: number
  createdAt: Date
}

export interface MovementSummary {
  /** Σ potrjenih vhodnih (paid_in + change_fund in) */
  paidIn: number
  /** Σ potrjenih izhodnih (paid_out + supplier_payment + change_fund out) */
  paidOut: number
  /** Σ potrjenih odvodov v sef (safe_drop) — ZReport.cashDrops */
  safeDrop: number
  /** Σ potrjenih gotovinskih vračil brez fiskalnega storna */
  guestRefund: number
  /** vhodni − izhodni (brez prodaje!) */
  net: number
  count: number
  voidedCount: number
}

/** Evropska zaokrožitev na 2 decimalki (r2 iz map.ts). */
const r = r2

/**
 * Povzetek POTRJENIH (ne-razveljavitveno povezanih) premikov izmene.
 * Osnovna vrstica razveljavitve (reversalOfId !== null) se NE šteje —
 * njen učinek je razveljavitveni zapis ORIGINALA prek status='voided'.
 * (Original voided + reversal voided = neto 0; original voided brez
 * reversala ne more obstajati — void VEDNO ustvari reverse zapis.)
 */
export function summarizeMovements(rows: { type: string; direction: string; amount: number; status: string; reversalOfId: string | null }[]): MovementSummary {
  let paidIn = 0, paidOut = 0, safeDrop = 0, guestRefund = 0, count = 0, voidedCount = 0
  for (const m of rows) {
    if (m.status !== 'confirmed') {
      if (m.status === 'voided' && m.reversalOfId === null) voidedCount++
      continue
    }
    if (m.reversalOfId !== null) continue // razveljavitveni zapis ni samostojen promet
    count++
    const a = Math.abs(num(m.amount))
    if (m.type === 'safe_drop') safeDrop += a
    else if (m.type === 'guest_refund') guestRefund += a
    if (m.direction === 'in') paidIn += a
    else paidOut += a
  }
  return {
    paidIn: r(paidIn),
    paidOut: r(paidOut),
    safeDrop: r(safeDrop),
    guestRefund: r(guestRefund),
    net: r(paidIn - paidOut),
    count,
    voidedCount,
  }
}

/**
 * Pričakovana gotovina v predalu (EN vir formule, uporablja jo živi pregled
 * IN zaključek izmene):
 *   startingCash + cashSales (fiskalna prodaja v oknu, storno neto) + net premikov.
 * Vračanja premikov so že v net (voided ne šteje).
 */
export function expectedDrawerCash(startingCash: number, cashSales: number, netMovements: number): number {
  return r(num(startingCash) + num(cashSales) + num(netMovements))
}

/* ───────── CSV izvoz (računovodstvo: NEPRODAJNI premiki, ločeno od prodaje) ───────── */

export function movementsCsv(rows: CashMovementRow[], locale: string): string {
  const head = locale === 'hr'
    ? ['ID', 'Izmjena', 'Lokacija', 'Vrsta', 'Smjer', 'Iznos', 'Valuta', 'Razlog', 'Napomena', 'Korisnik', 'Uređaj', 'Referenca računa', 'Status', 'Poništeno od', 'Vrijeme']
    : ['ID', 'Izmena', 'Lokacija', 'Vrsta', 'Smer', 'Znesek', 'Valuta', 'Razlog', 'Opomba', 'Uporabnik', 'Naprava', 'Referenca računa', 'Status', 'Razveljavil', 'Čas']
  const lines = [head]
  for (const m of rows) {
    lines.push([
      m.id,
      m.shiftId,
      m.locationId,
      m.type,
      m.direction,
      num(m.amount).toFixed(2),
      m.currency,
      m.reasonName || m.reasonText,
      m.note,
      m.userName,
      m.deviceId,
      m.receiptRef,
      m.status,
      m.voidedByName,
      new Date(m.createdAt).toISOString(),
    ])
  }
  // BOM + `;` (Excel SI/HR konvencija — isti vzorec kot vsi obstoječi izvozi)
  return '\ufeff' + lines.map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n')
}
