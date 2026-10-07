import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok } from '@/lib/api'
import { nid, num, jstr } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.recipeItem.findMany({
    include: {
      MenuItem: { select: { id: true, name: true } },
      InventoryItem: { select: { id: true, name: true, unit: true } },
    },
    take: 500,
  })
  const byItem = new Map<string, { id: string; name: string; instructions: string; items: { inventoryItemId: string; name: string; unit: string; qty: number }[] }>()
  for (const r of rows) {
    const key = r.menuItemId
    if (!byItem.has(key)) {
      byItem.set(key, {
        id: key,
        name: r.MenuItem?.name || 'Artikel',
        instructions: '',
        items: [],
      })
    }
    byItem.get(key)!.items.push({
      inventoryItemId: r.inventoryItemId,
      name: r.InventoryItem?.name || 'Sestavina',
      unit: r.unit || r.InventoryItem?.unit || '',
      qty: num(r.quantityPerServing),
    })
  }
  return ok({ recipes: [...byItem.values()] })
}

/**
 * Shrani recepturo artikla menija (razknjiževanje po recepturah).
 * Telo: { menuItemId, items: [{ inventoryItemId, qty, unit? }], notes? }
 * Zamenja obstoječe sestavine za ta artikel (atomarno v transakciji).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const menuItemId = String(body?.menuItemId || '')
  const rawItems = Array.isArray(body?.items) ? body.items : []

  const menuItem = await db.menuItem.findUnique({ where: { id: menuItemId }, select: { id: true, name: true } })
  if (!menuItem) return ok({ error: 'Artikel menija ne obstaja.' }, 404)

  // Deduplikacija po sestavini (shema: @@unique(menuItemId, inventoryItemId))
  const merged = new Map<string, { inventoryItemId: string; qty: number; unit: string }>()
  for (const it of rawItems) {
    const inventoryItemId = String(it?.inventoryItemId || '')
    const qty = Number(String(it?.qty ?? 0).replace(',', '.'))
    if (!inventoryItemId || !(qty > 0)) continue
    const prev = merged.get(inventoryItemId)
    merged.set(inventoryItemId, {
      inventoryItemId,
      qty: Math.round(((prev?.qty || 0) + qty) * 1000) / 1000,
      unit: String(it?.unit || ''),
    })
  }
  if (merged.size === 0) return ok({ error: 'Receptura potrebuje vsaj eno sestavino s količino > 0.' }, 400)

  const invItems = await db.inventoryItem.findMany({
    where: { id: { in: [...merged.keys()] } },
    select: { id: true, name: true, unit: true },
  })
  if (invItems.length !== merged.size) return ok({ error: 'Ena od sestavin ne obstaja v zalogi.' }, 404)

  const notes = String(body?.notes || '')
  const rows = [...merged.values()].map((m) => {
    const inv = invItems.find((i) => i.id === m.inventoryItemId)!
    return {
      id: nid(),
      menuItemId,
      inventoryItemId: m.inventoryItemId,
      quantityPerServing: m.qty,
      unit: m.unit || inv.unit || '',
      notes,
    }
  })

  await db.$transaction(async (tx) => {
    await tx.recipeItem.deleteMany({ where: { menuItemId } })
    for (const r of rows) await tx.recipeItem.create({ data: r })
  })

  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'RECIPE_SAVED',
      entityType: 'MenuItem',
      entityId: menuItemId,
      details: jstr({ menuItem: menuItem.name, lines: rows.map((r) => ({ item: invItems.find((i) => i.id === r.inventoryItemId)?.name, qty: r.quantityPerServing, unit: r.unit })) }),
    },
  })

  return ok({ saved: rows.length, menuItemId }, 201)
}

/** Izbriši recepturo artikla menija (?menuItemId=). */
export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const menuItemId = url.searchParams.get('menuItemId') || ''
  if (!menuItemId) return ok({ error: 'menuItemId je obvezen.' }, 400)
  const menuItem = await db.menuItem.findUnique({ where: { id: menuItemId }, select: { name: true } })
  const del = await db.recipeItem.deleteMany({ where: { menuItemId } })
  if (del.count > 0) {
    await db.auditLog.create({
      data: { id: nid(), userId: user.sub, action: 'RECIPE_DELETED', entityType: 'MenuItem', entityId: menuItemId, details: jstr({ menuItem: menuItem?.name || menuItemId, removed: del.count }) },
    })
  }
  return ok({ deleted: del.count })
}
