import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { payrollTablesReady } from '@/lib/payroll-schema'
import { holidaysInRange } from '@/lib/payroll-holidays'
import { surchargeBasisRows } from '@/lib/payroll-surcharges'
import { lookupSurchargeRates } from '@/lib/payroll-rates-store'
import {
  aggregateByEmployeeJob,
  buildPayrollCsv,
  canonicalExportJson,
  diffRowDigest,
  exceptionsSummary,
  EXPORT_SCHEMA_VERSION,
  findPayrollExceptions,
  periodDto,
  rowDigestOf,
  toEntryRow,
  totalsOfRows,
  type PayrollEntryRow,
  type PayrollPeriodRow,
  type TipExportRow,
} from '@/lib/payroll'

/**
 * Issue #22 (P2, v1.115.0) — IZVOZ obračunskega obdobja (računovodski vir).
 *
 * GET /api/payroll/[id]/export?format=csv|json  (privzeto csv)
 *   → SAMO iz zaključenega obdobja (409 za draft — plačilna osnova mora biti
 *     zaklenjena, sicer bi izvozi različnih vsebin nosili isto obdobje).
 *     Vsak izvoz se ZAPIŠE (PayrollExport): seq 1..N, contentHash (sha256
 *     KANONIKALNEGA JSON — rekurzivno sortirani ključi, brez meta), rowDigest
 *     (entryId:neto:centi:status — BREZ PII), changedEntries (set razlika
 *     digestov vs. prejšnji izvoz), identicalToPrevious.
 *
 *     Vsebina (ISTE poizvedbe kot detail/zaklep): vnosi (vsi — status nosi
 *     potrditev; SKUPAJ šteje samo approved), povzetek po zaposlenem+delu
 *     (samo approved), napitnine (distribucije + bazeni), SKUPAJ, noga z
 *     omejitvami (zunanji sistem potrdi zakonske dodatke). CSV: BOM + ';'
 *     + CRLF (vzorec reports/export).
 *
 *     Audit PAYROLL_EXPORTED: SAMO števci (seq/format/diff/identical/bruto) —
 *     brez vrstic, brez imen (PII izven revizije).
 *
 * PRE-DDL: probe payrollTablesReady → 503 (graceful).
 */

/** stanje obdobja se je med izvozom spremenilo (anchor CAS izgubil) — 409 */
class ExportStateChangedError extends Error {
  constructor() {
    super('Obdobje je med izvozom spremenilo stanje.')
  }
}

