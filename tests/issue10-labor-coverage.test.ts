/**
 * Issue #10 (P2, v1.117.0) — strošek dela in napoved pokritosti izmen glede na
 * prodajo (brez AI, 0 novih tabel — čisti izračuni nad Order/TimeEntry/
 * StaffShift/EmployeeJob/Job/Location).
 *
 * Pokrito:
 *  A. ČISTI MOTOR (src/lib/labor-coverage.ts, 0 DB uvozov):
 *   1. konstante (LCOV_TARGET/WARN/LOW_PCT=32/38/20, MAX_DAYS 90, FORECAST 7)
 *      + nabora statusov zgodovine/napovede izmen;
 *   2. resolveShiftRateCents veriga: EmployeeJob (employeeId+jobId) → primarna
 *      dodelitev → Job.basePayRate → BREZ ('none' = 0 centov IZRECNO — minute
 *      štejejo, strošek se zastavi; postavka 0 na členu = MANJKA → veriga
 *      nadaljuje);
 *   3. shiftDurationMinutes: 09–17 −30 → 450; 22–06 čez polnoč → 480 (−30 →
 *      450); start=end → 1440; odmor ≥ trajanje → 0; slab HH:MM/datum → null;
 *   4. coverageFlag pasovi: <20 low, 20–32 ok, >32–38 warn, >38 alarm, null
 *      (ni ocene) → null — meje niso vključene v višji pas;
 *   5. laborPct: null kadar netSales ≤ 0 (nikoli ∞/0/negativno — neto se
 *      clamp-a na 0); s prodajo → r2(cena/neto×100);
 *   6. dataQualityOf števci (odprt/zaprt-stopnja-0/nepotrjen/prekrivanje/
 *      izmena-brez-postavke/mešane valute) + reasons = STABILEN nabor kod;
 *   7. forecastSales determinizem: isti vhod → BYTE-identičen izhod (tudi
 *      vrstni red vhoda ne šteje — sortiranje po datumu), prazna zgodovina →
 *      [], horizon 0/100 → clamp, confidence low <3 / ok ≥3 vzorcev;
 *  B. RUTA GET /api/reports/labor-coverage: 200 happy (dni = število dni okna,
 *      ure 7×24, vloge, skupaj, napoved, pokritost — IZRAČUNANI števili);
 *      privzeto okno 28 dni; 400 slab format/from > to; to > danes → clamp;
 *      okno > 90 dni → odrezano na 90; jobId filter SAMO na labor strani
 *      (prodaja ostaja); locationId 404/403 (staff tuja lokacija — guardResource
 *      lokacijski sloj; centralna čez-org meja); staff scope fail-closed (samo
 *      svoja lokacija); cross-org nevidno; 401 brez žetona; 403 waiter (brez
 *      reports.view); PII: izhod VSEBUJE SAMO agregate — BREZ employeeId/imen
 *      (top-level ključi so natanko parameters/days/hours/roles/totals/
 *      dataQuality/forecast/generatedAt);
 *  C. PODATKOVNA KAKOVOST: odprt vnos = živi delež do `now` (labor-cost
 *      precedens; brez `now` → 0 minut a ŠTEVEC živi — nikoli tiho) + brez
 *      PII; zaprt vnos s postavko 0 → strošek 0 + števec (nikoli tiho 0 €);
 *      prekrivajoča se okna ISTEGA zaposlenega → par štet, vnosi NE izločeni;
 *      nepotrjen zaprt vnos → štet + prispeva; izmena brez postavke → minute
 *      štejejo, strošek 0 + plannedIncomplete/missingRateShifts; ruta: vsi
 *      števci na živih (umazanih) fiksturah;
 *  D. NAČRTOVANO VS DEJANSKO: overnight vnos (22:00–06:00 Europe/Ljubljana) se
 *      proporcionalno razcepi na OBA lokalna dneva + Σ minut ≡ totalMinutes in
 *      Σ centov ≡ plačilo vnosa (ledger-ekvivalentnost, floor+ostanek); izmena
 *      se pripiše dnevu ZAČETKA; varianceMinutes per dan (načrtovano−dejansko);
 *      per-dan laborPct + pasovi (badge); PER-LOKACIJSKA cona: isti instant
 *      23:30Z → 06-03 v Ljubljani, 06-02 v UTC (vsaka lokacija svoja cona) +
 *      mešane valute → zastavica; urna matrika 168 celic + staffOn povprečje;
 *  E. NAPOVED + POKRITOST: povprečje ISTEGA dneva tedna (točna matematika:
 *      min/max/sampleCount), dnevi z 0 naročili = closedDays ločeno (NE v
 *      povprečju — ne zavajajo ocene); pokritost SAMO prihodnje dneve z izmenami
 *      v scheduled/confirmed/in_progress (cancelled/completed IZVEN); expectedPct
 *      null brez ocene prodaje; flag barve (low/ok/warn/alarm meje); overlaps
 *      (pari prekrivajočih se BODOČIH izmen istega zaposlenega; dotikajoča se
 *      okna NISO prekrivanje; različna zaposlena niso); longNoBreak (> 8 h brez
 *      odmora); overtimeMinutes v napovedi vedno 0;
 *  F. EXPORT /api/reports/export?section=labor-coverage: CSV (BOM, ';', CRLF,
 *      SL glave, 2 decimalki, datoteka labor-pokritost_{from}_{to}.csv, dnevi +
 *      168 urnih vrstic + napoved + pokritost + vloge + izjeme) in JSON (ISTA
 *      pogodba kot UI ruta — isti motor/loader → GLOBA identična poročila,
 *      razlikujeta se samo generatedAt/exportMeta — "isti obračun kot UI");
 *      dovoljenja: 401, waiter 403, staff lasten obseg 200, tuja lokacija 403;
 *  G. REGISTRI: 'i10-' v TEST_PREFIXES; APP_VERSION 1.134.0; reasons = enum
 *      kod; 0 DDL — schema.sqlite.prisma/SCHEMA_MIGRATIONS/konzola HANDLERS/
 *      drift-check BREZ 'labor-coverage' (izraz read-only izračun, 0 tabel).
 *
 * Fiksture s predpono i10- (TEST_PREFIXES vrstica že v fixture-sweep; ID_SWEEP
 * pokriva timeEntry/staffShift/employeeJob/job/order/employee/location, org
 * drevo poimeno-prefiksirano + ročno). Org drevo ×2 (issue5/issue8 vzorec):
 * orgA → locA1 (Europe/Ljubljana, EUR) + locA2 (UTC, USD — dokaz per-cona),
 * orgB → locB za cross-tenant. Glavno okno 2026-06-01..07 (v preteklosti);
 * umazane fiksture na [danes−4, danes] za C-sklop (odprt vnos tik pred zdaj —
 * živa proracija). dev.db ima realne ostanke → EKSPRESNI števli vedno prek
 * locationId=locA1 ali staff obsega (samo locA1), strukturne pa za centralni
 * multi-lokacijski obseg.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import {
  laborCoverageReport,
  forecastSales,
  coverageOf,
  coverageFlag,
  dataQualityOf,
  resolveShiftRateCents,
  shiftDurationMinutes,
  LCOV_TARGET_PCT,
  LCOV_WARN_PCT,
  LCOV_LOW_PCT,
  LCOV_MAX_DAYS,
  LCOV_FORECAST_DAYS,
  SHIFT_HISTORY_STATUSES,
  SHIFT_FORECAST_STATUSES,
  type LaborCoverageDay,
  type LaborCoverageForecastDay,
  type ShiftInput,
  type JobRate,
  type JobBase,
  type LocationTz,
} from '../src/lib/labor-coverage'
import { GET as laborCoverageGET } from '../src/app/api/reports/labor-coverage/route'
import { GET as exportGET } from '../src/app/api/reports/export/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'

const P = 'i10-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TZ = 'Europe/Ljubljana'
const D = (iso: string) => new Date(iso)

// glavno okno analize (ponedeljek 2026-06-01 .. nedelja 2026-06-07 — v preteklosti)
const W_FROM = '2026-06-01'
const W_TO = '2026-06-07'
const todayISO = () => new Date().toISOString().slice(0, 10)
const addDaysISO = (iso: string, n: number) =>
  new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10)

// ── org drevo ×2 (issue5/issue8 vzorec; imena/slug PREFIKSIRANA → FIELD_SWEEP + ročno) ──
let orgA = '', brandA = '', propA = ''
let orgB = '', brandB = '', propB = ''
let locA1 = '' // Europe/Ljubljana, EUR — glavne fiksture
let locA2 = '' // UTC, USD — dokaz per-lokacijske cone + mešane valute
let locB = '' // orgB — cross-tenant
let mgrA1 = '' // MANAGER locA1 (staff obseg — fail-closed)
let mgrB = '' // MANAGER locB (cross-org)
let waiterA = '' // WAITER locA1 (brez reports.view)
let adminA = '' // ADMIN locA1 (centralna orgA vloga)
let emp1 = '', emp2 = '', emp3 = '', emp4 = '', emp5 = ''
let tokA1 = '', tokB = '', tokWaiter = '', tokAdmin = ''
let jW = '', jK = ''

function req(url: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
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

let orderSeq = 950_000

/** Plačano naročilo DIREKTNO v DB (neto = subtotal − discount po pogodbi). */
async function mkOrder(id: string, loc: string, paidAt: Date, subtotal: number, discount = 0): Promise<string> {
  await db.order.create({
    data: {
      id, orderNumber: ++orderSeq, locationId: loc,
      paymentStatus: 'paid', paidAt, subtotal, discount, status: 'paid',
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
  /** undefined = privzeta lokacija; null = NAMERNO brez lokacije (loader izpusti) */
  loc?: string | null
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
      locationId: o.loc === undefined ? locA1 : o.loc, // null ostane null (?? bi ga tiho zamenjal)
    },
  })
  return id
}

let shiftSeq = 0

/** Načrtovana izmena DIREKTNO v DB (startTime/endTime 'HH:MM' lokalno; loc null = brez lokacije). */
async function mkShift(employeeId: string, shiftDate: string, startTime: string, endTime: string, breakMinutes: number, status: string, jobId: string | null, loc?: string | null): Promise<string> {
  const id = `${P}sh-${++shiftSeq}-${RUN}`
  await db.staffShift.create({
    data: {
      id, employeeId, shiftDate: D(`${shiftDate}T00:00:00Z`), startTime, endTime, breakMinutes, status, jobId,
      locationId: loc === undefined ? locA1 : loc, // null ostane null
    },
  })
  return id
}

/**
 * Ročno čiščenje: vsi moji modeli so id/employeeId/locationId-prefiksirani
 * (ID_SWEEP jih pobriše), org drevo pobrišemo eksplicitno (issue8 vzorec),
 * nato sweepTestFixtures kot varovalka za vse ostalo.
 */
