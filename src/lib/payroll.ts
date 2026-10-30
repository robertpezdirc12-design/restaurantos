/**
 * Issue #22 (P2, v1.115.0) — obračun plač: ČISTA logika (brez DB/IO uvozov).
 *
 * Kanonični tok (Task 2-design): PayrollPeriod je agregatni zaklep NAD obstoječo
 * evidenco (TimeEntry/StaffShift/TipPool/TipDistribution) — brez novega časovnega
 * sistema. Ta modul vsebuje izključno deterministične funkcije, ki jih API rute
 * (src/app/api/payroll/*) in testi klicajo neposredno:
 *  - DST-varna časovna cona (Intl, brez zunanjih odvisnosti),
 *  - validacija obsega obdobja (62 dni, preteklost),
 *  - gradnjo vrstic obračuna iz TimeEntry (centna aritmetika iz lib/timeclock),
 *  - podatkovne izjeme (menedžerski pregled pred zaklepom),
 *  - agregacijo po zaposlenem + delovnem mestu ter načrtovane minute iz izmen,
 *  - CSV/JSON izvozne gradnike + digeste (rowDigest/contentHash — PII izven).
 *
 * Konvencije:
 *  - vsi denarni zneski so CELIŠTEVILČNI centi (Int); EUR format '12,34',
 *  - meje obdobja so UTC instanti LOKALNE polnoči po Location.timezone;
 *    periodEnd je EKSKLUZIVNA meja (prvi trenutek izven obdobja),
 *  - dateKey = lokalna 'YYYY-MM-DD' datuma vnosa (localDateKey),
 *  - plačilna osnova = SAMO status 'approved' (tips/labor štejeta vse statuse,
 *    #22 pa je plačilni pogled — snapshot ob zaključku).
 */

import { num } from '@/lib/map'
import { payRateToCents } from '@/lib/timeclock'
import type { SurchargeBases } from './payroll-surcharges'
import type { SurchargeRates } from './payroll-rates'
import { pctCsv } from './payroll-rates'

/* ─────────────────── 1) Časovna cona (DST-varno, Intl) ─────────────────── */

/** Odmik časovnega pasu (ms) za dan instant — iz formatToParts (brez deps). */
function tzOffsetMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d)
  const p: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  // hour '24' (midnight, starejši Node) → 0; ms ni v formatu — zaokrožimo na minuto
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, (p.hour ?? 0) % 24, p.minute ?? 0, p.second ?? 0)
  return Math.round((asUTC - d.getTime()) / 60000) * 60000
}

/**
 * UTC instant LOKALNE polnoči (00:00) za dateISO v tz.
 *
 * Fiksna točka: guess = Date.UTC(y,m-1,d) − offset(guess). Zagovor kancer ofseta
 * na polnoč (12:00 UTC guess na dan prehoda pozna/zimska ura vrne PO-prehodni
 * ofset — npr. 2026-10-25 Europe/Ljubljana bi z njim dal 23:00Z namesto 22:00Z),
 * zato 3 iteracije konvergirajo v samo-konzistenten odgovor:
 *   2026-10-25 Europe/Ljubljana → 2026-10-24T22:00:00Z (CEST pred prehodom ob 01:00Z)
 *   2026-03-29 Europe/Ljubljana → 2026-03-28T23:00:00Z (CET pred prehodom ob 01:00Z)
 */
export function localMidnightUtc(dateISO: string, tz: string): Date {
  const [y, m, d] = dateISO.split('-').map((v) => Number(v))
  let guess = Date.UTC(y, m - 1, d, 12) // zagov: poldne UTC (prehodi so ~02–03 lokalno)
  for (let i = 0; i < 3; i++) {
    guess = Date.UTC(y, m - 1, d) - tzOffsetMs(new Date(guess), tz)
  }
  return new Date(guess)
}

/** Lokalni datuma ključ 'YYYY-MM-DD' instanta d v tz (enota lokalnega dne vnosa). */
export function localDateKey(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const p: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') p[part.type] = part.value
  }
  return `${p.year}-${p.month}-${p.day}`
}

