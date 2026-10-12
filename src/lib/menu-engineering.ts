/**
 * Menu engineering math (Kasavana-Smith) — pure functions, no DB imports.
 *
 * OPS-8 wave 1 (v1.71.0). Kept dependency-free so unit tests cover the math
 * directly; the API route (src/app/api/menu-engineering) stays thin and only
 * fetches rows, then feeds them into `buildMenuEngineering`.
 *
 * Model notes:
 * - Cost per serving = sum of DIRECT RecipeItem rows (parentRecipeItemId == null)
 *   times InventoryItem.costPerUnit. Sub-recipes (RecipeItem.parentRecipeItemId
 *   self-relation) are IGNORED for v1 — their components would double-count the
 *   parent row; note kept for a future wave together with yieldPercent handling
 *   (deductStockForOrderTx also ignores yieldPercent today, so costs stay consistent).
 * - Fallback: InventoryItem.costPerServing of the inventory row linked to the
 *   menu item via InventoryItem.menuItemId (unique per location) when > 0.
 * - Popularity thresholds and CM thresholds are computed WITHIN each category
 *   (Kasavana-Smith: popularity = share of category unit sales, so the average
 *   must be per category, never global).
 */

export type Quadrant = 'stars' | 'plowhorses' | 'puzzles' | 'dogs' | 'unknown'

/** Raw per-item input (aggregated sales + cost). All money values in EUR. */
export interface MeItemInput {
  id: string
  name: string
  category: string
  price: number
  qtySold: number
  revenue: number
  cost: number
  costKnown: boolean
}

export interface MeCategoryThresholds {
  name: string
  qtyThreshold: number
  cmThreshold: number
}

export interface MeItemResult {
  id: string
  name: string
  category: string
  price: number
  qtySold: number
  revenue: number
  cost: number
  costKnown: boolean
  cm: number
  foodCostPct: number
  popShare: number
  quadrant: Quadrant
}

export interface MeOutput {
  categories: MeCategoryThresholds[]
  items: MeItemResult[]
}

/** CM (contribution margin) = price - cost. */
export function contributionMargin(price: number, cost: number): number {
  return price - cost
}

/** Food cost percentage = cost / price * 100 (price 0 -> 0 to avoid div by zero). */
export function foodCostPct(price: number, cost: number): number {
  if (price <= 0) return 0
  return (cost / price) * 100
}

/**
 * Kasavana-Smith quadrant classification against per-category thresholds.
 * >= threshold counts as high popularity / high CM (boundary belongs to the
 * high side, matching the standard literature definition).
 */
export function classifyQuadrant(
  qtySold: number,
  cm: number,
  qtyThreshold: number,
  cmThreshold: number
): Quadrant {
  const highPop = qtySold >= qtyThreshold
  const highCm = cm >= cmThreshold
  if (highPop && highCm) return 'stars'
  if (highPop && !highCm) return 'plowhorses'
  if (!highPop && highCm) return 'puzzles'
  return 'dogs'
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Compute per-category thresholds:
 * - qtyThreshold = mean qtySold of ALL items in the category,
 * - cmThreshold  = mean CM of costKnown items only (unknown-cost items cannot
 *   contribute a CM and are excluded from quadrant math entirely).
 */
export function computeThresholds(items: MeItemInput[]): MeCategoryThresholds[] {
  const byCat = new Map<string, MeItemInput[]>()
  for (const it of items) {
    const arr = byCat.get(it.category)
    if (arr) arr.push(it)
    else byCat.set(it.category, [it])
  }
  const out: MeCategoryThresholds[] = []
  for (const [name, arr] of byCat) {
    const qtyTotal = arr.reduce((s, it) => s + it.qtySold, 0)
    const qtyThreshold = arr.length > 0 ? qtyTotal / arr.length : 0
    const known = arr.filter((it) => it.costKnown)
    const cmThreshold =
      known.length > 0 ? known.reduce((s, it) => s + contributionMargin(it.price, it.cost), 0) / known.length : 0
    out.push({ name, qtyThreshold: r2(qtyThreshold), cmThreshold: r2(cmThreshold) })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * Full pipeline: thresholds per category -> popularity share (within category)
 * -> quadrant classification -> rounded response rows.
 * Items with costKnown=false keep quadrant='unknown' (listed in the table,
 * excluded from scatter + threshold calc by the caller's rendering choice).
 */
export function buildMenuEngineering(items: MeItemInput[]): MeOutput {
  const thresholds = computeThresholds(items)
  const thrByCat = new Map(thresholds.map((t) => [t.name, t]))

  const catQtyTotal = new Map<string, number>()
  for (const it of items) catQtyTotal.set(it.category, (catQtyTotal.get(it.category) || 0) + it.qtySold)

  const outItems: MeItemResult[] = items.map((it) => {
    const thr = thrByCat.get(it.category)
    const cm = contributionMargin(it.price, it.cost)
    const catTotal = catQtyTotal.get(it.category) || 0
    const popShare = catTotal > 0 ? (it.qtySold / catTotal) * 100 : 0
    const quadrant =
      it.costKnown && thr ? classifyQuadrant(it.qtySold, cm, thr.qtyThreshold, thr.cmThreshold) : 'unknown'
    return {
      id: it.id,
      name: it.name,
      category: it.category,
      price: r2(it.price),
      qtySold: it.qtySold,
      revenue: r2(it.revenue),
      cost: r2(it.cost),
      costKnown: it.costKnown,
      cm: r2(cm),
      foodCostPct: r2(foodCostPct(it.price, it.cost)),
      popShare: r2(popShare),
      quadrant,
    }
  })

  outItems.sort((a, b) => a.category.localeCompare(b.category) || b.qtySold - a.qtySold || a.name.localeCompare(b.name))
  return { categories: thresholds, items: outItems }
}

/**
 * Direct recipe cost per serving from joined rows. Rows with a
 * parentRecipeItemId (sub-recipe components) are ignored for v1.
 */
export function recipeCostFromRows(
  rows: { quantityPerServing: number | string; parentRecipeItemId?: string | null; costPerUnit: number | string }[]
): number {
  let sum = 0
  for (const r of rows) {
    if (r.parentRecipeItemId) continue
    sum += Number(r.quantityPerServing) * Number(r.costPerUnit)
  }
  return sum
}
