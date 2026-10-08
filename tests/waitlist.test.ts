import { describe, expect, test } from 'bun:test'
import {
  WAITLIST_ACTIVE_STATUSES,
  WAITLIST_STATUSES,
  actualWaitMinutes,
  canTransition,
  durationLabel,
  isOverQuoted,
  isTerminalWaitlistStatus,
  minutesWaiting,
  partySizeLabel,
  quoteLabel,
  transitionError,
  validateEntryInput,
  waitlistStats,
} from '@/lib/waitlist'

describe('waitlist — stanja in prehodi', () => {
  test('zaprt seznam stanj', () => {
    expect(WAITLIST_STATUSES).toEqual(['waiting', 'notified', 'seated', 'left'])
    expect(WAITLIST_ACTIVE_STATUSES).toEqual(['waiting', 'notified'])
  })
  test('terminalni statusi brez prehodov naprej', () => {
    expect(isTerminalWaitlistStatus('seated')).toBe(true)
    expect(isTerminalWaitlistStatus('left')).toBe(true)
    expect(isTerminalWaitlistStatus('waiting')).toBe(false)
    expect(canTransition('seated', 'left')).toBe(false)
    expect(canTransition('left', 'waiting')).toBe(false)
    expect(canTransition('waiting', 'waiting')).toBe(false) // self-prehod ni prehod
  })
  test('zakoniti prehodi', () => {
    expect(canTransition('waiting', 'notified')).toBe(true)
    expect(canTransition('waiting', 'seated')).toBe(true) // direktna usaditev
    expect(canTransition('waiting', 'left')).toBe(true)
    expect(canTransition('notified', 'seated')).toBe(true)
    expect(canTransition('notified', 'left')).toBe(true)
    expect(canTransition('notified', 'notified')).toBe(false)
    expect(canTransition('waiting', 'waiting')).toBe(false)
  })
  test('transitionError: slovenščina + neznana stanja', () => {
    expect(transitionError('waiting', 'notified')).toBeNull()
    expect(transitionError('waiting', 'seated')).toBeNull()
    expect(transitionError('seated', 'left')).toContain('zaključen')
    expect(transitionError('notified', 'waiting')).toContain('ni dovoljen')
    expect(transitionError('waiting', 'nepostojec')).toContain('Neznan status')
    expect(transitionError('xyz', 'left')).toContain('Neznano trenutno stanje')
    expect(transitionError('left', 'left')).toContain('že v stanju')
  })
})

describe('waitlist — validateEntryInput', () => {
  test('veljaven vnos → normalizirano', () => {
    const v = validateEntryInput({ guestName: '  Družina Novak  ', partySize: 4, quotedWaitMinutes: '15', guestPhone: ' 041 234 567 ', preferredArea: 'terasa', specialNeeds: 'otroški stol', notes: '  proslava  ' })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.value.guestName).toBe('Družina Novak')
      expect(v.value.partySize).toBe(4)
      expect(v.value.quotedWaitMinutes).toBe(15)
      expect(v.value.guestPhone).toBe('041 234 567')
      expect(v.value.notes).toBe('proslava')
    }
  })
  test('ime obvezno', () => {
    const v = validateEntryInput({ partySize: 2 })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('Ime gosta')
  })
  test('število oseb: celo, ≥ 1, ≤ 30', () => {
    expect(validateEntryInput({ guestName: 'X', partySize: 0 }).ok).toBe(false)
    expect(validateEntryInput({ guestName: 'X', partySize: -2 }).ok).toBe(false)
    expect(validateEntryInput({ guestName: 'X', partySize: 2.5 }).ok).toBe(false)
    const fromStr = validateEntryInput({ guestName: 'X', partySize: '3' })
    expect(fromStr.ok).toBe(true) // lenientna konverzija (dosledno z ostalimi rutami)
    if (fromStr.ok) expect(fromStr.value.partySize).toBe(3)
    expect(validateEntryInput({ guestName: 'X', partySize: 'abc' }).ok).toBe(false)
    expect(validateEntryInput({ guestName: 'X', partySize: 31 }).ok).toBe(false)
    const v = validateEntryInput({ guestName: 'X', partySize: 30 })
    expect(v.ok).toBe(true)
  })
  test('napovedani čas: ne-negativen, ≤ 600, prazno → 0', () => {
    const a = validateEntryInput({ guestName: 'X', partySize: 2, quotedWaitMinutes: '' })
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.value.quotedWaitMinutes).toBe(0)
    const b = validateEntryInput({ guestName: 'X', partySize: 2, quotedWaitMinutes: -5 })
    expect(b.ok).toBe(false)
    const c = validateEntryInput({ guestName: 'X', partySize: 2, quotedWaitMinutes: 601 })
    expect(c.ok).toBe(false)
    const d = validateEntryInput({ guestName: 'X', partySize: 2, quotedWaitMinutes: 15.7 })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.value.quotedWaitMinutes).toBe(16) // zaokroženo
  })
  test('dolžina polj obrezana', () => {
    const v = validateEntryInput({ guestName: 'x'.repeat(200), partySize: 2, notes: 'y'.repeat(500) })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.value.guestName.length).toBe(120)
      expect(v.value.notes.length).toBe(300)
    }
  })
  test('null/undefined vnos', () => {
    expect(validateEntryInput(null).ok).toBe(false)
    expect(validateEntryInput(undefined).ok).toBe(false)
  })
})