/** Koledarski dan +1 (aritmetika na ISO delih — NIKOLI +24h, prehode DST pusti pri miru). */
function nextDayISO(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map((v) => Number(v))
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/**
 * UTC meji obdobja: start = lokalna polnoč startISO; end = lokalna polnoč
 * dneva ZA endISO — EKSKLUZIVNA zgornja meja ([start, end) po clockIn).
 */
export function periodBounds(startISO: string, endISO: string, tz: string): { start: Date; end: Date } {
  return { start: localMidnightUtc(startISO, tz), end: localMidnightUtc(nextDayISO(endISO), tz) }
}

/* ─────────────────── 2) Validacija obsega obdobja ─────────────────── */

export const MAX_PERIOD_DAYS = 62

function isSanityISO(dateISO: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return false
  const [y, m, d] = dateISO.split('-').map((v) => Number(v))
  const utc = new Date(Date.UTC(y, m - 1, d))
  // round-trip (UTC getterji — lokalna cona strežnika ne sme vplivati)
  return (
    utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d
  )
}

/** Dnevna razdalja med ISO datumoma (koledarska, čista UTC — brez DST). */
function daysBetweenISO(aISO: string, bISO: string): number {
  const [ay, am, ad] = aISO.split('-').map((v) => Number(v))
  const [by, bm, bd] = bISO.split('-').map((v) => Number(v))
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/**
 * Validacija [start, end]: veljavna ISO datuma, start ≤ end, span ≤ 62 dni
 * (vključno z obema), end ne v prihodnosti (endISO ≤ todayKey — mesec se
 * zaklepa šele, ko je minil). Slovenska sporočila napak (rute jih vračajo 1:1).
 */
export function validatePeriodRange(
  startISO: string,
  endISO: string,
  todayKey: string,
): { ok: true } | { ok: false; error: string } {
  if (!isSanityISO(startISO) || !isSanityISO(endISO)) {
    return { ok: false, error: 'Neveljaven datum obdobja (pričakovana oblika YYYY-MM-DD).' }
  }
  if (daysBetweenISO(startISO, endISO) < 0) {
    return { ok: false, error: 'Začetek obdobja je za koncem obdobja.' }
  }
  if (daysBetweenISO(startISO, endISO) + 1 > MAX_PERIOD_DAYS) {
    return { ok: false, error: `Obdobje je predolgo (največ ${MAX_PERIOD_DAYS} dni).` }
  }
  if (endISO > todayKey) {
    return { ok: false, error: 'Konec obdobja ne sme biti v prihodnosti — obračun zajame pretekle dneve.' }
  }
  return { ok: true }
}

/* ─────────────────── 3) Vrstice obračuna (TimeEntry → row) ─────────────────── */

/** Vhodna oblika vrstice TimeEntry (Prisma vrstica ali testni objekt). */
export interface PayrollEntryInput {
  id: string
  employeeId: string
  jobId?: string | null
  clockIn: Date
  clockOut: Date | null
  breakMinutes: number
  totalMinutes: number
  /** Decimal | number | string (Prisma Decimal prek num()) */
  payRate: unknown
  totalPay: unknown
  type: string
  status: string
  locationId: string | null
  Employee?: { name: string } | null
  Job?: { name: string } | null
}

/** Izhodna vrstica obračuna (detaljni pogled + CSV/JSON izvoz). */
export interface PayrollEntryRow {
  entryId: string
  employeeId: string
  employeeName: string
  jobId: string | null
  jobName: string
  /** lokalni datum vnosa (localDateKey(clockIn, tz)) */
  date: string
  /** ISO — UTC instant prijave */
  clockIn: string
  /** ISO — null za odprt vnos */
  clockOut: string | null
  breakMinutes: number
  /** neto minute (totalMinutes vnosa; 0 za odprte vnose) */
  netMinutes: number
  payRateCents: number
  /** posnetek vnosa (approved matematika: round(net×rate/60); 0 za odprt vnos) */
  grossCents: number
  type: string
  status: string
  locationId: string | null
}

/**
 * En vnosa → vrstica obračuna. netMinutes = totalMinutes (ZA ZAPRT vnos; odprt
 * prispeva 0 — plača se šele ob odjavi/potrditvi). grossCents = POSNETEK vnosa
 * (payRateToCents(totalPay)) — enak round(netMinutes×payRateCents/60) iz
 * lib/timeclock (totalPayCents), a ohranja ZGODOVINSKO postavko, če se je
 * spremenila po odjavi (snapshot semantika evidenc).
 */
export function toEntryRow(e: PayrollEntryInput, tz: string, jobNameFallback: string): PayrollEntryRow {
  const payRateCents = payRateToCents(num(e.payRate))
  const closed = e.clockOut !== null
  return {
    entryId: e.id,
    employeeId: e.employeeId,
    employeeName: e.Employee?.name ?? '',
    jobId: e.jobId ?? null,
    jobName: e.Job?.name ?? jobNameFallback,
    date: localDateKey(e.clockIn, tz),
    clockIn: e.clockIn.toISOString(),
    clockOut: closed ? (e.clockOut as Date).toISOString() : null,
    breakMinutes: Math.max(0, Math.round(e.breakMinutes || 0)),
    netMinutes: closed ? Math.max(0, Math.round(e.totalMinutes || 0)) : 0,
    payRateCents,
    grossCents: closed ? payRateToCents(num(e.totalPay)) : 0,
    type: e.type,
    status: e.status,
    locationId: e.locationId,
  }
}

/* ─────────────────── 4) Podatkovne izjeme (pregled pred zaklepom) ─────────────────── */

export type PayrollExceptionCode =
  | 'OPEN_ENTRY'
  | 'UNAPPROVED'
  | 'RATE_ZERO'
  | 'RATE_MISMATCH'
  | 'OVERLAP'
  | 'LONG_NO_BREAK'
  | 'SHIFT_NO_ENTRY'

export interface PayrollException {
  code: PayrollExceptionCode
  employeeName: string
  entryId?: string
  shiftId?: string
  detail: string
}

/** Vhodna oblika StaffShift vrstice (izjeme + načrtovane minute). */
export interface ShiftInput {
  id: string
  employeeId: string
  shiftDate: Date
  startTime: string
  endTime: string
  breakMinutes: number
  status: string
  Employee?: { name: string } | null
}

/** Vhodna oblika EmployeeJob (primerjava ZGODOVINSKE vs TRENUTNE postavke). */
export interface EmployeeJobInput {
  employeeId: string
  jobId: string | null
  payRate: unknown
  isPrimary: boolean
}

/** Statusi izmene, ki OBVEZUJEJO evidanco (SHIFT_NO_ENTRY). */
const SHIFT_EXPECTED_STATUSES = ['confirmed', 'completed', 'in_progress']

const eur = (cents: number): string => `${(cents / 100).toFixed(2).replace('.', ',')} €`

/**
 * Menedžerski checklist kakovosti podatkov PRED zaklepom (issue: "izjeme",
 * "opozorila pred zaklepom"). NE blokirajo — zaklep zha acknowledgeExceptions.
 *  - OPEN_ENTRY: vnos brez odjave (manjka odjava).
 *  - UNAPPROVED: ZAPRT vnos s statusom ≠ approved (vključno disputed in
 *    active-closed — recenzija je bila izpuščena).
 *  - RATE_ZERO: postavka 0 na zaprtem vnosu — nikoli 0 € brez opozorila.
 *  - RATE_MISMATCH: posnetek postavke ≠ trenutna EmployeeJob postavka za
 *    (zaposleni, delo), kadar dodelitev obstaja (centna primerjava).
 *  - OVERLAP: dva zaprta vnosa istega zaposlenega se prekrivata [in, out)
 *    — ena izjema na par (manjši ID v entryId; obratni par se ne ponovi).
 *  - LONG_NO_BREAK: neto > 360 min brez odmora (opozorilo, ne blokada).
 *  - SHIFT_NO_ENTRY: potrjena/končana/v-teku izmena brez NOGA vnosa tisti dan
 *    (primerjava lokalnega datuma izmene z množico datumov vnosov).
 */
export function findPayrollExceptions(
  entries: PayrollEntryInput[],
  shifts: ShiftInput[],
  employeeJobs: EmployeeJobInput[],
  tz = 'Europe/Ljubljana',
): PayrollException[] {
  const out: PayrollException[] = []

  // trenutna postavka po (employeeId, jobId)
  const currentRate = new Map<string, number>()
  for (const j of employeeJobs) {
    if (j.jobId !== null) currentRate.set(`${j.employeeId}|${j.jobId}`, payRateToCents(num(j.payRate)))
  }

  const nameOf = (e: PayrollEntryInput): string => e.Employee?.name ?? ''

  const closed = entries.filter((e) => e.clockOut !== null)

  for (const e of entries) {
    const name = nameOf(e)
    if (e.clockOut === null) {
      out.push({
        code: 'OPEN_ENTRY',
        employeeName: name,
        entryId: e.id,
        detail: `Manjka odjava (prijava ${localDateKey(e.clockIn, tz)}).`,
      })
    }
  }

  for (const e of closed) {
    const name = nameOf(e)
    if (e.status !== 'approved') {
      out.push({
        code: 'UNAPPROVED',
        employeeName: name,
        entryId: e.id,
        detail: `Vnos ni potrjen (status: ${e.status}).`,
      })
    }
    const rateCents = payRateToCents(num(e.payRate))
    if (rateCents === 0) {
      out.push({
        code: 'RATE_ZERO',
        employeeName: name,
        entryId: e.id,
        detail: 'Plačna postavka manjka (0 €) — preverite dodelitev delovnega mesta.',
      })
    } else if (e.jobId !== null) {
      const current = currentRate.get(`${e.employeeId}|${e.jobId}`)
      if (current !== undefined && current !== rateCents) {
        out.push({
          code: 'RATE_MISMATCH',
          employeeName: name,
          entryId: e.id,
          detail: `Zgodovinska postavka (${eur(rateCents)}) se razlikuje od trenutne (${eur(current)}).`,
        })
      }
    }
    const netMinutes = Math.max(0, Math.round(e.totalMinutes || 0))
    if (netMinutes > 360 && !(Math.round(e.breakMinutes || 0) > 0)) {
      out.push({
        code: 'LONG_NO_BREAK',
        employeeName: name,
        entryId: e.id,
        detail: `Dolga izmena brez odmora (${netMinutes} min neto, odmor 0 min).`,
      })
    }
  }

  // OVERLAP — pari zaprtih vnosov istega zaposlenega, [clockIn, clockOut)
  const closedSpans = closed.map((e) => ({
    id: e.id,
    employeeId: e.employeeId,
    employeeName: nameOf(e),
    in: e.clockIn.getTime(),
    out: (e.clockOut as Date).getTime(),
  }))
  closedSpans.sort((a, b) => a.in - b.in)
  for (let i = 0; i < closedSpans.length; i++) {
    for (let j = i + 1; j < closedSpans.length; j++) {
      const a = closedSpans[i]
      const b = closedSpans[j]
      // BUGFIX (test agent #5, issue #22): prekrivanje štejemo SAMO znotraj
      // ISTEGA zaposlenega (komentar zgoraj to obljublja, koda pa je manjkala
      // primerjavo) — vzporedne izmene različnih zaposlenih so v gostinstvu
      // normalno delo in ne smejo polniti izjem/exceptionCount.
      if (a.employeeId !== b.employeeId) continue
      if (a.in < b.out && b.in < a.out) {
        const overlapMin = Math.round((Math.min(a.out, b.out) - Math.max(a.in, b.in)) / 60000)
        const [first, second] = a.id < b.id ? [a, b] : [b, a] // manjši ID prvi — deterministično
        out.push({
          code: 'OVERLAP',
          employeeName: first.employeeName,
          entryId: first.id,
          detail: `Prekrivajoča se vnosa ${first.id} in ${second.id} (${overlapMin} min prekrivanja).`,
        })
      }
    }
  }

  // SHIFT_NO_ENTRY — pričakovana izmena brez NOGA vnosa tisti dan (lokalni datum)
  const entryDaysByEmployee = new Map<string, Set<string>>()
  for (const e of entries) {
    const set = entryDaysByEmployee.get(e.employeeId) ?? new Set<string>()
    set.add(localDateKey(e.clockIn, tz))
    entryDaysByEmployee.set(e.employeeId, set)
  }
  for (const s of shifts) {
    if (!SHIFT_EXPECTED_STATUSES.includes(s.status)) continue
    const day = localDateKey(s.shiftDate, tz)
    const days = entryDaysByEmployee.get(s.employeeId)
    if (!days || !days.has(day)) {
      out.push({
        code: 'SHIFT_NO_ENTRY',
        employeeName: s.Employee?.name ?? '',
        shiftId: s.id,
        detail: `Načrtovana izmena brez evidence (${day} ${s.startTime}–${s.endTime}).`,
      })
    }
  }

  return out
}

/* ─────────────────── 5) Agregacija (po zaposlenem + delovnem mestu) ─────────────────── */

export interface EmployeeJobAggregate {
  employeeId: string
  employeeName: string
  jobId: string | null
  jobName: string
  entryCount: number
  approvedCount: number
  /** neto minute — SAMO approved (plačilna osnova) */
  netMinutes: number
  /** bruto v centih — SAMO approved */
  grossCents: number
  /** minute po tipu vnosa — SAMO approved (plačilna osnova) */
  byType: Record<string, number>
  /** [min, max] postavke (centi) vseh vrstic skupine; null če ni vrstic */
  rateRangeCents: [number, number] | null
}

/**
 * Združevanje vrstic po (zaposleni, delovno mesto). entryCount/approvedCount
 * štejeta VSE vrstice; neto minute, bruto in byType samo APPROVED (plačilna
 * osnova — nepotrjeno ostaja vidno samo prek izjem). rateRangeCents zajame
 * vse vrstice (opozorilo o mešanju postavk ne glede na status).
 */
export function aggregateByEmployeeJob(rows: PayrollEntryRow[]): EmployeeJobAggregate[] {
  const map = new Map<string, EmployeeJobAggregate>()
  for (const r of rows) {
    const key = `${r.employeeId}|${r.jobId ?? ''}`
    const agg =
      map.get(key) ??
      ({
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        jobId: r.jobId,
        jobName: r.jobName,
        entryCount: 0,
        approvedCount: 0,
        netMinutes: 0,
        grossCents: 0,
        byType: {},
        rateRangeCents: [r.payRateCents, r.payRateCents],
      } satisfies EmployeeJobAggregate)
    agg.employeeName = r.employeeName || agg.employeeName
    agg.jobName = agg.jobName || r.jobName
    agg.entryCount += 1
    if (agg.rateRangeCents) {
      agg.rateRangeCents[0] = Math.min(agg.rateRangeCents[0], r.payRateCents)
      agg.rateRangeCents[1] = Math.max(agg.rateRangeCents[1], r.payRateCents)
    }
    if (r.status === 'approved') {
      agg.approvedCount += 1
      agg.netMinutes += r.netMinutes
      agg.grossCents += r.grossCents
      agg.byType[r.type] = (agg.byType[r.type] || 0) + r.netMinutes
    }
    map.set(key, agg)
  }
  return [...map.values()].sort(
    (a, b) => a.employeeName.localeCompare(b.employeeName) || a.jobName.localeCompare(b.jobName),
  )
}

export interface PlannedAggregate {
  employeeId: string
  employeeName: string
  shiftCount: number
  plannedMinutes: number
}

/** 'HH:MM' → minute dneva; neveljavna oblika → null. */
function parseHM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * Načrtovane minute iz izmen (dvojna kontrola: načrtovano vs dejansko).
 * Trajanje = endTime − startTime ('HH:MM' isti-dan niza; endTime ≤ startTime
 * pomeni prehod čez polnoč → +24 h) − odmor (min 0). Štejejo se statusi
 * ['confirmed','completed','in_progress','scheduled'] (no_show/cancelled ne).
 */
export function plannedMinutesFromShifts(shifts: ShiftInput[], _tz = 'Europe/Ljubljana'): PlannedAggregate[] {
  const map = new Map<string, PlannedAggregate>()
  for (const s of shifts) {
    if (!['confirmed', 'completed', 'in_progress', 'scheduled'].includes(s.status)) continue
    const start = parseHM(s.startTime)
    const end = parseHM(s.endTime)
    if (start === null || end === null) continue
    let duration = end - start
    if (duration <= 0) duration += 24 * 60 // prek polnoči
    duration = Math.max(0, duration - Math.max(0, Math.round(s.breakMinutes || 0)))
    const agg =
      map.get(s.employeeId) ??
      { employeeId: s.employeeId, employeeName: s.Employee?.name ?? '', shiftCount: 0, plannedMinutes: 0 }
    agg.employeeName = agg.employeeName || (s.Employee?.name ?? '')
    agg.shiftCount += 1
    agg.plannedMinutes += duration
    map.set(s.employeeId, agg)
  }
  return [...map.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName))
}

/* ─────────────────── 6) Izvozi (CSV / kanonični JSON / digesti) ─────────────────── */

// v1.192.0: /2 — aditivna sekcija DOPLACILNE OSNOVE (noč/nedelja/praznik po
// zaposlenem+delu, nadure po zaposlenem — čisti sloj payroll-surcharges.ts);
// obstoječe sekcije NESPREMENJENE (noga samo preformulirana — osnove zdaj
// izvožene, odstotki ostajajo zunanji). P3 #19 docs/TRZNA-VRZELI-2026.md.
// v1.197.0: /3 — N-27-3 (docs/TRZNA-VRZELI-2027.md): zneski doplačil OB
// minutah (NocEur/NedeljaEur/PraznikEur/NadureEur — ko so noge nastavljene;
// prazne kolone, ko niso) + noga izvoza zapiše uporabljene noge (uporabniški
// vhod po kolektivni pogodbi; zakonitost potrdi biro). Kolone so VEDNO
// prisotne (stabilna oblika za birove uvoze), vrednost = '' kadar noge ne
// obstajajo — izvoz NIKOLI ne trdi 0 € za neizračunan znesek.
export const EXPORT_SCHEMA_VERSION = 'payroll-export/3'

/** Tip distribucije napitnine v izvoznih gradnikih (PII: samo imena, ne naslovi). */
export interface TipExportRow {
  distributionId: string
  employeeId: string
  employeeName: string
  amountCents: number
  status: string
  poolId: string
  poolDate: string
  poolCashCents: number
  poolCardCents: number
}

/** CSV polje: narekovaji samo ob ; " \n \r; notranji " podvojen; null/undefined → ''. */
export function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** EUR iz centov z DECIMALNO VEJICO (slovenska konvencija, '12,34'). */
const eurCsv = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',')

