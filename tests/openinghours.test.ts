import { describe, expect, test } from 'bun:test'
import {
  parseHHMM, fmtHHMM, toLocalDateKey, isValidDateKey, localParts,
  validateOpeningHoursRows, validateSpecialDayInput, isOpenAtMinute,
  currentStatus, nextChange, outsideHoursFor, slovenianHolidays, upcomingSpecialDays,
  type ValidatedRow,
} from '../src/lib/openinghours'

/** Pomožnik: zgradi veljavne vrstice iz surovega vnosa. */
function build(rows: Partial<Parameters<typeof validateOpeningHoursRows>[0][number]>[]): ValidatedRow[] {
  const full = Array.from({ length: 7 }, (_, dow) => ({
    dayOfWeek: dow, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false, ...rows.find((r) => r.dayOfWeek === dow),
  }))
  const v = validateOpeningHoursRows(full)
  if (!v.ok) throw new Error(v.error)
  return v.rows
}

const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm)

describe('parseHHMM / fmtHHMM', () => {
  test('razčleni veljavne čase (tudi enomestna ura, presledki)', () => {
    expect(parseHHMM('08:30')).toBe(510)
    expect(parseHHMM(' 9:05 ')).toBe(545)
    expect(parseHHMM('00:00')).toBe(0)
    expect(parseHHMM('23:59')).toBe(1439)
  })
  test('zavrne neveljavne oblike', () => {
    expect(parseHHMM('24:00')).toBeNull()
    expect(parseHHMM('8:60')).toBeNull()
    expect(parseHHMM('ab:cd')).toBeNull()
    expect(parseHHMM('')).toBeNull()
    expect(parseHHMM('8')).toBeNull()
  })
  test('fmtHHMM normira in wrapa', () => {
    expect(fmtHHMM(545)).toBe('09:05')
    expect(fmtHHMM(0)).toBe('00:00')
    expect(fmtHHMM(1500)).toBe('01:00')
  })
  test('rok uporabe: parse → fmt okrogel sprehod', () => {
    for (const t of ['00:00', '08:30', '23:59']) expect(fmtHHMM(parseHHMM(t)!)).toBe(t)
  })
})

describe('lokalni datumi', () => {
  test('toLocalDateKey uporablja lokalne komponente (ne UTC)', () => {
    expect(toLocalDateKey(at(2026, 3, 5, 23, 59))).toBe('2026-03-05')
  })
  test('isValidDateKey zavrne neveljavne', () => {
    expect(isValidDateKey('2026-02-30')).toBe(false)
    expect(isValidDateKey('2026-13-01')).toBe(false)
    expect(isValidDateKey('2026-1-1')).toBe(false)
    expect(isValidDateKey('2026-12-25')).toBe(true)
  })
  test('localParts: dan v tednu po JS konvenciji (0=nedelja)', () => {
    // 2026-03-08 je nedelja
    expect(localParts(at(2026, 3, 8, 14, 30)).dayOfWeek).toBe(0)
    expect(localParts(at(2026, 3, 8, 14, 30)).minutes).toBe(14 * 60 + 30)
    // 2026-03-09 je ponedeljek
    expect(localParts(at(2026, 3, 9)).dayOfWeek).toBe(1)
  })
})

