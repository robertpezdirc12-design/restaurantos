import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, isCentralRole } from '@/lib/api'
import { prepMinutes, stationOf, kdsItemStats, kdsHeatmap, kdsTimeSplit, kdsDayKpi, kdsDelayCounts, type KdsSample } from '@/lib/kds-stats'
import { KDS_DELAY_ACTION } from '@/lib/kds-delays'

const ALLOWED_DAYS = [7, 14, 30] as const

/** Clamp `days` onto the allowed set 7|14|30 (default 7, nearest-value snapping). */
export function clampDays(raw: string | null): number {
  if (!raw) return 7
  const n = Number(raw)
  if (!Number.isFinite(n)) return 7
  const clamped = Math.min(30, Math.max(7, Math.round(n)))
  return ALLOWED_DAYS.reduce(
    (best, d) => (Math.abs(d - clamped) < Math.abs(best - clamped) ? d : best),
    7 as number
  )
}

/**
 * GET /api/kitchen/stats?days=7|14|30&station=KITCHEN|BAR
 *
 * KDS prep-time statistics (Lightspeed KDS 2.0 pattern), OPS-8 wave 1.
 * - Samples: non-voided OrderItems with BOTH firedAt and readyAt set
 *   (every path to the kitchen board goes through /api/orders/[id]/fire,
 *   which stamps firedAt; the kitchen PATCH stamps readyAt on READY).
 * - prepMin = (readyAt - firedAt) / 60000, kept raw (no outlier clamping);
 *   negative diffs (clock skew) are excluded.
 * - Station filter mirrors the KDS board buckets: PrepStation.type 'bar'
 *   = BAR, everything else (including no station) = KITCHEN.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'kitchen.update')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = clampDays(url.searchParams.get('days'))
  const stationParam = url.searchParams.get('station')
  const stationFilter = stationParam === 'BAR' || stationParam === 'KITCHEN' ? stationParam : null
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const orderScope = isCentralRole(user) ? {} : { locationId: user.loc || '__no_location__' }

  const rows = await db.orderItem.findMany({
    where: {
      voided: false,
      // firedAt >= since (operational window: prep activity in the period)
      firedAt: { gte: since },
      readyAt: { not: null },
      Order: orderScope,
    },
    select: {
      menuItemName: true,
      firedAt: true,
      readyAt: true,
      MenuItem: { select: { name: true, PrepStation: { select: { type: true } } } },
    },
    take: 50000,
  })

  const samples: KdsSample[] = []
  for (const r of rows) {
    if (!r.firedAt || !r.readyAt) continue
    const prepMin = prepMinutes(r.firedAt, r.readyAt)
    if (prepMin === null) continue
    const station = stationOf(r.MenuItem?.PrepStation?.type)
    if (stationFilter && station !== stationFilter) continue
    samples.push({ name: r.MenuItem?.name || r.menuItemName || '—', prepMin, firedAt: r.firedAt, station })
  }

  const kpi = {
    ...kdsDayKpi(samples, new Date()),
    ...kdsTimeSplit(samples),
  }

  // OPS-9 val 3 (v1.76.0): delay reasons from AuditLog KDS_DELAY rows in the period
  const delayRows = await db.auditLog.findMany({
    where: {
      action: KDS_DELAY_ACTION,
      timestamp: { gte: since },
      ...(isCentralRole(user) ? {} : { locationId: user.loc || '__no_location__' }),
    },
    select: { details: true },
    take: 5000,
  })

  return ok({
    days,
    generatedAt: new Date().toISOString(),
    kpi: {
      todayAvgPrep: kpi.avg,
      todayCount: kpi.count,
      onTimePct: kpi.onTimePct,
      okPct: kpi.okPct,
      warnPct: kpi.warnPct,
      latePct: kpi.latePct,
    },
    items: kdsItemStats(samples),
    heatmap: kdsHeatmap(samples),
    delays: kdsDelayCounts(delayRows),
  })
}
