/**
 * Issue #19 (P1/P2, v1.107.0) — politika finančnih izjem: pragovi odobritve
 * in obveznost razloga, konfigurirana pooblaščene osebe (settings.manage),
 * NE trdo kodirana v kodi.
 *
 * IMPLEMENTACIJA (vzorec ap-tolerance / stroski-kategorije):
 *  - 9 novih stolpcev na RestaurantSettings (globalna poslovna politika):
 *      excDiscountApprovalPct        DECIMAL(5,2) DEFAULT 15  — prag % za popust (ohrani dosedanjo 15-% vloga pravilo)
 *      excDiscountApprovalAmountCents INTEGER     DEFAULT 0   — prag centov za fiksni popust (0 = izklopljen)
 *      excVoidApprovalAmountCents     INTEGER     DEFAULT 0   — prag vrednosti preklica postavke (0 = izklopljen)
 *      excStornoApprovalAmountCents   INTEGER     DEFAULT 0   — prag zneska fiskalnega storna (0 = izklopljen)
 *      excCancelApprovalAmountCents   INTEGER     DEFAULT 0   — prag zneska preklica naročila (0 = izklopljen)
 *      excRequireReasonDiscount      BOOLEAN     DEFAULT false — razlog za register popust (ad-hoc vedno zahteva)
 *      excRequireReasonCancel        BOOLEAN     DEFAULT true  — razlog za preklic naročila
 *      excRequireReasonStorno        BOOLEAN     DEFAULT true  — razlog za fiskalni storno
 *      excRequireReasonVoid          BOOLEAN     DEFAULT true  — razlog za preklic postavke (dosedanja obveznost)
 *  - MAIN schema.prisma jih NIMA (zastrupitev P2022 do DDL) — dostop IZKLJUČNO
 *    prek raw SQL, gated s probo (60 s TTL → lambda se po DDL samozdravi).
 *    SQLite mirror jih ima (dev db push).
 *  - DDL korak: /api/admin/migrate-exception-policy (konzola, idempotentno).
 *  - Pisanje: PUT /api/settings (samo settings.manage, validacija).
 *
 * PRIVZETKI = varna nadaljevanja obstoječega vedenja + zahteve issue-ja:
 *  prag % ostane 15 (dosedanja DISCOUNT_APPROVAL_PERCENT disciplina), ostali
 *  zneskovni pragovi so IZKLOPLJENI (0) — njihovo vklopitev je izrecna
 *  odločitev upravljavca. Razlog je privzeto obvezen za preklic naročila,
 *  storno in preklic postavke; za register popuste NE (konfigurirana
 *  promocija ni izjema — ad-hoc popust razlog zahteva VEDNO, v kodi rute).
 */
import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'

const PROBE_TTL_MS = 60_000

export interface ExceptionPolicy {
  discountApprovalPct: number
  discountApprovalAmountCents: number
  voidApprovalAmountCents: number
  stornoApprovalAmountCents: number
  cancelApprovalAmountCents: number
  requireReasonDiscount: boolean
  requireReasonCancel: boolean
  requireReasonStorno: boolean
  requireReasonVoid: boolean
}

/**
 * Privzeti (varni) pragovi: % ohranja dosedanjo 15-% politiko vlog, zneskovni
 * pragovi izklopljeni (0 centov) — njihov vklop je izrecna odločitev. Razlog
 * obvezen za preklic/storno/void (issue zahteva), register popust ne.
 */
export const DEFAULT_EXCEPTION_POLICY: ExceptionPolicy = {
  discountApprovalPct: 15,
  discountApprovalAmountCents: 0,
  voidApprovalAmountCents: 0,
  stornoApprovalAmountCents: 0,
  cancelApprovalAmountCents: 0,
  requireReasonDiscount: false,
  requireReasonCancel: true,
  requireReasonStorno: true,
  requireReasonVoid: true,
}

export const EXCEPTION_POLICY_COLUMNS = [
  'excDiscountApprovalPct',
  'excDiscountApprovalAmountCents',
  'excVoidApprovalAmountCents',
  'excStornoApprovalAmountCents',
  'excCancelApprovalAmountCents',
  'excRequireReasonDiscount',
  'excRequireReasonCancel',
  'excRequireReasonStorno',
  'excRequireReasonVoid',
] as const

export type ExceptionPolicyColumn = (typeof EXCEPTION_POLICY_COLUMNS)[number]

/** Številske politike z mejami (bool brez). */
export const EXCEPTION_POLICY_BOUNDS: Partial<
  Record<ExceptionPolicyColumn, { min: number; max: number }>
> = {
  excDiscountApprovalPct: { min: 0, max: 100 },
  excDiscountApprovalAmountCents: { min: 0, max: 10_000_000 },
  excVoidApprovalAmountCents: { min: 0, max: 10_000_000 },
  excStornoApprovalAmountCents: { min: 0, max: 10_000_000 },
  excCancelApprovalAmountCents: { min: 0, max: 10_000_000 },
}

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL / v testih). Z vrednostjo jo vsili. */
export function resetExceptionPolicyProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/** Ali so stolpci politike prisotni na trenutni bazi? (memoizirano, 60 s) */
export async function exceptionPolicyAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe(`SELECT "excDiscountApprovalPct" FROM "RestaurantSettings" LIMIT 1`)
    cached = { value: true, at: Date.now() }
  } catch (e) {
    cached = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return cached.value
}

