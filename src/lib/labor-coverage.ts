/**
 * Issue #10 (P2, v1.117.0) — strošek dela in napoved pokritosti izmen glede na
 * prodajo (brez AI): ČISTA logika (0 DB/IO uvozov).
 *
 * Kanonični tok (10-design): poročilo pokritosti je ČIST izračun nad obstoječo
 * evidenco (Order/TimeEntry/StaffShift/EmployeeJob/Job/Location) — BREZ novih
 * tabel/stolpcev. API rute (/api/reports/labor-coverage + export sekcija
 * 'labor-coverage') naložita podatke s SKUPNIM loaderjem
 * (src/lib/labor-coverage-data.ts — isti obračun za UI in izvoz) in ju podata
 * tej funkciji:
 *  - dnevi po LOKALNEM datumskem ključu po Location.timezone (vsaka lokacija
 *    svoja cona; združitev po dateKey; mešane valute → zastavica),
 *  - overnight razcep TimeEntry [clockIn, clockOut || now) po lokalnih polnočeh
 *    (localMidnightUtc) in lokalnih urnih mejah — proporcionalno minute/strošek;
 *    zadnji člen razcepa je OSTANEK, zato VSOTA razcepljenih minut ≡ totalMinutes
 *    in vsota razcepljenih centov ≡ plačilo vnosa (invarianta),
 *  - odprti vnosi: živi delež (clockOut = now — labor-cost precedens) + števec,
 *  - načrtovane minute iz StaffShift (payroll plannedMinutesFromShifts pravilo:
 *    endTime ≤ startTime → +24 h, − odmor, min 0) na dan ZAČETKA izmene,
 *  - postavka izmene: veriga EmployeeJob (employeeId+jobId) → primarna
 *    dodelitev → Job.basePayRate → BREZ (0 centov + source 'none' — nikoli
 *    tiho: klicalna koda šteje incomplete),
 *  - deterministična napoved: povprečje neto prodaje ISTEGA dneva tedna
 *    (forecastQty vzorec iz batch.ts; dnevi z 0 naročili so zaprti dnevi,
 *    NE v povprečju) + pokritost prihodnjih izmen s pasovi low/ok/warn/alarm,
 *  - podatkovna kakovost: števci open/rate-zero/overlap/unapproved/
 *    missing-rate-shifts/mixed-currencies/no-sales (FcDataQuality vzorec —
 *    razlogi so KODE, preslikavo v lcov.dq.* naredi UI).
 *
 * Konvencije (zrcalo payroll.ts / labor-cost.ts):
 *  - vsi denarni zneski so CELIŠTEVILČNI centi (Int); EUR = cents/100;
 *    urna postavka €/h → centi/h (payRateToCents konvencija iz timeclock),
 *  - okno = lokalni datumski ključi 'YYYY-MM-DD' (from..to vključno),
 *    vsak dan serije obstaja (zero-filled), razvrščeno naraščajoče,
 *  - dow = 1 (ponedeljek) .. 7 (nedelja) — ISO vrstni red,
 *  - DETERMINIZEM: izhod je ČISTA funkcija vhodov — Date.now() NE obstaja tukaj;
 *    `now` za proracijo odprtih vnosov poda klicalna koda (ruta VEDNO new Date(),
 *    testi fiksni instant; brez njega odprti vnosi prispevajo 0 minut, a ostanejo
 *    šteti v openEntries — `generatedAt` doda izključno ruta).
 */

import { num, r2 } from '@/lib/map'
import { localDateKey, localMidnightUtc } from '@/lib/payroll'

/* ─────────────────── 1) Konstante (poslovne tarče, NE zakonske) ─────────────────── */

/**
 * Ciljni delež stroška dela v neto prodaji (%). POSLOVNA tarča
 * (Lightspeed/Toast referenčni pas) in NE zakonska meja — zrcalo
 * LABOR_TARGET_PCT v /api/reports/labor-cost (OPS-10 val 1) ter CSV noge
 * izvoza obračuna plač (issue #22). Ista številka = isti prikaz povsod.
 */
export const LCOV_TARGET_PCT = 32
/** Opozorilni pas (%): nad to vrednostjo je pokritost kritično draga (alarm). */
export const LCOV_WARN_PCT = 38
/** Nizki pas (%): pod to vrednostjo je pokritost sumljivo nizka (low). */
export const LCOV_LOW_PCT = 20
/** Največje okno analize (dni, vključno) — guard rute/loaderja (privzeto 28). */
export const LCOV_MAX_DAYS = 90
/** Obseg deterministične napovedi (dni od to+1). */
export const LCOV_FORECAST_DAYS = 7

/** Zgodovinske izmene (plannedMinutesFromShifts nabor — absent/no_show/cancelled ne). */
export const SHIFT_HISTORY_STATUSES = ['scheduled', 'confirmed', 'in_progress', 'completed'] as const
/** Napovedne izmene (samo še načrtovane — completed je že zgodovina). */
export const SHIFT_FORECAST_STATUSES = ['scheduled', 'confirmed', 'in_progress'] as const

/* ─────────────────── 2) Vhodni tipi (PODATKOVNO-neodvisni) ─────────────────── */

/** Plačano naročilo (Order: paymentStatus='paid'; neto = subtotal − discount). */
export interface OrderInput {
  id: string
  paidAt: Date
  subtotal: number
  discount: number
  locationId: string
}

/** Vnos delovnega časa (TimeEntry; clockOut null = ODPRT — živi delež do `now`). */
export interface EntryInput {
  id: string
  employeeId: string
  jobId?: string | null
  clockIn: Date
  clockOut?: Date | null
  breakMinutes: number
  totalMinutes: number
  payRate: number
  totalPay: number
  type: string
  status: string
  locationId?: string | null
}

