import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const employees = await db.employee.findMany({
    select: { id: true, name: true, email: true, role: true, active: true, language: true, locationId: true },
    orderBy: { name: 'asc' },
  })
  return ok({ employees })
}
