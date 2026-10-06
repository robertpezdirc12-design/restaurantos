import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { mapOrder, mapOrderItem, nid, num, r2, itemStatusToDB } from '@/lib/map'

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
  }
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
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalize(order)) })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)

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
      where: { id: { in: body.addItems.map((i: { menuItemId: string }) => i.menuItemId) } },
    })
    const rows = body.addItems.map((i: { menuItemId: string; qty?: number; note?: string }) => {
      const mi = menuItems.find((m) => m.id === i.menuItemId)!
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
    await db.orderItem.createMany({ data: rows })
    const totals = await recalcTotals(id)
    Object.assign(data, totals)
    if (data.status === undefined && order.status === 'open') data.status = 'sent'
  }

  const updated = await db.order.update({ where: { id }, data, include: orderInclude })
  return ok({ order: mapOrder(normalize(updated)) })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  await db.order.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: user.name, cancelledById: user.sub },
  })
  if (order.tableId) {
    await db.table.update({ where: { id: order.tableId }, data: { status: 'cleaning' } })
  }
  return ok({ cancelled: true })
}
