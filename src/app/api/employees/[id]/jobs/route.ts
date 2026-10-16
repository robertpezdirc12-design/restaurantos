import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { payRateToCents } from '@/lib/timeclock'

/**
 * Issue #22 (P2, v1.115.0) — PLAČNE POSTAVKE zaposlenega (EmployeeJob CRUD).
 *
 * GET /api/employees/[id]/jobs
 *   → dodelitve delovnih mest zaposlenega: [{ jobId, name, isActive,
 *     payRate, payRateCents, isPrimary }] (plačna postavka v EUR in centih).
 *
 * PUT /api/employees/[id]/jobs  { jobs: [{ jobId, payRate, isPrimary? }] }
 *   → REPLACE SET (prazna lista = počisti vse). Validacija: največ 8
 *     dodelitev, jobId enoličen v listi, delovno mesto obstaja IN je aktivno
 *     (404), plačna postavka 0..10000 EUR z največ 2 decimalkama. Kadar
 *     lista ni prazna in NOGA postavka ni označena kot primarna, se PRVA
 *     samodejno šteje za primarno (clock-in snapshot vedno potrebuje eno
 *     primarno postavko — izrecno implementirano, ne po naključju).
 *     TX: deleteMany + createMany (atomarna zamenjava), audit
 *     EMPLOYEE_JOBS_UPDATED (števci + primarno mesto, BREZ postavk — zneski
 *     ne gredo v revizijo).
 *
 * Pravica: employees.manage + guardResource na employee.locationId (null
 * lokacija zaposlenega: non-central → 403 fail-closed, centralne → org meja).
 * EmployeeJob je STARA shema — probe ni potreben.
 */

const MAX_JOBS = 8
const MAX_PAY_RATE = 10000

/** Postavka: končno število, 0..10000, največ 2 decimali (centna natančnost). */
function isValidPayRate(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false
  if (v < 0 || v > MAX_PAY_RATE) return false
  // 2 decimali: v mora biti enak zaokroženemu centnemu znesku nazaj v EUR
  return v === Math.round(v * 100) / 100
}

function jobsOut(rows: { jobId: string; payRate: unknown; isPrimary: boolean; Job?: { name: string; isActive: boolean } | null }[]) {
  return rows.map((j) => ({
    jobId: j.jobId,
    name: j.Job?.name ?? '',
    isActive: j.Job?.isActive !== false,
    payRate: num(j.payRate),
    payRateCents: payRateToCents(num(j.payRate)),
    isPrimary: j.isPrimary,
  }))
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params

  const employee = await db.employee.findUnique({ where: { id }, select: { id: true, name: true, locationId: true } })
  if (!employee) return fail('Zaposleni ne obstaja.', 404)
  const guarded = await guardResource(user, employee.locationId)
  if (guarded) return guarded

  const rows = await db.employeeJob.findMany({
    where: { employeeId: id },
    include: { Job: { select: { id: true, name: true, isActive: true } } },
    orderBy: [{ isPrimary: 'desc' }, { Job: { name: 'asc' } }],
  })
  return ok({ jobs: jobsOut(rows) })
}

interface JobInput {
  jobId: string
  payRate: number
  isPrimary: boolean
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || !Array.isArray(body.jobs)) {
    return fail('Pričakovan seznam jobs ([{ jobId, payRate, isPrimary? }]).', 400)
  }

  const employee = await db.employee.findUnique({ where: { id }, select: { id: true, name: true, locationId: true } })
  if (!employee) return fail('Zaposleni ne obstaja.', 404)
  const guarded = await guardResource(user, employee.locationId)
  if (guarded) return guarded

  const rawJobs = body.jobs as Record<string, unknown>[]
  if (rawJobs.length > MAX_JOBS) {
    return fail(`Preveč delovnih mest (največ ${MAX_JOBS}).`, 400)
  }

  const inputs: JobInput[] = []
  const seen = new Set<string>()
  for (const raw of rawJobs) {
    const jobId = typeof raw.jobId === 'string' ? raw.jobId.trim() : ''
    if (!jobId) return fail('jobId je obvezen.', 400)
    if (seen.has(jobId)) return fail('Podvojen jobId v seznamu (vsako delovno mesto enkrat).', 400)
    seen.add(jobId)
    if (!isValidPayRate(raw.payRate)) return fail('Neveljavna plačna postavka (0–10000 EUR, največ 2 decimali).', 400)
    inputs.push({ jobId, payRate: raw.payRate, isPrimary: raw.isPrimary === true })
  }

  // delovna mesta: obstajajo IN so aktivna (nov vnos izključno na aktivna mesta)
  const jobIds = [...seen]
  const jobs = jobIds.length
    ? await db.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, name: true, isActive: true } })
    : []
  const jobById = new Map(jobs.map((j) => [j.id, j]))
  for (const jobId of jobIds) {
    const job = jobById.get(jobId)
    if (!job || job.isActive !== true) return fail('Delovno mesto ne obstaja ali ni aktivno.', 404)
  }

  // PRIMARNA postavka: največ ena izrecna; če lista ni prazna in NOGA ni
  // označena, je PRVA primarna (izrecna odločitev — clock-in snapshot vedno
  // potrebuje primarno postavko, sicer bi novi vnosi nastali z 0 €)
  const explicitPrimary = inputs.filter((i) => i.isPrimary)
  if (explicitPrimary.length > 1) return fail('Samo eno delovno mesto je lahko primarno.', 400)
  if (inputs.length > 0 && explicitPrimary.length === 0) {
    inputs[0] = { ...inputs[0], isPrimary: true }
  }
  const primaryJobId = inputs.find((i) => i.isPrimary)?.jobId ?? null

  const updatedRows = await db.$transaction(async (tx) => {
    // REPLACE SET: delete + create v ENI transakciji (branje nikoli vidi
    // delne zamenjave); @@unique(employeeId, jobId) varuje pred duplikati
    await tx.employeeJob.deleteMany({ where: { employeeId: id } })
    if (inputs.length > 0) {
      await tx.employeeJob.createMany({
        data: inputs.map((i) => ({
          id: nid(),
          employeeId: id,
          jobId: i.jobId,
          payRate: i.payRate,
          isPrimary: i.isPrimary,
        })),
      })
    }
    // revizija: BREZ postavk (zneski ne gredo v audit) — števec + primarno mesto
    await writeAudit(tx, {
      userId: user.sub,
      action: 'EMPLOYEE_JOBS_UPDATED',
      entityType: 'Employee',
      entityId: id,
      details: jstr({ employeeId: id, count: inputs.length, primaryJobId }),
      locationId: employee.locationId,
    })
    return tx.employeeJob.findMany({
      where: { employeeId: id },
      include: { Job: { select: { id: true, name: true, isActive: true } } },
      orderBy: [{ isPrimary: 'desc' }, { Job: { name: 'asc' } }],
    })
  })

  return ok({ jobs: jobsOut(updatedRows) })
}
