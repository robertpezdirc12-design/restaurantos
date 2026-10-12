/**
 * OPS-10 val 1 — analytics pure math (NO db fixtures).
 *
 * Covers:
 *  - src/lib/sales-by-hour.ts: salesByHour (buckets, multi-day, avgCheck,
 *    rounding, garbage-input guard), heatQuantiles (quantile edges, dedupe,
 *    empty input), heatClass (boundaries).
 *  - src/lib/labor-cost.ts: laborByDay (same-day, overnight 24h split,
 *    proportional cost proration, overtime marking, open/zero guards),
 *    laborPct (null base, rounding), laborByRole.
 *  - src/lib/kds-stats.ts OPS-10 extensions: stationTarget (fallback 5/10,
 *    PrepStation override, min 1), classifyPrep (exact boundaries),
 *    kdsStationBreakdown (grouping, per-target pct, back-compat of the
 *    existing 5/10 kdsTimeSplit is NOT touched).
 *
 * Pure data only — no DB, no auth, no fixtures.
 */
import { describe, it, expect } from 'bun:test'
import {
  salesByHour, heatQuantiles, heatClass, dayKeyOf,
  type SalesHourSample,
} from '@/lib/sales-by-hour'
import {
  laborByDay, laborPct, laborByRole,
  type LaborSample,
} from '@/lib/labor-cost'
import {
  stationTarget, classifyPrep, kdsStationBreakdown, kdsTimeSplit,
  type KdsSample,
} from '@/lib/kds-stats'

const paid = (y: number, m: number, d: number, h: number, total: number, source = 'pos'): SalesHourSample => ({
  paidAt: new Date(y, m, d, h, 15, 0),
  total,
  orderSource: source,
})

const shift = (over: Partial<LaborSample> & { clockIn: Date; clockOut: Date | null }): LaborSample => ({
  totalMinutes: 480,
  totalPay: 96,
  jobId: 'job-a',
  type: 'regular',
  ...over,
})

const kds = (over: Partial<KdsSample>): KdsSample => ({
  name: 'Burger',
  prepMin: 5,
  firedAt: new Date(2026, 1, 10, 12, 0, 0),
  station: 'KITCHEN',
  ...over,
})

describe('OPS-10 salesByHour', () => {
  it('buckets by local hour and produces exactly 24 buckets per day', () => {
    const { days, totals } = salesByHour([
      paid(2026, 1, 10, 12, 24.5),
      paid(2026, 1, 10, 12, 10),
      paid(2026, 1, 10, 23, 8),
    ])
    expect(days.length).toBe(1)
    expect(days[0].date).toBe('2026-02-10')
    expect(days[0].dayBuckets.length).toBe(24)
    const h12 = days[0].dayBuckets[12]
    expect(h12.hour).toBe(12)
    expect(h12.revenue).toBe(34.5)
    expect(h12.orders).toBe(2)
    expect(h12.avgCheck).toBe(17.25) // 34.5 / 2
    expect(days[0].dayBuckets[23].revenue).toBe(8)
    // empty buckets are zeroed
    expect(days[0].dayBuckets[3]).toEqual({ hour: 3, revenue: 0, orders: 0, avgCheck: 0 })
    // totals aggregate over all days
    expect(totals[12].revenue).toBe(34.5)
    expect(totals[12].orders).toBe(2)
    expect(totals.length).toBe(24)
  })

  it('splits multiple days and sorts them ascending', () => {
    const { days } = salesByHour([
      paid(2026, 1, 12, 9, 10),
      paid(2026, 1, 10, 9, 20),
      paid(2026, 1, 11, 9, 30),
    ])
    expect(days.map((d) => d.date)).toEqual(['2026-02-10', '2026-02-11', '2026-02-12'])
    expect(days[0].dayBuckets[9].revenue).toBe(20)
    expect(days[2].dayBuckets[9].revenue).toBe(10)
  })

  it('avgCheck is 0 for empty buckets and revenue is rounded to 2 decimals', () => {
    const { days } = salesByHour([
      paid(2026, 1, 10, 8, 0.1),
      paid(2026, 1, 10, 8, 0.2),
      paid(2026, 1, 10, 8, 0.0001),
    ])
    const b = days[0].dayBuckets[8]
    expect(b.avgCheck).toBe(0.1) // 0.3001/3 → r2 0.1
    expect(b.revenue).toBe(0.3)
    expect(days[0].dayBuckets[7].avgCheck).toBe(0)
  })

  it('ignores garbage samples (negative / non-finite totals, invalid dates)', () => {
    const { totals } = salesByHour([
      paid(2026, 1, 10, 12, -5),
      { paidAt: new Date(2026, 1, 10, 12), total: Number.NaN },
      { paidAt: new Date('nope'), total: 10 },
      paid(2026, 1, 10, 12, 42),
    ])
    expect(totals[12]).toEqual({ hour: 12, revenue: 42, orders: 1, avgCheck: 42 })
  })
})

