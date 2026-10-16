import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num } from '@/lib/map'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { payrollTablesReady } from '@/lib/payroll-schema'
import {
  exceptionsSummary,
  findPayrollExceptions,
  periodDto,
  toEntryRow,
  totalsOfRows,
  type PayrollEntryRow,
  type PayrollPeriodRow,
  type TipExportRow,
} from '@/lib/payroll'

/**
 * Issue #22 (P2, v1.115.0) — ZAKLEP obračunskega obdobja.
 *
 * POST /api/payroll/[id]/close  { note?: string (≤ 500), acknowledgeExceptions?: boolean }
 *   → status draft → closed + SNAPSHOT vsot (samo approved gre v plačilno
 *     osnovo: netMinutesApproved/grossPayCents; napitnine cash/card/pending/paid
 *     iz bazenov obdobja) + version = 1 + reopenCount. Izjeme (OPEN_ENTRY/
 *     UNAPPROVED/…) NE blokirajo same po sebi — zahtevajo IZRECNO potrditev
 *     (acknowledgeExceptions: true); sicer 409 + povzetek izjem ({ code: count }),
 *     da UI pokaže checklist. Sočasen zaklep: CAS updateMany (status 'draft')
 *     + ANCHOR na vrstici lokacije (vzorec #63) — dvojni klik nikoli ne zaklene
 *     dvakrat. Audit PAYROLL_PERIOD_CLOSED (števci, NE vrstice/PII).
 *
 * PRE-DDL: probe payrollTablesReady → 503 (graceful).
 */

const CLOSE_NOTE_MAX = 500

/**
 * Naloži vse podatke obdobja (ISTE poizvedbe kot GET /api/payroll/[id] —
 * snapshot zaklepa izhaja iz istih vrstic kot izvoz/detail; konvencije sidro:
 * OR [TimeEntry.locationId, Employee.locationId], TipPool.date UTC polnoč).
 */
async function loadPeriodData(period: PayrollPeriodRow): Promise<{
  rows: PayrollEntryRow[]
  tips: TipExportRow[]
  pools: { id: string; poolDate: string; status: string; cashCents: number; cardCents: number; totalCents: number }[]
  entries: Parameters<typeof findPayrollExceptions>[0]
  shifts: Parameters<typeof findPayrollExceptions>[1]
  employeeJobs: Parameters<typeof findPayrollExceptions>[2]
}> {
  const locId = period.locationId
  const window = { gte: period.periodStart, lt: period.periodEnd }

  const [entries, shifts, tipPools] = await Promise.all([
    db.timeEntry.findMany({
      where: {
        // OR sidro (tips dayBasisRows konvencija): vnos z lokacijo obdobja ALI
        // vnos zaposlenega z lokacijo obdobja
        OR: [{ locationId: locId }, { Employee: { locationId: locId } }],
        clockIn: window,
      },
      include: {
        Employee: { select: { id: true, name: true, locationId: true } },
        Job: { select: { id: true, name: true } },
      },
      orderBy: { clockIn: 'asc' },
    }),
    db.staffShift.findMany({
      // isti OR sidro kot vnosi (izmena brez lokacije = po zaposlenem);
      // relacija na zaposlenega nosi sestavljeno ime (dve Employee vezavi v
      // modelu StaffShift) — uporabimo employeeId vezavo
      where: { OR: [{ locationId: locId }, { Employee_StaffShift_employeeIdToEmployee: { locationId: locId } }], shiftDate: window },
      include: { Employee_StaffShift_employeeIdToEmployee: { select: { id: true, name: true, locationId: true } } },
      orderBy: { shiftDate: 'asc' },
    }),
    db.tipPool.findMany({
      // TipPool.date = UTC polnoč poslovnega dne (tips dayRange konvencija)
      where: { locationId: locId, date: window },
      include: { TipDistribution: { include: { Employee: { select: { id: true, name: true } } } } },
      orderBy: { date: 'asc' },
    }),
  ])

  const employeeIds = [...new Set(entries.map((e) => e.employeeId))]
  const employeeJobs = employeeIds.length
    ? await db.employeeJob.findMany({
        where: { employeeId: { in: employeeIds } },
        include: { Job: { select: { id: true, name: true } } },
      })
    : []

  const primaryJobName = new Map<string, string>()
  for (const j of employeeJobs) {
    if (j.isPrimary) primaryJobName.set(j.employeeId, j.Job?.name ?? '')
  }

  const entriesInput = entries.map((e) => ({
    id: e.id,
    employeeId: e.employeeId,
    jobId: e.jobId,
    clockIn: e.clockIn,
    clockOut: e.clockOut,
    breakMinutes: e.breakMinutes,
    totalMinutes: e.totalMinutes,
    payRate: e.payRate,
    totalPay: e.totalPay,
    type: e.type,
    status: e.status,
    locationId: e.locationId,
    Employee: e.Employee ? { name: e.Employee.name } : null,
    Job: e.Job ? { name: e.Job.name } : null,
  }))
  const rows = entriesInput.map((e) => toEntryRow(e, period.timezone, primaryJobName.get(e.employeeId) ?? ''))

  const pools = tipPools.map((p) => ({
    id: p.id,
    poolDate: p.date.toISOString().slice(0, 10),
    status: p.status,
    cashCents: Math.round(num(p.cashTips) * 100),
    cardCents: Math.round(num(p.cardTips) * 100),
    totalCents: Math.round(num(p.totalTips) * 100),
  }))
  const poolById = new Map(pools.map((p) => [p.id, p]))

  const tips: TipExportRow[] = []
  for (const pool of tipPools) {
    const meta = poolById.get(pool.id)!
    for (const d of pool.TipDistribution) {
      tips.push({
        distributionId: d.id,
        employeeId: d.employeeId,
        employeeName: d.Employee?.name ?? d.employeeName,
        amountCents: Math.round(num(d.amount) * 100),
        status: d.status,
        poolId: pool.id,
        poolDate: meta.poolDate,
        poolCashCents: meta.cashCents,
        poolCardCents: meta.cardCents,
      })
    }
  }
  tips.sort(
    (a, b) => a.poolDate.localeCompare(b.poolDate) || a.employeeName.localeCompare(b.employeeName) || a.distributionId.localeCompare(b.distributionId),
  )

  return {
    rows,
    tips,
    pools,
    entries: entriesInput,
    shifts: shifts.map((s) => ({
      id: s.id,
      employeeId: s.employeeId,
      shiftDate: s.shiftDate,
      startTime: s.startTime,
      endTime: s.endTime,
      breakMinutes: s.breakMinutes,
      status: s.status,
      Employee: s.Employee_StaffShift_employeeIdToEmployee ? { name: s.Employee_StaffShift_employeeIdToEmployee.name } : null,
    })),
    employeeJobs: employeeJobs.map((j) => ({
      employeeId: j.employeeId,
      jobId: j.jobId,
      payRate: j.payRate,
      isPrimary: j.isPrimary,
    })),
  }
}

