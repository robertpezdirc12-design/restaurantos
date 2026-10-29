/**
 * Issue #22 (P2, v1.115.0) — obračun plač (period → zaklep → ponovno odprtje → izvoz).
 *
 * Pokrito:
 *  A. ČISTI MOTOR (src/lib/payroll.ts, brez DB):
 *   1. localMidnightUtc: DST konec 2026-10-25 → 22:00Z prejšnji dan; DST začetek
 *      2026-03-29 → 23:00Z; zima → 23:00Z; poletje → 22:00Z;
 *   2. periodBounds: end = lokalna polnoč dneva ZA endISO (EKSKLUZIVNA meja);
 *      obdobje čez DST prehod (CEST→CET) je 11 koledarskih dni + 1 h;
 *   3. validatePeriodRange: start > konec / span > 62 / konec v prihodnosti /
 *      slab ISO → napaka; veljavno 31 dni OK; MAX_PERIOD_DAYS = 62;
 *   4. toEntryRow: zaprt nočni vnos (neto 510, bruto iz POSNETKA totalPay) +
 *      odprt vnos → neto 0 / bruto 0; datum = lokalni dateKey;
 *   5. toEntryRow: 450 min × 8,50 €/h = 6375 centov (centna aritmetika, brez
 *      float drifta);
 *   6. findPayrollExceptions: VSEH 7 kod (OPEN_ENTRY/UNAPPROVED/RATE_ZERO/
 *      RATE_MISMATCH/OVERLAP/LONG_NO_BREAK/SHIFT_NO_ENTRY) + employeeName +
 *      slovenski detail;
 *   7. OVERLAP: dotikajoča se okna [in, out) NISO prekrivanje; par prekrivajočih
 *      → točno ENA izjema;
 *   8. plannedMinutesFromShifts: 22:00–06:00 čez polnoč → 480; 09:00–17:00 − 30
 *      odmora → 450; cancelled/no_show se ne štejeta;
 *   9. csvField: narekovaji ob ; " \n \r in vejico (šumniki!), podvojeni ",
 *      število → String, null → '';
 *  10. buildPayrollCsv: BOM + CRLF + glava vnosov + SKUPAJ + Shema +
 *      KontrolniHash + OpombaZaklepa (quotana) + noga (napitnine pending,
 *      zunanji sistem) + EUR z decimalno VEJICO;
 *  11. rowDigestOf/diffRowDigest: isto → 0; sprememba statusa → 2 (stara + nova
 *      vrstica); odstranitev/dodaja → 1; digest BREZ imen (PII);
 *  12. canonicalExportJson: rekurzivno sortirani ključi — vrstni red vstavljanja
 *      ne vpliva na niz;
 *  13. periodDto (ISO meji + lokalna startISO/endISO) + exceptionsSummary;
 *  B. POST/GET /api/payroll: 201 DTO (draft, v1, tz lokacije, ekskluzivna meja,
 *      audit PAYROLL_PERIOD_CREATED); seznam z exportCount + locationScope
 *      (manager tuje lokacije NE vidi); validacije 400 (konec < začetek, > 62
 *      dni, prihodnost, slab ISO); prekrivanje 409; sosednje obdobje 201;
 *      tuji body locationId NON-central ignorira (fail-closed lastna lokacija),
 *      centralna vloga ga upošteva; waiter 403; brez žetona 401; pre-DDL 503;
 *  C. GET [id] DETALJ: žive vsote (samo approved) nasproti snapshot 0 v draftu;
 *      zaposleni po (employeeId, jobId) — več delovnih mest = ločena agregata z
 *      lastnim neto/bruto/rateRange; jobName pad iz PRIMARNE dodelitve;
 *      plannedMinutes/varianceMinutes; izjeme s kodami + imeni + povzetek;
 *      404/403/401;
 *  D. close: brez ack → 409 { error, exceptions: {koda: števec} }; z ack → 200 +
 *      snapshot (samo approved; odprt vnos se NE šteje) + version 1 + audit
 *      PAYROLL_PERIOD_CLOSED (števci); dvojni zaklep 409; čisto obdobje (brez
 *      vnosov) zaklene brez ack;
 *  E. reopen + čuvaj timeclock: PATCH vnosa v ZAKLJUČENEM obdobju → 409
 *      (EXAKTNO sporočilo); reopen draft → 409; razlog < 3 znaki → 400; reopen
 *      veljaven → draft, reopenCount 1, snapshot OSTANE; PATCH po reopen → 200;
 *      ponovni zaklep → version 2; audit PAYROLL_PERIOD_REOPENED z razlogom;
 *  F. export: draft → 409; CSV (text/csv, attachment obracun-…-vN-iM.csv, BOM,
 *      ';', CRLF, stabilni entryId-ji, ime z vejico + šumniki QUOTED, EUR z
 *      vejico, SKUPAJ vrstica); napitnine pending izvožene a NE v plačani vsoti;
 *      JSON (schemaVersion payroll-export/2, rows s statusom, seq); ponovni
 *      izvoz identične vsebine → identicalToPrevious true + changedEntries 0 +
 *      seq +1; po spremembi + ponovnem zaključku → changedEntries > 0;
 *      PayrollExport vrstica z rowDigest BREZ PII; audit PAYROLL_EXPORTED brez
 *      imen; 401/403/403; velike ure (10000 min → 166667 centov);
 *  G. EmployeeJob CRUD: PUT replace-set + GET (payRateCents, isPrimary);
 *      avto-primarna (prva vrstica); -1/10001/3 decimalke → 400; neznano +
 *      neaktivno delo → 404; podvojen jobId → 400; > 8 → 400; audit
 *      EMPLOYEE_JOBS_UPDATED BREZ zneskov; tuja lokacija 403; brez žetona 401;
 *  H. REGISTER/DRIFT/I18N: 'payroll-periods' v SCHEMA_MIGRATIONS (#27) +
 *      endpoint + descKey; mig.payrollPeriods.desc v SL/HR; drift matcher
 *      isPayrollPeriodsStatement; tabs.obracun = employees.manage; payr.*
 *      pariteta SL/HR.
 *
 * Fiksture s predpono i22- (TEST_PREFIXES + LOCATION_CHILD_SWEEP payrollPeriod,
 * dodal 3-b); PayrollExport NIMA locationId → čistimo ROČNO po periodId +
 * exportedById; EmployeeJob z nid() id → ROČNO po employeeId; audit PAYROLL_* ima
 * nid() entityId → ROČNO po locationId predponi. Časovni pas fiksur je
 * Europe/Ljubljana; obdobja so v preteklosti (konec ≤ todayKey).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { nid, num } from '../src/lib/map'
import {
  localMidnightUtc,
  periodBounds,
  validatePeriodRange,
  MAX_PERIOD_DAYS,
  toEntryRow,
  findPayrollExceptions,
  plannedMinutesFromShifts,
  csvField,
  buildPayrollCsv,
  canonicalExportJson,
  rowDigestOf,
  diffRowDigest,
  periodDto,
  exceptionsSummary,
  EXPORT_SCHEMA_VERSION,
  type PayrollEntryInput,
  type PayrollEntryRow,
  type PayrollPeriodRow,
  type TipExportRow,
} from '../src/lib/payroll'
import { __setPayrollTablesCacheForTests, __resetPayrollTablesCacheForTests } from '../src/lib/payroll-schema'
import { GET as payrollGET, POST as payrollPOST } from '../src/app/api/payroll/route'
import { GET as payrollDetailGET } from '../src/app/api/payroll/[id]/route'
import { POST as payrollClosePOST } from '../src/app/api/payroll/[id]/close/route'
import { POST as payrollReopenPOST } from '../src/app/api/payroll/[id]/reopen/route'
import { GET as payrollExportGET } from '../src/app/api/payroll/[id]/export/route'
import { GET as employeeJobsGET, PUT as employeeJobsPUT } from '../src/app/api/employees/[id]/jobs/route'
import { PATCH as timeclockPATCH } from '../src/app/api/timeclock/[id]/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { TAB_PERM } from '../src/lib/tab-permissions'
import { sl as slDict } from '../src/lib/i18n/sl'
import { hr as hrDict } from '../src/lib/i18n/hr'

const P = 'i22-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TZ = 'Europe/Ljubljana'
const D = (iso: string) => new Date(iso)

// pričakovane vsote fiksur (glavno obdobje p1, 2026-09-07 .. 2026-09-13):
//   vnosi: e1(450,6375c,jobA) e2(510,8500c,jobB) e3(ODPRT) e4(120,0c,active)
//          e5(480,10000c,jobA) e6(60,1000c,jobA) e8(420,7700c,null)
//          e9(240,4000c,jobA) e10(240,4000c,jobA) → 9 vnosov, 7 potrjenih
//   neto (approved): 2400 min; bruto: 41575 c; izjeme: 7 (vsaka koda 1×)
const GROSS_DRAFT = 41575
const NET_DRAFT = 2400

let locA = ''
let locB = ''
let jobA = ''
let jobB = ''
let jobC = ''
let mgrA = ''
let mgrB = ''
let waiterA = ''
let adminA = ''
let emp1 = '' // "Natakar Žiga, Jr." — ime z vejico + šumniki (CSV quoting)
let emp2 = '' // odprt/nepotrjen/vrhunske izjeme
let emp3 = '' // izmene (načrt) + vnos brez jobId (pad primarne dodelitve)
let emp4 = '' // prekrivajoča se vnosa
let emp5 = '' // EmployeeJob CRUD (G)
let tokA = ''
let tokB = ''
let tokWaiter = ''
let tokAdmin = ''

let e1 = ''
let e4 = ''
let e8 = ''
let p1 = ''
let p2 = ''
let p3 = ''
let pLocB = ''
let csv1 = '' // CSV iz F2 (ponovno uporabljen v F3 — brez novega izvoza)

const NAME1 = `${P}Natakar Žiga, Jr.`
const NAME2 = `${P}Kuhar Ana`
const NAME3 = `${P}Natakarka Mojca`
const NAME4 = `${P}Picer Anže`
const NAME5 = `${P}Pinči Uroš`

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function seedEmployee(key: string, name: string, role: string, loc: string | null, seq: number): Promise<string> {
  const id = `${P}${key}-${RUN}`
  const pin = `${PIN_BASE}${seq}`
  const f = employeePinFields(pin, `${id}@test.local`)
  await db.employee.create({
    data: {
      id, name, email: `${id}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

interface MkEntryOpts {
  employeeId: string
  jobId?: string | null
  clockIn: Date
  clockOut: Date | null
  breakMinutes?: number
  totalMinutes?: number
  payRate?: number
  totalPay?: number
  type?: string
  status?: string
}

let entrySeq = 0

/** Vnos delovnega časa DIREKTNO v DB (popoln nadzor nad posnetkom/statusom/jobId). */
async function mkEntry(o: MkEntryOpts): Promise<string> {
  const id = `${P}te-${++entrySeq}-${RUN}`
  const closed = o.clockOut !== null
  await db.timeEntry.create({
    data: {
      id,
      employeeId: o.employeeId,
      jobId: o.jobId ?? null,
      clockIn: o.clockIn,
      clockOut: o.clockOut,
      breakStart: null,
      breakEnd: null,
      breakMinutes: o.breakMinutes ?? 0,
      totalMinutes: closed ? (o.totalMinutes ?? 0) : 0,
      payRate: o.payRate ?? 0,
      totalPay: closed ? (o.totalPay ?? 0) : 0,
      type: o.type ?? 'regular',
      status: o.status ?? 'approved',
      notes: '',
      locationId: locA,
    },
  })
  return id
}

