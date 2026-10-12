/**
 * OPS-9 val 1 — recipe BOM maturity (pure math, NO db fixtures).
 *
 * Covers src/lib/recipe-cost.ts:
 *  - effectiveRawQty: yield 100 -> identity; 80 -> net / 0.8; invalid (0, negative,
 *    > 100, NaN) -> treated as 100; r3 rounding (3 decimals).
 *  - recipeCost: flat sum; recursive cost with sub-recipe children (every node
 *    consumes raw at its own level); cycle guard terminates and counts each node once;
 *    missing costPerUnit -> 0 contribution + costKnown=false; dangling parent -> root.
 *  - flattenDeduction: portions multiplier; dedupe by inventoryItemId (sum);
 *    identical to the legacy flat math for yieldPercent=100 without children
 *    (backward-compatibility proof for deductStockForOrderTx).
 *
 * Pure data only — no DB, no auth, no fixtures (no TEST_PREFIXES entry needed).
 */
import { describe, expect, test } from 'bun:test'
import { effectiveRawQty, flattenDeduction, recipeCost, type RecipeNode } from '../src/lib/recipe-cost'

let seq = 0
/** Deterministic node factory (ids n1, n2, ...). */
function nd(partial: Partial<RecipeNode> & { inventoryItemId: string; quantityPerServing: number }): RecipeNode {
  seq += 1
  return {
    id: partial.id || `n${seq}`,
    menuItemId: partial.menuItemId || 'mi1',
    inventoryItemId: partial.inventoryItemId,
    quantityPerServing: partial.quantityPerServing,
    yieldPercent: partial.yieldPercent ?? 100,
    unit: partial.unit || 'kg',
    parentRecipeItemId: partial.parentRecipeItemId ?? null,
    costPerUnit: partial.costPerUnit,
  }
}

describe('OPS-9 effectiveRawQty', () => {
  test('yield 100 je identiteta (nazajkompatibilnost z obstoječimi vrsticami)', () => {
    expect(effectiveRawQty(0.4, 100)).toBe(0.4)
    expect(effectiveRawQty(1.5, 100)).toBe(1.5)
    expect(effectiveRawQty(0, 100)).toBe(0)
  })

  test('yield 80 → neto / 0.8 (r3)', () => {
    expect(effectiveRawQty(0.4, 80)).toBe(0.5) // 0.4 / 0.8 = 0.5
    expect(effectiveRawQty(1, 80)).toBe(1.25) // 1 / 0.8 = 1.25
    expect(effectiveRawQty(0.333, 90)).toBe(0.37) // 0.333 / 0.9 = 0.37 → r3
  })

  test('neveljaven yield (0, negativen, > 100, NaN) → obravnava kot 100', () => {
    expect(effectiveRawQty(0.4, 0)).toBe(0.4)
    expect(effectiveRawQty(0.4, -25)).toBe(0.4)
    expect(effectiveRawQty(0.4, 150)).toBe(0.4) // clamp to (0, 100]
    expect(effectiveRawQty(0.4, Number.NaN)).toBe(0.4)
    expect(effectiveRawQty(Number.NaN, 80)).toBe(0) // non-finite net -> 0
  })
})

describe('OPS-9 recipeCost', () => {
  test('ravna receptura: Σ efektivna surovina × costPerUnit', () => {
    const items = [
      nd({ inventoryItemId: 'flour', quantityPerServing: 1.5, costPerUnit: 2 }),
      nd({ inventoryItemId: 'salt', quantityPerServing: 0.5, costPerUnit: 1.5 }),
    ]
    const { cost, costKnown } = recipeCost(items, 'mi1')
    expect(cost).toBe(3.75) // 1.5*2 + 0.5*1.5
    expect(costKnown).toBe(true)
  })

  test('z otroki: starš in otroci oba prispevata (surovina na vsaki ravni)', () => {
    // Dough (parent, 0.5 kg @ 10) + children: flour 0.45 kg @ 2, water 0.3 kg @ 0.01
    const dough = nd({ id: 'dough', inventoryItemId: 'dough-inv', quantityPerServing: 0.5, costPerUnit: 10 })
    const items = [
      dough,
      nd({ inventoryItemId: 'flour', quantityPerServing: 0.45, costPerUnit: 2, parentRecipeItemId: 'dough' }),
      nd({ inventoryItemId: 'water', quantityPerServing: 0.3, costPerUnit: 0.01, parentRecipeItemId: 'dough' }),
    ]
    const { cost } = recipeCost(items, 'mi1')
    // 0.5*10 + 0.45*2 + 0.3*0.01 = 5 + 0.9 + 0.003 = 5.903 -> r2 = 5.9
    expect(cost).toBe(5.9)
  })

  test('yield v pod-recepturi: otrok 0.4 @ 80 % stane 0.5 × cost', () => {
    const dough = nd({ id: 'dough', inventoryItemId: 'dough-inv', quantityPerServing: 0.5, costPerUnit: 10 })
    const items = [
      dough,
      nd({ inventoryItemId: 'flour', quantityPerServing: 0.4, yieldPercent: 80, costPerUnit: 2, parentRecipeItemId: 'dough' }),
    ]
    const { cost } = recipeCost(items, 'mi1')
    expect(cost).toBe(6) // 5 + (0.4/0.8)*2 = 5 + 1
  })

  test('cikel (A↔B) se zaključi vsak vozel šteje natanko enkrat', () => {
    const items = [
      nd({ id: 'a', inventoryItemId: 'inv-a', quantityPerServing: 1, costPerUnit: 3, parentRecipeItemId: 'b' }),
      nd({ id: 'b', inventoryItemId: 'inv-b', quantityPerServing: 2, costPerUnit: 5, parentRecipeItemId: 'a' }),
    ]
    const { cost } = recipeCost(items, 'mi1') // must terminate
    expect(cost).toBe(13) // 1*3 + 2*5, no double counting, no hang
  })

  test('manjkajoč costPerUnit → prispeva 0, costKnown=false', () => {
    const items = [
      nd({ inventoryItemId: 'known', quantityPerServing: 2, costPerUnit: 4 }),
      nd({ inventoryItemId: 'unknown', quantityPerServing: 1 }), // no costPerUnit
    ]
    const { cost, costKnown } = recipeCost(items, 'mi1')
    expect(cost).toBe(8)
    expect(costKnown).toBe(false)
  })

  test('viseči parent (vrstica drugega artikla / manjkajoča) → vrstica ostane vrhnja in se šteje', () => {
    const items = [
      nd({ inventoryItemId: 'flour', quantityPerServing: 1, costPerUnit: 2, parentRecipeItemId: 'ghost-row' }),
    ]
    const { cost, costKnown } = recipeCost(items, 'mi1')
    expect(cost).toBe(2)
    expect(costKnown).toBe(true)
  })

  test('samo vrstice zaposlenega artikla se štejejo (menuItemId filter)', () => {
    const items = [
      nd({ inventoryItemId: 'a', quantityPerServing: 1, costPerUnit: 5 }),
      nd({ menuItemId: 'mi2', inventoryItemId: 'b', quantityPerServing: 99, costPerUnit: 1 }),
    ]
    expect(recipeCost(items, 'mi1').cost).toBe(5)
    expect(recipeCost(items, 'mi2').cost).toBe(99)
  })
})

