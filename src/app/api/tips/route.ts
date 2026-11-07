import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, jstr, num } from '@/lib/map'
import { dayRange, parseTipMethod, splitTips, tipChainHash, entryMinutesInRange, sanitizeTipPointsRecord, type TipMethod } from '@/lib/tips'
import { writeAudit } from '@/lib/audit-chain'
import { jobTipPointsAvailable, jobTipPointsFor } from '@/lib/job-tip-points'

/**
 * Issue #1 (triage ①) — napitnine: dnevni bazen + distribucija po zaposlenih.
 *
 * GET  /api/tips?date=YYYY-MM-DD&locationId=&method=hours|equal|points&points=<JSON>
 *   → predogled dneva (zbirke cash/non-cash, ure po zaposlenih, predogled delitve)
 *     + obstoječi bazen za dan (z distribucijami) + zgodovina zadnjih bazenov.
 *     N5 (revizija §4): finančni podatki (zneski napitnin, distribucije) — UI prikaže
 *     zavihek Napitnine samo z 'reports.labour' (TAB_PERM.napitnine), zato backend
 *     uveljavja isto kanonično dovoljenje (prej: requireAuth).
 *     PRIMERJAVA §40 (v1.266.0): opcijski points=<JSON mapa employeeId→točke>
 *     (sanitiziran) — predogled točkovne delitve odraža VNEŠENE točke (prej je
 *     GET trdo klical methodWeights z {} — »po točkah« je v UI tiho delil
 *     enakovredno!). Dodatno per zaposleni: jobId/jobName/jobTipPoints —
 *     VLOGA tega dne (TimeEntry.jobId z največ minutami → primarna EmployeeJob)
 *     + privzete točke vloge (DDL-gated, pre-DDL 0) za predpolnitev vnosa;
 *     odgovor nosi tipPointsDdlActive.
 *
 * POST /api/tips  { date, locationId?, method, points?, shiftId? }
 *   → zaključi dan: ustvari TipPool + TipDistribution (hash-veriga), audit TIP_POOL_CLOSE.
 *     Pravica: employees.manage. Idempotentna zaščita: EN bazen na dan+lokacijo (409).
 *     §40: body.points gre skozi sanitizeTipPointsRecord (končni celi 0..999; prej
 *     je Infinity šel skozi do splitTips → neobdelan 500) + revizija nosi pointsSum
 *     (iskren zapis vnešenih uteži pri točkovni delitvi).
 *
 * Kanonični tok: Payment.tipAmount (vnos pri plačilu) → bazen → distribucija → izplačilo.
 * Payment/Order/Receipt tok ni spremenjen (§18: brez odstranjevanja obstoječega).
 */

interface BasisRow {
  employeeId: string
  employeeName: string
  minutes: number
  points: number
  /** §40: vloga tega dne (TimeEntry jobId z največ minutami → primarna EmployeeJob; null = brez) */
  jobId: string | null
  jobName: string | null
  /** §40: privzete točke vloge (DDL-gated; pre-DDL 0 — predpolnitev prazna) */
  jobTipPoints: number
}

function decToCents(v: unknown): number {
  return Math.round(Number(v) * 100)
}