/** Skupne vsote izvoza (iste v JSON in CSV — en vir). */
export interface PayrollTotals {
  entryCount: number
  approvedCount: number
  netMinutesApproved: number
  grossPayCents: number
  cashTipsCents: number
  cardTipsCents: number
  tipsPendingCents: number
  tipsPaidCents: number
}

export function totalsOfRows(rows: PayrollEntryRow[], tips: TipExportRow[], pools: { cashCents: number; cardCents: number }[]): PayrollTotals {
  const approved = rows.filter((r) => r.status === 'approved')
  return {
    entryCount: rows.length,
    approvedCount: approved.length,
    netMinutesApproved: approved.reduce((a, r) => a + r.netMinutes, 0),
    grossPayCents: approved.reduce((a, r) => a + r.grossCents, 0),
    cashTipsCents: pools.reduce((a, p) => a + p.cashCents, 0),
    cardTipsCents: pools.reduce((a, p) => a + p.cardCents, 0),
    tipsPendingCents: tips.filter((t) => t.status === 'pending').reduce((a, t) => a + t.amountCents, 0),
    tipsPaidCents: tips.filter((t) => t.status === 'paid').reduce((a, t) => a + t.amountCents, 0),
  }
}

export interface PayrollExportMeta {
  seq: number
  generatedISO: string
  contentHash8: string
  changedEntries: number
  identicalToPrevious: boolean
}

