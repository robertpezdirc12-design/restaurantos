import { describe, it, expect } from 'bun:test'
import { resolveTargetsByRule, type NotificationRule, type PushTarget } from '@/lib/push'
import {
  lowStockThreshold,
  isBelowLowStock,
  shouldSendLowStockAlert,
  lowStockBody,
} from '@/lib/low-stock'
import { normalizeDursInput, normalizeDursResponse, pickDursEntry } from '@/lib/durs'
import {
  parLevel,
  suggestedQty,
  buildSuggestion,
  groupSuggestionsBySupplier,
  type ReorderItem,
} from '@/lib/reorder'

/* OPS-8 val 2 (v1.72.0) — pure-function units for the notification matrix,
   low-stock alerting rules, DURS normalization and reorder suggestion math.
   No DB, no network — only deterministic math and shape coercion. */

describe('OPS-8 val 2 — notification matrix (resolveTargetsByRule)', () => {
  const base: PushTarget = { roles: ['bar'], locationId: 'loc1', employeeIds: ['emp9'] }

  it('missing rule / everyone mode keeps the base target unchanged', () => {
    expect(resolveTargetsByRule(base, undefined)).toEqual(base)
    expect(resolveTargetsByRule(base, null)).toEqual(base)
    expect(resolveTargetsByRule(base, { mode: 'everyone' })).toEqual(base)
  })

  it('off mode returns null (caller skips the push)', () => {
    expect(resolveTargetsByRule(base, { mode: 'off' })).toBeNull()
  })

  it('roles mode overrides roles but preserves employeeIds (author always notified)', () => {
    const out = resolveTargetsByRule(base, { mode: 'roles', roles: ['kitchen', 'chef'] })
    expect(out).toEqual({ roles: ['kitchen', 'chef'], locationId: 'loc1', employeeIds: ['emp9'] })
  })

  it('roles mode with empty/invalid configured roles resolves to null (nobody to notify)', () => {
    expect(resolveTargetsByRule(base, { mode: 'roles', roles: [] })).toBeNull()
    expect(resolveTargetsByRule(base, { mode: 'roles', roles: ['  ', ''] })).toBeNull()
    expect(resolveTargetsByRule(base, { mode: 'roles', roles: [42 as unknown as string] })).toBeNull()
  })

  it('unknown mode falls back to everyone (forward compatibility)', () => {
    expect(resolveTargetsByRule(base, { mode: 'wizard' as NotificationRule['mode'] })).toEqual(base)
  })
})

describe('OPS-8 val 2 — low-stock rules', () => {
  it('threshold: reorderPoint wins over minQuantity; minQuantity fallback; 0 unmonitored', () => {
    expect(lowStockThreshold(10, 5)).toBe(10)
    expect(lowStockThreshold(0, 5)).toBe(5)
    expect(lowStockThreshold(0, 0)).toBe(0)
    expect(lowStockThreshold(null, null)).toBe(0)
  })

  it('below check: threshold 0 never alerts; crossing at exactly the threshold alerts', () => {
    expect(isBelowLowStock(4, 0)).toBe(false)
    expect(isBelowLowStock(5, 5)).toBe(true)
    expect(isBelowLowStock(4.99, 5)).toBe(true)
    expect(isBelowLowStock(5.01, 5)).toBe(false)
  })

  it('re-arm: first time always alerts; afterwards only when an inflow arrived since the last alert', () => {
    expect(shouldSendLowStockAlert(undefined, false)).toBe(true)
    expect(shouldSendLowStockAlert('2026-02-10T12:00:00.000Z', false)).toBe(false)
    expect(shouldSendLowStockAlert('2026-02-10T12:00:00.000Z', true)).toBe(true)
  })

  it('grouped body: max 5 names then ellipsis with the remaining count', () => {
    expect(lowStockBody(['A', 'B'])).toBe('A, B')
    expect(lowStockBody(['1', '2', '3', '4', '5'])).toBe('1, 2, 3, 4, 5')
    expect(lowStockBody(['1', '2', '3', '4', '5', '6', '7'])).toBe('1, 2, 3, 4, 5 … (+2)')
  })
})

