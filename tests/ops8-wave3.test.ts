import { describe, it, expect } from 'bun:test'
import {
  prevWindow, deltaPct, avgCheckOf, avgPartySizeOf, buildXzReport, deltaArrow,
} from '@/lib/xz-report'
import { buildGlEntry, glEntryNumber, glMemo, GL_STANDARD_ACCOUNTS } from '@/lib/gl'
import { filterReservations, RESERVATION_FILTERS } from '@/lib/reservation-filters'
import { shiftSummaryEmailText } from '@/lib/daily-email'

/* OPS-8 val 3 (v1.73.0) — pure-function units for the X/Z business report math,
   the GL daily journal balancing rule, reservation status filtering and the
   shift-close summary e-mail text. No DB, no network. */

describe('OPS-8 val 3 — X/Z report math', () => {
  it('prevWindow: same-length window immediately before the period', () => {
    const pw = prevWindow(new Date('2026-02-01T00:00:00'), new Date('2026-02-10T23:59:59.999'))
    expect(pw.from.toISOString()).toBe('2026-01-22T00:00:00.000Z')
    expect(pw.to.toISOString()).toBe('2026-01-31T23:59:59.999Z')
    // 1-day period → exactly the day before, same length
    const pw2 = prevWindow(new Date('2026-02-05T00:00:00'), new Date('2026-02-05T23:59:59.999'))
    expect(pw2.from.toISOString()).toBe('2026-02-04T00:00:00.000Z')
    expect(pw2.to.toISOString()).toBe('2026-02-04T23:59:59.999Z')
  })

  it('deltaPct: null without a baseline, otherwise 1-decimal percent', () => {
    expect(deltaPct(110, 0)).toBeNull()
    expect(deltaPct(110, -5)).toBeNull()
    expect(deltaPct(110, 100)).toBe(10)
    expect(deltaPct(90, 100)).toBe(-10)
    expect(deltaPct(100.5, 100)).toBe(0.5)
  })

  it('avgCheck: net/covers with 2 decimals; 0 without covers', () => {
    expect(avgCheckOf(247.45, 13)).toBe(19.03)
    expect(avgCheckOf(100, 3)).toBe(33.33)
    expect(avgCheckOf(100, 0)).toBe(0)
  })

  it('avgPartySize: mean of non-cancelled reservations, 0 when empty', () => {
    expect(avgPartySizeOf([])).toBe(0)
    expect(avgPartySizeOf([2, 4, 4])).toBe(3.33)
    expect(avgPartySizeOf([2, 2])).toBe(2)
  })

  it('buildXzReport: assembles metrics + previous-period comparison', () => {
    const rep = buildXzReport({
      from: '2026-02-01',
      to: '2026-02-10',
      grossSales: 366.65,
      netSales: 247.45,
      vatByRate: [{ rate: 22, base: 100, amount: 22 }, { rate: 9.5, base: 114.65, amount: 10.89 }],
      paymentsByMethod: [{ method: 'card', amount: 200 }, { method: 'cash', amount: 80 }],
      discountsTotal: 15,
      tipsTotal: 12.5,
      voidedCount: 2,
      voidedTotal: 43.2,
      wasteTotal: 8.4,
      covers: 13,
      avgPartySize: 3.25,
      prevNetSales: 200,
      prevCovers: 10,
      prevFrom: '2026-01-22',
      prevTo: '2026-01-31',
    })
    expect(rep.vatTotal).toBe(32.89)
    expect(rep.avgCheck).toBe(19.03)
    expect(rep.comparison.deltaNetPct).toBe(23.7)
    expect(rep.comparison.deltaCoversPct).toBe(30)
    expect(rep.paymentsByMethod[0].method).toBe('card')
    expect(rep.vatByRate[0].rate).toBe(9.5) // sorted ascending
  })

  it('deltaArrow: ▲ / ▼ / · markers', () => {
    expect(deltaArrow(5)).toBe('▲')
    expect(deltaArrow(-5)).toBe('▼')
    expect(deltaArrow(0)).toBe('·')
    expect(deltaArrow(null)).toBe('·')
  })
})

