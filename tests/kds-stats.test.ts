import { describe, it, expect } from 'bun:test'
import {
  prepMinutes,
  stationOf,
  kdsItemStats,
  kdsHeatmap,
  kdsTimeSplit,
  kdsDayKpi,
  type KdsSample,
} from '@/lib/kds-stats'

/* OPS-8 (v1.71.0) — KDS prep-time statistics math, pure functions, no DB.
   Guarantees: 5/10 min escalation split (ok/warn/late, onTime = <= 10 min),
   48 half-hour heatmap buckets (hour 0-23, half 0|1), per-item avg/min/max,
   negative prep diffs (clock skew) are excluded. */

const sample = (over: Partial<KdsSample>): KdsSample => ({
  name: 'Burger',
  prepMin: 5,
  firedAt: new Date(2026, 1, 10, 12, 0, 0),
  station: 'KITCHEN',
  ...over,
})

describe('kds stats — prepMinutes', () => {
  it('computes minutes from firedAt -> readyAt', () => {
    expect(prepMinutes(new Date(0), new Date(4 * 60000))).toBeCloseTo(4, 10)
    expect(prepMinutes(new Date(0), new Date(90 * 60000))).toBeCloseTo(90, 10)
  })

  it('excludes negative diffs (clock skew / data error)', () => {
    expect(prepMinutes(new Date(60000), new Date(0))).toBeNull()
  })
})

describe('kds stats — station bucket', () => {
  it('bar station type -> BAR, everything else (incl. null) -> KITCHEN', () => {
    expect(stationOf('bar')).toBe('BAR')
    expect(stationOf('BAR')).toBe('BAR')
    expect(stationOf('kitchen')).toBe('KITCHEN')
    expect(stationOf('grill')).toBe('KITCHEN')
    expect(stationOf(null)).toBe('KITCHEN')
  })
})

describe('kds stats — per-item aggregation', () => {
  it('count, avg/min/max and late share per menu item', () => {
    const samples: KdsSample[] = [
      sample({ name: 'Burger', prepMin: 4 }),
      sample({ name: 'Burger', prepMin: 6 }),
      sample({ name: 'Burger', prepMin: 12 }),
      sample({ name: 'Espresso', prepMin: 2 }),
    ]
    const stats = kdsItemStats(samples)
    const burger = stats.find((s) => s.name === 'Burger')!
    expect(burger.count).toBe(3)
    expect(burger.avg).toBeCloseTo(7.3, 1) // (4+6+12)/3
    expect(burger.min).toBe(4)
    expect(burger.max).toBe(12)
    expect(burger.latePct).toBeCloseTo(33.3, 1) // 1 of 3 > 10 min
    // sorted by count desc
    expect(stats[0].name).toBe('Burger')
  })

  it('late boundary: exactly 10 min is NOT late, 10.01 is', () => {
    const stats = kdsItemStats([sample({ prepMin: 10 }), sample({ prepMin: 10.01 })])
    // single aggregated row per name 'Burger': 1 late of 2
    expect(stats[0].count).toBe(2)
    expect(stats[0].latePct).toBeCloseTo(50, 1)
  })
})

describe('kds stats — 30-minute heatmap', () => {
  it('returns exactly 48 buckets (hour 0-23, half 0|1) and assigns samples to the right bucket', () => {
    const heat = kdsHeatmap([
      sample({ firedAt: new Date(2026, 1, 10, 12, 5, 0), prepMin: 4 }),
      sample({ firedAt: new Date(2026, 1, 10, 12, 29, 59), prepMin: 6 }),
      sample({ firedAt: new Date(2026, 1, 10, 12, 30, 0), prepMin: 8 }),
      sample({ firedAt: new Date(2026, 1, 10, 23, 45, 0), prepMin: 2 }),
    ])
    expect(heat).toHaveLength(48)
    const b1200 = heat.find((c) => c.hour === 12 && c.half === 0)!
    expect(b1200.count).toBe(2)
    expect(b1200.avg).toBe(5) // (4+6)/2
    const b1230 = heat.find((c) => c.hour === 12 && c.half === 1)!
    expect(b1230.count).toBe(1)
    expect(b1230.avg).toBe(8)
    const b2330 = heat.find((c) => c.hour === 23 && c.half === 1)!
    expect(b2330.count).toBe(1)
    // empty buckets stay present with count 0
    expect(heat.find((c) => c.hour === 0 && c.half === 0)!.count).toBe(0)
  })
})

describe('kds stats — 5/10 min escalation split', () => {
  it('ok <= 5, warn 5-10, late > 10; onTime = ok + warn', () => {
    const split = kdsTimeSplit([
      sample({ prepMin: 5 }), // ok
      sample({ prepMin: 7 }), // warn
      sample({ prepMin: 10 }), // warn (<= 10)
      sample({ prepMin: 10.5 }), // late
    ])
    expect(split.okPct).toBe(25)
    expect(split.warnPct).toBe(50)
    expect(split.latePct).toBe(25)
    expect(split.onTimePct).toBe(75)
  })

  it('empty sample set returns zeros (no NaN)', () => {
    expect(kdsTimeSplit([])).toEqual({ okPct: 0, warnPct: 0, latePct: 0, onTimePct: 0 })
  })
})

describe('kds stats — today KPI', () => {
  it('aggregates only samples fired on the same local calendar day as ref', () => {
    const ref = new Date(2026, 1, 10, 18, 0, 0)
    const kpi = kdsDayKpi([
      sample({ firedAt: new Date(2026, 1, 10, 12, 0, 0), prepMin: 4 }),
      sample({ firedAt: new Date(2026, 1, 10, 15, 30, 0), prepMin: 6 }),
      sample({ firedAt: new Date(2026, 1, 9, 23, 0, 0), prepMin: 20 }), // yesterday
      sample({ firedAt: new Date(2026, 1, 11, 0, 1, 0), prepMin: 8 }), // tomorrow
    ], ref)
    expect(kpi.count).toBe(2)
    expect(kpi.avg).toBe(5)
  })

  it('no samples today -> zero KPI', () => {
    expect(kdsDayKpi([], new Date(2026, 1, 10))).toEqual({ avg: 0, count: 0 })
  })
})