export interface PayrollCsvInput {
  period: {
    id: string
    locationId: string | null
    startISO: string
    endISO: string
    timezone: string
    status: string
    version: number
    closeNote: string
  }
  rows: PayrollEntryRow[]
  tips: TipExportRow[]
  totals: PayrollTotals
  /** P3 #19 (v1.192.0) — doplačilne osnove (noč/nedelja/praznik/nadure) */
  surchargeBases: SurchargeBases
  /** N-27-3 (v1.197.0) — noge doplačil uporabljene pri izračunu zneskov
   * (null = noge niso nastavljene — Eur kolone prazne); del contentHasha. */
  surchargeRates?: SurchargeRates | null
  exportMeta: PayrollExportMeta
}

/**
 * CSV izvoz obračuna (pripravljeno za slovenske CSV/Excel uvoze računovodskih
 * sistemov): '\uFEFF' BOM + '\r\n' + ločilo ';'. Vse vrstice vnosov (status
 * nosi potrditev — samo approved sešteva v SKUPAJ), povzetek po zaposlenem in
 * delovnem mestu (samo approved — plačilna osnova), napitnine (distribucije +
 * bazeni), DOPLAČILNE OSNOVE (v1.192.0 — minute noč/nedelja/praznik po
 * zaposlenem+delu, nadure po zaposlenem; odstotke potrdi biro), SKUPAJ + nogo
 * z omejitvami.
 */
