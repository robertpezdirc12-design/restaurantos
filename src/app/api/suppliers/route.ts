import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { nid } from '@/lib/map'

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

/** Nov dobavitelj — ADMIN/MANAGER. */
export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim()
  if (!name) return ok({ error: 'Naziv dobavitelja je obvezen.' }, 400)
  const exists = await db.supplier.findUnique({ where: { name } })
  if (exists) return ok({ error: 'Dobavitelj s tem nazivom že obstaja.' }, 409)
  const row = await db.supplier.create({
    data: {
      id: nid(),
      name,
      code: `SUP-${nid().slice(0, 8).toUpperCase()}`,
      contactPerson: String(body?.contact || ''),
      phone: String(body?.phone || ''),
      email: String(body?.email || ''),
      address: String(body?.address || ''),
    },
  })
  return ok({ supplier: { id: row.id, name: row.name } }, 201)
}
