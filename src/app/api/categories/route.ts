import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { mapCategory } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.category.findMany({ orderBy: { sortOrder: 'asc' }, take: 100 })
  return ok({ categories: rows.map(mapCategory) })
}