async function dayPayments(from: Date, to: Date, locationId: string) {
  return db.payment.findMany({
    where: {
      status: 'completed',
      // v1.239.0 §16 B: { not: 0 } namesto { gt: 0 } — storno od v1.239.0 piše
      // NEGACIJSKO vrstico (tipAmount < 0, zrcalo originala); bazen mora videti
      // obe, da se neto (poprej je storno pustil pozitivno napitnino za vedno).
      tipAmount: { not: 0 },
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
    select: { clockIn: true, clockOut: true, breakMinutes: true, jobId: true, Employee: { select: { id: true, name: true, locationId: true } } },
  })
  const map = new Map<string, BasisRow>()
  // §40: akumulacija minut per (employee, job) — vloga dneva = delovno mesto z NAJVEČ minutami
  const jobMinutes = new Map<string, Map<string, number>>()
  const push = (id: string, name: string) => {
    if (!map.has(id)) map.set(id, { employeeId: id, employeeName: name, minutes: 0, points: 0, jobId: null, jobName: null, jobTipPoints: 0 })
    return map.get(id)!
  }
  for (const e of entries) {
    // šteje izmena na lokaciji zaposlenega (TimeEntry nima lokacije; Employee.locationId je sidro)
    if (e.Employee.locationId && e.Employee.locationId !== locationId) continue
    const row = push(e.Employee.id, e.Employee.name)
    const mins = entryMinutesInRange(
      e.clockIn.getTime(),
      e.clockOut ? e.clockOut.getTime() : null,
      e.breakMinutes,
      from.getTime(),
      to.getTime()
    )
    row.minutes += mins
    if (e.jobId) {
      const per = jobMinutes.get(e.Employee.id) ?? new Map<string, number>()
      per.set(e.jobId, (per.get(e.jobId) ?? 0) + mins)
      jobMinutes.set(e.Employee.id, per)
    }
  }
  for (const t of tipEmployees) push(t.id, t.name)
  const rows = Array.from(map.values()).sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'sl'))

  // §40: brez TimeEntry jobId → primarna EmployeeJob (issue #22 dodelitev; 0 minut —
  // samo izhodišče predpolnitve, ne utež)
  const needPrimary = rows.filter((r) => !jobMinutes.has(r.employeeId)).map((r) => r.employeeId)
  if (needPrimary.length > 0) {
    const primaries = await db.employeeJob.findMany({
      where: { employeeId: { in: needPrimary }, isPrimary: true },
      select: { employeeId: true, jobId: true },
    })
    const primaryByEmp = new Map(primaries.map((p) => [p.employeeId, p.jobId]))
    for (const empId of needPrimary) {
      const j = primaryByEmp.get(empId)
      jobMinutes.set(empId, j ? new Map([[j, 0]]) : new Map())
    }
  }
  // vloga dneva = jobId z največ minuti; izenačeno → prvi po jobId (deterministično)
  for (const r of rows) {
    const per = jobMinutes.get(r.employeeId)
    if (!per || per.size === 0) continue
    let best: { jobId: string; mins: number } | null = null
    for (const [jobId, mins] of per) {
      if (!best || mins > best.mins || (mins === best.mins && jobId < best.jobId)) best = { jobId, mins }
    }
    if (best) r.jobId = best.jobId
  }

  // §40: imena + privzete točke vlog (DDL-gated — pre-DDL ostanejo 0/null, vnos ročen)
  const jobIds = Array.from(new Set(rows.map((r) => r.jobId).filter((x): x is string => !!x)))
  if (jobIds.length > 0) {
    const jobs = await db.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, name: true } })
    const nameById = new Map(jobs.map((j) => [j.id, j.name]))
    const ddlActive = await jobTipPointsAvailable()
    const pointsByJob = ddlActive ? await jobTipPointsFor(jobIds) : {}
    for (const r of rows) {
      if (r.jobId && nameById.has(r.jobId)) {
        r.jobName = nameById.get(r.jobId) ?? null
        r.jobTipPoints = pointsByJob[r.jobId] ?? 0
      } else {
        r.jobId = null
      }
    }
  }
  return rows
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
  // N5: finančni seznam (bazeni, zneski, distribucije) → 'reports.labour' (skladen z UI zavihkom)
  const user = await requirePermission(req, 'reports.labour')
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
  // §40: opcijsen points=<JSON> — sanitiziran vnos točk per oseba za PREDOGLED
  // (prej trdo {} — »po točkah« bi v predogledu tiho pokazal enakovredno delitev)
  let enteredPoints: Record<string, number> = {}
  const rawPoints = url.searchParams.get('points')
  if (rawPoints) {
    try {
      enteredPoints = sanitizeTipPointsRecord(JSON.parse(rawPoints))
    } catch {
      return fail('points mora biti veljaven JSON ({employeeId: točke}).', 400)
    }
  }

  const payments = await dayPayments(range.from, range.to, locationId)
  const cashCents = payments.filter((p) => p.type === 'cash').reduce((a, p) => a + decToCents(p.tipAmount), 0)
  const nonCashCents = payments.filter((p) => p.type !== 'cash').reduce((a, p) => a + decToCents(p.tipAmount), 0)
  const totalCents = cashCents + nonCashCents

  const empIds = Array.from(new Set(payments.map((p) => p.employeeId).filter((x): x is string => !!x)))
  const tipEmployees = empIds.length
    ? (await db.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true } }))
    : []
  const rows = await dayBasisRows(range.from, range.to, locationId, tipEmployees)
  // §40: učinkovite točke predogleda = vnešene ?? predpolnitev vloge — predogled
  // je tako SINHRON z tistim, kar bo UI poslal ob zaključku dneva (UI vedno pošlje
  // svoj stanj vnosov, ki se inicializira iz predpolnitve; POST pa uporabi IZKLJUČNO
  // prejete vrednosti — brez tihega vpliva vloge na denarno pot).
  const previewPoints: Record<string, number> = Object.fromEntries(
    rows.map((r) => [r.employeeId, enteredPoints[r.employeeId] ?? r.jobTipPoints]),
  )
  const { weights, basisCents, fallbackEqual } = methodWeights(method, rows, previewPoints)
  const previewCents = splitTips(totalCents, weights)

  const pool = await db.tipPool.findFirst({
    where: { date: { gte: range.from, lt: range.to }, locationId },
    include: { TipDistribution: { orderBy: { createdAt: 'asc' } } },
  })

  // v1.225.0 (QA-val #7, najdba #1): Prisma Decimal se v JSON serializira kot NIZ —
  // UI je vrstico TipDistribution z `hoursWorked.toFixed(2)` zrušil s TypeError
  // (niz nima toFixed). Bazen se zdaj preslika v številke (ista disciplina kot
  // `history` preslikava spodaj): hoursWorked/points/amount in totalTips/cashTips/
  // cardTips so vedno pravi numberji — UI tip (number) končno drži.
  const poolNormalized = pool
    ? {
        ...pool,
        totalTips: num(pool.totalTips),
        cashTips: num(pool.cashTips),
        cardTips: num(pool.cardTips),
        TipDistribution: pool.TipDistribution.map((d) => ({
          ...d,
          hoursWorked: num(d.hoursWorked),
          points: num(d.points),
          amount: num(d.amount),
        })),
      }
    : null

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
    // §40: vloga dneva + privzete točke per zaposleni + DDL stanje (UI vir predpolnitve)
    tipPointsDdlActive: await jobTipPointsAvailable(),
    totals: { totalCents, cashCents, nonCashCents, payments: payments.length },
    employees: rows.map((r, i) => ({
      ...r,
      // vnešene točke (sanitizirane) imajo prednost pred predpolnitvijo vloge
      enteredPoints: enteredPoints[r.employeeId] ?? r.jobTipPoints,
      previewCents: previewCents[i] ?? 0,
    })),
    pool: poolNormalized,
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

