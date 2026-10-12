import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { nid, num, jstr, r2 } from '@/lib/map'
import { flattenDeduction, type RecipeNode } from '@/lib/recipe-cost'
import { scaleBatchLines, forecastQty, type BatchLine } from '@/lib/batch'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * OPS-10 val 3 (v1.79.0) — priprava po serijah (BatchPreparation activation).
 *
 * GET  /api/batch-preparations
 *        → last 50 batches (lines included) + `candidates` (inventory items whose
 *          linked menu item HAS a BOM) + `forecast` per candidate item (ceil of the
 *          average deduction quantity over the last 4 same-weekday sales days;
 *          without a BOM the raw sold servings are used as the fallback).
 *        ?bomFor=<inventoryItemId> → per-portion flattened BOM lines (dialog preview).
 *
 * POST /api/batch-preparations { outputItemId, plannedQty, note?, idempotencyKey? }
 *        → BOM flatten (flattenDeduction, portions=1) → scaleBatchLines →
 *          DRAFT batch + lines (unitCost = InventoryItem.costPerUnit snapshot,
 *          totalInputCost = Σ qty×unitCost). Idempotency: (locationId, idempotencyKey)
 *          unique — replay returns the existing DRAFT.
 *
 * Pravica: inventory.manage (kot receive). Audit: BATCH_CREATED.
 * Completion/cancellation: PATCH /api/batch-preparations/[id].
 */

/** Last N occurrences of the same weekday strictly BEFORE today (local days). */
function lastSameWeekdayWindows(now: Date, count = 4): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = []
  const weekday = now.getDay()
  for (let back = 1; back <= 28 && out.length < count; back++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 0, 0, 0, 0)
    if (d.getDay() !== weekday) continue
    out.push({ start: d, end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0) })
  }
  return out
}

interface BatchRowLike {
  id: string
  status: string
  note: string
  outputItemId: string
  outputQuantity: unknown
  outputUnit: string
  outputCostPerUnit: unknown
  totalInputCost: unknown
  createdAt: Date
  completedAt: Date | null
  cancelledAt: Date | null
  createdByName: string
  completedByName: string
  idempotencyKey: string | null
  InventoryItem: { name: string; unit: string } | null
  BatchPreparationLine: {
    id: string
    inventoryItemId: string
    itemName: string
    unit: string
    quantity: unknown
    costPerUnit: unknown
    inputStockTransactionId: string | null
    InventoryItem?: { name: string; unit: string } | null
  }[]
}

