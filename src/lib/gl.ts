/**
 * OPS-8 val 3 (v1.73.0) — GL journal (orientation) pure + seed layer.
 *
 * ZERO DDL: uses the existing ChartOfAccount / JournalEntry / JournalLine models.
 * Scope is deliberately narrow — an automatic DAILY sales entry that a bookkeeper
 * can use as a starting point ("orientacijski obračun"), NOT statutory accounting.
 *
 * SI standard chart subset (official GVR numbers):
 *   101 Blagajna                          (asset,    debit = cash received)
 *   204 Terjatve od kupcev                (asset,    debit = card/other non-cash received)
 *   221 Obveznosti za davke na potrošnjo  (liability,credit = VAT collected)
 *   401 Prihodki od prodaje               (revenue,  credit = net sales)
 *   402 Vrnjena prodaja in popusti        (revenue,  DEBIT = contra revenue: discounts,
 *                                          voids, waste-as-loss; credit only for residuals)
 */
import { db } from '@/lib/db'
import { nid } from '@/lib/map'
import type { AccountType } from '@/lib/prisma-types'

export interface GlStandardAccount {
  code: string
  name: string
  accountType: AccountType
  description: string
}

export const GL_STANDARD_ACCOUNTS: GlStandardAccount[] = [
  { code: '101', name: 'Blagajna', accountType: 'asset', description: 'Gotovina v blagajni (101)' },
  { code: '204', name: 'Terjatve od kupcev', accountType: 'asset', description: 'Ne-gotovinska plačila (kartice, mobilno, drugo)' },
  { code: '221', name: 'Obveznosti za davke na potrošnjo', accountType: 'liability', description: 'DDV zaračunan na računih' },
  { code: '401', name: 'Prihodki od prodaje', accountType: 'revenue', description: 'Neto promet (brez DDV)' },
  { code: '402', name: 'Vrnjena prodaja in popusti', accountType: 'revenue', description: 'Kontra prihodek — popusti, storno, kalo (breme)' },
]

const ACCOUNT_BY_CODE = new Map(GL_STANDARD_ACCOUNTS.map((a) => [a.code, a]))

/** process-wide once-flag — seeding is idempotent, so double-run is harmless anyway */
let seededInProcess = false

/** Idempotent upsert of the SI standard accounts used by the auto journal. */
export async function seedStandardAccounts(): Promise<void> {
  if (seededInProcess) return
  for (const a of GL_STANDARD_ACCOUNTS) {
    await db.chartOfAccount.upsert({
      where: { code: a.code },
      create: { id: `gl-acc-${a.code}`, code: a.code, name: a.name, accountType: a.accountType, description: a.description },
      update: { name: a.name, accountType: a.accountType },
    })
  }
  seededInProcess = true
}

export interface GlDayTotals {
  /** cash payments total for the day */
  cash: number
  /** card / other non-cash payments total for the day */
  nonCash: number
  /** net sales (excl. VAT) for the day */
  netSales: number
  /** total VAT for the day */
  vatTotal: number
  /** discounts total for the day */
  discountsTotal: number
}

export interface GlLine {
  accountCode: string
  accountName: string
  accountType: AccountType
  debit: number
  credit: number
}

export interface GlEntryPreview {
  lines: GlLine[]
  debits: number
  credits: number
  balanced: boolean
  /** debits - credits BEFORE the balancing adjustment (0 = nothing absorbed) */
  residual: number
  /** account whose line absorbed the rounding/mismatch remainder, null if none */
  adjustedAccount: string | null
}

export const r2g = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Deterministic balancing rule (documented decision, OPS-8 val 3):
 *
 * Lines: debit 101 = cash, debit 204 = non-cash, credit 401 = net sales,
 * debit 402 = discounts, credit 221 = VAT.
 *
 * residual = debits - credits computed from the raw totals.
 *  - |residual| <= 0.02  → rounding drift, absorbed deterministically by the 401
 *    (revenue) credit line (credit += residual, works for both signs). Rationale:
 *    base/vat come from the same receipts, so sub-cent drift is a rounding artifact.
 *  - |residual|  > 0.02  → real-world mismatch (voids whose payments are not
 *    reversed, loyalty redemption, payments dated on another day). Absorbed by the
 *    402 contra-revenue line (Lightspeed "items loss as discount" pattern):
 *    residual > 0 → 402 CREDIT increases (too much debit collected),
 *    residual < 0 → 402 DEBIT increases (credits exceed collections — e.g. voided
 *    receipts). The entry ALWAYS balances while keeping the mismatch visible in 402.
 */
export function buildGlEntry(t: GlDayTotals): GlEntryPreview {
  const lines: GlLine[] = []
  const acc = (code: string): GlStandardAccount => {
    const a = ACCOUNT_BY_CODE.get(code)
    if (!a) throw new Error(`Unknown GL account ${code}`)
    return a
  }
  const push = (code: string, debit: number, credit: number): void => {
    const d = r2g(Math.max(0, debit))
    const c = r2g(Math.max(0, credit))
    if (d !== 0 || c !== 0) {
      const a = acc(code)
      lines.push({ accountCode: a.code, accountName: a.name, accountType: a.accountType, debit: d, credit: c })
    }
  }

  push('101', r2g(t.cash), 0)
  push('204', r2g(t.nonCash), 0)
  push('401', 0, r2g(t.netSales))
  if (r2g(t.discountsTotal) > 0) push('402', r2g(t.discountsTotal), 0)
  push('221', 0, r2g(t.vatTotal))

  const sumOf = (sel: (l: GlLine) => number): number => r2g(lines.reduce((s, l) => s + sel(l), 0))
  let debits = sumOf((l) => l.debit)
  let credits = sumOf((l) => l.credit)
  const residual = r2g(debits - credits)
  let adjustedAccount: string | null = null

  if (residual !== 0) {
    const line401 = lines.find((x) => x.accountCode === '401')
    // 401 absorbs sub-cent drift only when the line exists and stays non-negative;
    // otherwise (degenerate zero-sales day) the 402 rule below keeps the entry balanced.
    adjustedAccount = line401 && Math.abs(residual) <= 0.02 && line401.credit + residual >= 0 ? '401' : '402'
    if (adjustedAccount === '401') {
      line401!.credit = r2g(line401!.credit + residual)
    } else {
      const l = lines.find((x) => x.accountCode === '402')
      if (l) {
        if (residual > 0) l.credit = r2g(l.credit + residual)
        else l.debit = r2g(l.debit - residual)
      } else if (residual > 0) {
        push('402', 0, residual)
      } else {
        push('402', -residual, 0)
      }
    }
    debits = sumOf((x) => x.debit)
    credits = sumOf((x) => x.credit)
  }

  return { lines, debits, credits, balanced: debits === credits, residual, adjustedAccount }
}

/** Deterministic per-day entry number — also the idempotency key (unique in DB). */
export function glEntryNumber(dayIso: string): string {
  const compact = dayIso.replaceAll('-', '')
  return `GL-${compact}-01`
}

/** Memo (description) — the 'AVTO' prefix marks rows created by this automation. */
export function glMemo(dayIso: string): string {
  return `AVTO dnevnik prodaje ${dayIso}`
}
