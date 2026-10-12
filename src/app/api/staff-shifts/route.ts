import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, requireAuth, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * OPS-7 (v1.69.0) — URNIK IZMEN (StaffShift, 7shifts vzorec).
 *
 * GET   /api/staff-shifts?from=YYYY-MM-DD&to=YYYY-MM-DD
 *         → izmene zaposlenih v obdobju (lokacijsko obseg; brez parametrov = trenutni teden)
 * POST  body: {employeeId, shiftDate (ISO datum), shiftType, startTime, endTime,
 *              breakMinutes?, notes?, locationId?}
 *         → nova izmena (perm timeclock.manage)
 * PATCH body: {id, shiftType?, startTime?, endTime?, breakMinutes?, notes?, status?}
 *         → urejanje/preklic izmene (perm timeclock.manage); status preklica → 'cancelled'
 * DELETE body: {id} → briše izmeno (perm timeclock.manage)
 *
 * Statusi (enum StaffShiftStatus): scheduled/confirmed/in_progress/completed/absent/cancelled/no_show.
 * Zaposleni vidi svoje izmene (GET vseeno vmesniško dovoljen vsem avtenticiranim — UI filtrira),
 * urejanje je strogo timeclock.manage (backend fail-closed).
 */
const SHIFT_TYPES = ['morning', 'afternoon', 'evening', 'night', 'split', 'full'] as const
const SHIFT_STATUSES = ['scheduled', 'confirmed', 'in_progress', 'completed', 'absent', 'cancelled', 'no_show'] as const

