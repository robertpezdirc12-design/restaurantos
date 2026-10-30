import { NextRequest } from 'next/server'
import type { TableStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, requireUserLocation, isResponse, ok, fail, locationScope } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { mapTable, tableStatusToDB, nid, jstr, ORDER_ACTIVE_DB } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const tables = await db.table.findMany({
    where: await locationScope(user),
    // OSS-4 (v1.204.0): include razširjen na 'hold' — zadržano naročilo TUDI zaseda
    // mizo (Issue #70 kanonična izpeljava: brez tega bi zadržana miza padla v DIRTY).
    // activeOrder ostane SAMO aktivni tok (urejevalnik/fire tarča); zadržano gre v
    // ločeno polje heldOrderId (aditivno, 0 DDL).
    include: { Order: { where: { status: { in: [...ORDER_ACTIVE_DB, 'hold'] } }, include: { OrderItem: true } } },
    orderBy: [{ area: 'asc' }, { number: 'asc' }],
  })
  return ok({ tables: tables.map((t) => {
    const active = t.Order.find((o) => ORDER_ACTIVE_DB.includes(o.status)) ?? null
    const held = !active ? (t.Order.find((o) => o.status === 'hold') ?? null) : null
    return mapTable(
      { ...t, items: active?.OrderItem },
      active ? { ...active, items: active.OrderItem } : null,
      held ? { ...held, items: held.OrderItem } : null,
    )
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
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard
  const exists = await db.table.findUnique({ where: { number_locationId: { number, locationId } } })
  if (exists) return fail(`Miza s številko ${number} že obstaja.`)
  const table = await db.table.create({
    data: {
      id: nid(), number, capacity: Number(body?.seats ?? body?.capacity) || 4,
      area: String(body?.zone ?? body?.area ?? 'Glavna dvorana'), posX: Number(body?.posX) || 40, posY: Number(body?.posY) || 40,
      status: tableStatusToDB('FREE') as TableStatus, locationId,
    },
  })
  // 33-c (audit §6): kreiranje mize je zdaj revidirano (prej brez revizije)
  await writeAudit(db, { userId: user.sub, action: 'TABLE_CREATE', entityType: 'Table', entityId: table.id, details: jstr({ number, capacity: table.capacity, area: table.area }), locationId: locationId })
  return ok({ table: mapTable(table) }, 201)
}