describe('validateOpeningHoursRows', () => {
  test('veljavne vrstice normalizira in razčleni', () => {
    const v = validateOpeningHoursRows(Array.from({ length: 7 }, (_, dow) => ({ dayOfWeek: dow, openTime: '8:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false })))
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.rows[1].openMin).toBe(480)
      expect(v.rows[1].openTime).toBe('08:00')
    }
  })
  test('zavrne != 7 vrstic', () => {
    expect(validateOpeningHoursRows([]).ok).toBe(false)
    expect(validateOpeningHoursRows(Array.from({ length: 6 }, (_, dow) => ({ dayOfWeek: dow, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false }))).ok).toBe(false)
  })
  test('zavrne podvojen dan in neveljaven dan', () => {
    const base = (dow: number) => ({ dayOfWeek: dow, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false })
    expect(validateOpeningHoursRows([base(1), base(1), base(0), base(2), base(3), base(4), base(5)]).ok).toBe(false)
    expect(validateOpeningHoursRows([base(0), base(1), base(2), base(3), base(4), base(5), { ...base(9), openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false }]).ok).toBe(false)
  })
  test('zaprvi dan: časi se ignorirajo', () => {
    const v = build([{ dayOfWeek: 0, isClosed: true, openTime: 'zzz', closeTime: 'zzz', breakStart: 'x', breakEnd: 'y' }])
    expect(v[0].isClosed).toBe(true)
    expect(v[0].openTime).toBe('')
  })
  test('odpiralni = zapiralni → 400; neveljaven čas → 400', () => {
    const mk = (o: string, c: string) => Array.from({ length: 7 }, (_, dow) => ({ dayOfWeek: dow, openTime: o, closeTime: c, breakStart: '', breakEnd: '', isClosed: false }))
    expect(validateOpeningHoursRows(mk('10:00', '10:00')).ok).toBe(false)
    expect(validateOpeningHoursRows(mk('10:65', '22:00')).ok).toBe(false)
  })
  test('overnight okno je dovoljeno (20:00 → 02:00)', () => {
    const v = build([{ dayOfWeek: 5, openTime: '20:00', closeTime: '02:00' }])
    expect(v[5].closeMin).toBe(2 * 60 + 1440)
  })
  test('odmor: oba časa obvezna, začetek < konec, znotraj okna', () => {
    const mk = (bs: string, be: string) => Array.from({ length: 7 }, (_, dow) => ({ dayOfWeek: dow, openTime: '08:00', closeTime: '22:00', breakStart: bs, breakEnd: be, isClosed: false }))
    expect(validateOpeningHoursRows(mk('14:00', '')).ok).toBe(false)
    expect(validateOpeningHoursRows(mk('15:00', '14:00')).ok).toBe(false)
    expect(validateOpeningHoursRows(mk('06:00', '09:00')).ok).toBe(false)
    expect(validateOpeningHoursRows(mk('05:00', '21:00')).ok).toBe(false)
    expect(validateOpeningHoursRows(mk('14:00', '16:00')).ok).toBe(true)
  })
  test('overnight rep: odmor 00:30–01:00 v oknu 20:00→02:00 je veljaven', () => {
    const v = build([{ dayOfWeek: 6, openTime: '20:00', closeTime: '02:00', breakStart: '00:30', breakEnd: '01:00' }])
    expect(v[6].breakStartMin).toBe(30)
    expect(v[6].breakEndMin).toBe(60)
    expect(isOpenAtMinute(v[6], 45).onBreak).toBe(true)
    expect(isOpenAtMinute(v[6], 100).onBreak).toBe(false)
  })
})

describe('isOpenAtMinute', () => {
  const normal = build([{ dayOfWeek: 1, breakStart: '14:00', breakEnd: '16:00' }])[1]
  test('znotraj okna, na odmoru, zunaj', () => {
    expect(isOpenAtMinute(normal, 10 * 60)).toEqual({ inside: true, onBreak: false })
    expect(isOpenAtMinute(normal, 15 * 60)).toEqual({ inside: true, onBreak: true })
    expect(isOpenAtMinute(normal, 23 * 60)).toEqual({ inside: false, onBreak: false })
  })
  test('overnight: 01:00 je znotraj 20:00→02:00', () => {
    const ov = build([{ dayOfWeek: 5, openTime: '20:00', closeTime: '02:00' }])[5]
    expect(isOpenAtMinute(ov, 1 * 60).inside).toBe(true)
    expect(isOpenAtMinute(ov, 19 * 60).inside).toBe(false)
    expect(isOpenAtMinute(ov, 3 * 60).inside).toBe(false)
  })
  test('mejni: open je znotraj, close NI (izključen)', () => {
    const r = build([])[1]
    expect(isOpenAtMinute(r, 8 * 60).inside).toBe(true)
    expect(isOpenAtMinute(r, 22 * 60).inside).toBe(false)
  })
  test('zaprvi dan nikoli odprt', () => {
    const closed = build([{ dayOfWeek: 2, isClosed: true }])[2]
    expect(isOpenAtMinute(closed, 12 * 60).inside).toBe(false)
  })
})

describe('currentStatus', () => {
  const rows = build([
    { dayOfWeek: 0, isClosed: true }, // nedelja zaprta
    { dayOfWeek: 1, breakStart: '14:00', breakEnd: '16:00' },
  ])
  test('odprto med tednom', () => {
    const s = currentStatus(rows, [], at(2026, 3, 10, 12, 0)) // torek
    expect(s.isOpen).toBe(true)
    expect(s.phase).toBe('open')
    expect(s.nextChangeLabel).toContain('Zapre se ob 22:00')
  })
  test('odmor: zaprto z razlago + nadaljevanje', () => {
    const s = currentStatus(rows, [], at(2026, 3, 9, 15, 0)) // pon, v odmoru
    expect(s.phase).toBe('break')
    expect(s.isOpen).toBe(false)
    expect(s.detail).toContain('14:00–16:00')
  })
  test('zaprta nedelja → naslednji prehod = jutri (ponedeljek) ob 08:00', () => {
    const s = currentStatus(rows, [], at(2026, 3, 8, 12, 0))
    expect(s.phase).toBe('closed_day')
    expect(s.nextChangeLabel).toBe('Odpre se jutri ob 08:00')
  })
  test('zaprta nedelja, sobotna noč → naslednje odprtje "v ponedeljek"', () => {
    const s = currentStatus(rows, [], at(2026, 3, 7, 23, 30)) // sobota
    expect(s.nextChangeLabel).toBe('Odpre se v ponedeljek ob 08:00')
  })
  test('poseben dan (zaprto) prevlada nad tednom', () => {
    const s = currentStatus(rows, [{ date: '2026-03-10', isClosed: true, openTime: '', closeTime: '', note: 'Praznik dela' }], at(2026, 3, 10, 12, 0))
    expect(s.phase).toBe('special_closed')
    expect(s.detail).toContain('Praznik dela')
  })
  test('poseben urnik prevlada nad tednom (odprt po posebnem)', () => {
    const s = currentStatus(rows, [{ date: '2026-03-10', isClosed: false, openTime: '10:00', closeTime: '18:00', note: 'Dogodek' }], at(2026, 3, 10, 12, 0))
    expect(s.isOpen).toBe(true)
    expect(s.phase).toBe('special_hours')
    expect(s.detail).toContain('10:00–18:00')
    expect(s.nextChangeLabel).toBe('Zapre se ob 18:00')
  })
  test('poseben urnik, zunaj okna → zaprto', () => {
    const s = currentStatus(rows, [{ date: '2026-03-10', isClosed: false, openTime: '10:00', closeTime: '18:00', note: '' }], at(2026, 3, 10, 20, 0))
    expect(s.isOpen).toBe(false)
    expect(s.phase).toBe('special_hours')
  })
  test('brez podatkov → zaprto (fail-closed)', () => {
    const s = currentStatus([], [], at(2026, 3, 10, 12, 0))
    expect(s.isOpen).toBe(false)
    expect(s.phase).toBe('closed_day')
  })
})

describe('nextChange', () => {
  test('danes: zaključek', () => {
    const rows = build([])
    const n = nextChange(rows, [], at(2026, 3, 10, 12, 0))
    expect(n?.label).toBe('Zapre se ob 22:00')
  })
  test('jutri: odprtje', () => {
    const rows = build([])
    const n = nextChange(rows, [], at(2026, 3, 10, 23, 30))
    expect(n?.label).toBe('Odpre se jutri ob 08:00')
  })
  test('overnight zaključek pade naslednji dan', () => {
    const rows = build([{ dayOfWeek: 5, openTime: '20:00', closeTime: '02:00' }])
    const n = nextChange(rows, [], at(2026, 3, 13, 23, 30)) // petek zvečer
    expect(n?.label).toBe('Zapre se jutri ob 02:00')
  })
  test('posebni dan prekine tedenski vrstni red', () => {
    const rows = build([])
    const n = nextChange(rows, [{ date: '2026-03-11', isClosed: true, openTime: '', closeTime: '', note: 'Zaprt' }], at(2026, 3, 10, 23, 30))
    expect(n?.label).toBe('Odpre se v četrtek ob 08:00')
  })
})

describe('outsideHoursFor (rezervacije)', () => {
  const rows = build([{ dayOfWeek: 0, isClosed: true }, { dayOfWeek: 1, breakStart: '14:00', breakEnd: '16:00' }])
  test('znotraj časa → brez opozorila', () => {
    expect(outsideHoursFor(rows, [], at(2026, 3, 9, 12, 0)).outside).toBe(false)
  })
  test('zaprta nedelja', () => {
    const r = outsideHoursFor(rows, [], at(2026, 3, 8, 12, 0))
    expect(r).toEqual({ outside: true, reason: 'closed_day', label: 'Nedelja je zaprto' })
  })
  test('izven ure', () => {
    const r = outsideHoursFor(rows, [], at(2026, 3, 9, 23, 0))
    expect(r.reason).toBe('outside_hours')
    expect(r.label).toContain('08:00–22:00')
  })
  test('odmor', () => {
    expect(outsideHoursFor(rows, [], at(2026, 3, 9, 15, 0)).reason).toBe('break')
  })
  test('poseben dan zaprt', () => {
    const r = outsideHoursFor(rows, [{ date: '2026-03-09', isClosed: true, openTime: '', closeTime: '', note: 'Popravilo' }], at(2026, 3, 9, 12, 0))
    expect(r.reason).toBe('special_closed')
    expect(r.label).toContain('Popravilo')
  })
})

describe('slovenski prazniki', () => {
  test('2026: 12 praznikov, pravilni datumi (Velika noč 5. 4. 2026)', () => {
    const h = slovenianHolidays(2026)
    expect(h.length).toBe(12)
    expect(h.find((x) => x.date === '2026-01-01')?.name).toBe('Novo leto')
    expect(h.find((x) => x.date === '2026-02-08')?.name).toContain('Prešernov')
    expect(h.find((x) => x.date === '2026-04-06')?.name).toBe('Velikonočni ponedeljek')
    expect(h.find((x) => x.date === '2026-05-24')?.name).toBe('Binkošti')
    expect(h.find((x) => x.date === '2026-12-26')?.name).toContain('samostojnosti')
  })
  test('2027: Velika noč 28. 3. 2027 → ponedeljek 29. 3.', () => {
    const h = slovenianHolidays(2027)
    expect(h.find((x) => x.date === '2027-03-29')?.name).toBe('Velikonočni ponedeljek')
    expect(h.find((x) => x.date === '2027-05-16')?.name).toBe('Binkošti')
  })
  test('razvrščeno po datumu', () => {
    const h = slovenianHolidays(2026)
    for (let i = 1; i < h.length; i++) expect(h[i - 1].date <= h[i].date).toBe(true)
  })
})

describe('upcomingSpecialDays', () => {
  test('filtrira pretekle in prihodnje okno', () => {
    const now = at(2026, 3, 10)
    const list = upcomingSpecialDays([
      { date: '2026-03-01', isClosed: true, openTime: '', closeTime: '', note: 'pretekli' },
      { date: '2026-03-15', isClosed: true, openTime: '', closeTime: '', note: 'prihodnji' },
      { date: '2026-05-05', isClosed: false, openTime: '10:00', closeTime: '15:00', note: '' },
      { date: '2026-12-01', isClosed: false, openTime: '10:00', closeTime: '15:00', note: '' },
    ], now, 60)
    expect(list.map((s) => s.date)).toEqual(['2026-03-15', '2026-05-05'])
  })
})

describe('validateSpecialDayInput', () => {
  test('zaprto ustvari prazne čase', () => {
    const v = validateSpecialDayInput({ date: '2026-03-10', isClosed: true, note: 'Praznik' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.day.openTime).toBe('')
  })
  test('odprt poseben dan potrebuje oba časa', () => {
    expect(validateSpecialDayInput({ date: '2026-03-10', isClosed: false, openTime: '10:00' }).ok).toBe(false)
    expect(validateSpecialDayInput({ date: '2026-03-10', isClosed: false, openTime: '10:00', closeTime: '10:00' }).ok).toBe(false)
    expect(validateSpecialDayInput({ date: '2026-03-10', isClosed: false, openTime: '10:00', closeTime: '18:00' }).ok).toBe(true)
  })
  test('neveljaven datum in opomba > 200', () => {
    expect(validateSpecialDayInput({ date: '2026-02-30', isClosed: true }).ok).toBe(false)
    expect(validateSpecialDayInput({ date: '2026-03-10', isClosed: true, note: 'x'.repeat(201) }).ok).toBe(false)
  })
})

describe('outsideHoursFor — poseben odprti urnik', () => {
  const rows = build([])
  test('zunaj posebnega urnika → special_hours_outside', () => {
    const r = outsideHoursFor(rows, [{ date: '2026-03-10', isClosed: false, openTime: '17:00', closeTime: '23:00', note: 'Dogodek' }], at(2026, 3, 10, 11, 0))
    expect(r).toEqual({ outside: true, reason: 'special_hours_outside', label: 'Poseben urnik: 17:00–23:00 — Dogodek' })
  })
  test('znotraj posebnega urnika → dovoljeno', () => {
    expect(outsideHoursFor(rows, [{ date: '2026-03-10', isClosed: false, openTime: '17:00', closeTime: '23:00', note: '' }], at(2026, 3, 10, 20, 0)).outside).toBe(false)
  })
})