function mapBatch(b: BatchRowLike) {
  return {
    id: b.id,
    status: b.status,
    note: b.note,
    outputItemId: b.outputItemId,
    outputItemName: b.InventoryItem?.name || '',
    outputUnit: b.InventoryItem?.unit || b.outputUnit,
    outputQuantity: num(b.outputQuantity),
    outputCostPerUnit: num(b.outputCostPerUnit),
    totalInputCost: num(b.totalInputCost),
    createdAt: b.createdAt,
    completedAt: b.completedAt,
    cancelledAt: b.cancelledAt,
    createdByName: b.createdByName,
    completedByName: b.completedByName,
    idempotencyKey: b.idempotencyKey,
    lines: b.BatchPreparationLine.map((l) => ({
      id: l.id,
      inventoryItemId: l.inventoryItemId,
      name: l.InventoryItem?.name || l.itemName,
      unit: l.InventoryItem?.unit || l.unit,
      quantity: num(l.quantity),
      costPerUnit: num(l.costPerUnit),
      inputStockTransactionId: l.inputStockTransactionId,
    })),
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  // dialog preview: per-portion BOM lines for one candidate item
  const bomFor = req.nextUrl.searchParams.get('bomFor') || ''
  if (bomFor) {
    const item = await db.inventoryItem.findUnique({
      where: { id: bomFor },
      select: { id: true, name: true, unit: true, menuItemId: true },
    })
    if (!item) return fail('Artikel ne obstaja.', 404)
    if (!item.menuItemId) return ok({ lines: [], hasBom: false })
    const recipes = await db.recipeItem.findMany({
      where: { menuItemId: item.menuItemId },
      select: { id: true, menuItemId: true, inventoryItemId: true, quantityPerServing: true, unit: true, parentRecipeItemId: true, yieldPercent: true },
    })
    if (recipes.length === 0) return ok({ lines: [], hasBom: false })
    const invIds = [...new Set(recipes.map((r) => r.inventoryItemId))]
    const invRows = await db.inventoryItem.findMany({
      where: { id: { in: invIds } },
      select: { id: true, name: true, unit: true, costPerUnit: true },
    })
    const nodes: RecipeNode[] = recipes.map((r) => {
      const inv = invRows.find((i) => i.id === r.inventoryItemId)
      return {
        id: r.id,
        menuItemId: r.menuItemId,
        inventoryItemId: r.inventoryItemId,
        inventoryName: inv?.name,
        quantityPerServing: num(r.quantityPerServing),
        yieldPercent: num(r.yieldPercent, 100),
        unit: r.unit,
        parentRecipeItemId: r.parentRecipeItemId,
        costPerUnit: inv ? num(inv.costPerUnit) : undefined,
      }
    })
    const flat = flattenDeduction(nodes, item.menuItemId, 1)
    const lines: (BatchLine & { name: string; unit: string; costPerUnit: number })[] = []
    for (const [inventoryItemId, qty] of flat) {
      const inv = invRows.find((i) => i.id === inventoryItemId)
      lines.push({ inventoryItemId, qty, name: inv?.name || '', unit: inv?.unit || '', costPerUnit: inv ? num(inv.costPerUnit) : 0 })
    }
    return ok({ lines, hasBom: lines.length > 0 })
  }

  const batches = await db.batchPreparation.findMany({
    where: await locationScope(user),
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      InventoryItem: { select: { name: true, unit: true } },
      BatchPreparationLine: { include: { InventoryItem: { select: { name: true, unit: true } } } },
    },
  })

  // candidates: inventory items whose linked menu item carries a BOM (batch outputs)
  const candidatesRaw = await db.inventoryItem.findMany({
    where: { menuItemId: { not: null } },
    select: { id: true, name: true, unit: true, menuItemId: true },
    take: 200,
  })
  const menuIds = [...new Set(candidatesRaw.map((c) => c.menuItemId as string))]
  const bomMenuIds = new Set(
    menuIds.length
      ? (await db.recipeItem.findMany({ where: { menuItemId: { in: menuIds } }, select: { menuItemId: true }, distinct: ['menuItemId'] })).map((r) => r.menuItemId)
      : [],
  )
  const candidates = candidatesRaw.filter((c) => c.menuItemId && bomMenuIds.has(c.menuItemId))

  // forecast per candidate: avg deduction qty over the last 4 same weekdays
  const windows = lastSameWeekdayWindows(new Date(), 4)
  const forecast: Record<string, number> = {}
  if (candidates.length > 0 && windows.length > 0) {
    // one fetch per day window (paid orders only — consistent with sales reports)
    const perDay: { menuItemId: string; quantity: number }[][] = []
    for (const w of windows) {
      const items = await db.orderItem.findMany({
        where: { voided: false, Order: { paidAt: { gte: w.start, lt: w.end } } },
        select: { menuItemId: true, quantity: true },
        take: 5000,
      })
      perDay.push(items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity || 0 })))
    }
    const involvedMenuIds = [...new Set(perDay.flat().map((i) => i.menuItemId))]
    const recipes = involvedMenuIds.length
      ? await db.recipeItem.findMany({
          where: { menuItemId: { in: involvedMenuIds } },
          select: { id: true, menuItemId: true, inventoryItemId: true, quantityPerServing: true, unit: true, parentRecipeItemId: true, yieldPercent: true },
        })
      : []
    const recipeNodes: RecipeNode[] = recipes.map((r) => ({
      id: r.id,
      menuItemId: r.menuItemId,
      inventoryItemId: r.inventoryItemId,
      quantityPerServing: num(r.quantityPerServing),
      yieldPercent: num(r.yieldPercent, 100),
      unit: r.unit,
      parentRecipeItemId: r.parentRecipeItemId,
    }))
    const bomByMenu = new Map<string, RecipeNode[]>()
    for (const n of recipeNodes) {
      const list = bomByMenu.get(n.menuItemId) || []
      list.push(n)
      bomByMenu.set(n.menuItemId, list)
    }

    for (const cand of candidates) {
      const menuItemId = cand.menuItemId as string
      const totals = perDay.map((dayItems) => {
        let total = 0
        for (const oi of dayItems) {
          const nodes = bomByMenu.get(oi.menuItemId)
          if (nodes && nodes.length > 0) {
            const flat = flattenDeduction(nodes, oi.menuItemId, oi.quantity)
            total += flat.get(cand.id) || 0
          } else if (oi.menuItemId === menuItemId) {
            // no BOM for the sold menu item — fall back to raw sold servings
            total += oi.quantity
          }
        }
        return total
      })
      forecast[cand.id] = forecastQty(totals)
    }
  }

  return ok({
    batches: batches.map(mapBatch),
    candidates: candidates.map((c) => ({ id: c.id, name: c.name, unit: c.unit, menuItemId: c.menuItemId })),
    forecast,
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const outputItemId = String(body.outputItemId || '').trim()
  if (!outputItemId) return fail('Manjka izdelek (outputItemId).', 400)
  const plannedQty = num(body.plannedQty)
  if (!(plannedQty > 0) || plannedQty > 100000) return fail('Količina priprave mora biti večja od 0 (največ 100000).', 400)

  const item = await db.inventoryItem.findUnique({
    where: { id: outputItemId },
    select: { id: true, name: true, unit: true, menuItemId: true, locationId: true },
  })
  if (!item) return fail('Artikel ne obstaja.', 404)
  if (!item.menuItemId) return fail('Artikel nima povezanega artikla menija (receptura/BOM ni na voljo).', 400)

  // location: user's location, else the item's, else the default 'main'
  const locationId = user.loc || item.locationId || 'main'

  // idempotency: (locationId, idempotencyKey) unique on BatchPreparation
  const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey).slice(0, 120) : null
  if (idempotencyKey) {
    const existing = await db.batchPreparation.findUnique({
      where: { locationId_idempotencyKey: { locationId, idempotencyKey } },
      include: { InventoryItem: { select: { name: true, unit: true } }, BatchPreparationLine: { include: { InventoryItem: { select: { name: true, unit: true } } } } },
    })
    if (existing) return ok({ batch: mapBatch(existing), idempotentReplay: true })
  }

  const recipes = await db.recipeItem.findMany({
    where: { menuItemId: item.menuItemId },
    select: { id: true, menuItemId: true, inventoryItemId: true, quantityPerServing: true, unit: true, parentRecipeItemId: true, yieldPercent: true },
  })
  if (recipes.length === 0) return fail('Izbrani artikel nima recepture (BOM) — priprava po serijah ni mogoča.', 400)
  const invIds = [...new Set(recipes.map((r) => r.inventoryItemId))]
  const invRows = await db.inventoryItem.findMany({
    where: { id: { in: invIds } },
    select: { id: true, name: true, unit: true, costPerUnit: true },
  })
  const nodes: RecipeNode[] = recipes.map((r) => {
    const inv = invRows.find((i) => i.id === r.inventoryItemId)
    return {
      id: r.id,
      menuItemId: r.menuItemId,
      inventoryItemId: r.inventoryItemId,
      inventoryName: inv?.name,
      quantityPerServing: num(r.quantityPerServing),
      yieldPercent: num(r.yieldPercent, 100),
      unit: r.unit,
      parentRecipeItemId: r.parentRecipeItemId,
    }
  })
  const flat = flattenDeduction(nodes, item.menuItemId, 1)
  const perPortion: BatchLine[] = [...flat.entries()].map(([inventoryItemId, qty]) => ({ inventoryItemId, qty }))
  const scaled = scaleBatchLines(perPortion, plannedQty)
  if (scaled.length === 0) return fail('Receptura ne odšteje nobene sestavine — priprava ni mogoča.', 400)

  const costById = new Map(invRows.map((i) => [i.id, num(i.costPerUnit)]))
  const nameById = new Map(invRows.map((i) => [i.id, i.name]))
  const unitById = new Map(invRows.map((i) => [i.id, i.unit]))
  let totalInputCost = 0
  for (const l of scaled) totalInputCost += (l.qty || 0) * (costById.get(l.inventoryItemId) || 0)
  totalInputCost = r2(totalInputCost)

  const created = await db.batchPreparation.create({
    data: {
      id: nid(),
      locationId,
      status: 'DRAFT',
      outputItemId: item.id,
      outputQuantity: plannedQty,
      outputUnit: item.unit,
      totalInputCost,
      note: String(body.note || '').slice(0, 500),
      createdByName: user.name || '',
      idempotencyKey,
      BatchPreparationLine: {
        create: scaled.map((l) => ({
          id: nid(),
          inventoryItemId: l.inventoryItemId,
          itemName: nameById.get(l.inventoryItemId) || '',
          unit: unitById.get(l.inventoryItemId) || '',
          quantity: l.qty,
          costPerUnit: costById.get(l.inventoryItemId) || 0,
        })),
      },
    },
    include: {
      InventoryItem: { select: { name: true, unit: true } },
      BatchPreparationLine: { include: { InventoryItem: { select: { name: true, unit: true } } } },
    },
  })

  const __aId = nid(); const __chain = await auditChainFields(db, { action: 'BATCH_CREATED', entityType: 'BatchPreparation', entityId: created.id, details: jstr({ outputItemId: item.id, outputItemName: item.name, plannedQty, lines: scaled.length, totalInputCost, idempotencyKey, locationId }), id: __aId })
  await db.auditLog.create({
    data: { ...__chain, id: __aId, userId: user.sub, action: 'BATCH_CREATED', entityType: 'BatchPreparation', entityId: created.id, details: jstr({ outputItemId: item.id, outputItemName: item.name, plannedQty, lines: scaled.length, totalInputCost, idempotencyKey, locationId }) },
  })

  return ok({ batch: mapBatch(created) }, 201)
}
