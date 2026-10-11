import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { num } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  // Issue #4 §1: vsi finančni agregati so location-scoped (centralne vloge vidijo vse)
  const scope = await locationScope(user)
  const [todayPaid, monthPaid, monthExpenses, byTax] = await Promise.all([
    db.order.aggregate({
      where: { paymentStatus: 'paid', paidAt: { gte: startOfDay }, ...scope },
      _sum: { total: true, tax: true },
      _count: true,
    }),
    db.order.aggregate({
      where: { paymentStatus: 'paid', paidAt: { gte: startOfMonth }, ...scope },
      _sum: { total: true, tax: true },
      _count: true,
    }),
    db.accountsPayable.aggregate({
      // Task 61: preklicani stroški (status 'void' — mehki DELETE) ne smejo bati
      // mesečnih stroškov; izključeni so tudi iz reports/export (status bucket je ločen).
      where: { invoiceDate: { gte: startOfMonth }, status: { not: 'void' }, ...scope },
      _sum: { totalAmount: true },
    }),
    db.orderItem.groupBy({
      by: ['vatRate'],
      where: { Order: { paymentStatus: 'paid', paidAt: { gte: startOfMonth }, ...scope } },
      _sum: { quantity: true },
    }),
  ])

  const monthRevenue = monthPaid._sum.total ? num(monthPaid._sum.total) : 0
  const monthExpense = monthExpenses._sum.totalAmount ? num(monthExpenses._sum.totalAmount) : 0

  return ok({
    today: {
      revenue: todayPaid._sum.total ? num(todayPaid._sum.total) : 0,
      tax: todayPaid._sum.tax ? num(todayPaid._sum.tax) : 0,
      invoices: todayPaid._count,
    },
    month: {
      revenue: monthRevenue,
      tax: monthPaid._sum.tax ? num(monthPaid._sum.tax) : 0,
      invoices: monthPaid._count,
      expenses: monthExpense,
      profit: monthRevenue - monthExpense,
    },
    taxBreakdown: byTax.map((t) => ({ taxRate: num(t.vatRate, 22), qty: t._sum.quantity || 0 })),
  })
}
