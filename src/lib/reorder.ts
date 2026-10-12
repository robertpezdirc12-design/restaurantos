/**
 * OPS-8 val 2 (v1.72.0) — Predlogi naročil (reorder suggestions, Lightspeed vzorec).
 *
 * Math (pure, no DB — unit-tested):
 *   PAR (par level)   = reorderPoint > 0 ? reorderPoint : minQuantity   (0 = no suggestion)
 *   crosses threshold = qty <= PAR (and PAR > 0)
 *   incoming          = Σ (quantityOrdered − quantityReceived) over OPEN purchase orders
 *                       (status submitted | approved | partial)
 *   suggested         = PAR − qty − incoming  (> 0, otherwise skip the item —
 *                       open orders already cover the shortfall)
 *   costEstimate      = suggested × costPerUnit (estimate; supplier pack pricing
 *                       may differ — informational)
 * Grouped by supplier → one "Create PO" button per supplier in the UI.
 */

const r3 = (n: number) => Math.round(n * 1000) / 1000
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Purchase order statuses still expecting a receipt (inflow). */
export const OPEN_PO_STATUSES = ['submitted', 'approved', 'partial'] as const

export interface ReorderItem {
  itemId: string
  name: string
  unit: string
  qty: number
  minQty: number
  reorderPoint: number
  costPerUnit: number
}

/** Item PAR level (reorderPoint takes precedence over minQuantity; 0 = unmonitored). */
export function parLevel(item: Pick<ReorderItem, 'minQty' | 'reorderPoint'>): number {
  const rp = item.reorderPoint
  if (rp > 0) return r3(rp)
  const mq = item.minQty
  return mq > 0 ? r3(mq) : 0
}

/** Suggested quantity (PAR − stock − incoming); <= 0 → not a suggestion. */
export function suggestedQty(par: number, qty: number, incoming: number): number {
  return r3(par - r3(qty) - r3(incoming))
}

export interface ReorderSuggestion {
  itemId: string
  itemName: string
  unit: string
  qty: number
  par: number
  incoming: number
  suggested: number
  supplierId: string | null
  supplierName: string
  costEstimate: number
}

export interface ReorderSupplierGroup {
  supplierId: string | null
  supplierName: string
  items: ReorderSuggestion[]
  total: number
}

/** Build a suggestion for one item (or null: above threshold / incoming covers it). */
export function buildSuggestion(
  item: ReorderItem,
  incoming: number,
  supplier: { supplierId: string | null; supplierName: string } | null,
): ReorderSuggestion | null {
  const par = parLevel(item)
  if (par <= 0) return null
  if (r3(item.qty) > par) return null // nad pragom — nič ne manjka
  const suggested = suggestedQty(par, item.qty, incoming)
  if (suggested <= 0) return null // odprta naročila že pokrijejo primanjkljaj
  return {
    itemId: item.itemId,
    itemName: item.name,
    unit: item.unit,
    qty: r3(item.qty),
    par,
    incoming: r3(incoming),
    suggested,
    supplierId: supplier?.supplierId ?? null,
    supplierName: supplier?.supplierName ?? '',
    costEstimate: r2(suggested * item.costPerUnit),
  }
}

/** Group by supplier (unresolved supplier → a shared null-supplier group). */
export function groupSuggestionsBySupplier(suggestions: ReorderSuggestion[]): ReorderSupplierGroup[] {
  const map = new Map<string, ReorderSupplierGroup>()
  for (const s of suggestions) {
    const key = s.supplierId || `__none__:${s.supplierName}`
    let g = map.get(key)
    if (!g) {
      g = { supplierId: s.supplierId, supplierName: s.supplierName, items: [], total: 0 }
      map.set(key, g)
    }
    g.items.push(s)
    g.total = r2(g.total + s.costEstimate)
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}