export function buildPayrollCsv(input: PayrollCsvInput): string {
  const { period, rows, tips, totals, surchargeBases, surchargeRates, exportMeta } = input
  const L: string[] = []

  // N-27-3: zneskovna celica — undefined (noge niso nastavljene) → PRAZNA
  // kolona (izvoz ne trdi 0 € za neizračunan znesek); sicer EUR z vejico.
  const eurCell = (cents?: number): string => (cents === undefined ? '' : eurCsv(cents))
  const ratesOn = surchargeRates != null
  const sumOf = (pick: (b: (typeof surchargeBases.perEmployeeJob)[number]) => number | undefined): number | undefined => {
    if (!ratesOn) return undefined
    return surchargeBases.perEmployeeJob.reduce((a, b) => a + (pick(b) ?? 0), 0)
  }

  // ── 1) glava/meta ──
  L.push(`OBRAČUN PLAČ - RestaurantOS`)
  L.push(`Obdobje;${period.startISO};${period.endISO}`)
  L.push(`Lokacija;${csvField(period.locationId)}`)
  L.push(`ObdobjeID;${period.id};Razlicica;${period.version}`)
  L.push(`Izvoz;${exportMeta.seq};Ustvarjeno;${exportMeta.generatedISO};Shema;${EXPORT_SCHEMA_VERSION}`)
  L.push(`SpremenjeneVrstice;${exportMeta.changedEntries};EnakoKotPrej;${exportMeta.identicalToPrevious ? 'DA' : 'NE'}`)
  if (period.closeNote) L.push(`OpombaZaklepa;${csvField(period.closeNote)}`)
  L.push('')

  // ── 2) vnosi (VSI — status nosi stanje potrditve) ──
  L.push(`VNOSI DELAVNEGA ČASA`)
  L.push(`ZaposleniID;Zaposleni;DeloID;Delo;Datum;Prihod;Odhod;OdmorMin;NetoMin;PostavkaEUR;BrutoEUR;Tip;Status;VnosID`)
  const sortedRows = [...rows].sort(
    (a, b) =>
      a.employeeName.localeCompare(b.employeeName) ||
      a.date.localeCompare(b.date) ||
      a.entryId.localeCompare(b.entryId),
  )
  for (const r of sortedRows) {
    L.push(
      [
        csvField(r.employeeId),
        csvField(r.employeeName),
        csvField(r.jobId),
        csvField(r.jobName),
        r.date,
        r.clockIn,
        r.clockOut ?? '',
        r.breakMinutes,
        r.netMinutes,
        eurCsv(r.payRateCents),
        eurCsv(r.grossCents),
        csvField(r.type),
        csvField(r.status),
        csvField(r.entryId),
      ].join(';'),
    )
  }
  L.push(`SKUPAJ;Vnosi;${totals.entryCount};Potrjeni;${totals.approvedCount};NetoMin;${totals.netMinutesApproved};BrutoEUR;${eurCsv(totals.grossPayCents)}`)
  L.push('')

  // ── 3) povzetek po zaposlenem + delovnem mestu (plačilna osnova — samo approved) ──
  L.push(`POVPZETEK PO ZAPOSLENEM IN DELOVNEM MESTU (samo potrjeno)`)
  L.push(`ZaposleniID;Zaposleni;DeloID;Delo;NetoMin;BrutoEUR;StatusPotrditve`)
  for (const a of aggregateByEmployeeJob(sortedRows).filter((a) => a.approvedCount > 0)) {
    L.push(
      [
        csvField(a.employeeId),
        csvField(a.employeeName),
        csvField(a.jobId),
        csvField(a.jobName),
        a.netMinutes,
        eurCsv(a.grossCents),
        'approved',
      ].join(';'),
    )
  }
  L.push('')

  // ── 4) napitnine (distribucije po zaposlenih + bazeni po dnevih) ──
  L.push(`NAPITNINE`)
  L.push(`ZaposleniID;Zaposleni;NapitnineEUR;Status`)
  for (const t of [...tips].sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.distributionId.localeCompare(b.distributionId))) {
    L.push([csvField(t.employeeId), csvField(t.employeeName), eurCsv(t.amountCents), csvField(t.status)].join(';'))
  }
  L.push('')
  L.push(`BAZENI NAPITNIN`)
  L.push(`PoolID;Datum;GotovinaEUR;KarticaEUR`)
  const poolSeen = new Set<string>()
  for (const t of tips) {
    if (poolSeen.has(t.poolId)) continue
    poolSeen.add(t.poolId)
    L.push([t.poolId, t.poolDate, eurCsv(t.poolCashCents), eurCsv(t.poolCardCents)].join(';'))
  }
  L.push(`SKUPAJ;Napitnine;PendingEUR;${eurCsv(totals.tipsPendingCents)};PlacanoEUR;${eurCsv(totals.tipsPaidCents)};GotovinaEUR;${eurCsv(totals.cashTipsCents)};KarticaEUR;${eurCsv(totals.cardTipsCents)}`)
  L.push('')

  // ── 5) SKUPAJ ──
  L.push(`SKUPAJ OBRAČUNA`)
  L.push(`NetoMin (potrjeno);${totals.netMinutesApproved}`)
  L.push(`BrutoEUR (potrjeno);${eurCsv(totals.grossPayCents)}`)
  L.push(`NapitninePendingEUR;${eurCsv(totals.tipsPendingCents)}`)
  L.push(`NapitninePlacanoEUR;${eurCsv(totals.tipsPaidCents)}`)
  L.push('')

  // ── 5.5) doplačilne osnove (P3 #19 v1.192.0 minute; N-27-3 v1.197.0 zneski
  //    ob minutah, ko so noge nastavljene — kolone VEDNO prisotne, vrednost
  //    prazna kadar noge ne obstajajo) ──
  L.push(`DOPLACILNE OSNOVE (minute + zneski, ko so noge nastavljene - odstotek potrdi zunanji payroll sistem)`)
  L.push(`Noc/Nedelja/Praznik po zaposlenem in delovnem mestu (pred odmorom)`)
  L.push(`ZaposleniID;Zaposleni;DeloID;Delo;NocMin;NocEur;NedeljaMin;NedeljaEur;PraznikMin;PraznikEur;PotrjenoNetoMin`)
  for (const b of surchargeBases.perEmployeeJob) {
    L.push(
      [
        csvField(b.employeeId),
        csvField(b.employeeName),
        csvField(b.jobId),
        csvField(b.jobName),
        b.nightMinutes,
        eurCell(b.nightAmtCents),
        b.sundayMinutes,
        eurCell(b.sundayAmtCents),
        b.holidayMinutes,
        eurCell(b.holidayAmtCents),
        b.approvedMinutes,
      ].join(';'),
    )
  }
  const totN = surchargeBases.perEmployeeJob.reduce((a, b) => a + b.nightMinutes, 0)
  const totS = surchargeBases.perEmployeeJob.reduce((a, b) => a + b.sundayMinutes, 0)
  const totH = surchargeBases.perEmployeeJob.reduce((a, b) => a + b.holidayMinutes, 0)
  L.push(
    `SKUPAJ;NocMin;${totN};NocEur;${eurCell(sumOf((b) => b.nightAmtCents))};NedeljaMin;${totS};NedeljaEur;${eurCell(sumOf((b) => b.sundayAmtCents))};PraznikMin;${totH};PraznikEur;${eurCell(sumOf((b) => b.holidayAmtCents))}`,
  )
  L.push(`Nadure po zaposlenem (dnevni presezek NETO minut nad pragom; po dnevu prijave)`)
  L.push(`ZaposleniID;Zaposleni;NadureMin;NadureEur;DneviNadPragom`)
  for (const o of surchargeBases.overtime) {
    L.push([csvField(o.employeeId), csvField(o.employeeName), o.overtimeBasisMinutes, eurCell(o.overtimeAmtCents), o.daysOverThreshold].join(';'))
  }
  L.push('')

  // ── 6) noga (meje odgovornosti + kontrolni hash) ──
  L.push(`Napitnine pending se ne stejejo kot izplacane.`)
  if (ratesOn) {
    L.push(
      `Noge (uporabniski vhod po kolektivni pogodbi);Noc=${pctCsv(surchargeRates.nightPct)};Nedelja=${pctCsv(surchargeRates.sundayPct)};Praznik=${pctCsv(surchargeRates.holidayPct)};Nadure=${pctCsv(surchargeRates.overtimePct)};Zakonitost nog potrdi zunanji payroll sistem.`,
    )
  } else {
    L.push(`RestaurantOS ne izracunava odstotkov doplacil (noge niso nastavljene) - izvaza samo osnovne minute; odstotek potrdi zunanji payroll sistem.`)
  }
  L.push(`KontrolniHash;${exportMeta.contentHash8}`)

  return '\uFEFF' + L.join('\r\n')
}

