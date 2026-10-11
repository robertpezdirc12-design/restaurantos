import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { Prisma } from '@prisma/client'
import {
  breakDeltaMinutes,
  durationLabel,
  isTimeclockStatus,
  payRateToCents,
  timeclockStats,
  totalMinutesCalc,
  totalPayCents,
  validateManualEntry,
} from '@/lib/timeclock'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Delovni čas — clock-in/clock-out (GitLab issue #1, triage ⑥).
 *
 * GET  /api/timeclock
 *   → moja evidenta (zadnjih 30 dni) + aktiven vnos + moje statistike.
 * GET  /api/timeclock?scope=team&days=7&employeeId=&status=
 *   → ekipni vpogled (pravica employees.manage): vnosi po zaposlenih
 *     + skupne statistike + seznam zaposlenih (za ročni vnos).
 *
 * POST /api/timeclock { action: 'clock-in' | 'break-start' | 'break-end' | 'clock-out' }
 *   → samopostrežna ura za prijavljenega zaposlenega; payRate posnetek iz
 *     primarne delovne mesta (EmployeeJob.isPrimary); 409 na nedovoljena stanja.
 * POST /api/timeclock { action: 'manual', employeeId, clockIn, clockOut, breakMinutes?, type?, note? }
 *   → ročni (popravljeni) vnos managerja (pravica employees.manage); status
 *     ostane 'active' do potrditve prek PATCH (jasna recenzija + audit).
 *
 * Ure iz zaključenih vnosov so osnova za delitev napitnin po urah
 * (/api/tips dayBasisRows — obstoječa pot, ki doslej ni imela podatkov).
 * §18: noben obstoječ tok ni spremenjen.
 */

const DAY_MS = 86400_000

function mapEntry(e: {
  id: string
  employeeId: string
  clockIn: Date
  clockOut: Date | null
  breakStart: Date | null
  breakEnd: Date | null
  breakMinutes: number
  totalMinutes: number
  payRate: Prisma.Decimal | number
  totalPay: Prisma.Decimal | number
  type: string
  status: string
  notes: string
  locationId: string | null
  Employee?: { name: string } | null
}) {
  return {
    id: e.id,
    employeeId: e.employeeId,
    employeeName: e.Employee?.name ?? '',
    clockIn: e.clockIn,
    clockOut: e.clockOut,
    breakStart: e.breakStart,
    breakEnd: e.breakEnd,
    breakMinutes: e.breakMinutes,
    totalMinutes: e.totalMinutes,
    payRate: num(e.payRate),
    totalPay: num(e.totalPay),
    type: e.type,
    status: e.status,
    notes: e.notes,
    locationId: e.locationId,
  }
}

/** payRate posnetek (€/h) + jobId iz primarne delovne mesta; 0, če ni nastavljeno */
async function payRateSnapshot(employeeId: string): Promise<{ payRate: number; jobId: string | null }> {
  const job = await db.employeeJob.findFirst({
    where: { employeeId, isPrimary: true },
    select: { jobId: true, payRate: true },
  })
  return { payRate: job ? num(job.payRate) : 0, jobId: job?.jobId ?? null }
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') || 'own'

  if (scope === 'team') {
    const perm = await requirePermission(req, 'employees.manage')
    if (isResponse(perm)) return perm
    const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days') ?? 7) || 7))
    const employeeId = String(url.searchParams.get('employeeId') || '')
    const statusRaw = String(url.searchParams.get('status') || '')
    const where: Prisma.TimeEntryWhereInput = {
      clockIn: { gte: new Date(Date.now() - days * DAY_MS) },
      ...(await locationScope(perm)),
      ...(employeeId ? { employeeId } : {}),
      ...(isTimeclockStatus(statusRaw) ? { status: statusRaw } : {}),
    }
    const rows = await db.timeEntry.findMany({
      where,
      orderBy: { clockIn: 'desc' },
      take: 400,
      include: { Employee: { select: { name: true } } },
    })
    const employees = await db.employee.findMany({
      where: { status: 'active', ...(await locationScope(perm)) },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    })
    const activeNow = rows.filter((r) => r.clockOut === null)
    return ok({
      entries: rows.map(mapEntry),
      employees,
      activeNow: activeNow.map((r) => ({ employeeId: r.employeeId, employeeName: r.Employee?.name ?? '', clockIn: r.clockIn, breakStart: r.breakStart })),
      stats: timeclockStats(rows),
      days,
    })
  }

  // lastna evidenta (vsak prijavljen zaposleni)
  const rows = await db.timeEntry.findMany({
    where: {
      employeeId: user.sub,
      clockIn: { gte: new Date(Date.now() - 30 * DAY_MS) },
    },
    orderBy: { clockIn: 'desc' },
    take: 200,
  })
  const active = rows.find((r) => r.clockOut === null) ?? null
  return ok({
    entries: rows.map(mapEntry),
    activeEntry: active ? mapEntry(active) : null,
    stats: timeclockStats(rows),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)
  const action = String(body?.action || '')

  /* ── ročni vnos managerja (popravek) ── */
  if (action === 'manual') {
    const perm = await requirePermission(req, 'employees.manage')
    if (isResponse(perm)) return perm
    const employeeId = String(body?.employeeId || '')
    if (!employeeId) return fail('Zaposleni je obvezen.', 400)
    const employee = await db.employee.findUnique({ where: { id: employeeId } })
    if (!employee) return fail('Zaposleni ne obstaja.', 404)
    const locRes = await guardResource(perm, employee.locationId)
    if (locRes) return locRes
    const clockInMs = Date.parse(String(body?.clockIn || ''))
    const clockOutMs = Date.parse(String(body?.clockOut || ''))
    const v = validateManualEntry(
      { clockInMs, clockOutMs, breakMinutes: Number(body?.breakMinutes) || 0, type: String(body?.type || 'regular'), note: String(body?.note || '') },
      Date.now(),
    )
    if (!v.ok) return fail(v.error!, 400)
    const val = v.value!
    const { payRate, jobId } = await payRateSnapshot(employeeId)
    const minutes = totalMinutesCalc(val.clockInMs, val.clockOutMs, val.breakMinutes)
    const cents = totalPayCents(minutes, payRateToCents(payRate))
    const entry = await db.timeEntry.create({
      data: {
        id: nid(),
        employeeId,
        jobId,
        clockIn: new Date(val.clockInMs),
        clockOut: new Date(val.clockOutMs),
        breakMinutes: val.breakMinutes,
        totalMinutes: minutes,
        payRate,
        totalPay: cents / 100,
        type: val.type,
        status: 'active',
        notes: val.note || 'Ročni vnos (popravek)',
        locationId: employee.locationId,
      },
    })
    const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'TIMECLOCK_MANUAL', entityType: 'TimeEntry', entityId: entry.id, details: jstr({ employee: employee.name, employeeId, clockIn: new Date(val.clockInMs).toISOString(), clockOut: new Date(val.clockOutMs).toISOString(), breakMinutes: val.breakMinutes, type: val.type, totalMinutes: minutes, totalPay: cents / 100, }), id: __aId2 })
    await db.auditLog.create({
      data: { ...__chain2,
        id: __aId2,
        userId: perm.sub,
        action: 'TIMECLOCK_MANUAL',
        entityType: 'TimeEntry',
        entityId: entry.id,
        details: jstr({
          employee: employee.name, employeeId,
          clockIn: new Date(val.clockInMs).toISOString(), clockOut: new Date(val.clockOutMs).toISOString(),
          breakMinutes: val.breakMinutes, type: val.type, totalMinutes: minutes, totalPay: cents / 100,
        }),
      },
    })
    return ok({ entry: mapEntry({ ...entry, Employee: { name: employee.name } }) }, 201)
  }

  /* ── samopostrežna ura (clock-in / break / clock-out) ── */
  const employee = await db.employee.findUnique({ where: { id: user.sub } })
  if (!employee) return fail('Zaposleni profil ne obstaja za ta račun.', 404)

  const active = await db.timeEntry.findFirst({
    where: { employeeId: user.sub, clockOut: null },
    orderBy: { clockIn: 'desc' },
  })

  if (action === 'clock-in') {
    if (active) return fail('Izmena že teče (od ' + new Date(active.clockIn).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' }) + ').', 409)
    const { payRate, jobId } = await payRateSnapshot(user.sub)
    const now = new Date()
    const entry = await db.timeEntry.create({
      data: {
        id: nid(),
        employeeId: user.sub,
        jobId,
        clockIn: now,
        payRate,
        type: 'regular',
        status: 'active',
        locationId: user.loc || employee.locationId,
      },
    })
    const __aId4 = nid(); const __chain4 = await auditChainFields(db, { action: 'TIMECLOCK_IN', entityType: 'TimeEntry', entityId: entry.id, details: jstr({ employee: employee.name, clockIn: now.toISOString(), payRate, jobId }), id: __aId4 })
    await db.auditLog.create({
      data: { ...__chain4,
        id: __aId4,
        userId: user.sub,
        action: 'TIMECLOCK_IN',
        entityType: 'TimeEntry',
        entityId: entry.id,
        details: jstr({ employee: employee.name, clockIn: now.toISOString(), payRate, jobId }),
      },
    })
    return ok({ entry: mapEntry({ ...entry, Employee: { name: employee.name } }) }, 201)
  }

  if (!active) return fail('Ni aktivne izmene — najprej se prijavi (clock-in).', 409)

  if (action === 'break-start') {
    if (active.breakStart && !active.breakEnd) return fail('Odmor že teče.', 409)
    const now = new Date()
    await db.timeEntry.update({ where: { id: active.id }, data: { breakStart: now, breakEnd: null } })
    const __aId6 = nid(); const __chain6 = await auditChainFields(db, { action: 'TIMECLOCK_BREAK_START', entityType: 'TimeEntry', entityId: active.id, details: jstr({ at: now.toISOString() }), id: __aId6 })
    await db.auditLog.create({
      data: { ...__chain6,
        id: __aId6,
        userId: user.sub,
        action: 'TIMECLOCK_BREAK_START',
        entityType: 'TimeEntry',
        entityId: active.id,
        details: jstr({ at: now.toISOString() }),
      },
    })
    return ok({ ok: true, breakStart: now })
  }

  if (action === 'break-end') {
    if (!active.breakStart || active.breakEnd) return fail('Odmor ni odprt.', 409)
    const now = new Date()
    const delta = breakDeltaMinutes(active.breakStart.getTime(), now.getTime())
    const entry = await db.timeEntry.update({
      where: { id: active.id },
      data: { breakEnd: now, breakMinutes: { increment: delta } },
    })
    const __aId8 = nid(); const __chain8 = await auditChainFields(db, { action: 'TIMECLOCK_BREAK_END', entityType: 'TimeEntry', entityId: active.id, details: jstr({ at: now.toISOString(), deltaMinutes: delta, breakMinutes: entry.breakMinutes }), id: __aId8 })
    await db.auditLog.create({
      data: { ...__chain8,
        id: __aId8,
        userId: user.sub,
        action: 'TIMECLOCK_BREAK_END',
        entityType: 'TimeEntry',
        entityId: active.id,
        details: jstr({ at: now.toISOString(), deltaMinutes: delta, breakMinutes: entry.breakMinutes }),
      },
    })
    return ok({ ok: true, breakMinutes: entry.breakMinutes, deltaMinutes: delta })
  }

  if (action === 'clock-out') {
    const now = new Date()
    let breakMinutes = active.breakMinutes
    const autoBreak = active.breakStart !== null && active.breakEnd === null
    if (autoBreak) {
      breakMinutes += breakDeltaMinutes(active.breakStart!.getTime(), now.getTime())
    }
    // race-safe zaključek: uspe samo, če izmena še teče
    const upd = await db.timeEntry.updateMany({
      where: { id: active.id, clockOut: null },
      data: { clockOut: now, breakEnd: autoBreak ? now : active.breakEnd, breakMinutes },
    })
    if (upd.count === 0) return fail('Izmena je bila vmes zaključena.', 409)
    const minutes = totalMinutesCalc(active.clockIn.getTime(), now.getTime(), breakMinutes)
    const cents = totalPayCents(minutes, payRateToCents(num(active.payRate)))
    const entry = await db.timeEntry.update({
      where: { id: active.id },
      data: { totalMinutes: minutes, totalPay: cents / 100 },
    })
    const __aId10 = nid(); const __chain10 = await auditChainFields(db, { action: 'TIMECLOCK_OUT', entityType: 'TimeEntry', entityId: active.id, details: jstr({ employee: employee.name, clockIn: active.clockIn.toISOString(), clockOut: now.toISOString(), breakMinutes, totalMinutes: minutes, totalPay: cents / 100, autoBreakEnded: autoBreak, }), id: __aId10 })
    await db.auditLog.create({
      data: { ...__chain10,
        id: __aId10,
        userId: user.sub,
        action: 'TIMECLOCK_OUT',
        entityType: 'TimeEntry',
        entityId: active.id,
        details: jstr({
          employee: employee.name, clockIn: active.clockIn.toISOString(), clockOut: now.toISOString(),
          breakMinutes, totalMinutes: minutes, totalPay: cents / 100, autoBreakEnded: autoBreak,
        }),
      },
    })
    return ok({
      entry: mapEntry({ ...entry, Employee: { name: employee.name } }),
      summary: { totalMinutes: minutes, label: durationLabel(minutes), totalPay: cents / 100 },
    })
  }

  return fail('Neznana akcija (clock-in | break-start | break-end | clock-out | manual).', 400)
}
