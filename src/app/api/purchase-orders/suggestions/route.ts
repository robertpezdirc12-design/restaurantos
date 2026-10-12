import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import {
  buildSuggestion, groupSuggestionsBySupplier, OPEN_PO_STATUSES,
  type ReorderItem, type ReorderSuggestion,
} from '@/lib/reorder'

/**
 * OPS-8 val 2 (v1.72.0) — Predlogi naročil (reorder suggestions).
 *
 * GET /api/purchase-orders/suggestions
 *   → { suggestions: [{ itemId, itemName, qty, par, incoming, suggested,
 *        supplierId, supplierName, costEstimate }],
 *       groupedBySupplier: [{ supplierId, supplierName, items, total }] }
 *
 * Rules: PAR = reorderPoint || minQuantity (> 0); an item is a candidate when
 * qty <= PAR; incoming = Σ (ordered − received) over open orders
 * (submitted/approved/partial); suggested = PAR − qty − incoming (> 0).
 * Supplier: SupplierItem catalog (cheapest active), else legacy
 * InventoryItem.supplier string match against Supplier.name.
 * Permission: requireAuth (same as GET /api/purchase-orders — read for all).
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const items = await db.inventoryItem.findMany({
    where: await locationScope(user),
    orderBy: { name: 'asc' },
    take: 500,
  })

  // threshold candidates (PAR = reorderPoint || minQuantity)
  const candidates = items.filter((i) => {
    const rp = num(i.reorderPoint)
    const mq = num(i.minQuantity)
    const par = rp > 0 ? rp : mq
    return par > 0 && num(i.quantity) <= par
  })
  if (candidates.length === 0) return ok({ suggestions: [], groupedBySupplier: [] })

  const ids = candidates.map((i) => i.id)

  // inflow over open orders (submitted/approved/partial)
  const openLines = await db.purchaseOrderItem.findMany({
    where: { inventoryItemId: { in: ids }, PurchaseOrder: { status: { in: [...OPEN_PO_STATUSES] } } },
    select: { inventoryItemId: true, quantityOrdered: true, quantityReceived: true },
  })
  const incomingByItem = new Map<string, number>()
  for (const l of openLines) {
    if (!l.inventoryItemId) continue
    const remaining = Math.max(0, num(l.quantityOrdered) - num(l.quantityReceived))
    if (remaining <= 0) continue
    incomingByItem.set(l.inventoryItemId, (incomingByItem.get(l.inventoryItemId) || 0) + remaining)
  }

  // supplier catalog: cheapest active SupplierItem per item
  const catalog = await db.supplierItem.findMany({
    where: { inventoryItemId: { in: ids }, isActive: true },
    include: { Supplier: { select: { id: true, name: true, isActive: true } } },
  })
  const cheapestByItem = new Map<string, { price: number; supplierId: string; supplierName: string }>()
  for (const c of catalog) {
    if (!c.Supplier?.isActive) continue
    const price = num(c.pricePerPack)
    const prev = cheapestByItem.get(c.inventoryItemId)
    if (!prev || price < prev.price) {
      cheapestByItem.set(c.inventoryItemId, { price, supplierId: c.Supplier.id, supplierName: c.Supplier.name })
    }
  }

  // legacy fallback: InventoryItem.supplier string ↔ Supplier.name
  const suppliers = await db.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true } })
  const supplierByName = new Map(suppliers.map((s) => [s.name.trim().toLowerCase(), { supplierId: s.id, supplierName: s.name }]))

  const suggestions: ReorderSuggestion[] = []
  for (const i of candidates) {
    const row: ReorderItem = {
      itemId: i.id,
      name: i.name,
      unit: i.unit,
      qty: num(i.quantity),
      minQty: num(i.minQuantity),
      reorderPoint: num(i.reorderPoint),
      costPerUnit: num(i.costPerUnit),
    }
    const cat = cheapestByItem.get(i.id)
    const legacy = !cat && i.supplier ? supplierByName.get(String(i.supplier).trim().toLowerCase()) : undefined
    const supplier = cat || legacy || null
    const s = buildSuggestion(row, incomingByItem.get(i.id) || 0, supplier)
    if (s) suggestions.push(s)
  }

  return ok({ suggestions, groupedBySupplier: groupSuggestionsBySupplier(suggestions) })
}