/** Prebere politiko (DDL-gated); manjkajoči/NULL → privzetki. */
export async function exceptionPolicy(): Promise<ExceptionPolicy> {
  if (!(await exceptionPolicyAvailable())) return { ...DEFAULT_EXCEPTION_POLICY }
  try {
    const rows = await db.$queryRaw<{
      excDiscountApprovalPct: unknown
      excDiscountApprovalAmountCents: unknown
      excVoidApprovalAmountCents: unknown
      excStornoApprovalAmountCents: unknown
      excCancelApprovalAmountCents: unknown
      excRequireReasonDiscount: unknown
      excRequireReasonCancel: unknown
      excRequireReasonStorno: unknown
      excRequireReasonVoid: unknown
    }[]>`SELECT "excDiscountApprovalPct", "excDiscountApprovalAmountCents", "excVoidApprovalAmountCents", "excStornoApprovalAmountCents", "excCancelApprovalAmountCents", "excRequireReasonDiscount", "excRequireReasonCancel", "excRequireReasonStorno", "excRequireReasonVoid" FROM "RestaurantSettings" LIMIT 1`
    const r = rows[0]
    if (!r) return { ...DEFAULT_EXCEPTION_POLICY }
    const num = (v: unknown, d: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : d
    }
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
    return {
      discountApprovalPct: num(r.excDiscountApprovalPct, DEFAULT_EXCEPTION_POLICY.discountApprovalPct),
      discountApprovalAmountCents: Math.round(num(r.excDiscountApprovalAmountCents, DEFAULT_EXCEPTION_POLICY.discountApprovalAmountCents)),
      voidApprovalAmountCents: Math.round(num(r.excVoidApprovalAmountCents, DEFAULT_EXCEPTION_POLICY.voidApprovalAmountCents)),
      stornoApprovalAmountCents: Math.round(num(r.excStornoApprovalAmountCents, DEFAULT_EXCEPTION_POLICY.stornoApprovalAmountCents)),
      cancelApprovalAmountCents: Math.round(num(r.excCancelApprovalAmountCents, DEFAULT_EXCEPTION_POLICY.cancelApprovalAmountCents)),
      requireReasonDiscount: bool(r.excRequireReasonDiscount, DEFAULT_EXCEPTION_POLICY.requireReasonDiscount),
      requireReasonCancel: bool(r.excRequireReasonCancel, DEFAULT_EXCEPTION_POLICY.requireReasonCancel),
      requireReasonStorno: bool(r.excRequireReasonStorno, DEFAULT_EXCEPTION_POLICY.requireReasonStorno),
      requireReasonVoid: bool(r.excRequireReasonVoid, DEFAULT_EXCEPTION_POLICY.requireReasonVoid),
    }
  } catch {
    return { ...DEFAULT_EXCEPTION_POLICY }
  }
}

/**
 * Validacija + pisanje politike (raw UPDATE na singleton vrstico). Imena
 * stolpcev so iz FIKSNE allow-liste; bool vrednosti se zapišejo kot 0/1,
 * številke prek Number() — brez SQL injekcije. Vrne napako (string) | null.
 */
export async function writeExceptionPolicy(
  values: Partial<Record<ExceptionPolicyColumn, number | boolean>>
): Promise<string | null> {
  const keys = Object.keys(values) as ExceptionPolicyColumn[]
  if (keys.length === 0) return null
  if (!(await exceptionPolicyAvailable())) {
    return 'Politika izjem čaka DDL korak (Enterprise → Shema migracije → exception-policy).'
  }
  for (const k of keys) {
    const v = values[k]
    const bounds = EXCEPTION_POLICY_BOUNDS[k]
    if (bounds) {
      const n = Number(v)
      if (!Number.isFinite(n)) return `${k} mora biti število.`
      if (n < bounds.min || n > bounds.max) return `${k} mora biti med ${bounds.min} in ${bounds.max}.`
    } else if (typeof v !== 'boolean') {
      return `${k} mora biti true/false.`
    }
  }
  const assigns = keys.map((k) => {
    const v = values[k]
    return `"${k}" = ${typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : Number(v)}`
  })
  await db.$executeRawUnsafe(`UPDATE "RestaurantSettings" SET ${assigns.join(', ')}`)
  return null
}

/* ───────── odločitveni pomočniki (en vir resnice za rute) ───────── */

/**
 * Ali odstotkovni popust presega prag odobritve? (val > pct — strogo nad
 * pragom, enako dosedanji 15-% disciplini `val > DISCOUNT_APPROVAL_PERCENT`.)
 */
export function percentAboveThreshold(val: number, policy: ExceptionPolicy): boolean {
  return val > policy.discountApprovalPct
}

/** Ali fiksni znesek (EUR) presega prag centov? (0 = izklopljen) */
export function amountAboveThreshold(eur: number, thresholdCents: number): boolean {
  if (thresholdCents <= 0) return false
  return Math.round(eur * 100) > thresholdCents
}
