import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import { resolvePermissions } from '@/lib/permissions'
import type { AuthPayload } from '@/lib/auth'

/**
 * OPS-7 (v1.69.0) — ZAHTEVE ZA PROSTOST (TimeOffRequest, 7shifts vzorec).
 *
 * GET  → lastne zahteve (vedno) + vseh članov ekipe (perm employees.manage ALI timeclock.manage)
 * POST body: {type, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), reason?}
 *      → nova zahteva: zaposleni zase; manager lahko v imenu drugih (employeeId)
 * PATCH body: {id, status: 'approved'|'rejected'|'cancelled'}
 *      → odobritev/zavrnitev (perm employees.manage); preklic lastne pending zahteve
 *
 * Tipi: vacation|sick|personal|unpaid (prost besedni; UI ponuja standardne).
 */
const TYPES = ['vacation', 'sick', 'personal', 'unpaid']
const DECISIONS = ['approved', 'rejected', 'cancelled']

/** zaposleni z timeclock.manage/employees.manage ali vodstvena vloga ureja zahteve drugih */
async function canManageTeam(user: AuthPayload): Promise<boolean> {
  if (['OWNER', 'ADMIN', 'MANAGER', 'GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER'].includes(user.role)) return true
  const employee = await db.employee.findUnique({ where: { id: user.sub }, select: { role: true, permissionOverrides: true } })
  if (!employee) return false
  const perms = resolvePermissions(employee.role, employee.permissionOverrides)
  return perms.includes('employees.manage') || perms.includes('timeclock.manage')
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const canSeeAll = await canManageTeam(user)
  const rows = await db.timeOffRequest.findMany({
    where: canSeeAll ? { Employee: { locationId: user.loc || undefined } } : { employeeId: user.sub },
    include: { Employee: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return ok({
    requests: rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      employeeName: r.Employee?.name ?? '',
      type: r.type,
      startDate: r.startDate.toISOString(),
      endDate: r.endDate.toISOString(),
      status: r.status,
      reason: r.reason,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
    })),
    canManage: Boolean(canSeeAll),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const startDateRaw = typeof body?.startDate === 'string' ? body.startDate.trim() : ''
  const endDateRaw = typeof body?.endDate === 'string' ? body.endDate.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateRaw)) {
    return fail('startDate in endDate (YYYY-MM-DD) sta obvezna.', 400)
  }
  const type = TYPES.includes(body?.type) ? body.type : 'vacation'
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
  // manager/centralna vloga lahko v imenu drugih; navadni zaposleni samo zase
  let employeeId = user.sub
  if (typeof body?.employeeId === 'string' && body.employeeId.trim() && body.employeeId.trim() !== user.sub) {
    const canForOthers = await canManageTeam(user)
    if (!canForOthers) return fail('Zahteve za druge zaposlene ureja vodstvo.', 403)
    employeeId = body.employeeId.trim()
  }
  const startDate = new Date(`${startDateRaw}T00:00:00`)
  const endDate = new Date(`${endDateRaw}T23:59:59`)
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate < startDate) {
    return fail('Neveljaven obdobje prostosti.', 400)
  }
  const employee = await db.employee.findUnique({ where: { id: employeeId } })
  if (!employee) return fail('Zaposleni ne obstaja.', 404)
  if (employee.locationId) {
    const guard = await guardResource(user, employee.locationId)
    if (guard) return guard
  }
  const row = await db.timeOffRequest.create({
    data: { id: nid(), employeeId, type, startDate, endDate, status: 'pending', reason },
  })
  return ok({ request: { id: row.id } })
}

export async function PATCH(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  const status = typeof body?.status === 'string' ? body.status : ''
  if (!id || !DECISIONS.includes(status)) return fail('id in status (approved|rejected|cancelled) sta obvezna.', 400)

  const row = await db.timeOffRequest.findUnique({ where: { id }, include: { Employee: true } })
  if (!row) return fail('Zahteva ne obstaja.', 404)

  const isOwn = row.employeeId === user.sub
  const canManage = await canManageTeam(user)
  if (status === 'cancelled') {
    if (!isOwn && !canManage) return fail('Samo lastno zahtevo je mogoče preklicati.', 403)
  } else {
    if (!canManage) return fail('Odobritev/zavrnitev je pravica vodstva.', 403)
    if (row.Employee.locationId) {
      const guard = await guardResource(user, row.Employee.locationId)
      if (guard) return guard
    }
  }

  await db.$transaction(async (tx) => {
    await tx.timeOffRequest.update({
      where: { id },
      data: { status, reviewedBy: canManage ? user.sub : row.reviewedBy, reviewedAt: new Date() },
    })
    await writeAudit(tx, { userId: user.sub, action: 'TIME_OFF_DECISION', entityType: 'TimeOffRequest', entityId: id, details: jstr({ status, employeeId: row.employeeId, by: user.name }), locationId: row.Employee.locationId })
  })

  // OPS-8 val 2 (v1.72.0): push to the requester on status change (via notification matrix;
  // fire-and-forget; base target = the requester exactly)
  void pushEvent('TIME_OFF_STATUS', {
    title: 'Status zahteve za prostost',
    body: `${status === 'approved' ? 'Odobreno' : status === 'rejected' ? 'Zavrnjeno' : 'Preklicano'} · ${row.startDate ? new Date(row.startDate).toLocaleDateString('sl-SI') : ''}`,
    url: '/dashboard?tab=urnik',
    tag: `timeoff-${id}`,
  }, { employeeIds: [row.employeeId] })
  return ok({ updated: true })
}
