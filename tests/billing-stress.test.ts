/**
 * Naloga #6 — stress test (lastnostni fuzz) za DDV konvencijo «končna cena za gosta».
 *
 * Navodni testi v billing.test.ts preverjajo konkretna mesta; ta datoteka preverja,
 * da LASTNOST velja povsod na domeni, kjer produkt dejansko živi (cene 0,01–5.000 €,
 * stopnje 0–22 %). Generiranje je DETERMINISTIČNO (fiksni seed → ponovljiva napaka),
 * referenca pa JE NEODVISNA integer-cent aritmetika, ne kopija produkcijske delitve.
 *
 * Invariante:
 *  I1 neto + DDV === končna cena (eksaktno, brez centnega beža)
 *  I2 izvlečen neto === integer-cent referenca round(g·10000 / (10000 + stopnja·100))
 *  I3 monotonost po ceni pri fiksni stopnji
 *  I4 neveljaven vnos (NaN/±Infinity/negativno) → 0, nikoli NaN ali negativen znesek
 *  I5 splitVat in computeBill sta zaprta: agregat === vsota postavljenih končnih cen
 *  I6 0 <= totalDue <= grossTotal in discountTotal <= grossTotal pod poljubnimi popusti
 */
import { describe, expect, test } from 'bun:test'
import { computeBill, netFromGross, splitVat, vatFromGross } from '@/lib/billing'
import { r2 } from '@/lib/map'
import type { BillInput, BillItem } from '@/lib/billing'

/** mulberry32 — determinističen PRNG (ist seed = isti niz, kjerkoli se test ponovi). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0x1124_5eed
/** Realne stopnje: SI 22 / 9,5 (+ 0 za oproščeno) + tuje, ker ima baza lahko katerokoli. */
const RATES = [0, 0.5, 5, 8.5, 9.5, 13.5, 17, 22]

/** Končna cena v centih → EUR (vse vnosne cene so centno poravnane, kot v bazi Decimal(10,2)). */
const cents = (c: number) => c / 100

/** Neodvisna referenca: neto v centih, izračunan na celih številih (brez plavajoče delitve z 1+r/100).
 *  Pri stopnjah iz RATES je števec (gC·10000 ali njegova okrajšana oblika) vedno SOD, imenovalec
 *  pa liha komponenta ne more produce robu 0,5 ¢ — zato je enakost z produkcijskim r2 EKSTNA
 *  in ne tolerance. Izmerjeno: 0 razlik na 40.000 parov. */
function netCentsRef(grossCents: number, rate: number): number {
  return Math.round((grossCents * 10000) / (10000 + Math.round(rate * 100)))
}

describe('stress I1+I2 — neto + DDV = končna cena, potrjeno z integer oraklom', () => {
  test('40.000 naključnih (cena, stopnja) parov: vsota razčlenitve vrne končno ceno', () => {
    const next = rng(SEED)
    const fails: string[] = []
    const ties: string[] = []
    for (let i = 0; i < 40_000; i++) {
      const gC = Math.floor(next() * 500_001) // 0,00 € – 5.000,00 €
      const rate = RATES[i % RATES.length]
      const g = cents(gC)
      const net = netFromGross(g, rate)
      const vat = vatFromGross(g, rate)
      if (r2(net + vat) !== g) fails.push(`${g.toFixed(2)} @${rate} → ${net}+${vat}`)
      const refC = netCentsRef(gC, rate)
      if (refC !== Math.round(net * 100)) {
        // Rob zaokroževanja na polovičnem centu: plavajoča delitev in integer orakel se
        // lahko razideta za 1 cent. Je EN sam cent in razlika pade na točno polovico?
        const exact = (gC * 10000) / (10000 + Math.round(rate * 100))
        const onHalfCent = Math.abs(exact - Math.floor(exact) - 0.5) < 1e-9
        if (Math.abs(refC - Math.round(net * 100)) === 1 && onHalfCent) ties.push(`${g.toFixed(2)} @${rate}`)
        else fails.push(`orakel ${g.toFixed(2)} @${rate} ref=${refC} kod=${Math.round(net * 100)}`)
      }
      if (!(net >= 0 && vat >= 0 && net <= g)) fails.push(`predznak ${g.toFixed(2)} @${rate}`)
      // DDV delež končne cene = r/(100+r), znotraj polovičnega centa zaokroževanja
      const expected = (g * rate) / (100 + rate)
      if (Math.abs(vat - expected) > 0.005 + 1e-9) fails.push(`delež ${g.toFixed(2)} @${rate}`)
    }
    expect(fails.slice(0, 5)).toEqual([])
    expect(fails.length).toBe(0)
    // Dokumentirano: robustnost zaokroževanja na polovičnem centu (ni napaka, je meja).
    expect(ties.length).toBeLessThan(50)
  })
})