async function cleanup() {
  await db.order.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.timeEntry.deleteMany({ where: { employeeId: { startsWith: P } } }).catch(() => null)
  await db.employeeJob.deleteMany({ where: { employeeId: { startsWith: P } } }).catch(() => null)
  await db.staffShift.deleteMany({ where: { employeeId: { startsWith: P } } }).catch(() => null)
  await db.job.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.property.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.brand.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.organization.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()

  // org drevo ×2: orgA z locA1 (LJU/EUR) + locA2 (UTC/USD), orgB z locB
  orgA = `${P}orgA-${RUN}`; brandA = `${P}brandA-${RUN}`; propA = `${P}propA-${RUN}`
  orgB = `${P}orgB-${RUN}`; brandB = `${P}brandB-${RUN}`; propB = `${P}propB-${RUN}`
  locA1 = `${P}locA1-${RUN}`; locA2 = `${P}locA2-${RUN}`; locB = `${P}locB-${RUN}`
  await db.organization.create({ data: { id: orgA, name: `${P}Org A`, slug: `${P}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: `${P}Org B`, slug: `${P}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: `${P}Brand A` } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: `${P}Brand B` } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: `${P}Prop A` } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: `${P}Prop B` } })
  await db.location.create({ data: { id: locA1, name: `${P}Ljubljana`, code: `I10A1-${RUN.toUpperCase()}`, propertyId: propA, timezone: 'Europe/Ljubljana', currency: 'EUR' } })
  await db.location.create({ data: { id: locA2, name: `${P}UTC Labs`, code: `I10A2-${RUN.toUpperCase()}`, propertyId: propA, timezone: 'UTC', currency: 'USD' } })
  await db.location.create({ data: { id: locB, name: `${P}Zagreb`, code: `I10B-${RUN.toUpperCase()}`, propertyId: propB, timezone: 'Europe/Ljubljana', currency: 'EUR' } })

  mgrA1 = await seedEmployee('mgrA1', `${P}Zaposleni Vodja`, 'manager', locA1, 1)
  mgrB = await seedEmployee('mgrB', `${P}Zaposleni Bori`, 'manager', locB, 2)
  waiterA = await seedEmployee('waiterA', `${P}Zaposleni Timi`, 'waiter', locA1, 3)
  adminA = await seedEmployee('adminA', `${P}Zaposleni Central`, 'admin', locA1, 4)
  emp1 = await seedEmployee('emp1', `${P}Zaposleni Ena`, 'waiter', locA1, 5)
  emp2 = await seedEmployee('emp2', `${P}Zaposleni Dva`, 'chef', locA1, 6)
  emp3 = await seedEmployee('emp3', `${P}Zaposleni Tri`, 'waiter', locA1, 7)
  emp4 = await seedEmployee('emp4', `${P}Zaposleni Stirje`, 'waiter', locA1, 8)
  emp5 = await seedEmployee('emp5', `${P}Zaposleni Pet`, 'waiter', locA2, 9)
  tokA1 = createToken({ sub: mgrA1, name: `${P}Zaposleni Vodja`, role: 'MANAGER', loc: locA1, sv: 0 })
  tokB = createToken({ sub: mgrB, name: `${P}Zaposleni Bori`, role: 'MANAGER', loc: locB, sv: 0 })
  tokWaiter = createToken({ sub: waiterA, name: `${P}Zaposleni Timi`, role: 'WAITER', loc: locA1, sv: 0 })
  tokAdmin = createToken({ sub: adminA, name: `${P}Zaposleni Central`, role: 'ADMIN', loc: locA1, sv: 0 })

  // delovna mesta (Job GLOBALEN — prefiksiran id/name za čistost)
  jW = `${P}jobW-${RUN}`
  jK = `${P}jobK-${RUN}`
  await db.job.create({ data: { id: jW, name: `${P}Natakar ${RUN}`, basePayRate: 10, isActive: true } })
  await db.job.create({ data: { id: jK, name: `${P}Kuhar ${RUN}`, basePayRate: 12.5, isActive: true } })

  // plačne postavke (edini vir urne postavke — veriga exact → primary → base)
  await db.employeeJob.create({ data: { id: `${P}ej-1-${RUN}`, employeeId: emp1, jobId: jW, payRate: 10, isPrimary: true } })
  await db.employeeJob.create({ data: { id: `${P}ej-2-${RUN}`, employeeId: emp2, jobId: jK, payRate: 12, isPrimary: true } })
  await db.employeeJob.create({ data: { id: `${P}ej-5-${RUN}`, employeeId: emp5, jobId: jW, payRate: 10, isPrimary: true } })

  /* ── GLAVNE FIKSTURE (okno 2026-06-01..07, locA1 = Europe/Ljubljana) ──
   * naročila: 06-01 → 90,00 + 50,00 (neto 140,00, 2); 06-02 → 30,00; 06-03 →
   * 40,00 plačano 23:30Z = 01:30 lokalno 06-03 (dokaz cone v D/B);
   * vnosi: te1 10:00–14:00 (240/40,00); te2 22:00–06:00 čez polnoč
   * (480/80,00 → 120/20,00 na 06-02 + 360/60,00 na 06-03); te3 nadura 60/10,00;
   * izmene: s1 06-01 09–17 −30 (450, 12 €/h → 90,00); prihodnje (napoved
   * 06-08..14): s2/s3+s4 (prekrivanje istega zaposlenega)/s5/s6 preklicana/
   * s7 zaključena (IZVEN pokritosti)/s8 540 min brez odmora/s9 brez postavke. */
  await mkOrder(`${P}ord1-${RUN}`, locA1, D('2026-06-01T10:00:00Z'), 100, 10)
  await mkOrder(`${P}ord2-${RUN}`, locA1, D('2026-06-01T10:30:00Z'), 50)
  await mkOrder(`${P}ord3-${RUN}`, locA1, D('2026-06-02T09:00:00Z'), 30)
  await mkOrder(`${P}ord4-${RUN}`, locA1, D('2026-06-02T23:30:00Z'), 40)
  await mkEntry({ employeeId: emp1, jobId: jW, clockIn: D('2026-06-01T08:00:00Z'), clockOut: D('2026-06-01T12:00:00Z'), totalMinutes: 240, payRate: 10, totalPay: 40 })
  await mkEntry({ employeeId: emp2, jobId: jK, clockIn: D('2026-06-02T20:00:00Z'), clockOut: D('2026-06-03T04:00:00Z'), totalMinutes: 480, payRate: 10, totalPay: 80 })
  await mkEntry({ employeeId: emp1, jobId: jW, clockIn: D('2026-06-03T18:00:00Z'), clockOut: D('2026-06-03T19:00:00Z'), totalMinutes: 60, payRate: 10, totalPay: 10, type: 'overtime' })
  await mkShift(emp2, '2026-06-01', '09:00', '17:00', 30, 'confirmed', jK)
  await mkShift(emp1, '2026-06-08', '09:00', '17:00', 30, 'scheduled', jW)
  await mkShift(emp1, '2026-06-09', '09:00', '13:00', 0, 'scheduled', jW)
  await mkShift(emp1, '2026-06-09', '12:00', '16:00', 0, 'confirmed', jW)
  await mkShift(emp2, '2026-06-10', '08:00', '16:00', 0, 'scheduled', jK)
  await mkShift(emp1, '2026-06-11', '09:00', '17:00', 30, 'cancelled', jW)
  await mkShift(emp2, '2026-06-12', '09:00', '18:00', 0, 'completed', jK)
  await mkShift(emp2, '2026-06-13', '09:00', '18:00', 0, 'scheduled', jK)
  // vnos/izmena BREZ lokacije — loader ju IZPUSTI (NE pripisuj neutemeljeni coni)
  await mkEntry({ employeeId: emp1, jobId: jW, clockIn: D('2026-06-01T08:00:00Z'), clockOut: D('2026-06-01T12:00:00Z'), totalMinutes: 240, payRate: 10, totalPay: 40, loc: null })
  await mkShift(emp1, '2026-06-01', '09:00', '17:00', 0, 'scheduled', jW, null)
  await mkShift(emp4, '2026-06-14', '10:00', '18:00', 30, 'scheduled', null)

  /* ── locA2 = UTC, USD (per-cona dokaz): isto plačilo 23:30Z kot ord4, a
   * UTC datum = 06-02; vnos 23:00–01:00Z se razcepi 60+60 po UTC dnevih. */
  await mkOrder(`${P}ord5-${RUN}`, locA2, D('2026-06-02T23:30:00Z'), 50)
  await mkEntry({ employeeId: emp5, jobId: jW, clockIn: D('2026-06-02T23:00:00Z'), clockOut: D('2026-06-03T01:00:00Z'), totalMinutes: 120, payRate: 10, totalPay: 20, loc: locA2 })
  await mkShift(emp5, '2026-06-08', '08:00', '16:00', 0, 'scheduled', jW, locA2)

  /* ── UMAZANE FIKSTURE (okno [danes−4, danes], locA1) — C-sklop ──
   * odprti/nepotrjeni/postavka-0/prekrivanje/izmena-brez-postavke + 1 naročilo. */
  const d2 = addDaysISO(todayISO(), -2) // dnevi z zaprtimi umazanimi vnosi
  const d1 = addDaysISO(todayISO(), -1)
  await mkOrder(`${P}ordD-${RUN}`, locA1, D(`${d2}T10:00:00Z`), 20)
  await mkEntry({ employeeId: emp3, jobId: jW, clockIn: D(`${d2}T08:00:00Z`), clockOut: D(`${d2}T12:00:00Z`), totalMinutes: 240, payRate: 10, totalPay: 40 }) // prekrivanje 1
  await mkEntry({ employeeId: emp3, jobId: jW, clockIn: D(`${d2}T10:00:00Z`), clockOut: D(`${d2}T14:00:00Z`), totalMinutes: 240, payRate: 10, totalPay: 40 }) // prekrivanje 2
  await mkEntry({ employeeId: emp3, jobId: jW, clockIn: D(`${d2}T15:00:00Z`), clockOut: D(`${d2}T17:00:00Z`), totalMinutes: 120, payRate: 0, totalPay: 50 }) // stopnja 0 (zaprt)
  await mkEntry({ employeeId: emp3, jobId: jW, clockIn: D(`${d1}T08:00:00Z`), clockOut: D(`${d1}T10:00:00Z`), totalMinutes: 120, payRate: 10, totalPay: 20, status: 'active' }) // nepotrjen
  // odprt vnos: prijava včeraj 23:30Z = danes 01:30 lokalno → živi delež do zdaj
  await mkEntry({ employeeId: emp3, jobId: jW, clockIn: D(`${d1}T23:30:00Z`), clockOut: null, payRate: 10, status: 'active' })
  // izmena BREZ postavke (jobId null, brez EmployeeJob) → minute štejejo, strošek 0
  await mkShift(emp4, d2, '09:00', '17:00', 0, 'confirmed', null)
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ čisti-motor pomožniki (brez DB) ═══════════════════ */

const E_LOC: LocationTz = { id: 'i10-eLJU', timezone: 'Europe/Ljubljana', currency: 'EUR' }
const E_LOC_UTC: LocationTz = { id: 'i10-eUTC', timezone: 'UTC', currency: 'USD' }
const E_JOB_W: JobBase = { jobId: 'i10-ejw', name: 'Natakar', basePayRateCents: 1000 }
const E_JOB_K: JobBase = { jobId: 'i10-ejk', name: 'Kuhar', basePayRateCents: 1250 }
const ej = (employeeId: string, cents: number, jobId = 'i10-ejw'): JobRate => ({ jobId, employeeId, payRateCents: cents, isPrimary: true })

function sh(employeeId: string, date: string, start: string, end: string, brk = 0, status = 'scheduled', jobId: string | null = 'i10-ejw', loc = 'i10-eLJU'): ShiftInput {
  return { id: `i10-esh-${employeeId}-${date}-${start}`, employeeId, jobId, shiftDate: D(`${date}T00:00:00Z`), startTime: start, endTime: end, breakMinutes: brk, status, locationId: loc }
}

function entry(id: string, employeeId: string, clockIn: string, clockOut: string | null, totalMinutes: number, payRate: number, totalPay: number, status = 'approved', jobId: string | null = null, loc = 'i10-eLJU') {
  return { id, employeeId, jobId, clockIn: D(clockIn), clockOut: clockOut === null ? null : D(clockOut), breakMinutes: 0, totalMinutes, payRate, totalPay, type: 'regular', status, locationId: loc }
}

function dayRow(date: string, dow: number, net: number, orders: number): LaborCoverageDay {
  return {
    date, dow, netSalesCents: net, orders, plannedMinutes: 0, plannedCostCents: 0, plannedIncomplete: 0,
    actualMinutes: 0, actualCostCents: 0, openEntries: 0, unapproved: 0, rateZero: 0, overtimeMinutes: 0,
    varianceMinutes: 0, laborPct: null, sphCents: null, costPerOrderCents: null,
  }
}

function fday(date: string, dow: number, net: number | null, sampleCount = 3): LaborCoverageForecastDay {
  return { date, dow, expectedNetSalesCents: net, minCents: net, maxCents: net, sampleCount, closedDays: 0, confidence: 'ok' }
}

/* ═══════════════════ A. čisti motor (labor-coverage.ts) ═══════════════════ */

