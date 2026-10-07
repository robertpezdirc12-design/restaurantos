import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { num, nid, jstr } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.inventoryItem.findMany({ orderBy: { name: 'asc' }, take: 100 })
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
  await db.auditLog.create({
    data: { id: nid(), userId: user.sub, action: 'INVENTORY_ADJUST', entityType: 'InventoryItem', entityId: id, details: jstr({ name: item.name, ...data }) },
  })
  return ok({ item: { id: updated.id, name: updated.name, qty: num(updated.quantity) } })
}