describe('OPS-10 heatQuantiles / heatClass', () => {
  const buckets = (revs: number[]) => revs.map((revenue, hour) => ({ hour, revenue, orders: 1, avgCheck: revenue }))

  it('returns classes-1 ascending edges over non-zero revenues (linear interpolation)', () => {
    expect(heatQuantiles(buckets([10, 20, 30, 40, 50]), 5)).toEqual([18, 26, 34, 42])
    expect(heatQuantiles(buckets([5, 1, 3, 9, 7]), 5)).toEqual([2.6, 4.2, 5.8, 7.4])
  })

  it('excludes zero revenues and dedupes equal edges', () => {
    expect(heatQuantiles(buckets([0, 0, 10, 10, 10, 10]), 5)).toEqual([10]) // all quantiles collapse to 10
    expect(heatQuantiles(buckets([0, 0, 0]), 5)).toEqual([]) // all zero → no scale
    expect(heatQuantiles([], 5)).toEqual([]) // empty → no scale
  })

  it('heatClass boundaries: 0 for empty, >= edge steps up, capped at edges.length', () => {
    const edges = [18, 26, 34, 42]
    expect(heatClass(0, edges)).toBe(0)
    expect(heatClass(-3, edges)).toBe(0)
    expect(heatClass(17.99, edges)).toBe(0)
    expect(heatClass(18, edges)).toBe(1) // >= edge steps up (boundary inclusive)
    expect(heatClass(26, edges)).toBe(2)
    expect(heatClass(41.5, edges)).toBe(3)
    expect(heatClass(42, edges)).toBe(4)
    expect(heatClass(9999, edges)).toBe(4)
    expect(heatClass(Number.NaN, edges)).toBe(0)
    expect(heatClass(50, [])).toBe(0) // no edges → everything in class 0
  })
})

describe('OPS-10 laborByDay', () => {
  it('same-day shift: one row on the clockIn date, minutes = totalMinutes, cost = totalPay', () => {
    const rows = laborByDay([
      shift({
        clockIn: new Date(2026, 1, 10, 9, 0),
        clockOut: new Date(2026, 1, 10, 17, 0),
        totalMinutes: 450, // 30 min break
        totalPay: 63.75,
      }),
    ])
    expect(rows.length).toBe(1)
    expect(rows[0].date).toBe('2026-02-10')
    expect(rows[0].minutes).toBe(450)
    expect(rows[0].cost).toBe(63.75)
    expect(rows[0].overtimeMinutes).toBe(0)
  })

  it('overnight shift splits at midnight proportionally; minutes and cost sums are preserved', () => {
    // 22:00 → 06:00 (480 wall), 450 paid minutes, 63.75 EUR
    const rows = laborByDay([
      shift({
        clockIn: new Date(2026, 1, 10, 22, 0),
        clockOut: new Date(2026, 1, 11, 6, 0),
        totalMinutes: 450,
        totalPay: 63.75,
      }),
    ])
    expect(rows.map((r) => r.date)).toEqual(['2026-02-10', '2026-02-11'])
    // wall overlap 120 / 360 → scaled by 450/480 = 0.9375
    expect(rows[0].minutes).toBeCloseTo(112.5, 2)
    expect(rows[1].minutes).toBeCloseTo(337.5, 2)
    // cost = totalPay/totalMinutes * deljeniMin (== proportional share of totalPay)
    expect(rows[0].cost).toBeCloseTo(15.94, 2)
    expect(rows[1].cost).toBeCloseTo(47.81, 2)
    expect(rows[0].minutes + rows[1].minutes).toBeCloseTo(450, 2)
    expect(rows[0].cost + rows[1].cost).toBeCloseTo(63.75, 2)
  })

  it('overtime minutes are tracked only for type=overtime entries', () => {
    const rows = laborByDay([
      shift({
        clockIn: new Date(2026, 1, 10, 9, 0),
        clockOut: new Date(2026, 1, 10, 17, 0),
        totalMinutes: 480, totalPay: 96, type: 'overtime',
      }),
      shift({
        clockIn: new Date(2026, 1, 10, 9, 0),
        clockOut: new Date(2026, 1, 10, 13, 0),
        totalMinutes: 240, totalPay: 40, type: 'regular',
      }),
    ])
    expect(rows[0].minutes).toBe(720)
    expect(rows[0].overtimeMinutes).toBe(480)
    expect(rows[0].cost).toBe(136) // 96 + 40
  })

  it('guards: open entry (clockOut null), zero/negative minutes, reversed interval → skipped; NaN pay → 0 cost', () => {
    const rows = laborByDay([
      shift({ clockIn: new Date(2026, 1, 10, 9, 0), clockOut: null }), // open
      shift({ clockIn: new Date(2026, 1, 10, 9, 0), clockOut: new Date(2026, 1, 10, 17, 0), totalMinutes: 0 }),
      shift({ clockIn: new Date(2026, 1, 10, 17, 0), clockOut: new Date(2026, 1, 10, 9, 0) }), // skew
      shift({ clockIn: new Date(2026, 1, 10, 9, 0), clockOut: new Date(2026, 1, 10, 17, 0), totalPay: Number.NaN }),
    ])
    // minutes still count for the valid shift even when pay is unusable (cost 0)
    expect(rows).toEqual([{ date: '2026-02-10', minutes: 480, cost: 0, overtimeMinutes: 0 }])
  })
})

