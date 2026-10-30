import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok,
  fail,
  isResponse,
  requireAnyPermission,
  requirePermission,
  requireUserLocation,
  locationScope,
  isCentralRole,
} from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { equipmentTableReady } from '@/lib/equipment-store'
import { equipmentDto, nextDueAtFor, parseEquipmentInput } from '@/lib/equipment'

/**
 * OSS-1 (v1.200.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — vzdrževanje
 * opreme: register naprav + servisni načrti.
 *
 * GET  — seznam opreme v lokacijskem obsegu (staff: izključno svoja lokacija;
 *        centralne: org allow-lista / ?locationId filter; ?status filter),
 *        z IZPELJANIMI overdue zastavicami ob branju (brez cron stanja).
 *        Dostop: settings.manage ALI haccp.execute (branje — izvajalci HACCP
 *        meritev vidijo servisne roke svojih naprav).
 * POST — nova oprema + servisni načrt v ENI transakciji (settings.manage).
 *        Skalarne vezave brez FK (PayrollSurchargeRate konvencija); brisanje
 *        počisti načrte aplikacijsko ([id] DELETE transakcija).
 * Do DDL (Enterprise → Shema migracije → equipment-maintenance): 503.
 */

/** iz { locationId: X | {in: [...]} } naredi where za Location model */
function locationWhereFromScope(scope: { locationId?: string | { in: string[] } }): { id?: string | { in: string[] } } {
  if (!scope.locationId) return {}
  return { id: scope.locationId }
}

export async function GET(req: NextRequest) {
  const ctx = await requireAnyPermission(req, ['settings.manage', 'haccp.execute'])
  if (isResponse(ctx)) return ctx
  const user = ctx.user

  if (!(await equipmentTableReady())) {
    return fail('Vzdrževanje opreme čaka na shemsko migracijo (Enterprise → Shema migracije → equipment-maintenance).', 503)
  }

  const url = new URL(req.url)
  const statusParam = url.searchParams.get('status')
  const locParam = url.searchParams.get('locationId')
  let scope: { locationId?: string | { in: string[] } }
  if (locParam && isCentralRole(user)) {
    const orgGuard = await assertOrgScope(user, locParam)
    if (orgGuard) return orgGuard
    scope = { locationId: locParam }
  } else {
    scope = await locationScope(user)
  }

  const rows = await db.equipment.findMany({
    where: { ...scope, ...(statusParam ? { status: statusParam } : {}) },
    orderBy: [{ name: 'asc' }],
  })
  const ids = rows.map((r) => r.id)
  const plans = ids.length
    ? await db.equipmentMaintenancePlan.findMany({ where: { equipmentId: { in: ids } } })
    : []
  const planByEquipment = new Map(plans.map((p) => [p.equipmentId, p]))
  const now = new Date()

  const locations = await db.location.findMany({
    where: locationWhereFromScope(scope),
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }],
  })

  return ok({
    equipment: rows.map((r) => equipmentDto(r, planByEquipment.get(r.id) ?? null, now)),
    locations,
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  if (!(await equipmentTableReady())) {
    return fail('Vzdrževanje opreme čaka na shemsko migracijo (Enterprise → Shema migracije → equipment-maintenance).', 503)
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const parsed = parseEquipmentInput(body)
  if (!parsed.ok) return fail(parsed.error)

  const locGuard = requireUserLocation(user, body?.locationId)
  if (isResponse(locGuard)) return locGuard
  const locationId = locGuard
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const dupe = await db.equipment.findFirst({
    where: { locationId, name: { equals: parsed.value.name } },
    select: { id: true },
  })
  if (dupe) return fail('Oprema s tem nazivom že obstaja na tej lokaciji.', 409)

  const now = new Date()
  const created = await db.$transaction(async (tx) => {
    const eq = await tx.equipment.create({
      data: {
        id: nid(),
        locationId,
        name: parsed.value.name,
        kind: parsed.value.kind,
        serialNumber: parsed.value.serialNumber,
        installedAt: parsed.value.installedAt,
        status: parsed.value.status,
        notes: parsed.value.notes,
        createdById: user.sub,
      },
    })
    await tx.equipmentMaintenancePlan.create({
      data: {
        id: nid(),
        equipmentId: eq.id,
        title: parsed.value.planTitle,
        intervalDays: parsed.value.intervalDays,
        lastServicedAt: null,
        nextDueAt: nextDueAtFor(parsed.value.intervalDays, null, now),
        active: true,
        updatedById: user.sub,
      },
    })
    return eq
  })

  const plan = await db.equipmentMaintenancePlan.findFirst({ where: { equipmentId: created.id } })

  await writeAudit(db, {
    userId: user.sub,
    action: 'EQUIPMENT_CREATE',
    entityType: 'Equipment',
    entityId: created.id,
    details: jstr({
      locationId,
      name: created.name,
      kind: created.kind,
      intervalDays: parsed.value.intervalDays,
      planTitle: parsed.value.planTitle,
    }),
    locationId,
  })

  return ok({ equipment: equipmentDto(created, plan ?? null, now) }, 201)
}