/** Načrtovana izmena (StaffShift; startTime/endTime 'HH:MM' lokalno). */
export interface ShiftInput {
  id: string
  employeeId: string
  jobId?: string | null
  shiftDate: Date
  startTime: string
  endTime: string
  breakMinutes: number
  status: string
  locationId?: string | null
}

/** Postavka zaposlenega za delo (EmployeeJob; payRate €/h → centi/h). */
export interface JobRate {
  jobId: string
  employeeId: string
  payRateCents: number
  isPrimary: boolean
}

/** Delovno mesto (Job — GLOBALEN; basePayRate €/h → centi/h). */
export interface JobBase {
  jobId: string
  name: string
  basePayRateCents: number
}

/** Lokacija s cono (Location.timezone) in valuto (mixed → zastavica). */
export interface LocationTz {
  id: string
  timezone: string
  currency: string
}

/** Celotni vhod poročila — napolni ga loader (rute/testi). */
export interface LaborCoverageInput {
  from: string
  to: string
  /**
   * Živi trenutek za proracijo ODPRTIH vnosov (labor-cost precedens).
   * Ruta VEDNO poda new Date(); testi fiksni instant (determinizem).
   * Brez njega odprti vnosi prispevajo 0 minut/stroška — števec openEntries
   * jih vseeno šteje (nikoli tiho).
   */
  now?: Date
  locations: LocationTz[]
  orders: OrderInput[]
  entries: EntryInput[]
  shifts: ShiftInput[]
  employeeJobs: JobRate[]
  jobs: JobBase[]
  /** Echo filtra (vnosi/izmene so že pre-filtrirane v loaderju). */
  jobId?: string | null
}

/* ─────────────────── 3) Izhodni tipi ─────────────────── */

export interface LaborCoverageDay {
  date: string
  /** 1=ponedeljek .. 7=nedelja */
  dow: number
  netSalesCents: number
  orders: number
  plannedMinutes: number
  plannedCostCents: number
  plannedIncomplete: number
  actualMinutes: number
  actualCostCents: number
  openEntries: number
  unapproved: number
  rateZero: number
  overtimeMinutes: number
  varianceMinutes: number
  /** actualCost / netSales × 100; null če netSales ≤ 0 (nikoli ∞/0) */
  laborPct: number | null
  /** neto prodaja na delovno uro (centi); null če 0 delovnih ur */
  sphCents: number | null
  /** dejanski strošek na naročilo (centi); null če 0 naročil */
  costPerOrderCents: number | null
}

export interface LaborCoverageHourCell {
  dow: number
  hour: number
  netSalesCents: number
  orders: number
  laborMinutes: number
  /** povprečno št. SOČASNO aktivnih vnosov v (dow, hour) čez dneve z ≥1 vnosom */
  staffOn: number
}

export interface LaborCoverageRoleRow {
  /** null jobId → vrstica '—' (vnos/izmena brez vloge) */
  jobId: string | null
  name: string
  plannedMinutes: number
  plannedCostCents: number
  actualMinutes: number
  actualCostCents: number
}

export interface LaborCoverageTotals {
  netSalesCents: number
  orders: number
  plannedMinutes: number
  plannedCostCents: number
  actualMinutes: number
  actualCostCents: number
  laborPct: number | null
  sphCents: number | null
  costPerOrderCents: number | null
  varianceMinutes: number
  overtimeMinutes: number
}

export interface LaborCoverageDataQuality {
  incompleteData: boolean
  /** kode razlogov: 'open-entries'|'rate-zero'|'overlap'|'unapproved'|'missing-rate-shifts'|'mixed-currencies'|'no-sales' */
  reasons: string[]
  openEntries: number
  rateZero: number
  overlapPairs: number
  unapproved: number
  missingRateShifts: number
  /** 0 = ena valuta; >1 = mešane (število različnih valut, ne tiho seštevanje) */
  mixedCurrencies: number
}

export interface LaborCoverageForecastDay {
  date: string
  dow: number
  /** round(povprečje neto prodaje istega dneva tedna); null če ni vzorcev — NIČ izmišljenega */
  expectedNetSalesCents: number | null
  minCents: number | null
  maxCents: number | null
  sampleCount: number
  /** dnevi z 0 naročili istega dneva tedna (ločeno, NE v povprečju) */
  closedDays: number
  confidence: 'low' | 'ok'
}

export interface LaborCoverageCoverageDay {
  date: string
  dow: number
  shiftCount: number
  plannedMinutes: number
  plannedCostCents: number
  /** delež izmen BREZ postavke (0..1, r2) */
  incompleteRate: number
  expectedNetSalesCents: number | null
  /** plannedCost / expectedSales × 100; null če ni ocene prodaje (≤ 0) */
  expectedPct: number | null
  /** null če ni ocene prodaje (ni osnove za presojo); sicer pas glede na konstante */
  flag: 'low' | 'ok' | 'warn' | 'alarm' | null
  /** 0 za napoved (nadure so zgolj pretekli dejanski podatek — informativno) */
  overtimeMinutes: number
  /** pari prekrivajočih se izmen ISTEGA zaposlenega tisti dan (informativno) */
  overlaps: number
  /** izmene z breakMinutes = 0 in trajanjem > 8 h (informativno, ne zakonsko) */
  longNoBreak: number
}

export interface LaborCoverageReport {
  parameters: {
    from: string
    to: string
    locationIds: string[]
    jobId: string | null
    targetPct: number
    warnPct: number
    lowPct: number
    forecastDays: number
    currencies: string[]
    /** zgodovinski dnevi z ≥ 1 naročilom (vzorčna osnova napovedi) */
    sampleDays: number
    /** zgodovinski dnevi z 0 naročili (zaprti — ločeno od povprečja) */
    closedDays: number
    counts: { orders: number; entries: number; shifts: number }
  }
  days: LaborCoverageDay[]
  hours: LaborCoverageHourCell[]
  roles: LaborCoverageRoleRow[]
  totals: LaborCoverageTotals
  dataQuality: LaborCoverageDataQuality
  forecast: {
    method: 'same-weekday-average'
    days: LaborCoverageForecastDay[]
    coverage: LaborCoverageCoverageDay[]
  }
}

