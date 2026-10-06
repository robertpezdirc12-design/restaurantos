import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({
    where: { id },
    include: { items: true, table: true, employee: { select: { name: true } }, fursInvoices: true },
  })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  return ok({ order })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)

  const order = await db.order.findUnique({ where: { id }, include: { items: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)

  const data: Record<string, unknown> = {}
  if (body?.status && ['OPEN', 'SENT', 'PREPARED', 'PAID', 'CANCELLED'].includes(body.status)) {
    data.status = body.status
    if (body.status === 'PAID' || body.status === 'CANCELLED') {
      data.closedAt = new Date()
      if (order.tableId) {
        await db.table.update({ where: { id: order.tableId }, data: { status: 'DIRTY' } })
      }
    }
  }
  if (body?.guests) data.guests = Number(body.guests)
  if (body?.note !== undefined) data.note = body.note

  // dodajanje artiklov v odprto naročilo
  if (Array.isArray(body?.addItems) && body.addItems.length > 0) {
    const menuItems = await db.menuItem.findMany({
      where: { id: { in: body.addItems.map((i: { menuItemId: string }) => i.menuItemId) } },
    })
    let subtotal = 0
    let tax = 0
    const rows = body.addItems.map((i: { menuItemId: string; qty?: number; note?: string }) => {
      const mi = menuItems.find((m) => m.id === i.menuItemId)!
      const qty = Number(i.qty) || 1
      subtotal += mi.price * qty
      tax += (mi.price * qty * mi.taxRate) / 100
      return {
        orderId: id,
        menuItemId: mi.id,
        name: mi.name,
        qty,
        unitPrice: mi.price,
        taxRate: mi.taxRate,
        station: mi.station,
        status: 'PENDING',
        note: i.note || null,
      }
    })
    await db.orderItem.createMany({ data: rows })
    data.subtotal = order.subtotal + subtotal
    data.tax = order.tax + tax
    data.total = (order.subtotal + subtotal) + (order.tax + tax)
    if (data.status === undefined && order.status === 'OPEN') data.status = 'SENT'
  }

  const updated = await db.order.update({ where: { id }, data, include: { items: true, table: true } })
  return ok({ order: updated })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  await db.order.update({ where: { id }, data: { status: 'CANCELLED', closedAt: new Date() } })
  if (order.tableId) {
    await db.table.update({ where: { id: order.tableId }, data: { status: 'DIRTY' } })
  }
  return ok({ cancelled: true })
}
