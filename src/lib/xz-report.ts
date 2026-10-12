/**
 * OPS-8 val 3 (v1.73.0) — X/Z business report pure math layer (Lightspeed
 * Business Report pattern). No DB, no I/O — the route (/api/reports/export
 * section=zz) feeds raw aggregates in and renders JSON/CSV out.
 *
 * Conventions follow the existing accounting export:
 *  - all money values are EUR rounded to 2 decimals;
 *  - "gross" = incl. VAT, excl. tips; "net" = excl. VAT;
 *  - covers = number of (non-voided) receipts in the period.
 */

export interface XzVatRow {
  rate: number
  base: number
  amount: number
}

export interface XzPaymentRow {
  method: string
  amount: number
}

export interface XzComparison {
  prevFrom: string
  prevTo: string
  prevNetSales: number
  prevCovers: number
  /** percent change vs previous period; null when the previous period is empty (no baseline) */
  deltaNetPct: number | null
  deltaCoversPct: number | null
}

export interface XzReport {
  from: string
  to: string
  grossSales: number
  netSales: number
  vatTotal: number
  vatByRate: XzVatRow[]
  paymentsByMethod: XzPaymentRow[]
  discountsTotal: number
  tipsTotal: number
  voidedCount: number
  voidedTotal: number
  wasteTotal: number
  covers: number
  avgCheck: number
  avgPartySize: number
  comparison: XzComparison
}

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
/** one decimal, used for percentages */
export const r1 = (n: number): number => Math.round((n + Number.EPSILON) * 10) / 10

/**
 * Immediately preceding window of the SAME length as [from, to] (inclusive day range).
 * [2026-02-01T00:00, 2026-02-10T23:59:59.999] → [2026-01-22T00:00, 2026-01-31T23:59:59.999].
 */
export function prevWindow(from: Date, to: Date): { from: Date; to: Date } {
  const spanMs = to.getTime() - from.getTime() + 1
  const prevTo = new Date(from.getTime() - 1)
  const prevFrom = new Date(from.getTime() - spanMs)
  return { from: prevFrom, to: prevTo }
}

/**
 * Percent change vs previous period. Returns null when there is no baseline
 * (previous <= 0) — the UI then shows "no comparison data" instead of a fake ∞.
 */
export function deltaPct(current: number, prev: number): number | null {
  if (!(prev > 0)) return null
  return r1(((current - prev) / prev) * 100)
}

/** Average check = net sales / covers, 2 decimals; 0 when there were no covers. */
export function avgCheckOf(netSales: number, covers: number): number {
  if (!(covers > 0)) return 0
  return r2(netSales / covers)
}

/** Mean party size of non-cancelled reservations; 0 when the list is empty. */
export function avgPartySizeOf(sizes: number[]): number {
  const valid = sizes.filter((s) => Number.isFinite(s) && s > 0)
  if (valid.length === 0) return 0
  return r2(valid.reduce((a, b) => a + b, 0) / valid.length)
}

/** Assembles the report from pre-aggregated inputs (all money already rounded by caller). */
export function buildXzReport(input: {
  from: string
  to: string
  grossSales: number
  netSales: number
  vatByRate: XzVatRow[]
  paymentsByMethod: XzPaymentRow[]
  discountsTotal: number
  tipsTotal: number
  voidedCount: number
  voidedTotal: number
  wasteTotal: number
  covers: number
  avgPartySize: number
  prevNetSales: number
  prevCovers: number
  prevFrom: string
  prevTo: string
}): XzReport {
  const vatTotal = r2(input.vatByRate.reduce((a, v) => a + v.amount, 0))
  return {
    from: input.from,
    to: input.to,
    grossSales: r2(input.grossSales),
    netSales: r2(input.netSales),
    vatTotal,
    vatByRate: [...input.vatByRate].sort((a, b) => a.rate - b.rate),
    paymentsByMethod: [...input.paymentsByMethod].sort((a, b) => b.amount - a.amount),
    discountsTotal: r2(input.discountsTotal),
    tipsTotal: r2(input.tipsTotal),
    voidedCount: input.voidedCount,
    voidedTotal: r2(input.voidedTotal),
    wasteTotal: r2(input.wasteTotal),
    covers: input.covers,
    avgCheck: avgCheckOf(input.netSales, input.covers),
    avgPartySize: input.avgPartySize,
    comparison: {
      prevFrom: input.prevFrom,
      prevTo: input.prevTo,
      prevNetSales: r2(input.prevNetSales),
      prevCovers: input.prevCovers,
      deltaNetPct: deltaPct(input.netSales, input.prevNetSales),
      deltaCoversPct: deltaPct(input.covers, input.prevCovers),
    },
  }
}

/** Delta arrow for the preview dialog: ▲ / ▼ / · (emerald / rose / muted handled by UI). */
export function deltaArrow(pct: number | null): string {
  if (pct === null) return '·'
  if (pct > 0) return '▲'
  if (pct < 0) return '▼'
  return '·'
}