/* ─────────────────── 4) Časi/terminska aritmetika (lokalni, DST-varna) ─────────────────── */

const HOUR_MS = 3600 * 1000

/**
 * Odmik časovnega pasu (ms) za dan instant — zrcalo interne (neizvožene)
 * logike payroll.ts: formatToParts, zaokroženo na celo minuto.
 */
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
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, (p.hour ?? 0) % 24, p.minute ?? 0, p.second ?? 0)
  return Math.round((asUTC - d.getTime()) / 60000) * 60000
}

/** Lokalna ura (0–23) instanta v tz — hour '24' (starejši Node) → 0. */
function localHourOf(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).formatToParts(d)
  const h = parts.find((part) => part.type === 'hour')?.value ?? '0'
  return Number(h) % 24
}

/**
 * Naslednja LOKALNA urna meja (stenska ura HH:00) po instantu t — 3-iteracijska
 * konvergenca iz odmika (localMidnightUtc vzorec; upošteva prehode DST).
 * Varovalka: rezultat je VEDNO > t (sicer bi zanka razcepa obtičala).
 */
function nextLocalHourBoundaryMs(t: number, tz: string): number {
  const off = tzOffsetMs(new Date(t), tz)
  const wall = t + off // stenska ura kot UTC-ms (približek)
  const targetWall = Math.floor(wall / HOUR_MS) * HOUR_MS + HOUR_MS
  let inst = targetWall - off
  for (let i = 0; i < 3; i++) inst = targetWall - tzOffsetMs(new Date(inst), tz)
  return inst > t ? inst : t + HOUR_MS
}

/** Veljaven ISO datum (YYYY-MM-DD, round-trip po UTC delih — payroll isSanityISO vzorec). */
function isSanityISO(dateISO: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return false
  const [y, m, d] = String(dateISO).split('-').map((v) => Number(v))
  const utc = new Date(Date.UTC(y, m - 1, d))
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d
}

/** Dan + N (koledarska aritmetika na ISO delih — NIKOLI ±24h, DST pusti pri miru). */
function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = String(dateISO).split('-').map((v) => Number(v))
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** Dnevi okna [from, to] vključno (naraščajoče; neveljavni ISO → []). */
function dateRange(fromISO: string, toISO: string): string[] {
  if (!isSanityISO(fromISO) || !isSanityISO(toISO)) return []
  const out: string[] = []
  let cur = String(fromISO)
  let guard = 0
  while (cur <= String(toISO) && guard++ < 4000) {
    out.push(cur)
    cur = addDaysISO(cur, 1)
  }
  return out
}

/** ISO dan tedna: 1=ponedeljek .. 7=nedelja. */
function dowOf(dateKey: string): number {
  const [y, m, d] = String(dateKey).split('-').map((v) => Number(v))
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=nedelja
  return ((js + 6) % 7) + 1
}

/** 'HH:MM' → minute od polnoči; neveljavno → null (payroll parseHM vzorec). */
function parseHM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/* ─────────────────── 5) Urna postavka izmene (veriga) ─────────────────── */

export type ShiftRateSource = 'employee-job-exact' | 'employee-job-primary' | 'job-base' | 'none'

export interface ShiftRateResolution {
  cents: number
  source: ShiftRateSource
}

/**
 * Veriga postavke za izmeno: EmployeeJob (employeeId+jobId) → primarna
 * dodelitev istega zaposlenega → Job.basePayRate → BREZ.
 * Postavka 0 na katerem koli členu se šteje kot MANJKAJČA (veriga nadaljuje);
 * 'none' = 0 centov + izrecen source — minute se štejejo, strošek se ZASTAVI
 * (klicalna koda šteje plannedIncomplete / missingRateShifts — nikoli tiho 0 €).
 */
export function resolveShiftRateCents(
  shift: ShiftInput,
  employeeJobs: JobRate[],
  jobs: JobBase[],
): ShiftRateResolution {
  if (shift.jobId) {
    const exact = employeeJobs.find((j) => j.employeeId === shift.employeeId && j.jobId === shift.jobId)
    if (exact && exact.payRateCents > 0) return { cents: exact.payRateCents, source: 'employee-job-exact' }
  }
  const primary = employeeJobs.find((j) => j.employeeId === shift.employeeId && j.isPrimary)
  if (primary && primary.payRateCents > 0) return { cents: primary.payRateCents, source: 'employee-job-primary' }
  if (shift.jobId) {
    const base = jobs.find((j) => j.jobId === shift.jobId)
    if (base && base.basePayRateCents > 0) return { cents: base.basePayRateCents, source: 'job-base' }
  }
  return { cents: 0, source: 'none' }
}

/* ─────────────────── 6) Overnight razcep vnosa po lokalnih dneh/urah ─────────────────── */

interface EntryChunk {
  dateKey: string
  hour: number
  minutes: number
  costCents: number
}

/**
 * Razcep [clockIn, out) na LOKALNE dne (polnoči — localMidnightUtc) in urne
 * koščke; minute = delež koščka × totalMinutes (labor-cost proporcionalna
 * konvencija), strošek = delež × payCents. Zadnji člen je OSTANEK, zato velja
 * INVARIANTA: Σ minut vseh koščkov ≡ totalMinutes in Σ centov ≡ payCents.
 */
