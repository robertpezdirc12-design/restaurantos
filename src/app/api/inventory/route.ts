import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, assertResourceLocation, isResponse, ok, locationScope } from '@/lib/api'
import { num, nid, jstr } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
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
  const user = requireAuth(req)
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
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['OWNER', 'ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  const item = id ? await db.inventoryItem.findUnique({ where: { id } }) : null
  if (!item) return ok({ error: 'Artikel ne obstaja.' }, 404)
  // Issue #4 §1: prilagoditev zaloge tujega artikla (druga lokacija) je zavrnjena (fail-closed)
  const locRes = assertResourceLocation(user, item.locationId)
  if (locRes) return locRes

  const data: Record<string, unknown> = {}
  const delta = body?.delta !== undefined && body?.delta !== null && body?.delta !== '' ? Number(String(body.delta).replace(',', '.')) : null
  const setQty = body?.setQty !== undefined && body?.setQty !== null && body?.setQty !== '' ? Number(String(body.setQty).replace(',', '.')) : null
  if (delta !== null) {
    data.quantity = Math.max(0, num(item.quantity) + delta)
    if (delta > 0) data.lastRestocked = new Date()
  } else if (setQty !== null) {
    data.quantity = Math.max(0, setQty)
  }
  if (body?.minQty !== undefined && body?.minQty !== '') data.minQuantity = Number(String(body.minQty).replace(',', '.')) || 0
  if (body?.cost !== undefined && body?.cost !== '') data.costPerUnit = Number(String(body.cost).replace(',', '.')) || 0
  if (Object.keys(data).length === 0) return ok({ error: 'Ni podatkov za posodobitev.' }, 400)

  const updated = await db.inventoryItem.update({ where: { id }, data })

  // Evidence gibanja zaloge (razvidnost za računovodski izvoz): prejem/odpis/popravek
  const prevQty = num(item.quantity)
  const newQty = delta !== null ? Math.max(0, prevQty + delta) : setQty !== null ? Math.max(0, setQty) : prevQty
  const variance = Math.round((newQty - prevQty) * 1000) / 1000
  if (variance !== 0) {
    const unitCost = data.costPerUnit !== undefined ? (data.costPerUnit as number) : num(item.costPerUnit)
    await db.stockTransaction.create({
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

  await db.auditLog.create({
    data: { id: nid(), userId: user.sub, action: 'INVENTORY_ADJUST', entityType: 'InventoryItem', entityId: id, details: jstr({ name: item.name, ...data }) },
  })
  return ok({ item: { id: updated.id, name: updated.name, qty: num(updated.quantity) } })
}
