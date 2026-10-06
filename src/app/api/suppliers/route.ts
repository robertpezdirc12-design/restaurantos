import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.supplier.findMany({ orderBy: { name: 'asc' }, take: 100 })
  return ok({
    suppliers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      contact: r.contactPerson || null,
      phone: r.phone || null,
      email: r.email || null,
      address: r.address || null,
    })),
  })
}