describe('OPS-8 val 3 — GL daily journal balancing rule', () => {
  const byCode = (lines: ReturnType<typeof buildGlEntry>['lines'], code: string) =>
    lines.find((l) => l.accountCode === code)

  it('standard SI accounts seeded: 101/204/221/401/402 with correct types', () => {
    const codes = Object.fromEntries(GL_STANDARD_ACCOUNTS.map((a) => [a.code, a]))
    expect(codes['101'].accountType).toBe('asset')
    expect(codes['204'].accountType).toBe('asset')
    expect(codes['221'].accountType).toBe('liability')
    expect(codes['401'].accountType).toBe('revenue')
    expect(codes['402'].accountType).toBe('revenue')
  })

  it('consistent day: debits == credits, VAT credit equals VAT total, net credit equals net', () => {
    // identity: cash + nonCash + discounts == net + vat (total = net + vat - discount)
    const e = buildGlEntry({ cash: 146, nonCash: 200, netSales: 300, vatTotal: 66, discountsTotal: 20 })
    expect(e.residual).toBe(0)
    expect(e.adjustedAccount).toBeNull()
    expect(e.balanced).toBe(true)
    expect(e.debits).toBe(366)
    expect(e.credits).toBe(366)
    expect(byCode(e.lines, '101')?.debit).toBe(146)
    expect(byCode(e.lines, '204')?.debit).toBe(200)
    expect(byCode(e.lines, '401')?.credit).toBe(300)
    expect(byCode(e.lines, '402')?.debit).toBe(20)
    expect(byCode(e.lines, '221')?.credit).toBe(66)
  })

  it('sub-cent rounding drift (<= 0.02) is absorbed by the 401 revenue line', () => {
    const e = buildGlEntry({ cash: 100, nonCash: 200, netSales: 250, vatTotal: 49.99, discountsTotal: 0 })
    expect(e.adjustedAccount).toBe('401')
    expect(e.balanced).toBe(true)
    expect(e.debits).toBe(e.credits)
    expect(byCode(e.lines, '401')?.credit).toBe(250.01)
    expect(byCode(e.lines, '402')).toBeUndefined() // no discounts → no 402 line
  })

  it('negative drift is absorbed by 401 without making the credit negative', () => {
    const e = buildGlEntry({ cash: 100, nonCash: 149.99, netSales: 250, vatTotal: 0, discountsTotal: 0 })
    // debits 249.99, credits 250 → residual -0.01 → 401 credit 249.99
    expect(e.adjustedAccount).toBe('401')
    expect(e.balanced).toBe(true)
    expect(byCode(e.lines, '401')?.credit).toBe(249.99)
  })

  it('real mismatch (voids without reversing payments) lands on the 402 line and still balances', () => {
    const e = buildGlEntry({ cash: 0, nonCash: 0, netSales: 100, vatTotal: 22, discountsTotal: 0 })
    expect(e.adjustedAccount).toBe('402')
    expect(e.balanced).toBe(true)
    expect(e.debits).toBe(e.credits)
    // credits exceed collections → 402 DEBIT 122 (contra revenue increases)
    expect(byCode(e.lines, '402')?.debit).toBe(122)
  })

  it('opposite mismatch (payments exceed revenue) lands on 402 CREDIT', () => {
    const e = buildGlEntry({ cash: 122, nonCash: 0, netSales: 100, vatTotal: 0, discountsTotal: 0 })
    expect(e.adjustedAccount).toBe('402')
    expect(e.balanced).toBe(true)
    expect(byCode(e.lines, '402')?.credit).toBe(22)
  })

  it('zero-activity day still balances (all-zero totals → empty entry)', () => {
    const e = buildGlEntry({ cash: 0, nonCash: 0, netSales: 0, vatTotal: 0, discountsTotal: 0 })
    expect(e.lines).toHaveLength(0)
    expect(e.balanced).toBe(true)
  })

  it('entry number + memo: deterministic per day, AVTO prefix for the memo', () => {
    expect(glEntryNumber('2026-02-10')).toBe('GL-20260210-01')
    expect(glMemo('2026-02-10')).toBe('AVTO dnevnik prodaje 2026-02-10')
  })
})

