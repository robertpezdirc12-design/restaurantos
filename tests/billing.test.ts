/**
 * Issue #4 §11 — unit testi za kanonični izračun računa (src/lib/billing.ts).
 * Čista matematika — brez DB. Podpisi so preverjeni proti dejanski kodi:
 *   computeBill(input: BillInput): BillResult
 *   discountAmountOf(d: { type: string; amount: number | unknown }, base: number): number
 */
import { describe, expect, test } from 'bun:test'
import { computeBill, discountAmountOf } from '@/lib/billing'
import type { BillInput } from '@/lib/billing'

const baseInput = (over: Partial<BillInput> = {}): BillInput => ({
  items: [],
  subtotal: 10,
  tax: 2.2,
  manualDiscount: 0,
  autoCandidates: [],
  now: new Date('2026-01-15T12:00:00'),
  loyaltyEnabled: false,
  pointsPerEuro: 0,
  pointsValue: 0.01,
  ...over,
})

describe('computeBill — osnova', () => {
  test('brez popusta → totalDue = subtotal + tax (grossTotal)', () => {
    const b = computeBill(baseInput())
    expect(b.subtotal).toBe(10)
    expect(b.tax).toBe(2.2)
    expect(b.grossTotal).toBe(12.2)
    expect(b.discountTotal).toBe(0)
    expect(b.totalDue).toBe(12.2)
  })

  test('fiksni popust (manual) → totalDue = gross − popust', () => {
    const b = computeBill(baseInput({ manualDiscount: 2 }))
    expect(b.manualDiscount).toBe(2)
    expect(b.discountTotal).toBe(2)
    expect(b.totalDue).toBe(10.2)
  })

  test('odstotek popust (Happy Hour auto, percent 10 %) → 10 % subtotala', () => {
    const b = computeBill(
      baseInput({
        autoCandidates: [{ id: 'd1', name: 'Happy Hour', type: 'percent', amount: 10 }],
      }),
    )
    expect(b.autoDiscounts).toHaveLength(1)
    expect(b.autoDiscounts[0].amount).toBe(1) // 10 % od 10
    expect(b.discountTotal).toBe(1)
    expect(b.totalDue).toBe(11.2)
  })

  test('popust ne gre pod 0 — ogromen popust je omejen na subtotal', () => {
    const b = computeBill(baseInput({ manualDiscount: 999 }))
    expect(b.totalDue).toBe(2.2) // max(0, 12.2 − 10)
    expect(b.discountTotal).toBe(10) // omejeno na subtotal
  })

  test('ročni + auto popust se seštejeta (skupaj omejeno na subtotal)', () => {
    const b = computeBill(
      baseInput({
        manualDiscount: 1,
        autoCandidates: [{ id: 'd1', name: 'HH', type: 'fixed', amount: 0.5 }],
      }),
    )
    expect(b.discountTotal).toBe(1.5)
    expect(b.totalDue).toBe(10.7)
  })
})

describe('computeBill — zvestoba', () => {
  test('maxRedeemablePoints ≥ 0 in = floor(totalDue / pointsValue)', () => {
    const b = computeBill(baseInput({ loyaltyEnabled: true, pointsValue: 0.01 }))
    expect(b.loyalty.maxRedeemablePoints).toBe(1220) // floor(12.2 / 0.01)
    expect(b.loyalty.maxRedeemablePoints).toBeGreaterThanOrEqual(0)
  })

  test('pointsValue 0 → maxRedeemablePoints 0 (nikoli NaN/negativno)', () => {
    const b = computeBill(baseInput({ loyaltyEnabled: true, pointsValue: 0 }))
    expect(b.loyalty.maxRedeemablePoints).toBe(0)
  })
})

describe('discountAmountOf', () => {
  test('percent — odstotek osnove', () => {
    expect(discountAmountOf({ type: 'percent', amount: 10 }, 100)).toBe(10)
  })

  test("legacy 'percentage' alias (produkcijski podatki) se obnaša kot percent", () => {
    expect(discountAmountOf({ type: 'percentage', amount: 25 }, 100)).toBe(25)
  })

  test('fixed — fiksni znesek, omejen na osnovo', () => {
    expect(discountAmountOf({ type: 'fixed', amount: 30 }, 100)).toBe(30)
    expect(discountAmountOf({ type: 'fixed', amount: 150 }, 100)).toBe(100)
  })

  test('osnova 0 → popust 0 (nikoli negativno)', () => {
    expect(discountAmountOf({ type: 'percent', amount: 50 }, 0)).toBe(0)
    expect(discountAmountOf({ type: 'fixed', amount: 5 }, 0)).toBe(0)
  })
})
