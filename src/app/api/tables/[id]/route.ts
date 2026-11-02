import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { tableStatusToDB, tableStatusToUI, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Issue #4 §1: spreminjanje statusov miz je natakarjska akcija (orders.create).
  // Issue #5 (P0 §C): OPERATIVNI status (natakar) je ločen od TLORISA (posX/posY/zone =
  // konfiguracija prostora → menu.manage, usklajeno z DELETE); prej je orders.create
  // pokrival oboje — natakar je lahko trajno prestavil mize z drag&drop.
  // v1.229.0 (PRIMERJAVA-VMESNIKOV-2026 §4): številka + sedeži sta TUDI konfiguracija
  // prostora ( identiteta mize, ne stanje) → isti menu.manage gate kot tloris.
  const { id } = await params
  const body = await req.json().catch(() => null)
  const isFloorPlan = body?.posX !== undefined || body?.posY !== undefined || body?.zone !== undefined
    || body?.number !== undefined || body?.seats !== undefined
  const user = await requirePermission(req, isFloorPlan ? 'menu.manage' : 'orders.create')
  if (isResponse(user)) return user
  const data: Record<string, unknown> = {}
  if (body?.status) data.status = tableStatusToDB(String(body.status))
  if (body?.posX !== undefined) data.posX = Number(body.posX)
  if (body?.posY !== undefined) data.posY = Number(body.posY)
  if (body?.zone !== undefined) data.area = String(body.zone)
  // v1.229.0: številka mize (celo število ≥ 1) — edinstvena znotraj lokacije (409).
  if (body?.number !== undefined) {
    const n = Number(body.number)
    if (!Number.isInteger(n) || n < 1) return fail('Številka mize mora biti celo število ≥ 1.', 400)
    data.number = n
  }
  // v1.229.0: sedeži (kapaciteta, celo število 1–30 — prag obstaja v UI seeda 1–12).
  if (body?.seats !== undefined) {
    const s = Number(body.seats)
    if (!Number.isInteger(s) || s < 1 || s > 30) return fail('Sedežev mora biti med 1 in 30.', 400)
    data.capacity = s
  }
  if (Object.keys(data).length === 0) return fail('Ni sprememb.')
  const existing = await db.table.findUnique({ where: { id }, select: { locationId: true, number: true, capacity: true, area: true } })
  if (!existing) return fail('Miza ne obstaja.', 404)
  // Issue #4 §1: miza mora pripadati lokaciji uporabnika
  const locRes = await guardResource(user, existing.locationId)
  if (locRes) return locRes
  // v1.229.0: preimenovalni konflikt — številka je unique (number_locationId);
  // eksplicitna 409 z imenom mize, ki jo drži (P2002 past iz POST se tu ne sme ponoviti).
  if (data.number !== undefined && data.number !== existing.number) {
    const clash = await db.table.findUnique({ where: { number_locationId: { number: data.number as number, locationId: existing.locationId } } })
    if (clash) return fail(`Miza s številko ${data.number} že obstaja.`, 409)
  }
  const table = await db.table.update({ where: { id }, data })
  // v1.229.0: revizija konfiguracije (status ostane operativen brez revizije — vsak 15 s
  // cikel bi zasipal verigo; enaka disciplina kot POST/DELETE).
  if (data.number !== undefined || data.capacity !== undefined || data.area !== undefined) {
    await writeAudit(db, { userId: user.sub, action: 'TABLE_UPDATE', entityType: 'Table', entityId: id, details: jstr({ from: { number: existing.number, capacity: existing.capacity, area: existing.area }, to: { number: table.number, capacity: table.capacity, area: table.area } }), locationId: existing.locationId })
  }
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
