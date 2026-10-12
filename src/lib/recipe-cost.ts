/**
 * Recipe BOM cost & deduction math — PURE (no db imports; data passed in, unit-testable).
 *
 * OPS-9 val 1 "recepture BOM maturity": makes the recipe model complete by using the
 * two previously unused RecipeItem columns:
 *  - yieldPercent  (Decimal 5,2, default 100): net quantityPerServing is the NET output,
 *    the raw inventory consumption is net / (yield/100).
 *  - parentRecipeItemId (self-relation "RecipeItemToRecipeItem"): a row may be a
 *    sub-recipe node — children (rows whose parentRecipeItemId === node.id) hang under it.
 *
 * Consumption semantics: EVERY node references an InventoryItem, so both leaves and
 * parents consume raw stock (a parent row is itself an inventory item, e.g. prepped
 * dough; its children decompose it). Cost and deduction therefore walk the whole tree.
 *
 * NOTE on the schema unique constraint @@unique(menuItemId, inventoryItemId): within one
 * menu item an inventory item can appear at most once (as parent OR child) — a child with
 * the same (menuItemId, inventoryItemId) as its parent row would violate the constraint.
 * The helpers below still dedupe/sum defensively so legacy or dirty data never explodes.
 *
 * Rounding convention: r3 (3 decimals), same style as the local r3 helper in
 * src/lib/inventory.ts (quantityPerServing is Decimal(12,3), so r3 is lossless for
 * stored quantities and keeps backward-compatible results bit-for-bit).
 */

export interface RecipeNode {
  id: string
  menuItemId: string
  inventoryItemId: string
  inventoryName?: string
  /** Net quantity per one sold serving (as stored in RecipeItem.quantityPerServing). */
  quantityPerServing: number
  /** Yield percent in (0, 100]; anything else is treated as 100 (see effectiveRawQty). */
  yieldPercent: number
  unit: string
  /** Parent row id (sub-recipe link) or null for top-level lines. */
  parentRecipeItemId: string | null
  /** Unit cost of the referenced inventory item; undefined = cost unknown. */
  costPerUnit?: number
}

/** Round to 3 decimals (same convention as src/lib/inventory.ts r3). */
export function r3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Round to 2 decimals (money, same convention as src/lib/inventory.ts r2). */
export function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Effective RAW quantity for one serving: quantityPerServing / (yieldPercent / 100).
 * yieldPercent is clamped to the valid domain (0, 100]; 0, negative, > 100 or
 * non-finite values are treated as 100 (identity — backward compatible with rows
 * that never set the column).
 */
export function effectiveRawQty(quantityPerServing: number, yieldPercent: number): number {
  const net = Number.isFinite(quantityPerServing) ? quantityPerServing : 0
  const y = Number(yieldPercent)
  const valid = Number.isFinite(y) && y > 0 && y <= 100
  const pct = valid ? y : 100
  return r3(net / (pct / 100))
}

/** Children index: parent row id -> child nodes (only rows whose parent is present). */
function childrenMap(nodes: RecipeNode[]): Map<string, RecipeNode[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const map = new Map<string, RecipeNode[]>()
  for (const n of nodes) {
    if (!n.parentRecipeItemId || !byId.has(n.parentRecipeItemId)) continue
    const list = map.get(n.parentRecipeItemId) || []
    list.push(n)
    map.set(n.parentRecipeItemId, list)
  }
  return map
}

/**
 * Top-level nodes: no parent, or a dangling parent (parent id not present in the
 * given set — defensive: legacy/cross-menu reference must not silently drop rows).
 */
function rootNodes(nodes: RecipeNode[]): RecipeNode[] {
  const byId = new Set(nodes.map((n) => n.id))
  return nodes.filter((n) => !n.parentRecipeItemId || !byId.has(n.parentRecipeItemId))
}

/** Filter to one menu item's rows and normalize numeric fields. */
function nodesForMenuItem(items: RecipeNode[], menuItemId: string): RecipeNode[] {
  return items.filter((n) => n.menuItemId === menuItemId)
}

/**
 * Full recursive recipe cost for one menu item (per single serving).
 *
 * cost = SUM over all reachable nodes (roots + descendants) of
 *        effectiveRawQty(node) * (node.costPerUnit ?? 0)
 *
 * - A node with children contributes its own raw consumption PLUS its children's
 *   subtrees (children consume raw quantities at every level).
 * - CYCLE GUARD: a visited set of node ids stops descending any branch that loops
 *   back — the looping node's own contribution is counted once, then descent stops.
 * - Missing costPerUnit (undefined) contributes 0 and flips costKnown=false so the
 *   caller can decide the fallback (e.g. menu-item legacy cost or "unknown").
 */
export function recipeCost(
  items: RecipeNode[],
  menuItemId: string
): { cost: number; costKnown: boolean } {
  const nodes = nodesForMenuItem(items, menuItemId)
  const childrenOf = childrenMap(nodes)
  const visited = new Set<string>()
  let cost = 0
  let costKnown = true

  const visit = (node: RecipeNode): void => {
    // Cycle guard: if this node was already consumed higher up the branch,
    // stop descending (count it exactly once overall).
    if (visited.has(node.id)) return
    visited.add(node.id)
    if (node.costPerUnit === undefined || node.costPerUnit === null || !Number.isFinite(node.costPerUnit)) {
      costKnown = false
    } else {
      cost += effectiveRawQty(node.quantityPerServing, node.yieldPercent) * node.costPerUnit
    }
    for (const child of childrenOf.get(node.id) || []) visit(child)
  }

  // Roots first, then any node still unvisited (pure cycles / orphans) as its own
  // fallback root — every node is counted at most once and recursion terminates.
  for (const node of rootNodes(nodes)) visit(node)
  for (const node of nodes) visit(node)

  return { cost: r2(cost), costKnown }
}

/**
 * Flatten one menu item's recipe tree into total RAW quantities per inventory item
 * for `portions` sold servings — the deduction map.
 *
 * totalRaw(inventoryItemId) = SUM over all tree nodes referencing it of
 *                             effectiveRawQty(node) * portions   (deduped, r3)
 *
 * - Deduction consumes RAW quantities at every level (leaves and parents both,
 *   since each node references an inventory item).
 * - Dedupe by inventoryItemId (sums); within one menu item the schema unique
 *   constraint already prevents duplicates, this is defensive.
 * - CYCLE GUARD: same visited-set semantics as recipeCost — a looping branch is
 *   descended only once, so results stay finite and deterministic.
 */
export function flattenDeduction(
  items: RecipeNode[],
  menuItemId: string,
  portions: number
): Map<string, number> {
  const nodes = nodesForMenuItem(items, menuItemId)
  const childrenOf = childrenMap(nodes)
  const visited = new Set<string>()
  const totals = new Map<string, number>()

  const visit = (node: RecipeNode): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    const raw = effectiveRawQty(node.quantityPerServing, node.yieldPercent) * portions
    if (raw > 0) totals.set(node.inventoryItemId, r3((totals.get(node.inventoryItemId) || 0) + raw))
    for (const child of childrenOf.get(node.id) || []) visit(child)
  }

  for (const node of rootNodes(nodes)) visit(node)
  for (const node of nodes) visit(node)

  return totals
}