/** sočasen zaklep (CAS je izgubil) — 409 */
class ConcurrentCloseError extends Error {
  constructor() {
    super('Obdobje je medtem že zaključeno.')
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await payrollTablesReady())) {
    return fail('Obračunsko obdobje čaka na shemsko migracijo (Enterprise → Shema migracije → payroll-periods).', 503)
  }
  const { id } = await ctx.params

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Neveljavno telo zahtevka.', 400)
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, CLOSE_NOTE_MAX) : ''
  const acknowledgeExceptions = body.acknowledgeExceptions === true

  const period = await db.payrollPeriod.findUnique({ where: { id } })
  if (!period) return fail('Obračunsko obdobje ne obstaja.', 404)
  const guarded = await guardResource(user, period.locationId)
  if (guarded) return guarded
  if (period.status === 'closed') return fail('Obračunsko obdobje je že zaključeno.', 409)

  // ── snapshot: ISTE vrstice kot detail/izvoz (plačilna osnova = samo approved) ──
  const data = await loadPeriodData(period)
  const exceptions = findPayrollExceptions(data.entries, data.shifts, data.employeeJobs, period.timezone)
  const totals = totalsOfRows(data.rows, data.tips, data.pools)

  // izjeme NE blokirajo — zahtevajo izrecno potrditev (checklist v UI)
  if (exceptions.length > 0 && !acknowledgeExceptions) {
    // fail() nosi samo sporočilo — za dodatne podatke (povzetek izjem) gradim
    // odgovor ročno (oblika { error, ... } ostaja enaka fail konvenciji)
    return NextResponse.json(
      {
        error: 'Obdobje vsebuje nepotrjene ali odprte vnose — pregledajte izjeme in potrdite zaklep.',
        exceptions: exceptionsSummary(exceptions),
      },
      { status: 409 },
    )
  }

  const now = new Date()
  const version = 1 + period.reopenCount

  try {
    const updated = await db.$transaction(async (tx) => {
      // ANCHOR na vrstici lokacije (vzorec #63): serializira sočasne zaklepe/
      // ustvarjanja za isto lokacijo. period brez lokacije → brez ankora
      // (degeneriran primer; CAS spodaj še vedno varuje).
      if (period.locationId) {
        const anchor = await tx.location.updateMany({ where: { id: period.locationId }, data: { updatedAt: now } })
        if (anchor.count === 0) throw new ConcurrentCloseError()
      }
      // CAS: samo iz 'draft' — dvojni klik/sočasnost → count 0 → 409 (nič
      // spremembe, nič audita: revizija vidi TOČNO EN zaklep na različico)
      const res = await tx.payrollPeriod.updateMany({
        where: { id: period.id, status: 'draft' },
        data: {
          status: 'closed',
          closedAt: now,
          closedById: user.sub,
          closeNote: note,
          version,
          entryCount: totals.entryCount,
          approvedCount: totals.approvedCount,
          exceptionCount: exceptions.length,
          netMinutesApproved: totals.netMinutesApproved,
          grossPayCents: totals.grossPayCents,
          cashTipsCents: totals.cashTipsCents,
          cardTipsCents: totals.cardTipsCents,
          tipsPendingCents: totals.tipsPendingCents,
          tipsPaidCents: totals.tipsPaidCents,
        },
      })
      if (res.count === 0) throw new ConcurrentCloseError()
      await writeAudit(tx, {
        userId: user.sub,
        action: 'PAYROLL_PERIOD_CLOSED',
        entityType: 'PayrollPeriod',
        entityId: period.id,
        details: jstr({
          version,
          entryCount: totals.entryCount,
          approvedCount: totals.approvedCount,
          exceptionCount: exceptions.length,
          netMinutesApproved: totals.netMinutesApproved,
          grossPayCents: totals.grossPayCents,
          cashTipsCents: totals.cashTipsCents,
          cardTipsCents: totals.cardTipsCents,
          tipsPendingCents: totals.tipsPendingCents,
          tipsPaidCents: totals.tipsPaidCents,
          acknowledged: exceptions.length > 0,
          note,
        }),
        locationId: period.locationId,
      })
      return tx.payrollPeriod.findUnique({ where: { id: period.id } })
    })
    if (!updated) return fail('Obračunsko obdobje ne obstaja.', 404)
    return ok({ period: periodDto(updated) })
  } catch (e) {
    if (e instanceof ConcurrentCloseError) return fail(e.message, 409)
    throw e
  }
}
