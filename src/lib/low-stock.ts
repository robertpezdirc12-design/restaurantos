/**
 * OPS-8 val 2 (v1.72.0) — Nizka zaloga opozorila (RoxPos pattern).
 *
 * After stock deduction (deductStockForOrderTx in /api/furs) receives new item
 * quantities and sends ONE grouped push for all items that crossed the threshold
 * for the first time (newQty <= reorderPoint || minQuantity). State (last alert per
 * item) lives in an Integration row (name='low-stock-state', type='other') config JSON:
 *   { "itemId": "2026-02-10T12:00:00.000Z", ... }
 *
 * RE-ARM rule: re-alert an item ONLY if an inflow arrived since the last alert —
 * a StockTransaction with POSITIVE quantity for that item (covers types 'purchase'
 * (GRN), 'RECEIVE' (manual receipt), 'STOCKTAKE' (positive count), 'ADJUST'
 * (positive correction), 'STORNO_RETURN' (return on receipt storno)).
 *
 * Sending goes through pushEvent('LOW_STOCK', ...) → the notification matrix applies
 * (base target: warehouse + management). Helper is fire-and-forget and NEVER throws —
 * the caller invokes it as `void maybeNotifyLowStock(...)` AFTER the tx commit.
 */
import { db } from '@/lib/db'
import { num, jparse } from '@/lib/map'
import { pushEvent } from '@/lib/push'

export const LOW_STOCK_STATE_MARKER = 'low-stock-state'

export interface LowStockDeduction {
  inventoryItemId: string
  name: string
  newQty: number
}

export interface LowStockStateConfig {
  [itemId: string]: string // lastAlertedAt ISO
}

/** Item threshold: reorderPoint when set (> 0), otherwise minQuantity. */
export function lowStockThreshold(reorderPoint: unknown, minQuantity: unknown): number {
  const rp = num(reorderPoint)
  if (rp > 0) return rp
  const mq = num(minQuantity)
  return mq > 0 ? mq : 0
}

/** Pure: is the item below the threshold at this quantity (threshold 0 = no alerts). */
export function isBelowLowStock(newQty: number, threshold: number): boolean {
  return threshold > 0 && newQty <= threshold
}

/** Pure: alert decision — no prior alert → send; with prior alert → only on re-arm (inflow). */
export function shouldSendLowStockAlert(lastAlertedAt: string | undefined, inflowSinceAlert: boolean): boolean {
  if (!lastAlertedAt) return true
  return inflowSinceAlert
}

/** Join item names for ONE grouped notification (RoxPos: max 5 + ellipsis). */
export function lowStockBody(names: string[]): string {
  const shown = names.slice(0, 5).join(', ')
  const rest = names.length - 5
  return rest > 0 ? `${shown} … (+${rest})` : shown
}

async function readState(): Promise<LowStockStateConfig> {
  const row = await db.integration.findFirst({ where: { name: LOW_STOCK_STATE_MARKER, type: 'other' } })
  if (!row) return {}
  const cfg = jparse<LowStockStateConfig>(row.config, {})
  return cfg && typeof cfg === 'object' ? cfg : {}
}

async function writeState(state: LowStockStateConfig): Promise<void> {
  const config = JSON.stringify(state)
  const row = await db.integration.findFirst({ where: { name: LOW_STOCK_STATE_MARKER, type: 'other' } })
  if (row) {
    await db.integration.update({ where: { id: row.id }, data: { config } })
  } else {
    await db.integration.create({
      data: {
        id: `low-stock-state-${Date.now().toString(36)}`,
        name: LOW_STOCK_STATE_MARKER,
        type: 'other',
        provider: 'internal',
        config,
        isActive: true,
        syncEnabled: false,
      },
    })
  }
}

/**
 * Check deducted items and send ONE grouped low-stock push when needed.
 * Call AFTER the tx commit (fire-and-forget: `void maybeNotifyLowStock(stock.deductions)`).
 */
export async function maybeNotifyLowStock(deductions: LowStockDeduction[]): Promise<void> {
  try {
    if (!Array.isArray(deductions) || deductions.length === 0) return

    const ids = [...new Set(deductions.map((d) => d.inventoryItemId).filter(Boolean))]
    if (ids.length === 0) return

    const items = await db.inventoryItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, unit: true, quantity: true, minQuantity: true, reorderPoint: true },
    })
    const itemById = new Map(items.map((i) => [i.id, i]))

    const state = await readState()
    const nowIso = new Date().toISOString()
    const crossed: { itemId: string; label: string }[] = []

    for (const d of deductions) {
      const item = itemById.get(d.inventoryItemId)
      if (!item) continue
      const threshold = lowStockThreshold(item.reorderPoint, item.minQuantity)
      // r3 tolerance — float drift (22.000000005) must not trigger a false alarm
      if (!isBelowLowStock(Math.round(d.newQty * 1000) / 1000, threshold)) continue
      const lastAlertedAt = state[d.inventoryItemId]
      let inflowSinceAlert = false
      if (lastAlertedAt) {
        const t = new Date(lastAlertedAt)
        if (isNaN(t.getTime())) {
          inflowSinceAlert = false
        } else {
          const inflow = await db.stockTransaction.count({
            where: { inventoryItemId: d.inventoryItemId, quantity: { gt: 0 }, createdAt: { gt: t } },
          })
          inflowSinceAlert = inflow > 0
        }
      }
      if (!shouldSendLowStockAlert(lastAlertedAt, inflowSinceAlert)) continue
      crossed.push({ itemId: d.inventoryItemId, label: `${item.name} (${Math.round(d.newQty * 1000) / 1000} ${item.unit})` })
    }

    if (crossed.length === 0) return

    await pushEvent('LOW_STOCK', {
      title: 'Nizka zaloga',
      body: lowStockBody(crossed.map((c) => c.label)),
      url: '/dashboard?tab=zaloge',
      tag: 'low-stock',
    }, { roles: ['warehouse', 'manager'] })

    // Update state for all crossed items (even when the matrix filters the push out —
    // the event is "handled"; re-arm arrives with a new inflow).
    const nextState: LowStockStateConfig = { ...state }
    for (const c of crossed) nextState[c.itemId] = nowIso
    await writeState(nextState)
  } catch (e) {
    // low-stock alerting MUST NEVER affect the fiscal flow
    console.warn('[low-stock] maybeNotifyLowStock failed (ignored):', (e as Error).message)
  }
}
