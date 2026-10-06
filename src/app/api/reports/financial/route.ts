import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const [todayPaid, monthPaid, monthExpenses, byTax] = await Promise.all([
    db.order.aggregate({ where: { status: 'PAID', closedAt: { gte: startOfDay } }, _sum: { total: true, tax: true }, _count: true }),
    db.order.aggregate({ where: { status: 'PAID', closedAt: { gte: startOfMonth } }, _sum: { total: true, tax: true }, _count: true }),
    db.expense.aggregate({ where: { paidAt: { gte: startOfMonth } }, _sum: { amount: true } }),
    db.orderItem.groupBy({ by: ['taxRate'], where: { order: { status: 'PAID', closedAt: { gte: startOfMonth } } }, _sum: { qty: true } }),
  ])

  return ok({
    today: { revenue: todayPaid._sum.total || 0, tax: todayPaid._sum.tax || 0, invoices: todayPaid._count },
    month: { revenue: monthPaid._sum.total || 0, tax: monthPaid._sum.tax || 0, invoices: monthPaid._count, expenses: monthExpenses._sum.amount || 0, profit: (monthPaid._sum.total || 0) - (monthExpenses._sum.amount || 0) },
    taxBreakdown: byTax.map((t) => ({ taxRate: t.taxRate, qty: t._sum.qty || 0 })),
  })
}
