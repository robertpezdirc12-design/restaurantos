import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, locationScope, isResponse, ok } from '@/lib/api'

/**
 * Issue #5 (P0, kommentar #6): prej ročni bypass `isCentralRole ? {}` — centralna
 * vloga je videla VSE lokacije VSEH organizacij (danes-promet vključno). Zdaj
 * uporabljen je locationScope → org allow-lista (Task 54 vzorec). todayRevenue/todayOrders
 * sta finančna kazalnika → samo za reports.view (operativni števci ostanejo vsem).
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const user = ctx.user
  const scope = await locationScope(user)
  const locations = await db.location.findMany({
    // Issue #4 §1: non-central vidi statistiko SAMO svoje lokacije (fail-closed);
    // centralne: org allow-lista (ne več vse organizacije)
    where: { id: scope.locationId ?? undefined },
    include: {
      _count: { select: { Table: true, Employee: true, Order: true } },
    },
  })
  const showRevenue = ctx.perms.includes('reports.sales')
  const stats = await Promise.all(
    locations.map(async (l) => {
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      // števec naročil = operativni podatek; ZNESEK = finančni (samo reports.view)
      const today = await db.order.aggregate({
        where: { locationId: l.id, createdAt: { gte: startOfDay }, status: { not: 'cancelled' } },
        _count: true,
        ...(showRevenue ? { _sum: { total: true } } : {}),
      })
      return {
        id: l.id,
        name: l.name,
        tables: l._count.Table,
        employees: l._count.Employee,
        orders: l._count.Order,
        todayOrders: today._count,
        todayRevenue: showRevenue && today._sum?.total ? Number(today._sum.total) : 0,
      }
    })
  )
  return ok({ stats })
}
