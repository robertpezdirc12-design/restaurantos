/**
 * OPS-10 val 3 (v1.79.0) — BatchPreparation pure math (no db imports).
 *
 * A batch preparation produces an output inventory item from its recipe BOM:
 *  - the BOM kernel (src/lib/recipe-cost.ts flattenDeduction) yields per-portion
 *    RAW quantities per inventory item;
 *  - scaleBatchLines multiplies them by the planned output quantity;
 *  - forecastQty predicts how much to prep from the average of the last N same
 *    weekday sales totals (ceil — always round UP, never under-prep);
 *  - batchCostPerUnit spreads the total input cost over the produced units.
 */

/** One BOM line per ONE output unit (portion) — from flattenDeduction. */
export interface BatchLine {
  inventoryItemId: string
  qty: number
}

/** All batch lifecycle states (schema default 'DRAFT'; freeform String column). */
export const BATCH_STATUSES = ['DRAFT', 'COMPLETED', 'CANCELLED'] as const

/** Round to 3 decimals (same convention as recipe-cost.ts / inventory.ts). */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Round to 4 decimals (unit cost precision for batch outputs). */
function r4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * Scale per-portion BOM lines by the planned output quantity:
 *  - qty × plannedQty, rounded to 3 decimals;
 *  - lines that round down to 0 are REMOVED;
 *  - invalid plannedQty (non-finite / ≤ 0) yields an empty list;
 *  - the input is never mutated; dedupe by inventoryItemId sums defensively.
 */
export function scaleBatchLines(lines: BatchLine[], plannedQty: number): BatchLine[] {
  const p = Number(plannedQty)
  if (!Number.isFinite(p) || p <= 0) return []
  const out = new Map<string, number>()
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || typeof l !== 'object' || !l.inventoryItemId) continue
    const q = r3(Number(l.qty) * p)
    if (!(q > 0)) continue
    out.set(l.inventoryItemId, r3((out.get(l.inventoryItemId) || 0) + q))
  }
  return [...out.entries()].map(([inventoryItemId, qty]) => ({ inventoryItemId, qty }))
}

/**
 * Production forecast from the totals of the last N SAME weekdays:
 * ceil(average), minimum 0; an empty/invalid list → 0. Ceil (never floor) —
 * under-prepping loses sales, over-prepping only costs shelf space.
 */
export function forecastQty(sameWeekdayTotals: number[]): number {
  const list = Array.isArray(sameWeekdayTotals) ? sameWeekdayTotals : []
  if (list.length === 0) return 0
  const nums = list.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
  if (nums.length === 0) return 0
  const avg = nums.reduce((s, v) => s + v, 0) / nums.length
  return Math.max(0, Math.ceil(avg))
}

/**
 * Output unit cost: totalInputCost / outputQuantity, rounded to 4 decimals.
 * Either argument non-finite or ≤ 0 → 0 (never NaN, never negative).
 */
export function batchCostPerUnit(totalInputCost: number, outputQuantity: number): number {
  const c = Number(totalInputCost)
  const q = Number(outputQuantity)
  if (!Number.isFinite(c) || !Number.isFinite(q) || c <= 0 || q <= 0) return 0
  return r4(c / q)
}