/** Obdobje prek RUTE (201) — vrača id. */
async function mkPeriod(token: string, start: string, end: string, loc = locA): Promise<string> {
  const r = await payrollPOST(req('POST', '/api/payroll', token, { locationId: loc, start, end }))
  expect(r.status).toBe(201)
  const j = await body(r)
  return String((j.period as Record<string, unknown>).id)
}

/**
 * Ročno čiščenje modelov, ki jih ID_SWEEP/LOCATION_CHILD_SWEEP ne pokrijeta:
 *  - PayrollExport (nid() id, BREZ locationId) → po periodId naših obdobij +
 *    exportedById predpona (varovalka za sirote),
 *  - EmployeeJob iz PUT rute (nid() id) → po employeeId predponi,
 *  - audit PAYROLL_* / EXPORT (nid() entityId) → po locationId predponi,
 *  - TIMECLOCK_UPDATE audit (brez locationId) → entityId = predponski entryId.
 */
async function cleanup() {
  const periods = await db.payrollPeriod
    .findMany({ where: { locationId: { startsWith: P } }, select: { id: true } })
    .catch(() => [] as { id: string }[])
  if (periods.length > 0) {
    await db.payrollExport.deleteMany({ where: { periodId: { in: periods.map((x) => x.id) } } }).catch(() => null)
  }
  await db.payrollExport.deleteMany({ where: { exportedById: { startsWith: P } } }).catch(() => null)
  await db.payrollPeriod.deleteMany({ where: { locationId: { startsWith: P } } }).catch(() => null)
  await db.timeEntry.deleteMany({ where: { employeeId: { startsWith: P } } }).catch(() => null)
  await db.tipDistribution.deleteMany({ where: { tipPoolId: { startsWith: P } } }).catch(() => null)
  await db.tipPool.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.employeeJob.deleteMany({ where: { employeeId: { startsWith: P } } }).catch(() => null)
  await db.staffShift.deleteMany({ where: { employeeId: { startsWith: P } } }).catch(() => null)
  await db.job.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.auditLog
    .deleteMany({ where: { OR: [{ locationId: { startsWith: P } }, { entityId: { startsWith: P } }] } })
    .catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()
  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `I22A-${RUN.toUpperCase()}`, timezone: TZ },
  })
  const lb = await db.location.create({
    data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `I22B-${RUN.toUpperCase()}`, timezone: TZ },
  })
  locA = la.id
  locB = lb.id

  mgrA = await seedEmployee('mgrA', `${P}Vodja Ana`, 'manager', locA, 1)
  mgrB = await seedEmployee('mgrB', `${P}Vodja Bori`, 'manager', locB, 2)
  waiterA = await seedEmployee('waiterA', `${P}Natakar Timi`, 'waiter', locA, 3)
  adminA = await seedEmployee('adminA', `${P}Admin Central`, 'admin', locA, 4)
  emp1 = await seedEmployee('emp1', NAME1, 'waiter', locA, 5)
  emp2 = await seedEmployee('emp2', NAME2, 'chef', locA, 6)
  emp3 = await seedEmployee('emp3', NAME3, 'waiter', locA, 7)
  emp4 = await seedEmployee('emp4', NAME4, 'waiter', locA, 8)
  emp5 = await seedEmployee('emp5', NAME5, 'waiter', locA, 9)
  tokA = createToken({ sub: mgrA, name: `${P}Vodja Ana`, role: 'MANAGER', loc: locA, sv: 0 })
  tokB = createToken({ sub: mgrB, name: `${P}Vodja Bori`, role: 'MANAGER', loc: locB, sv: 0 })
  tokWaiter = createToken({ sub: waiterA, name: `${P}Natakar Timi`, role: 'WAITER', loc: locA, sv: 0 })
  tokAdmin = createToken({ sub: adminA, name: `${P}Admin Central`, role: 'ADMIN', loc: locA, sv: 0 })

  // delovna mesta (Job je GLOBALEN — predponski id/name za čistost)
  jobA = `${P}jobA-${RUN}`
  jobB = `${P}jobB-${RUN}`
  jobC = `${P}jobC-${RUN}`
  await db.job.create({ data: { id: jobA, name: `${P}Natakar ${RUN}`, basePayRate: 10, isActive: true } })
  await db.job.create({ data: { id: jobB, name: `${P}Kuhar ${RUN}`, basePayRate: 12.5, isActive: true } })
  await db.job.create({ data: { id: jobC, name: `${P}Picer-neaktivno ${RUN}`, basePayRate: 10, isActive: false } })

  // trenutne plačne postavke (vir za RATE_MISMATCH + pad primarnega imena)
  await db.employeeJob.create({ data: { id: `${P}ej-1a-${RUN}`, employeeId: emp1, jobId: jobA, payRate: 8.5, isPrimary: true } })
  await db.employeeJob.create({ data: { id: `${P}ej-1b-${RUN}`, employeeId: emp1, jobId: jobB, payRate: 10, isPrimary: false } })
  await db.employeeJob.create({ data: { id: `${P}ej-2-${RUN}`, employeeId: emp2, jobId: jobA, payRate: 12.5, isPrimary: true } })
  await db.employeeJob.create({ data: { id: `${P}ej-3-${RUN}`, employeeId: emp3, jobId: jobB, payRate: 11, isPrimary: true } })

  // vnosi v oknu p1 (2026-09-07 .. 2026-09-13, UTC instanti lokalnih časov)
  e1 = await mkEntry({ employeeId: emp1, jobId: jobA, clockIn: D('2026-09-08T07:00:00Z'), clockOut: D('2026-09-08T15:00:00Z'), breakMinutes: 30, totalMinutes: 450, payRate: 8.5, totalPay: 63.75 })
  await mkEntry({ employeeId: emp1, jobId: jobB, clockIn: D('2026-09-09T20:00:00Z'), clockOut: D('2026-09-10T05:00:00Z'), breakMinutes: 30, totalMinutes: 510, payRate: 10, totalPay: 85 })
  await mkEntry({ employeeId: emp2, jobId: null, clockIn: D('2026-09-11T06:00:00Z'), clockOut: null, payRate: 10, status: 'active' }) // OPEN_ENTRY
  e4 = await mkEntry({ employeeId: emp2, jobId: null, clockIn: D('2026-09-12T06:00:00Z'), clockOut: D('2026-09-12T08:00:00Z'), breakMinutes: 0, totalMinutes: 120, payRate: 0, totalPay: 0, status: 'active' }) // UNAPPROVED + RATE_ZERO
  await mkEntry({ employeeId: emp2, jobId: jobA, clockIn: D('2026-09-12T08:30:00Z'), clockOut: D('2026-09-12T16:30:00Z'), breakMinutes: 0, totalMinutes: 480, payRate: 12.5, totalPay: 100 }) // LONG_NO_BREAK
  await mkEntry({ employeeId: emp2, jobId: jobA, clockIn: D('2026-09-12T17:00:00Z'), clockOut: D('2026-09-12T18:00:00Z'), breakMinutes: 0, totalMinutes: 60, payRate: 10, totalPay: 10 }) // RATE_MISMATCH (10 vs 12,50)
  e8 = await mkEntry({ employeeId: emp3, jobId: null, clockIn: D('2026-09-11T07:00:00Z'), clockOut: D('2026-09-11T14:30:00Z'), breakMinutes: 30, totalMinutes: 420, payRate: 11, totalPay: 77 })
  await mkEntry({ employeeId: emp4, jobId: jobA, clockIn: D('2026-09-08T07:00:00Z'), clockOut: D('2026-09-08T11:00:00Z'), breakMinutes: 0, totalMinutes: 240, payRate: 10, totalPay: 40 })
  await mkEntry({ employeeId: emp4, jobId: jobA, clockIn: D('2026-09-08T10:00:00Z'), clockOut: D('2026-09-08T14:00:00Z'), breakMinutes: 0, totalMinutes: 240, payRate: 10, totalPay: 40 }) // OVERLAP par

  // izmene emp3: 09-10 (brez vnosa → SHIFT_NO_ENTRY) + 09-11 22:00–06:00 (čez polnoč, −30)
  await db.staffShift.create({ data: { id: `${P}sh-1-${RUN}`, employeeId: emp3, shiftDate: D('2026-09-10T00:00:00Z'), startTime: '09:00', endTime: '17:00', breakMinutes: 0, status: 'confirmed', locationId: locA } })
  await db.staffShift.create({ data: { id: `${P}sh-2-${RUN}`, employeeId: emp3, shiftDate: D('2026-09-11T00:00:00Z'), startTime: '22:00', endTime: '06:00', breakMinutes: 30, status: 'confirmed', locationId: locA } })

  // napitnine: pool1 v oknu (gotovina 30 + kartica 20; 30 pending + 20 paid),
  // pool3 IZVEN okna (kontrola, da se ne šteje)
  await db.tipPool.create({ data: { id: `${P}pool1-${RUN}`, date: D('2026-09-09T00:00:00Z'), cashTips: 30, cardTips: 20, totalTips: 50, status: 'pending', locationId: locA } })
  await db.tipDistribution.create({ data: { id: `${P}dist1-${RUN}`, tipPoolId: `${P}pool1-${RUN}`, employeeId: emp1, employeeName: NAME1, amount: 30, hoursWorked: 8, points: 1, status: 'pending' } })
  await db.tipDistribution.create({ data: { id: `${P}dist2-${RUN}`, tipPoolId: `${P}pool1-${RUN}`, employeeId: emp2, employeeName: NAME2, amount: 20, hoursWorked: 4, points: 1, status: 'paid', paidAt: D('2026-09-10T08:00:00Z') } })
  await db.tipPool.create({ data: { id: `${P}pool3-${RUN}`, date: D('2026-08-30T00:00:00Z'), cashTips: 100, cardTips: 0, totalTips: 100, status: 'paid', locationId: locA } })
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ A. čisti motor (payroll.ts) ═══════════════════ */