describe('A. labor-coverage.ts čisti motor', () => {
  it('A1. konstante: pasovi 32/38/20, okno 90, napoved 7 + nabora statusov', () => {
    expect(LCOV_TARGET_PCT).toBe(32)
    expect(LCOV_WARN_PCT).toBe(38)
    expect(LCOV_LOW_PCT).toBe(20)
    expect(LCOV_MAX_DAYS).toBe(90)
    expect(LCOV_FORECAST_DAYS).toBe(7)
    expect([...SHIFT_HISTORY_STATUSES]).toEqual(['scheduled', 'confirmed', 'in_progress', 'completed'])
    expect([...SHIFT_FORECAST_STATUSES]).toEqual(['scheduled', 'confirmed', 'in_progress'])
    // zgodovina je nADNABOR napovedi (completed = zgodovina, napoved samo načrtovane)
    for (const s of SHIFT_FORECAST_STATUSES) expect([...SHIFT_HISTORY_STATUSES]).toContain(s)
  })

  it('A2. resolveShiftRateCents veriga: exact → primary → base → none (0 = manjkajoča)', () => {
    const s = (jobId: string | null) => sh('e1', '2026-06-01', '09:00', '17:00', 0, 'scheduled', jobId)
    // 1. EmployeeJob (employeeId+jobId) exact
    expect(resolveShiftRateCents(s('j1'), [{ jobId: 'j1', employeeId: 'e1', payRateCents: 1000, isPrimary: false }], [])).toEqual({ cents: 1000, source: 'employee-job-exact' })
    // 2. exact s postavko 0 → MANJKAJOČA → veriga nadaljuje na primarno
    expect(resolveShiftRateCents(s('j1'), [
      { jobId: 'j1', employeeId: 'e1', payRateCents: 0, isPrimary: false },
      { jobId: 'j2', employeeId: 'e1', payRateCents: 1500, isPrimary: true },
    ], [])).toEqual({ cents: 1500, source: 'employee-job-primary' })
    // 3. exact manjka → primarna dodelitev istega zaposlenega (tudi jobId null)
    expect(resolveShiftRateCents(s(null), [ej('e1', 1200, 'j2')], [])).toEqual({ cents: 1200, source: 'employee-job-primary' })
    // 4. primarna BATE osnovno postavko (job-base je šele za njo)
    expect(resolveShiftRateCents(s('jB'), [ej('e1', 1200, 'j2')], [{ jobId: 'jB', name: 'x', basePayRateCents: 800 }])).toEqual({ cents: 1200, source: 'employee-job-primary' })
    // 5. Job.basePayRate kadar zaposleni nima EmployeeJob
    expect(resolveShiftRateCents(s('jB'), [], [{ jobId: 'jB', name: 'x', basePayRateCents: 800 }])).toEqual({ cents: 800, source: 'job-base' })
    // 6. base 0 → 'none': 0 centov IZRECNO (nikoli tiho — klicalna koda zastavi)
    expect(resolveShiftRateCents(s('jB'), [], [{ jobId: 'jB', name: 'x', basePayRateCents: 0 }])).toEqual({ cents: 0, source: 'none' })
    // 7. ničesar → 'none'
    expect(resolveShiftRateCents(s('jX'), [], [])).toEqual({ cents: 0, source: 'none' })
  })

  it('A3. shiftDurationMinutes: čez polnoč +24h, − odmor, min 0, slabi vnosi → null', () => {
    expect(shiftDurationMinutes(sh('e', '2026-06-01', '09:00', '17:00', 30))).toBe(450)
    expect(shiftDurationMinutes(sh('e', '2026-06-01', '22:00', '06:00', 0))).toBe(480) // endTime ≤ start → +24h
    expect(shiftDurationMinutes(sh('e', '2026-06-01', '22:00', '06:00', 30))).toBe(450)
    expect(shiftDurationMinutes(sh('e', '2026-06-01', '09:00', '09:00', 0))).toBe(1440) // polna izmena
    expect(shiftDurationMinutes(sh('e', '2026-06-01', '09:00', '10:00', 120))).toBe(0) // odmor ≥ trajanje
    expect(shiftDurationMinutes(sh('e', '2026-06-01', '9:5', '17:00', 0))).toBeNull() // slab HH:MM
    expect(shiftDurationMinutes(sh('e', '2026-06-01', '25:00', '17:00', 0))).toBeNull()
    expect(shiftDurationMinutes(sh('e', '2026-06-01', '09:00', '09:60', 0))).toBeNull()
    expect(shiftDurationMinutes({ ...sh('e', '2026-06-01', '09:00', '17:00'), shiftDate: new Date('garbage') })).toBeNull()
  })

  it('A4. coverageFlag pasovi: <20 low, 20–32 ok, >32–38 warn, >38 alarm; null → null', () => {
    expect(coverageFlag(0)).toBe('low')
    expect(coverageFlag(19.99)).toBe('low')
    expect(coverageFlag(20)).toBe('ok') // meja NI v nižjem pasu
    expect(coverageFlag(31.99)).toBe('ok')
    expect(coverageFlag(32)).toBe('ok') // 32 točno = še ok
    expect(coverageFlag(32.01)).toBe('warn')
    expect(coverageFlag(38)).toBe('warn') // 38 točno = še warn
    expect(coverageFlag(38.01)).toBe('alarm')
    expect(coverageFlag(100)).toBe('alarm')
    expect(coverageFlag(null)).toBeNull() // ni ocene prodaje → ni presoje
    expect(coverageFlag(Number.NaN)).toBeNull()
  })

  it('A5. laborPct: null kadar netSales ≤ 0 (nikoli ∞/0); s prodajo r2', () => {
    // dan z delom a BREZ neto prodaje: laborPct null (nikoli ∞/deljenje z 0);
    // sph = 0 (določene so minute, prodaje ni — as-built: 0, ne null), cpo 0 (1 naročilo z 0 neto)
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-01', locations: [E_LOC],
      orders: [{ id: 'o', paidAt: D('2026-06-01T10:00:00Z'), subtotal: 0, discount: 0, locationId: 'i10-eLJU' }],
      entries: [entry('e1', 'e1', '2026-06-01T08:00:00Z', '2026-06-01T10:00:00Z', 120, 10, 20, 'approved', 'i10-ejw')],
      shifts: [], employeeJobs: [ej('e1', 1000)], jobs: [E_JOB_W], now: D('2026-06-02T00:00:00Z'),
    })
    expect(r.days[0].laborPct).toBeNull()
    expect(r.totals.laborPct).toBeNull()
    expect(r.days[0].sphCents).toBe(0)
    expect(r.days[0].costPerOrderCents).toBe(2000) // strošek/naročilo ne glede na neto (2000 c / 1)
    // popust > skupni → neto clamp na 0 → laborPct null (NE negativno)
    const neg = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-01', locations: [E_LOC],
      orders: [{ id: 'o', paidAt: D('2026-06-01T10:00:00Z'), subtotal: 10, discount: 30, locationId: 'i10-eLJU' }],
      entries: [entry('e1', 'e1', '2026-06-01T08:00:00Z', '2026-06-01T10:00:00Z', 120, 10, 20)],
      shifts: [], employeeJobs: [ej('e1', 1000)], jobs: [E_JOB_W], now: D('2026-06-02T00:00:00Z'),
    })
    expect(neg.days[0].netSalesCents).toBe(0)
    expect(neg.days[0].laborPct).toBeNull()
    // z osnovo: 4000 c stroška / 14000 c neto = 28.57 %
    const okr = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-01', locations: [E_LOC],
      orders: [
        { id: 'o1', paidAt: D('2026-06-01T10:00:00Z'), subtotal: 100, discount: 10, locationId: 'i10-eLJU' },
        { id: 'o2', paidAt: D('2026-06-01T10:30:00Z'), subtotal: 50, discount: 0, locationId: 'i10-eLJU' },
      ],
      entries: [entry('e1', 'e1', '2026-06-01T08:00:00Z', '2026-06-01T12:00:00Z', 240, 10, 40)],
      shifts: [], employeeJobs: [ej('e1', 1000)], jobs: [E_JOB_W], now: D('2026-06-02T00:00:00Z'),
    })
    expect(okr.days[0].laborPct).toBe(28.57)
    expect(okr.totals.laborPct).toBe(28.57)
  })

  it('A6. dataQualityOf števci + reasons = stabilen nabor kod (FcDataQuality vzorec)', () => {
    const dq = dataQualityOf({
      entries: [
        entry('a', 'emp3', '2026-06-16T08:00:00Z', null, 0, 10, 0, 'active'), // odprt (živi delež) + nepotrjen
        entry('b', 'emp3', '2026-06-16T15:00:00Z', '2026-06-16T17:00:00Z', 120, 0, 50), // zaprt s postavko 0
        entry('c', 'emp3', '2026-06-17T08:00:00Z', '2026-06-17T10:00:00Z', 120, 10, 20, 'active'), // nepotrjen
        entry('d1', 'emp3', '2026-06-18T08:00:00Z', '2026-06-18T12:00:00Z', 240, 10, 40),
        entry('d2', 'emp3', '2026-06-18T10:00:00Z', '2026-06-18T14:00:00Z', 240, 10, 40), // prekrivajoč par
        entry('x', 'emp9', 'garbage', '2026-06-18T14:00:00Z', 60, 10, 10), // slab clockIn → izpuščen
      ],
      historyShifts: [sh('emp4', '2026-06-19', '09:00', '17:00', 0, 'confirmed', null)], // brez postavke
      employeeJobs: [], jobs: [],
      locations: [E_LOC, E_LOC_UTC],
      now: D('2026-06-16T08:30:00Z'), // 30 min po prijavi odprtega (ne prekriva ostalih)
      totalOrders: 5,
    })
    expect(dq).toEqual({
      incompleteData: true,
      reasons: ['open-entries', 'rate-zero', 'overlap', 'unapproved', 'missing-rate-shifts', 'mixed-currencies'],
      openEntries: 1, rateZero: 1, overlapPairs: 1, unapproved: 2, missingRateShifts: 1, mixedCurrencies: 2,
    })
    // vsaka koda je iz STABILNEGA nabora (UI preslika lcov.dq.*)
    const ENUM = ['open-entries', 'rate-zero', 'overlap', 'unapproved', 'missing-rate-shifts', 'mixed-currencies', 'no-sales']
    for (const reason of dq.reasons) expect(ENUM).toContain(reason)
    // brez `now`: odprt vnos ostane štet (nikoli tiho), overlap mu ne šteje
    const dq2 = dataQualityOf({
      entries: [entry('a', 'emp3', '2026-06-16T08:00:00Z', null, 0, 10, 0, 'active')],
      historyShifts: [], employeeJobs: [], jobs: [], locations: [E_LOC], totalOrders: 0,
    })
    expect(dq2.openEntries).toBe(1)
    expect(dq2.overlapPairs).toBe(0)
    expect(dq2.reasons).toContain('no-sales')
    // mešane valute: števec RAZLIČNIH valut (ne pa tiho seštevanje)
    expect(dataQualityOf({ entries: [], historyShifts: [], employeeJobs: [], jobs: [], locations: [E_LOC], totalOrders: 1 }).mixedCurrencies).toBe(1)
  })

  it('A7. forecastSales determinizem: byte-identičen izhod, vrstni red vhoda ne šteje', () => {
    const hist = [
      dayRow('2026-06-01', 1, 10000, 2), dayRow('2026-06-02', 2, 5000, 1), dayRow('2026-06-03', 3, 0, 0),
      dayRow('2026-06-08', 1, 0, 0), dayRow('2026-06-15', 1, 30000, 1),
    ]
    const f1 = forecastSales(hist)
    const f2 = forecastSales([...hist]) // isti vhod
    expect(JSON.stringify(f1)).toBe(JSON.stringify(f2)) // byte-identično
    const f3 = forecastSales([...hist].reverse()) // vrstni red NE vpliva (interni sort)
    expect(JSON.stringify(f1)).toBe(JSON.stringify(f3))
    expect(f1).toHaveLength(7) // privzeti horizon LCOV_FORECAST_DAYS
    expect(f1[0].date).toBe('2026-06-16') // to + 1
    expect(f1[6].date).toBe('2026-06-22')
    // horizon 0 → prazno; > 60 → clamp na 60
    expect(forecastSales(hist, 0)).toHaveLength(0)
    expect(forecastSales([dayRow('2026-06-01', 1, 100, 1)], 100)).toHaveLength(60)
    // prazna zgodovina → []
    expect(forecastSales([], 7)).toEqual([])
    // zaupanje: <3 vzorci isti dan tedna → 'low', ≥3 → 'ok'
    const big = [
      dayRow('2026-06-01', 1, 10000, 2), dayRow('2026-06-08', 1, 30000, 1), dayRow('2026-06-15', 1, 20000, 1),
      dayRow('2026-06-22', 1, 0, 0),
    ]
    const fb = forecastSales(big)
    const mon = fb.find((d) => d.date === '2026-06-29')!
    expect(mon.confidence).toBe('ok') // 3 vzorci (10000/30000/20000)
    expect(mon.sampleCount).toBe(3)
    expect(mon.closedDays).toBe(1) // 06-22 brez naročil
    const tue = fb.find((d) => d.date === '2026-06-23')!
    expect(tue.confidence).toBe('low') // 0 vzorcev torek
  })
})

