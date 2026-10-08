import { describe, expect, test } from 'bun:test'
import {
  GC_TX_TYPES,
  balanceAfterCents,
  canRedeem,
  cardNumberFor,
  effectiveCardStatus,
  gcNote,
  gcTxSign,
  giftCardIssueId,
  giftCardTxId,
  maskCardNumber,
  validateIssueCents,
  validateTopUpCents,
} from '@/lib/giftcards'

const NOW = new Date('2026-01-15T12:00:00Z')

describe('giftcards — effectiveCardStatus', () => {
  test('aktivna kartica s saldom', () => {
    expect(effectiveCardStatus('active', 5000, null, NOW)).toBe('active')
  })
  test('ročno deaktivirana ima prednost pred vsem', () => {
    expect(effectiveCardStatus('inactive', 5000, null, NOW)).toBe('inactive')
    expect(effectiveCardStatus('inactive', 5000, '2020-01-01', NOW)).toBe('inactive')
  })
  test('pretekla kartica', () => {
    expect(effectiveCardStatus('active', 5000, '2026-01-14T23:59:59Z', NOW)).toBe('expired')
    // meja: kartica velja ŠE na točno trenutek roka, preteče 1 ms PO roku
    expect(effectiveCardStatus('active', 5000, '2026-01-15T12:00:00Z', NOW)).toBe('active')
    expect(effectiveCardStatus('active', 5000, '2026-01-15T12:00:00.001Z', new Date('2026-01-15T12:00:00.002Z'))).toBe('expired')
  })
  test('izčrpana (saldo 0)', () => {
    expect(effectiveCardStatus('active', 0, null, NOW)).toBe('exhausted')
    expect(effectiveCardStatus('active', -1, null, NOW)).toBe('exhausted')
  })
  test('nepoznan DB status z saldom ostane aktivna', () => {
    expect(effectiveCardStatus('weird', 100, null, NOW)).toBe('active')
  })
})

describe('giftcards — canRedeem', () => {
  const card = { cardNumber: 'GC-20260101-000001', status: 'active', balanceCents: 2500, expiresAt: null }
  test('uspešen unovčenje dovolj velikega salda', () => {
    expect(canRedeem(card, 2500, NOW)).toEqual({ ok: true, status: 'active' })
    expect(canRedeem(card, 1, NOW).ok).toBe(true)
  })
  test('ne obstaja', () => {
    expect(canRedeem(null, 100, NOW)).toMatchObject({ ok: false })
    expect(canRedeem(null, 100, NOW).reason).toContain('ne obstaja')
  })
  test('neveljaven znesek (0, negativno, NaN)', () => {
    expect(canRedeem(card, 0, NOW).ok).toBe(false)
    expect(canRedeem(card, -5, NOW).ok).toBe(false)
    expect(canRedeem(card, Number.NaN, NOW).ok).toBe(false)
  })
  test('premalo salda — razlog vsebuje manjkajoči znesek', () => {
    const r = canRedeem(card, 3000, NOW)
    expect(r.ok).toBe(false)
    // strežniška sporočila dosledno uporabljajo točko (isti vzorec kot vsota delov plačila v /api/furs)
    expect(r.reason).toContain('5.00')
  })
  test('deaktivirana / pretekla / izčrpana', () => {
    expect(canRedeem({ ...card, status: 'inactive' }, 100, NOW).status).toBe('inactive')
    expect(canRedeem({ ...card, expiresAt: '2020-01-01' }, 100, NOW).status).toBe('expired')
    expect(canRedeem({ ...card, balanceCents: 0 }, 100, NOW).status).toBe('exhausted')
  })
})

describe('giftcards — cardNumberFor + maskCardNumber', () => {
  test('format GC-YYYYMMDD-XXXXXX', () => {
    expect(cardNumberFor(1, NOW)).toBe('GC-20260115-000001')
    expect(cardNumberFor(123456, NOW)).toBe('GC-20260115-123456')
  })
  test('zaporedje < 1 se prižge na 1', () => {
    expect(cardNumberFor(0, NOW)).toBe('GC-20260115-000001')
    expect(cardNumberFor(-3, NOW)).toBe('GC-20260115-000001')
  })
  test('maskiranje pokaže samo zadnje 4', () => {
    expect(maskCardNumber('GC-20260101-000123')).toBe('GC-…0123')
    expect(maskCardNumber('12')).toBe('…12')
  })
})

