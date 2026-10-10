import { NextRequest } from 'next/server'
import type { TableStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, requireUserLocation, isResponse, ok, fail, locationScope } from '@/lib/api'
import { mapTable, tableStatusToDB, nid, ORDER_ACTIVE_DB } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const tables = await db.table.findMany({
    where: locationScope(user),
    include: { Order: { where: { status: { in: ORDER_ACTIVE_DB } }, include: { OrderItem: true } } },
    orderBy: [{ area: 'asc' }, { number: 'asc' }],
  })
  return ok({ tables: tables.map((t) => {
    const active = t.Order[0]
    return mapTable({ ...t, items: active?.OrderItem }, active ? { ...active, items: active.OrderItem } : null)
  }) })
}

export async function POST(req: NextRequest) {
  // P2 audit N1: kreiranje miz = konfiguracija prostora — kanonično dovoljenje menu.manage
  // (ROLE_DEFAULTS: owner/admin/manager imajo vsa dovoljenja → OWNER NI VEČ blokiran;
  // staff/waiter/bar/chef/kitchen → 403). Usklajeno z menus/categories po 31-b.
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const number = Number(body?.number ?? body?.name)
  if (!number || number < 1) return fail('Številka mize je obvezna.')
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  const exists = await db.table.findUnique({ where: { number_locationId: { number, locationId } } })
  if (exists) return fail(`Miza s številko ${number} že obstaja.`)
  const table = await db.table.create({
    data: {
      id: nid(), number, capacity: Number(body?.seats ?? body?.capacity) || 4,
      area: String(body?.zone ?? body?.area ?? 'Glavna dvorana'), posX: Number(body?.posX) || 40, posY: Number(body?.posY) || 40,
      status: tableStatusToDB('FREE') as TableStatus, locationId,
    },
  })
  return ok({ table: mapTable(table) }, 201)
}
