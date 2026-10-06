import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return fail('Ni dovoljenj.', 403)
  const { id } = await params
  const body = await req.json().catch(() => null)
  const data: Record<string, unknown> = {}
  if (body?.available !== undefined) data.available = Boolean(body.available)
  if (body?.price !== undefined) data.price = Number(body.price)
  if (body?.name) data.name = String(body.name)
  if (Object.keys(data).length === 0) return fail('Ni sprememb.')
  const item = await db.menuItem.update({ where: { id }, data })
  return ok({ item })
}
