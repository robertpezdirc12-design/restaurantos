import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { tableStatusToDB, tableStatusToUI } from '@/lib/map'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Issue #4 §1: spreminjanje statusov miz je natakrjska akcija (orders.create)
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const data: Record<string, unknown> = {}
  if (body?.status) data.status = tableStatusToDB(String(body.status))
  if (body?.posX !== undefined) data.posX = Number(body.posX)
  if (body?.posY !== undefined) data.posY = Number(body.posY)
  if (body?.zone !== undefined) data.area = String(body.zone)
  if (Object.keys(data).length === 0) return fail('Ni sprememb.')
  const existing = await db.table.findUnique({ where: { id }, select: { locationId: true } })
  if (!existing) return fail('Miza ne obstaja.', 404)
  // Issue #4 §1: miza mora pripadati lokaciji uporabnika
  const locRes = await guardResource(user, existing.locationId)
  if (locRes) return locRes
  const table = await db.table.update({ where: { id }, data })
  return ok({ table: { ...table, status: tableStatusToUI(table.status) } })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // P2 audit N1: brisanje miz = konfiguracija prostora — kanonično dovoljenje menu.manage
  // (ROLE_DEFAULTS: owner/admin/manager → OWNER/MANAGER nista več blokirana, ADMIN ostane;
  // staff/waiter/bar/chef/kitchen → 403). Lokacijski gate ostaja.
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const existing = await db.table.findUnique({ where: { id }, select: { locationId: true, number: true } })
  if (!existing) return fail('Miza ne obstaja.', 404)
  // Issue #4 §1: brisanje tujokra lokacijskega vira je zavrnjeno (fail-closed)
  const locRes = await guardResource(user, existing.locationId)
  if (locRes) return locRes
  await db.table.delete({ where: { id } })
  // 33-c (audit §6): brisanje mize je zdaj revidirano (prej brez revizije)
  await writeAudit(db, { userId: user.sub, action: 'TABLE_DELETE', entityType: 'Table', entityId: id, details: jstr({ number: existing.number }), locationId: existing.locationId })
  return ok({ deleted: true })
}
