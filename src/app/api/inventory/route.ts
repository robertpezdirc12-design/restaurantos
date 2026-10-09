import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, assertResourceLocation, isResponse, ok, locationScope } from '@/lib/api'
import { num, nid, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.inventoryItem.findMany({
    // Issue #4 §1: staff vidi samo zalogo svoje lokacije
    where: locationScope(user),
    orderBy: { name: 'asc' },
    take: 100,
  })
  return ok({
    inventory: rows.map((r) => ({
      id: r.id,
      name: r.name,
      unit: r.unit,
      qty: num(r.quantity),
      minQty: num(r.minQuantity),
      cost: num(r.costPerUnit),
      supplierId: r.supplier || null,
      locationId: r.locationId,
    })),
  })
}

/** Nov artikel zaloge (sprejem blaga) — ADMIN/MANAGER. */
export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (!['OWNER', 'ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim()
  if (!name) return ok({ error: 'Naziv artikla je obvezen.' }, 400)
  const locationId = user.loc || (await db.location.findFirst())?.id || null
  const row = await db.inventoryItem.create({
    data: {
      id: nid(),
      name,
      unit: String(body?.unit || 'pcs'),
      quantity: Number(String(body?.qty ?? 0).replace(',', '.')) || 0,
      minQuantity: Number(String(body?.minQty ?? 0).replace(',', '.')) || 0,
      costPerUnit: Number(String(body?.cost ?? 0).replace(',', '.')) || 0,
      supplier: String(body?.supplierName || ''),
      category: String(body?.category || 'general'),
      locationId,
    },
  })
  await db.auditLog.create({
    data: { id: nid(), userId: user.sub, action: 'INVENTORY_CREATE', entityType: 'InventoryItem', entityId: row.id, details: jstr({ name, qty: num(row.quantity), unit: row.unit }) },
  })
  return ok({ item: { id: row.id, name: row.name } }, 201)
}

/** Prilagoditev zaloge: prejem (delta > 0), popravek količine/min/cene — ADMIN/MANAGER. */
export async function PATCH(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (!['OWNER', 'ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  const item = id ? await db.inventoryItem.findUnique({ where: { id } }) : null
  if (!item) return ok({ error: 'Artikel ne obstaja.' }, 404)
  // Issue #4 §1: prilagoditev zaloge tujega artikla (druga lokacija) je zavrnjena (fail-closed)
  const locRes = assertResourceLocation(user, item.locationId)
  if (locRes) return locRes

  const delta = body?.delta !== undefined && body?.delta !== null && body?.delta !== '' ? Number(String(body.delta).replace(',', '.')) : null
  const setQty = body?.setQty !== undefined && body?.setQty !== null && body?.setQty !== '' ? Number(String(body.setQty).replace(',', '.')) : null
  const minQty = body?.minQty !== undefined && body?.minQty !== '' ? (Number(String(body.minQty).replace(',', '.')) || 0) : null
  const cost = body?.cost !== undefined && body?.cost !== '' ? (Number(String(body.cost).replace(',', '.')) || 0) : null
  if (delta === null && setQty === null && minQty === null && cost === null) return ok({ error: 'Ni podatkov za posodobitev.' }, 400)

  // R4 popravek (P0 audit): transakcija + atomarne spremembe količine (increment/decrement
  // s pogojem) — brez lost update; StockTransaction + AuditLog v ISTI transakciji,
  // da evidence gibanja ne odstopa od dejanskega stanja (prej: trije ločeni klici).
  const result = await db.$transaction(async (tx) => {
    const prevQty = num(item.quantity)
    let newQty = prevQty
    let variance = 0
    if (delta !== null && delta > 0) {
      await tx.inventoryItem.updateMany({ where: { id }, data: { quantity: { increment: delta }, lastRestocked: new Date() } })
      const after = await tx.inventoryItem.findUnique({ where: { id }, select: { quantity: true } })
      newQty = num(after?.quantity)
      variance = Math.round((newQty - prevQty) * 1000) / 1000
    } else if (delta !== null && delta < 0) {
      const dec = -delta
      const res = await tx.inventoryItem.updateMany({ where: { id, quantity: { gte: dec } }, data: { quantity: { decrement: dec } } })
      if (res.count === 0) {
        // talna omejitev na 0 (enako kot prejšnji max(0, qty + delta))
        const cur = await tx.inventoryItem.findUnique({ where: { id }, select: { quantity: true } })
        const avail = Math.max(0, num(cur?.quantity))
        if (avail > 0) await tx.inventoryItem.updateMany({ where: { id, quantity: { gte: avail } }, data: { quantity: { decrement: avail } } })
      }
      const after = await tx.inventoryItem.findUnique({ where: { id }, select: { quantity: true } })
      newQty = num(after?.quantity)
      variance = Math.round((newQty - prevQty) * 1000) / 1000
    } else if (setQty !== null) {
      // inventurni popravek (absolutna vrednost) — namenoma last-writer-wins
      newQty = Math.max(0, setQty)
      await tx.inventoryItem.updateMany({ where: { id }, data: { quantity: newQty } })
      variance = Math.round((newQty - prevQty) * 1000) / 1000
    }
    if (minQty !== null) await tx.inventoryItem.updateMany({ where: { id }, data: { minQuantity: minQty } })
    if (cost !== null) await tx.inventoryItem.updateMany({ where: { id }, data: { costPerUnit: cost } })

    // Evidence gibanja zaloge (razvidnost za računovodski izvoz): prejem/odpis/popravek
    if (variance !== 0) {
      const unitCost = cost !== null ? cost : num(item.costPerUnit)
      await tx.stockTransaction.create({
        data: {
          id: nid(),
          inventoryItemId: id,
          type: variance > 0 ? 'RECEIVE' : 'ADJUST',
          quantity: variance,
          previousQty: prevQty,
          newQty,
          costPerUnit: unitCost,
          totalCost: Math.round(Math.abs(variance) * unitCost * 100) / 100,
          reason: variance > 0 ? 'Prejem blaga (ročni vnos)' : 'Popravek/odpis zaloge (ročni vnos)',
          employeeId: user.sub,
          employeeName: user.name,
        },
      })
    }

    await tx.auditLog.create({
      data: { id: nid(), userId: user.sub, action: 'INVENTORY_ADJUST', entityType: 'InventoryItem', entityId: id, details: jstr({ name: item.name, previousQty: prevQty, newQty, delta, setQty, minQuantity: minQty, costPerUnit: cost }) },
    })
    return { newQty, variance, name: item.name }
  })

  // Issue #11 §3 — dogodek spremembe zaloge (variance != 0 pomeni dejanski premik)
  if (result.variance !== 0) {
    await publishEvent('StockChanged', { entityType: 'InventoryItem', entityId: id, payload: { name: result.name, variance: result.variance, newQty: result.newQty, by: user.name } }).catch(() => undefined)
  }
  return ok({ item: { id, name: item.name, qty: result.newQty } })
}
