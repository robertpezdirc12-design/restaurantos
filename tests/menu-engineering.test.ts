import { describe, it, expect } from 'bun:test'
import {
  contributionMargin,
  foodCostPct,
  classifyQuadrant,
  computeThresholds,
  buildMenuEngineering,
  recipeCostFromRows,
  type MeItemInput,
} from '@/lib/menu-engineering'

/* OPS-8 (v1.71.0) — menu engineering math (Kasavana-Smith), pure functions, no DB.
   Guarantees: thresholds are computed WITHIN each category, popularity share is
   relative to the category total, unknown-cost items never enter quadrant math. */

const item = (over: Partial<MeItemInput> & { id: string; category?: string }): MeItemInput => ({
  name: over.id,
  category: 'Jedi',
  price: 10,
  qtySold: 10,
  revenue: 100,
  cost: 4,
  costKnown: true,
  ...over,
})

describe('menu engineering — CM and food cost %', () => {
  it('CM = price - cost', () => {
    expect(contributionMargin(10, 4)).toBe(6)
    expect(contributionMargin(0, 4)).toBe(-4)
  })

  it('FC % = cost/price*100, price 0 -> 0 (no division by zero)', () => {
    expect(foodCostPct(10, 4)).toBeCloseTo(40, 10)
    expect(foodCostPct(0, 4)).toBe(0)
  })
})

describe('menu engineering — quadrant classification', () => {
  it('stars: high popularity AND high CM', () => {
    expect(classifyQuadrant(10, 6, 5, 5)).toBe('stars')
  })
  it('plowhorses: high popularity, low CM', () => {
    expect(classifyQuadrant(10, 4, 5, 5)).toBe('plowhorses')
  })
  it('puzzles: low popularity, high CM', () => {
    expect(classifyQuadrant(3, 6, 5, 5)).toBe('puzzles')
  })
  it('dogs: low popularity, low CM', () => {
    expect(classifyQuadrant(3, 4, 5, 5)).toBe('dogs')
  })
  it('boundary belongs to the high side (>= threshold)', () => {
    expect(classifyQuadrant(5, 5, 5, 5)).toBe('stars')
    expect(classifyQuadrant(5, 4.99, 5, 5)).toBe('plowhorses')
    expect(classifyQuadrant(4.99, 5, 5, 5)).toBe('puzzles')
  })
})

describe('menu engineering — per-category thresholds', () => {
  it('qty threshold = category mean, CM threshold = mean of costKnown items only', () => {
    const items: MeItemInput[] = [
      item({ id: 'a1', category: 'Jedi', qtySold: 10, price: 10, cost: 4 }),
      item({ id: 'a2', category: 'Jedi', qtySold: 20, price: 10, cost: 4 }),
      item({ id: 'p1', category: 'Pijače', qtySold: 4, price: 2, cost: 0.5 }),
      item({ id: 'u1', category: 'Pijače', qtySold: 8, price: 3, cost: 0, costKnown: false }),
    ]
    const thr = computeThresholds(items)
    expect(thr).toHaveLength(2)
    const jedi = thr.find((t) => t.name === 'Jedi')!
    expect(jedi.qtyThreshold).toBe(15)
    expect(jedi.cmThreshold).toBe(6)
    const pijace = thr.find((t) => t.name === 'Pijače')!
    // qty mean uses ALL items (4+8)/2, CM mean uses only the costKnown one
    expect(pijace.qtyThreshold).toBe(6)
    expect(pijace.cmThreshold).toBe(1.5)
  })

  it('categories are sorted by name', () => {
    const thr = computeThresholds([item({ id: 'b', category: 'Z' }), item({ id: 'a', category: 'A' })])
    expect(thr.map((t) => t.name)).toEqual(['A', 'Z'])
  })
})

