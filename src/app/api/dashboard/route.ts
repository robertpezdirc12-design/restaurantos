import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { num, ORDER_ACTIVE_DB } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const locationId = user.loc || (await db.location.findFirst())?.id
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const [activeOrders, openTables, menuCount, employees, todayOrders, paidToday, topItemsRaw] = await Promise.all([
    db.order.count({ where: { status: { in: ORDER_ACTIVE_DB } } }),
    db.table.count({ where: { status: 'occupied' } }),
    db.menuItem.count({ where: { isAvailable: true } }),
    db.employee.count({ where: { status: 'active' } }),
    db.order.findMany({
      where: { locationId, createdAt: { gte: startOfDay }, status: { not: 'cancelled' } },
      select: { total: true, status: true },
    }),
    db.order.aggregate({
      where: { locationId, paymentStatus: 'paid', paidAt: { gte: startOfDay } },
      _sum: { total: true },
      _count: true,
    }),
    db.orderItem.groupBy({
      by: ['menuItemName'],
      where: { Order: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) }, status: { not: 'cancelled' } } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    }),
  ])

  const todayRevenue = todayOrders.reduce((s, o) => s + num(o.total), 0)

  return ok({
    stats: {
      activeOrders,
      openTables,
      menuItems: menuCount,
      employees,
      todayOrders: todayOrders.length,
      todayRevenue,
      paidToday: { count: paidToday._count, total: paidToday._sum.total ? num(paidToday._sum.total) : 0 },
    },
    topItems: topItemsRaw.map((t) => ({ name: t.menuItemName, qty: t._sum.quantity || 0 })),
  })
}