function mkEntryInput(over: Partial<PayrollEntryInput> = {}): PayrollEntryInput {
  return {
    id: 'i22-e-test',
    employeeId: 'i22-emp-test',
    jobId: 'i22-job-test',
    clockIn: D('2026-09-08T07:00:00Z'),
    clockOut: D('2026-09-08T15:00:00Z'),
    breakMinutes: 30,
    totalMinutes: 450,
    payRate: 10,
    totalPay: 75,
    type: 'regular',
    status: 'approved',
    locationId: 'i22-loc-test',
    Employee: { name: 'i22-Test Zaposleni' },
    Job: { name: 'i22-Test Delo' },
    ...over,
  }
}

function mkRow(entryId: string, netMinutes: number, grossCents: number, status: string, over: Partial<PayrollEntryRow> = {}): PayrollEntryRow {
  return {
    entryId,
    employeeId: 'i22-emp-test',
    employeeName: 'i22-Test Zaposleni',
    jobId: 'i22-job-test',
    jobName: 'i22-Test Delo',
    date: '2026-09-08',
    clockIn: '2026-09-08T07:00:00.000Z',
    clockOut: '2026-09-08T15:00:00.000Z',
    breakMinutes: 30,
    netMinutes,
    payRateCents: 850,
    grossCents,
    type: 'regular',
    status,
    locationId: 'i22-loc-test',
    ...over,
  }
}