/* ── kanonični JSON (stabilna osnova contentHash) ── */

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/**
 * Kanonični JSON izvoza: rekurzivno SORTIRANI ključi (stabilna hash osnova —
 * vrstni red polj ne vpliva na contentHash). Števila ostanejo števila (centi
 * kot integer), datumi/ISO kot nizi. IZHOD IZKLJUČI exportMeta (generatedISO/
 * seq so zapis vsakega izvoza, ne vsebine).
 */
export function canonicalExportJson(input: Omit<PayrollCsvInput, 'exportMeta'>): string {
  return JSON.stringify(sortKeysDeep(input))
}

/**
 * Minimalni digest vrstic (BREZ PII — samo ID + minute + centi + status):
 * `entryId:netMinutes:grossCents:status` + `distributionId:amountCents:status`,
 * združeni s ';'. Primerjava različic (diffRowDigest) brez shranjevanja vsebine.
 */
export function rowDigestOf(rows: PayrollEntryRow[], tips: TipExportRow[]): string {
  const parts: string[] = []
  for (const r of [...rows].sort((a, b) => a.entryId.localeCompare(b.entryId))) {
    parts.push(`${r.entryId}:${r.netMinutes}:${r.grossCents}:${r.status}`)
  }
  for (const t of [...tips].sort((a, b) => a.distributionId.localeCompare(b.distributionId))) {
    parts.push(`${t.distributionId}:${t.amountCents}:${t.status}`)
  }
  return parts.join(';')
}

