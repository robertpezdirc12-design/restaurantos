import { describe, expect, test } from 'bun:test'
import {
  TIMECLOCK_STATUSES,
  TIMECLOCK_STATUS_LABELS,
  TIMECLOCK_TYPES,
  TIMECLOCK_TYPE_LABELS,
  breakDeltaMinutes,
  canTransitionStatus,
  durationLabel,
  grossMinutes,
  liveMinutes,
  payLabel,
  payRateToCents,
  timeclockStats,
  totalMinutesCalc,
  totalPayCents,
  transitionStatusError,
  validateManualEntry,
  type TimeclockStatus,
} from '@/lib/timeclock'

describe('timeclock — konstante', () => {
  test('zaprti seznami tipov in statusov z oznakami', () => {
    expect(TIMECLOCK_TYPES).toEqual(['regular', 'overtime', 'holiday', 'sick', 'vacation'])
    expect(TIMECLOCK_STATUSES).toEqual(['active', 'approved', 'disputed'])
    for (const t of TIMECLOCK_TYPES) expect(TIMECLOCK_TYPE_LABELS[t].length).toBeGreaterThan(0)
    for (const s of TIMECLOCK_STATUSES) expect(TIMECLOCK_STATUS_LABELS[s].length).toBeGreaterThan(0)
  })
})

describe('timeclock — prehodi statusov (recenzija)', () => {
  test('dovoljeni prehodi', () => {
    expect(canTransitionStatus('active', 'approved')).toBe(true)
    expect(canTransitionStatus('active', 'disputed')).toBe(true)
    expect(canTransitionStatus('disputed', 'approved')).toBe(true)
    expect(canTransitionStatus('approved', 'disputed')).toBe(true)
  })
  test('nedovoljeni prehodi', () => {
    expect(canTransitionStatus('active', 'active')).toBe(false)
    expect(canTransitionStatus('disputed', 'disputed')).toBe(false)
    expect(canTransitionStatus('approved', 'approved')).toBe(false)
    for (const from of TIMECLOCK_STATUSES as readonly TimeclockStatus[]) {
      expect(canTransitionStatus(from, 'active')).toBe(false) // active nikoli (dobimo ob clock-in)
    }
  })
  test('sporočila napak v slovenščini', () => {
    expect(transitionStatusError('approved', 'approved')).toContain('že v stanju')
    expect(transitionStatusError('active', 'active')).toContain('že v stanju')
    expect(transitionStatusError('disputed', 'active')).toContain('Nedovoljen prehod')
  })
})

describe('timeclock — centna aritmetika (brez float drifta)', () => {
  test('payRateToCents', () => {
    expect(payRateToCents(8.5)).toBe(850)
    expect(payRateToCents(0)).toBe(0)
    expect(payRateToCents(10.005)).toBe(1001) // zaokroži
  })
  test('totalPayCents — 450 min × 8,50 €/h = 63,75 €', () => {
    expect(totalPayCents(450, 850)).toBe(6375)
  })
  test('totalPayCents — klasičen drift primer', () => {
    // 510 min (8,5 h) × 9,19 €/h = 78,115 € → 7812 ct (ne 7811.999…)
    expect(totalPayCents(510, 919)).toBe(7812)
  })
  test('totalPayCents — ničelni rob', () => {
    expect(totalPayCents(0, 850)).toBe(0)
    expect(totalPayCents(450, 0)).toBe(0)
    expect(totalPayCents(-10, 850)).toBe(0)
  })
  test('payLabel — slovenska oblika', () => {
    expect(payLabel(6375)).toBe('63,75 €')
    expect(payLabel(0)).toBe('0,00 €')
  })
})

describe('timeclock — minute (konvencija tips.ts)', () => {
  const IN = Date.UTC(2026, 9, 8, 7, 0) // 07:00 UTC
  test('grossMinutes — zaokroži na celo minuto', () => {
    expect(grossMinutes(IN, IN + 90 * 60000)).toBe(90)
    expect(grossMinutes(IN, IN + 90 * 60000 + 29999)).toBe(90) // 29,999 s → 90 min
    expect(grossMinutes(IN, IN + 90 * 60000 + 30000)).toBe(91) // 30 s → 91 min
  })
  test('grossMinutes — obratni/nedoločen vrne 0', () => {
    expect(grossMinutes(IN, IN - 1)).toBe(0)
    expect(grossMinutes(IN, IN)).toBe(0)
  })
  test('totalMinutesCalc — odmor se odšteje, negativno ne sme', () => {
    expect(totalMinutesCalc(IN, IN + 480 * 60000, 30)).toBe(450)
    expect(totalMinutesCalc(IN, IN + 480 * 60000, 480)).toBe(0)
    expect(totalMinutesCalc(IN, IN + 480 * 60000, 500)).toBe(0)
    expect(totalMinutesCalc(IN, IN + 480 * 60000, -30)).toBe(480) // negativen odmor ignoriran
  })
  test('liveMinutes — živo štetje', () => {
    expect(liveMinutes(IN, IN + 60 * 60000, 0)).toBe(60)
    expect(liveMinutes(IN, IN + 60 * 60000, 15)).toBe(45)
  })
  test('breakDeltaMinutes — floor na minuto', () => {
    const BS = Date.UTC(2026, 9, 8, 11, 0)
    expect(breakDeltaMinutes(BS, BS + 30 * 60000)).toBe(30)
    expect(breakDeltaMinutes(BS, BS + 30 * 60000 + 59999)).toBe(30) // floor
    expect(breakDeltaMinutes(BS, BS - 1)).toBe(0)
  })
})