describe('waitlist — čakanje', () => {
  test('actualWaitMinutes: minute med prijavo in usaditvijo', () => {
    const a = actualWaitMinutes('2026-01-15T18:00:00Z', '2026-01-15T18:23:59Z')
    expect(a).toBe(23) // floor
    expect(actualWaitMinutes('2026-01-15T18:00:00Z', '2026-01-15T18:00:00Z')).toBe(0)
    expect(actualWaitMinutes('2026-01-15T19:00:00Z', '2026-01-15T18:00:00Z')).toBe(0) // negativno → 0
  })
  test('minutesWaiting (živi prikaz)', () => {
    const now = new Date('2026-01-15T18:30:00Z')
    expect(minutesWaiting('2026-01-15T18:12:00Z', now)).toBe(18)
    expect(minutesWaiting(now, now)).toBe(0)
  })
  test('isOverQuoted', () => {
    expect(isOverQuoted(20, 15)).toBe(true)
    expect(isOverQuoted(15, 15)).toBe(false) // točno na meji ni prekoračitev
    expect(isOverQuoted(20, 0)).toBe(false) // brez napovedi ni merila
  })
  test('oznake', () => {
    expect(quoteLabel(15)).toBe('≈ 15 min')
    expect(quoteLabel(0)).toBe('—')
    expect(durationLabel(65)).toBe('1 h 5 min')
    expect(durationLabel(59)).toBe('59 min')
  })
})

describe('waitlist — partySizeLabel (slovenska n-tev)', () => {
  test('1 oseba, 2 osebi, 3/4 osebe, 5+ oseb', () => {
    expect(partySizeLabel(1)).toBe('1 oseba')
    expect(partySizeLabel(2)).toBe('2 osebi')
    expect(partySizeLabel(3)).toBe('3 osebe')
    expect(partySizeLabel(4)).toBe('4 osebe')
    expect(partySizeLabel(5)).toBe('5 oseb')
    expect(partySizeLabel(8)).toBe('8 oseb')
    expect(partySizeLabel(30)).toBe('30 oseb')
  })
})

describe('waitlist — waitlistStats', () => {
  test('prazen seznam → ničelna statistika', () => {
    const s = waitlistStats([])
    expect(s).toEqual({ waiting: 0, notified: 0, seated: 0, left: 0, waitingParty: 0, avgActualWait: 0, maxActualWait: 0 })
  })
  test('agregacija', () => {
    const s = waitlistStats([
      { status: 'waiting', partySize: 2, actualWaitMinutes: 0 },
      { status: 'waiting', partySize: 3, actualWaitMinutes: 0 },
      { status: 'notified', partySize: 4, actualWaitMinutes: 0 },
      { status: 'seated', partySize: 2, actualWaitMinutes: 12 },
      { status: 'seated', partySize: 6, actualWaitMinutes: 30 },
      { status: 'left', partySize: 1, actualWaitMinutes: 0 },
    ])
    expect(s.waiting).toBe(2)
    expect(s.waitingParty).toBe(5)
    expect(s.notified).toBe(1)
    expect(s.seated).toBe(2)
    expect(s.left).toBe(1)
    expect(s.avgActualWait).toBe(21) // (12+30)/2 = 21
    expect(s.maxActualWait).toBe(30)
  })
  test('samo usajeni brez čakanja', () => {
    const s = waitlistStats([{ status: 'seated', partySize: 2, actualWaitMinutes: 0 }])
    expect(s.seated).toBe(1)
    expect(s.avgActualWait).toBe(0)
    expect(s.maxActualWait).toBe(0)
  })
  test('neznani status se prezre', () => {
    const s = waitlistStats([{ status: 'weird', partySize: 9, actualWaitMinutes: 99 }])
    expect(s.waiting).toBe(0)
    expect(s.seated).toBe(0)
  })
})
