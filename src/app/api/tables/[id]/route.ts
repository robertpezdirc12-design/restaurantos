import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const data: Record<string, unknown> = {}
  if (body?.status) data.status = String(body.status)
  if (body?.posX !== undefined) data.posX = Number(body.posX)
  if (body?.posY !== undefined) data.posY = Number(body.posY)
  if (Object.keys(data).length === 0) return fail('Ni sprememb.')
  const table = await db.table.update({ where: { id }, data })
  return ok({ table })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (user.role !== 'ADMIN') return fail('Samo skrbnik lahko briše mize.', 403)
  const { id } = await params
  await db.table.delete({ where: { id } })
  return ok({ deleted: true })
}
