import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import { buildMenuEngineering, recipeCostFromRows, type MeItemInput } from '@/lib/menu-engineering'

const ALLOWED_DAYS = [30, 60, 90] as const

/**
 * Clamp the `days` query parameter onto the allowed set 30|60|90 (default 30).
 * Any numeric input is snapped to the nearest allowed value; non-numeric -> 30.
 */
export function clampDays(raw: string | null): number {
  if (!raw) return 30
  const n = Number(raw)
  if (!Number.isFinite(n)) return 30
  const clamped = Math.min(90, Math.max(30, Math.round(n)))
  return ALLOWED_DAYS.reduce(
    (best, d) => (Math.abs(d - clamped) < Math.abs(best - clamped) ? d : best),
    30 as number
  )
}

/**
 * GET /api/menu-engineering?days=30|60|90
 *
 * Menu engineering report (Kasavana-Smith quadrant analysis), OPS-8 wave 1.
 * - Sales: non-voided OrderItems of orders with paymentStatus paid|partial,
 *   created within the period, location-scoped (central roles = all locations).
 * - Cost: BOM-aware (yield + sub-recipe children) via recipe-cost kernel, fallback to the
 *   linked InventoryItem.costPerServing, else costKnown=false (item stays in
 *   the table with quadrant 'unknown', excluded from scatter + thresholds).
 * - Thresholds (popularity + CM) are computed WITHIN each category — see
 *   src/lib/menu-engineering.ts for the pure math.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = clampDays(url.searchParams.get('days'))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Issue #4 §1: location scope on the related Order (OrderItem has no locationId).
  // Issue #5 (P0, komentar #6): org allow-lista namesto ročnega centralnega bypassa
  // (analiza prodaje ne sme mešati organizacij).
  const orderScope = await locationScope(user)

  const rows = await db.orderItem.findMany({
    where: {
      voided: false,
      Order: { paymentStatus: { in: ['paid', 'partial'] }, createdAt: { gte: since }, ...orderScope },
    },
    select: { menuItemId: true, quantity: true, price: true, discountAmount: true },
    take: 50000,
  })

  // Aggregate sales per menu item: qty = units sold, revenue = qty*price - line discount.
  const sales = new Map<string, { qty: number; revenue: number }>()
  for (const r of rows) {
    const agg = sales.get(r.menuItemId) || { qty: 0, revenue: 0 }
    agg.qty += r.quantity
    agg.revenue += num(r.quantity) * num(r.price) - num(r.discountAmount)
    sales.set(r.menuItemId, agg)
  }
  const soldIds = [...sales.keys()].filter((id) => (sales.get(id)?.qty || 0) > 0)
  const empty = { days, generatedAt: new Date().toISOString(), categories: [], items: [] }
  if (soldIds.length === 0) return ok(empty)

  const menuItems = await db.menuItem.findMany({
    where: { id: { in: soldIds } },
    select: { id: true, name: true, price: true, Category: { select: { name: true } } },
  })
  const miById = new Map(menuItems.map((m) => [m.id, m]))

  // Cost layer 1: direct recipe rows (sub-recipe components ignored for v1).
  const recipeRows = await db.recipeItem.findMany({
    where: { menuItemId: { in: soldIds } },
    select: {
      id: true,
      menuItemId: true,
      quantityPerServing: true,
      yieldPercent: true,
      parentRecipeItemId: true,
      InventoryItem: { select: { costPerUnit: true } },
    },
  })
  const recipesByItem = new Map<string, typeof recipeRows>()
  for (const r of recipeRows) {
    const arr = recipesByItem.get(r.menuItemId)
    if (arr) arr.push(r)
    else recipesByItem.set(r.menuItemId, [r])
  }

  // Cost layer 2 (fallback): InventoryItem.costPerServing linked by menuItemId.
  const linkedInv = await db.inventoryItem.findMany({
    where: { menuItemId: { in: soldIds } },
    select: { menuItemId: true, costPerServing: true },
    orderBy: { costPerServing: 'desc' },
  })
  const fallbackCost = new Map<string, number>()
  for (const inv of linkedInv) {
    if (!inv.menuItemId) continue
    const c = num(inv.costPerServing)
    if (c > 0 && !fallbackCost.has(inv.menuItemId)) fallbackCost.set(inv.menuItemId, c)
  }

  const inputs: MeItemInput[] = []
  for (const id of soldIds) {
    const mi = miById.get(id)
    const agg = sales.get(id)
    if (!mi || !agg) continue
    const rowsForItem = recipesByItem.get(id) || []
    const recipeCost = recipeCostFromRows(
      rowsForItem.map((r) => ({
        id: r.id,
        quantityPerServing: num(r.quantityPerServing),
        yieldPercent: num(r.yieldPercent) || 100,
        parentRecipeItemId: r.parentRecipeItemId,
        costPerUnit: num(r.InventoryItem?.costPerUnit),
      }))
    )
    const cost = recipeCost > 0 ? recipeCost : fallbackCost.get(id) || 0
    inputs.push({
      id: mi.id,
      name: mi.name,
      category: mi.Category?.name || '—',
      price: num(mi.price),
      qtySold: agg.qty,
      revenue: Math.max(0, agg.revenue),
      cost,
      costKnown: cost > 0,
    })
  }
  if (inputs.length === 0) return ok(empty)

  const result = buildMenuEngineering(inputs)
  return ok({ days, generatedAt: new Date().toISOString(), ...result })
}