describe('A. payroll.ts čisti motor', () => {
  it('A1. localMidnightUtc: DST konec/začetek + zima/poletje (3-iteracijska fiksna točka)', () => {
    // konec DST (CEST→CET ob 01:00Z): polnoč 25.10. je ŠE v CEST → 22:00Z prejšnji dan
    expect(localMidnightUtc('2026-10-25', TZ).toISOString()).toBe('2026-10-24T22:00:00.000Z')
    // začetek DST (CET→CEST ob 01:00Z): polnoč 29.3. je ŠE v CET → 23:00Z prejšnji dan
    expect(localMidnightUtc('2026-03-29', TZ).toISOString()).toBe('2026-03-28T23:00:00.000Z')
    // sredina zime (CET): 23:00Z prejšnji dan
    expect(localMidnightUtc('2026-01-15', TZ).toISOString()).toBe('2026-01-14T23:00:00.000Z')
    // sredina poletja (CEST): 22:00Z prejšnji dan
    expect(localMidnightUtc('2026-07-01', TZ).toISOString()).toBe('2026-06-30T22:00:00.000Z')
  })

  it('A2. periodBounds: end = lokalna polnoč dneva ZA endISO (EKSKLUZIVNO); DST prehod +1 h', () => {
    const b = periodBounds('2026-01-01', '2026-01-31', TZ)
    expect(b.start.toISOString()).toBe('2025-12-31T23:00:00.000Z')
    expect(b.end.toISOString()).toBe('2026-01-31T23:00:00.000Z') // polnoč 1.2. = prvi trenutek IZVEN
    // 20.10. .. 30.10. = 11 koledarskih dni čez konec DST → 11×24 h + 1 h = 265 h
    const d = periodBounds('2026-10-20', '2026-10-30', TZ)
    expect(d.start.toISOString()).toBe('2026-10-19T22:00:00.000Z') // CEST
    expect(d.end.toISOString()).toBe('2026-10-30T23:00:00.000Z') // CET
    expect(d.end.getTime() - d.start.getTime()).toBe(265 * 3_600_000)
  })

  it('A3. validatePeriodRange: 4 napake + veljavno 31 dni; MAX_PERIOD_DAYS 62', () => {
    const reversed = validatePeriodRange('2026-01-10', '2026-01-05', '2026-10-16')
    expect(reversed.ok).toBe(false)
    expect(reversed.ok === false && reversed.error).toContain('za koncem')
    const span = validatePeriodRange('2026-01-01', '2026-03-04', '2026-10-16') // 63 dni
    expect(span.ok).toBe(false)
    expect(span.ok === false && span.error).toContain('62')
    const future = validatePeriodRange('2026-10-01', '2026-12-01', '2026-10-16')
    expect(future.ok).toBe(false)
    expect(future.ok === false && future.error).toContain('prihodnosti')
    expect(validatePeriodRange('20260901', '2026-09-30', '2026-10-16').ok).toBe(false)
    expect(validatePeriodRange('2026-02-30', '2026-03-05', '2026-10-16').ok).toBe(false) // round-trip sanity
    expect(validatePeriodRange('2026-01-01', '2026-01-31', '2026-02-01')).toEqual({ ok: true })
    expect(MAX_PERIOD_DAYS).toBe(62)
  })

  it('A4. toEntryRow: zaprt nočni vnos (neto 510, bruto iz POSNETKA) + odprt vnos → 0/0', () => {
    const closed = toEntryRow(
      mkEntryInput({ clockIn: D('2026-09-09T20:00:00Z'), clockOut: D('2026-09-10T05:00:00Z'), breakMinutes: 30, totalMinutes: 510, payRate: 10, totalPay: 85 }),
      TZ,
      'i22-Pad delo',
    )
    expect(closed.netMinutes).toBe(510)
    expect(closed.grossCents).toBe(8500)
    expect(closed.payRateCents).toBe(1000)
    expect(closed.date).toBe('2026-09-09') // lokalni datum prijave
    expect(closed.clockIn).toBe('2026-09-09T20:00:00.000Z')
    expect(closed.clockOut).toBe('2026-09-10T05:00:00.000Z')
    expect(closed.breakMinutes).toBe(30)
    expect(closed.jobName).toBe('i22-Test Delo') // Job.name iz vnosa
    const open = toEntryRow(mkEntryInput({ clockOut: null, totalMinutes: 510, totalPay: 85, Job: null }), TZ, '')
    expect(open.netMinutes).toBe(0) // odprt vnos prispeva 0
    expect(open.grossCents).toBe(0)
    expect(open.clockOut).toBeNull()
    expect(open.jobName).toBe('') // pad, kadar Job manjka
  })

  it('A5. toEntryRow: 450 min × 8,50 €/h = 6375 centov (brez float drifta)', () => {
    const r = toEntryRow(mkEntryInput({ totalMinutes: 450, payRate: 8.5, totalPay: 63.75 }), TZ, '')
    expect(r.netMinutes).toBe(450)
    expect(r.payRateCents).toBe(850)
    expect(r.grossCents).toBe(6375)
  })

  it('A6. findPayrollExceptions: vseh 7 kod po enkrat + employeeName + slovenski detail', () => {
    const ex = findPayrollExceptions(
      [
        mkEntryInput({ id: 'x-open', clockOut: null }),
        mkEntryInput({ id: 'x-zero', employeeId: 'e1', payRate: 0, totalPay: 0, Employee: { name: 'i22-Ime A' } }),
        mkEntryInput({ id: 'x-unappr', employeeId: 'e2', status: 'active', Employee: { name: 'i22-Ime B' } }),
        mkEntryInput({ id: 'x-long', employeeId: 'e3', totalMinutes: 420, breakMinutes: 0, Employee: { name: 'i22-Ime C' } }),
        mkEntryInput({ id: 'x-rate', employeeId: 'e4', jobId: 'job-m', payRate: 10, totalPay: 75, Employee: { name: 'i22-Ime D' } }),
        mkEntryInput({ id: 'x-ov1', employeeId: 'e5', clockIn: D('2026-09-08T07:00:00Z'), clockOut: D('2026-09-08T11:00:00Z'), Employee: { name: 'i22-Ime E' } }),
        mkEntryInput({ id: 'x-ov2', employeeId: 'e5', clockIn: D('2026-09-08T10:00:00Z'), clockOut: D('2026-09-08T14:00:00Z'), Employee: { name: 'i22-Ime E' } }),
      ],
      [{ id: 's1', employeeId: 'e9', shiftDate: D('2026-09-15T00:00:00Z'), startTime: '09:00', endTime: '17:00', breakMinutes: 0, status: 'confirmed', Employee: { name: 'i22-Ime F' } }],
      [{ employeeId: 'e4', jobId: 'job-m', payRate: 12.5, isPrimary: true }],
      TZ,
    )
    const codes = ex.map((x) => x.code)
    for (const code of ['OPEN_ENTRY', 'UNAPPROVED', 'RATE_ZERO', 'RATE_MISMATCH', 'OVERLAP', 'LONG_NO_BREAK', 'SHIFT_NO_ENTRY']) {
      expect(codes.filter((c) => c === code)).toHaveLength(1)
    }
    const mismatch = ex.find((x) => x.code === 'RATE_MISMATCH')!
    expect(mismatch.employeeName).toBe('i22-Ime D')
    expect(mismatch.detail).toContain('10,00 €')
    expect(mismatch.detail).toContain('12,50 €')
    const open = ex.find((x) => x.code === 'OPEN_ENTRY')!
    expect(open.employeeName).toBe('i22-Test Zaposleni')
    expect(open.detail).toContain('Manjka odjava')
    expect(ex.find((x) => x.code === 'SHIFT_NO_ENTRY')!.employeeName).toBe('i22-Ime F')
    expect(ex.find((x) => x.code === 'RATE_ZERO')!.entryId).toBe('x-zero')
  })

  it('A7. OVERLAP: dotikajoča se okna [in, out) niso prekrivanje; par → točno ENA izjema; RAZLIČNA zaposlena nikoli', () => {
    const a = mkEntryInput({ id: 'o1', employeeId: 'ov', clockIn: D('2026-09-08T07:00:00Z'), clockOut: D('2026-09-08T11:00:00Z') })
    const b = mkEntryInput({ id: 'o2', employeeId: 'ov', clockIn: D('2026-09-08T11:00:00Z'), clockOut: D('2026-09-08T15:00:00Z') })
    expect(findPayrollExceptions([a, b], [], [], TZ).filter((x) => x.code === 'OVERLAP')).toHaveLength(0)
    const c = mkEntryInput({ id: 'o3', employeeId: 'ov', clockIn: D('2026-09-08T10:00:00Z'), clockOut: D('2026-09-08T15:00:00Z') })
    const overlaps = findPayrollExceptions([a, c], [], [], TZ).filter((x) => x.code === 'OVERLAP')
    expect(overlaps).toHaveLength(1) // obratni par se NE ponovi
    expect(overlaps[0].detail).toContain('60') // minut prekrivanja
    // REGRESIJA bugfixa #22: IDENTIČNO okno RAZLIČNIH zaposlenih ni prekrivanje
    // (vzporedne izmene so normalno delo — prej je koda primerjala vse pare)
    const other = mkEntryInput({ id: 'o4', employeeId: 'drug-zaposleni', clockIn: D('2026-09-08T07:00:00Z'), clockOut: D('2026-09-08T15:00:00Z') })
    expect(findPayrollExceptions([a, c, other], [], [], TZ).filter((x) => x.code === 'OVERLAP')).toHaveLength(1)
  })

  it('A8. plannedMinutesFromShifts: čez polnoč 480; − odmor 450; cancelled/no_show ne štejeta', () => {
    const sh = (id: string, employeeId: string, start: string, end: string, brk: number, status: string) => ({
      id,
      employeeId,
      shiftDate: D('2026-09-10T00:00:00Z'),
      startTime: start,
      endTime: end,
      breakMinutes: brk,
      status,
      Employee: { name: `i22-${employeeId}` },
    })
    const out = plannedMinutesFromShifts(
      [sh('s1', 'p1', '22:00', '06:00', 0, 'confirmed'), sh('s2', 'p2', '09:00', '17:00', 30, 'confirmed'), sh('s3', 'p2', '18:00', '22:00', 0, 'cancelled'), sh('s4', 'p1', '10:00', '12:00', 0, 'no_show')],
      TZ,
    )
    const by = new Map(out.map((x) => [x.employeeId, x]))
    expect(out.length).toBe(2)
    expect(by.get('p1')!.plannedMinutes).toBe(480) // čez polnoč +24 h
    expect(by.get('p1')!.shiftCount).toBe(1)
    expect(by.get('p2')!.plannedMinutes).toBe(450) // 480 − 30 odmora
  })

  it('A9. csvField: narekovaji ob ; " \n \r (ločilo je ;, NE vejica); število → String; null → prazno', () => {
    expect(csvField('abc')).toBe('abc')
    expect(csvField('a;b')).toBe('"a;b"')
    expect(csvField('a"b')).toBe('"a""b"')
    // vejica NI ločilo (';' je) — šumniki/vejice gredo skozi BREZ narekovajev
    expect(csvField('šumnik Žiga, Jr.')).toBe('šumnik Žiga, Jr.')
    expect(csvField(12)).toBe('12')
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
    expect(csvField('nov\nvrst')).toBe('"nov\nvrst"')
  })

  it('A10. buildPayrollCsv: BOM + CRLF + glava + SKUPAJ + shema + hash + noga + EUR vejica', () => {
    const tip: TipExportRow = { distributionId: 'i22-d1', employeeId: 'i22-emp1', employeeName: NAME1, amountCents: 3000, status: 'pending', poolId: 'i22-pool', poolDate: '2026-09-09', poolCashCents: 3000, poolCardCents: 2000 }
    const csv = buildPayrollCsv({
      period: { id: 'i22-per', locationId: 'i22-loc', startISO: '2026-09-07', endISO: '2026-09-13', timezone: TZ, status: 'closed', version: 2, closeNote: 'Test; opomba' },
      rows: [mkRow('i22-e1', 450, 6375, 'approved'), mkRow('i22-e2', 120, 0, 'active')],
      tips: [tip],
      totals: { entryCount: 2, approvedCount: 1, netMinutesApproved: 450, grossPayCents: 6375, cashTipsCents: 3000, cardTipsCents: 2000, tipsPendingCents: 3000, tipsPaidCents: 2000 },
      // v1.192.0 (P3 #19): doplačilne osnove — prazen set (osnovna shema /2 vhod)
      surchargeBases: { perEmployeeJob: [], overtime: [] },
      exportMeta: { seq: 1, generatedISO: '2026-10-16T10:00:00.000Z', contentHash8: 'abcd1234', changedEntries: 0, identicalToPrevious: false },
    })
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.includes('\r\n')).toBe(true)
    expect(csv.includes('OBRAČUN PLAČ - RestaurantOS')).toBe(true)
    expect(csv.includes('ZaposleniID;Zaposleni;DeloID;Delo;Datum;Prihod;Odhod;OdmorMin;NetoMin;PostavkaEUR;BrutoEUR;Tip;Status;VnosID')).toBe(true)
    expect(csv.includes('SKUPAJ;Vnosi;2;Potrjeni;1;NetoMin;450;BrutoEUR;63,75')).toBe(true)
    expect(csv.includes(`Shema;${EXPORT_SCHEMA_VERSION}`)).toBe(true)
    expect(csv.includes('KontrolniHash;abcd1234')).toBe(true)
    expect(csv.includes('OpombaZaklepa;"Test; opomba"')).toBe(true) // ';' sproži narekovaje
    expect(csv.includes('Napitnine pending se ne stejejo kot izplacane.')).toBe(true)
    expect(csv.includes('RestaurantOS ne izracunava odstotkov doplacil')).toBe(true)
    expect(csv.includes(`;${NAME1};`)).toBe(true) // ime gre skozi (vejica ni ločilo)
    expect(csv.includes('63,75')).toBe(true) // EUR z decimalno vejico
  })

  it('A11. rowDigestOf/diffRowDigest: isto → 0; status → 2; odstrani/dodaj → 1; BREZ PII', () => {
    const r1 = mkRow('i22-e1', 450, 6375, 'approved')
    const r2 = mkRow('i22-e2', 510, 8500, 'approved')
    const tip: TipExportRow = { distributionId: 'i22-d1', employeeId: 'i22-emp1', employeeName: NAME1, amountCents: 3000, status: 'pending', poolId: 'i22-p', poolDate: '2026-09-09', poolCashCents: 0, poolCardCents: 0 }
    const prev = rowDigestOf([r1, r2], [tip])
    expect(prev).toContain('i22-e1:450:6375:approved')
    expect(prev).toContain('i22-d1:3000:pending') // distribucije tudi v digestu
    expect(prev).not.toContain('Natakar') // digest BREZ imen
    expect(rowDigestOf([r2, r1], [tip])).toBe(prev) // vrstni red vnosov ne vpliva
    expect(diffRowDigest(prev, prev)).toBe(0)
    // sprememba statusa: stara in nova vrstica se razlikujeta → 2
    expect(diffRowDigest(prev, rowDigestOf([{ ...r1, status: 'disputed' }, r2], [tip]))).toBe(2)
    expect(diffRowDigest(prev, rowDigestOf([r1], [tip]))).toBe(1) // odstranitev
    expect(diffRowDigest(prev, rowDigestOf([r1, r2, mkRow('i22-e3', 60, 1000, 'approved')], [tip]))).toBe(1) // dodaja
  })

  it('A12. canonicalExportJson: rekurzivno sortirani ključi — vrstni red vstavljanja ne vpliva', () => {
    type Loose = Record<string, unknown>
    const a: Loose = { period: { id: 'i22-per', version: 2, closeNote: '' }, rows: [{ entryId: 'i22-e1', status: 'approved', netMinutes: 450 }], tips: [], totals: {} }
    const b: Loose = { rows: [{ netMinutes: 450, status: 'approved', entryId: 'i22-e1' }], totals: {}, period: { closeNote: '', version: 2, id: 'i22-per' }, tips: [] }
    const ja = canonicalExportJson(a as unknown as Parameters<typeof canonicalExportJson>[0])
    const jb = canonicalExportJson(b as unknown as Parameters<typeof canonicalExportJson>[0])
    expect(ja).toBe(jb)
    const parsed = JSON.parse(ja) as Loose
    expect(Object.keys(parsed).sort()).toEqual(['period', 'rows', 'tips', 'totals'])
    expect(Object.keys(parsed.period as Loose).sort()).toEqual(['closeNote', 'id', 'version'])
  })

  it('A13. periodDto: ISO meji + lokalna startISO/endISO (end −1 ms = zadnji dan); exceptionsSummary', () => {
    const b = periodBounds('2026-09-07', '2026-09-13', TZ)
    const row: PayrollPeriodRow = {
      id: 'i22-per', locationId: 'i22-loc', periodStart: b.start, periodEnd: b.end, timezone: TZ,
      status: 'closed', closedAt: D('2026-10-01T10:00:00Z'), closedById: 'i22-mgr', closeNote: 'opomba',
      reopenCount: 1, version: 2, entryCount: 9, approvedCount: 7, exceptionCount: 7, netMinutesApproved: 2400,
      grossPayCents: 41575, cashTipsCents: 3000, cardTipsCents: 2000, tipsPendingCents: 3000, tipsPaidCents: 2000,
    }
    const dto = periodDto(row)
    expect(dto.periodStart).toBe('2026-09-06T22:00:00.000Z')
    expect(dto.periodEnd).toBe('2026-09-13T22:00:00.000Z')
    expect(dto.startISO).toBe('2026-09-07')
    expect(dto.endISO).toBe('2026-09-13') // ekskluzivna meja −1 ms = lokalno zadnji dan
    expect(dto.closedAt).toBe('2026-10-01T10:00:00.000Z')
    expect(dto.closedById).toBe('i22-mgr')
    expect(dto.version).toBe(2)
    const sum = exceptionsSummary([
      { code: 'OPEN_ENTRY', employeeName: 'a', detail: 'x' },
      { code: 'OPEN_ENTRY', employeeName: 'b', detail: 'y' },
      { code: 'OVERLAP', employeeName: 'c', detail: 'z' },
    ])
    expect(sum.OPEN_ENTRY).toBe(2)
    expect(sum.OVERLAP).toBe(1)
  })
})

/* ═══════════════════ B. POST/GET /api/payroll ═══════════════════ */

