import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { mapOrder, mapOrderItem, itemStatusToDB, orderStatusToUI, ORDER_ACTIVE_DB, ITEM_ACTIVE_DB } from '@/lib/map'

/** Kuhinjski prikaz (KDS) — vrsta artikel-predmetov po naročilih */
export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const orders = await db.order.findMany({
    where: {
      status: { in: ORDER_ACTIVE_DB },
      OrderItem: { some: { status: { in: ITEM_ACTIVE_DB } } },
    },
    include: {
      Table: true,
      OrderItem: {
        where: { status: { in: ITEM_ACTIVE_DB } },
        orderBy: { createdAt: 'asc' },
        include: { MenuItem: { include: { PrepStation: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
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
  if (!body?.itemId || !['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(body.status)) {
    return fail('itemId in veljaven status sta obvezna.')
  }
  const newDbStatus = itemStatusToDB(body.status)
  const item = await db.orderItem.update({
    where: { id: body.itemId },
    data: {
      status: newDbStatus,
      ...(newDbStatus === 'ready'
        ? { readyAt: new Date(), readyById: user.sub, readyByName: user.name }
        : {}),
    },
  })
  // če so vsi artikli naročila pripravljeni → naročilo PREPARED
  const remaining = await db.orderItem.count({
    where: { orderId: item.orderId, status: { in: ['pending', 'fired', 'preparing'] } },
  })
  if (remaining === 0) {
    await db.order.update({ where: { id: item.orderId }, data: { status: 'prepared' } })
  } else {
    await db.order.updateMany({ where: { id: item.orderId, status: 'open' }, data: { status: 'sent' } })
  }
  const fresh = await db.orderItem.findUnique({ where: { id: item.id }, include: { MenuItem: { include: { PrepStation: true } } } })
  const mapped = fresh
    ? mapOrderItem({ ...fresh, menuItem: fresh.MenuItem ? { prepStation: fresh.MenuItem.PrepStation } : undefined })
    : { id: item.id, status: orderStatusToUI(item.status) }
  return ok({ item: mapped })
}
