import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import { salesByHour, heatQuantiles, type SalesHourSample } from '@/lib/sales-by-hour'

/** Clamp `days` to 1..90 (default 7) — analytics window guard. */
export function clampDays(raw: string | null): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 7
  return Math.min(90, Math.max(1, n))
}

/**
 * GET /api/reports/sales-by-hour?days=7
 *
 * OPS-10 val 1 (v1.77.0) — sales-by-hour heatmap (Toast hourly-sales pattern).
 * Source: paid Orders (paidAt != null, paidAt >= since), revenue = Order.total
 * (incl. VAT), grouped by LOCAL hour of paidAt via the pure layer
 * src/lib/sales-by-hour.ts. Location scope mirrors /api/reports/export
 * (central roles = whole organization, staff = own location only).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = clampDays(url.searchParams.get('days'))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const locScope = await locationScope(user)
  const orders = await db.order.findMany({
    where: { paidAt: { gte: since }, ...locScope },
    select: { paidAt: true, total: true, orderSource: true },
    take: 50000,
  })

  const samples: SalesHourSample[] = []
  for (const o of orders) {
    if (!o.paidAt) continue
    samples.push({ paidAt: o.paidAt, total: num(o.total), orderSource: o.orderSource })
  }

  const { days: byDay, totals } = salesByHour(samples)
  return ok({
    // `days` = per-day bucket rows (plan spec); window length travels as periodDays
    days: byDay,
    periodDays: days,
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    totals,
    edges: heatQuantiles(totals, 5),
  })
}
