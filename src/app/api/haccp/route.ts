import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { num } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.haccpEntry.findMany({ orderBy: { date: 'desc' }, take: 100 })
  return ok({
    haccpChecks: rows.map((r) => ({
      id: r.id,
      type: r.category.toUpperCase(),
      target: r.title,
      value: r.value ? num(r.value) : null,
      ok: r.status === 'ok',
      note: r.description || null,
      employeeId: r.employeeName || null,
      checkedAt: r.date,
      locationId: r.locationId,
    })),
  })
}