function splitEntryChunks(clockIn: Date, out: Date, totalMinutes: number, payCents: number, tz: string): EntryChunk[] {
  const totalMs = out.getTime() - clockIn.getTime()
  if (!(totalMs > 0) || !(totalMinutes > 0)) return []

  const segs: Array<{ dateKey: string; hour: number; ms: number }> = []
  const end = out.getTime()
  let cursor = clockIn.getTime()
  let guard = 0
  while (cursor < end) {
    if (guard++ > 8784) {
      // varovalka: >1 leto urnih meja = garbage vhod → ostanek prilepi zadnjemu
      const ms = end - cursor
      if (segs.length > 0) segs[segs.length - 1].ms += ms
      else segs.push({ dateKey: localDateKey(new Date(cursor), tz), hour: localHourOf(new Date(cursor), tz), ms })
      break
    }
    const key = localDateKey(new Date(cursor), tz)
    const dayEnd = localMidnightUtc(addDaysISO(key, 1), tz).getTime()
    const segEnd = Math.min(dayEnd, end)
    let c = cursor
    while (c < segEnd) {
      const hb = nextLocalHourBoundaryMs(c, tz)
      const ce = Math.min(Math.max(hb, c + 1), segEnd)
      segs.push({ dateKey: key, hour: localHourOf(new Date(c), tz), ms: ce - c })
      c = ce
    }
    cursor = segEnd
  }

  const chunks: EntryChunk[] = []
  let minLeft = totalMinutes
  let centsLeft = payCents
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1
    const share = segs[i].ms / totalMs
    // floor za vse razen zadnjega: Σ floor ≤ payCents → ostanek ≥ 0 (invarianta)
    const minutes = last ? Math.max(0, minLeft) : totalMinutes * share
    const cents = last ? Math.max(0, centsLeft) : Math.floor(payCents * share)
    minLeft -= minutes
    centsLeft -= cents
    chunks.push({ dateKey: segs[i].dateKey, hour: segs[i].hour, minutes, costCents: cents })
  }
  return chunks
}

/* ─────────────────── 7) Trajanje izmene + prekrivanja ─────────────────── */

/**
 * Trajanje izmene v minutah (NETO): endTime ≤ startTime → +24 h (čez polnoč),
 * − breakMinutes, min 0 — plannedMinutesFromShifts pravilo. Neveljaven HH:MM
 * ali neveljaven datum → null (izmena se preskoči, kot v payroll).
 */
export function shiftDurationMinutes(s: ShiftInput): number | null {
  if (!(s.shiftDate instanceof Date) || Number.isNaN(s.shiftDate.getTime())) return null
  const start = parseHM(s.startTime)
  const end = parseHM(s.endTime)
  if (start === null || end === null) return null
  let duration = end - start
  if (duration <= 0) duration += 24 * 60
  return Math.max(0, duration - Math.max(0, Math.round(num(s.breakMinutes) || 0)))
}

/** Bruto trajanje (NETO + odmor) — za zaznavanje prekrivanja izmen. */
function shiftGrossMinutes(s: ShiftInput): number | null {
  const start = parseHM(s.startTime)
  const end = parseHM(s.endTime)
  if (start === null || end === null) return null
  let duration = end - start
  if (duration <= 0) duration += 24 * 60
  return duration
}

/** Število parov [start, end) intervalov, ki se prekrivajo (isti zaposleni). */
function countOverlapPairs(intervals: Array<[number, number]>): number {
  if (intervals.length < 2) return 0
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const ends: number[] = [] // konci prejšnjih, urejeni
  let pairs = 0
  for (const [start, end] of sorted) {
    // štej prejšnje i z end_i > start (presek [start_i, min(end_i, end)))
    let lo = 0
    let hi = ends.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ends[mid] > start) hi = mid
      else lo = mid + 1
    }
    pairs += ends.length - lo
    // vstavi end urejeno
    let p = 0
    let q = ends.length
    while (p < q) {
      const mid = (p + q) >> 1
      if (ends[mid] < end) p = mid + 1
      else q = mid
    }
    ends.splice(p, 0, end)
  }
  return pairs
}

/** Pari prekrivajočih se vnosov ISTEGA zaposlenega ([in, out) presek) — števec, vnosi OSTANEJO. */
function countEntryOverlaps(entries: EntryInput[], nowMs: number | null): number {
  const byEmp = new Map<string, Array<[number, number]>>()
  for (const e of entries) {
    if (!(e.clockIn instanceof Date) || Number.isNaN(e.clockIn.getTime())) continue
    const inMs = e.clockIn.getTime()
    const out = e.clockOut instanceof Date && !Number.isNaN(e.clockOut.getTime()) ? e.clockOut.getTime() : nowMs
    if (out === null || !(out > inMs)) continue
    const list = byEmp.get(e.employeeId)
    if (list) list.push([inMs, out])
    else byEmp.set(e.employeeId, [[inMs, out]])
  }
  let pairs = 0
  for (const list of byEmp.values()) pairs += countOverlapPairs(list)
  return pairs
}

/* ─────────────────── 8) Razni pomožniki ─────────────────── */

/** Labor % (0–100, r2); null, kadar ni osnove (netSales ≤ 0) — nikoli ∞/0. */
function pctOf(costCents: number, netSalesCents: number): number | null {
  if (!(netSalesCents > 0)) return null
  return r2((Math.max(0, costCents) / netSalesCents) * 100)
}

/**
 * Pas pokritosti: alarm > warn > low > ok; null (ni ocene prodaje) → null
 * (nevtralno — brez osnove ni presoje).
 */
export function coverageFlag(pct: number | null): 'low' | 'ok' | 'warn' | 'alarm' | null {
  if (pct === null || !Number.isFinite(pct)) return null
  if (pct > LCOV_WARN_PCT) return 'alarm'
  if (pct > LCOV_TARGET_PCT) return 'warn'
  if (pct < LCOV_LOW_PCT) return 'low'
  return 'ok'
}

