import { describe, expect, test } from 'bun:test'
import {
  WASTE_REASON_LABELS,
  WASTE_REASONS,
  WASTE_REVERSAL_TX_TYPE,
  WASTE_TX_TYPE,
  canReverseWaste,
  isWasteReason,
  validateWasteInput,
  wasteReasonLabel,
  wasteReversalReason,
  wasteStats,
  wasteTotalCents,
} from '@/lib/waste'

describe('waste — konstante in razlogi', () => {
  test('zaprt seznam razlogov z oznakami', () => {
    expect(WASTE_REASONS.length).toBeGreaterThanOrEqual(5)
    expect(WASTE_REASONS[WASTE_REASONS.length - 1]).toBe('drugo')
    for (const r of WASTE_REASONS) {
      expect(typeof WASTE_REASON_LABELS[r]).toBe('string')
      expect(WASTE_REASON_LABELS[r].length).toBeGreaterThan(0)
    }
  })
  test('isWasteReason', () => {
    expect(isWasteReason('pokvarjeno')).toBe(true)
    expect(isWasteReason('neznano')).toBe(false)
    expect(isWasteReason(42)).toBe(false)
    expect(isWasteReason(undefined)).toBe(false)
  })
  test('wasteReasonLabel: znan razlog, neznani surovi vnos, prazen → Drugo', () => {
    expect(wasteReasonLabel('preteklo')).toBe('Pretekel rok')
    expect(wasteReasonLabel('cudni-vnos')).toBe('cudni-vnos')
    expect(wasteReasonLabel('')).toBe('Drugo')
    expect(wasteReasonLabel(undefined as unknown as string)).toBe('Drugo')
  })
  test('tipi transakcij: WASTE knjiži odtok, reverzija je ADJUST', () => {
    expect(WASTE_TX_TYPE).toBe('WASTE')
    expect(WASTE_REVERSAL_TX_TYPE).toBe('ADJUST')
  })
})

describe('waste — wasteTotalCents (centna natančnost)', () => {
  test('osnovni izračun: 2 kg × 4,50 € = 9,00 €', () => {
    expect(wasteTotalCents(2, 4.5)).toBe(900)
  })
  test('količina na 3 decimalki: 0,333 kg × 6,84 €/kg = 2,28 €', () => {
    expect(wasteTotalCents(0.333, 6.84)).toBe(228)
  })
  test('float drift izziv: 0.1 × 3 × 1.1 — celoštevilčno se ne podvoji napake', () => {
    // 0.3 × 1.1 = 0.30000000000000004 v float; centna aritmetika → 33 ct
    expect(wasteTotalCents(0.3, 1.1)).toBe(33)
  })
  test('float drift izziv: 3.7 × 2.9 = 10.73', () => {
    expect(wasteTotalCents(3.7, 2.9)).toBe(1073)
  })
  test('zaokroževanje na cent pri grdyh vrednostih: 0.005 kg × 1.00 € = 1 ct', () => {
    expect(wasteTotalCents(0.005, 1)).toBe(1)
  })
  test('neveljavni vhodi → 0', () => {
    expect(wasteTotalCents(0, 5)).toBe(0)
    expect(wasteTotalCents(-2, 5)).toBe(0)
    expect(wasteTotalCents(2, 0)).toBe(0)
    expect(wasteTotalCents(2, -1)).toBe(0)
    expect(wasteTotalCents(NaN, 5)).toBe(0)
    expect(wasteTotalCents(Infinity, 5)).toBe(0)
  })
})

