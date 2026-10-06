import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { mapMenuItem, num } from '@/lib/map'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return fail('Ni dovoljenj.', 403)
  const { id } = await params
  const body = await req.json().catch(() => null)
  const data: Record<string, unknown> = {}
  if (body?.available !== undefined) data.isAvailable = Boolean(body.available)
  if (body?.price !== undefined) data.price = Number(body.price)
  if (body?.name) data.name = String(body.name)
  if (body?.vatRate !== undefined) data.vatRate = Number(body.vatRate)
  if (Object.keys(data).length === 0) return fail('Ni sprememb.')
  const item = await db.menuItem.update({ where: { id }, data, include: { PrepStation: true, Category: true } })
  return ok({ item: mapMenuItem({ ...item, prepStation: item.PrepStation }) })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return fail('Ni dovoljenj.', 403)
  const { id } = await params
  const inUse = await db.orderItem.count({ where: { menuItemId: id } })
  if (inUse > 0) return fail('Artikel je že uporabljen v naročilih — nastavi kot "Ni na voljo".', 409)
  await db.menuItem.delete({ where: { id } })
  return ok({ deleted: true })
}