/** Dana noča matrika [dow 1..7][hour 0..23]. */
const hourKey = (dow: number, hour: number): string => `${dow}|${hour}`

interface DayAgg {
  netSalesCents: number
  orders: number
  plannedMinutes: number
  plannedCostCents: number
  plannedIncomplete: number
  actualMinutes: number // float (proporcionalni razcep), r2 ob izpisu
  actualCostCents: number
  openEntries: number
  unapproved: number
  rateZero: number
  overtimeMinutes: number // float, r2 ob izpisu
}

function emptyDay(): DayAgg {
  return {
    netSalesCents: 0,
    orders: 0,
    plannedMinutes: 0,
    plannedCostCents: 0,
    plannedIncomplete: 0,
    actualMinutes: 0,
    actualCostCents: 0,
    openEntries: 0,
    unapproved: 0,
    rateZero: 0,
    overtimeMinutes: 0,
  }
}

/* ─────────────────── 9) Podatkovna kakovost (FcDataQuality vzorec) ─────────────────── */

export interface LaborCoverageDataQualityInput {
  /** vsi NALOŽENI vnosi okna (± varovalni dan) — števci so okenske vsote */
  entries: EntryInput[]
  /** zgodovinske izmene (status v SHIFT_HISTORY_STATUSES), že omejene na okno */
  historyShifts: ShiftInput[]
  employeeJobs: JobRate[]
  jobs: JobBase[]
  locations: LocationTz[]
  now?: Date
  /** skupno število naročil okna (0 → 'no-sales') */
  totalOrders: number
}

/**
 * Okenski povzetek kakovosti: vsak NEPOLN vir postane KODA razloga (UI
 * preslika lcov.dq.*), števci ostanejo številke. incompleteData = vsaj en
 * razlog. Mešane valute: števec različnih valut (> 1 → zastavika, ne tiho).
 */
export function dataQualityOf(args: LaborCoverageDataQualityInput): LaborCoverageDataQuality {
  const nowMs = args.now && !Number.isNaN(args.now.getTime()) ? args.now.getTime() : null

  let openEntries = 0
  let rateZero = 0
  let unapproved = 0
  for (const e of args.entries) {
    if (!(e.clockIn instanceof Date) || Number.isNaN(e.clockIn.getTime())) continue
    const closed = e.clockOut instanceof Date && !Number.isNaN(e.clockOut.getTime())
    if (!closed) openEntries += 1
    else if (!(num(e.payRate) > 0)) rateZero += 1 // rate-zero: ZAPRT vnos s postavko 0
    if (e.status !== 'approved') unapproved += 1 // odprti so po navadi tudi 'active' — štejejo
  }

  const overlapPairs = countEntryOverlaps(args.entries, nowMs)

  let missingRateShifts = 0
  for (const s of args.historyShifts) {
    if (resolveShiftRateCents(s, args.employeeJobs, args.jobs).source === 'none') missingRateShifts += 1
  }

  const currencies = new Set(args.locations.map((l) => l.currency))
  const mixedCurrencies = currencies.size

  const reasons: string[] = []
  if (openEntries > 0) reasons.push('open-entries')
  if (rateZero > 0) reasons.push('rate-zero')
  if (overlapPairs > 0) reasons.push('overlap')
  if (unapproved > 0) reasons.push('unapproved')
  if (missingRateShifts > 0) reasons.push('missing-rate-shifts')
  if (mixedCurrencies > 1) reasons.push('mixed-currencies')
  if (args.totalOrders <= 0) reasons.push('no-sales')

  return {
    incompleteData: reasons.length > 0,
    reasons,
    openEntries,
    rateZero,
    overlapPairs,
    unapproved,
    missingRateShifts,
    mixedCurrencies,
  }
}

/* ─────────────────── 10) Napoved prodaje (isti dan tedna) ─────────────────── */

/**
 * DETERMINISTIČNA napoved (forecastQty vzorec — batch.ts): za vsak prihodnji
 * dan (to+1 … to+horizonDays) povprečje neto prodaje ZGODOVINSKIH dni ISTEGA
 * dneva tedna. Vzorci = SAMO dnevi z ≥ 1 naročilom; dnevi z 0 naročili so
 * closedDays (ločeno — NE v povprečju, da zaprti dnevi ne pollutajo ocene).
 * Ni vzorcev → expectedNetSalesCents = null + confidence 'low' (NIČ izmišljenega).
 */
export function forecastSales(
  historyDays: LaborCoverageDay[],
  horizonDays: number = LCOV_FORECAST_DAYS,
): LaborCoverageForecastDay[] {
  const days = [...historyDays].sort((a, b) => a.date.localeCompare(b.date))
  if (days.length === 0) return []
  const to = days[days.length - 1].date
  const horizon = Math.max(0, Math.min(60, Math.round(horizonDays)))

  const byDow = new Map<number, LaborCoverageDay[]>()
  for (const d of days) {
    const list = byDow.get(d.dow)
    if (list) list.push(d)
    else byDow.set(d.dow, [d])
  }

  const out: LaborCoverageForecastDay[] = []
  for (let i = 1; i <= horizon; i++) {
    const date = addDaysISO(to, i)
    const dow = dowOf(date)
    const sameDow = byDow.get(dow) || []
    const samples = sameDow.filter((d) => d.orders > 0).map((d) => d.netSalesCents)
    const closedDays = sameDow.length - samples.length
    if (samples.length === 0) {
      out.push({ date, dow, expectedNetSalesCents: null, minCents: null, maxCents: null, sampleCount: 0, closedDays, confidence: 'low' })
      continue
    }
    const sum = samples.reduce((a, b) => a + b, 0)
    out.push({
      date,
      dow,
      expectedNetSalesCents: Math.round(sum / samples.length),
      minCents: Math.min(...samples),
      maxCents: Math.max(...samples),
      sampleCount: samples.length,
      closedDays,
      confidence: samples.length < 3 ? 'low' : 'ok',
    })
  }
  return out
}