/** Issue #63: bazen za (dan, lokacija) že obstaja — CAS/anchor tekmovalni poskus (409, brez podvojitve) */
class TipPoolExistsError extends Error {
  constructor(public readonly poolId: string) {
    super(`Za ta dan in lokacijo bazen že obstaja (${poolId}).`)
  }
}

/** Issue #63: ciljna lokacija ne obstaja — fail-closed 400 (anchor update je P2025). */
class TipLocationMissingError extends Error {
  constructor() {
    super('Ciljna lokacija ne obstaja.')
  }
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
  // §40: sanitizacija na VHODU — končni celi 0..999 ostanejo, ostalo izpade (0);
  // prej je surova mapa šla v methodWeights, kjer je Math.max(0, Number(x) || 0)
  // spustil Infinity do splitTips → neobdelan 500.
  const points: Record<string, number> = sanitizeTipPointsRecord(body?.points)
  const shiftId = body?.shiftId ? String(body.shiftId) : null

  let range: { from: Date; to: Date }
  try {
    range = dayRange(date)
  } catch (e) {
    return fail((e as Error).message, 400)
  }

  // zaščita pred podvojitvijo: en bazen na dan + lokacijo (hitra pot — UX)
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
    .sort((a, b) => a.row.employeeName.localeCompare(b.row.employeeName, 'sl') || a.row.employeeId.localeCompare(b.row.employeeId))

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