/* ═══════════════════ B. ruta GET /api/reports/labor-coverage ═══════════════════ */

describe('B. ruta labor-coverage (okno/obseg/varovalke/PII)', () => {
  it('B1. 200 happy — izračunani števili + oblika izhoda + PII (samo agregati)', async () => {
    const r = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}&locationId=${locA1}`, tokAdmin))
    expect(r.status).toBe(200)
    const b = await body(r)
    // top-level ključi: NATANKO pogodba (generatedAt doda ruta)
    expect(Object.keys(b).sort()).toEqual(['dataQuality', 'days', 'forecast', 'generatedAt', 'hours', 'parameters', 'roles', 'totals'])
    expect(typeof b.generatedAt).toBe('string')
    expect(String(b.generatedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // PII: BREZ employeeId/imen zaposlenih (dnevi/ure/vloge so agregati)
    const raw = JSON.stringify(b)
    expect(raw).not.toContain('employeeId')
    expect(raw).not.toContain('employeeName')
    expect(raw).not.toContain(`${P}Zaposleni`)
    expect(raw).not.toContain(emp1)
    // parametri (determinizem vidljiv: osnova napovedi je izpisana)
    const par = b.parameters as Record<string, unknown>
    expect(Object.keys(par).sort()).toEqual(['closedDays', 'counts', 'currencies', 'forecastDays', 'from', 'jobId', 'locationIds', 'lowPct', 'sampleDays', 'targetPct', 'to', 'warnPct'])
    expect(par.from).toBe(W_FROM)
    expect(par.to).toBe(W_TO)
    expect(par.locationIds).toEqual([locA1])
    expect(par.jobId).toBeNull()
    expect(par.targetPct).toBe(32)
    expect(par.warnPct).toBe(38)
    expect(par.lowPct).toBe(20)
    expect(par.forecastDays).toBe(7)
    expect(par.currencies).toEqual(['EUR'])
    expect(par.sampleDays).toBe(3) // 06-01/02/03 imajo naročila
    expect(par.closedDays).toBe(4)
    expect(par.counts).toEqual({ orders: 4, entries: 3, shifts: 9 }) // vnos/izmena BREZ lokacije IZPUŠČENA
    // dnevi: število dni okna + oblika vrstice + izračunane vrednosti
    const days = b.days as Array<Record<string, unknown>>
    expect(days).toHaveLength(7)
    expect(Object.keys(days[0]).sort()).toEqual(['actualCostCents', 'actualMinutes', 'costPerOrderCents', 'date', 'dow', 'laborPct', 'netSalesCents', 'openEntries', 'orders', 'overtimeMinutes', 'plannedCostCents', 'plannedIncomplete', 'plannedMinutes', 'rateZero', 'sphCents', 'unapproved', 'varianceMinutes'])
    const d1 = days.find((d) => d.date === '2026-06-01')!
    expect(d1.dow).toBe(1)
    expect(d1.netSalesCents).toBe(14000)
    expect(d1.orders).toBe(2)
    expect(d1.plannedMinutes).toBe(450)
    expect(d1.plannedCostCents).toBe(9000)
    expect(d1.actualMinutes).toBe(240)
    expect(d1.actualCostCents).toBe(4000)
    expect(d1.varianceMinutes).toBe(210) // načrtovano − dejansko
    expect(d1.laborPct).toBe(28.57)
    expect(d1.sphCents).toBe(3500)
    expect(d1.costPerOrderCents).toBe(2000)
    const d2 = days.find((d) => d.date === '2026-06-02')!
    expect(d2.actualMinutes).toBe(120) // overnight 22:00–24:00
    expect(d2.actualCostCents).toBe(2000)
    expect(d2.laborPct).toBe(66.67)
    const d3 = days.find((d) => d.date === '2026-06-03')!
    expect(d3.netSalesCents).toBe(4000) // ord4 plačano 23:30Z = 01:30 lokalno 06-03
    expect(d3.actualMinutes).toBe(420) // 360 (nočni vnos) + 60 (nadura)
    expect(d3.actualCostCents).toBe(7000)
    expect(d3.overtimeMinutes).toBe(60)
    const d4 = days.find((d) => d.date === '2026-06-04')!
    expect(d4.netSalesCents).toBe(0)
    expect(d4.laborPct).toBeNull()
    // skupaj
    const t = b.totals as Record<string, unknown>
    expect(Object.keys(t).sort()).toEqual(['actualCostCents', 'actualMinutes', 'costPerOrderCents', 'laborPct', 'netSalesCents', 'orders', 'overtimeMinutes', 'plannedCostCents', 'plannedMinutes', 'sphCents', 'varianceMinutes'])
    expect(t).toEqual({
      netSalesCents: 21000, orders: 4, plannedMinutes: 450, plannedCostCents: 9000,
      actualMinutes: 780, actualCostCents: 13000, laborPct: 61.9, sphCents: 1615,
      costPerOrderCents: 3250, varianceMinutes: -330, overtimeMinutes: 60,
    })
    // vloge: samo agregati po delovnem mestu (BREZ zaposlenih), sortirano po strošku
    const roles = b.roles as Array<Record<string, unknown>>
    expect(roles).toHaveLength(2)
    expect(Object.keys(roles[0]).sort()).toEqual(['actualCostCents', 'actualMinutes', 'jobId', 'name', 'plannedCostCents', 'plannedMinutes'])
    expect(roles[0]).toEqual({ jobId: jK, name: `${P}Kuhar ${RUN}`, plannedMinutes: 450, plannedCostCents: 9000, actualMinutes: 480, actualCostCents: 8000 })
    expect(roles[1]).toEqual({ jobId: jW, name: `${P}Natakar ${RUN}`, plannedMinutes: 0, plannedCostCents: 0, actualMinutes: 300, actualCostCents: 5000 })
    // urna matrika: CELO 7×24 (dow 1..7 × ura 0..23) + oblika celice
    const hours = b.hours as Array<Record<string, unknown>>
    expect(hours).toHaveLength(168)
    expect(Object.keys(hours[0]).sort()).toEqual(['dow', 'hour', 'laborMinutes', 'netSalesCents', 'orders', 'staffOn'])
    const cell = (dow: number, hour: number) => hours.find((h) => h.dow === dow && h.hour === hour)!
    expect(cell(1, 10)).toEqual({ dow: 1, hour: 10, netSalesCents: 0, orders: 0, laborMinutes: 60, staffOn: 1 })
    expect(cell(1, 12)).toEqual({ dow: 1, hour: 12, netSalesCents: 14000, orders: 2, laborMinutes: 60, staffOn: 1 })
    expect(cell(2, 22)).toEqual({ dow: 2, hour: 22, netSalesCents: 0, orders: 0, laborMinutes: 60, staffOn: 1 })
    expect(cell(3, 0)).toEqual({ dow: 3, hour: 0, netSalesCents: 0, orders: 0, laborMinutes: 60, staffOn: 1 })
    expect(cell(3, 5)).toEqual({ dow: 3, hour: 5, netSalesCents: 0, orders: 0, laborMinutes: 60, staffOn: 1 })
    expect(cell(3, 6)).toEqual({ dow: 3, hour: 6, netSalesCents: 0, orders: 0, laborMinutes: 0, staffOn: 0 })
    expect(cell(3, 20)).toEqual({ dow: 3, hour: 20, netSalesCents: 0, orders: 0, laborMinutes: 60, staffOn: 1 })
    // podatkovna kakovost: čisti viri → nič razlogov
    expect(b.dataQuality).toEqual({
      incompleteData: false, reasons: [], openEntries: 0, rateZero: 0, overlapPairs: 0,
      unapproved: 0, missingRateShifts: 0, mixedCurrencies: 1,
    })
    // napoved + pokritost (E-sklop podrobneje — tu struktura)
    const fc = b.forecast as Record<string, unknown>
    expect(fc.method).toBe('same-weekday-average')
    const fd = fc.days as Array<Record<string, unknown>>
    expect(fd).toHaveLength(7)
    expect(Object.keys(fd[0]).sort()).toEqual(['closedDays', 'confidence', 'date', 'dow', 'expectedNetSalesCents', 'maxCents', 'minCents', 'sampleCount'])
    expect(fd[0].date).toBe('2026-06-08')
    expect(fd[0].expectedNetSalesCents).toBe(14000) // edini ponedeljek z prodajo
    const cov = fc.coverage as Array<Record<string, unknown>>
    expect(Object.keys(cov[0]).sort()).toEqual(['date', 'dow', 'expectedNetSalesCents', 'expectedPct', 'flag', 'incompleteRate', 'longNoBreak', 'overlaps', 'overtimeMinutes', 'plannedCostCents', 'plannedMinutes', 'shiftCount'])
    expect(cov.map((c) => c.date)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-13', '2026-06-14'])
  })

  it('B2. privzeto okno 28 dni (brez from/to) + notranja konsistenca datumov', async () => {
    const r = await laborCoverageGET(req('/api/reports/labor-coverage', tokA1))
    expect(r.status).toBe(200)
    const b = await body(r)
    const days = b.days as Array<Record<string, unknown>>
    expect(days).toHaveLength(28)
    const dates = days.map((d) => String(d.date))
    expect(dates[0]).toBe(addDaysISO(dates[27], -27)) // from = to − 27
    const par = b.parameters as Record<string, unknown>
    expect(par.from).toBe(dates[0])
    expect(par.to).toBe(dates[27]) // to = danes (UTC)
    expect(new Date(`${dates[27]}T00:00:00Z`).getTime()).toBeLessThanOrEqual(Date.now()) // nikoli v prihodnosti
    expect(b.hours).toHaveLength(168)
  })

  it('B3. validacija: slab format from/to + from > to → 400', async () => {
    const badFrom = await laborCoverageGET(req(`/api/reports/labor-coverage?from=20260601&to=${W_TO}`, tokA1))
    expect(badFrom.status).toBe(400)
    expect(String((await body(badFrom)).error)).toContain('Neveljaven datum')
    const badTo = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=2026-02-30`, tokA1))
    expect(badTo.status).toBe(400) // round-trip sanity (30.2.)
    const reversed = await laborCoverageGET(req(`/api/reports/labor-coverage?from=2026-06-05&to=2026-06-01`, tokA1))
    expect(reversed.status).toBe(400)
    expect(String((await body(reversed)).error)).toContain('za datumom "to"')
  })

  it('B4. to > danes → clamp na danes; okno > 90 dni → odrezano na 90 dni', async () => {
    // from 2026-01-01 + to 2099 → to = danes, okno ~289 dni → from = to − 89
    const r = await laborCoverageGET(req('/api/reports/labor-coverage?from=2026-01-01&to=2099-01-01', tokA1))
    expect(r.status).toBe(200)
    const b = await body(r)
    const days = b.days as Array<Record<string, unknown>>
    expect(days).toHaveLength(LCOV_MAX_DAYS)
    const dates = days.map((d) => String(d.date))
    expect(dates[0]).toBe(addDaysISO(dates[89], -(LCOV_MAX_DAYS - 1)))
    expect(new Date(`${dates[89]}T00:00:00Z`).getTime()).toBeLessThanOrEqual(Date.now())
    // čisto preteklo preveliko okno: to ostane, from se odreže
    const today = todayISO()
    const r2 = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${addDaysISO(today, -120)}&to=${addDaysISO(today, -1)}`, tokA1))
    const b2 = await body(r2)
    const dates2 = (b2.days as Array<Record<string, unknown>>).map((d) => String(d.date))
    expect(dates2).toHaveLength(90)
    expect(dates2[89]).toBe(addDaysISO(today, -1)) // to NI premaknjen
    expect(dates2[0]).toBe(addDaysISO(addDaysISO(today, -1), -89))
  })

  it('B5. locationId: neznana → 404; staff tuja lokacija → 403 (guardResource); centralna čez-org → 403', async () => {
    const unknown = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}&locationId=${P}nema-${RUN}`, tokA1))
    expect(unknown.status).toBe(404)
    expect(String((await body(unknown)).error)).toContain('Lokacija ne obstaja')
    // mgrA1 (MANAGER locA1) → locB: lokacijski sloj varovalke
    const staffForeign = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}&locationId=${locB}`, tokA1))
    expect(staffForeign.status).toBe(403)
    // adminA (ADMIN orgA) → locB (orgB): org meja centralne vloge
    const centralForeign = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}&locationId=${locB}`, tokAdmin))
    expect(centralForeign.status).toBe(403)
    expect(String((await body(centralForeign)).error)).toContain('drugi organizaciji')
    // mgrA1 → locA2 (ISTA org, a druga lokacija): staff vidi SAMO svojo
    const staffOther = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}&locationId=${locA2}`, tokA1))
    expect(staffOther.status).toBe(403)
  })

  it('B6. staff obseg fail-closed: mgrA1 brez locationId vidi SAMO locA1 (isti obračun)', async () => {
    const r = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}`, tokA1))
    expect(r.status).toBe(200)
    const b = await body(r)
    const par = b.parameters as Record<string, unknown>
    expect(par.locationIds).toEqual([locA1]) // fail-closed — NIKOLI vse lokacije
    expect(par.currencies).toEqual(['EUR'])
    // isti izračun kot B1 (locA1-only): umazane oktobrske fiksture so IZVEN okna
    const t = b.totals as Record<string, unknown>
    expect(t.netSalesCents).toBe(21000)
    expect(t.orders).toBe(4)
    expect(t.actualMinutes).toBe(780)
    expect(t.actualCostCents).toBe(13000)
    expect((b.days as unknown[])).toHaveLength(7)
  })

  it('B7. cross-org: mgrB (orgB) vidi SAMO locB — orgA podatki NEvidni', async () => {
    const r = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}`, tokB))
    expect(r.status).toBe(200)
    const b = await body(r)
    const par = b.parameters as Record<string, unknown>
    expect(par.locationIds).toEqual([locB])
    expect(par.counts).toEqual({ orders: 0, entries: 0, shifts: 0 })
    const t = b.totals as Record<string, unknown>
    expect(t.netSalesCents).toBe(0)
    expect(t.orders).toBe(0)
    expect(t.actualMinutes).toBe(0)
    const raw = JSON.stringify(b)
    expect(raw).not.toContain(locA1) // noben orgA identifikator
    expect(raw).not.toContain(locA2)
  })

  it('B8. 401 brez žetona; 403 waiter (brez reports.labour — issue #72 D3)', async () => {
    const no = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}`))
    expect(no.status).toBe(401)
    expect(String((await body(no)).error)).toContain('Avtentikacija')
    const waiter = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}`, tokWaiter))
    expect(waiter.status).toBe(403)
    expect(String((await body(waiter)).error)).toContain('reports.labour')
  })

  it('B9. jobId filter: SAMO labor stran (vnosi/izmene) — prodaja ostaja celotna', async () => {
    const r = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}&locationId=${locA1}&jobId=${jW}`, tokAdmin))
    expect(r.status).toBe(200)
    const b = await body(r)
    const par = b.parameters as Record<string, unknown>
    expect(par.jobId).toBe(jW) // echo filtra
    // jobFilter velja na TimeEntry + StaffShift, NE na Order (prodaja ni vezana na vlogo);
    // s9 ima jobId NULL → jo Prisma jobId-filter izloči (dokumentirano vedenje)
    expect(par.counts).toEqual({ orders: 4, entries: 2, shifts: 4 }) // te1+te3; s2/s3/s4/s6
    const t = b.totals as Record<string, unknown>
    expect(t.netSalesCents).toBe(21000) // NEspremenjena prodaja
    expect(t.actualMinutes).toBe(300) // 240 + 60 (samo jW vnosi)
    expect(t.actualCostCents).toBe(5000)
    expect(t.plannedMinutes).toBe(0) // s1 je jK → izven filtra
    expect(t.laborPct).toBe(23.81)
    expect(t.sphCents).toBe(4200)
    expect(t.costPerOrderCents).toBe(1250)
    const d1 = (b.days as Array<Record<string, unknown>>).find((d) => d.date === '2026-06-01')!
    expect(d1.netSalesCents).toBe(14000)
    expect(d1.actualMinutes).toBe(240)
    // vloge: SAMO jW vrstica
    const roles = b.roles as Array<Record<string, unknown>>
    expect(roles).toHaveLength(1)
    expect(roles[0].jobId).toBe(jW)
    // pokritost: samo jW prihodnje izmene (s5/s8 sta jK, s9 jobId null → IZVEN filtra)
    const cov = ((b.forecast as Record<string, unknown>).coverage as Array<Record<string, unknown>>).map((c) => c.date)
    expect(cov).toEqual(['2026-06-08', '2026-06-09'])
    // napoved NI odvisna od job filtra (celotna prodaja)
    const fd = (b.forecast as Record<string, unknown>).days as Array<Record<string, unknown>>
    expect(fd[0].expectedNetSalesCents).toBe(14000)
  })

  it('B10. per-lokacijska cona (locA2 = UTC): isti instant 23:30Z → 06-02 UTC (v LJU bi bil 06-03)', async () => {
    const r = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}&locationId=${locA2}`, tokAdmin))
    expect(r.status).toBe(200)
    const b = await body(r)
    const par = b.parameters as Record<string, unknown>
    expect(par.locationIds).toEqual([locA2])
    expect(par.currencies).toEqual(['USD'])
    expect(par.counts).toEqual({ orders: 1, entries: 1, shifts: 1 })
    const days = b.days as Array<Record<string, unknown>>
    const d2 = days.find((d) => d.date === '2026-06-02')!
    expect(d2.netSalesCents).toBe(5000) // ord5 23:30Z = 23:30 UTC → 06-02 (v LJU = 06-03!)
    expect(d2.actualMinutes).toBe(60) // vnos 23:00–01:00Z: 60 min na 06-02 UTC
    expect(d2.actualCostCents).toBe(1000)
    const d3 = days.find((d) => d.date === '2026-06-03')!
    expect(d3.actualMinutes).toBe(60) // 60 min na 06-03 UTC
    expect(d3.netSalesCents).toBe(0)
    const t = b.totals as Record<string, unknown>
    expect(t.laborPct).toBe(40) // 2000 / 5000
    // pokritost 06-08 (jW izmena, 480 min, 10 €/h): ponedeljek BREZ vzorcev v UTC
    const cov = (b.forecast as Record<string, unknown>).coverage as Array<Record<string, unknown>>
    expect(cov).toHaveLength(1)
    expect(cov[0].plannedMinutes).toBe(480)
    expect(cov[0].plannedCostCents).toBe(8000)
    expect(cov[0].expectedNetSalesCents).toBeNull()
    expect(cov[0].expectedPct).toBeNull()
    expect(cov[0].flag).toBeNull()
    // ena lokacija → ena valuta (mešanje je zastavika, ne gre vedno)
    expect((b.dataQuality as Record<string, unknown>).mixedCurrencies).toBe(1)
  })

  it('B11. centralni obseg brez locationId: orgA lokacije (locA1+locA2) + mešane valute (zastavica)', async () => {
    // centralna ADMIN orgA: allow-lista orgA (tudi legacy propertyId-null lokacije
    // dev.db — zato strukturne trditve, ne izračunani števli)
    const r = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}`, tokAdmin))
    expect(r.status).toBe(200)
    const b = await body(r)
    const par = b.parameters as Record<string, unknown>
    const ids = par.locationIds as string[]
    expect(ids).toContain(locA1)
    expect(ids).toContain(locA2)
    expect(ids).not.toContain(locB) // orgB NEvidna
    // EUR (locA1 + dev.db legacy) + USD (locA2) → 2 valute → zastavica + razlog
    const dq = b.dataQuality as Record<string, unknown>
    expect(dq.mixedCurrencies).toBe(2)
    expect(dq.reasons).toContain('mixed-currencies')
    expect(par.currencies).toEqual(['EUR', 'USD'])
  })
})

