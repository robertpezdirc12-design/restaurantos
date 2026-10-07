import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, forbidden, assertResourceLocation } from '@/lib/api'
import { mapOrder, mapOrderItem, nid, num, r2, itemStatusToDB } from '@/lib/map'
import { publishEvent } from '@/lib/events'

const orderInclude = {
  OrderItem: { include: { MenuItem: { include: { PrepStation: true } } } },
  Table: true,
  Employee_Order_employeeIdToEmployee: { select: { id: true, name: true, role: true } },
  Receipt: { orderBy: { createdAt: 'desc' as const } },
} as const

function normalize(o: Record<string, unknown>) {
  return {
    ...o,
    items: o.OrderItem,
    table: o.Table,
    employee: o.Employee_Order_employeeIdToEmployee,
  } as Parameters<typeof mapOrder>[0]
}

async function recalcTotals(orderId: string) {
  const items = await db.orderItem.findMany({ where: { orderId, voided: false } })
  let subtotal = 0
  let tax = 0
  for (const it of items) {
    subtotal += num(it.price) * (it.quantity || 0)
    tax += num(it.vatAmount)
  }
  return { subtotal: r2(subtotal), tax: r2(tax), total: r2(subtotal + tax) }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: location gate (prej: katerikoli staff je mogel brati naročilo katerekoli lokacije)
  const guard = assertResourceLocation(user, order.locationId)
  if (guard) return guard
  return ok({ order: mapOrder(normalize(order)) })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)

  // Granularne pravice (issue #1) — glede na vrsto spremembe:
  if (Array.isArray(body?.addItems) && body.addItems.length > 0) {
    const gate = await requirePermission(req, 'orders.create')
    if (isResponse(gate)) return gate
  } else if (body?.status) {
    if (body.status === 'PAID' || body.status === 'CANCELLED') {
      // plačilo/veljavnost mimo plačilnega poteka = samo vodstvo
      if (user.role !== 'ADMIN' && user.role !== 'MANAGER') return forbidden()
    } else {
      const gate = await requirePermission(req, 'kitchen.update')
      if (isResponse(gate)) return gate
    }
  }

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: location gate na VSAKO spremembo (prej: PATCH brez body akcije je bil prazen gate)
  const locGuard = assertResourceLocation(user, order.locationId)
  if (locGuard) return locGuard
  const recognized = Array.isArray(body?.addItems) || body?.status !== undefined || body?.note !== undefined || body?.customerName !== undefined
  if (!recognized) return fail('Ni prepoznane akcije (addItems | status | note | customerName).', 400)

  const data: Record<string, unknown> = {}
  if (body?.status && ['OPEN', 'SENT', 'PREPARED', 'PAID', 'CANCELLED'].includes(body.status)) {
    data.status = body.status.toLowerCase()
    if (body.status === 'PAID') {
      data.paidAt = new Date()
      data.paymentStatus = 'paid'
    }
    if (body.status === 'PAID' || body.status === 'CANCELLED') {
      if (order.tableId) {
        await db.table.update({ where: { id: order.tableId }, data: { status: 'cleaning' } })
      }
    }
    if (body.status === 'CANCELLED') {
      data.cancelledAt = new Date()
      data.cancelledBy = user.name
      data.cancelledById = user.sub
    }
  }
  if (body?.note !== undefined) data.notes = body.note
  if (body?.customerName !== undefined) data.customerName = body.customerName

  // dodajanje artiklov v odprto naročilo
  if (Array.isArray(body?.addItems) && body.addItems.length > 0) {
    const menuItems = await db.menuItem.findMany({
      where: {
        id: { in: body.addItems.map((i: { menuItemId: string }) => i.menuItemId) },
        isAvailable: true,
        // Issue #4 §1: artikel mora pripadati lokaciji naročila (prek Category→Menu)
        Category: { Menu: { locationId: order.locationId } },
      },
    })
    const rows = body.addItems.map((i: { menuItemId: string; qty?: number; note?: string }) => {
      const mi = menuItems.find((m) => m.id === i.menuItemId)
      if (!mi) throw new Error(`Artikel ni na voljo na tej lokaciji (${i.menuItemId}).`)
      const qty = Math.max(1, Math.round(Number(i.qty) || 1))
      const price = num(mi.price)
      const vatRate = num(mi.vatRate, 22)
      const line = price * qty
      return {
        id: nid(),
        orderId: id,
        menuItemId: mi.id,
        quantity: qty,
        price,
        vatRate,
        vatAmount: (line * vatRate) / 100,
        menuItemName: mi.name,
        status: itemStatusToDB('PENDING'),
        notes: i.note || '',
      }
    })
    try {
      await db.orderItem.createMany({ data: rows })
    } catch {
      return fail('Artikel ni na voljo na lokaciji naročila.', 400)
    }
    const totals = await recalcTotals(id)
    Object.assign(data, totals)
    if (data.status === undefined && order.status === 'open') data.status = 'sent'
  }

  const updated = await db.order.update({ where: { id }, data, include: orderInclude })
  // Issue #11 §3 — plačilo/storno dogodki (fire-and-forget, nikoli ne vplivata na odgovor)
  if (updated.status === 'paid') {
    await publishEvent('PaymentCompleted', { entityType: 'Order', entityId: updated.id, payload: { total: updated.total, locationId: updated.locationId } }).catch(() => undefined)
  }
  if (updated.status === 'cancelled') {
    await publishEvent('OrderCancelled', { entityType: 'Order', entityId: updated.id, payload: { by: user.name, locationId: updated.locationId } }).catch(() => undefined)
  }
  return ok({ order: mapOrder(normalize(updated)) })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  // storno naročila = samo vodstvo (issue #1: pravice na kritičnih operacijah)
  if (user.role !== 'ADMIN' && user.role !== 'MANAGER') return forbidden()
  const { id } = await params
  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: lokacijski gate na storno
  const delGuard = assertResourceLocation(user, order.locationId)
  if (delGuard) return delGuard
  await db.order.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: user.name, cancelledById: user.sub },
  })
  // Issue #11 §3 — storno dogodek
  await publishEvent('OrderCancelled', { entityType: 'Order', entityId: order.id, payload: { by: user.name, locationId: order.locationId, storno: true } }).catch(() => undefined)
  if (order.tableId) {
    await db.table.update({ where: { id: order.tableId }, data: { status: 'cleaning' } })
  }
  return ok({ cancelled: true })
}
