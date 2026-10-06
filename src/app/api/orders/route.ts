import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import {
  mapOrder, mapOrderItem, orderTypeToDB, orderStatusToUI,
  nid, num, r2, ORDER_ACTIVE_DB,
} from '@/lib/map'

const orderInclude = {
  OrderItem: { include: { MenuItem: { include: { PrepStation: true } } } },
  Table: true,
  Employee_Order_employeeIdToEmployee: { select: { id: true, name: true, role: true } },
  Receipt: { orderBy: { createdAt: 'desc' as const } },
} as const

/** Normalizacija produkcijske vrstice -> mapper pričakovana oblika */
function normalize(o: Record<string, unknown>) {
  return {
    ...o,
    items: o.OrderItem,
    table: o.Table,
    employee: o.Employee_Order_employeeIdToEmployee,
  }
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const status = req.nextUrl.searchParams.get('status')
  const where = status
    ? { status: status.toLowerCase() }
    : { status: { in: ORDER_ACTIVE_DB } }
  const orders = await db.order.findMany({
    where,
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({ orders: orders.map((o) => mapOrder(normalize(o))) })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
    return fail('Naročilo mora vsebovati vsaj en artikel.')
  }
  const menuItemIds = body.items.map((i: { menuItemId: string }) => i.menuItemId)
  const menuItems = await db.menuItem.findMany({
    where: { id: { in: menuItemIds } },
    include: { PrepStation: true },
  })
  if (menuItems.length === 0) return fail('Artikli ne obstajajo.')

  let subtotal = 0
  let tax = 0
  const itemRows = body.items.map((i: { menuItemId: string; qty?: number; note?: string }) => {
    const mi = menuItems.find((m) => m.id === i.menuItemId)
    if (!mi) throw new Error('Artikel ne obstaja')
    const qty = Math.max(1, Math.round(Number(i.qty) || 1))
    const price = num(mi.price)
    const vatRate = num(mi.vatRate, 22)
    const line = price * qty
    const vat = (line * vatRate) / 100
    subtotal += line
    tax += vat
    return {
      id: nid(),
      menuItemId: mi.id,
      quantity: qty,
      price,
      vatRate,
      vatAmount: vat,
      menuItemName: mi.name,
      status: 'pending' as const,
      notes: i.note || '',
      modifiersJson: '[]',
    }
  })

  const locationId = user.loc || (await db.location.findFirst())?.id
  if (!locationId) return fail('Ni lokacije. Najprej ustvari lokacijo.', 400)
  const maxNumber = await db.order.aggregate({ where: { locationId }, _max: { orderNumber: true } })
  const orderNumber = (maxNumber._max.orderNumber || 0) + 1

  const order = await db.order.create({
    data: {
      id: nid(),
      orderNumber,
      locationId,
      tableId: body.tableId || null,
      employeeId: user.sub,
      type: orderTypeToDB(body.type || 'DINE_IN'),
      status: 'open',
      paymentStatus: 'unpaid',
      notes: body.note || '',
      subtotal: r2(subtotal),
      tax: r2(tax),
      total: r2(subtotal + tax),
      splitCount: Number(body.guests) || 1,
      OrderItem: { create: itemRows },
    },
    include: orderInclude,
  })

  if (order.tableId) {
    await db.table.update({ where: { id: order.tableId }, data: { status: 'occupied' } })
  }
  return ok({ order: mapOrder(normalize(order)) }, 201)
}