describe('OPS-9 flattenDeduction', () => {
  test('multiplikator porcij', () => {
    const items = [nd({ inventoryItemId: 'flour', quantityPerServing: 0.5, costPerUnit: 2 })]
    const map = flattenDeduction(items, 'mi1', 3)
    expect(map.get('flour')).toBe(1.5)
  })

  test('yield 80: odjem surovine = neto / 0.8 × porcije', () => {
    const items = [nd({ inventoryItemId: 'flour', quantityPerServing: 0.4, yieldPercent: 80 })]
    const map = flattenDeduction(items, 'mi1', 2)
    expect(map.get('flour')).toBe(1) // (0.4/0.8) * 2
  })

  test('dedupe: ista sestavina v več vozliščih se sešteje', () => {
    // Defensive path (schema unique constraint normally prevents this): two roots
    // referencing the same inventory item must SUM, not overwrite.
    const items = [
      nd({ inventoryItemId: 'flour', quantityPerServing: 0.25 }),
      nd({ inventoryItemId: 'flour', quantityPerServing: 0.5 }),
    ]
    const map = flattenDeduction(items, 'mi1', 1)
    expect(map.size).toBe(1)
    expect(map.get('flour')).toBe(0.75)
  })

  test('pod-recepture: starš + otroci oba odšteta, × porcije', () => {
    const dough = nd({ id: 'dough', inventoryItemId: 'dough-inv', quantityPerServing: 0.5 })
    const items = [
      dough,
      nd({ inventoryItemId: 'flour', quantityPerServing: 0.45, parentRecipeItemId: 'dough' }),
    ]
    const map = flattenDeduction(items, 'mi1', 2)
    expect(map.get('dough-inv')).toBe(1) // 0.5 * 2
    expect(map.get('flour')).toBe(0.9) // 0.45 * 2
  })

  test('NAZAJKOMPATIBILNOST: yield=100 brez otrok = stara ravna matematika', () => {
    // Legacy shape: flat lines, default yield — flattenDeduction must produce exactly
    // what deductStockForOrderTx computed before OPS-9: r3(qty * portions) per line.
    const items = [
      nd({ inventoryItemId: 'A', quantityPerServing: 1.5 }),
      nd({ inventoryItemId: 'B', quantityPerServing: 0.5 }),
      nd({ inventoryItemId: 'C', quantityPerServing: 0.333 }),
    ]
    const portions = 4
    const legacy = new Map<string, number>([
      ['A', Math.round(1.5 * portions * 1000) / 1000],
      ['B', Math.round(0.5 * portions * 1000) / 1000],
      ['C', Math.round(0.333 * portions * 1000) / 1000],
    ])
    const map = flattenDeduction(items, 'mi1', portions)
    expect(map.size).toBe(legacy.size)
    for (const [k, v] of legacy) expect(map.get(k)).toBe(v)
  })

  test('cikel (A↔B) se zaključi vsak vozel šteje natanko enkrat × porcije', () => {
    const items = [
      nd({ id: 'a', inventoryItemId: 'inv-a', quantityPerServing: 1, parentRecipeItemId: 'b' }),
      nd({ id: 'b', inventoryItemId: 'inv-b', quantityPerServing: 2, parentRecipeItemId: 'a' }),
    ]
    const map = flattenDeduction(items, 'mi1', 3) // must terminate
    expect(map.get('inv-a')).toBe(3)
    expect(map.get('inv-b')).toBe(6)
  })

  test('mešani artikli: flattenDeduction filtrira po menuItemId', () => {
    const items = [
      nd({ inventoryItemId: 'a', quantityPerServing: 1 }),
      nd({ menuItemId: 'mi2', inventoryItemId: 'b', quantityPerServing: 99 }),
    ]
    const m1 = flattenDeduction(items, 'mi1', 2)
    const m2 = flattenDeduction(items, 'mi2', 1)
    expect(m1.size).toBe(1)
    expect(m1.get('a')).toBe(2)
    expect(m2.get('b')).toBe(99)
  })
})
