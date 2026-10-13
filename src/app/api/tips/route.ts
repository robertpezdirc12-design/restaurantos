import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { dayRange, parseTipMethod, splitTips, tipChainHash, entryMinutesInRange, type TipMethod } from '@/lib/tips'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #1 (triage ①) — napitnine: dnevni bazen + distribucija po zaposlenih.
 *
 * GET  /api/tips?date=YYYY-MM-DD&locationId=&method=hours|equal|points
 *   → predogled dneva (zbirke cash/non-cash, ure po zaposlenih, predogled delitve)
 *     + obstoječi bazen za dan (z distribucijami) + zgodovina zadnjih bazenov.
 *     N5 (revizija §4): finančni podatki (zneski napitnin, distribucije) — UI prikaže
 *     zavihek Napitnine samo z 'reports.view' (TAB_PERM.napitnine), zato backend
 *     uveljavlja isto kanonično dovoljenje (prej: requireAuth).
 *
 * POST /api/tips  { date, locationId?, method, points?, shiftId? }
 *   → zaključi dan: ustvari TipPool + TipDistribution (hash-veriga), audit TIP_POOL_CLOSE.
 *     Pravica: employees.manage. Idempotentna zaščita: EN bazen na dan+lokacijo (409).
 *
 * Kanonični tok: Payment.tipAmount (vnos pri plačilu) → bazen → distribucija → izplačilo.
 * Payment/Order/Receipt tok ni spremenjen (§18: brez odstranjevanja obstoječega).
 */

interface BasisRow { employeeId: string; employeeName: string; minutes: number; points: number }

function decToCents(v: unknown): number {
  return Math.round(Number(v) * 100)
}

