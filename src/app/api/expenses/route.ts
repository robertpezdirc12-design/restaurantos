import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { num } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.accountsPayable.findMany({ orderBy: { invoiceDate: 'desc' }, take: 100 })
  return ok({
    expenses: rows.map((r) => ({
      id: r.id,
      category: 'OSTALO',
      description: r.invoiceNumber || r.notes || 'Dobaviteljev račun',
      amount: num(r.totalAmount),
      paidAt: r.paidAt || r.invoiceDate,
      locationId: r.locationId,
    })),
  })
}
