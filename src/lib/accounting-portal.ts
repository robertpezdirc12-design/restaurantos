/**
 * P2-13 (v1.189.0) — knjigovodski portal, čisti sloj.
 *
 * NAMEN: read-only agregacija za vlogo accounting (tržna vrzel P2-13,
 * docs/TRZNA-VRZELI-2026.md §4 #13) — knjigovodja danes mora skakati med
 * zavihki (računi / stroški / nabava za e-račune, ki so POD inventory.manage
 * in mu jih zavihek ne pokaže). Portal prikazuje obdobje na enem mestu.
 *
 * Načela (vzorec gl.ts / waitlist.ts):
 *  - VSE funkcije so PURE, brez IO — UI in testi lahko kličejo brez baze;
 *  - brez novih API rut: UI bere OBSTOJEČE /api/reports/export?section=zz
 *    (format=json), /api/reports/gl, /api/einvoices in /api/expenses
 *    (razširjen z opcijskimi from/to — gl. GET /api/expenses);
 *  - READ-ONLY: v tej izdaji ni nobene mutacije — statusi so le prikazani,
 *    dejanja (pošlji/poizkusi znova) ostajajo v obstoječih karticah;
 *  - brez AI — vsak izračun je determinističen in obnovljiv.
 */
import { EINVOICE_STATUSES } from './einvoice-lifecycle'

/** Statusi, ki zahtevajo knjigovodsko pozornost (rdeči badge v portalu). */
export const EINVOICE_ALERT_STATUSES = ['failed', 'needs_review', 'rejected'] as const

/** Statusi, ki pomenijo »še NI poslano iz outboxa« (draft/validated/queued). */
export const EINVOICE_OUTSTANDING_STATUSES = ['draft', 'validated', 'queued'] as const

export interface PortalStatusRow {
  status: string
}

/**
 * Števec e-računov po statusih — zaprt seznam: vsak od 9 statusov dobí vnos
 * (0, če manjka). Neznani statusi se prezrejo (fail-safe, ne crash).
 */
export function countEInvoiceStatuses(rows: PortalStatusRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of EINVOICE_STATUSES) counts[s] = 0
  for (const r of rows) if (counts[r.status] !== undefined) counts[r.status] += 1
  return counts
}

export interface PortalBalanceTotals {
  debits: number
  credits: number
}

export interface PortalBalanceState {
  balanced: boolean
  /** debits - credits, zaokroženo na 2 decimalki (občutljivo na zaokroževanje) */
  diff: number
}

/**
 * Stanje balanse GL obračuna za obdobje — enako pravilo kot ruta GL
 * (r2g zaokroževanje; |diff| <= 0.02 je zaokroževalni radij, ki ga jedro
 * absorbira v 401/402, zato se tam že kvantificira kot uravnovešeno).
 */
export function glBalanceState(totals: PortalBalanceTotals): PortalBalanceState {
  const diff = Math.round((totals.debits - totals.credits + Number.EPSILON) * 100) / 100
  return { balanced: Math.abs(diff) <= 0.02, diff }
}

export interface PortalOutboxSummary {
  /** števec po vseh 9 statusih (zaprt seznam, manjkajoči = 0) */
  byStatus: Record<string, number>
  /** draft+validated+queued — v outboxu, še ni poslano */
  outstandingCount: number
  /** failed+needs_review+rejected — zahteva knjigovodsko pozornost */
  alertCount: number
  /** skupaj vrstic v periodi */
  total: number
}

/** Združen povzetek odpreme za UI (en klic, brez duplikata logike v komponenti). */
export function eInvoiceOutboxSummary(rows: PortalStatusRow[]): PortalOutboxSummary {
  const byStatus = countEInvoiceStatuses(rows)
  const outstandingCount = EINVOICE_OUTSTANDING_STATUSES.reduce((s, k) => s + (byStatus[k] ?? 0), 0)
  const alertCount = EINVOICE_ALERT_STATUSES.reduce((s, k) => s + (byStatus[k] ?? 0), 0)
  return { byStatus, outstandingCount, alertCount, total: rows.length }
}

export interface PortalExpenseRow {
  amount: number
  paidAmount: number
}

export interface PortalExpenseSummary {
  /** skupaj znesek prejetih računov v periodi */
  total: number
  /** znesek − plačano (odprte obveznosti do dobaviteljev) */
  outstanding: number
  /** število dokumentov */
  count: number
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** Čisti povzetek stroškov iz vrstic (agregat strežnika je v GET /api/expenses). */
export function expenseSummary(rows: PortalExpenseRow[]): PortalExpenseSummary {
  const total = r2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0))
  const paid = r2(rows.reduce((s, r) => s + (Number(r.paidAmount) || 0), 0))
  return { total, outstanding: r2(total - paid), count: rows.length }
}

/**
 * Meja obdobja za invoiceDate filter (strežniška pomožnica, brez IO):
 * 'YYYY-MM-DD' → [00:00:00, 23:59:59.999] lokalnega časa — ISTA konvencija
 * kot /api/einvoices GET (from T00:00:00 / to T23:59:59.999).
 */
export function expensePeriodRange(from: string, to: string): { gte: Date; lte: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null
  const gte = new Date(`${from}T00:00:00`)
  const lte = new Date(`${to}T23:59:59.999`)
  if (isNaN(gte.getTime()) || isNaN(lte.getTime())) return null
  return { gte, lte }
}