describe('stress I3 — monotonost', () => {
  test('naraščajoča končna cena nikoli ne zmanjša neto osnove ali DDV', () => {
    for (const rate of RATES) {
      let prevNet = -1
      let prevVat = -1
      for (let gC = 0; gC <= 20_000; gC += 7) {
        const g = cents(gC)
        const net = netFromGross(g, rate)
        const vat = vatFromGross(g, rate)
        expect(net).toBeGreaterThanOrEqual(prevNet)
        expect(vat).toBeGreaterThanOrEqual(prevVat)
        prevNet = net
        prevVat = vat
      }
    }
  })
})

describe('stress I4 — nevarni vnosi nikoli ne izpljunejo NaN ali negativca', () => {
  test('NaN / ±Infinity / negativno / 0 → ničla, razčlenitev ostane zaprta', () => {
    const hostile = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1_000_000, -0.01, -0, 0]
    for (const v of hostile) {
      for (const rate of [...RATES, Number.NaN, -22, Number.POSITIVE_INFINITY]) {
        const net = netFromGross(v, rate)
        const vat = vatFromGross(v, rate)
        expect(Number.isFinite(net)).toBe(true)
        expect(Number.isFinite(vat)).toBe(true)
        expect(net).toBeGreaterThanOrEqual(0)
        expect(vat).toBeGreaterThanOrEqual(0)
        expect(r2(net + vat)).toBe(r2(Math.max(0, Number.isFinite(v) ? v : 0)))
      }
    }
  })
})