describe('OPS-10 laborPct', () => {
  it('null when there is no net sales base', () => {
    expect(laborPct(100, 0)).toBeNull()
    expect(laborPct(100, -5)).toBeNull()
    expect(laborPct(100, Number.NaN)).toBeNull()
  })

  it('cost / netSales × 100 rounded to 2 decimals', () => {
    expect(laborPct(32, 100)).toBe(32)
    expect(laborPct(63.75, 291.43)).toBe(21.87)
    expect(laborPct(1, 3)).toBe(33.33)
    expect(laborPct(0, 100)).toBe(0)
  })
})

describe('OPS-10 laborByRole', () => {
  it('maps jobId → Job.name, groups, sorts by cost desc; unknown job → "—"', () => {
    const rows = laborByRole(
      [
        shift({ clockIn: new Date(2026, 1, 10, 9, 0), clockOut: new Date(2026, 1, 10, 17, 0), totalMinutes: 480, totalPay: 96, jobId: 'job-a' }),
        shift({ clockIn: new Date(2026, 1, 10, 9, 0), clockOut: new Date(2026, 1, 10, 13, 0), totalMinutes: 240, totalPay: 40, jobId: 'job-a' }),
        shift({ clockIn: new Date(2026, 1, 10, 9, 0), clockOut: new Date(2026, 1, 10, 17, 0), totalMinutes: 480, totalPay: 80, jobId: 'job-b' }),
        shift({ clockIn: new Date(2026, 1, 10, 9, 0), clockOut: new Date(2026, 1, 10, 12, 0), totalMinutes: 180, totalPay: 30, jobId: null }),
      ],
      { 'job-a': 'Kuhinja', 'job-b': 'Sank' },
    )
    expect(rows.map((r) => r.roleName)).toEqual(['Kuhinja', 'Sank', '—'])
    expect(rows[0].minutes).toBe(720)
    expect(rows[0].cost).toBe(136)
    expect(rows[1]).toEqual({ roleName: 'Sank', minutes: 480, cost: 80 })
    expect(rows[2]).toEqual({ roleName: '—', minutes: 180, cost: 30 })
  })
})

describe('OPS-10 stationTarget', () => {
  it('fallbacks mirror the live board timers: BAR 5, KITCHEN 10 (no override map)', () => {
    expect(stationTarget('bar')).toBe(5)
    expect(stationTarget('BAR')).toBe(5)
    expect(stationTarget('kitchen')).toBe(10)
    expect(stationTarget('grill')).toBe(10)
    expect(stationTarget('')).toBe(10)
  })

  it('PrepStation override map wins; non-finite falls back; min 1 and rounding applied', () => {
    expect(stationTarget('bar', { BAR: 4 })).toBe(4)
    expect(stationTarget('kitchen', { KITCHEN: 8 })).toBe(8)
    expect(stationTarget('kitchen', { KITCHEN: 0 })).toBe(1) // min 1
    expect(stationTarget('bar', { BAR: -3 })).toBe(1)
    expect(stationTarget('bar', { BAR: 7.6 })).toBe(8) // rounded to whole minutes
    expect(stationTarget('bar', { BAR: Number.NaN })).toBe(5) // garbage override → fallback
    expect(stationTarget('kitchen', { BAR: 3 })).toBe(10) // other bucket's override ignored
  })
})