describe('B. POST/GET /api/payroll (ustvarjanje + seznam)', () => {
  it('B1. ustvari 201 → DTO (draft, v1, tz lokacije, ekskluzivna meja) + audit', async () => {
    const r = await payrollPOST(req('POST', '/api/payroll', tokA, { locationId: locA, start: '2026-09-07', end: '2026-09-13' }))
    expect(r.status).toBe(201)
    const j = await body(r)
    const per = j.period as Record<string, unknown>
    p1 = String(per.id)
    expect(p1).toBeTruthy()
    expect(per.status).toBe('draft')
    expect(per.version).toBe(1)
    expect(per.timezone).toBe(TZ)
    expect(per.locationId).toBe(locA)
    expect(per.periodStart).toBe('2026-09-06T22:00:00.000Z')
    expect(per.periodEnd).toBe('2026-09-13T22:00:00.000Z')
    expect(per.startISO).toBe('2026-09-07')
    expect(per.endISO).toBe('2026-09-13')
    expect(per.reopenCount).toBe(0)
    expect(per.entryCount).toBe(0) // snapshot polja so 0 do zaklepa
    expect(per.grossPayCents).toBe(0)
    const audit = await db.auditLog.findFirst({ where: { action: 'PAYROLL_PERIOD_CREATED', entityId: p1 } })
    expect(audit).toBeTruthy()
    expect(audit?.userId).toBe(mgrA)
    expect(audit?.locationId).toBe(locA)
    expect(String(audit?.details)).toContain(`"start":"2026-09-07"`)
  })

  it('B2. GET seznam: manager vidi svoja obdobja + exportCount 0; tuja lokacija NE vidi', async () => {
    const rA = await payrollGET(req('GET', '/api/payroll', tokA))
    expect(rA.status).toBe(200)
    const jA = await body(rA)
    const periodsA = jA.periods as Array<Record<string, unknown>>
    const idsA = periodsA.map((x) => String(x.id))
    expect(idsA).toContain(p1)
    const p1row = periodsA.find((x) => String(x.id) === p1)!
    expect(p1row.exportCount).toBe(0)
    expect(p1row.lastExportAt).toBeNull()
    expect(p1row.status).toBe('draft')
    const rB = await payrollGET(req('GET', '/api/payroll', tokB))
    expect(rB.status).toBe(200)
    const idsB = ((await body(rB)).periods as Array<Record<string, unknown>>).map((x) => String(x.id))
    expect(idsB).not.toContain(p1) // locationScope — mgrB ne vidi locA obdobij
  })

  it('B3. validacija: konec < začetek / > 62 dni / prihodnost / slab ISO → 400', async () => {
    const cases: Array<[string, string, string]> = [
      ['2026-09-13', '2026-09-07', 'za koncem'],
      ['2026-07-01', '2026-10-10', 'predolgo'],
      ['2026-10-01', '2026-12-01', 'prihodnosti'],
      ['20260901', '2026-09-30', 'Neveljaven datum'],
    ]
    for (const [start, end, msg] of cases) {
      const r = await payrollPOST(req('POST', '/api/payroll', tokA, { start, end }))
      expect(r.status).toBe(400)
      expect(String((await body(r)).error)).toContain(msg)
    }
  })

  it('B4. prekrivanje 409; sosednje obdobje (dan ZA endISO) 201 ×2', async () => {
    const rOv = await payrollPOST(req('POST', '/api/payroll', tokA, { start: '2026-09-10', end: '2026-09-12' }))
    expect(rOv.status).toBe(409)
    expect(String((await body(rOv)).error)).toContain('prekriva')
    // meji se DOTIKATA (end = lokalna polnoč 14.9. = start soseda) — ni prekrivanja
    const rAdj = await payrollPOST(req('POST', '/api/payroll', tokA, { start: '2026-09-14', end: '2026-09-20' }))
    expect(rAdj.status).toBe(201)
    p2 = String(((await body(rAdj)).period as Record<string, unknown>).id)
    const rAdj2 = await payrollPOST(req('POST', '/api/payroll', tokA, { start: '2026-09-21', end: '2026-09-27' }))
    expect(rAdj2.status).toBe(201)
    p3 = String(((await body(rAdj2)).period as Record<string, unknown>).id) // ostane DRAFT (E/F)
  })

  it('B5. tuji body locationId: NON-central ga IGNORIRA (fail-closed lastna lokacija); centralna upošteva', async () => {
    // mgrB pošlje locA v telesu — requireUserLocation non-central VEDNO vrne lastno
    // lokacijo → obdobje nastane na locB, tujih lokacij ni mogoče odpreti
    const r = await payrollPOST(req('POST', '/api/payroll', tokB, { locationId: locA, start: '2026-09-07', end: '2026-09-13' }))
    expect(r.status).toBe(201)
    const per = (await body(r)).period as Record<string, unknown>
    expect(per.locationId).toBe(locB) // TUJ locationId je bil ignoriran
    pLocB = String(per.id)
    // centralna vloga (admin) upošteva IZRECNI body locationId
    const rAdm = await payrollPOST(req('POST', '/api/payroll', tokAdmin, { locationId: locB, start: '2026-08-17', end: '2026-08-23' }))
    expect(rAdm.status).toBe(201)
    expect(((await body(rAdm)).period as Record<string, unknown>).locationId).toBe(locB)
  })

  it('B6. waiter brez employees.manage → 403; brez žetona → 401', async () => {
    const r403 = await payrollPOST(req('POST', '/api/payroll', tokWaiter, { start: '2026-09-01', end: '2026-09-05' }))
    expect(r403.status).toBe(403)
    const r401 = await payrollPOST(req('POST', '/api/payroll', '', { start: '2026-09-01', end: '2026-09-05' }))
    expect(r401.status).toBe(401)
  })

  it('B7. pre-DDL: payrollTablesReady=false → GET/POST 503 → reset pravi stanje', async () => {
    __setPayrollTablesCacheForTests(false)
    try {
      const rList = await payrollGET(req('GET', '/api/payroll', tokA))
      expect(rList.status).toBe(503)
      expect(String((await body(rList)).error)).toContain('migracijo')
      const rPost = await payrollPOST(req('POST', '/api/payroll', tokA, { start: '2026-08-01', end: '2026-08-05' }))
      expect(rPost.status).toBe(503)
    } finally {
      __resetPayrollTablesCacheForTests()
    }
    const rAfter = await payrollGET(req('GET', '/api/payroll', tokA))
    expect(rAfter.status).toBe(200) // tabela obstaja → probe znova true
  })
})

/* ═══════════════════ C. GET /api/payroll/[id] (detalj) ═══════════════════ */

describe('C. GET /api/payroll/[id] (menedžerski pregled)', () => {
  it('C1. detalj 200: ŽIVE vsote (samo approved) nasproti snapshot 0 v draftu + napitnine', async () => {
    const r = await payrollDetailGET(req('GET', `/api/payroll/${p1}`, tokA), params(p1))
    expect(r.status).toBe(200)
    const j = await body(r)
    const totals = j.totals as Record<string, unknown>
    expect(totals.entryCount).toBe(9)
    expect(totals.approvedCount).toBe(7)
    expect(totals.netMinutesApproved).toBe(NET_DRAFT)
    expect(totals.grossPayCents).toBe(GROSS_DRAFT)
    expect(totals.cashTipsCents).toBe(3000)
    expect(totals.cardTipsCents).toBe(2000)
    expect(totals.tipsPendingCents).toBe(3000)
    expect(totals.tipsPaidCents).toBe(2000)
    // snapshot polja DTO ostanejo 0, dokler se obdobje ne zaklene (draft = žive vsote)
    const per = j.period as Record<string, unknown>
    expect(per.status).toBe('draft')
    expect(per.entryCount).toBe(0)
    expect(per.grossPayCents).toBe(0)
    // bazeni: pool1 v oknu (2 distribuciji), pool3 IZVEN okna se NE šteje
    const pools = j.tipPools as Array<Record<string, unknown>>
    expect(pools.length).toBe(1)
    expect(Number(pools[0].cashCents)).toBe(3000)
    expect(Number(pools[0].cardCents)).toBe(2000)
    expect(Number(pools[0].distributions)).toBe(2)
    expect((j.tips as unknown[]).length).toBe(2)
    // zgodovina izvozov še prazna
    expect((j.exports as unknown[]).length).toBe(0)
  })

  it('C2. zaposleni po (employeeId, jobId): več delovnih mest = 2 agregata z lastnimi vsotami', async () => {
    const r = await payrollDetailGET(req('GET', `/api/payroll/${p1}`, tokA), params(p1))
    expect(r.status).toBe(200)
    const j = await body(r)
    const employees = j.employees as Array<Record<string, unknown>>
    const emp1Aggs = employees.filter((x) => x.employeeId === emp1)
    expect(emp1Aggs.length).toBe(2) // jobA + jobB — LOČENA agregata
    const a1 = emp1Aggs.find((x) => x.jobId === jobA)!
    expect(a1.entryCount).toBe(1)
    expect(a1.approvedCount).toBe(1)
    expect(a1.netMinutes).toBe(450)
    expect(a1.grossCents).toBe(6375)
    expect(a1.rateRangeCents).toEqual([850, 850])
    const a2 = emp1Aggs.find((x) => x.jobId === jobB)!
    expect(a2.netMinutes).toBe(510)
    expect(a2.grossCents).toBe(8500)
    expect(a2.rateRangeCents).toEqual([1000, 1000])
    // emp2 (jobA): e5+e6 approved; e4 (jobId null) pade v lastno skupino z neto 0
    const emp2JobA = employees.find((x) => x.employeeId === emp2 && x.jobId === jobA)!
    expect(emp2JobA.entryCount).toBe(2)
    expect(emp2JobA.netMinutes).toBe(540)
    expect(emp2JobA.grossCents).toBe(11000)
    expect(emp2JobA.rateRangeCents).toEqual([1000, 1250])
    const emp2Null = employees.find((x) => x.employeeId === emp2 && x.jobId === null)!
    expect(emp2Null.entryCount).toBe(2) // e3 (odprt) + e4 (active) — nikoli v plačilni osnovi
    expect(emp2Null.approvedCount).toBe(0)
    expect(emp2Null.netMinutes).toBe(0)
    // emp3: vnos BREZ jobId → jobName pad iz PRIMARNE EmployeeJob dodelitve (jobB)
    const emp3agg = employees.find((x) => x.employeeId === emp3)!
    expect(emp3agg.jobId).toBeNull()
    expect(emp3agg.jobName).toBe(`${P}Kuhar ${RUN}`)
    expect(emp3agg.netMinutes).toBe(420)
    expect(emp3agg.grossCents).toBe(7700)
  })

  it('C3. plannedMinutes + varianceMinutes = načrtovane − potrjene minute', async () => {
    const r = await payrollDetailGET(req('GET', `/api/payroll/${p1}`, tokA), params(p1))
    expect(r.status).toBe(200)
    const j = await body(r)
    const employees = j.employees as Array<Record<string, unknown>>
    // emp3: 480 (09:00–17:00 brez odmora) + 450 (22:00–06:00 −30) = 930 načrtovanih
    const emp3agg = employees.find((x) => x.employeeId === emp3)!
    expect(emp3agg.plannedMinutes).toBe(930)
    expect(emp3agg.varianceMinutes).toBe(930 - 420) // 510 manj od načrta
    // emp4 brez izmen: načrt 0, odmik negativen (nad načrtom)
    const emp4agg = employees.find((x) => x.employeeId === emp4)!
    expect(emp4agg.plannedMinutes).toBe(0)
    expect(emp4agg.varianceMinutes).toBe(-480)
  })

  it('C4. izjeme: vseh 7 kod + employeeName + entryId + povzetek po kodi', async () => {
    const r = await payrollDetailGET(req('GET', `/api/payroll/${p1}`, tokA), params(p1))
    expect(r.status).toBe(200)
    const j = await body(r)
    const exceptions = j.exceptions as Array<Record<string, unknown>>
    expect(exceptions.length).toBe(7)
    const codes = new Set(exceptions.map((x) => String(x.code)))
    for (const code of ['OPEN_ENTRY', 'UNAPPROVED', 'RATE_ZERO', 'RATE_MISMATCH', 'OVERLAP', 'LONG_NO_BREAK', 'SHIFT_NO_ENTRY']) {
      expect(codes.has(code)).toBe(true)
    }
    const rz = exceptions.find((x) => x.code === 'RATE_ZERO')!
    expect(rz.employeeName).toBe(NAME2)
    expect(rz.entryId).toBe(e4)
    const sne = exceptions.find((x) => x.code === 'SHIFT_NO_ENTRY')!
    expect(sne.employeeName).toBe(NAME3)
    expect(sne.shiftId).toBe(`${P}sh-1-${RUN}`)
    const sum = j.exceptionsSummary as Record<string, number>
    expect(sum.OVERLAP).toBe(1)
    expect(sum.UNAPPROVED).toBe(1)
    expect(sum.RATE_MISMATCH).toBe(1)
  })

  it('C5. 404 neznano obdobje; 403 tuja lokacija; 401 brez žetona', async () => {
    const unknown = nid()
    const r404 = await payrollDetailGET(req('GET', `/api/payroll/${unknown}`, tokA), params(unknown))
    expect(r404.status).toBe(404)
    const r403 = await payrollDetailGET(req('GET', `/api/payroll/${p1}`, tokB), params(p1))
    expect(r403.status).toBe(403)
    const r401 = await payrollDetailGET(req('GET', `/api/payroll/${p1}`, ''), params(p1))
    expect(r401.status).toBe(401)
  })
})