/**
 * Set razlika digestov: število členov v next, ki jih ni v prev, plus členi v
 * prev, ki jih ni v next (simetrična razlika na množici). 0 = vrstice so
 * vsebinsko identične (spremembe, ki ne spreminijo minute/centov/statusa, se
 * ne štejejo — ceno vsebine pokriva contentHash).
 */
export function diffRowDigest(prev: string, next: string): number {
  const prevSet = new Set(prev.split(';').filter((s) => s !== ''))
  const nextSet = new Set(next.split(';').filter((s) => s !== ''))
  let changed = 0
  for (const item of nextSet) if (!prevSet.has(item)) changed += 1
  for (const item of prevSet) if (!nextSet.has(item)) changed += 1
  return changed
}

/* ─────────────────── 7) DTO perioda (skupni izhod API rut) ─────────────────── */

/** Vhodna oblika vrstice PayrollPeriod (Prisma vrstica ali testni objekt). */
export interface PayrollPeriodRow {
  id: string
  locationId: string | null
  periodStart: Date
  periodEnd: Date
  timezone: string
  status: string
  closedAt: Date | null
  closedById: string | null
  closeNote: string
  reopenCount: number
  version: number
  entryCount: number
  approvedCount: number
  exceptionCount: number
  netMinutesApproved: number
  grossPayCents: number
  cashTipsCents: number
  cardTipsCents: number
  tipsPendingCents: number
  tipsPaidCents: number
}

