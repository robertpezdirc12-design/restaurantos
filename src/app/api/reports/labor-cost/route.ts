import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import {
  laborByDay, laborByRole, laborPct, type LaborSample,
} from '@/lib/labor-cost'
import { dayKeyOf } from '@/lib/sales-by-hour'
import { liveMinutes, totalPayCents } from '@/lib/timeclock'

/** Clamp `days` to 1..90 (default 7) — analytics window guard. */
export function clampDays(raw: string | null): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 7
  return Math.min(90, Math.max(1, n))
}

/** Labor % management target (Lightspeed/Toast benchmark band midpoint). */
export const LABOR_TARGET_PCT = 32

/**
 * GET /api/reports/labor-cost?days=7
 *
 * OPS-10 val 1 (v1.77.0) — labor cost % (Toast punch×wage/netSales pattern).
 * Sources:
 *  - TimeEntry (clockIn >= since; OPEN entries included — counted up to now
 *    with the live-minutes convention from timeclock.ts and payRate snapshot
 *    proration, since totalPay/totalMinutes are only stamped on clock-out);
 *  - net sales per day from PAID Orders (paymentStatus='paid', paidAt set;
 *    net = subtotal − discount, excl. VAT — same net convention as Receipt).
 * Location scope mirrors /api/reports/export. All aggregation goes through
 * the pure layer src/lib/labor-cost.ts.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = clampDays(url.searchParams.get('days'))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const now = new Date()

  const locScope = await locationScope(user)
  const [entries, paidOrders] = await Promise.all([
    db.timeEntry.findMany({
      where: { clockIn: { gte: since }, ...locScope },
      select: {
        clockIn: true, clockOut: true, breakMinutes: true,
        totalMinutes: true, totalPay: true, payRate: true,
        type: true, jobId: true,
        Job: { select: { name: true } },
      },
      take: 50000,
    }),
    db.order.findMany({
      where: { paidAt: { gte: since }, paymentStatus: 'paid', ...locScope },
      select: { paidAt: true, subtotal: true, discount: true },
      take: 50000,
    }),
  ])

  // Open entries: substitute clockOut = now + live minutes (breaks subtracted)
  // + payRate proration (totalPay/totalMinutes are stamped only on clock-out).
  const samples: LaborSample[] = entries.map((e) => {
    if (e.clockOut) {
      return {
        clockIn: e.clockIn,
        clockOut: e.clockOut,
        totalMinutes: e.totalMinutes,
        totalPay: num(e.totalPay),
        jobId: e.jobId,
        type: e.type,
      }
    }
    const live = liveMinutes(e.clockIn.getTime(), now.getTime(), e.breakMinutes)
    const livePay = live > 0 ? num(totalPayCents(live, Math.round(num(e.payRate) * 100))) / 100 : 0
    return {
      clockIn: e.clockIn,
      clockOut: now,
      totalMinutes: live,
      totalPay: livePay,
      jobId: e.jobId,
      type: e.type,
    }
  })

  const jobNames: Record<string, string> = {}
  for (const e of entries) if (e.jobId && e.Job?.name) jobNames[e.jobId] = e.Job.name

  // net sales per paid-at day (subtotal − discount, excl. VAT)
  const netByDay = new Map<string, number>()
  for (const o of paidOrders) {
    if (!o.paidAt) continue
    const key = dayKeyOf(o.paidAt)
    const net = Math.max(0, num(o.subtotal) - num(o.discount))
    netByDay.set(key, (netByDay.get(key) || 0) + net)
  }

  const dayRows = laborByDay(samples)
  const roleRows = laborByRole(samples, jobNames)

  const outDays = dayRows.map((d) => {
    const netSales = Math.round((netByDay.get(d.date) || 0) * 100) / 100
    return { date: d.date, cost: d.cost, minutes: d.minutes, overtimeMinutes: d.overtimeMinutes, netSales, pct: laborPct(d.cost, netSales) }
  })

  const totalCost = Math.round(dayRows.reduce((a, d) => a + d.cost, 0) * 100) / 100
  const totalMinutes = Math.round(dayRows.reduce((a, d) => a + d.minutes, 0) * 100) / 100
  const totalOvertimeMinutes = Math.round(dayRows.reduce((a, d) => a + d.overtimeMinutes, 0) * 100) / 100
  const totalNetSales = Math.round([...netByDay.values()].reduce((a, v) => a + v, 0) * 100) / 100

  return ok({
    days: outDays,
    roles: roleRows,
    summary: {
      periodDays: days,
      totalCost,
      totalMinutes,
      totalOvertimeMinutes,
      totalNetSales,
      avgPct: laborPct(totalCost, totalNetSales),
      targetPct: LABOR_TARGET_PCT,
    },
    generatedAt: now.toISOString(),
  })
}