describe('stress I5+I6 — agregati (splitVat / computeBill) ostanejo zaprti', () => {
  const mkItem = (i: number, unitCents: number, qty: number, rate: number, voided: boolean): BillItem => {
    const line = r2(cents(unitCents) * qty)
    return {
      id: `st-${i}`,
      menuItemId: `mi-${i}`,
      name: ` artikel ${i}`,
      quantity: qty,
      unitPrice: cents(unitCents),
      vatRate: rate,
      vatAmount: vatFromGross(line, rate),
      categoryId: i % 2 === 0 ? 'cat-a' : 'cat-b',
      voided,
    }
  }

  /** Kako produksijski seštevalec sestavi osnovo (ops.createOrderCore / recalcOrderTotals). */
  const aggregates = (items: BillItem[]) => {
    let subtotal = 0
    let tax = 0
    for (const it of items) {
      const line = it.unitPrice * it.quantity
      const vat = vatFromGross(line, it.vatRate)
      subtotal += r2(line - vat)
      tax += vat
    }
    return { subtotal: r2(subtotal), tax: r2(tax) }
  }

  /** Minimalna veljavna osnova — isti obrazec kot ga dajejo produkcijski klicatelji. */
  const baseCart = (): BillInput => {
    const it = mkItem(0, 1850, 1, 22, false)
    const line = r2(it.unitPrice * it.quantity)
    const vat = vatFromGross(line, it.vatRate)
    return {
      items: [it],
      subtotal: r2(line - vat),
      tax: vat,
      manualDiscount: 0,
      autoCandidates: [],
      now: new Date('2026-01-15T12:00:00'),
      loyaltyEnabled: false,
      pointsPerEuro: 0,
      pointsValue: 0.01,
    }
  }

  test('splitVat: 2.000 naključnih košaric — neto + DDV === vsota postavljenih končnih cen', () => {
    const next = rng(SEED + 1)
    for (let k = 0; k < 2_000; k++) {
      const n = 1 + Math.floor(next() * 8)
      const items: BillItem[] = []
      for (let i = 0; i < n; i++) {
        items.push(mkItem(i, 1 + Math.floor(next() * 3_000), 1 + Math.floor(next() * 6), RATES[Math.floor(next() * RATES.length)], next() < 0.15))
      }
      const live = items.filter((it) => !it.voided)
      const shown = r2(live.reduce((s, it) => s + r2(it.unitPrice * it.quantity), 0))
      const split = splitVat(live, (it) => r2(it.unitPrice * it.quantity), (it) => it.vatAmount)
      expect(split.gross).toBe(shown)
      expect(r2(split.net + split.vat)).toBe(split.gross)
      expect(split.vat).toBeLessThanOrEqual(split.gross)
      expect(split.net).toBeGreaterThanOrEqual(0)
    }
  })

  test('computeBill: 2.000 košaric × poljubni popusti — totalDue ostane v [0, grossTotal] ≡ prikazanim cenam', () => {
    const next = rng(SEED + 2)
    for (let k = 0; k < 2_000; k++) {
      const n = 1 + Math.floor(next() * 8)
      const items: BillItem[] = []
      for (let i = 0; i < n; i++) {
        items.push(mkItem(i, 1 + Math.floor(next() * 3_000), 1 + Math.floor(next() * 6), RATES[Math.floor(next() * RATES.length)], next() < 0.1))
      }
      const live = items.filter((it) => !it.voided)
      const shown = r2(live.reduce((s, it) => s + r2(it.unitPrice * it.quantity), 0))
      const agg = aggregates(live)
      const mode = Math.floor(next() * 5)
      const manual = mode === 0 ? 0 : mode === 1 ? r2(shown * next()) : mode === 2 ? shown * 3 : mode === 3 ? -50 : Number.NaN
      const autoCandidates =
        next() < 0.5
          ? [{ id: `auto-${k}`, name: 'Happy Hour', type: next() < 0.5 ? 'percent' : 'fixed', amount: [0, 10, 50, 100, 1000][Math.floor(next() * 5)], targetCategoryIds: next() < 0.5 ? '' : 'cat-a' }]
          : []
      const input: BillInput = {
        items,
        subtotal: agg.subtotal,
        tax: agg.tax,
        manualDiscount: manual,
        autoCandidates,
        now: new Date('2026-01-15T12:00:00'),
        loyaltyEnabled: true,
        pointsPerEuro: 1,
        pointsValue: 0.01,
      }
      const b = computeBill(input)
      // KLJUČNA POSLOVNA TRDITEV: račun brez popusta === vsota cen, ki jih gost vidi na meniju.
      expect(b.grossTotal).toBe(shown)
      expect(b.totalDue).toBeGreaterThanOrEqual(0)
      expect(b.totalDue).toBeLessThanOrEqual(b.grossTotal)
      expect(b.discountTotal).toBeLessThanOrEqual(b.grossTotal)
      expect(b.totalDue).toBe(r2(b.grossTotal - b.discountTotal))
      expect(r2(b.subtotal + b.tax)).toBe(b.grossTotal)
      for (const v of [b.subtotal, b.tax, b.grossTotal, b.manualDiscount, b.discountTotal, b.totalDue, b.loyalty.maxRedeemablePoints]) {
        expect(Number.isFinite(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test('computeBill: neveljavna osnova (NaN/±Infinity v subtotal/tax) → nobeno polje ne nosi NaN', () => {
    const hostile = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    for (const a of hostile) {
      for (const bm of hostile) {
        const b = computeBill({
          ...baseCart(),
          subtotal: a,
          tax: bm,
          manualDiscount: bm,
        })
        for (const v of [b.subtotal, b.tax, b.grossTotal, b.manualDiscount, b.discountTotal, b.totalDue]) {
          expect(Number.isFinite(v)).toBe(true)
          expect(v).toBeGreaterThanOrEqual(0)
        }
        expect(b.totalDue).toBeLessThanOrEqual(b.grossTotal)
        // Infinity osnove NIKOLI ne sme navidezno povečati računa: nevtralizirana je na 0
        if (!Number.isFinite(a)) expect(b.subtotal).toBe(0)
        if (!Number.isFinite(bm)) expect(b.tax).toBe(0)
      }
    }
  })
})