/* ─────────────────── 11) Pokritost prihodnjih izmen ─────────────────── */

/**
 * Per prihodnji dan Z izmenami (status scheduled/confirmed/in_progress —
 * completed je zgodovina): načrtovane minute/strošek (veriga postavk),
 * ocenjen Labor % glede na napoved prodaje ISTEGA dneva ter pas zastavice.
 * informativno: overlaps (pari izmen istega zaposlenega tisti dan) in
 * longNoBreak (izmena > 8 h brez odmora) — BREZ zakonskih predpostavk.
 * SAMO priporočilo — nič se ne objavi/briše.
 */
export function coverageOf(
  forecastDays: LaborCoverageForecastDay[],
  shifts: ShiftInput[],
  employeeJobs: JobRate[],
  jobs: JobBase[],
  locations: LocationTz[],
): LaborCoverageCoverageDay[] {
  if (forecastDays.length === 0) return []
  const locById = new Map(locations.map((l) => [l.id, l]))
  const futureDates = new Set(forecastDays.map((d) => d.date))
  const fdByDate = new Map(forecastDays.map((d) => [d.date, d]))

  interface CovAgg {
    shiftCount: number
    plannedMinutes: number
    plannedCostCents: number
    noRate: number
    longNoBreak: number
    gross: Map<string, Array<[number, number]>> // employeeId → [startMin, endMin)
  }
  const byDate = new Map<string, CovAgg>()

  for (const s of shifts) {
    if (!(SHIFT_FORECAST_STATUSES as readonly string[]).includes(s.status)) continue
    const loc = s.locationId ? locById.get(s.locationId) : undefined
    if (!loc) continue // loader že pre-filtrira null/tuje lokacije (dokumentirano)
    const date = localDateKey(s.shiftDate, loc.timezone)
    if (!futureDates.has(date)) continue
    const dur = shiftDurationMinutes(s)
    if (dur === null || dur <= 0) continue
    const rate = resolveShiftRateCents(s, employeeJobs, jobs)

    let row = byDate.get(date)
    if (!row) {
      row = { shiftCount: 0, plannedMinutes: 0, plannedCostCents: 0, noRate: 0, longNoBreak: 0, gross: new Map() }
      byDate.set(date, row)
    }
    row.shiftCount += 1
    row.plannedMinutes += dur
    row.plannedCostCents += Math.round((dur * rate.cents) / 60)
    if (rate.source === 'none') row.noRate += 1
    if (!(Math.round(num(s.breakMinutes) || 0) > 0) && dur > 480) row.longNoBreak += 1

    const start = parseHM(s.startTime)
    const gross = shiftGrossMinutes(s)
    if (start !== null && gross !== null) {
      const list = row.gross.get(s.employeeId)
      const interval: [number, number] = [start, start + gross]
      if (list) list.push(interval)
      else row.gross.set(s.employeeId, [interval])
    }
  }

  const out: LaborCoverageCoverageDay[] = []
  for (const [date, row] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const fd = fdByDate.get(date)
    const expectedNetSalesCents = fd ? fd.expectedNetSalesCents : null
    const expectedPct =
      expectedNetSalesCents !== null && expectedNetSalesCents > 0
        ? r2((row.plannedCostCents / expectedNetSalesCents) * 100)
        : null
    let overlaps = 0
    for (const list of row.gross.values()) overlaps += countOverlapPairs(list)
    out.push({
      date,
      dow: dowOf(date),
      shiftCount: row.shiftCount,
      plannedMinutes: row.plannedMinutes,
      plannedCostCents: row.plannedCostCents,
      incompleteRate: row.shiftCount > 0 ? r2(row.noRate / row.shiftCount) : 0,
      expectedNetSalesCents,
      expectedPct,
      flag: coverageFlag(expectedPct),
      overtimeMinutes: 0, // napoved nima dejanskih vnosov — nadure so zgolj pretekli podatek
      overlaps,
      longNoBreak: row.longNoBreak,
    })
  }
  return out
}

/* ─────────────────── 12) GLAVNA funkcija ─────────────────── */

/**
 * Celotno poročilo pokritosti dela (days + hours 7×24 + roles + totals +
 * dataQuality + forecast/coverage) — ČISTA funkcija vhodov (determinizem:
 `now` je del vhoda; generatedAt doda izključno ruta).
 */
