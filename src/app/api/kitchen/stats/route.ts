import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { prepMinutes, stationOf, kdsItemStats, kdsHeatmap, kdsTimeSplit, kdsDayKpi, kdsDelayCounts, kdsStationBreakdown, type KdsSample } from '@/lib/kds-stats'
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

  // Issue #5 (P0, kommentar #6): org allow-lista (prej centralna vloga VSE organizacije)
  const orderScope = await locationScope(user)

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
      locationId: orderScope.locationId ?? undefined,
    },
    select: { details: true },
    take: 5000,
  })

  // OPS-10 val 1 (v1.77.0): per-station targets from PrepStation.avgPrepTime.
  // Active stations are mapped onto the two KDS buckets (stationOf(type));
  // when several active stations share a bucket the first by sortOrder wins.
  const prepStations = await db.prepStation.findMany({
    where: { isActive: true },
    select: { id: true, name: true, type: true, avgPrepTime: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  const bucketAvg = new Map<string, number>()
  const stationConfig: Array<{ id: string; name: string; type: string; bucket: 'BAR' | 'KITCHEN'; avgPrepTime: number }> = []
  for (const ps of prepStations) {
    const bucket = stationOf(ps.type) as 'BAR' | 'KITCHEN'
    if (!bucketAvg.has(bucket)) bucketAvg.set(bucket, ps.avgPrepTime)
    stationConfig.push({ id: ps.id, name: ps.name, type: ps.type, bucket, avgPrepTime: ps.avgPrepTime })
  }
  const targets = {
    BAR: bucketAvg.get('BAR') ?? 5,
    KITCHEN: bucketAvg.get('KITCHEN') ?? 10,
  }

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
    // OPS-10 val 1 (v1.77.0) — additive keys (back-compat: existing keys untouched)
    targets,
    stations: kdsStationBreakdown(samples, targets),
    stationConfig,
  })
}