function weekRange(fromParam: string | null, toParam: string | null): { from: Date; to: Date } {
  const parse = (s: string | null, fallbackOffsetDays: number, startOfWeek = true) => {
    if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(`${s}T00:00:00`)
      if (!Number.isNaN(d.getTime())) return d
    }
    const now = new Date()
    const dow = now.getDay() || 7 // 1..7 (pon..ned)
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (startOfWeek ? 1 - dow : fallbackOffsetDays))
    return d
  }
  const from = parse(fromParam, 0)
  const to = parse(toParam, 0, false)
  if (to.getTime() <= from.getTime()) to.setDate(from.getDate() + 6)
  to.setHours(23, 59, 59, 999)
  return { from, to }
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { from, to } = weekRange(req.nextUrl.searchParams.get('from'), req.nextUrl.searchParams.get('to'))
  const scope = await locationScope(user)
  const shifts = await db.staffShift.findMany({
    where: {
      shiftDate: { gte: from, lte: to },
      ...scope,
    },
    include: { Employee_StaffShift_employeeIdToEmployee: { select: { id: true, name: true, role: true } }, Location: { select: { id: true, name: true } } },
    orderBy: [{ shiftDate: 'asc' }, { startTime: 'asc' }],
  })
  return ok({
    from: from.toISOString(),
    to: to.toISOString(),
    shifts: shifts.map((s) => ({
      id: s.id,
      employeeId: s.employeeId,
      employeeName: s.Employee_StaffShift_employeeIdToEmployee?.name ?? '',
      employeeRole: s.Employee_StaffShift_employeeIdToEmployee?.role ?? '',
      shiftDate: s.shiftDate.toISOString(),
      shiftType: s.shiftType,
      startTime: s.startTime,
      endTime: s.endTime,
      breakMinutes: s.breakMinutes,
      notes: s.notes,
      status: s.status,
      locationId: s.locationId,
      locationName: s.Location?.name ?? '',
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'timeclock.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const employeeId = typeof body?.employeeId === 'string' ? body.employeeId.trim() : ''
  const shiftDateRaw = typeof body?.shiftDate === 'string' ? body.shiftDate.trim() : ''
  const startTime = typeof body?.startTime === 'string' ? body.startTime.trim().slice(0, 5) : ''
  const endTime = typeof body?.endTime === 'string' ? body.endTime.trim().slice(0, 5) : ''
  if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(shiftDateRaw) || !/^\d{1,2}:\d{2}$/.test(startTime) || !/^\d{1,2}:\d{2}$/.test(endTime)) {
    return fail('employeeId, shiftDate (YYYY-MM-DD), startTime in endTime (HH:MM) so obvezni.', 400)
  }
  const shiftType = SHIFT_TYPES.includes(body?.shiftType) ? body.shiftType : 'full'
  const breakMinutes = Math.max(0, Math.min(240, Number(body?.breakMinutes) || 0))
  const notes = typeof body?.notes === 'string' ? body.notes.trim().slice(0, 200) : ''

  const employee = await db.employee.findUnique({ where: { id: employeeId } })
  if (!employee || employee.status !== 'active') return fail('Zaposleni ne obstaja ali ni aktiven.', 404)
  const targetLocationId = typeof body?.locationId === 'string' && body.locationId.trim() ? body.locationId.trim() : employee.locationId
  if (targetLocationId) {
    const guard = await guardResource(user, targetLocationId)
    if (guard) return guard
  }
  const shiftDate = new Date(`${shiftDateRaw}T00:00:00`)
  if (Number.isNaN(shiftDate.getTime())) return fail('Neveljaven datum izmene.', 400)

  const shift = await db.$transaction(async (tx) => {
    const created = await tx.staffShift.create({
      data: {
        id: nid(),
        employeeId,
        shiftDate,
        shiftType,
        startTime,
        endTime,
        breakMinutes,
        notes,
        role: employee.role,
        locationId: targetLocationId || null,
        status: 'scheduled',
        createdById: user.sub,
      },
    })
    const __aId = nid()
    const __chain = await auditChainFields(tx, {
      action: 'STAFF_SHIFT_CREATE',
      entityType: 'StaffShift',
      entityId: created.id,
      details: jstr({ employeeId, employee: employee.name, shiftDate: shiftDateRaw, startTime, endTime, shiftType, by: user.name }),
      locationId: targetLocationId || null,
      id: __aId,
    })
    await tx.auditLog.create({
      data: { ...__chain, id: __aId, userId: user.sub, action: 'STAFF_SHIFT_CREATE', entityType: 'StaffShift', entityId: created.id, details: jstr({ employeeId, employee: employee.name, shiftDate: shiftDateRaw, startTime, endTime, shiftType, by: user.name }), locationId: targetLocationId || null },
    })
    return created
  })
  return ok({ shift: { id: shift.id } })
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'timeclock.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (!id) return fail('id je obvezen.', 400)
  const shift = await db.staffShift.findUnique({ where: { id } })
  if (!shift) return fail('Izmena ne obstaja.', 404)
  if (shift.locationId) {
    const guard = await guardResource(user, shift.locationId)
    if (guard) return guard
  }
  const data: Record<string, unknown> = {}
  if (typeof body?.shiftType === 'string' && SHIFT_TYPES.includes(body.shiftType)) data.shiftType = body.shiftType
  if (typeof body?.startTime === 'string' && /^\d{1,2}:\d{2}$/.test(body.startTime.trim())) data.startTime = body.startTime.trim().slice(0, 5)
  if (typeof body?.endTime === 'string' && /^\d{1,2}:\d{2}$/.test(body.endTime.trim())) data.endTime = body.endTime.trim().slice(0, 5)
  if (body?.breakMinutes !== undefined) data.breakMinutes = Math.max(0, Math.min(240, Number(body.breakMinutes) || 0))
  if (typeof body?.notes === 'string') data.notes = body.notes.trim().slice(0, 200)
  if (typeof body?.status === 'string' && (SHIFT_STATUSES as readonly string[]).includes(body.status)) data.status = body.status
  if (Object.keys(data).length === 0) return fail('Ni sprememb.', 400)

  const __aId = nid()
  await db.$transaction(async (tx) => {
    await tx.staffShift.update({ where: { id }, data })
    const __chain = await auditChainFields(tx, {
      action: 'STAFF_SHIFT_UPDATE',
      entityType: 'StaffShift',
      entityId: id,
      details: jstr({ changes: Object.keys(data), by: user.name }),
      locationId: shift.locationId,
      id: __aId,
    })
    await tx.auditLog.create({
      data: { ...__chain, id: __aId, userId: user.sub, action: 'STAFF_SHIFT_UPDATE', entityType: 'StaffShift', entityId: id, details: jstr({ changes: Object.keys(data), by: user.name }), locationId: shift.locationId },
    })
  })
  return ok({ updated: true })
}

export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'timeclock.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (!id) return fail('id je obvezen.', 400)
  const shift = await db.staffShift.findUnique({ where: { id } })
  if (!shift) return fail('Izmena ne obstaja.', 404)
  if (shift.locationId) {
    const guard = await guardResource(user, shift.locationId)
    if (guard) return guard
  }
  await db.staffShift.delete({ where: { id } })
  const __aId = nid()
  await db.$transaction(async (tx) => {
    const __chain = await auditChainFields(tx, {
      action: 'STAFF_SHIFT_DELETE',
      entityType: 'StaffShift',
      entityId: id,
      details: jstr({ employeeId: shift.employeeId, shiftDate: shift.shiftDate.toISOString(), by: user.name }),
      locationId: shift.locationId,
      id: __aId,
    })
    await tx.auditLog.create({
      data: { ...__chain, id: __aId, userId: user.sub, action: 'STAFF_SHIFT_DELETE', entityType: 'StaffShift', entityId: id, details: jstr({ employeeId: shift.employeeId, shiftDate: shift.shiftDate.toISOString(), by: user.name }), locationId: shift.locationId },
    })
  })
  return ok({ deleted: true })
}
