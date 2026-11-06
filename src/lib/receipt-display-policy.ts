/**
 * PRIMERJAVA §37 (v1.263.0) — SKRIVANJE NIČELNIH POSTAVK NA NATISNJENEM
 * RAČUNU (Square Vol 16, 5. 11. 2026 »Hide $0 items from printed customer
 * receipts«): poslovna PRIKAZOVNA politika računa — postavke, dodane po
 * ceni 0 (kruh na hišni račun, kozarec vode), se ob vklopu ne izrisujejo
 * na odjemalskem računu; posnetek, kuhinja, poročila in izvozi ostanejo
 * popolni (Square dobesedno: »transaction records … include $0 items
 * either way«).
 *
 * IMPLEMENTACIJA (vzorec ap-tolerance / exception-policy / cash-policy —
 * aditivni politika stolpec na RestaurantSettings):
 *  - 1 nov stolpec: hideZeroReceiptItems BOOLEAN NOT NULL DEFAULT FALSE
 *    (privzeto IZKLOPLJENO — računi byte-identični sedanjim).
 *  - MAIN schema.prisma ga NIMA (zastrupitev P2022 do DDL) — dostop
 *    IZKLJUČNO prek raw SQL, gated s probo (60 s TTL → po DDL koraku se
 *    lambda samozdravi). SQLite mirror ga ima (dev db push).
 *  - DDL korak: /api/admin/migrate-receipt-display-policy (konzola,
 *    idempotentno, oba dialekta).
 *  - Pisanje: PUT /api/settings (settings.manage — PRIKAZOVNA preferenca
 *    družine receiptFooter, NIE denarna politika POLICY_COLUMNS/Issue #72
 *    C3; poštena odločitev §37 B6). Do DDL: pisanje → 503 s potjo konzole.
 *
 * Filter SAMO v izrisu (src/lib/receipt.ts receiptDisplayItems) — ta sloj
 * nosi IZKLJUČNO nastavitev; bralci: /api/furs/[id] (zastavica na računu —
 * tisk neodvisen od pravic nad nastavitvami) + GET /api/settings (UI).
 */
import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'

const PROBE_TTL_MS = 60_000

export interface ReceiptDisplayPolicy {
  hideZeroItems: boolean
}

/** Privzeto IZKLOPLJENO — vsak obstoječi izpis ostane enak. */
export const DEFAULT_RECEIPT_DISPLAY_POLICY: ReceiptDisplayPolicy = {
  hideZeroItems: false,
}

export const RECEIPT_DISPLAY_POLICY_COLUMNS = ['hideZeroReceiptItems'] as const

export type ReceiptDisplayPolicyColumn = (typeof RECEIPT_DISPLAY_POLICY_COLUMNS)[number]

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL / v testih). Z vrednostjo jo vsili. */
export function resetReceiptDisplayPolicyProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/** Ali je stolpec politike prisoten na trenutni bazi? (memoizirano, 60 s) */
export async function receiptDisplayPolicyAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe(`SELECT "hideZeroReceiptItems" FROM "RestaurantSettings" LIMIT 1`)
    cached = { value: true, at: Date.now() }
  } catch (e) {
    cached = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return cached.value
}

/** Prebere politiko (DDL-gated); manjkajoči/NULL → privzetek (izklopljeno). */
export async function receiptDisplayPolicy(): Promise<ReceiptDisplayPolicy> {
  if (!(await receiptDisplayPolicyAvailable())) return { ...DEFAULT_RECEIPT_DISPLAY_POLICY }
  try {
    const rows = await db.$queryRaw<{ hideZeroReceiptItems: unknown }[]>
      `SELECT "hideZeroReceiptItems" FROM "RestaurantSettings" LIMIT 1`
    const r = rows[0]
    if (!r) return { ...DEFAULT_RECEIPT_DISPLAY_POLICY }
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
    return {
      hideZeroItems: bool(r.hideZeroReceiptItems, DEFAULT_RECEIPT_DISPLAY_POLICY.hideZeroItems),
    }
  } catch {
    return { ...DEFAULT_RECEIPT_DISPLAY_POLICY }
  }
}

/**
 * Validacija + pisanje politike (raw UPDATE na singleton vrstico; ime
 * stolpca iz FIKSNE allow-liste — brez SQL injekcije). Vrne napako
 * (string) | null — 503 sporočilo nosi pot do DDL konzole.
 */
export async function writeReceiptDisplayPolicy(
  values: Partial<Record<ReceiptDisplayPolicyColumn, boolean>>
): Promise<string | null> {
  const keys = Object.keys(values) as ReceiptDisplayPolicyColumn[]
  if (keys.length === 0) return null
  for (const k of keys) {
    if (typeof values[k] !== 'boolean') return `${k} mora biti true/false.`
  }
  if (!(await receiptDisplayPolicyAvailable())) {
    return 'Prikaz ničelnih postavk čaka DDL korak (Enterprise → Shema migracije → receipt-display-policy).'
  }
  const assigns = keys.map((k) => `"${k}" = ${values[k] === true ? 'TRUE' : 'FALSE'}`)
  await db.$executeRawUnsafe(`UPDATE "RestaurantSettings" SET ${assigns.join(', ')}`)
  return null
}