describe('giftcards — validacije zneskov', () => {
  test('polnjenje: mora biti > 0', () => {
    expect(validateTopUpCents(0)).toContain('večji od 0')
    expect(validateTopUpCents(-100)).toContain('večji od 0')
  })
  test('polnjenje: celo število centov + zgornja varovalka', () => {
    expect(validateTopUpCents(1050.5)).toContain('celo število')
    expect(validateTopUpCents(500_001)).toContain('Največje polnjenje')
    expect(validateTopUpCents(500_000)).toBeNull()
  })
  test('izdaja: negativen začetni saldo zavrnjen, 0 dovoljen (kartica brez vrednosti)', () => {
    expect(validateIssueCents(-1, null, NOW)).toContain('negativen')
    expect(validateIssueCents(0, null, NOW)).toBeNull()
    expect(validateIssueCents(5000, null, NOW)).toBeNull()
  })
  test('izdaja: rok mora biti v prihodnosti', () => {
    expect(validateIssueCents(1000, '2020-01-01', NOW)).toContain('prihodnosti')
    expect(validateIssueCents(1000, '2027-01-01', NOW)).toBeNull()
    expect(validateIssueCents(1000, '2026-01-15T12:00:00Z', NOW)).toContain('prihodnosti')
  })
})

describe('giftcards — ledžer (podpisani zneski)', () => {
  test('predznak po tipu', () => {
    expect(gcTxSign('issue')).toBe(1)
    expect(gcTxSign('topup')).toBe(1)
    expect(gcTxSign('refund')).toBe(1)
    expect(gcTxSign('adjust')).toBe(1)
    expect(gcTxSign('redeem')).toBe(-1)
    expect(GC_TX_TYPES).toContain('topup')
    expect(GC_TX_TYPES).toContain('redeem')
  })
  test('invarianta: vsota podpisanih = saldo (izdaja → polnjenje → unovčenje)', () => {
    let bal = 0
    bal = balanceAfterCents(bal, 'issue', 5000) // +50 €
    bal = balanceAfterCents(bal, 'topup', 1000) // +10 €
    bal = balanceAfterCents(bal, 'redeem', 2500) // −25 €
    expect(bal).toBe(3500)
    bal = balanceAfterCents(bal, 'redeem', 3500)
    expect(bal).toBe(0)
    expect(effectiveCardStatus('active', bal, null, NOW)).toBe('exhausted')
  })
})

describe('giftcards — idempotentni id transakcije', () => {
  test('determinističen', () => {
    expect(giftCardTxId('card1', 'op-123')).toBe(giftCardTxId('card1', 'op-123'))
  })
  test('različna kartica ali operacija → različen id', () => {
    expect(giftCardTxId('card1', 'op-123')).not.toBe(giftCardTxId('card2', 'op-123'))
    expect(giftCardTxId('card1', 'op-123')).not.toBe(giftCardTxId('card1', 'op-124'))
  })
  test('format gctx-…', () => {
    expect(giftCardTxId('card1', 'op-123')).toMatch(/^gctx-[0-9a-f]{8}-/)
  })
  test('izdaja: determinističen id kartice prek sha256', () => {
    expect(giftCardIssueId('op-abc')).toBe(giftCardIssueId('op-abc'))
    expect(giftCardIssueId('op-abc')).not.toBe(giftCardIssueId('op-abd'))
    expect(giftCardIssueId('op-abc')).toMatch(/^gc-[0-9a-f]{24}$/)
  })
})

describe('giftcards — opombe', () => {
  test('gcNote obreže in pade na privzeto', () => {
    expect(gcNote('', 'izdaja kartice')).toBe('izdaja kartice')
    expect(gcNote(null)).toBe('')
    expect(gcNote('x'.repeat(500)).length).toBe(200)
  })
})
