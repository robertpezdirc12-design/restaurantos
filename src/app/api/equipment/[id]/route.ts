import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, isResponse, requirePermission } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { equipmentTableReady } from '@/lib/equipment-store'
import {
  equipmentDto,
  nextDueAtFor,
  parseEquipmentPatch,
  type ParsedEquipmentPatch,
} from '@/lib/equipment'

/**
 * OSS-1 (v1.200.0) — PATCH/DELETE enote opreme (settings.manage).
 *
 * PATCH — polja opreme in/ali servisnega načrta (interval/naslov/pavza);
 *         sprememba intervala PREIZRAČUNA nextDueAt iz zadnjega servisa
 *         (deterministično, brez skritega zgodnjega uvajanja).
 * DELETE — transakcija: počisti servisne načrte (aplikacijska integriteta —
 *          skalarne vezave brez FK) + enota.
 * Do DDL: 503. Audit: EQUIPMENT_UPDATED / EQUIPMENT_DELETED.
 */

/** Razdeli patch na polja opreme in polja načrta. */
function splitPatch(p: ParsedEquipmentPatch): {
  eq: Partial<{
    name: string
    kind: string
    serialNumber: string | null
    installedAt: Date | null
    status: string
    notes: string | null
  }>
  plan: Partial<{ title: string; intervalDays: number; active: boolean }>
} {
  const { name, kind, serialNumber, installedAt, status, notes, intervalDays, planTitle, planActive } = p
  const eq: { name?: string; kind?: string; serialNumber?: string | null; installedAt?: Date | null; status?: string; notes?: string | null } = {}
  if (name !== undefined) eq.name = name
  if (kind !== undefined) eq.kind = kind
  if (serialNumber !== undefined) eq.serialNumber = serialNumber
  if (installedAt !== undefined) eq.installedAt = installedAt
  if (status !== undefined) eq.status = status
  if (notes !== undefined) eq.notes = notes
  const plan: { title?: string; intervalDays?: number; active?: boolean } = {}
  if (planTitle !== undefined) plan.title = planTitle
  if (intervalDays !== undefined) plan.intervalDays = intervalDays
  if (planActive !== undefined) plan.active = planActive
  return { eq, plan }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  if (!(await equipmentTableReady())) {
    return fail('Vzdrževanje opreme čaka na shemsko migracijo (Enterprise → Shema migracije → equipment-maintenance).', 503)
  }

  const { id } = await params
  const body = await req.json().catch(() => null)
  const parsed = parseEquipmentPatch(body)
  if (!parsed.ok) return fail(parsed.error)

  const { eq, plan: planPatch } = splitPatch(parsed.value)
  if (Object.keys(eq).length === 0 && Object.keys(planPatch).length === 0) {
    return fail('Ni sprememb — podajte vsaj eno polje.')
  }

  const existing = await db.equipment.findUnique({ where: { id } })
  if (!existing) return fail('Oprema ne obstaja.', 404)
  const guarded = await guardResource(user, existing.locationId)
  if (guarded) return guarded

  const updated = await db.$transaction(async (tx) => {
    if (Object.keys(eq).length > 0) {
      await tx.equipment.update({ where: { id }, data: eq })
    }
    if (Object.keys(planPatch).length > 0) {
      const plan = await tx.equipmentMaintenancePlan.findFirst({ where: { equipmentId: id } })
      if (plan) {
        const intervalDays = planPatch.intervalDays ?? plan.intervalDays
        const nextDueAt = nextDueAtFor(intervalDays, plan.lastServicedAt, plan.createdAt)
        await tx.equipmentMaintenancePlan.update({
          where: { id: plan.id },
          data: { ...planPatch, nextDueAt, updatedById: user.sub },
        })
      } else {
        const now = new Date()
        await tx.equipmentMaintenancePlan.create({
          data: {
            id: nid(),
            equipmentId: id,
            title: planPatch.title ?? 'Servis',
            intervalDays: planPatch.intervalDays ?? 90,
            nextDueAt: nextDueAtFor(planPatch.intervalDays ?? 90, null, now),
            active: planPatch.active ?? true,
            updatedById: user.sub,
          },
        })
      }
    }
    return tx.equipment.findUnique({ where: { id } })
  })

  const plan = await db.equipmentMaintenancePlan.findFirst({ where: { equipmentId: id } })

  await writeAudit(db, {
    userId: user.sub,
    action: 'EQUIPMENT_UPDATED',
    entityType: 'Equipment',
    entityId: id,
    details: jstr({ locationId: existing.locationId, patch: parsed.value }),
    locationId: existing.locationId,
  })

  return ok({ equipment: equipmentDto(updated ?? existing, plan ?? null, new Date()) })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  if (!(await equipmentTableReady())) {
    return fail('Vzdrževanje opreme čaka na shemsko migracijo (Enterprise → Shema migracije → equipment-maintenance).', 503)
  }

  const { id } = await params
  const existing = await db.equipment.findUnique({ where: { id } })
  if (!existing) return fail('Oprema ne obstaja.', 404)
  const guarded = await guardResource(user, existing.locationId)
  if (guarded) return guarded

  await db.$transaction(async (tx) => {
    await tx.equipmentMaintenancePlan.deleteMany({ where: { equipmentId: id } })
    await tx.equipment.delete({ where: { id } })
    await writeAudit(tx, {
      userId: user.sub,
      action: 'EQUIPMENT_DELETED',
      entityType: 'Equipment',
      entityId: id,
      details: jstr({ locationId: existing.locationId, name: existing.name }),
      locationId: existing.locationId,
    })
  })

  return ok({ deleted: id })
}