/* ═══════════════════ D. POST /api/payroll/[id]/close ═══════════════════ */

describe('D. zaklep obdobja', () => {
  it('D1. izjeme brez ack → 409 { error, exceptions: { koda: števec } }', async () => {
    const r = await payrollClosePOST(req('POST', `/api/payroll/${p1}/close`, tokA, {}), params(p1))
    expect(r.status).toBe(409)
    const j = await body(r)
    expect(String(j.error)).toContain('nepotrjene')
    const exc = j.exceptions as Record<string, number>
    expect(exc.OPEN_ENTRY).toBe(1)
    expect(exc.UNAPPROVED).toBe(1)
    expect(exc.RATE_ZERO).toBe(1)
    expect(exc.RATE_MISMATCH).toBe(1)
    expect(exc.OVERLAP).toBe(1)
    expect(exc.LONG_NO_BREAK).toBe(1)
    expect(exc.SHIFT_NO_ENTRY).toBe(1)
    // obdobje je NEspremenjeno (409 ni zaklep)
    const row = await db.payrollPeriod.findUniqueOrThrow({ where: { id: p1 } })
    expect(row.status).toBe('draft')
    expect(row.closedAt).toBeNull()
  })

  it('D2. zaklep z acknowledgeExceptions + opombo → snapshot (samo approved) + audit', async () => {
    const r = await payrollClosePOST(
      req('POST', `/api/payroll/${p1}/close`, tokA, { note: 'Zaklep s priznanimi izjemami', acknowledgeExceptions: true }),
      params(p1),
    )
    expect(r.status).toBe(200)
    const j = await body(r)
    const per = j.period as Record<string, unknown>
    expect(per.status).toBe('closed')
    expect(per.version).toBe(1)
    expect(per.closeNote).toBe('Zaklep s priznanimi izjemami')
    expect(per.closedById).toBe(mgrA)
    // snapshot: plačilna osnova = SAMO approved (odprt vnos e3 se NE šteje)
    expect(per.entryCount).toBe(9)
    expect(per.approvedCount).toBe(7)
    expect(per.exceptionCount).toBe(7) // > 0 — izjeme so bile štete
    expect(per.netMinutesApproved).toBe(NET_DRAFT)
    expect(per.grossPayCents).toBe(GROSS_DRAFT)
    expect(per.cashTipsCents).toBe(3000)
    expect(per.cardTipsCents).toBe(2000)
    expect(per.tipsPendingCents).toBe(3000) // pending ≠ izplačano
    expect(per.tipsPaidCents).toBe(2000)
    const row = await db.payrollPeriod.findUniqueOrThrow({ where: { id: p1 } })
    expect(row.closedAt).toBeTruthy()
    // revizija: števci (brez vrstic), veriga, lokacija
    const audit = await db.auditLog.findFirst({ where: { action: 'PAYROLL_PERIOD_CLOSED', entityId: p1, details: { contains: '"version":1' } } })
    expect(audit).toBeTruthy()
    expect(audit?.userId).toBe(mgrA)
    expect(audit?.locationId).toBe(locA)
    expect(audit?.chainHash).toBeTruthy()
    expect(String(audit?.details)).toContain('"grossPayCents":41575')
    expect(String(audit?.details)).toContain('"acknowledged":true')
  })

  it('D3. dvojni zaklep → 409 (CAS — ni druge različice/audita)', async () => {
    const r = await payrollClosePOST(req('POST', `/api/payroll/${p1}/close`, tokA, { acknowledgeExceptions: true }), params(p1))
    expect(r.status).toBe(409)
    expect(String((await body(r)).error)).toContain('že zaključeno')
    const audits = await db.auditLog.count({ where: { action: 'PAYROLL_PERIOD_CLOSED', entityId: p1, details: { contains: '"version":1' } } })
    expect(audits).toBe(1) // točno EN zaklep v1
  })

  it('D4. čisto obdobje (brez vnosov) se zaklene BREZ ack → 200, prazni števci', async () => {
    const r = await payrollClosePOST(req('POST', `/api/payroll/${p2}/close`, tokA, { note: 'Prazen mesec' }), params(p2))
    expect(r.status).toBe(200)
    const j = await body(r)
    const per = j.period as Record<string, unknown>
    expect(per.status).toBe('closed')
    expect(per.version).toBe(1)
    expect(per.entryCount).toBe(0)
    expect(per.approvedCount).toBe(0)
    expect(per.exceptionCount).toBe(0)
    expect(per.grossPayCents).toBe(0)
    expect(per.netMinutesApproved).toBe(0)
  })
})

/* ═══════════════════ E. reopen + čuvaj timeclock ═══════════════════ */

describe('E. ponovno odprtje + zaklep timeclock', () => {
  it('E1. PATCH vnosa v ZAKLJUČENEM obdobju → 409 z EXAKTNIM sporočilom', async () => {
    const r = await timeclockPATCH(req('PATCH', `/api/timeclock/${e4}`, tokA, { status: 'approved' }), params(e4))
    expect(r.status).toBe(409)
    const j = await body(r)
    expect(String(j.error)).toBe('Vnos pripada zaključenemu obračunskemu obdobju — najprej ga ponovno odprite (Obračun).')
    // vnos je NEspremenjen
    const row = await db.timeEntry.findUniqueOrThrow({ where: { id: e4 } })
    expect(row.status).toBe('active')
  })

  it('E2. reopen DRAFT → 409; razlog < 3 znaki → 400', async () => {
    const rDraft = await payrollReopenPOST(req('POST', `/api/payroll/${p3}/reopen`, tokA, { reason: 'Razlog zaključenega' }), params(p3))
    expect(rDraft.status).toBe(409)
    expect(String((await body(rDraft)).error)).toContain('ni zaključeno')
    const rShort = await payrollReopenPOST(req('POST', `/api/payroll/${p1}/reopen`, tokA, { reason: 'xx' }), params(p1))
    expect(rShort.status).toBe(400)
    expect(String((await body(rShort)).error)).toContain('Razlog')
    const row = await db.payrollPeriod.findUniqueOrThrow({ where: { id: p1 } })
    expect(row.status).toBe('closed') // nič se ni zgodilo
  })

  it('E3. reopen veljaven → draft, reopenCount 1, snapshot OSTANE (zgodovina zaklepa)', async () => {
    const r = await payrollReopenPOST(req('POST', `/api/payroll/${p1}/reopen`, tokA, { reason: 'Popravek vnosa e4 pred ponovnim zaklepom' }), params(p1))
    expect(r.status).toBe(200)
    const j = await body(r)
    const per = j.period as Record<string, unknown>
    expect(per.status).toBe('draft')
    expect(per.reopenCount).toBe(1)
    expect(per.version).toBe(1) // nova različica šele ob ponovnem zaključku
    expect(per.grossPayCents).toBe(GROSS_DRAFT) // snapshot se NE resetira
    expect(per.netMinutesApproved).toBe(NET_DRAFT)
    expect(String(j.message)).toContain('ponovno odprto')
  })

  it('E4. PATCH istega vnosa po reopen → 200 (sprememba dovoljena)', async () => {
    const r = await timeclockPATCH(req('PATCH', `/api/timeclock/${e4}`, tokA, { status: 'approved' }), params(e4))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect((j.entry as Record<string, unknown>).status).toBe('approved')
    const row = await db.timeEntry.findUniqueOrThrow({ where: { id: e4 } })
    expect(row.status).toBe('approved')
  })

  it('E5. ponovni zaklep → version 2 (1 + reopenCount) z novim snapshotom', async () => {
    const r = await payrollClosePOST(
      req('POST', `/api/payroll/${p1}/close`, tokA, { note: 'Drugi zaklep po popravku', acknowledgeExceptions: true }),
      params(p1),
    )
    expect(r.status).toBe(200)
    const per = (await body(r)).period as Record<string, unknown>
    expect(per.status).toBe('closed')
    expect(per.version).toBe(2)
    expect(per.reopenCount).toBe(1)
    expect(per.approvedCount).toBe(8) // e4 je zdaj potrjen
    expect(per.netMinutesApproved).toBe(NET_DRAFT + 120) // e4: 120 min, 0 €
    expect(per.grossPayCents).toBe(GROSS_DRAFT) // e4 ima postavko 0
    expect(per.exceptionCount).toBe(6) // UNAPPROVED(e4) je odpovedal
  })

  it('E6. audit PAYROLL_PERIOD_REOPENED z razlogom obstaja', async () => {
    const audit = await db.auditLog.findFirst({
      where: { action: 'PAYROLL_PERIOD_REOPENED', entityId: p1, details: { contains: 'Popravek vnosa e4' } },
    })
    expect(audit).toBeTruthy()
    expect(audit?.userId).toBe(mgrA)
    expect(String(audit?.details)).toContain('"reopenCount":1')
    expect(String(audit?.details)).toContain('"previousVersion":1')
  })
})

