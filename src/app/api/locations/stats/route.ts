import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const locations = await db.location.findMany({
    include: {
      _count: { select: { Table: true, Employee: true, Order: true } },
    },
  })
  const stats = await Promise.all(
    locations.map(async (l) => {
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      const today = await db.order.aggregate({
        where: { locationId: l.id, createdAt: { gte: startOfDay }, status: { not: 'cancelled' } },
        _sum: { total: true },
        _count: true,
      })
      return {
        id: l.id,
        name: l.name,
        tables: l._count.Table,
        employees: l._count.Employee,
        orders: l._count.Order,
        todayOrders: today._count,
        todayRevenue: today._sum.total ? Number(today._sum.total) : 0,
      }
    })
  )
  return ok({ stats })
}