async function dayPayments(from: Date, to: Date, locationId: string) {
  return db.payment.findMany({
    where: {
      status: 'completed',
      tipAmount: { gt: 0 },
      createdAt: { gte: from, lt: to },
      Check: { Order: { locationId } },
    },
    select: { id: true, tipAmount: true, type: true, employeeId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
}

async function dayBasisRows(from: Date, to: Date, locationId: string, tipEmployees: { id: string; name: string }[]): Promise<BasisRow[]> {
  const entries = await db.timeEntry.findMany({
    where: { clockIn: { gte: from, lt: to } },
    select: { clockIn: true, clockOut: true, breakMinutes: true, Employee: { select: { id: true, name: true, locationId: true } } },
  })
  const map = new Map<string, BasisRow>()
  const push = (id: string, name: string) => {
    if (!map.has(id)) map.set(id, { employeeId: id, employeeName: name, minutes: 0, points: 0 })
    return map.get(id)!
  }
  for (const e of entries) {
    // šteje izmena na lokaciji zaposlenega (TimeEntry nima lokacije; Employee.locationId je sidro)
    if (e.Employee.locationId && e.Employee.locationId !== locationId) continue
    const row = push(e.Employee.id, e.Employee.name)
    row.minutes += entryMinutesInRange(
      e.clockIn.getTime(),
      e.clockOut ? e.clockOut.getTime() : null,
      e.breakMinutes,
      from.getTime(),
      to.getTime()
    )
  }
  for (const t of tipEmployees) push(t.id, t.name)
  return Array.from(map.values()).sort((a, b) => a.employeeName.localeCompare(b.employeeName))
}

function methodWeights(method: TipMethod, rows: BasisRow[], points: Record<string, number>): { weights: number[]; basisCents: number[]; fallbackEqual: boolean } {
  if (method === 'hours') {
    const totalMin = rows.reduce((a, r) => a + r.minutes, 0)
    if (totalMin > 0) {
      return { weights: rows.map((r) => r.minutes), basisCents: rows.map((r) => r.minutes * 60), fallbackEqual: false }
    }
    // fallback: brez evidenc ur delimo enakovredno (jasno označeno v details)
    return { weights: rows.map(() => 1), basisCents: rows.map(() => 1), fallbackEqual: true }
  }
  if (method === 'points') {
    return { weights: rows.map((r) => Math.max(0, Number(points[r.employeeId]) || 0)), basisCents: rows.map((r) => Math.round((Number(points[r.employeeId]) || 0) * 100)), fallbackEqual: false }
  }
  return { weights: rows.map(() => 1), basisCents: rows.map(() => 1), fallbackEqual: false }
}

export async function GET(req: NextRequest) {
  // N5: finančni seznam (bazeni, zneski, distribucije) → 'reports.view' (skladen z UI zavihkom)
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10)
  let range: { from: Date; to: Date }
  try {
    range = dayRange(date)
  } catch (e) {
    return fail((e as Error).message, 400)
  }
  // Issue #5 (P0, komentar #6): prej locationId verbatim iz query — tudi NON-central
  // (fallback || user.loc je veljal samo ob MANJKAJOČEM parametru!) in brez org preverbe
  // za centralne. Zdaj: non-central VEDNO user.loc; centralna vloga s parametrom gre
  // čez assertOrgScope (tuja organizacija → 403).
  let locationId: string
  if (isCentralRole(user)) {
    const raw = url.searchParams.get('locationId') || user.loc || ''
    if (!raw) return fail('locationId je obvezen (izberi lokacijo).', 400)
    const orgGuard = await assertOrgScope(user, raw)
    if (orgGuard) return orgGuard
    locationId = raw
  } else {
    if (!user.loc) return fail('Uporabnik nima dodeljene lokacije.', 403)
    locationId = user.loc
  }
  const method = parseTipMethod(url.searchParams.get('method')) || 'hours'

  const payments = await dayPayments(range.from, range.to, locationId)
  const cashCents = payments.filter((p) => p.type === 'cash').reduce((a, p) => a + decToCents(p.tipAmount), 0)
  const nonCashCents = payments.filter((p) => p.type !== 'cash').reduce((a, p) => a + decToCents(p.tipAmount), 0)
  const totalCents = cashCents + nonCashCents

  const empIds = Array.from(new Set(payments.map((p) => p.employeeId).filter((x): x is string => !!x)))
  const tipEmployees = empIds.length
    ? (await db.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true } }))
    : []
  const rows = await dayBasisRows(range.from, range.to, locationId, tipEmployees)
  const { weights, basisCents, fallbackEqual } = methodWeights(method, rows, {})
  const previewCents = splitTips(totalCents, weights)

  const pool = await db.tipPool.findFirst({
    where: { date: { gte: range.from, lt: range.to }, locationId },
    include: { TipDistribution: { orderBy: { createdAt: 'asc' } } },
  })

  const history = await db.tipPool.findMany({
    where: { locationId },
    orderBy: { date: 'desc' },
    take: 14,
    include: { TipDistribution: { select: { employeeName: true, amount: true, status: true } } },
  })

  return ok({
    date,
    locationId,
    method,
    fallbackEqual,
    totals: { totalCents, cashCents, nonCashCents, payments: payments.length },
    employees: rows.map((r, i) => ({ ...r, previewCents: previewCents[i] ?? 0 })),
    pool,
    history: history.map((p) => ({
      id: p.id,
      date: p.date,
      totalTips: p.totalTips,
      distributionMethod: p.distributionMethod,
      status: p.status,
      employees: p.TipDistribution.length,
      paid: p.TipDistribution.filter((d) => d.status === 'paid').length,
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  const date = String(body?.date || '')
  const method = parseTipMethod(body?.method) || 'hours'
  // Issue #5 (P0, komentar #6): enaka validacija kot GET — non-central vedno user.loc,
  // centralna s parametrom čez assertOrgScope.
  let locationId: string
  if (isCentralRole(user)) {
    const raw = String(body?.locationId || user.loc || '')
    if (!raw) return fail('locationId je obvezen (izberi lokacijo).', 400)
    const orgGuard = await assertOrgScope(user, raw)
    if (orgGuard) return orgGuard
    locationId = raw
  } else {
    if (!user.loc) return fail('Uporabnik nima dodeljene lokacije.', 403)
    locationId = user.loc
  }
  const points: Record<string, number> =
    body?.points && typeof body.points === 'object' && !Array.isArray(body.points) ? (body.points as Record<string, number>) : {}
  const shiftId = body?.shiftId ? String(body.shiftId) : null

  let range: { from: Date; to: Date }
  try {
    range = dayRange(date)
  } catch (e) {
    return fail((e as Error).message, 400)
  }

  // zaščita pred podvojitvijo: en bazen na dan + lokacijo
  const existing = await db.tipPool.findFirst({ where: { date: { gte: range.from, lt: range.to }, locationId } })
  if (existing) return fail(`Za ta dan in lokacijo bazen že obstaja (${existing.id}).`, 409)

  const payments = await dayPayments(range.from, range.to, locationId)
  const cashCents = payments.filter((p) => p.type === 'cash').reduce((a, p) => a + decToCents(p.tipAmount), 0)
  const nonCashCents = payments.filter((p) => p.type !== 'cash').reduce((a, p) => a + decToCents(p.tipAmount), 0)
  const totalCents = cashCents + nonCashCents
  if (totalCents <= 0) return fail('Za ta dan ni napitnin — nič za deliti.', 400)

  const empIds = Array.from(new Set(payments.map((p) => p.employeeId).filter((x): x is string => !!x)))
  const tipEmployees = empIds.length
    ? (await db.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true } }))
    : []
  const rows = await dayBasisRows(range.from, range.to, locationId, tipEmployees)
  if (rows.length === 0) return fail('Ni zaposlenih z osnovo za delitev (ure/evidence manjkajo).', 400)

  const { weights, basisCents, fallbackEqual } = methodWeights(method, rows, points)
  const amounts = splitTips(totalCents, weights)
  const effectiveMethod: TipMethod = method === 'hours' && fallbackEqual ? 'equal' : method

  const ordered = rows
    .map((r, i) => ({ row: r, basis: basisCents[i], amount: amounts[i] }))
    .sort((a, b) => a.row.employeeName.localeCompare(b.row.employeeName) || a.row.employeeId.localeCompare(b.row.employeeId))

  const poolId = nid()
  // hash-veriga po abecedi zaposlenega — nespremenljivo zaporedje (tamper-evident)
  let prev = ''
  const distributions = ordered.map((o) => {
    const previousHash = prev
    const chainHash = tipChainHash(prev, o.row.employeeId, o.basis, o.amount)
    prev = chainHash
    return {
      id: nid(),
      tipPoolId: poolId,
      employeeId: o.row.employeeId,
      employeeName: o.row.employeeName,
      previousHash,
      chainHash,
      hoursWorked: effectiveMethod === 'equal' ? 0 : o.row.minutes / 60,
      points: effectiveMethod === 'points' ? Math.round(o.basis) / 100 : 0,
      amount: o.amount / 100,
      status: 'pending',
    }
  })

  const pool = await db.$transaction(async (tx) => {
    const created = await tx.tipPool.create({
      data: {
        id: poolId,
        date: range.from,
        shiftId,
        totalTips: totalCents / 100,
        cashTips: cashCents / 100,
        cardTips: nonCashCents / 100,
        distributionMethod: effectiveMethod,
        status: 'pending',
        locationId,
      },
    })
    await tx.tipDistribution.createMany({ data: distributions })
    await writeAudit(tx, { userId: user.sub, action: 'TIP_POOL_CLOSE', entityType: 'TipPool', entityId: poolId, details: jstr({
          date,
          locationId,
          method: effectiveMethod,
          requestedMethod: method,
          fallbackEqual,
          totalCents,
          cashCents,
          nonCashCents,
          payments: payments.length,
          employees: distributions.length,
          sumOfParts: distributions.reduce((a, d) => a + d.amount * 100, 0),
        }) })
    return created
  })

  const created = await db.tipDistribution.findMany({ where: { tipPoolId: poolId }, orderBy: { createdAt: 'asc' } })
  return ok({ pool, distributions: created }, 201)
}