/* ═══════════════════ F. GET /api/payroll/[id]/export ═══════════════════ */

describe('F. izvoz obračuna (CSV/JSON + digesti + PII)', () => {
  it('F1. izvoz DRAFT obdobja → 409', async () => {
    const r = await payrollExportGET(req('GET', `/api/payroll/${p3}/export?format=csv`, tokA), params(p3))
    expect(r.status).toBe(409)
    expect(String((await body(r)).error)).toContain('zaključenega')
  })

  it('F2. CSV: 200, text/csv, attachment, BOM, CRLF, stabilni ID-ji, quoted ime, EUR vejica, SKUPAJ', async () => {
    const r = await payrollExportGET(req('GET', `/api/payroll/${p1}/export?format=csv`, tokA), params(p1))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="obracun-.*-v2-i1\.csv"/)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const csv = await r.text()
    csv1 = csv
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.includes('\r\n')).toBe(true)
    expect(csv.includes('ZaposleniID;Zaposleni;DeloID;Delo;Datum;Prihod;Odhod;OdmorMin;NetoMin;PostavkaEUR;BrutoEUR;Tip;Status;VnosID')).toBe(true)
    expect(csv.includes(e1)).toBe(true) // stabilen entryId (isti kot v DB)
    expect(csv.includes(`${P}te-`)).toBe(true)
    // ime z vejico + šumniki gre skozi NENAREKOVANO (ločilo je ';' — vejica ni
    // separator, csvField navaja samo ; " \n \r) v vsaki vrstici, ki ga nosi
    const nameLines = csv.split('\r\n').filter((l) => l.includes('Natakar Žiga'))
    expect(nameLines.length).toBeGreaterThanOrEqual(3) // vnos + povzetek + napitnina
    for (const line of nameLines) expect(line.includes(`;${NAME1};`)).toBe(true)
    // EUR z decimalno vejico + vsota (po E4: 8 potrjenih, 2520 min, enak bruto)
    expect(csv.includes('63,75')).toBe(true)
    expect(csv.includes('SKUPAJ;Vnosi;9;Potrjeni;8;NetoMin;2520;BrutoEUR;415,75')).toBe(true)
    expect(csv.includes('Shema;payroll-export/2')).toBe(true)
    expect(csv.includes('Napitnine pending se ne stejejo kot izplacane.')).toBe(true)
    expect(csv.includes('RestaurantOS ne izracunava odstotkov doplacil')).toBe(true)
  })

  it('F3. CSV napitnine: pending izvožena s statusom, NE v plačani vsoti; paid štet', async () => {
    // distribucija d1 (emp1, 30,00) pending — vidna, a se NE sešteje v PlacanoEUR
    expect(csv1.includes(`;30,00;pending`)).toBe(true)
    expect(csv1.includes(`;20,00;paid`)).toBe(true)
    expect(csv1.includes('SKUPAJ;Napitnine;PendingEUR;30,00;PlacanoEUR;20,00;GotovinaEUR;30,00;KarticaEUR;20,00')).toBe(true)
    // bazen v oknu z gotovino/kartico; pool3 (izven okna) NI v izvozu
    expect(csv1.includes(`;2026-09-09;30,00;20,00`)).toBe(true)
    expect(csv1).not.toContain(`${P}pool3`)
  })

  it('F4. JSON: schemaVersion payroll-export/2, rows s statusom, export.seq 2', async () => {
    const r = await payrollExportGET(req('GET', `/api/payroll/${p1}/export?format=json`, tokA), params(p1))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.schemaVersion).toBe('payroll-export/2')
    const rows = j.rows as Array<Record<string, unknown>>
    expect(rows.length).toBe(9)
    expect(rows.every((x) => typeof x.status === 'string')).toBe(true)
    const e1row = rows.find((x) => x.entryId === e1)!
    expect(e1row.netMinutes).toBe(450)
    expect(e1row.grossCents).toBe(6375)
    const totals = j.totals as Record<string, unknown>
    expect(totals.grossPayCents).toBe(GROSS_DRAFT)
    expect(totals.tipsPendingCents).toBe(3000)
    const exp = j.export as Record<string, unknown>
    expect(exp.seq).toBe(2) // drugi izvoz tega obdobja
    expect(exp.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect((j.employees as unknown[]).length).toBeGreaterThan(0)
  })

  it('F5. ponovni izvoz identične vsebine → identicalToPrevious true, changedEntries 0, seq 3', async () => {
    const r = await payrollExportGET(req('GET', `/api/payroll/${p1}/export?format=csv`, tokA), params(p1))
    expect(r.status).toBe(200)
    const csv = await r.text()
    expect(csv.includes('SpremenjeneVrstice;0')).toBe(true)
    expect(csv.includes('EnakoKotPrej;DA')).toBe(true)
    const exports = await db.payrollExport.findMany({ where: { periodId: p1 }, orderBy: { seq: 'asc' } })
    expect(exports.length).toBe(3)
    expect(exports[2].seq).toBe(3) // NOVA vrstica zapisa izvoza (ni ponavljanja)
    expect(exports[2].identicalToPrevious).toBe(true)
    expect(exports[2].changedEntries).toBe(0)
    expect(exports[2].contentHash).toBe(exports[1].contentHash) // CSV in JSON delita payload hash
  })

  it('F6. po reopen + spremembi vnosa + ponovnem zaključku → changedEntries > 0', async () => {
    const rr = await payrollReopenPOST(req('POST', `/api/payroll/${p1}/reopen`, tokA, { reason: 'Sprememba statusa e8 po izvozu' }), params(p1))
    expect(rr.status).toBe(200)
    const rp = await timeclockPATCH(req('PATCH', `/api/timeclock/${e8}`, tokA, { status: 'disputed' }), params(e8))
    expect(rp.status).toBe(200)
    const rc = await payrollClosePOST(
      req('POST', `/api/payroll/${p1}/close`, tokA, { note: 'Tretji zaklep', acknowledgeExceptions: true }),
      params(p1),
    )
    expect(rc.status).toBe(200)
    expect(((await body(rc)).period as Record<string, unknown>).version).toBe(3)
    const r = await payrollExportGET(req('GET', `/api/payroll/${p1}/export?format=json`, tokA), params(p1))
    expect(r.status).toBe(200)
    const j = await body(r)
    const exp = j.export as Record<string, unknown>
    expect(Number(exp.changedEntries)).toBeGreaterThan(0) // e8: approved → disputed
    expect(exp.seq).toBe(4)
    expect(exp.identicalToPrevious).toBe(false)
  })

  it('F7. PayrollExport vrstice z rowDigest (BREZ imen) + stabilna oblika digesta', async () => {
    const exports = await db.payrollExport.findMany({ where: { periodId: p1 }, orderBy: { seq: 'asc' } })
    expect(exports.length).toBe(4)
    for (const x of exports) {
      expect(x.rowDigest.length).toBeGreaterThan(0)
      // digest = entryId:neto:centi:status — PII (imena) ostajajo IZVEN
      expect(x.rowDigest).not.toContain('Natakar')
      expect(x.rowDigest).not.toContain('Kuhar')
      expect(x.rowDigest).not.toContain('Mojca')
      expect(x.rowDigest).not.toContain('Anže')
    }
    // struktura digesta: entryId:netMinutes:grossCents:status + distribucija
    expect(exports[0].rowDigest).toContain(`${e1}:450:6375:approved`)
    expect(exports[0].rowDigest).toContain(`${P}dist1-${RUN}:3000:pending`)
    expect(exports[0].grossPayCents).toBe(GROSS_DRAFT)
    expect(exports[0].entryCount).toBe(9)
  })

  it('F8. audit PAYROLL_EXPORTED obstaja; details BREZ imen zaposlenih (PII varovalka)', async () => {
    const audits = await db.auditLog.findMany({ where: { action: 'PAYROLL_EXPORTED', details: { contains: `"periodId":"${p1}"` } } })
    expect(audits.length).toBe(4)
    for (const a of audits) {
      const s = String(a.details)
      expect(s).not.toContain('Natakar')
      expect(s).not.toContain('Kuhar')
      expect(s).not.toContain('Mojca')
      expect(s).not.toContain('Anže')
      expect(s).not.toContain('Pinči')
      const d = JSON.parse(s) as Record<string, unknown>
      expect(Object.keys(d).sort()).toEqual(['changedEntries', 'format', 'grossPayCents', 'identical', 'periodId', 'seq'])
    }
  })

  it('F9. 401 brez žetona; 403 tuja lokacija; 403 waiter', async () => {
    const r401 = await payrollExportGET(req('GET', `/api/payroll/${p1}/export`, ''), params(p1))
    expect(r401.status).toBe(401)
    const r403b = await payrollExportGET(req('GET', `/api/payroll/${p1}/export`, tokB), params(p1))
    expect(r403b.status).toBe(403)
    const r403w = await payrollExportGET(req('GET', `/api/payroll/${p1}/export`, tokWaiter), params(p1))
    expect(r403w.status).toBe(403)
    // zavrnjeni klici NE ustvarijo izvoza
    expect(await db.payrollExport.count({ where: { periodId: p1 } })).toBe(4)
  })

  it('F10. velike ure: 10000 min × 10 €/h → 166667 centov v CSV in JSON', async () => {
    const pBig = await mkPeriod(tokA, '2026-08-10', '2026-08-16')
    await mkEntry({
      employeeId: emp4,
      jobId: jobA,
      clockIn: D('2026-08-11T06:00:00Z'),
      clockOut: D('2026-08-18T04:40:00Z'),
      breakMinutes: 0,
      totalMinutes: 10000,
      payRate: 10,
      totalPay: 1666.67,
    })
    const rc = await payrollClosePOST(
      req('POST', `/api/payroll/${pBig}/close`, tokA, { acknowledgeExceptions: true }), // LONG_NO_BREAK
      params(pBig),
    )
    expect(rc.status).toBe(200)
    expect(((await body(rc)).period as Record<string, unknown>).grossPayCents).toBe(166667)
    const rCsv = await payrollExportGET(req('GET', `/api/payroll/${pBig}/export?format=csv`, tokA), params(pBig))
    expect(rCsv.status).toBe(200)
    expect((await rCsv.text()).includes('1666,67')).toBe(true)
    const rJson = await payrollExportGET(req('GET', `/api/payroll/${pBig}/export?format=json`, tokA), params(pBig))
    expect(rJson.status).toBe(200)
    const j = await body(rJson)
    expect((j.totals as Record<string, unknown>).grossPayCents).toBe(166667)
    const row = (j.rows as Array<Record<string, unknown>>)[0]!
    expect(row.netMinutes).toBe(10000)
    expect(row.grossCents).toBe(166667) // round(10000 × 1000 / 60)
  })
})