/** DTO PayrollPeriod za vse /api/payroll* odgovore (ISO datumi + lokalna ISO meji). */
export function periodDto(p: PayrollPeriodRow): {
  id: string
  locationId: string | null
  periodStart: string
  periodEnd: string
  startISO: string
  endISO: string
  timezone: string
  status: string
  closedAt: string | null
  closedById: string | null
  closeNote: string
  reopenCount: number
  version: number
  entryCount: number
  approvedCount: number
  exceptionCount: number
  netMinutesApproved: number
  grossPayCents: number
  cashTipsCents: number
  cardTipsCents: number
  tipsPendingCents: number
  tipsPaidCents: number
} {
  return {
    id: p.id,
    locationId: p.locationId,
    periodStart: p.periodStart.toISOString(),
    periodEnd: p.periodEnd.toISOString(),
    startISO: localDateKey(p.periodStart, p.timezone),
    // periodEnd je EKSKLUZIVEN — zadnji dan obdobja je 1 ms pred njim
    endISO: localDateKey(new Date(p.periodEnd.getTime() - 1), p.timezone),
    timezone: p.timezone,
    status: p.status,
    closedAt: p.closedAt ? p.closedAt.toISOString() : null,
    closedById: p.closedById,
    closeNote: p.closeNote,
    reopenCount: p.reopenCount,
    version: p.version,
    entryCount: p.entryCount,
    approvedCount: p.approvedCount,
    exceptionCount: p.exceptionCount,
    netMinutesApproved: p.netMinutesApproved,
    grossPayCents: p.grossPayCents,
    cashTipsCents: p.cashTipsCents,
    cardTipsCents: p.cardTipsCents,
    tipsPendingCents: p.tipsPendingCents,
    tipsPaidCents: p.tipsPaidCents,
  }
}

/** Povzetek izjem po kodi (števci za 409 zaklep in JSON izvoz). */
export function exceptionsSummary(exceptions: PayrollException[]): Record<PayrollExceptionCode, number> {
  const out = {} as Record<PayrollExceptionCode, number>
  for (const e of exceptions) out[e.code] = (out[e.code] || 0) + 1
  return out
}
