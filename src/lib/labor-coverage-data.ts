/**
 * Issue #10 (P2, v1.117.0) — skupni podatkovni loader za poročilo pokritosti
 * dela (strošek dela + napoved pokritosti izmen glede na prodajo).
 *
 * STREŽNIŠKI modul (uvozi db) — izključno za API plasti; čista aritmetika je
 * v src/lib/labor-coverage.ts (0 DB uvozov). Namen: obe ruti pokličeta ENAKO
 * nalaganje (ista vrata, isti obseg, isti viri), da izvoz vedno uporablja
 * ISTI obračun kot UI:
 *  - GET /api/reports/labor-coverage            (JSON za UI)
 *  - GET /api/reports/export?section=labor-coverage (CSV/JSON)
 *
 * Varovalke (fail-closed, zrcalo obstoječih poročil):
 *  - locationScope(user): centralne vloge = org allow-lista (locScope), staff
 *    = IZKLJUČNO svoja lokacija; loader nikoli ne pade nazaj na "vse";
 *  - eksplicitni locationId: 404 (ne obstaja) → guardResource (staff/org
 *    meja, 403) → članstvo v locationScope seznamu (403) — trije sloji;
 *  - TimeEntry/StaffShift imajo NULLABLE locationId: `in` seznam Lokacij v
 *    obsegu vrstice z null lokacijo IZPUSTI (dokumentirano: NE pripisuj
 *    neutemeljeni coni/valuti);
 *  - orderId? NE obstaja: prodaja ni vezana na vlogo (jobId filter velja
 *    SAMO na labor strani — TimeEntry + StaffShift, dokumentirano).
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num } from '@/lib/map'
import { LCOV_FORECAST_DAYS, LCOV_MAX_DAYS, type LaborCoverageInput } from '@/lib/labor-coverage'
import type { AuthPayload } from '@/lib/auth'

/* ─────────────────── 1) Okno analize (from/to) ─────────────────── */

export interface LaborCoverageWindow {
  from: string
  to: string
}

/** Veljaven ISO datum (round-trip po UTC delih — payroll isSanityISO vzorec). */
function isSanityISO(dateISO: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return false
  const [y, m, d] = String(dateISO).split('-').map((v) => Number(v))
  const utc = new Date(Date.UTC(y, m - 1, d))
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d
}