/**
 * Naloži vse podatke obdobja (ISTE poizvedbe kot GET /api/payroll/[id] in
 * POST close — contentHash izvoza izhaja iz istih vrstic kot snapshot zaklepa;
 * konvencije sidro: OR [TimeEntry.locationId, Employee.locationId],
 * TipPool.date = UTC polnoč poslovnega dne).
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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await payrollTablesReady())) {
    return fail('Obračunsko obdobje čaka na shemsko migracijo (Enterprise → Shema migracije → payroll-periods).', 503)
  }
  const { id } = await ctx.params

  const format = (new URL(req.url).searchParams.get('format') || 'csv').toLowerCase()
  if (format !== 'csv' && format !== 'json') {
    return fail('Neveljaven format izvoza (csv ali json).', 400)
  }

  const period = await db.payrollPeriod.findUnique({ where: { id } })
  if (!period) return fail('Obračunsko obdobje ne obstaja.', 404)
  const guarded = await guardResource(user, period.locationId)
  if (guarded) return guarded
  if (period.status !== 'closed') {
    return fail('Izvoz je možen samo iz zaključenega obdobja.', 409)
  }

  // ── P3 #19 (v1.192.0): doplačilne osnove — prazniki po DRŽAVI lokacije
  // (Location.country; brez lokacije → prazen seznam — nedelja/noč ostane,
  // prazniška kategorija prazna, NE izmišljujemo si države)
  const locCountry = period.locationId
    ? (await db.location.findUnique({ where: { id: period.locationId }, select: { country: true } }))?.country ?? ''
    : ''

  // ── N-27-3 (v1.197.0): noge doplačil (lokacija → privzete NULL; brez tabele
  // null — graceful) — kadar obstajajo, osnove dobijo ZNESKE; noge so del
  // vsebine izvoza (contentHash: sprememba noge = nov izvoz, identical false)
  const surchargeRates = await lookupSurchargeRates(period.locationId)

  // ── vsebina (ISTE vrstice kot detail/zaklep) + digesti ──
  const data = await loadPeriodData(period)
  const totals = totalsOfRows(data.rows, data.tips, data.pools)
  const dto = periodDto(period)
  const surchargeBases = surchargeBasisRows(
    data.rows,
    period.timezone,
    holidaysInRange(dto.startISO, dto.endISO, locCountry),
    undefined,
    surchargeRates ?? undefined,
  )
  const payload = {
    period: {
      id: period.id,
      locationId: period.locationId,
      startISO: dto.startISO,
      endISO: dto.endISO,
      timezone: period.timezone,
      status: period.status,
      version: period.version,
      closeNote: period.closeNote,
    },
    rows: data.rows,
    tips: data.tips,
    totals,
    surchargeBases,
    // v hash gre ČISTA vsebina nog (odstotki) — vir/locationId so izpeljani iz
    // period.locationId (že v payload.period)
    surchargeRates: surchargeRates
      ? {
          nightPct: surchargeRates.nightPct,
          sundayPct: surchargeRates.sundayPct,
          holidayPct: surchargeRates.holidayPct,
          overtimePct: surchargeRates.overtimePct,
        }
      : null,
  }
  const digest = rowDigestOf(data.rows, data.tips)
  const contentHash = createHash('sha256').update(canonicalExportJson(payload), 'utf8').digest('hex')
  const contentHash8 = contentHash.slice(0, 8)

  const previous = await db.payrollExport.findFirst({
    where: { periodId: period.id },
    orderBy: { seq: 'desc' },
  })
  const changedEntries = previous ? diffRowDigest(previous.rowDigest, digest) : 0
  const identicalToPrevious = previous ? previous.contentHash === contentHash : false
  const seq = (previous?.seq ?? 0) + 1

  // ── zapis izvoza (TX + ANCHOR na vrstici obdobja: CAS status 'closed' —
  // če je bilo med gradnjo vsebine ponovno odprto, se izvoz NE zapiše)
  const exportId = nid()
  const now = new Date()
  try {
    await db.$transaction(async (tx) => {
      const anchor = await tx.payrollPeriod.updateMany({
        where: { id: period.id, status: 'closed' },
        data: { updatedAt: now },
      })
      if (anchor.count !== 1) throw new ExportStateChangedError()
      await tx.payrollExport.create({
        data: {
          id: exportId,
          periodId: period.id,
          seq,
          format,
          contentHash,
          grossPayCents: totals.grossPayCents,
          netMinutesTotal: totals.netMinutesApproved,
          tipsCentsTotal: totals.tipsPendingCents + totals.tipsPaidCents,
          entryCount: totals.entryCount,
          changedEntries,
          identicalToPrevious,
          rowDigest: digest,
          exportedById: user.sub,
        },
      })
      // revizija brez vsebine: števci samo (seq/format/diff/identical/bruto)
      await writeAudit(tx, {
        userId: user.sub,
        action: 'PAYROLL_EXPORTED',
        entityType: 'PayrollExport',
        entityId: exportId,
        details: jstr({
          periodId: period.id,
          seq,
          format,
          changedEntries,
          identical: identicalToPrevious,
          grossPayCents: totals.grossPayCents,
        }),
        locationId: period.locationId,
      })
    })
  } catch (e) {
    if (e instanceof ExportStateChangedError) return fail(e.message, 409)
    throw e
  }

  if (format === 'json') {
    return ok({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      period: dto,
      rows: data.rows,
      employees: aggregateByEmployeeJob(data.rows),
      tips: data.tips,
      totals,
      surchargeBases,
      surchargeRates: surchargeRates
        ? {
            locationId: surchargeRates.locationId,
            source: surchargeRates.source,
            nightPct: surchargeRates.nightPct,
            sundayPct: surchargeRates.sundayPct,
            holidayPct: surchargeRates.holidayPct,
            overtimePct: surchargeRates.overtimePct,
          }
        : null,
      exceptionsSummary: exceptionsSummary(findPayrollExceptions(data.entries, data.shifts, data.employeeJobs, period.timezone)),
      export: {
        id: exportId,
        seq,
        contentHash,
        contentHash8,
        changedEntries,
        identicalToPrevious,
        generatedAt: now.toISOString(),
      },
    })
  }

  const csv = buildPayrollCsv({
    ...payload,
    exportMeta: { seq, generatedISO: now.toISOString(), contentHash8, changedEntries, identicalToPrevious },
  })
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="obracun-${dto.startISO}_${dto.endISO}-v${period.version}-i${seq}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