  /*
   * Issue #63 (P1) — ATOMARNA ENOLIČNOST bazena na (poslovni dan, lokacija):
   * gornji findFirst je bil IZVEN transakcije — dve sočasni zahtevi za isti
   * (datum, locationId) sta ga obe prestali in vsaka ustvarila SVOJ TipPool +
   * lastne TipDistribution vrstice (ista Payment.tipAmount razdeljen dvakrat;
   * payout lahko oba bazena ločeno izplača).
   * Zdaj: znotraj ENE interaktivne transakcije NAJPREJ ANCHOR write na vrstico
   * LOKACIJE (updateMany + updatedAt) — na SQLite pridabi izključni pisljivi
   * zaklep, na PostgreSQL zaklene vrstico lokacije — kar serializira vsa
   * sočasna ustvarjanja bazenov ZA ISTO LOKACIJO. Sledi FRESH re-check (isti
   * dnevni okvir + ista lokacija — ključ ne more vrniti tujega bazena) in šele
   * nato createMany bazena + distribucij + audit, vse skupaj: napaka kjerkoli
   * → ROLLBACK (brez delnega/siromašnega bazena).
   * (Ekvivalent unique(data, locationId) omejitvi, ki bi zahtevala DDL migracijo
   * in obdelavo legacy dvojnikov — enaka invarianta, brez spremembe sheme.)
   */
  let pool: Awaited<ReturnType<typeof db.tipPool.create>> | null = null
  try {
    pool = await db.$transaction(async (tx) => {
      // #63: anchor claim — serializacija sočasnih POST za isto lokacijo
      const anchor = await tx.location.updateMany({ where: { id: locationId }, data: { updatedAt: new Date() } })
      if (anchor.count === 0) throw new TipLocationMissingError()
      // #63: FRESH re-check ZNOTRAJ transakcije (zahtevek je bil sprožen pred
      // tekmečevim commitom — zdaj vidi njegov bazen in se ustavi)
      const dupe = await tx.tipPool.findFirst({ where: { date: { gte: range.from, lt: range.to }, locationId } })
      if (dupe) throw new TipPoolExistsError(dupe.id)
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
          // §40: iskren zapis vnešenih točk pri točkovni delitvi (uteži = dokaz
          // kaj je DEJANSKO delilo; 0 točk = vsi enakovredno po splitTips fallback)
          ...(method === 'points' ? { pointsSum: Object.values(points).reduce((a, b) => a + b, 0), pointsEntered: Object.keys(points).length } : {}),
        }) })
      return created
    })
  } catch (e) {
    // #63: izgubljeni tekmec — natanko en bazen obstaja (njegov); ta zahteva
    // ni ustvarila ničesar (rollback) → 409 z ID-jem zmagovalnega bazena.
    if (e instanceof TipPoolExistsError) return fail(e.message, 409)
    if (e instanceof TipLocationMissingError) return fail(e.message, 400)
    throw e
  }

  const created = await db.tipDistribution.findMany({ where: { tipPoolId: poolId }, orderBy: { createdAt: 'asc' } })
  return ok({ pool, distributions: created }, 201)
}
