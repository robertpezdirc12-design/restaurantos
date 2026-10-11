import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import {
  canTransitionStatus,
  isTimeclockType,
  payRateToCents,
  totalMinutesCalc,
  totalPayCents,
  transitionStatusError,
  type TimeclockStatus,
  type TimeclockType,
} from '@/lib/timeclock'
import { auditChainFields } from '@/lib/audit-chain'

const FUTURE_SKEW_MS = 5 * 60 * 1000

/**
 * Recenzija + popravljanje vnosa delovnega časa (pravica employees.manage).
 *
 * PATCH /api/timeclock/[id]
 *   { status: 'approved' | 'disputed' }                  → menedžerska recenzija
 *   { clockIn?, clockOut?, breakMinutes?, type?, note? } → popravek časov
 *     (totalMinutes/totalPay se preračunajo iz posnetka payRate vnosu).
 * Location fail-closed (issue #4 §1): recenzija vnosa tujega zaposlenega → 403.
 * Audit TIMECLOCK_UPDATE z before/after.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const entry = await db.timeEntry.findUnique({
    where: { id },
    include: { Employee: { select: { id: true, name: true, locationId: true } } },
  })
  if (!entry) return fail('Vnos delovnega časa ne obstaja.', 404)

  const locRes = await guardResource(user, entry.Employee?.locationId ?? entry.locationId)
  if (locRes) return locRes

  const before = {
    status: entry.status,
    clockIn: entry.clockIn.toISOString(),
    clockOut: entry.clockOut ? entry.clockOut.toISOString() : null,
    breakMinutes: entry.breakMinutes,
    type: entry.type,
    notes: entry.notes,
    totalMinutes: entry.totalMinutes,
    totalPay: num(entry.totalPay),
  }

  const data: Record<string, unknown> = {}

  // 1) recenzija (approve/dispute)
  if (body.status !== undefined) {
    const to = String(body.status)
    const from = entry.status as TimeclockStatus
    if (!canTransitionStatus(from, to as TimeclockStatus)) {
      return fail(transitionStatusError(from, to as TimeclockStatus), 409)
    }
    data.status = to
  }

  // 2) popravek časov / tipa / opombe
  const hasTimeEdit = body.clockIn !== undefined || body.clockOut !== undefined || body.breakMinutes !== undefined || body.type !== undefined || body.note !== undefined
  if (hasTimeEdit) {
    const clockInMs = body.clockIn !== undefined ? Date.parse(String(body.clockIn)) : entry.clockIn.getTime()
    const clockOutMs = body.clockOut !== undefined ? (body.clockOut === null ? NaN : Date.parse(String(body.clockOut))) : entry.clockOut ? entry.clockOut.getTime() : NaN
    if (!Number.isFinite(clockInMs)) return fail('Neveljaven čas prijave.', 400)
    if (!Number.isFinite(clockOutMs)) return fail('Neveljaven čas odjave (vnos mora biti zaključen).', 400)
    if (clockOutMs <= clockInMs) return fail('Čas odjave mora biti za časom prijave.', 400)
    if (clockInMs > Date.now() + FUTURE_SKEW_MS) return fail('Prijava ne sme biti v prihodnosti.', 400)
    const breakMinutes = body.breakMinutes !== undefined ? Math.max(0, Math.round(Number(body.breakMinutes) || 0)) : entry.breakMinutes
    const gross = Math.round((clockOutMs - clockInMs) / 60000)
    if (breakMinutes > gross) return fail(`Odmor (${breakMinutes} min) ne sme biti daljši od izmene (${gross} min).`, 400)
    const type = body.type !== undefined ? String(body.type) : entry.type
    if (!isTimeclockType(type)) return fail('Neznan tip vnosa.', 400)
    if (body.note !== undefined) data.notes = String(body.note || '').trim().slice(0, 500)
    data.clockIn = new Date(clockInMs)
    data.clockOut = new Date(clockOutMs)
    data.breakStart = null
    data.breakEnd = null
    data.breakMinutes = breakMinutes
    data.type = type as TimeclockType
    const minutes = totalMinutesCalc(clockInMs, clockOutMs, breakMinutes)
    const cents = totalPayCents(minutes, payRateToCents(num(entry.payRate)))
    data.totalMinutes = minutes
    data.totalPay = cents / 100
  }

  if (Object.keys(data).length === 0) return fail('Ni sprememb (status ali časovna polja).', 400)

  const updated = await db.timeEntry.update({ where: { id }, data })

  const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'TIMECLOCK_UPDATE', entityType: 'TimeEntry', entityId: id, details: jstr({ employee: entry.Employee?.name ?? entry.employeeId, before, after: { status: updated.status, clockIn: updated.clockIn.toISOString(), clockOut: updated.clockOut ? updated.clockOut.toISOString() : null, breakMinutes: updated.breakMinutes, type: updated.type, totalMinutes: updated.totalMinutes, totalPay: num(updated.totalPay), }, }), id: __aId2 })
  await db.auditLog.create({
    data: { ...__chain2,
      id: __aId2,
      userId: user.sub,
      action: 'TIMECLOCK_UPDATE',
      entityType: 'TimeEntry',
      entityId: id,
      details: jstr({
        employee: entry.Employee?.name ?? entry.employeeId,
        before,
        after: {
          status: updated.status,
          clockIn: updated.clockIn.toISOString(),
          clockOut: updated.clockOut ? updated.clockOut.toISOString() : null,
          breakMinutes: updated.breakMinutes,
          type: updated.type,
          totalMinutes: updated.totalMinutes,
          totalPay: num(updated.totalPay),
        },
      }),
    },
  })

  return ok({ entry: { ...updated, employeeName: entry.Employee?.name ?? '' } })
}
