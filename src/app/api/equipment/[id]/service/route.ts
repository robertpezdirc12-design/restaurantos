import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, isResponse, requireAnyPermission } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { equipmentTableReady } from '@/lib/equipment-store'
import { equipmentDto, nextDueAtFor, parseServiceInput } from '@/lib/equipment'

/**
 * OSS-1 (v1.200.0) — »SERVIS OPRAVLJEN« (POST /api/equipment/[id]/service).
 *
 * Zabeleži opravljen servis: lastServicedAt = servicedAt (privzeto zdaj),
 * nextDueAt = lastServicedAt + intervalDays (determinističen preizračun).
 * Datum v prihodnosti je napaka (servis se ne napoveduje nazaj v čas —
 * nič ne izmišljamo). Dostop: settings.manage ALI haccp.execute (izvajalci
 * HACCP meritev zabeležijo servis svojih hladilnikov). Do DDL: 503.
 * Audit: EQUIPMENT_SERVICE_LOGGED.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAnyPermission(req, ['settings.manage', 'haccp.execute'])
  if (isResponse(ctx)) return ctx
  const user = ctx.user

  if (!(await equipmentTableReady())) {
    return fail('Vzdrževanje opreme čaka na shemsko migracijo (Enterprise → Shema migracije → equipment-maintenance).', 503)
  }

  const { id } = await params
  const body = await req.json().catch(() => null)
  const parsed = parseServiceInput(body ?? {}, new Date())
  if (!parsed.ok) return fail(parsed.error)

  const existing = await db.equipment.findUnique({ where: { id } })
  if (!existing) return fail('Oprema ne obstaja.', 404)
  const guarded = await guardResource(user, existing.locationId)
  if (guarded) return guarded

  const plan = await db.equipmentMaintenancePlan.findFirst({ where: { equipmentId: id } })
  if (!plan) return fail('Oprema nima servisnega načrta.', 409)

  const nextDueAt = nextDueAtFor(plan.intervalDays, parsed.value.servicedAt, plan.createdAt)
  await db.equipmentMaintenancePlan.update({
    where: { id: plan.id },
    data: {
      lastServicedAt: parsed.value.servicedAt,
      nextDueAt,
      updatedById: user.sub,
    },
  })

  await writeAudit(db, {
    userId: user.sub,
    action: 'EQUIPMENT_SERVICE_LOGGED',
    entityType: 'EquipmentMaintenancePlan',
    entityId: plan.id,
    details: jstr({
      equipmentId: id,
      equipmentName: existing.name,
      servicedAt: parsed.value.servicedAt.toISOString(),
      intervalDays: plan.intervalDays,
      note: parsed.value.note,
    }),
    locationId: existing.locationId,
  })

  const fresh = await db.equipmentMaintenancePlan.findFirst({ where: { equipmentId: id } })
  return ok({ equipment: equipmentDto(existing, fresh ?? null, new Date()) })
}
