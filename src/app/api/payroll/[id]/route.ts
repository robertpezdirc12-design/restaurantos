import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num } from '@/lib/map'
import { payrollTablesReady } from '@/lib/payroll-schema'
import {
  aggregateByEmployeeJob,
  exceptionsSummary,
  findPayrollExceptions,
  periodDto,
  plannedMinutesFromShifts,
  toEntryRow,
  totalsOfRows,
  type PayrollEntryRow,
  type PayrollPeriodRow,
  type TipExportRow,
} from '@/lib/payroll'

/**
 * Issue #22 (P2, v1.115.0) — DETALJ obračunskega obdobja (menedžerski pregled).
 *
 * GET /api/payroll/[id]
 *   → period (DTO + snapshot polja), ŽIVE vsote (totals — za draft so snapshot
 *     polja 0, dokler se obdobje ne zaklene), zaposleni po delovnih mestih
 *     (approved plačilna osnova + načrtovane minute + varianca), izjeme
 *     (checklist kakovosti pred zaklepom), napitnine (bazeni + distribucije),
 *     zgodovina izvozov. Pravica: employees.manage + guardResource na
 *     period.locationId (staff = lastna lokacija, centralne = org meja).
 *
 * PODATKOVNE KONVENCIJE (zrcalijo obstoječe tips/labor poti — komentirane
 * tudi ob poizvedbah spodaj):
 *  - TimeEntry: clockIn ∈ [periodStart, periodEnd) (UTC okno lokalnih polnoči),
 *    sidro OR [TimeEntry.locationId = period.locationId,
 *    Employee.locationId = period.locationId] — vnosi BREZ lastne lokacije
 *    štejejo po lokaciji ZAPOSLENEGA (ista konvencija kot tips dayBasisRows).
 *  - StaffShift: shiftDate v istem oknu, isti OR sidro.
 *  - TipPool.date je shranjen kot UTC polnoč poslovnega dne (tips dayRange),
 *    zato primerjamo UTC okno [periodStart, periodEnd).
 *  - EmployeeJob dodelitve samo za zaposlene iz vnosov — vir za RATE_MISMATCH
 *    in padajoče ime primarnega delovnega mesta.
 *
 * PRE-DDL: probe payrollTablesReady → 503 (graceful — ruta ne sme 500-ati,
 * dokler migracija payroll-periods ni aplicirana).
 */

/**
 * Naloži vse podatke obdobja: vnose, izmene, bazene napitnin, dodelitve delovnih
 * mest → vrstice obračuna (toEntryRow) + flat vrstice napitnin (TipExportRow)
 * + vhodi za čisto logiko (izjeme/načrt). ISTE poizvedbe uporabljata zaklep
 * (snapshot) in izvoz (contentHash) — en vir, ena oblika (stabilen hash).
 */
