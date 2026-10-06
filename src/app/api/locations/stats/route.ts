import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const locations = await db.location.findMany({
    include: {
      _count: { select: { tables: true, employees: true, orders: true } },
    },
  })
  const stats = await Promise.all(
    locations.map(async (l) => {
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      const today = await db.order.aggregate({
        where: { locationId: l.id, createdAt: { gte: startOfDay }, status: { not: 'CANCELLED' } },
        _sum: { total: true },
        _count: true,
      })
      return {
        id: l.id,
        name: l.name,
        tables: l._count.tables,
        employees: l._count.employees,
        orders: l._count.orders,
        todayOrders: today._count,
        todayRevenue: today._sum.total || 0,
      }
    })
  )
  return ok({ stats })
}