describe('OPS-8 val 3 — reservation status filter', () => {
  const now = new Date('2026-02-10T15:00:00').getTime()
  const mk = (id: string, reservedAt: string, status: string) => ({ id, reservedAt, status })
  const rows = [
    mk('a', '2026-02-09T18:00:00', 'COMPLETED'),
    mk('b', '2026-02-10T19:00:00', 'CONFIRMED'), // today, upcoming
    mk('c', '2026-02-10T09:00:00', 'SEATED'), // today, earlier
    mk('d', '2026-02-08T12:00:00', 'NO_SHOW'),
    mk('e', '2026-02-07T12:00:00', 'CANCELLED'),
    mk('f', '2026-02-11T12:00:00', 'CONFIRMED'), // future
  ]

  it('ALL returns everything sorted chronologically', () => {
    const out = filterReservations(rows, 'ALL', now)
    expect(out.map((r) => r.id)).toEqual(['e', 'd', 'a', 'c', 'b', 'f'])
  })

  it('UPCOMING: starts 1h ago or later, not cancelled (legacy dashboard rule)', () => {
    const out = filterReservations(rows, 'UPCOMING', now)
    // 'c' is SEATED but 6 h in the past → excluded by the 1 h rule
    expect(out.map((r) => r.id)).toEqual(['b', 'f'])
  })

  it('TODAY: any status within the local calendar day', () => {
    const out = filterReservations(rows, 'TODAY', now)
    expect(out.map((r) => r.id)).toEqual(['c', 'b'])
  })

  it('status chips: SEATED / NO_SHOW / CANCELLED exact matches', () => {
    expect(filterReservations(rows, 'SEATED', now).map((r) => r.id)).toEqual(['c'])
    expect(filterReservations(rows, 'NO_SHOW', now).map((r) => r.id)).toEqual(['d'])
    expect(filterReservations(rows, 'CANCELLED', now).map((r) => r.id)).toEqual(['e'])
  })

  it('all documented filters are exposed (UI chips parity)', () => {
    expect(RESERVATION_FILTERS).toEqual(['ALL', 'UPCOMING', 'TODAY', 'SEATED', 'NO_SHOW', 'CANCELLED'])
  })
})

describe('OPS-8 val 3 — shift-close daily summary e-mail text', () => {
  const data = {
    shiftId: 'sh1',
    shiftDate: new Date('2026-02-10T08:00:00'),
    from: new Date('2026-02-10T08:00:00'),
    to: new Date('2026-02-10T16:00:00'),
    locationId: 'loc1',
    gross: 1220.5,
    net: 1000.41,
    vat: 220.09,
    covers: 38,
    payments: [{ method: 'cash', amount: 300 }, { method: 'card', amount: 920.5 }],
    topItems: [{ name: 'Piščančji sent', qty: 12 }, { name: 'Ajdova kaša', qty: 8 }, { name: 'Kruh', qty: 5 }, { name: 'Kava', qty: 4 }],
  }

  it('subject carries the shift date marker', () => {
    const { subject } = shiftSummaryEmailText(data)
    expect(subject).toContain('RestavrantOS — dnevni povzetek')
    expect(subject).toContain('izmena')
  })

  it('body lists gross/net/vat/covers/avg check, payment methods and top items (max 3)', () => {
    const { body } = shiftSummaryEmailText(data)
    expect(body).toContain('Bruto promet (z DDV): 1220.50 EUR')
    expect(body).toContain('Neto promet (brez DDV): 1000.41 EUR')
    expect(body).toContain('DDV: 220.09 EUR')
    expect(body).toContain('Št. računov (covers): 38')
    expect(body).toContain('Povprečni račun: 26.33 EUR') // 1000.41 / 38
    expect(body).toContain('Gotovina: 300.00 EUR')
    expect(body).toContain('Kartica: 920.50 EUR')
    expect(body).toContain('1. Piščančji sent — 12×')
    expect(body).toContain('3. Kruh — 5×')
    expect(body).not.toContain('Kava') // only top 3 items are included
  })
})