describe('OPS-10 classifyPrep', () => {
  it('exact boundaries: <= target ok, <= target*1.25 warn, above late', () => {
    expect(classifyPrep(5, 5)).toBe('ok')
    expect(classifyPrep(4.99, 5)).toBe('ok')
    expect(classifyPrep(5.01, 5)).toBe('warn')
    expect(classifyPrep(6.25, 5)).toBe('warn') // exactly 125 %
    expect(classifyPrep(6.26, 5)).toBe('late')
    expect(classifyPrep(10, 10)).toBe('ok')
    expect(classifyPrep(12.5, 10)).toBe('warn')
    expect(classifyPrep(12.51, 10)).toBe('late')
  })

  it('degenerate target (0/negative/NaN) does not classify everything ok', () => {
    expect(classifyPrep(0, 0)).toBe('ok')
    expect(classifyPrep(1, 0)).toBe('late')
    expect(classifyPrep(1, -2)).toBe('late')
    expect(classifyPrep(3, Number.NaN)).toBe('late')
  })
})

describe('OPS-10 kdsStationBreakdown', () => {
  it('groups by station, uses each station target for the 3-color split, always returns both rows', () => {
    const rows = kdsStationBreakdown(
      [
        kds({ station: 'BAR', prepMin: 4 }),
        kds({ station: 'BAR', prepMin: 6 }),
        kds({ station: 'BAR', prepMin: 7 }),
        kds({ station: 'KITCHEN', prepMin: 8 }),
        kds({ station: 'KITCHEN', prepMin: 20 }),
      ],
      { BAR: 5, KITCHEN: 10 },
    )
    expect(rows.map((r) => r.station)).toEqual(['BAR', 'KITCHEN'])
    const bar = rows[0]
    expect(bar.count).toBe(3)
    expect(bar.avg).toBeCloseTo(5.7, 1) // (4+6+7)/3
    expect(bar.min).toBe(4)
    expect(bar.max).toBe(7)
    expect(bar.target).toBe(5)
    expect(bar.okPct).toBeCloseTo(33.3, 1) // 4 <= 5
    expect(bar.warnPct).toBeCloseTo(33.3, 1) // 6 in (5, 6.25]
    expect(bar.latePct).toBeCloseTo(33.3, 1) // 7 > 6.25
    const kitchen = rows[1]
    expect(kitchen.count).toBe(2)
    expect(kitchen.avg).toBe(14)
    expect(kitchen.target).toBe(10)
    expect(kitchen.okPct).toBe(50) // 8 <= 10
    expect(kitchen.warnPct).toBe(0)
    expect(kitchen.latePct).toBe(50) // 20 > 12.5
  })

  it('empty samples → zeroed rows with targets intact; legacy 5/10 kdsTimeSplit untouched', () => {
    const rows = kdsStationBreakdown([], { BAR: 3, KITCHEN: 12 })
    expect(rows).toEqual([
      { station: 'BAR', count: 0, avg: 0, min: 0, max: 0, okPct: 0, warnPct: 0, latePct: 0, target: 3 },
      { station: 'KITCHEN', count: 0, avg: 0, min: 0, max: 0, okPct: 0, warnPct: 0, latePct: 0, target: 12 },
    ])
    // fallback targets when the override map is empty
    expect(kdsStationBreakdown([], {}).map((r) => r.target)).toEqual([5, 10])
    // backward compatibility: old 5/10 split behaves as before
    const split = kdsTimeSplit([kds({ prepMin: 4 }), kds({ prepMin: 7 }), kds({ prepMin: 11 })])
    expect(split.okPct).toBeCloseTo(33.3, 1)
    expect(split.warnPct).toBeCloseTo(33.3, 1)
    expect(split.latePct).toBeCloseTo(33.3, 1)
    expect(split.onTimePct).toBeCloseTo(66.7, 1)
  })
})

describe('OPS-10 dayKeyOf', () => {
  it('local calendar key YYYY-MM-DD with zero padding', () => {
    expect(dayKeyOf(new Date(2026, 1, 5, 23, 59))).toBe('2026-02-05')
    expect(dayKeyOf(new Date(2026, 10, 13, 0, 0))).toBe('2026-11-13')
  })
})