export function laborCoverageReport(input: LaborCoverageInput): LaborCoverageReport {
  const dates = dateRange(input.from, input.to)
  const windowDates = new Set(dates)
  const locById = new Map(input.locations.map((l) => [l.id, l]))
  const nowMs = input.now && !Number.isNaN(input.now.getTime()) ? input.now.getTime() : null

  const dayAgg = new Map<string, DayAgg>(dates.map((d) => [d, emptyDay()]))
  const touchDay = (key: string): DayAgg | null => {
    const row = dayAgg.get(key)
    if (row) return row
    // dnevi IZVEN okna se ne ustvarjajo (varovalni polji loaderja ±1 dan)
    return null
  }

  // urna matrika: `${dow}|${hour}` → vsote; `${dateKey}|${hour}` → prisotni vnosi (staffOn)
  const hourAgg = new Map<string, { netSalesCents: number; orders: number; laborMinutes: number }>()
  const staffPresence = new Map<string, Set<string>>()

  // vloge (job agregati — BREZ imen zaposlenih)
  interface RoleAgg {
    jobId: string | null
    plannedMinutes: number
    plannedCostCents: number
    actualMinutes: number
    actualCostCents: number
  }
  const roleAgg = new Map<string, RoleAgg>()
  const touchRole = (jobId: string | null): RoleAgg => {
    const key = jobId ?? '\u0000null'
    let row = roleAgg.get(key)
    if (!row) {
      row = { jobId, plannedMinutes: 0, plannedCostCents: 0, actualMinutes: 0, actualCostCents: 0 }
      roleAgg.set(key, row)
    }
    return row
  }

  const historyShifts: ShiftInput[] = []

  /* ——— 1) Vnosi delovnega časa (dejansko) ——— */
  for (const e of input.entries) {
    if (!(e.clockIn instanceof Date) || Number.isNaN(e.clockIn.getTime())) continue
    const loc = e.locationId ? locById.get(e.locationId) : undefined
    if (!loc) continue // loader izpušča null/neznanne lokacije — NE pripisuj (dokumentirano)

    const isOpen = !(e.clockOut instanceof Date) || Number.isNaN(e.clockOut.getTime())
    const startKey = localDateKey(e.clockIn, loc.timezone)

    // dnevni števci (na dan PRIJAVE, če je v oknu): odprt/nepotrjen/stopnja-0
    const startDay = windowDates.has(startKey) ? touchDay(startKey) : null
    if (startDay) {
      if (isOpen) startDay.openEntries += 1
      if (e.status !== 'approved') startDay.unapproved += 1
      if (!isOpen && !(num(e.payRate) > 0)) startDay.rateZero += 1
    }

    // prispevek: [clockIn, out) — odprt vnos do `now` (živi delež, labor-cost precedens)
    const rateCents = Math.round(num(e.payRate) * 100) // payRateToCents konvencija (timeclock)
    let out: Date
    let minutes: number
    let payCents: number
    if (isOpen) {
      out = nowMs !== null ? new Date(nowMs) : e.clockIn // brez `now` → 0 minut (samo števec)
      const gross = Math.round((out.getTime() - e.clockIn.getTime()) / 60000) // grossMinutes konvencija
      minutes = Math.max(0, gross - Math.max(0, Math.round(num(e.breakMinutes) || 0)))
      // totalPayCents konvencija: round(min × centi/h / 60) — celoštevilčno, brez drifta
      payCents = minutes > 0 && rateCents > 0 ? Math.round((minutes * rateCents) / 60) : 0
    } else {
      out = e.clockOut as Date
      if (!(out.getTime() > e.clockIn.getTime())) continue
      minutes = num(e.totalMinutes)
      payCents = rateCents > 0 ? Math.max(0, Math.round(num(e.totalPay) * 100)) : 0 // rate-zero → strošek 0
    }
    if (!(minutes > 0)) continue

    const isOvertime = e.type === 'overtime'
    const roleRow = touchRole(e.jobId ?? null)
    for (const c of splitEntryChunks(e.clockIn, out, minutes, payCents, loc.timezone)) {
      const day = windowDates.has(c.dateKey) ? touchDay(c.dateKey) : null
      if (!day) continue // razcep IZVEN okna (varovalni dan) se ne šteje — okensko poročilo
      day.actualMinutes += c.minutes
      day.actualCostCents += c.costCents
      if (isOvertime) day.overtimeMinutes += c.minutes
      // urna matrika
      const dow = dowOf(c.dateKey)
      const hk = hourKey(dow, c.hour)
      let cell = hourAgg.get(hk)
      if (!cell) {
        cell = { netSalesCents: 0, orders: 0, laborMinutes: 0 }
        hourAgg.set(hk, cell)
      }
      cell.laborMinutes += c.minutes
      const pk = `${c.dateKey}|${c.hour}`
      let set = staffPresence.get(pk)
      if (!set) {
        set = new Set<string>()
        staffPresence.set(pk, set)
      }
      set.add(e.id)
      // vloge: dejanski delež po jobId vnosa
      roleRow.actualMinutes += c.minutes
      roleRow.actualCostCents += c.costCents
    }
  }

  /* ——— 2) Plačana naročila (neto = subtotal − discount) ——— */
  for (const o of input.orders) {
    if (!(o.paidAt instanceof Date) || Number.isNaN(o.paidAt.getTime())) continue
    const loc = locById.get(o.locationId)
    if (!loc) continue
    const key = localDateKey(o.paidAt, loc.timezone)
    const day = windowDates.has(key) ? touchDay(key) : null
    if (!day) continue
    const net = Math.max(0, num(o.subtotal) - num(o.discount))
    const cents = Math.round(net * 100)
    day.netSalesCents += cents
    day.orders += 1
    const hk = hourKey(dowOf(key), localHourOf(o.paidAt, loc.timezone))
    let cell = hourAgg.get(hk)
    if (!cell) {
      cell = { netSalesCents: 0, orders: 0, laborMinutes: 0 }
      hourAgg.set(hk, cell)
    }
    cell.netSalesCents += cents
    cell.orders += 1
  }

  /* ——— 3) Izmene (načrtovano) ——— */
  for (const s of input.shifts) {
    const loc = s.locationId ? locById.get(s.locationId) : undefined
    if (!loc) continue
    const isHistory = (SHIFT_HISTORY_STATUSES as readonly string[]).includes(s.status)
    const isForecast = (SHIFT_FORECAST_STATUSES as readonly string[]).includes(s.status)
    if (!isHistory && !isForecast) continue // absent/cancelled/no_show → nič
    const dur = shiftDurationMinutes(s)
    if (dur === null || dur <= 0) continue
    const rate = resolveShiftRateCents(s, input.employeeJobs, input.jobs)
    const cost = Math.round((dur * rate.cents) / 60)

    const key = localDateKey(s.shiftDate, loc.timezone) // dan ZAČETKA izmene
    if (isHistory && windowDates.has(key)) {
      const day = touchDay(key)
      if (day) {
        day.plannedMinutes += dur
        day.plannedCostCents += cost
        if (rate.source === 'none') day.plannedIncomplete += 1
        historyShifts.push(s)
        const roleRow = touchRole(s.jobId ?? null)
        roleRow.plannedMinutes += dur
        roleRow.plannedCostCents += cost
      }
    }
    // napovedne izmene obdela coverageOf (spodaj) — tukaj samo zgodovina
  }

  /* ——— 4) Dnevi ——— */
  const jobNameById = new Map(input.jobs.map((j) => [j.jobId, j.name]))
  const days: LaborCoverageDay[] = dates.map((date) => {
    const a = dayAgg.get(date) || emptyDay()
    const laborPct = pctOf(a.actualCostCents, a.netSalesCents)
    return {
      date,
      dow: dowOf(date),
      netSalesCents: a.netSalesCents,
      orders: a.orders,
      plannedMinutes: a.plannedMinutes,
      plannedCostCents: a.plannedCostCents,
      plannedIncomplete: a.plannedIncomplete,
      actualMinutes: r2(a.actualMinutes),
      actualCostCents: a.actualCostCents,
      openEntries: a.openEntries,
      unapproved: a.unapproved,
      rateZero: a.rateZero,
      overtimeMinutes: r2(a.overtimeMinutes),
      varianceMinutes: r2(a.plannedMinutes - a.actualMinutes),
      laborPct,
      sphCents: a.actualMinutes > 0 ? Math.round(a.netSalesCents / (a.actualMinutes / 60)) : null,
      costPerOrderCents: a.orders > 0 ? Math.round(a.actualCostCents / a.orders) : null,
    }
  })

  /* ——— 5) Urna matrika 7×24 ——— */
  const hours: LaborCoverageHourCell[] = []
  for (let dow = 1; dow <= 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const cell = hourAgg.get(hourKey(dow, hour))
      // staffOn: povprečje čez DNEVI z ≥ 1 sočasnim vnosom v (dow, hour)
      let staffDays = 0
      let staffSum = 0
      for (const d of dates) {
        if (dowOf(d) !== dow) continue
        const set = staffPresence.get(`${d}|${hour}`)
        if (set && set.size > 0) {
          staffDays += 1
          staffSum += set.size
        }
      }
      hours.push({
        dow,
        hour,
        netSalesCents: cell ? cell.netSalesCents : 0,
        orders: cell ? cell.orders : 0,
        laborMinutes: r2(cell ? cell.laborMinutes : 0),
        staffOn: staffDays > 0 ? r2(staffSum / staffDays) : 0,
      })
    }
  }

  /* ——— 6) Vloge (samo agregati po job — BREZ imen zaposlenih) ——— */
  const roles: LaborCoverageRoleRow[] = [...roleAgg.values()]
    .map((r) => ({
      jobId: r.jobId,
      name: r.jobId ? (jobNameById.get(r.jobId) ?? r.jobId) : '—',
      plannedMinutes: r2(r.plannedMinutes),
      plannedCostCents: r.plannedCostCents,
      actualMinutes: r2(r.actualMinutes),
      actualCostCents: r.actualCostCents,
    }))
    .sort((a, b) => b.plannedCostCents + b.actualCostCents - (a.plannedCostCents + a.actualCostCents) || a.name.localeCompare(b.name))

  /* ——— 7) Skupaj ——— */
  let netSalesCents = 0
  let orders = 0
  let plannedMinutes = 0
  let plannedCostCents = 0
  let actualMinutes = 0
  let actualCostCents = 0
  let overtimeMinutes = 0
  for (const a of dayAgg.values()) {
    netSalesCents += a.netSalesCents
    orders += a.orders
    plannedMinutes += a.plannedMinutes
    plannedCostCents += a.plannedCostCents
    actualMinutes += a.actualMinutes
    actualCostCents += a.actualCostCents
    overtimeMinutes += a.overtimeMinutes
  }
  const totals: LaborCoverageTotals = {
    netSalesCents,
    orders,
    plannedMinutes,
    plannedCostCents,
    actualMinutes: r2(actualMinutes),
    actualCostCents,
    laborPct: pctOf(actualCostCents, netSalesCents),
    sphCents: actualMinutes > 0 ? Math.round(netSalesCents / (actualMinutes / 60)) : null,
    costPerOrderCents: orders > 0 ? Math.round(actualCostCents / orders) : null,
    varianceMinutes: r2(plannedMinutes - actualMinutes),
    overtimeMinutes: r2(overtimeMinutes),
  }

  /* ——— 8) Napoved + pokritost (deterministično iz serije dni) ——— */
  const forecastDays = forecastSales(days, LCOV_FORECAST_DAYS)
  const coverage = coverageOf(forecastDays, input.shifts, input.employeeJobs, input.jobs, input.locations)

  /* ——— 9) Podatkovna kakovost ——— */
  const dataQuality = dataQualityOf({
    entries: input.entries,
    historyShifts,
    employeeJobs: input.employeeJobs,
    jobs: input.jobs,
    locations: input.locations,
    now: input.now,
    totalOrders: orders,
  })

  /* ——— 10) Parametri (determinizem vidljiv: osnova napovedi je izpisana) ——— */
  const sampleDays = days.filter((d) => d.orders > 0).length
  return {
    parameters: {
      from: input.from,
      to: input.to,
      locationIds: input.locations.map((l) => l.id).sort(),
      jobId: input.jobId ?? null,
      targetPct: LCOV_TARGET_PCT,
      warnPct: LCOV_WARN_PCT,
      lowPct: LCOV_LOW_PCT,
      forecastDays: LCOV_FORECAST_DAYS,
      currencies: [...new Set(input.locations.map((l) => l.currency))].sort(),
      sampleDays,
      closedDays: days.length - sampleDays,
      counts: { orders: input.orders.length, entries: input.entries.length, shifts: input.shifts.length },
    },
    days,
    hours,
    roles,
    totals,
    dataQuality,
    forecast: { method: 'same-weekday-average', days: forecastDays, coverage },
  }
}
