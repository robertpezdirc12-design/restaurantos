import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import type { OrderItemStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, mapOrderItem, itemStatusToDB, orderStatusToUI, ORDER_ACTIVE_DB, ITEM_ACTIVE_DB, nid, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { pushEvent, pushToEmployees } from '@/lib/push'
import { auditChainFields } from '@/lib/audit-chain'
import { KDS_DELAY_ACTION, computePrepMin, isValidDelayReason, kdsDelayDetails, shouldAskDelayReason } from '@/lib/kds-delays'

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
    where: { ...(await locationScope(user)), status: { in: ORDER_ACTIVE_DB }, OrderItem: { some: { status: { in: ITEM_ACTIVE_PRISMA } } } },
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
  // OPS-9 val 3: optional delay reason sent by the KDS when a LATE item (>10 min) is bumped
  const delayReason = isValidDelayReason(body.delayReason) ? body.delayReason : null
  const newDbStatus = itemStatusToDB(body.status)
  const target = await db.orderItem.findUnique({ where: { id: body.itemId }, include: { Order: { select: { locationId: true } } } })
  if (!target) return fail('Artikel naročila ne obstaja.', 404)
  const locRes = await guardResource(user, target.Order?.locationId)
  if (locRes) return locRes
  const item = await db.orderItem.update({
    where: { id: body.itemId },
    data: { status: newDbStatus as Prisma.OrderItemUpdateInput['status'], ...(newDbStatus === 'ready' ? { readyAt: new Date(), readyById: user.sub, readyByName: user.name } : {}) },
  })
  // OPS-9 val 3 (v1.76.0) — KDS_DELAY audit when a LATE item (prep > 10 min) is bumped to ready
  // with a reason from the catalog. NON-BLOCKING: any failure here must never fail the bump.
  if (newDbStatus === 'ready' && delayReason) {
    try {
      const prepMin = computePrepMin(target.firedAt, new Date())
      if (shouldAskDelayReason(prepMin)) {
        const __aId = nid()
        const details = kdsDelayDetails({
          orderItemId: item.id,
          menuItemName: target.menuItemName || item.menuItemName || '—',
          reason: delayReason,
          prepMin: prepMin as number,
          orderId: item.orderId,
        })
        const __chain = await auditChainFields(db, {
          id: __aId,
          action: KDS_DELAY_ACTION,
          entityType: 'OrderItem',
          entityId: item.id,
          details,
          locationId: target.Order?.locationId ?? null,
        })
        await db.auditLog.create({
          data: {
            ...__chain,
            id: __aId,
            userId: user.sub,
            action: KDS_DELAY_ACTION,
            entityType: 'OrderItem',
            entityId: item.id,
            details: jstr(details),
            locationId: target.Order?.locationId ?? null,
          },
        })
      }
    } catch {
      // never fail the bump because of the delay-reason audit
    }
  }
  const remaining = await db.orderItem.count({ where: { orderId: item.orderId, status: { in: ['pending', 'fired', 'preparing'] } } })
  if (remaining === 0) {
    await db.order.update({ where: { id: item.orderId }, data: { status: 'prepared' } })
    // Issue #11 §3 — kuhinja zaključena (vsi artikli ready)
    await publishEvent('KitchenCompleted', { entityType: 'Order', entityId: item.orderId, payload: { itemId: item.id, by: user.name } }).catch(() => undefined)
    // OPS-7 (v1.70.0) push to waiters/management; OPS-8 (v1.72.0) via notification matrix
    // (fire-and-forget; no rules = same behavior as before). Push to the order author goes
    // DIRECTLY (pushToEmployees) on purpose — personal notification, not a matrix event.
    const doneOrder = await db.order.findUnique({ where: { id: item.orderId }, select: { orderNumber: true, locationId: true, employeeId: true } })
    if (doneOrder) {
      void pushEvent('ORDER_READY', {
        title: 'Naročilo pripravljeno',
        body: `#${doneOrder.orderNumber ?? ''} — ${item.menuItemName ?? 'postavke'}`,
        url: '/dashboard?tab=mize',
        tag: `ready-${item.orderId}`,
      }, { roles: ['waiter', 'staff', 'manager'], locationId: doneOrder.locationId })
      if (doneOrder.employeeId) pushToEmployees([doneOrder.employeeId], {
        title: 'Naročilo pripravljeno',
        body: `#${doneOrder.orderNumber ?? ''} — ${item.menuItemName ?? 'postavke'}`,
        url: '/dashboard?tab=mize',
        tag: `ready-${item.orderId}`,
      })
    }
  }
  else await db.order.updateMany({ where: { id: item.orderId, status: 'open' }, data: { status: 'sent' } })
  const fresh = await db.orderItem.findUnique({ where: { id: item.id }, include: { MenuItem: { include: { PrepStation: true } } } })
  const mapped = fresh ? mapOrderItem({ ...fresh, menuItem: fresh.MenuItem ? { prepStation: fresh.MenuItem.PrepStation } : undefined }) : { id: item.id, status: orderStatusToUI(item.status) }
  return ok({ item: mapped })
}
