import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import type { OrderItemStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, assertResourceLocation, isResponse, ok, fail, locationScope } from '@/lib/api'
import { mapOrder, mapOrderItem, itemStatusToDB, orderStatusToUI, ORDER_ACTIVE_DB, ITEM_ACTIVE_DB } from '@/lib/map'
import { publishEvent } from '@/lib/events'

const ITEM_ACTIVE_PRISMA = ITEM_ACTIVE_DB as OrderItemStatus[]

type KitchenOrder = Prisma.OrderGetPayload<{
  include: {
    Table: true
    OrderItem: { include: { MenuItem: { include: { PrepStation: true } } } }
  }
}>

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const orders = await db.order.findMany({
    where: { ...locationScope(user), status: { in: ORDER_ACTIVE_DB }, OrderItem: { some: { status: { in: ITEM_ACTIVE_PRISMA } } } },
    include: {
      Table: true,
      OrderItem: {
        where: { status: { in: ITEM_ACTIVE_PRISMA } },
        orderBy: { createdAt: 'asc' },
        include: { MenuItem: { include: { PrepStation: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  }) as unknown as KitchenOrder[]

  const queue = orders.map((o) => ({
    ...mapOrder({ ...o, items: o.OrderItem, table: o.Table, employee: null }),
    items: o.OrderItem.map((it) =>
      mapOrderItem({ ...it, menuItem: it.MenuItem ? { prepStation: it.MenuItem.PrepStation } : undefined })
    ),
  }))
  return ok({ queue })
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'kitchen.update')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.itemId || !['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(body.status)) return fail('itemId in veljaven status sta obvezna.')
  const newDbStatus = itemStatusToDB(body.status)
  const target = await db.orderItem.findUnique({ where: { id: body.itemId }, include: { Order: { select: { locationId: true } } } })
  if (!target) return fail('Artikel naročila ne obstaja.', 404)
  const locRes = assertResourceLocation(user, target.Order?.locationId)
  if (locRes) return locRes
  const item = await db.orderItem.update({
    where: { id: body.itemId },
    data: { status: newDbStatus as Prisma.OrderItemUpdateInput['status'], ...(newDbStatus === 'ready' ? { readyAt: new Date(), readyById: user.sub, readyByName: user.name } : {}) },
  })
  const remaining = await db.orderItem.count({ where: { orderId: item.orderId, status: { in: ['pending', 'fired', 'preparing'] } } })
  if (remaining === 0) {
    await db.order.update({ where: { id: item.orderId }, data: { status: 'prepared' } })
    // Issue #11 §3 — kuhinja zaključena (vsi artikli ready)
    await publishEvent('KitchenCompleted', { entityType: 'Order', entityId: item.orderId, payload: { itemId: item.id, by: user.name } }).catch(() => undefined)
  }
  else await db.order.updateMany({ where: { id: item.orderId, status: 'open' }, data: { status: 'sent' } })
  const fresh = await db.orderItem.findUnique({ where: { id: item.id }, include: { MenuItem: { include: { PrepStation: true } } } })
  const mapped = fresh ? mapOrderItem({ ...fresh, menuItem: fresh.MenuItem ? { prepStation: fresh.MenuItem.PrepStation } : undefined }) : { id: item.id, status: orderStatusToUI(item.status) }
  return ok({ item: mapped })
}