describe('waste — validateWasteInput', () => {
  test('veljaven vnos → normalizirana vrednost', () => {
    const v = validateWasteInput({ quantity: 1.23456, reason: 'pokvarjeno', note: '  vonj po plesni  ' })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.value.quantity).toBe(1.235) // zaokroženo na 3 decimalki
      expect(v.value.reason).toBe('pokvarjeno')
      expect(v.value.note).toBe('vonj po plesni')
    }
  })
  test('količina iz niza z vejico', () => {
    const v = validateWasteInput({ quantity: '2,5', reason: 'razlitje' })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.quantity).toBe(2.5)
  })
  test('manjkajoča/neveljavna količina', () => {
    expect(validateWasteInput({ reason: 'drugo' }).ok).toBe(false)
    expect(validateWasteInput({ quantity: '', reason: 'drugo' }).ok).toBe(false)
    expect(validateWasteInput({ quantity: 'abc', reason: 'drugo' }).ok).toBe(false)
    expect(validateWasteInput({ quantity: NaN, reason: 'drugo' }).ok).toBe(false)
  })
  test('količina ≤ 0 zavrnjena', () => {
    const z = validateWasteInput({ quantity: 0, reason: 'drugo' })
    expect(z.ok).toBe(false)
    if (!z.ok) expect(z.error).toContain('večja od 0')
    const n = validateWasteInput({ quantity: -1, reason: 'drugo' })
    expect(n.ok).toBe(false)
    // preveč majhna po zaokroževanju (0.0004 → 0)
    const t = validateWasteInput({ quantity: 0.0004, reason: 'drugo' })
    expect(t.ok).toBe(false)
  })
  test('zgornja meja količine', () => {
    const v = validateWasteInput({ quantity: 100000, reason: 'drugo' })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('mejo')
  })
  test('neznani razlog zavrnjen', () => {
    const v = validateWasteInput({ quantity: 1, reason: 'polilo-gorivo' })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('razlog')
  })
  test('opomba: obrežje na 500 znakov + trim', () => {
    const v = validateWasteInput({ quantity: 1, reason: 'drugo', note: 'x'.repeat(600) })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value.note.length).toBe(500)
  })
  test('null/undefined vnos', () => {
    expect(validateWasteInput(null).ok).toBe(false)
    expect(validateWasteInput(undefined).ok).toBe(false)
  })
})

describe('waste — reverzija', () => {
  test('šele ne-povrnjen zapis je reverzabilen', () => {
    expect(canReverseWaste({ reversedAt: null }).ok).toBe(true)
  })
  test('že povrnjen zapis zavrnjen z razlogom', () => {
    const r = canReverseWaste({ reversedAt: new Date('2026-01-01') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('že povrnjen')
  })
  test('razlog reverzije vsebuje id zapisa', () => {
    expect(wasteReversalReason('wr-abc123')).toBe('Reverzija odpada (wr-abc123)')
  })
})

describe('waste — wasteStats', () => {
  test('prazen seznam → ničelna statistika', () => {
    const s = wasteStats([])
    expect(s.count).toBe(0)
    expect(s.totalCents).toBe(0)
    expect(s.byReason).toEqual([])
    expect(s.topReason).toBeNull()
  })
  test('agregacija po razlogih + padajoče urejanje', () => {
    const s = wasteStats([
      { reason: 'pokvarjeno', totalCost: 5 },
      { reason: 'pokvarjeno', totalCost: 2.5 },
      { reason: 'preteklo', totalCost: 10 },
      { reason: 'drugo', totalCost: 0 },
    ])
    expect(s.count).toBe(4)
    expect(s.totalCents).toBe(1750)
    expect(s.byReason[0]).toMatchObject({ reason: 'preteklo', count: 1, totalCents: 1000 })
    expect(s.byReason[1]).toMatchObject({ reason: 'pokvarjeno', count: 2, totalCents: 750 })
    expect(s.byReason[2]).toMatchObject({ reason: 'drugo', count: 1, totalCents: 0 })
    expect(s.topReason).toBe('preteklo')
    expect(s.byReason[0].label).toBe('Pretekel rok')
  })
  test('enak strošek → večji števec naprej', () => {
    const s = wasteStats([
      { reason: 'a-x', totalCost: 2 },
      { reason: 'b-y', totalCost: 2 },
      { reason: 'b-y', totalCost: 0.00001 },
    ])
    expect(s.byReason[0].reason).toBe('b-y')
    expect(s.byReason[0].count).toBe(2)
  })
  test('float drift: 0.1+0.2 = 0.3 → 30 ct', () => {
    const s = wasteStats([
      { reason: 'drugo', totalCost: 0.1 },
      { reason: 'drugo', totalCost: 0.2 },
    ])
    expect(s.totalCents).toBe(30)
  })
})