/* ═══════════════════ C. podatkovna kakovost (nikoli tiho) ═══════════════════ */

describe('C. podatkovna kakovost — števci + zastavice', () => {
  it('C1. odprt vnos: živi delež do `now` (labor-cost precedens) + števec; brez now → 0 minut a ŠTET', () => {
    const open = { id: 'op', employeeId: 'e1', jobId: 'i10-ejw', clockIn: D('2026-06-01T08:00:00Z'), clockOut: null, breakMinutes: 0, totalMinutes: 0, payRate: 10, totalPay: 0, type: 'regular', status: 'active', locationId: 'i10-eLJU' }
    // fiksni now = 2h po prijavi → 120 min × 10 €/h = 2000 c
    const r = laborCoverageReport({ from: '2026-06-01', to: '2026-06-01', locations: [E_LOC], orders: [], entries: [open], shifts: [], employeeJobs: [ej('e1', 1000)], jobs: [E_JOB_W], now: D('2026-06-01T10:00:00Z') })
    const d = r.days[0]
    expect(d.openEntries).toBe(1)
    expect(d.unapproved).toBe(1) // odprt je po navadi tudi 'active'
    expect(d.actualMinutes).toBe(120)
    expect(d.actualCostCents).toBe(2000)
    expect(r.dataQuality.openEntries).toBe(1)
    // BREZ now: 0 minut/stroška, a odprt vnos ostane štet (nikoli tiho)
    const rn = laborCoverageReport({ from: '2026-06-01', to: '2026-06-01', locations: [E_LOC], orders: [], entries: [open], shifts: [], employeeJobs: [ej('e1', 1000)], jobs: [E_JOB_W] })
    expect(rn.days[0].actualMinutes).toBe(0)
    expect(rn.days[0].actualCostCents).toBe(0)
    expect(rn.days[0].openEntries).toBe(1)
    expect(rn.dataQuality.openEntries).toBe(1)
    expect(rn.dataQuality.reasons).toContain('open-entries')
  })

  it('C2. zaprt vnos s postavko 0: minute štejejo, strošek 0 + števec (nikoli tiho 0 €)', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-01', locations: [E_LOC],
      orders: [{ id: 'o', paidAt: D('2026-06-01T10:00:00Z'), subtotal: 20, discount: 0, locationId: 'i10-eLJU' }],
      entries: [entry('z', 'e1', '2026-06-01T08:00:00Z', '2026-06-01T10:00:00Z', 120, 0, 50)], // totalPay 50 bi bil 5000 c
      shifts: [], employeeJobs: [], jobs: [E_JOB_W], now: D('2026-06-02T00:00:00Z'),
    })
    expect(r.days[0].actualMinutes).toBe(120) // minute se štejejo
    expect(r.days[0].actualCostCents).toBe(0) // a strošek 0 (NE 5000 iz posnetka)
    expect(r.days[0].rateZero).toBe(1)
    expect(r.days[0].laborPct).toBe(0) // z osnovo → 0 % (vidno, ne skrito)
    expect(r.dataQuality.rateZero).toBe(1)
    expect(r.dataQuality.reasons).toEqual(['rate-zero'])
  })

  it('C3. prekrivajoča se okna ISTEGA zaposlenega: par štet, vnosi NE izločeni', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-01', locations: [E_LOC],
      orders: [{ id: 'o', paidAt: D('2026-06-01T10:00:00Z'), subtotal: 20, discount: 0, locationId: 'i10-eLJU' }],
      entries: [
        entry('d1', 'e1', '2026-06-01T08:00:00Z', '2026-06-01T12:00:00Z', 240, 10, 40),
        entry('d2', 'e1', '2026-06-01T10:00:00Z', '2026-06-01T14:00:00Z', 240, 10, 40), // prekrivanje [10,12)
      ],
      shifts: [], employeeJobs: [], jobs: [E_JOB_W], now: D('2026-06-02T00:00:00Z'),
    })
    expect(r.days[0].actualMinutes).toBe(480) // OBA vnosa prispevata (NE izločena)
    expect(r.days[0].actualCostCents).toBe(8000)
    expect(r.dataQuality.overlapPairs).toBe(1) // a zastavica živi
    expect(r.dataQuality.reasons).toEqual(['overlap'])
  })

  it('C4. nepotrjen zaprt vnos: štet + prispeva (operativni pogled)', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-01', locations: [E_LOC],
      orders: [{ id: 'o', paidAt: D('2026-06-01T10:00:00Z'), subtotal: 20, discount: 0, locationId: 'i10-eLJU' }],
      entries: [entry('u', 'e1', '2026-06-01T08:00:00Z', '2026-06-01T10:00:00Z', 120, 10, 20, 'active')],
      shifts: [], employeeJobs: [], jobs: [E_JOB_W], now: D('2026-06-02T00:00:00Z'),
    })
    expect(r.days[0].actualMinutes).toBe(120)
    expect(r.days[0].actualCostCents).toBe(2000)
    expect(r.days[0].unapproved).toBe(1)
    expect(r.dataQuality.unapproved).toBe(1)
    expect(r.dataQuality.reasons).toEqual(['unapproved'])
  })

  it('C5. izmena BREZ postavke: minute štejejo, strošek 0 + plannedIncomplete/missingRateShifts', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-01', locations: [E_LOC],
      orders: [{ id: 'o', paidAt: D('2026-06-01T10:00:00Z'), subtotal: 20, discount: 0, locationId: 'i10-eLJU' }],
      entries: [],
      shifts: [sh('e4', '2026-06-01', '09:00', '17:00', 0, 'confirmed', null)], // brez EmployeeJob/Job
      employeeJobs: [], jobs: [], now: D('2026-06-02T00:00:00Z'),
    })
    expect(r.days[0].plannedMinutes).toBe(480) // minute štejejo
    expect(r.days[0].plannedCostCents).toBe(0) // strošek 0 — ZASTAVLJENO, ne tiho
    expect(r.days[0].plannedIncomplete).toBe(1)
    expect(r.dataQuality.missingRateShifts).toBe(1)
    expect(r.dataQuality.reasons).toEqual(['missing-rate-shifts'])
    // vloga brez jobId → vrstica '—' (agregat, brez zaposlenih)
    expect(r.roles).toEqual([{ jobId: null, name: '—', plannedMinutes: 480, plannedCostCents: 0, actualMinutes: 0, actualCostCents: 0 }])
  })

  it('C6. RUTA na umazanih fiksturah: vsi števci + živa proracija odprtega vnosa', async () => {
    const from = addDaysISO(todayISO(), -4)
    const r = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${from}&to=${todayISO()}`, tokA1))
    expect(r.status).toBe(200)
    const b = await body(r)
    // števci točno (umazana fikstura: 1 odprt, 1 stopnja-0, 1 par, 2 nepotrjena, 1 izmena brez postavke)
    expect(b.dataQuality).toEqual({
      incompleteData: true,
      reasons: ['open-entries', 'rate-zero', 'overlap', 'unapproved', 'missing-rate-shifts'],
      openEntries: 1, rateZero: 1, overlapPairs: 1, unapproved: 2, missingRateShifts: 1, mixedCurrencies: 1,
    })
    const par = b.parameters as Record<string, unknown>
    expect(par.counts).toEqual({ orders: 1, entries: 5, shifts: 1 })
    // danes−2: prekrivanja NE izločena (480) + stopnja-0 minute (120) + izmena brez postavke (480)
    const d2 = (b.days as Array<Record<string, unknown>>).find((d) => d.date === addDaysISO(todayISO(), -2))!
    expect(d2.rateZero).toBe(1)
    expect(d2.actualMinutes).toBe(600) // 240 + 240 + 120
    expect(d2.actualCostCents).toBe(8000) // stopnja-0 → 0 c
    expect(d2.plannedMinutes).toBe(480)
    expect(d2.plannedCostCents).toBe(0)
    expect(d2.plannedIncomplete).toBe(1)
    expect(d2.netSalesCents).toBe(2000)
    expect(d2.laborPct).toBe(400)
    // danes−1: nepotrjen zaprt vnos
    const d1 = (b.days as Array<Record<string, unknown>>).find((d) => d.date === addDaysISO(todayISO(), -1))!
    expect(d1.unapproved).toBe(1)
    expect(d1.actualMinutes).toBe(120)
    // danes: odprt vnos (prijava včeraj 23:30Z = 01:30 lokalno DANES) → ŽIVI delež do zdaj
    const d0 = (b.days as Array<Record<string, unknown>>).find((d) => d.date === todayISO())
    expect(d0).toBeTruthy()
    expect(d0!.openEntries).toBe(1)
    expect(d0!.unapproved).toBe(1)
    expect(Number(d0!.actualMinutes)).toBeGreaterThan(0) // živa proracija (runtime)
    expect(Number(d0!.actualMinutes)).toBeLessThan(1560) // < 26 h (varovalka testa)
    expect(Number(d0!.actualCostCents)).toBeGreaterThan(0)
    // pokritost: brez prihodnjih izmen v oknu → prazna (nikoli izmišljeno)
    expect(((b.forecast as Record<string, unknown>).coverage as unknown[])).toHaveLength(0)
  })
})

/* ═══════════════════ D. načrtovano vs dejansko + overnight/cona ═══════════════════ */

describe('D. načrtovano vs dejansko — overnight razcep, cone, variance', () => {
  it('D1. overnight vnos 22:00–06:00 LJU: proporcionalni razcep na OBA dneva + invarianta Σ ≡ total', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-03', locations: [E_LOC], orders: [],
      entries: [
        // 8 h (480 min, 8000 c): 22–24 na 06-02, 00–06 na 06-03
        entry('n1', 'e1', '2026-06-02T20:00:00Z', '2026-06-03T04:00:00Z', 480, 10, 80),
        // čudna plačila (7958 c): floor+ostanek invarianta — 180/2982 + 300/4976
        entry('n2', 'e2', '2026-06-02T19:00:00Z', '2026-06-03T03:00:00Z', 480, 10, 79.58),
      ],
      shifts: [], employeeJobs: [ej('e1', 1000), ej('e2', 1000)], jobs: [E_JOB_W], now: D('2026-06-04T00:00:00Z'),
    })
    const d2 = r.days.find((d) => d.date === '2026-06-02')!
    const d3 = r.days.find((d) => d.date === '2026-06-03')!
    expect(d2.actualMinutes).toBe(300) // 120 + 180
    expect(d3.actualMinutes).toBe(660) // 360 + 300
    expect(d2.actualCostCents).toBe(4982) // 2000 + 2982
    expect(d3.actualCostCents).toBe(10976) // 6000 + 4976
    // LEDGER-EKVIVALENTNOST za minute IN cente (Σ razcepljenih ≡ vnosa)
    expect(d2.actualMinutes + d3.actualMinutes).toBe(960) // 480 + 480
    expect(d2.actualCostCents + d3.actualCostCents).toBe(15958) // 8000 + 7958
    // urna matrika: nočne ure po 60 min (povedek razcepa na urne koške)
    const cell = (dow: number, hour: number) => r.hours.find((h) => h.dow === dow && h.hour === hour)!
    expect(cell(2, 22).laborMinutes).toBe(120) // oba vnosa v 22:00–23:00
    expect(cell(2, 23).laborMinutes).toBe(120)
    expect(cell(3, 0).laborMinutes).toBe(120)
    expect(cell(3, 5).laborMinutes).toBe(60) // n1 (do 06:00) — n2 se konča 05:00
    expect(cell(3, 6).laborMinutes).toBe(0) // vnos se konča 06:00
    expect(cell(2, 21).laborMinutes).toBe(60) // n2 (21:00 lokalno)
  })

  it('D2. per-lokacijska cona: isti instant 23:30Z → 06-03 v LJU / 06-02 v UTC + mešane valute', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-07', locations: [E_LOC, E_LOC_UTC],
      orders: [
        { id: 'oA', paidAt: D('2026-06-02T23:30:00Z'), subtotal: 40, discount: 0, locationId: 'i10-eLJU' },
        { id: 'oB', paidAt: D('2026-06-02T23:30:00Z'), subtotal: 50, discount: 0, locationId: 'i10-eUTC' },
      ],
      entries: [entry('t5', 'e5', '2026-06-02T23:00:00Z', '2026-06-03T01:00:00Z', 120, 10, 20, 'approved', 'i10-ejw', 'i10-eUTC')],
      shifts: [], employeeJobs: [ej('e5', 1000)], jobs: [E_JOB_W], now: D('2026-06-04T00:00:00Z'),
    })
    const d2 = r.days.find((d) => d.date === '2026-06-02')!
    const d3 = r.days.find((d) => d.date === '2026-06-03')!
    expect(d2.netSalesCents).toBe(5000) // UTC: 23:30 je ŠE 06-02
    expect(d2.actualMinutes).toBe(60) // UTC vnos 23:00–01:00 → 60 min na 06-02
    expect(d3.netSalesCents).toBe(4000) // LJU: 23:30Z = 01:30 06-03
    expect(d3.actualMinutes).toBe(60)
    expect(r.totals.netSalesCents).toBe(9000)
    // združitev po LOKALNEM datumskem ključu; mešane valute → zastavica (ne tiho)
    expect(r.parameters.currencies).toEqual(['EUR', 'USD'])
    expect(r.dataQuality.mixedCurrencies).toBe(2)
    expect(r.dataQuality.reasons).toEqual(['mixed-currencies'])
  })

  it('D3. izmena čez polnoč se pripiše dnevu ZAČETKA (22:00–06:00 → START dan)', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-03', locations: [E_LOC], orders: [],
      entries: [],
      shifts: [sh('e1', '2026-06-02', '22:00', '06:00', 30)], // 480 − 30 = 450
      employeeJobs: [ej('e1', 1000)], jobs: [E_JOB_W], now: D('2026-06-04T00:00:00Z'),
    })
    const d2 = r.days.find((d) => d.date === '2026-06-02')!
    const d3 = r.days.find((d) => d.date === '2026-06-03')!
    expect(d2.plannedMinutes).toBe(450) // VSE minute na dan začetka
    expect(d2.plannedCostCents).toBe(7500) // round(450 × 1000 / 60)
    expect(d2.varianceMinutes).toBe(450) // načrtovano − dejansko (0)
    expect(d3.plannedMinutes).toBe(0)
    expect(d3.plannedCostCents).toBe(0)
  })

  it('D4. varianceMinutes per dan + per-dan laborPct pasovi (badge barve)', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-03', locations: [E_LOC],
      orders: [
        { id: 'o1', paidAt: D('2026-06-01T10:00:00Z'), subtotal: 100, discount: 10, locationId: 'i10-eLJU' },
        { id: 'o2', paidAt: D('2026-06-01T10:30:00Z'), subtotal: 50, discount: 0, locationId: 'i10-eLJU' },
        { id: 'o3', paidAt: D('2026-06-02T09:00:00Z'), subtotal: 30, discount: 0, locationId: 'i10-eLJU' },
      ],
      entries: [
        entry('e1', 'e1', '2026-06-01T08:00:00Z', '2026-06-01T12:00:00Z', 240, 10, 40),
        entry('e2', 'e1', '2026-06-02T20:00:00Z', '2026-06-03T04:00:00Z', 480, 10, 80),
      ],
      shifts: [sh('e2', '2026-06-01', '09:00', '17:00', 30, 'confirmed', 'i10-ejk')],
      employeeJobs: [ej('e1', 1000, 'i10-ejw'), ej('e2', 1200, 'i10-ejk')], jobs: [E_JOB_W, E_JOB_K], now: D('2026-06-04T00:00:00Z'),
    })
    const d1 = r.days.find((d) => d.date === '2026-06-01')!
    const d2 = r.days.find((d) => d.date === '2026-06-02')!
    const d3 = r.days.find((d) => d.date === '2026-06-03')!
    expect(d1.varianceMinutes).toBe(210) // 450 − 240
    expect(d2.varianceMinutes).toBe(-120) // 0 − 120
    expect(d3.varianceMinutes).toBe(-360) // 0 − 360
    expect(r.totals.varianceMinutes).toBe(-270)
    // per-dan laborPct + ISTI pasovi kot pokritost (badge barve UI)
    expect(d1.laborPct).toBe(28.57)
    expect(coverageFlag(d1.laborPct)).toBe('ok') // 20–32
    expect(d2.laborPct).toBe(66.67)
    expect(coverageFlag(d2.laborPct)).toBe('alarm') // > 38
    expect(d3.laborPct).toBeNull() // brez prodaje → brez presoje
    expect(coverageFlag(d3.laborPct)).toBeNull()
  })

  it('D5. urna matrika: VEDNO 168 celic + staffOn povprečje čez dneve z prisotnostjo', () => {
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-08', locations: [E_LOC], orders: [],
      entries: [
        entry('a', 'empX', '2026-06-01T08:00:00Z', '2026-06-01T09:00:00Z', 60, 10, 10), // 10:00 lokalno
        entry('b', 'empY', '2026-06-01T08:00:00Z', '2026-06-01T09:00:00Z', 60, 10, 10), // sočasno
        entry('c', 'empZ', '2026-06-08T08:00:00Z', '2026-06-08T09:00:00Z', 60, 10, 10), // isti dow, 1 zaposlen
      ],
      shifts: [], employeeJobs: [ej('empX', 1000)], jobs: [E_JOB_W], now: D('2026-06-09T00:00:00Z'),
    })
    expect(r.hours).toHaveLength(168)
    const cell = (dow: number, hour: number) => r.hours.find((h) => h.dow === dow && h.hour === hour)!
    expect(cell(1, 10).laborMinutes).toBe(180) // 3 vnosi skozi to uro
    expect(cell(1, 10).staffOn).toBe(1.5) // (2 + 1) / 2 ponedeljka z prisotnostjo
    expect(cell(2, 10).laborMinutes).toBe(0) // torek brez vnosov
    expect(cell(2, 10).staffOn).toBe(0)
    // polnost mreže: dow 1..7, ura 0..23, brez lukenj
    for (let dow = 1; dow <= 7; dow++) for (let hour = 0; hour < 24; hour++) expect(cell(dow, hour)).toBeTruthy()
  })
})

/* ═══════════════════ E. napoved + pokritost prihodnjih izmen ═══════════════════ */

describe('E. napoved prodaje + pokritost', () => {
  it('E1. isti-dan-tedna povprečje: točna matematika + closedDays NE v povprečju', () => {
    const hist = [
      dayRow('2026-06-01', 1, 10000, 2), // ponedeljek A
      dayRow('2026-06-08', 1, 0, 0), // ponedeljek ZAPRT (0 naročil)
      dayRow('2026-06-15', 1, 30000, 1), // ponedeljek C
      dayRow('2026-06-02', 2, 5000, 1), // torek
      dayRow('2026-06-03', 3, 0, 0), // sreda ZAPRTA
      dayRow('2026-06-10', 3, 0, 0), // sreda ZAPRTA
    ]
    const f = forecastSales(hist) // to = 2026-06-15 → 06-16..06-22
    expect(f).toHaveLength(7)
    const mon = f.find((d) => d.date === '2026-06-22')! // ponedeljek
    expect(mon.expectedNetSalesCents).toBe(20000) // (10000 + 30000) / 2
    expect(mon.expectedNetSalesCents).not.toBe(13333) // zaprti dan NE kali povprečja
    expect(mon.minCents).toBe(10000)
    expect(mon.maxCents).toBe(30000)
    expect(mon.sampleCount).toBe(2)
    expect(mon.closedDays).toBe(1) // 06-08 ločeno izpisan
    expect(mon.confidence).toBe('low') // < 3 vzorci
    const tue = f.find((d) => d.date === '2026-06-16')!
    expect(tue.expectedNetSalesCents).toBe(5000)
    expect(tue.sampleCount).toBe(1)
    expect(tue.closedDays).toBe(0)
    const wed = f.find((d) => d.date === '2026-06-17')!
    expect(wed.expectedNetSalesCents).toBeNull() // NIČ izmišljenega brez vzorcev
    expect(wed.sampleCount).toBe(0)
    expect(wed.closedDays).toBe(2) // sreda 06-03 + 06-10 zaprti
    expect(wed.confidence).toBe('low')
    // dow vnaprej izračunan iz datuma (ISO 1=ponedeljek)
    expect(mon.dow).toBe(1)
    expect(tue.dow).toBe(2)
  })

  it('E2. pokritost: SAMO prihodnji dnevi z izmenami v scheduled/confirmed/in_progress', () => {
    const fdays = [fday('2026-06-08', 1, 100000), fday('2026-06-09', 2, 100000), fday('2026-06-10', 3, 100000), fday('2026-06-11', 4, 100000), fday('2026-06-12', 5, 100000)]
    const shifts = [
      sh('e1', '2026-06-08', '09:00', '17:00', 30, 'scheduled'), // vključena
      sh('e1', '2026-06-09', '09:00', '17:00', 0, 'confirmed'), // vključena
      sh('e2', '2026-06-10', '09:00', '17:00', 0, 'in_progress'), // vključena
      sh('e1', '2026-06-11', '09:00', '17:00', 0, 'cancelled'), // IZVEN (preklicana)
      sh('e1', '2026-06-12', '09:00', '17:00', 0, 'completed'), // IZVEN (zaključena = zgodovina)
      sh('e1', '2026-06-01', '09:00', '17:00', 0, 'scheduled'), // preteklost — izven futureDates
    ]
    const cov = coverageOf(fdays, shifts, [ej('e1', 1000), ej('e2', 1000)], [E_JOB_W], [E_LOC])
    expect(cov.map((c) => c.date)).toEqual(['2026-06-08', '2026-06-09', '2026-06-10'])
    expect(cov[0].plannedMinutes).toBe(450)
    expect(cov[0].plannedCostCents).toBe(7500)
    expect(cov[1].plannedMinutes).toBe(480)
    expect(cov[2].plannedMinutes).toBe(480)
    // prazna napoved → prazna pokritost
    expect(coverageOf([], shifts, [ej('e1', 1000)], [E_JOB_W], [E_LOC])).toEqual([])
  })

  it('E3. flag barve po pasih (konstrukcija do znanih deležev) + expectedPct null brez osnove', () => {
    // ena izmena 480 min na dan; postavka različna po zaposlenem → točen delež
    const ejs = [ej('e1', 1875), ej('e2', 2500), ej('e3', 4000), ej('e4', 4750), ej('e5', 4875), ej('e6', 2000)]
    const fdays = [
      fday('2026-07-06', 1, 100000), fday('2026-07-07', 2, 100000), fday('2026-07-08', 3, 100000),
      fday('2026-07-09', 4, 100000), fday('2026-07-10', 5, 100000), fday('2026-07-11', 6, 0), fday('2026-07-12', 7, null),
    ]
    const shifts = [
      sh('e1', '2026-07-06', '09:00', '17:00', 0), // 15000 → 15 % low
      sh('e2', '2026-07-07', '09:00', '17:00', 0), // 20000 → 20 % ok (meja)
      sh('e3', '2026-07-08', '09:00', '17:00', 0), // 32000 → 32 % ok (meja)
      sh('e4', '2026-07-09', '09:00', '17:00', 0), // 38000 → 38 % warn (meja)
      sh('e5', '2026-07-10', '09:00', '17:00', 0), // 39000 → 39 % alarm
      sh('e6', '2026-07-11', '09:00', '17:00', 0), // pričakovana prodaja 0 → null
      sh('e6', '2026-07-12', '09:00', '17:00', 0), // brez ocene → null
    ]
    const cov = coverageOf(fdays, shifts, ejs, [E_JOB_W], [E_LOC])
    expect(cov.map((c) => c.date)).toEqual(fdays.map((d) => d.date))
    expect(cov[0]).toMatchObject({ date: '2026-07-06', plannedCostCents: 15000, expectedPct: 15, flag: 'low' })
    expect(cov[1]).toMatchObject({ date: '2026-07-07', plannedCostCents: 20000, expectedPct: 20, flag: 'ok' })
    expect(cov[2]).toMatchObject({ date: '2026-07-08', plannedCostCents: 32000, expectedPct: 32, flag: 'ok' })
    expect(cov[3]).toMatchObject({ date: '2026-07-09', plannedCostCents: 38000, expectedPct: 38, flag: 'warn' })
    expect(cov[4]).toMatchObject({ date: '2026-07-10', plannedCostCents: 39000, expectedPct: 39, flag: 'alarm' })
    expect(cov[5]).toMatchObject({ date: '2026-07-11', expectedPct: null, flag: null }) // prodaja 0 → ni presoje
    expect(cov[6]).toMatchObject({ date: '2026-07-12', expectedPct: null, flag: null }) // brez vzorcev
    // nadure v napovedi so vedno 0 (zgolj pretekli dejanski podatek)
    for (const c of cov) expect(c.overtimeMinutes).toBe(0)
  })

  it('E4. overlaps: pari ISTEGA zaposlenega; dotikajoča okna NISO prekrivanje; longNoBreak', () => {
    const fdays = [fday('2026-07-13', 1, 100000), fday('2026-07-14', 2, 100000), fday('2026-07-15', 3, 100000)]
    const shifts = [
      // isti zaposleni e1: 09–13 ∩ 12–16 = 1 par (+ nočna 21–06 brez prekrivanja)
      sh('e1', '2026-07-13', '09:00', '13:00', 0),
      sh('e1', '2026-07-13', '12:00', '16:00', 0),
      sh('e1', '2026-07-13', '21:00', '06:00', 0), // 540 min brez odmora → longNoBreak
      // različna zaposlena, dotikajoča se okna → NI prekrivanje
      sh('e2', '2026-07-14', '09:00', '13:00', 0),
      sh('e3', '2026-07-14', '13:00', '17:00', 0),
      // 480 min točno brez odmora → NI longNoBreak (> 8 h strogo)
      sh('e2', '2026-07-15', '09:00', '17:00', 0),
    ]
    const cov = coverageOf(fdays, shifts, [ej('e1', 1875), ej('e2', 2500), ej('e3', 2500)], [E_JOB_W], [E_LOC])
    const c13 = cov.find((c) => c.date === '2026-07-13')!
    expect(c13.shiftCount).toBe(3)
    expect(c13.plannedMinutes).toBe(1020) // 240 + 240 + 540
    expect(c13.overlaps).toBe(1) // samo par (09–13, 12–16)
    expect(c13.longNoBreak).toBe(1) // samo nočna 540 min brez odmora
    const c14 = cov.find((c) => c.date === '2026-07-14')!
    expect(c14.overlaps).toBe(0) // dotik [13,17) ni presek
    const c15 = cov.find((c) => c.date === '2026-07-15')!
    expect(c15.longNoBreak).toBe(0) // 480 točno = NI dolga
    // odmor (> 0) onemogoči longNoBreak tudi pri dolgi izmeni
    const covB = coverageOf([fday('2026-07-16', 4, 100000)], [sh('e2', '2026-07-16', '09:00', '18:00', 30)], [ej('e2', 2500)], [E_JOB_W], [E_LOC])
    expect(covB[0].longNoBreak).toBe(0)
  })

  it('E5. izmena brez postavke v pokritosti: minute štejejo, cost 0 + incompleteRate 1', () => {
    const fdays = [fday('2026-07-17', 5, 100000)]
    const shifts = [sh('e7', '2026-07-17', '09:00', '17:00', 0, 'scheduled', null)] // e7 BREZ EmployeeJob + jobId null (base ne more priteči)
    const cov = coverageOf(fdays, shifts, [ej('e1', 1000)], [E_JOB_W], [E_LOC])
    expect(cov[0].plannedMinutes).toBe(480)
    expect(cov[0].plannedCostCents).toBe(0)
    expect(cov[0].incompleteRate).toBe(1) // r2(1/1) — delež izmen brez postavke
    expect(cov[0].expectedPct).toBe(0) // 0/100000 → 0 % (vidno, zastavljeno)
    expect(cov[0].flag).toBe('low') // 0 < 20 → sumljivo nizko (NI tiho)
  })
})

/* ═══════════════════ F. export (section=labor-coverage) ═══════════════════ */

describe('F. export /api/reports/export?section=labor-coverage', () => {
  it('F1. CSV: BOM + `;` + CRLF + SL glave + 2 decimalki + datoteka labor-pokritost', async () => {
    const r = await exportGET(req(`/api/reports/export?section=labor-coverage&format=csv&from=${W_FROM}&to=${W_TO}&locationId=${locA1}`, tokAdmin))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/csv')
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="labor-pokritost_${W_FROM}_${W_TO}.csv"`)
    const csv = await r.text()
    expect(csv.charCodeAt(0)).toBe(0xfeff) // UTF-8 BOM
    expect(csv).toContain('\r\n') // CRLF
    expect(csv).not.toMatch(/[^\r]\n/) // noben golem LF
    // SL glave odsekov (vzorec drugih sekcij)
    expect(csv).toContain('LABOR POKRITOST - RestaurantOS')
    expect(csv).toContain(`Obdobje;${W_FROM};${W_TO}`)
    expect(csv).toContain('DNEVI')
    expect(csv).toContain('PRODAJA IN DELO PO URAH (7x24, dan = 1 ponedeljek)')
    expect(csv).toContain('NAPOVED PRODAJE (povprečje istega dneva tedna)')
    expect(csv).toContain('POKRITOST PRIHODNJIH IZMEN')
    expect(csv).toContain('VLOGE')
    expect(csv).toContain('IZJEME (PODATKOVNA KAKOVOST)')
    // parametri (determinizem vidljiven: vzorci/zaprti dnevi/števci)
    expect(csv).toContain('Ciljni Labor %;32')
    expect(csv).toContain('Opozorilni %;38')
    expect(csv).toContain('Nizki %;20')
    expect(csv).toContain('Napoved (dni);7')
    expect(csv).toContain('Vzorci (dnevi z prodajo);3')
    expect(csv).toContain('Zaprti dnevi (brez naročil);4')
    expect(csv).toContain(`Lokacije;${locA1}`)
    expect(csv).toContain('Valute;EUR')
    // dnevi: 2 decimalki (p2) + izračunana vrstica 06-01
    expect(csv).toContain('2026-06-01;140.00;2;450;90.00;0;240;40.00;0;0;0;0;210;28.57;35.00;20.00')
    expect(csv).toContain('2026-06-03;40.00;1;0;0.00;0;420;70.00;0;0;0;60;-420;175;5.71;70.00')
    expect(csv).toContain('SKUPAJ;210.00;4;450;90.00;;780;130.00;;;;60;-330;61.9;16.15;32.50')
    // ure: 168 vrstic dow;ura;… (BOM/ime fiksno — števec je dokaz popolnosti)
    const hourRows = csv.split('\r\n').filter((l) => /^\d+;\d+;\d/.test(l))
    expect(hourRows).toHaveLength(168)
    expect(csv).toContain('1;10;0.00;0;60;1')
    expect(csv).toContain('3;0;0.00;0;60;1')
    // napoved + pokritost vrstici
    expect(csv).toContain('2026-06-08;140.00;140.00;140.00;1;low;0')
    expect(csv).toContain('2026-06-08;450;75.00;0;140.00;53.57;alarm;0;0')
    expect(csv).toContain('2026-06-09;480;80.00;0;30.00;266.67;alarm;1;0') // prekrivanje 1
    expect(csv).toContain('2026-06-13;540;108.00;0;;;;0;1') // brez ocene → prazna polja (prodaja/pct/zastavica), dolga brez odmora
    // vloge (agregati — brez zaposlenih)
    expect(csv).toContain(`${P}Kuhar ${RUN};450;90.00;480;80.00`)
    expect(csv).toContain(`${P}Natakar ${RUN};0;0.00;300;50.00`)
    // izjeme: čisti viri
    expect(csv).toContain('Odprti vnosi;0')
    expect(csv).toContain('Mešane valute;NE')
    // PII: BREZ imen zaposlenih/id-jev
    expect(csv).not.toContain(`${P}Zaposleni`)
    expect(csv).not.toContain(emp1)
  })

  it('F2. JSON: ISTA pogodba kot UI ruta — isti motor/loader → globalna identična poročila', async () => {
    const ui = await laborCoverageGET(req(`/api/reports/labor-coverage?from=${W_FROM}&to=${W_TO}&locationId=${locA1}`, tokAdmin))
    const uiB = await body(ui)
    const ex = await exportGET(req(`/api/reports/export?section=labor-coverage&format=json&from=${W_FROM}&to=${W_TO}&locationId=${locA1}`, tokAdmin))
    expect(ex.status).toBe(200)
    const exB = await body(ex)
    expect(exB.section).toBe('labor-coverage')
    // VSA polja poročila so globalno identična (isti obračun kot UI — zahteva #10)
    for (const key of ['parameters', 'days', 'hours', 'roles', 'totals', 'dataQuality', 'forecast']) {
      expect(exB[key]).toEqual(uiB[key]) // globoko primerjanje vrednosti
    }
    // razlikujeta se SAMO časovni žigi/meta (generatedAt ruta, exportMeta izvoz)
    expect(Object.keys(exB).sort()).toEqual(['dataQuality', 'days', 'exportMeta', 'forecast', 'hours', 'parameters', 'roles', 'section', 'totals'])
    const meta = exB.exportMeta as Record<string, unknown>
    expect(meta.from).toBe(W_FROM)
    expect(meta.to).toBe(W_TO)
    expect(meta.locationId).toBe(locA1)
    expect(meta.jobId).toBeNull()
    expect(String(meta.exportedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('F3. dovoljenja: 401 brez žetona; 403 waiter; staff lasten obseg 200; tuja lokacija 403', async () => {
    const no = await exportGET(req(`/api/reports/export?section=labor-coverage&format=csv&from=${W_FROM}&to=${W_TO}`))
    expect(no.status).toBe(401)
    const waiter = await exportGET(req(`/api/reports/export?section=labor-coverage&format=csv&from=${W_FROM}&to=${W_TO}`, tokWaiter))
    expect(waiter.status).toBe(403)
    expect(String((await body(waiter)).error)).toContain('reports.sales')
    // mgrA1 (MANAGER, reports.view, lastni obseg locA1) izvozi svoj obračun
    const own = await exportGET(req(`/api/reports/export?section=labor-coverage&format=csv&from=${W_FROM}&to=${W_TO}`, tokA1))
    expect(own.status).toBe(200)
    const csv = await own.text()
    expect(csv).toContain('LABOR POKRITOST - RestaurantOS')
    expect(csv).toContain(`Obdobje;${W_FROM};${W_TO}`)
    expect(csv).toContain(`Lokacije;${locA1}`) // SAMO lastna lokacija (fail-closed)
    expect(csv).toContain('2026-06-01;140.00;2;450;90.00;0;240;40.00;0;0;0;0;210;28.57;35.00;20.00')
    // staff na tuji lokaciji → guardResource 403; centralna čez-org 403
    const foreign = await exportGET(req(`/api/reports/export?section=labor-coverage&format=csv&from=${W_FROM}&to=${W_TO}&locationId=${locA2}`, tokA1))
    expect(foreign.status).toBe(403)
    const central = await exportGET(req(`/api/reports/export?section=labor-coverage&format=json&from=${W_FROM}&to=${W_TO}&locationId=${locB}`, tokAdmin))
    expect(central.status).toBe(403)
    expect(String((await body(central)).error)).toContain('drugi organizaciji')
    // neveljavno okno v izvozu → ista 400 validacija kot UI ruta
    const bad = await exportGET(req('/api/reports/export?section=labor-coverage&format=csv&from=2026-06-05&to=2026-06-01', tokA1))
    expect(bad.status).toBe(400)
  })

  it('F4. jobId filter v izvozu: echo filtra + SAMO labor stran (isti loader)', async () => {
    const r = await exportGET(req(`/api/reports/export?section=labor-coverage&format=csv&from=${W_FROM}&to=${W_TO}&locationId=${locA1}&jobId=${jW}`, tokAdmin))
    expect(r.status).toBe(200)
    const csv = await r.text()
    expect(csv).toContain(`Filter vloga (jobId);${jW}`)
    expect(csv).toContain('Naložene vrstice;naročila;4;vnosi;2;izmene;4') // prodaja 4, labor filtriran (s9 jobId null izven)
    expect(csv).toContain('2026-06-01;140.00;2;0;0.00;0;240;40.00;0;0;0;0;-240;28.57;35.00;20.00') // načrtovano 0 (s1 je jK)
    // pokritost brez jK izmen (s5 06-10 izven)
    expect(csv).toContain('2026-06-08;450;75.00;0;140.00;53.57;alarm;0;0')
    expect(csv).not.toContain('2026-06-10;480;96.00') // s5 (jK) izločena
    expect(csv).not.toContain('2026-06-14;450;0.00;1') // s9 (jobId null) izločena
  })
})

/* ═══════════════════ G. registri / verzija / 0 DDL ═══════════════════ */

describe('G. registri: TEST_PREFIXES, verzija, reasons enum, 0 DDL', () => {
  it('G1. i10- je v TEST_PREFIXES (fixture-sweep)', () => {
    expect(TEST_PREFIXES).toContain('i10-')
  })

  it('G2. APP_VERSION === 1.134.0', () => {
    // verzijski register posodablja vsak val — zadnji: v1.133.0 (issue #71: 34 UX najdb — KDS izmena+alergeni, jezik vloge)
    expect(APP_VERSION).toBe('1.151.0')
  })

  it('G3. dataQuality.reasons so stabilen nabor kod (UI preslika lcov.dq.*)', () => {
    const ENUM = ['open-entries', 'rate-zero', 'overlap', 'unapproved', 'missing-rate-shifts', 'mixed-currencies', 'no-sales']
    // poročilo, ki sproži VSE kode razen mixed-currencies
    const r = laborCoverageReport({
      from: '2026-06-01', to: '2026-06-01', locations: [E_LOC], orders: [],
      entries: [entry('a', 'e1', '2026-06-01T08:00:00Z', null, 0, 0, 0, 'active')],
      shifts: [sh('e2', '2026-06-01', '09:00', '17:00', 0, 'confirmed', null)],
      employeeJobs: [], jobs: [], now: D('2026-06-01T09:00:00Z'),
    })
    expect(r.dataQuality.reasons).toEqual(['open-entries', 'unapproved', 'missing-rate-shifts', 'no-sales'])
    for (const reason of r.dataQuality.reasons) expect(ENUM).toContain(reason)
    // A6 je že dokazal mixed-currencies kodo — tukaj le-tipujska varovalka nabora
    expect(ENUM).toHaveLength(7)
  })

  it('G4. 0 DDL: schema/SCHEMA_MIGRATIONS/konzola HANDLERS/drift-check BREZ labor-coverage', () => {
    // poročilo je ČIST izračun nad obstoječimi tabelami (issue: "brez novih tabel")
    const schema = readFileSync(join(import.meta.dir, '..', 'prisma', 'schema.sqlite.prisma'), 'utf8')
    expect(schema).not.toContain('labor-coverage')
    expect(schema).not.toContain('LaborCoverage')
    // register migracij NE vsebuje vnosa (stari 'issue10' = PrintJob migracija, nedotaknjena)
    expect(SCHEMA_MIGRATIONS.some((m) => m.id === 'labor-coverage')).toBe(false)
    expect(SCHEMA_MIGRATIONS.some((m) => m.endpoint.includes('labor-coverage'))).toBe(false)
    expect(SCHEMA_MIGRATIONS.some((m) => m.id === 'issue10')).toBe(true) // prejšnja, NE naša
    // konzola HANDLERS (source-check — ni izvožen) nima našega ključa
    const console = readFileSync(join(import.meta.dir, '..', 'src', 'app', 'api', 'admin', 'migrations', 'route.ts'), 'utf8')
    expect(console).not.toContain("'labor-coverage'")
    expect(console).not.toContain('migrate-labor-coverage')
    // drift-check ne pozna našega vzorca (nič DDL → nič drifta)
    const drift = readFileSync(join(import.meta.dir, '..', 'scripts', 'drift-check.ts'), 'utf8')
    expect(drift).not.toContain('labor-coverage')
    expect(drift).not.toContain('LaborCoverage')
  })
})
