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
  /** PRIMERJAVA §27 (v1.253.0) — ODPRTI RAČUNI (Square oktober 2026): aditivni blok
   * še ne poravnanih naročil (gosti še sedijo na mizah). OBSTOJEČA polja zgoraj
   * ostanejo IZKLJUČNO poravnana (računi) — odprti so ločeni, da pomen knjigovodskih
   * polj ne drsi. rows = najstarejših MAX_XZ_OPEN_ROWS za UI seznam (count je pošten). */
  openChecks: XzOpenChecks
  /** grossSales + openChecks.gross (ob izklopu = grossSales) */
  grossWithOpen: number
  /** netSales + openChecks.net (ob izklopu = netSales) */
  netWithOpen: number
}

/** Vrstica odprtega naročila za UI seznam (miza/brez mize, vrsta, znesek, kdaj odprto). */
export interface XzOpenCheckRow {
  orderNumber: number | null
  tableNumber: number | null
  type: string
  total: number
  createdAt: string
}

/** Odprti računi — aditivni blok X/Z poročila (PRIMERJAVA §27). */
export interface XzOpenChecks {
  included: boolean
  count: number
  gross: number
  net: number
  vat: number
  rows: XzOpenCheckRow[]
}

/** Varovalo seznama UI vrstic (najstarejši najprej; count ostane pošten prek agregata). */
export const MAX_XZ_OPEN_ROWS = 50

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
  /** PRIMERJAVA §27 (v1.253.0) — neobvezno: odprti računi (privzeto IZKLOP → ničle). */
  openChecks?: Partial<XzOpenChecks> | null
}): XzReport {
  const vatTotal = r2(input.vatByRate.reduce((a, v) => a + v.amount, 0))
  // §27: defenzivna normalizacija — manjkajoči/nesmiselni vhodi se spognejo v ničle,
  // rows se poreže na MAX_XZ_OPEN_ROWS, zneski zaokrožijo na cent (r2 disciplina sloja).
  const oc = input.openChecks || {}
  const ocIncluded = oc.included === true
  const ocCount = ocIncluded ? Math.max(0, Math.floor(num2(oc.count))) : 0
  const ocGross = ocIncluded ? r2(num2(oc.gross)) : 0
  const ocNet = ocIncluded ? r2(num2(oc.net)) : 0
  const ocVat = ocIncluded ? r2(num2(oc.vat)) : 0
  const ocRows = ocIncluded && Array.isArray(oc.rows)
    ? oc.rows.slice(0, MAX_XZ_OPEN_ROWS).map((r) => ({
      orderNumber: num2(r?.orderNumber) || null,
      tableNumber: num2(r?.tableNumber) || null,
      type: String(r?.type || ''),
      total: r2(num2(r?.total)),
      createdAt: String(r?.createdAt || ''),
    }))
    : []
  const grossSales = r2(input.grossSales)
  const netSales = r2(input.netSales)
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
    openChecks: { included: ocIncluded, count: ocCount, gross: ocGross, net: ocNet, vat: ocVat, rows: ocRows },
    grossWithOpen: r2(grossSales + ocGross),
    netWithOpen: r2(netSales + ocNet),
  }
}

/** §27 — defenzivna pretvorba neznanega števila (null/NaN/negativno → 0). */
function num2(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Delta arrow for the preview dialog: ▲ / ▼ / · (emerald / rose / muted handled by UI). */
export function deltaArrow(pct: number | null): string {
  if (pct === null) return '·'
  if (pct > 0) return '▲'
  if (pct < 0) return '▼'
  return '·'
}