describe('OPS-8 val 2 — DURS normalization', () => {
  it('input: strips spaces; 8 plain digits get the SI prefix; other input untouched', () => {
    expect(normalizeDursInput(' 5982 7513 ')).toBe('59827513'.length === 8 ? 'SI59827513' : '59827513')
    expect(normalizeDursInput('INETIS d.o.o.')).toBe('INETISd.o.o.')
    expect(normalizeDursInput('SI59827513')).toBe('SI59827513')
  })

  it('response: tolerant field aliases; vatPayer coerces only explicit truthy values', () => {
    const rows = normalizeDursResponse([
      {
        DavcnaStevilka: 'SI59827513',
        Naziv: 'INETIS D.O.O.',
        ZavezanecZaDDV: true,
        TransakcijskiRacuni: ['SI56 02000 00123456'],
      },
      { davcnaStevilka: '12345678', naziv: 'Test s.p.', zavezanecZaDDV: 'true', trr: [] },
      { taxNumber: '87654321', name: 'Nula', vatPayer: 0 },
      null,
      'garbage',
      { naziv: 'no tax number still listed' },
    ])
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({
      taxNumber: '59827513',
      vatId: 'SI59827513',
      name: 'INETIS D.O.O.',
      vatPayer: true,
      ibans: ['SI56 02000 00123456'],
    })
    expect(rows[1].vatPayer).toBe(true)
    expect(rows[2].vatPayer).toBe(false)
    expect(rows[3].vatId).toBe('')
  })

  it('response: non-array input yields an empty list', () => {
    expect(normalizeDursResponse(null)).toEqual([])
    expect(normalizeDursResponse({ DavcnaStevilka: '1' })).toEqual([])
  })

  it('pick: exact 8-digit tax number beats name match; name contains beats first-entry fallback', () => {
    const entries = normalizeDursResponse([
      { DavcnaStevilka: '11111111', Naziv: 'Prvi d.o.o.', ZavezanecZaDDV: true },
      { DavcnaStevilka: '59827513', Naziv: 'INETIS D.O.O.', ZavezanecZaDDV: true },
      { DavcnaStevilka: '22222222', Naziv: 'Tretji Inetis Trade', ZavezanecZaDDV: false },
    ])
    expect(pickDursEntry(entries, '59827513')?.taxNumber).toBe('59827513')
    expect(pickDursEntry(entries, 'si 5982 7513')?.taxNumber).toBe('59827513')
    expect(pickDursEntry(entries, 'inetis')?.taxNumber).toBe('59827513')
    expect(pickDursEntry(entries, 'trade')?.taxNumber).toBe('22222222')
    expect(pickDursEntry(entries, 'njam')?.taxNumber).toBe('11111111')
    expect(pickDursEntry([], 'x')).toBeNull()
  })
})

describe('OPS-8 val 2 — reorder suggestions math', () => {
  const item = (over: Partial<ReorderItem>): ReorderItem => ({
    itemId: 'i1',
    name: 'Moka',
    unit: 'kg',
    qty: 2,
    minQty: 5,
    reorderPoint: 0,
    costPerUnit: 1.5,
    ...over,
  })

  it('parLevel: reorderPoint takes precedence; minQuantity fallback; 0 unmonitored', () => {
    expect(parLevel(item({ reorderPoint: 12, minQty: 5 }))).toBe(12)
    expect(parLevel(item({ reorderPoint: 0, minQty: 5 }))).toBe(5)
    expect(parLevel(item({ reorderPoint: 0, minQty: 0 }))).toBe(0)
  })

  it('suggestedQty: PAR minus stock minus incoming (3-decimal rounding)', () => {
    expect(suggestedQty(10, 2, 0)).toBe(8)
    expect(suggestedQty(10, 2, 3)).toBe(5)
    expect(suggestedQty(10, 2, 9)).toBe(-1)
    expect(suggestedQty(10.5, 2.25, 0.125)).toBeCloseTo(8.125, 3)
  })

  it('buildSuggestion: skips above-par, unmonitored and incoming-covered items', () => {
    expect(buildSuggestion(item({ qty: 12, reorderPoint: 10 }), 0, null)).toBeNull()
    expect(buildSuggestion(item({ minQty: 0 }), 0, null)).toBeNull()
    expect(buildSuggestion(item({ reorderPoint: 10 }), 9, null)).toBeNull()
  })

  it('buildSuggestion happy path: suggested qty + cost estimate (2 decimals)', () => {
    const s = buildSuggestion(item({ reorderPoint: 10, qty: 2 }), 3, {
      supplierId: 'sup1',
      supplierName: 'Mlinarstvo d.o.o.',
    })
    expect(s).not.toBeNull()
    expect(s?.suggested).toBe(5)
    expect(s?.costEstimate).toBe(7.5)
    expect(s?.supplierId).toBe('sup1')
  })

  it('grouping: per-supplier groups sorted by total desc; unresolved suppliers share one group', () => {
    const a = buildSuggestion(item({ itemId: 'a', name: 'A', reorderPoint: 10, costPerUnit: 2 }), 0, {
      supplierId: 's1',
      supplierName: 'Dobavitelj 1',
    })
    const b = buildSuggestion(item({ itemId: 'b', name: 'B', reorderPoint: 6, minQty: 6, costPerUnit: 1 }), 0, {
      supplierId: 's2',
      supplierName: 'Dobavitelj 2',
    })
    const c = buildSuggestion(item({ itemId: 'c', name: 'C', reorderPoint: 4, costPerUnit: 3 }), 0, null)
    const groups = groupSuggestionsBySupplier([a, b, c].filter((x) => x !== null))
    expect(groups).toHaveLength(3)
    expect(groups[0].total).toBe(16)
    expect(groups.map((g) => g.supplierId)).toContain(null)
  })
})
