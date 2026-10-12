/**
 * OPS-10 val 1 (v1.77.0) — Sales-by-hour analytics, pure math layer.
 *
 * No DB, no I/O — the route (/api/reports/sales-by-hour, /api/reports/export
 * section=sbh) feeds raw paid-order samples in and renders JSON/CSV out.
 * Mirrors the xz-report.ts convention: clean functions, money rounded to
 * 2 decimals, UI renders whatever this module returns.
 *
 * Buckets: 1h granularity (hour 0-23, local time from paidAt.getHours()),
 * one full 24-bucket row per calendar day (day key 'YYYY-MM-DD' local).
 * Heat classes: quantile edges (5 classes) over non-zero revenues.
 */

export interface SalesHourSample {
  /** when the order was paid (Order.paidAt) */
  paidAt: Date
  /** paid amount (Order.total, incl. VAT) */
  total: number
  /** optional origin channel (Order.orderSource: pos|qr|kiosk|...) */
  orderSource?: string
}

export interface SalesHourBucket {
  /** hour of day 0-23 (local) */
  hour: number
  /** sum of paid totals in the bucket, 2 decimals */
  revenue: number
  /** number of paid orders in the bucket */
  orders: number
  /** revenue / orders, 2 decimals (0 when orders = 0) */
  avgCheck: number
}

export interface SalesByDay {
  /** local calendar day 'YYYY-MM-DD' */
  date: string
  /** always 24 buckets, hour 0..23 ascending */
  dayBuckets: SalesHourBucket[]
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** Local calendar day key of a Date ('YYYY-MM-DD'). */
export function dayKeyOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Empty bucket template (revenue 0, orders 0, avgCheck 0). */
function emptyBucket(hour: number): SalesHourBucket {
  return { hour, revenue: 0, orders: 0, avgCheck: 0 }
}

/**
 * Aggregates paid-order samples into per-day 24h buckets + period totals.
 * Days are returned sorted ascending; every day has exactly 24 buckets
 * (empty ones included) so the UI can render a full heatmap grid.
 * Non-finite / negative totals are ignored (data-error guard, same policy
 * as prepMinutes clock-skew exclusion in kds-stats).
 */
export function salesByHour(samples: SalesHourSample[]): { days: SalesByDay[]; totals: SalesHourBucket[] } {
  const dayMap = new Map<string, { sum: number; orders: number }[]>()
  const totalMap: { sum: number; orders: number }[] = Array.from({ length: 24 }, () => ({ sum: 0, orders: 0 }))

  for (const s of samples) {
    if (!(s.paidAt instanceof Date) || Number.isNaN(s.paidAt.getTime())) continue
    const total = Number(s.total)
    if (!Number.isFinite(total) || total < 0) continue
    const hour = s.paidAt.getHours()
    const key = dayKeyOf(s.paidAt)
    let buckets = dayMap.get(key)
    if (!buckets) {
      buckets = Array.from({ length: 24 }, (_, h) => ({ sum: 0, orders: 0 }))
      dayMap.set(key, buckets)
    }
    buckets[hour].sum += total
    buckets[hour].orders += 1
    totalMap[hour].sum += total
    totalMap[hour].orders += 1
  }

  const finalize = (b: { sum: number; orders: number }, hour: number): SalesHourBucket => ({
    hour,
    revenue: r2(b.sum),
    orders: b.orders,
    avgCheck: b.orders > 0 ? r2(b.sum / b.orders) : 0,
  })

  const days: SalesByDay[] = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, buckets]) => ({
      date,
      dayBuckets: buckets.map((b, hour) => finalize(b, hour)),
    }))
  const totals = totalMap.map((b, hour) => finalize(b, hour))
  return { days, totals }
}

/**
 * Quantile edges for the heatmap color scale: `classes` classes need
 * `classes - 1` internal edges computed over NON-ZERO revenues
 * (zero buckets stay in the lowest class regardless of the scale).
 * Linear-interpolation quantiles (numpy 'linear' method), deduped ascending,
 * rounded to 2 decimals. Empty / all-zero input → [] (UI renders all empty).
 */
export function heatQuantiles(buckets: SalesHourBucket[], classes = 5): number[] {
  const clamped = Math.max(2, Math.round(classes))
  const values = buckets
    .map((b) => Number(b.revenue))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b)
  if (values.length === 0) return []
  const edges: number[] = []
  for (let k = 1; k < clamped; k++) {
    const p = k / clamped
    const pos = p * (values.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    const q = lo === hi ? values[lo] : values[lo] + (values[hi] - values[lo]) * (pos - lo)
    edges.push(r2(q))
  }
  // dedupe (equal adjacent edges would create unreachable classes)
  return [...new Set(edges)]
}

/**
 * Heat class of a revenue against quantile edges: 0 (lowest) .. edges.length.
 * revenue <= 0 → always 0; boundary semantics: revenue >= edge → next class.
 */
export function heatClass(revenue: number, edges: number[]): number {
  if (!Number.isFinite(revenue) || revenue <= 0) return 0
  let cls = 0
  for (const e of edges) {
    if (Number.isFinite(e) && revenue >= e) cls += 1
    else break
  }
  return cls
}