async function loadPeriod(period: PayrollPeriodRow): Promise<{
  rows: PayrollEntryRow[]
  tips: TipExportRow[]
  pools: { id: string; poolDate: string; status: string; cashCents: number; cardCents: number; totalCents: number }[]
  entries: Parameters<typeof findPayrollExceptions>[0]
  shifts: Parameters<typeof plannedMinutesFromShifts>[0]
  employeeJobs: Parameters<typeof findPayrollExceptions>[2]
}> {
  const locId = period.locationId
  const window = { gte: period.periodStart, lt: period.periodEnd }

  const [entries, shifts, tipPools] = await Promise.all([
    db.timeEntry.findMany({
      where: {
        // OR sidro: vnos z lokacijo obdobja ALI vnos zaposlenega z lokacijo
        // obdobja (TimeEntry.locationId je opcijski — tips že šteje po
        // Employee.locationId; period.locationId null pomeni IS NULL)
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
      // TipPool.date = UTC polnoč poslovnega dne (tips dayRange konvencija) —
      // bazeni, katerih poslovni dan pade v UTC okno obdobja
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

  // padajoče ime delovnega mesta za vnose BREZ Job (jobId null / izbrisan Job):
  // PRIMARNA dodelitev zaposlenega (EmployeeJob.isPrimary), sicer ''
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

  // distribucije → flat vrstice izvoza (deterministično razvrščene — stabilen
  // rowDigest/contentHash med ponovljenimi izvozi iste vsebine)
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

  const shiftInput = shifts.map((s) => ({
    id: s.id,
    employeeId: s.employeeId,
    shiftDate: s.shiftDate,
    startTime: s.startTime,
    endTime: s.endTime,
    breakMinutes: s.breakMinutes,
    status: s.status,
    Employee: s.Employee_StaffShift_employeeIdToEmployee ? { name: s.Employee_StaffShift_employeeIdToEmployee.name } : null,
  }))
  const jobInput = employeeJobs.map((j) => ({
    employeeId: j.employeeId,
    jobId: j.jobId,
    payRate: j.payRate,
    isPrimary: j.isPrimary,
  }))

  return { rows, tips, pools, entries: entriesInput, shifts: shiftInput, employeeJobs: jobInput }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await payrollTablesReady())) {
    return fail('Obračunsko obdobje čaka na shemsko migracijo (Enterprise → Shema migracije → payroll-periods).', 503)
  }
  const { id } = await ctx.params

  const period = await db.payrollPeriod.findUnique({ where: { id } })
  if (!period) return fail('Obračunsko obdobje ne obstaja.', 404)
  const guarded = await guardResource(user, period.locationId)
  if (guarded) return guarded

  const data = await loadPeriod(period)
  const exceptions = findPayrollExceptions(data.entries, data.shifts, data.employeeJobs, period.timezone)
  const aggregates = aggregateByEmployeeJob(data.rows)
  const planned = plannedMinutesFromShifts(data.shifts, period.timezone)
  const totals = totalsOfRows(data.rows, data.tips, data.pools)

  const plannedBy = new Map(planned.map((p) => [p.employeeId, p]))
  const employees = aggregates.map((a) => {
    const plannedMinutes = plannedBy.get(a.employeeId)?.plannedMinutes ?? 0
    return { ...a, plannedMinutes, varianceMinutes: plannedMinutes - a.netMinutes }
  })
  // zaposleni z NAČRTOM brez vnosov (SHIFT_NO_ENTRY primer) — vrstica z ničelno
  // plačilno osnovo, da je razlika načrt/dejansko vidna v isti tabeli
  for (const p of planned) {
    if (aggregates.some((a) => a.employeeId === p.employeeId)) continue
    employees.push({
      employeeId: p.employeeId,
      employeeName: p.employeeName,
      jobId: null,
      jobName: '',
      entryCount: 0,
      approvedCount: 0,
      netMinutes: 0,
      grossCents: 0,
      byType: {},
      rateRangeCents: null,
      plannedMinutes: p.plannedMinutes,
      varianceMinutes: p.plannedMinutes,
    })
  }

  const exports = await db.payrollExport.findMany({
    where: { periodId: period.id },
    orderBy: { seq: 'desc' },
    take: 50,
  })

  return ok({
    period: periodDto(period),
    totals,
    employees,
    exceptions,
    exceptionsSummary: exceptionsSummary(exceptions),
    tips: data.tips,
    tipPools: data.pools.map((p) => ({ ...p, distributions: data.tips.filter((t) => t.poolId === p.id).length })),
    exports: exports.map((x) => ({
      id: x.id,
      seq: x.seq,
      format: x.format,
      exportedAt: x.exportedAt.toISOString(),
      exportedById: x.exportedById,
      changedEntries: x.changedEntries,
      identicalToPrevious: x.identicalToPrevious,
      contentHash8: x.contentHash.slice(0, 8),
    })),
    meta: { generatedAt: new Date().toISOString(), version: period.version },
  })
}
