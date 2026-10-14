import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, requireAuthWithPerms, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource, isCrossTenantLocations } from '@/lib/tenant'
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
 *
 * Issue #60 (P1) — tenant obseg urnikov:
 *  - PATCH/DELETE: guardResource BREZ POGOVA `if (shift.locationId)` — prej je
 *    legacy zapis z locationId=null PRESKOČIL guard (non-central uporabnik z
 *    timeclock.manage je lahko mutiral/tuji zbrisal nerazrešeno izmeno brez
 *    vsake kontrole). Zdaj: null lokacija → assertResourceLocation fail-closed
 *    (403 za staff/managere; centralna vloga = izrecen dostop, dokumentirano).
 *  - POST: ciljna lokacija je OBVEZNA (400, ko je tudi po fallbacku na
 *    employee.locationId prazna) — novih nerazrešenih izmen z null lokacijo
 *    ni več mogoče ustvariti.
 *  - POST: preveri ORGANIZACIJO ZAPOSLJENEGA (kanonični Employee.locationId)
 *    proti ciljni lokaciji (isCrossTenantLocations) — znana in različna org →
 *    403 (cross-tenant employeeId zavrnjen); medlokacijska razporeditev
 *    ZNOTRAJ iste organizacije je dovoljena (utrjeno poslovno pravilo).
 *  - Job ostaja GLOBALEN vir (brez locationId v shemi) — izrecno dokumentirano
 *    (issue #60: job scope ni tenant-specifičen; isActive + ekspliciten
 *    body.jobId sta edini varovalki).
 *  - DELETE: brisanje + audit vrstica v ISTI transakciji (prej ločeno — padec
 *    audita po uspešnem brisanju bi pustil izmeni brez revizijske sledi).
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
  // Issue #5 (P0 §C): prej requireAuth + CEL seznam izmen lokacije (imena/urice
  // celotne ekipe za vsakega, npr. čistilko) — modulski komentar o UI lastnem
  // filtriranju NI bil res (urnik-izmen-tab ne filtrira po employeeId). Zdaj:
  // lastne izmene za navadne zaposlene; EKIPNI pregled zahteva timeclock.manage
  // (urejanje) ali employees.manage.
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const user = ctx.user
  const teamView = ctx.perms.includes('timeclock.manage') || ctx.perms.includes('employees.manage')
  const { from, to } = weekRange(req.nextUrl.searchParams.get('from'), req.nextUrl.searchParams.get('to'))
  const scope = await locationScope(user)
  const shifts = await db.staffShift.findMany({
    where: {
      shiftDate: { gte: from, lte: to },
      ...scope,
      ...(teamView ? {} : { employeeId: user.sub }),
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

  // Issue #5 (komentar #2): jobId — StaffShift.jobId je v shemi (Job relation) in je
  // bil na tej poti MRTV (create ga nikoli ni shranil, UI tudi ne pošilja). Zdaj:
  // nevaljana vrednost se tiho izpusti (nazajkompatibilno), veljaven Job (aktiven,
  // z aktivno lokacijo) se pripne izmeni — delovni profili (Toast-style job
  // permissions) se gradijo na tem v naslednjem valu.
  const jobCandidate = typeof body?.jobId === 'string' && body.jobId.trim() ? body.jobId.trim() : ''
  const job = jobCandidate ? await db.job.findUnique({ where: { id: jobCandidate } }) : null
  const jobId = job && job.isActive ? job.id : null

  const employee = await db.employee.findUnique({ where: { id: employeeId } })
  if (!employee || employee.status !== 'active') return fail('Zaposleni ne obstaja ali ni aktiven.', 404)
  // #60: ciljna lokacija je OBVEZNA — body.locationId ?? employee.locationId;
  // če je tudi po fallbacku null → 400 (ne ustvarimo novih nerazrešenih izmen,
  // ki bi kasneje obšle guard pri PATCH/DELETE).
  const targetLocationId =
    typeof body?.locationId === 'string' && body.locationId.trim() ? body.locationId.trim() : employee.locationId
  if (!targetLocationId) {
    return fail('Lokacija izmene je obvezna (izrecen locationId ali lokacija zaposlenega) — globalne izmene niso podprte.', 400)
  }
  // #60: guard nad ciljno lokacijo — BREZ POGOVA (prej pogojno; zdaj zavezujoče)
  const guard = await guardResource(user, targetLocationId)
  if (guard) return guard
  // #60: org obseg ZAPOSLJENEGA — kanonična Employee.locationId proti ciljni
  // lokaciji. Znana + različna organizacija → 403 (manager orgA NE more razporediti
  // znanega zaposlenega iz orgB na svojo lokacijo); medlokacijsko znotraj iste org
  // je dovoljeno; employee brez lokacije (legacy) → migracijsko varno dovoljeno
  // (ciljna lokacija je že zgoraj org/lokacijsko preverjena).
  if (await isCrossTenantLocations(employee.locationId, targetLocationId)) {
    return fail('Zaposleni pripada drugi organizaciji kot ciljna lokacija — izmena zavrnjena.', 403)
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
        locationId: targetLocationId,
        status: 'scheduled',
        createdById: user.sub,
        ...(jobId ? { jobId } : {}),
      },
    })
    const __aId = nid()
    const __chain = await auditChainFields(tx, {
      action: 'STAFF_SHIFT_CREATE',
      entityType: 'StaffShift',
      entityId: created.id,
      details: jstr({ employeeId, employee: employee.name, shiftDate: shiftDateRaw, startTime, endTime, shiftType, by: user.name }),
      locationId: targetLocationId,
      id: __aId,
    })
    await tx.auditLog.create({
      data: { ...__chain, id: __aId, userId: user.sub, action: 'STAFF_SHIFT_CREATE', entityType: 'StaffShift', entityId: created.id, details: jstr({ employeeId, employee: employee.name, shiftDate: shiftDateRaw, startTime, endTime, shiftType, by: user.name }), locationId: targetLocationId },
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
  // #60: guard BREZ POGOVA — null lokacija NE preskoči varovalke (prej
  // `if (shift.locationId)` je legacy nerazrešene izmene pustil brez kontrole).
  // assertResourceLocation: non-central + null vir → 403 (fail-closed);
  // centralna vloga = izrecen dostop (dokumentiran nad razredom).
  const guard = await guardResource(user, shift.locationId)
  if (guard) return guard
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
  // #60: guard BREZ POGOVA (enaka fail-closed politika kot PATCH).
  const guard = await guardResource(user, shift.locationId)
  if (guard) return guard
  // #60: brisanje + audit v ISTI transakciji — prej je delete stekel izven,
  // padec kasnejšega audit zapisa pa bi izbrisal izmeno BREZ revizijske sledi.
  // Katerakoli napaka → rollback obeh (izmena ostane, sled ohranjena skladno).
  const __aId = nid()
  await db.$transaction(async (tx) => {
    await tx.staffShift.delete({ where: { id } })
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