describe('menu engineering — full pipeline', () => {
  it('popularity share is relative to the category total and quadrants are assigned per category', () => {
    const items: MeItemInput[] = [
      // Jedi: qtyThr = (20+18+10)/3 = 16, cmThr = (6+2+3)/3 ~= 3.6667
      item({ id: 'j1', name: 'Burger', category: 'Jedi', qtySold: 20, price: 10, cost: 4 }), // stars
      item({ id: 'j2', name: 'Test', category: 'Jedi', qtySold: 18, price: 10, cost: 8 }), // plowhorse (CM 2 < 3.6667)
      item({ id: 'j3', name: 'Gelato', category: 'Jedi', qtySold: 10, price: 6, cost: 3 }), // dog (CM 3 < 3.6667)
      // Pijače: qtyThr = (2+9+4)/3 = 5, cmThr = (1.8+1.4+1.1)/3 ~= 1.4333
      item({ id: 'p1', name: 'Espresso', category: 'Pijače', qtySold: 2, price: 2, cost: 0.2 }), // puzzle (CM 1.8)
      item({ id: 'p2', name: 'Voda', category: 'Pijače', qtySold: 9, price: 2, cost: 0.6 }), // plowhorse (CM 1.4 < 1.4333)
      item({ id: 'p3', name: 'Sok', category: 'Pijače', qtySold: 4, price: 3, cost: 1.9 }), // dog (CM 1.1)
    ]
    const out = buildMenuEngineering(items)
    const byId = new Map(out.items.map((i) => [i.id, i]))
    const j1 = byId.get('j1')!
    expect(j1.quadrant).toBe('stars')
    expect(j1.popShare).toBeCloseTo(41.67, 1) // 20 / 48 * 100
    const j2 = byId.get('j2')!
    expect(j2.quadrant).toBe('plowhorses')
    expect(j2.popShare).toBeCloseTo(37.5, 1)
    const p1 = byId.get('p1')!
    expect(p1.quadrant).toBe('puzzles')
    expect(p1.popShare).toBeCloseTo(13.33, 1) // 2 / 15 * 100
    expect(byId.get('p2')!.quadrant).toBe('plowhorses')
    expect(byId.get('p3')!.quadrant).toBe('dogs')
  })

  it('items with unknown cost keep quadrant unknown but stay in the table', () => {
    const out = buildMenuEngineering([
      item({ id: 'k1', name: 'Skriti', qtySold: 10, cost: 0, costKnown: false }),
      item({ id: 'k2', name: 'Znan', qtySold: 10, cost: 3 }),
    ])
    expect(out.items).toHaveLength(2)
    const k1 = out.items.find((i) => i.id === 'k1')!
    expect(k1.quadrant).toBe('unknown')
    expect(k1.costKnown).toBe(false)
    expect(out.items.find((i) => i.id === 'k2')!.quadrant).toBe('stars')
    // unknown items are excluded from the CM threshold: mean CM = 7 (only k2)
    expect(out.categories[0].cmThreshold).toBe(7)
  })

  it('rounds money and percent fields to 2 decimals', () => {
    const out = buildMenuEngineering([item({ id: 'r1', qtySold: 1, price: 9.995, cost: 3.333 })])
    const r1 = out.items[0]
    // JS float: 9.995*100 = 999.4999... -> 9.99 (deterministic 2dp rounding)
    expect(r1.price).toBe(9.99)
    expect(r1.cost).toBe(3.33)
    expect(r1.cm).toBe(6.66)
    expect(r1.foodCostPct).toBeCloseTo(33.35, 1)
  })
})

describe('menu engineering — recipe cost from rows (BOM-aware, OPS-9)', () => {
  it('sums ALL nodes (direct + sub-recipe children) x costPerUnit', () => {
    const cost = recipeCostFromRows([
      { id: 'a', quantityPerServing: 0.2, costPerUnit: 10 }, // 2.0
      { id: 'b', quantityPerServing: 1, costPerUnit: 0.5 }, // 0.5
      { id: 'c', quantityPerServing: 5, costPerUnit: 2, parentRecipeItemId: 'b' }, // sub-recipe child -> counts now
    ])
    expect(cost).toBeCloseTo(12.5, 10)
  })

  it('yieldPercent below 100 raises the effective raw quantity (netto/(yield/100))', () => {
    const cost = recipeCostFromRows([{ id: 'a', quantityPerServing: 0.4, yieldPercent: 50, costPerUnit: 4 }])
    expect(cost).toBeCloseTo(3.2, 10)
  })

  it('handles decimal strings (Prisma Decimal serialized)', () => {
    const cost = recipeCostFromRows([{ id: 'a', quantityPerServing: '0.25', costPerUnit: '4.00' }])
    expect(cost).toBeCloseTo(1, 10)
  })

  it('empty recipe -> 0 (caller falls back to costPerServing / unknown)', () => {
    expect(recipeCostFromRows([])).toBe(0)
  })
})
