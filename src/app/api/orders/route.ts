import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const status = req.nextUrl.searchParams.get('status')
  const orders = await db.order.findMany({
    where: status ? { status: status.toUpperCase() } : { status: { in: ['OPEN', 'SENT', 'PREPARED'] } },
    include: { table: { select: { id: true, name: true, zone: true } }, items: true, employee: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({ orders })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
    return fail('Naročilo mora vsebovati vsaj en artikel.')
  }
  const menuItemIds = body.items.map((i: { menuItemId: string }) => i.menuItemId)
  const menuItems = await db.menuItem.findMany({ where: { id: { in: menuItemIds } } })
  if (menuItems.length === 0) return fail('Artikli ne obstajajo.')

  let subtotal = 0
  let tax = 0
  const itemRows = body.items.map((i: { menuItemId: string; qty?: number; note?: string }) => {
    const mi = menuItems.find((m) => m.id === i.menuItemId)
    if (!mi) throw new Error('Artikel ne obstaja')
    const qty = Number(i.qty) || 1
    subtotal += mi.price * qty
    tax += (mi.price * qty * mi.taxRate) / 100
    return {
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

  const locationId = user.loc || (await db.location.findFirst())?.id || ''
  const order = await db.order.create({
    data: {
      locationId,
      tableId: body.tableId || null,
      employeeId: user.sub,
      type: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(body.type) ? body.type : 'DINE_IN',
      guests: Number(body.guests) || 1,
      note: body.note || null,
      status: 'OPEN',
      subtotal,
      tax,
      total: subtotal + tax,
      items: { create: itemRows },
    },
    include: { items: true, table: true },
  })

  if (order.tableId) {
    await db.table.update({ where: { id: order.tableId }, data: { status: 'OCCUPIED' } })
  }
  return ok({ order }, 201)
}
