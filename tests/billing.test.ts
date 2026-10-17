/**
 * Issue #4 §11 — unit testi za kanonični izračun računa (src/lib/billing.ts).
 * Čista matematika — brez DB. Podpisi so preverjeni proti dejanski kodi:
 *   computeBill(input: BillInput): BillResult
 *   discountAmountOf(d: { type: string; amount: number | unknown }, base: number): number
 */
import { describe, expect, test } from 'bun:test'
import { computeBill, discountAmountOf, netFromGross, vatFromGross } from '@/lib/billing'
import { APP_VERSION } from '@/lib/version'
import type { BillInput, BillItem } from '@/lib/billing'

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

  test('odstotek popust (Happy Hour auto, percent 10 %) → 10 % BRUTO cene (kar gost vidi)', () => {
    const b = computeBill(
      baseInput({
        autoCandidates: [{ id: 'd1', name: 'Happy Hour', type: 'percent', amount: 10 }],
      }),
    )
    expect(b.autoDiscounts).toHaveLength(1)
    expect(b.autoDiscounts[0].amount).toBe(1.22) // 10 % od 12,20 (prikazana cena)
    expect(b.discountTotal).toBe(1.22)
    expect(b.totalDue).toBe(10.98)
  })

  test('popust ne gre pod 0 — ogromen popust je omejen na grossTotal', () => {
    const b = computeBill(baseInput({ manualDiscount: 999 }))
    expect(b.totalDue).toBe(0)
    expect(b.discountTotal).toBe(12.2) // omejeno na znesek, ki ga gost plača
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

// Naloga #6 — cena v bazi je KONČNA cena za gosta (vključno z DDV). DDV se
// izvleče iz cene, ne prišteva. Testi zaklenejo to konvencijo, da se ne more
// vrstiti add-on izračun ((cena * stopnja) / 100) brez porušitve teh trditev.
describe('netFromGross / vatFromGross — izvleček DDV iz končne cene', () => {
  test('espresso 2,00 € pri 9,5 % → neto 1,83 € + DDV 0,17 €', () => {
    expect(netFromGross(2, 9.5)).toBe(1.83)
    expect(vatFromGross(2, 9.5)).toBe(0.17)
  })

  test('10,00 € pri 22 % → neto 8,20 € + DDV 1,80 € (ne 12,20 €)', () => {
    expect(netFromGross(10, 22)).toBe(8.2)
    expect(vatFromGross(10, 22)).toBe(1.8)
  })

  test('neto + DDV = bruto (brez dvojinega zaokroževanja — DDV je razlika)', () => {
    for (const gross of [0.01, 1.99, 2, 3.5, 7.77, 19.95, 1137.8, 1356.98]) {
      for (const rate of [0, 5, 9.5, 22]) {
        expect(Math.round((netFromGross(gross, rate) + vatFromGross(gross, rate)) * 100)).toBe(
          Math.round(gross * 100),
        )
      }
    }
  })

  test('stopnja 0 (brez DDV) → neto = bruto, DDV 0', () => {
    expect(netFromGross(12.34, 0)).toBe(12.34)
    expect(vatFromGross(12.34, 0)).toBe(0)
  })

  test('neveljavni vnos (negativno / NaN) → 0, nikoli negativni DDV', () => {
    expect(netFromGross(-5, 22)).toBe(0)
    expect(vatFromGross(-5, 22)).toBe(0)
    expect(netFromGross(Number.NaN, 22)).toBe(0)
    expect(vatFromGross(Number.NaN, 22)).toBe(0)
  })
})

describe('computeBill — nevtralizacija neveljavnih zneskov na vhodu', () => {
  // Najdeno s stress testom (billing-stress.test.ts, deterministični fuzz): na Postgresu je
  // 'NaN'::numeric v stolpcu zapisljiv, num() ga spusti naprej in je NN podvozil totalDue →
  // fiskalni račun z NaN namesto zneska. computeBill mora nevtralizirati na svojem vhodu.
  test('ročni popust NaN → ignoriran (0), totalDue ostane = grossTotal', () => {
    const b = computeBill(baseInput({ subtotal: 15, tax: 3.5, manualDiscount: Number.NaN }))
    expect(b.manualDiscount).toBe(0)
    expect(b.discountTotal).toBe(0)
    expect(b.grossTotal).toBe(18.5)
    expect(b.totalDue).toBe(18.5)
  })

  test('subtotal/tax NaN → 0; vsota, za plačilo in unovčenje točk ostanejo končni', () => {
    const b = computeBill(baseInput({ subtotal: Number.NaN, tax: Number.NaN, manualDiscount: 5 }))
    expect(b.subtotal).toBe(0)
    expect(b.tax).toBe(0)
    expect(b.grossTotal).toBe(0)
    expect(b.totalDue).toBe(0)
    expect(b.loyalty.maxRedeemablePoints).toBe(0)
  })

  test('nekončen popust (Infinity) → nevtraliziran na 0, NE pomeni «vse brezplačno»', () => {
    // fail-closed smer: pokvarjen popust ne sme izničiti prihodka in izdati fiskalnega
    // računa z 0; gost plača ceno, ki je napisana na meniju.
    const b = computeBill(baseInput({ subtotal: 15, tax: 3.5, manualDiscount: Number.POSITIVE_INFINITY }))
    expect(b.manualDiscount).toBe(0)
    expect(b.discountTotal).toBe(0)
    expect(b.totalDue).toBe(18.5)
  })

  test('realen popust, večji od računa → še vedno omejen na grossTotal (račun nikoli pod 0)', () => {
    const b = computeBill(baseInput({ subtotal: 15, tax: 3.5, manualDiscount: 999 }))
    expect(b.discountTotal).toBe(18.5)
    expect(b.totalDue).toBe(0)
  })
})

describe('computeBill — konvencija «vključno z DDV»', () => {
  const item = (over: Partial<BillItem> = {}): BillItem => ({
    id: 'i1',
    menuItemId: 'm1',
    name: 'Kava Espresso',
    quantity: 1,
    unitPrice: 2,
    vatRate: 9.5,
    vatAmount: vatFromGross(2, 9.5),
    categoryId: null,
    voided: false,
    ...over,
  })

  // Račun iz treh prikazanih cen: 2,00 € @9,5 % + 2× 3,00 € @22 % = 8,00 €
  const grossCart = (): { subtotal: number; tax: number; items: BillItem[] } => {
    const a = item()
    const b = item({
      id: 'i2',
      menuItemId: 'm2',
      name: 'Pivo',
      quantity: 2,
      unitPrice: 3,
      vatRate: 22,
      vatAmount: vatFromGross(6, 22),
    })
    const subtotal =
      Math.round((netFromGross(a.unitPrice * a.quantity, a.vatRate) + netFromGross(b.unitPrice * b.quantity, b.vatRate)) * 100) / 100
    const tax = Math.round((a.vatAmount + b.vatAmount) * 100) / 100
    return { subtotal, tax, items: [a, b] }
  }

  test('brez popusta → gost plača točno vsoto prikazanih cen (8,00 €)', () => {
    const { subtotal, tax, items } = grossCart()
    const prikazano = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0)
    const b = computeBill(baseInput({ items, subtotal, tax }))
    expect(b.subtotal).toBe(6.75) // NETO osnova
    expect(b.tax).toBe(1.25) // izvlečeni DDV
    expect(b.grossTotal).toBe(8)
    expect(b.totalDue).toBe(prikazano)
  })

  test('ročni popust 2,00 € → odšteje se od bruto (gost plača 6,00 €)', () => {
    const { subtotal, tax, items } = grossCart()
    const b = computeBill(baseInput({ items, subtotal, tax, manualDiscount: 2 }))
    expect(b.totalDue).toBe(6)
  })

  test('popust na kategorijo je seštevek BRUTO postavk te kategorije', () => {
    const { subtotal, tax, items } = grossCart()
    const withCat = items.map((it) => (it.id === 'i2' ? { ...it, categoryId: 'piva' } : it))
    const b = computeBill(
      baseInput({
        items: withCat,
        subtotal,
        tax,
        autoCandidates: [
          { id: 'd1', name: 'Happy Pivo', type: 'percent', amount: 10, targetCategoryIds: 'piva' },
        ],
      }),
    )
    expect(b.autoDiscounts[0].amount).toBe(0.6) // 10 % od 6,00 € prikazanega
    expect(b.totalDue).toBe(7.4)
  })

  test('zvestoba: unovčljive točke se računajo na bruto (znesek, ki ga gost plača)', () => {
    const { subtotal, tax, items } = grossCart()
    const b = computeBill(
      baseInput({ items, subtotal, tax, loyaltyEnabled: true, pointsValue: 0.01 }),
    )
    expect(b.loyalty.maxRedeemablePoints).toBe(800) // floor(8,00 / 0,01)
  })
})

/* ─────────────── REGISTRI — val v1.125.0 ─────────────── */

describe('REGISTRI — val v1.125.0 (e-računi SI/HR, issue #4)', () => {
  test('APP_VERSION === 1.125.0', () => {
    expect(APP_VERSION).toBe('1.125.0')
  })
})
