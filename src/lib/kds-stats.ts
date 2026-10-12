/**
 * KDS (kitchen display) prep-time statistics — pure aggregation functions.
 *
 * OPS-8 wave 1 (v1.71.0). No DB imports; the API route
 * (src/app/api/kitchen/stats) fetches OrderItem rows (voided=false,
 * firedAt != null, readyAt != null) and feeds them in as samples.
 *
 * Escalation thresholds align with the live KDS board timers (5/10 min):
 * <= 5 min ok, 5-10 min warning, > 10 min late. onTimePct = share <= 10 min.
 */

import { KDS_DELAY_REASONS, type KdsDelayReason } from '@/lib/kds-delays'

export interface KdsSample {
  /** menu item display name (OrderItem.menuItemName) */
  name: string
  /** prep minutes = (readyAt - firedAt) / 60000, never negative (skew guarded) */
  prepMin: number
  /** when the item was fired to the kitchen */
  firedAt: Date
  /** KDS station bucket derived from MenuItem.PrepStation.type ('BAR' | 'KITCHEN') */
  station: string
}

export interface KdsItemStat {
  name: string
  count: number
  avg: number
  min: number
  max: number
  latePct: number
}

export interface KdsHeatCell {
  hour: number
  half: 0 | 1
  avg: number
  count: number
}

export interface KdsTimeSplit {
  okPct: number
  warnPct: number
  latePct: number
  onTimePct: number
}

const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100

/** Raw prep minutes between firedAt and readyAt; null when data is unusable. */
export function prepMinutes(firedAt: Date, readyAt: Date): number | null {
  const ms = readyAt.getTime() - firedAt.getTime()
  // negative diff = clock skew / data error -> exclude rather than poison averages
  if (!Number.isFinite(ms) || ms < 0) return null
  return ms / 60000
}

/** KDS station bucket from PrepStation.type — mirrors stationToUI in map.ts. */
export function stationOf(type?: string | null): string {
  return type?.toLowerCase() === 'bar' ? 'BAR' : 'KITCHEN'
}

/** Per-item aggregation: count, avg/min/max prep, late share. Sorted by count desc. */
export function kdsItemStats(samples: KdsSample[]): KdsItemStat[] {
  const byName = new Map<string, number[]>()
  for (const s of samples) {
    const arr = byName.get(s.name)
    if (arr) arr.push(s.prepMin)
    else byName.set(s.name, [s.prepMin])
  }
  const out: KdsItemStat[] = []
  for (const [name, arr] of byName) {
    const count = arr.length
    const total = arr.reduce((s, v) => s + v, 0)
    const late = arr.filter((v) => v > 10).length
    out.push({
      name,
      count,
      avg: r1(total / count),
      min: r1(Math.min(...arr)),
      max: r1(Math.max(...arr)),
      latePct: r1((late / count) * 100),
    })
  }
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return out
}

/** 48 half-hour buckets (hour 0-23, half 0|1) of the day; empty buckets have avg 0, count 0. */
export function kdsHeatmap(samples: KdsSample[]): KdsHeatCell[] {
  const buckets = new Map<string, { sum: number; count: number }>()
  for (const s of samples) {
    const hour = s.firedAt.getHours()
    const half = s.firedAt.getMinutes() < 30 ? 0 : 1
    const key = `${hour}:${half}`
    const b = buckets.get(key) || { sum: 0, count: 0 }
    b.sum += s.prepMin
    b.count += 1
    buckets.set(key, b)
  }
  const out: KdsHeatCell[] = []
  for (let hour = 0; hour < 24; hour++) {
    for (const half of [0, 1] as const) {
      const b = buckets.get(`${hour}:${half}`)
      out.push({ hour, half, avg: b && b.count > 0 ? r2(b.sum / b.count) : 0, count: b?.count || 0 })
    }
  }
  return out
}

/** Escalation split against the 5/10 min thresholds. onTimePct = ok + warn (<= 10 min). */
export function kdsTimeSplit(samples: KdsSample[]): KdsTimeSplit {
  const n = samples.length
  if (n === 0) return { okPct: 0, warnPct: 0, latePct: 0, onTimePct: 0 }
  const ok = samples.filter((s) => s.prepMin <= 5).length
  const warn = samples.filter((s) => s.prepMin > 5 && s.prepMin <= 10).length
  const late = samples.filter((s) => s.prepMin > 10).length
  const okPct = r1((ok / n) * 100)
  const warnPct = r1((warn / n) * 100)
  const latePct = r1((late / n) * 100)
  return { okPct, warnPct, latePct, onTimePct: r1(((ok + warn) / n) * 100) }
}

/** Avg prep + count of items fired on the same local calendar day as `ref`. */
export function kdsDayKpi(samples: KdsSample[], ref: Date): { avg: number; count: number } {
  const y = ref.getFullYear()
  const m = ref.getMonth()
  const d = ref.getDate()
  const same = samples.filter((s) => {
    const t = s.firedAt
    return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d
  })
  if (same.length === 0) return { avg: 0, count: 0 }
  return { avg: r1(same.reduce((s, v) => s + v.prepMin, 0) / same.length), count: same.length }
}

/* ───── OPS-9 val 3 (v1.76.0) — delay reasons (AuditLog KDS_DELAY aggregation) ───── */

export interface KdsDelayCount {
  reason: KdsDelayReason
  count: number
}

/**
 * Aggregate AuditLog KDS_DELAY rows (details JSON with a `reason` field) into
 * { reason, count }[] over the fixed catalog, sorted by count desc then reason.
 * Unknown / missing / unparseable reasons are skipped (catalog-only report).
 */
export function kdsDelayCounts(rows: { details?: string | null }[]): KdsDelayCount[] {
  const counts = new Map<KdsDelayReason, number>()
  for (const r of rows) {
    let reason = ''
    try {
      const parsed: unknown = r.details ? JSON.parse(r.details) : null
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        reason = String((parsed as Record<string, unknown>).reason ?? '')
      }
    } catch {
      continue
    }
    if ((KDS_DELAY_REASONS as readonly string[]).includes(reason)) {
      counts.set(reason as KdsDelayReason, (counts.get(reason as KdsDelayReason) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}
