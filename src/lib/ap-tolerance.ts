/**
 * Issue #18 (P1) — tolerance tristranskega ujemanja (PO ↔ GRN ↔ e-račun).
 *
 * Zahteva issue-ja: »Nastavi preverljive tolerančne meje za količino, ceno,
 * DDV in zaokroževanje. Toleranco naj konfigurira pooblaščena oseba/
 * računovodska politika; ne kodiraj poljubnega dovoljenega odstotka.«
 *
 * IMPLEMENTACIJA (vzorec Task 66/67 »stroski-kategorije«):
 *  - 4 novi stolpci na RestaurantSettings (globalna računovodska politika):
 *      apMatchQtyTolerancePct    DECIMAL default 0   — % naročene/sprejete količine
 *      apMatchPriceTolerancePct  DECIMAL default 0   — % dogovorjene cene na enoto
 *      apMatchVatTolerancePct    DECIMAL default 0   — absolutne odstotne TOČKE DDV
 *      apMatchAmountToleranceCents INT default 2     — centi zaokroževanja zneskov
 *  - MAIN schema.prisma jih NIMA (zastrupitev P2022 do DDL) — dostop IZKLJUČNO
 *    prek raw SQL z vezanimi parametri, gated s probo (60 s TTL → lambda se po
 *    DDL samozdravi). SQLite mirror jih ima (dev db push).
 *  - DDL korak: /api/admin/migrate-ap-tolerance (konzola Enterprise, idempotentno).
 *  - Pisanje: PUT /api/settings (samo settings.manage, validacija 0..100 / 0..10000).
 *
 * PRIVZETO (brez DDL / pred nastavitvijo) = NAJSTROŽJE:
 *  0 % količine, 0 % cene, 0 točk DDV, 2 centa zaokroževanja (zaokroževanje NI
 *  »poljuben odstotek«, ampak računska nujnost — dokumentirano). Vsako ohlapnejše
 *  pravilo je IZRECNA odločitev pooblaščene osebe.
 */
import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'

const PROBE_TTL_MS = 60_000

export interface ApMatchTolerance {
  qtyTolerancePct: number
  priceTolerancePct: number
  vatTolerancePct: number
  amountToleranceCents: number
}

/** Privzete (stroge) tolerance — računovodska politika jih lahko le OHLAPI. */
export const DEFAULT_AP_TOLERANCE: ApMatchTolerance = {
  qtyTolerancePct: 0,
  priceTolerancePct: 0,
  vatTolerancePct: 0,
  amountToleranceCents: 2,
}

export const AP_TOLERANCE_COLUMNS = [
  'apMatchQtyTolerancePct',
  'apMatchPriceTolerancePct',
  'apMatchVatTolerancePct',
  'apMatchAmountToleranceCents',
] as const

export const AP_TOLERANCE_BOUNDS: Record<
  (typeof AP_TOLERANCE_COLUMNS)[number],
  { min: number; max: number }
> = {
  apMatchQtyTolerancePct: { min: 0, max: 100 },
  apMatchPriceTolerancePct: { min: 0, max: 100 },
  apMatchVatTolerancePct: { min: 0, max: 10 },
  apMatchAmountToleranceCents: { min: 0, max: 10000 },
}

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL / v testih). Z vrednostjo jo vsili. */
export function resetApToleranceProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/** Ali so tolerance stolpci prisotni na trenutni bazi? (memoizirano, 60 s) */
export async function apToleranceAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe(`SELECT "apMatchQtyTolerancePct" FROM "RestaurantSettings" LIMIT 1`)
    cached = { value: true, at: Date.now() }
  } catch (e) {
    cached = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return cached.value
}

/**
 * Prebere tolerance (DDL-gated). Manjkajoči/nastavljeni NULL → strogi privzetek.
 * Infrastrukturne napake ne maskirajo stanja — vrnjena vrednost je privzetek,
 * napako pa odkrije dejanska poizvedba klicalca.
 */
export async function apToleranceConfig(): Promise<ApMatchTolerance> {
  if (!(await apToleranceAvailable())) return { ...DEFAULT_AP_TOLERANCE }
  try {
    const rows = await db.$queryRaw<{
      apMatchQtyTolerancePct: unknown
      apMatchPriceTolerancePct: unknown
      apMatchVatTolerancePct: unknown
      apMatchAmountToleranceCents: unknown
    }[]>`SELECT "apMatchQtyTolerancePct", "apMatchPriceTolerancePct", "apMatchVatTolerancePct", "apMatchAmountToleranceCents" FROM "RestaurantSettings" LIMIT 1`
    const r = rows[0]
    if (!r) return { ...DEFAULT_AP_TOLERANCE }
    const num = (v: unknown, d: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : d
    }
    return {
      qtyTolerancePct: num(r.apMatchQtyTolerancePct, DEFAULT_AP_TOLERANCE.qtyTolerancePct),
      priceTolerancePct: num(r.apMatchPriceTolerancePct, DEFAULT_AP_TOLERANCE.priceTolerancePct),
      vatTolerancePct: num(r.apMatchVatTolerancePct, DEFAULT_AP_TOLERANCE.vatTolerancePct),
      amountToleranceCents: Math.round(num(r.apMatchAmountToleranceCents, DEFAULT_AP_TOLERANCE.amountToleranceCents)),
    }
  } catch {
    return { ...DEFAULT_AP_TOLERANCE }
  }
}

/**
 * Validacija + pisanje toleranc (raw UPDATE, idempotentno — kliče se znotraj
 * transakcije settings PUT). Vrne napako (string) ali null (uspeh).
 * Singleton vrstica RestaurantSettings obstaja v praksi vedno; UPDATE brez
 * WHERE posodobi eno vrstico (singleton). Imena stolpcev so iz FIKSNE
 * allow-liste (AP_TOLERANCE_COLUMNS) — vrednosti so števila (brez SQL injekcije).
 */
export async function writeApTolerance(
  values: Partial<Record<(typeof AP_TOLERANCE_COLUMNS)[number], number>>
): Promise<string | null> {
  const keys = Object.keys(values) as (typeof AP_TOLERANCE_COLUMNS)[number][]
  if (keys.length === 0) return null
  if (!(await apToleranceAvailable())) {
    return 'Tolerance ujemanja čakajo DDL korak (Enterprise → Shema migracije → ap-tolerance).'
  }
  for (const k of keys) {
    const v = values[k] as number
    if (!Number.isFinite(v)) return `${k} mora biti število.`
    const b = AP_TOLERANCE_BOUNDS[k]
    if (v < b.min || v > b.max) return `${k} mora biti med ${b.min} in ${b.max}.`
  }
  await db.$executeRawUnsafe(
    `UPDATE "RestaurantSettings" SET ${keys.map((k) => `"${k}" = ${Number(values[k])}`).join(', ')}`
  )
  return null
}