describe('timeclock — validateManualEntry (popravek managerja)', () => {
  const NOW = Date.UTC(2026, 9, 8, 18, 0)
  const day = (h: number, m = 0) => Date.UTC(2026, 9, 8, h, m)
  test('veljaven ročni vnos', () => {
    const r = validateManualEntry({ clockInMs: day(7), clockOutMs: day(15), breakMinutes: 30, type: 'regular', note: ' pozabil na uro ' }, NOW)
    expect(r.ok).toBe(true)
    expect(r.value?.breakMinutes).toBe(30)
    expect(r.value?.note).toBe('pozabil na uro') // trim
    expect(r.value?.type).toBe('regular')
  })
  test('odjava pred prijavo / enaka', () => {
    expect(validateManualEntry({ clockInMs: day(15), clockOutMs: day(7), breakMinutes: 0, type: 'regular' }, NOW).error).toContain('odjave mora biti za')
    expect(validateManualEntry({ clockInMs: day(8), clockOutMs: day(8), breakMinutes: 0, type: 'regular' }, NOW).ok).toBe(false)
  })
  test('prijava v prihodnosti', () => {
    const r = validateManualEntry({ clockInMs: NOW + 10 * 60000, clockOutMs: NOW + 60 * 60000, breakMinutes: 0, type: 'regular' }, NOW)
    expect(r.error).toContain('prihodnosti')
  })
  test('majhen časovni odmik (5 min) je toleriran', () => {
    const r = validateManualEntry({ clockInMs: NOW + 4 * 60000, clockOutMs: NOW + 64 * 60000, breakMinutes: 0, type: 'regular' }, NOW)
    expect(r.ok).toBe(true)
  })
  test('prestara prijava (> 31 dni)', () => {
    const r = validateManualEntry({ clockInMs: NOW - 32 * 24 * 60 * 60 * 1000, clockOutMs: NOW - 31 * 24 * 60 * 60 * 1000, breakMinutes: 0, type: 'regular' }, NOW)
    expect(r.error).toContain('31 dni')
  })
  test('odmor daljši od izmene', () => {
    const r = validateManualEntry({ clockInMs: day(7), clockOutMs: day(9), breakMinutes: 130, type: 'regular' }, NOW)
    expect(r.error).toContain('ne sme biti daljši')
  })
  test('neznan tip', () => {
    expect(validateManualEntry({ clockInMs: day(7), clockOutMs: day(9), breakMinutes: 0, type: 'domov' }, NOW).error).toContain('Neznan tip')
  })
  test('negativen/lomljen odmor se normalizira na 0, opomba obrežena na 500', () => {
    const r = validateManualEntry({ clockInMs: day(7), clockOutMs: day(9), breakMinutes: -5, type: 'overtime', note: 'x'.repeat(600) }, NOW)
    expect(r.ok).toBe(true)
    expect(r.value?.breakMinutes).toBe(0)
    expect(r.value?.note.length).toBe(500)
  })
})

describe('timeclock — statistika', () => {
  const base = {
    breakMinutes: 0,
    type: 'regular',
    status: 'approved',
  }
  test('skupaj po zaključenih vnosih; aktivni se ne štejejo v skupaj', () => {
    const s = timeclockStats([
      { ...base, clockIn: new Date(Date.UTC(2026, 9, 7, 7, 0)), clockOut: new Date(Date.UTC(2026, 9, 7, 15, 0)), status: 'approved' },
      { ...base, clockIn: new Date(Date.UTC(2026, 9, 8, 7, 0)), clockOut: null, status: 'active', type: 'overtime' },
      { ...base, clockIn: new Date(Date.UTC(2026, 9, 6, 7, 0)), clockOut: new Date(Date.UTC(2026, 9, 6, 11, 0)), status: 'disputed' },
    ])
    expect(s.entryCount).toBe(3)
    expect(s.activeCount).toBe(1)
    expect(s.disputedCount).toBe(1)
    expect(s.totalMinutes).toBe(480 + 240) // vsi zaključeni (aktiven se ne šteje)
    expect(s.approvedMinutes).toBe(480)
    expect(s.totalHours).toBe(12)
    expect(s.byType['regular']).toBe(720)
    expect(s.topType).toBe('regular')
  })
  test('prazna množica', () => {
    const s = timeclockStats([])
    expect(s.totalMinutes).toBe(0)
    expect(s.topType).toBeNull()
  })
})

describe('timeclock — durationLabel', () => {
  test('min/ure', () => {
    expect(durationLabel(45)).toBe('45 min')
    expect(durationLabel(60)).toBe('1 h')
    expect(durationLabel(450)).toBe('7 h 30 min')
    expect(durationLabel(0)).toBe('0 min')
    expect(durationLabel(-5)).toBe('0 min')
  })
})
