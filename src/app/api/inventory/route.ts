import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.inventoryItem.findMany({ orderBy: { name: 'asc' }, take: 100 })
  return ok({ inventory: rows })
}
