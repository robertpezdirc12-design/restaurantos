import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const errors = await db.auditLog.findMany({ where: { action: { contains: 'ERROR' } }, orderBy: { createdAt: 'desc' }, take: 50 })
  return ok({ errors })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.message) return fail('message je obvezen.')
  const log = await db.auditLog.create({
    data: { employeeId: user.sub, action: 'ERROR_REPORT', entity: 'client', data: JSON.stringify(body).slice(0, 2000) },
  })
  return ok({ log }, 201)
}
