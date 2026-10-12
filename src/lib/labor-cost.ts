/**
 * OPS-10 val 1 (v1.77.0) — Labor cost % analytics, pure math layer.
 *
 * No DB, no I/O — the route (/api/reports/labor-cost, /api/reports/export
 * section=labor) feeds TimeEntry samples (+ per-day net sales) in.
 *
 * Conventions:
 *  - day = LOCAL calendar day; a shift crossing midnight is split at the
 *    24h boundaries (day = clockIn date for the first segment);
 *  - minutes per day = wall-clock overlap scaled by totalMinutes/wallMinutes,
 *    so the split always sums to DB totalMinutes (breaks subtracted once);
 *  - cost per day = totalPay * dayMinutes / totalMinutes (0 minutes → 0 cost);
 *  - laborPct = cost / netSales * 100, null when there is no net sales base.
 */

export interface LaborSample {
  clockIn: Date
  /** null = still open — the route substitutes `now` before calling in */
  clockOut: Date | null
  /** DB totalMinutes (breaks already subtracted) */
  totalMinutes: number
  /** DB totalPay in EUR */
  totalPay: number
  jobId: string | null
  /** TimeEntry.type: regular|overtime|holiday|sick|vacation */
  type: string
}

export interface LaborDayRow {
  date: string
  minutes: number
  cost: number
  overtimeMinutes: number
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/** Local calendar day key of a Date ('YYYY-MM-DD'). */
function dayKeyOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Splits shifts into per-day rows (date, minutes, cost, overtimeMinutes).
 * Entries with a null clockOut, non-finite/negative intervals or
 * totalMinutes <= 0 contribute nothing (open shifts must be resolved by the
 * caller — substitute clockOut = now + live minutes before feeding them in).
 * Rows are returned sorted by date ascending; cost rounded to 2 decimals,
 * minutes to 2 decimals (proportional split can produce fractions).
 */
export function laborByDay(samples: LaborSample[]): LaborDayRow[] {
  const rows = new Map<string, { minutes: number; cost: number; overtimeMinutes: number }>()
  const touch = (key: string) => {
    let row = rows.get(key)
    if (!row) {
      row = { minutes: 0, cost: 0, overtimeMinutes: 0 }
      rows.set(key, row)
    }
    return row
  }

  for (const s of samples) {
    if (!(s.clockIn instanceof Date) || Number.isNaN(s.clockIn.getTime())) continue
    if (!s.clockOut || !(s.clockOut instanceof Date) || Number.isNaN(s.clockOut.getTime())) continue
    const wallMs = s.clockOut.getTime() - s.clockIn.getTime()
    if (!Number.isFinite(wallMs) || wallMs <= 0) continue
    const totalMinutes = Number(s.totalMinutes)
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) continue
    const totalPay = Number(s.totalPay)
    const pay = Number.isFinite(totalPay) && totalPay > 0 ? totalPay : 0

    // per-local-day wall overlap in minutes, split at 24h boundaries
    const overlaps = new Map<string, number>()
    let cursor = new Date(s.clockIn)
    const end = s.clockOut
    while (cursor < end) {
      const key = dayKeyOf(cursor)
      const nextMidnight = new Date(cursor)
      nextMidnight.setHours(24, 0, 0, 0)
      const segEnd = nextMidnight < end ? nextMidnight : end
      const segMin = (segEnd.getTime() - cursor.getTime()) / 60000
      overlaps.set(key, (overlaps.get(key) || 0) + segMin)
      cursor = nextMidnight
    }

    const wallMin = wallMs / 60000
    const isOvertime = s.type === 'overtime'
    for (const [key, segMin] of overlaps) {
      const share = segMin / wallMin // proportional split, sums to 1
      const dayMinutes = r2(segMin * (totalMinutes / wallMin))
      const dayCost = r2(pay * share)
      const row = touch(key)
      row.minutes = r2(row.minutes + dayMinutes)
      row.cost = r2(row.cost + dayCost)
      if (isOvertime) row.overtimeMinutes = r2(row.overtimeMinutes + dayMinutes)
    }
  }

  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, row]) => ({ date, ...row }))
}

/**
 * Labor cost % of net sales; null when there is no base (netSales <= 0) —
 * the UI then shows "—" instead of a fake ∞. Rounded to 2 decimals.
 */
export function laborPct(cost: number, netSales: number): number | null {
  const base = Number(netSales)
  if (!Number.isFinite(base) || base <= 0) return null
  const c = Number.isFinite(cost) ? Math.max(0, cost) : 0
  return r2((c / base) * 100)
}

export interface LaborRoleRow {
  roleName: string
  minutes: number
  cost: number
}

/**
 * Per-role aggregation (TimeEntry.jobId → Job.name; null jobId / unknown job
 * → '—'). Sorted by cost desc then name — the UI takes the top slice.
 */
export function laborByRole(
  samples: LaborSample[],
  jobNames: Record<string, string>
): LaborRoleRow[] {
  const map = new Map<string, { minutes: number; cost: number }>()
  for (const s of samples) {
    if (!(s.clockIn instanceof Date) || Number.isNaN(s.clockIn.getTime())) continue
    if (!s.clockOut || !(s.clockOut instanceof Date) || Number.isNaN(s.clockOut.getTime())) continue
    const wallMs = s.clockOut.getTime() - s.clockIn.getTime()
    if (!Number.isFinite(wallMs) || wallMs <= 0) continue
    const totalMinutes = Number(s.totalMinutes)
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) continue
    const totalPay = Number(s.totalPay)
    const pay = Number.isFinite(totalPay) && totalPay > 0 ? totalPay : 0
    const roleName = (s.jobId && jobNames[s.jobId]) || '—'
    const row = map.get(roleName) || { minutes: 0, cost: 0 }
    row.minutes = r2(row.minutes + totalMinutes)
    row.cost = r2(row.cost + pay)
    map.set(roleName, row)
  }
  return [...map.entries()]
    .map(([roleName, row]) => ({ roleName, ...row }))
    .sort((a, b) => b.cost - a.cost || a.roleName.localeCompare(b.roleName))
}
