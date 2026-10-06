import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const locationId = user.loc || (await db.location.findFirst())?.id
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const [activeOrders, openTables, menuCount, employees, todayOrders, paidToday, topItemsRaw] = await Promise.all([
    db.order.count({ where: { status: { in: ['OPEN', 'SENT', 'PREPARED'] } } }),
    db.table.count({ where: { status: 'OCCUPIED' } }),
    db.menuItem.count({ where: { available: true } }),
    db.employee.count({ where: { active: true } }),
    db.order.findMany({
      where: { locationId, createdAt: { gte: startOfDay }, status: { not: 'CANCELLED' } },
      select: { total: true, status: true },
    }),
    db.order.aggregate({ where: { locationId, status: 'PAID', closedAt: { gte: startOfDay } }, _sum: { total: true }, _count: true }),
    db.orderItem.groupBy({
      by: ['name'],
      where: { order: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } } },
      _sum: { qty: true },
      orderBy: { _sum: { qty: 'desc' } },
      take: 5,
    }),
  ])

  const todayRevenue = todayOrders.filter((o) => o.status !== 'CANCELLED').reduce((s, o) => s + o.total, 0)

  return ok({
    stats: {
      activeOrders,
      openTables,
      menuItems: menuCount,
      employees,
      todayOrders: todayOrders.length,
      todayRevenue,
      paidToday: { count: paidToday._count, total: paidToday._sum.total || 0 },
    },
    topItems: topItemsRaw.map((t) => ({ name: t.name, qty: t._sum.qty || 0 })),
  })
}