/** Dan + N (koledarska aritmetika na ISO delih — brez ±24h, DST pri miru). */
function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = String(dateISO).split('-').map((v) => Number(v))
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Dnevna razdalja med ISO datumoma (čista UTC koledarska aritmetika). */
function daysBetweenISO(aISO: string, bISO: string): number {
  const [ay, am, ad] = String(aISO).split('-').map((v) => Number(v))
  const [by, bm, bd] = String(bISO).split('-').map((v) => Number(v))
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/**
 * Okno iz query parametrov (YYYY-MM-DD): privzeto zadnjih 28 dni (to = danes
 * po UTC — z več lokacijami/različnimi conami ni enotnega "danes", UTC je
 * enostavna hišna konvencija, enaka `day()` v export ruti).
 * Validacija/clamp: 400 slab format, 400 from > to, to > danes → clamp na
 * danes (from nato sleče na to), okno > LCOV_MAX_DAYS → from = to − 89.
 */
export function resolveLaborCoverageWindow(
  fromP: string | null,
  toP: string | null,
): LaborCoverageWindow | { error: string } {
  const today = new Date().toISOString().slice(0, 10)
  if (fromP !== null && !isSanityISO(fromP)) return { error: 'Neveljaven datum (pričakovano YYYY-MM-DD).' }
  if (toP !== null && !isSanityISO(toP)) return { error: 'Neveljaven datum (pričakovano YYYY-MM-DD).' }
  let from = fromP ?? addDaysISO(today, -27)
  let to = toP ?? today
  if (from > to) return { error: 'Datum "from" je za datumom "to".' }
  if (to > today) to = today // clamp na danes (prihodnost ni zgodovina)
  if (from > to) from = to // from v prihodnosti po clampu to → okno [to, to]
  if (daysBetweenISO(from, to) + 1 > LCOV_MAX_DAYS) from = addDaysISO(to, -(LCOV_MAX_DAYS - 1))
  return { from, to }
}

/* ─────────────────── 2) Loader (viri → motorjev vhod) ─────────────────── */

export interface LoadedLaborCoverage {
  /** Pripravljen vhod za laborCoverageReport() — vključno now = new Date(). */
  input: LaborCoverageInput
  /** id-ji lokacij v obsegu (enkrat uporabljeno za where-clause, izpisano v parameters). */
  locationIds: string[]
}

/** UTC deli ISO datuma (brez parse fallbackov — okno je že validirano). */
function utcOfISO(dateISO: string): number {
  const [y, m, d] = String(dateISO).split('-').map((v) => Number(v))
  return Date.UTC(y, m - 1, d)
}

/**
 * Naloži VSE vire poročila v obsegu uporabnika in sestavi motorjev vhod.
 * `from`/`to` morata biti VELJAVNA ISO datuma (validacija je odgovornost rute
 * prek resolveLaborCoverageWindow). Eksplicitni `locationId`: 404/403 varovalke
 * (fail-closed). `jobId`: filter SAMO na labor strani (TimeEntry/StaffShift).
 */
export async function loadLaborCoverageData(
  user: AuthPayload,
  from: string,
  to: string,
  locationId?: string | null,
  jobId?: string | null,
): Promise<LoadedLaborCoverage | NextResponse> {
  /* ——— varovalke lokacije (fail-closed, trije sloji) ——— */
  const locScope = await locationScope(user)
  let onlyLocationId: string | null = null
  if (locationId) {
    const loc = await db.location.findUnique({ where: { id: locationId }, select: { id: true } })
    if (!loc) return fail('Lokacija ne obstaja.', 404)
    const guard = await guardResource(user, locationId)
    if (guard) return guard // staff: tuja lokacija / centralna: čez-org meja → 403
    onlyLocationId = locationId
  }
  // locScope filtrira stolpec `locationId` DRUGIH modelov; na sami tabeli
  // Location je primarni ključ `id` → dobesedni prevod obsega (id-ekvivalent):
  // centralna org allow-lista ostane allow-lista, staff ostane svoja lokacija.
  const scopeLocationIds = (scope: { locationId?: string | { in: string[] } }): { id?: string | { in: string[] } } => {
    if (typeof scope.locationId === 'string') return { id: scope.locationId }
    if (scope.locationId && typeof scope.locationId === 'object' && 'in' in scope.locationId) {
      return { id: { in: scope.locationId.in ?? [] } }
    }
    return {} // centralna vloga brez meje = vse lokacije
  }
  const locations = await db.location.findMany({
    where: onlyLocationId ? { id: onlyLocationId } : scopeLocationIds(locScope),
    select: { id: true, timezone: true, currency: true },
    take: 500,
  })
  const locationIds = locations.map((l) => l.id)
  if (onlyLocationId && locationIds.length === 0) {
    // lokacija obstaja in je minila guardResource, a ni v locationScope seznamu
    // (npr. centralna vloga vezana na drugo organizacijo brez null-propertyja)
    return fail('Lokacija ni v vašem obsegu — dostop zavrnjen.', 403)
  }

  /* ——— UTC okna z ±1 d varovalnim poljem ———
   * Odmiki con so ≤ 14 h < 24 h → ±1 dan pokrije vse pripise po lokalnem
   * ključu; motor vrstice, ki padejo zunaj [from, to] po lokalnem datumskem
   * ključu, vseeno zavrže (okensko poročilo, ne "vse kar naložim"). */
  const fromLoose = new Date(utcOfISO(from) - 24 * 3600 * 1000)
  const toLoose = new Date(utcOfISO(to) + 2 * 24 * 3600 * 1000) // toEnd + 1 dan
  const toShift = new Date(utcOfISO(to) + (LCOV_FORECAST_DAYS + 2) * 24 * 3600 * 1000)
  const jobFilter = jobId ? { jobId } : {}

  const [orders, entries, shifts] = await Promise.all([
    db.order.findMany({
      where: {
        paymentStatus: 'paid',
        paidAt: { gte: fromLoose, lte: toLoose },
        ...(onlyLocationId ? { locationId: onlyLocationId } : locScope),
      },
      select: { id: true, paidAt: true, subtotal: true, discount: true, locationId: true },
      take: 50000,
    }),
    // presečišče z oknom: clockIn < toEnd+1d && (odprt ALI clockOut > fromStart−1d)
    db.timeEntry.findMany({
      where: {
        clockIn: { lt: toLoose },
        OR: [{ clockOut: null }, { clockOut: { gt: fromLoose } }],
        locationId: { in: locationIds }, // nullable → null izpuščen (NE pripisuj)
        ...jobFilter,
      },
      select: {
        id: true, employeeId: true, jobId: true, clockIn: true, clockOut: true,
        breakMinutes: true, totalMinutes: true, payRate: true, totalPay: true,
        type: true, status: true, locationId: true,
      },
      take: 50000,
    }),
    db.staffShift.findMany({
      where: {
        shiftDate: { gte: fromLoose, lte: toShift }, // from−1d .. to+forecast+1d (+1 d varovala)
        locationId: { in: locationIds },
        ...jobFilter,
      },
      select: {
        id: true, employeeId: true, jobId: true, shiftDate: true, startTime: true,
        endTime: true, breakMinutes: true, status: true, locationId: true,
      },
      take: 20000,
    }),
  ])

  /* ——— plačne postavke (EmployeeJob — edini vir urne postavke) ——— */
  const employeeIds = [...new Set(shifts.map((s) => s.employeeId))]
  const [employeeJobs, jobsRows] = await Promise.all([
    employeeIds.length > 0
      ? db.employeeJob.findMany({
          // BREZ jobId filtra: veriga postavke potrebuje tudi PRIMARNO dodelitev
          // (fallback, ko exact (employeeId, jobId) manjka)
          where: { employeeId: { in: employeeIds } },
          select: { jobId: true, employeeId: true, payRate: true, isPrimary: true },
          take: 20000,
        })
      : Promise.resolve([] as { jobId: string; employeeId: string; payRate: unknown; isPrimary: boolean }[]),
    // Job je GLOBALEN (mali katalog vlog) — imena + osnovne postavke za celo serijo
    db.job.findMany({ select: { id: true, name: true, basePayRate: true }, take: 5000 }),
  ])

  const input: LaborCoverageInput = {
    from,
    to,
    now: new Date(), // živi trenutek — proracija odprtih vnosov (labor-cost precedens)
    locations: locations.map((l) => ({
      id: l.id,
      timezone: l.timezone || 'Europe/Ljubljana', // prazna cona (garbage) → hišni default
      currency: l.currency || 'EUR',
    })),
    orders: orders
      .filter((o) => o.paidAt instanceof Date)
      .map((o) => ({
        id: o.id,
        paidAt: o.paidAt as Date,
        subtotal: num(o.subtotal),
        discount: num(o.discount),
        locationId: o.locationId,
      })),
    entries: entries.map((e) => ({
      id: e.id,
      employeeId: e.employeeId,
      jobId: e.jobId,
      clockIn: e.clockIn,
      clockOut: e.clockOut,
      breakMinutes: e.breakMinutes,
      totalMinutes: e.totalMinutes,
      payRate: num(e.payRate),
      totalPay: num(e.totalPay),
      type: e.type,
      status: e.status,
      locationId: e.locationId,
    })),
    shifts: shifts.map((s) => ({
      id: s.id,
      employeeId: s.employeeId,
      jobId: s.jobId,
      shiftDate: s.shiftDate,
      startTime: s.startTime,
      endTime: s.endTime,
      breakMinutes: s.breakMinutes,
      status: s.status,
      locationId: s.locationId,
    })),
    employeeJobs: employeeJobs.map((j) => ({
      jobId: j.jobId,
      employeeId: j.employeeId,
      payRateCents: Math.round(num(j.payRate) * 100), // €/h → centi/h (payRateToCents)
      isPrimary: j.isPrimary,
    })),
    jobs: jobsRows.map((j) => ({
      jobId: j.id,
      name: j.name,
      basePayRateCents: Math.round(num(j.basePayRate) * 100),
    })),
    jobId: jobId ?? null,
  }
  return { input, locationIds }
}