/* ═══════════════════ G. EmployeeJob CRUD ═══════════════════ */

describe('G. GET/PUT /api/employees/[id]/jobs (plačne postavke)', () => {
  it('G1. PUT replace-set z izrecno primarno + GET pokaže obe dodelitvi (payRateCents)', async () => {
    const r = await employeeJobsPUT(
      req('PUT', `/api/employees/${emp5}/jobs`, tokA, { jobs: [{ jobId: jobA, payRate: 10, isPrimary: true }, { jobId: jobB, payRate: 12.5 }] }),
      params(emp5),
    )
    expect(r.status).toBe(200)
    const j = await body(r)
    const jobs = j.jobs as Array<Record<string, unknown>>
    expect(jobs.length).toBe(2)
    const ja = jobs.find((x) => x.jobId === jobA)!
    expect(num(ja.payRate)).toBe(10)
    expect(ja.payRateCents).toBe(1000)
    expect(ja.isPrimary).toBe(true)
    expect(ja.isActive).toBe(true)
    const jb = jobs.find((x) => x.jobId === jobB)!
    expect(num(jb.payRate)).toBe(12.5)
    expect(jb.payRateCents).toBe(1250)
    expect(jb.isPrimary).toBe(false)
    const rg = await employeeJobsGET(req('GET', `/api/employees/${emp5}/jobs`, tokA), params(emp5))
    expect(rg.status).toBe(200)
    const jg = await body(rg)
    expect((jg.jobs as unknown[]).length).toBe(2)
    expect(await db.employeeJob.count({ where: { employeeId: emp5 } })).toBe(2)
  })

  it('G2. PUT brez isPrimary → PRVA vrstica postane primarna (clock-in snapshot)', async () => {
    const r = await employeeJobsPUT(
      req('PUT', `/api/employees/${emp5}/jobs`, tokA, { jobs: [{ jobId: jobB, payRate: 9.5 }, { jobId: jobA, payRate: 11 }] }),
      params(emp5),
    )
    expect(r.status).toBe(200)
    const jobs = (await body(r)).jobs as Array<Record<string, unknown>>
    const jb = jobs.find((x) => x.jobId === jobB)!
    expect(jb.isPrimary).toBe(true) // prva samodejno primarna
    expect(jobs.find((x) => x.jobId === jobA)!.isPrimary).toBe(false)
  })

  it('G3. neveljavna postavka: −1 / 10001 / 3 decimalke → 400', async () => {
    for (const bad of [-1, 10001, 12.345]) {
      const r = await employeeJobsPUT(
        req('PUT', `/api/employees/${emp5}/jobs`, tokA, { jobs: [{ jobId: jobA, payRate: bad }] }),
        params(emp5),
      )
      expect(r.status).toBe(400)
      expect(String((await body(r)).error)).toContain('postavka')
    }
  })

  it('G4. neznano delovno mesto → 404; NEAKTIVNO delovno mesto → 404', async () => {
    const rUn = await employeeJobsPUT(
      req('PUT', `/api/employees/${emp5}/jobs`, tokA, { jobs: [{ jobId: `${P}neobstaja-${RUN}`, payRate: 10 }] }),
      params(emp5),
    )
    expect(rUn.status).toBe(404)
    const rInact = await employeeJobsPUT(
      req('PUT', `/api/employees/${emp5}/jobs`, tokA, { jobs: [{ jobId: jobC, payRate: 10 }] }),
      params(emp5),
    )
    expect(rInact.status).toBe(404)
  })

  it('G5. podvojen jobId v seznamu → 400; več kot 8 delovnih mest → 400', async () => {
    const rDup = await employeeJobsPUT(
      req('PUT', `/api/employees/${emp5}/jobs`, tokA, { jobs: [{ jobId: jobA, payRate: 10 }, { jobId: jobA, payRate: 12 }] }),
      params(emp5),
    )
    expect(rDup.status).toBe(400)
    expect(String((await body(rDup)).error)).toContain('Podvojen')
    const nine = Array.from({ length: 9 }, (_, i) => ({ jobId: `${P}fakejob${i}-${RUN}`, payRate: 10 }))
    const r9 = await employeeJobsPUT(req('PUT', `/api/employees/${emp5}/jobs`, tokA, { jobs: nine }), params(emp5))
    expect(r9.status).toBe(400) // omejitev dolžine zavrne PRED obstojem job-ov
  })

  it('G6. audit EMPLOYEE_JOBS_UPDATED brez postavk (zneski NE gredo v revizijo)', async () => {
    const audits = await db.auditLog.findMany({ where: { action: 'EMPLOYEE_JOBS_UPDATED', entityId: emp5 } })
    expect(audits.length).toBeGreaterThanOrEqual(2) // G1 + G2
    for (const a of audits) {
      const d = JSON.parse(String(a.details)) as Record<string, unknown>
      expect(Object.keys(d).sort()).toEqual(['count', 'employeeId', 'primaryJobId'])
      expect(d.employeeId).toBe(emp5)
      expect(String(a.details)).not.toContain('payRate')
      expect(String(a.details)).not.toContain('9.5')
    }
    // primarno mesto se sledi (G2 je zamenjal primarno na jobB)
    expect(audits.some((a) => String(a.details).includes(`"primaryJobId":"${jobB}"`))).toBe(true)
  })

  it('G7. tuja lokacija (manager B na zaposlenega A) → 403; brez žetona → 401', async () => {
    const r403 = await employeeJobsPUT(
      req('PUT', `/api/employees/${emp5}/jobs`, tokB, { jobs: [{ jobId: jobA, payRate: 10 }] }),
      params(emp5),
    )
    expect(r403.status).toBe(403)
    const r403g = await employeeJobsGET(req('GET', `/api/employees/${emp5}/jobs`, tokB), params(emp5))
    expect(r403g.status).toBe(403)
    const r401 = await employeeJobsPUT(req('PUT', `/api/employees/${emp5}/jobs`, '', { jobs: [] }), params(emp5))
    expect(r401.status).toBe(401)
  })
})

/* ═══════════════════ H. register / drift / i18n ═══════════════════ */

describe('H. register + drift + i18n', () => {
  it('H1. SCHEMA_MIGRATIONS vsebuje payroll-periods (#27) + endpoint + descKey', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'payroll-periods')
    expect(m).toBeTruthy()
    expect(m!.endpoint).toBe('/api/admin/migrate-payroll-periods')
    expect(m!.descKey).toBe('mig.payrollPeriods.desc')
    expect(typeof m!.probe).toBe('function')
  })

  it('H2. mig.payrollPeriods.desc obstaja v SL + HR slovarjih', () => {
    expect(slDict['mig.payrollPeriods.desc']).toBeTruthy()
    expect(hrDict['mig.payrollPeriods.desc']).toBeTruthy()
    expect(String(slDict['mig.payrollPeriods.desc'])).toContain('Obračun')
    expect(String(hrDict['mig.payrollPeriods.desc'])).toContain('Obračun')
  })

  it('H3. drift matcher: PayrollPeriod/PayrollExport CREATE/INDEX/ALTER znani; DROP/DELETE ne', async () => {
    const { isPayrollPeriodsStatement } = await import('../scripts/drift-check')
    expect(isPayrollPeriodsStatement('CREATE TABLE IF NOT EXISTS "PayrollPeriod" ("id" TEXT NOT NULL)')).toBe(true)
    expect(isPayrollPeriodsStatement('CREATE TABLE IF NOT EXISTS "PayrollExport" ("id" TEXT NOT NULL)')).toBe(true)
    expect(isPayrollPeriodsStatement('CREATE UNIQUE INDEX IF NOT EXISTS "PayrollExport_periodId_seq_key" ON "PayrollExport"("periodId","seq")')).toBe(true)
    expect(isPayrollPeriodsStatement('CREATE INDEX IF NOT EXISTS "PayrollPeriod_locationId_idx" ON "PayrollPeriod"("locationId")')).toBe(true)
    expect(isPayrollPeriodsStatement('ALTER TABLE "PayrollPeriod" ADD COLUMN "x" TEXT')).toBe(true)
    expect(isPayrollPeriodsStatement('DROP TABLE "PayrollPeriod"')).toBe(false)
    expect(isPayrollPeriodsStatement('CREATE TABLE "X" ("id" TEXT)')).toBe(false)
    expect(isPayrollPeriodsStatement('DELETE FROM "PayrollExport"')).toBe(false)
  })

  it('H4. tabs.obracun registriran v TAB_PERM z employees.manage', () => {
    expect(TAB_PERM['obracun']).toBe('employees.manage')
    expect(slDict['tabs.obracun']).toBeTruthy()
    expect(hrDict['tabs.obracun']).toBeTruthy()
  })

  it('H5. payr.* pariteta SL/HR (spot-check + enaka množica ključev)', () => {
    // 3-c je predpono izbral payr.* ('pay.' je gostovska plačilna stran)
    expect(slDict['payr.listTitle']).toBeTruthy()
    expect(hrDict['payr.listTitle']).toBeTruthy()
    expect(slDict['payr.ex.OPEN_ENTRY']).toBeTruthy()
    expect(hrDict['payr.ex.OPEN_ENTRY']).toBeTruthy()
    const payrSl = Object.keys(slDict).filter((k) => k.startsWith('payr.'))
    const payrHr = Object.keys(hrDict).filter((k) => k.startsWith('payr.'))
    expect(payrSl.length).toBeGreaterThanOrEqual(100)
    expect(payrHr.sort()).toEqual([...payrSl].sort())
  })
})
