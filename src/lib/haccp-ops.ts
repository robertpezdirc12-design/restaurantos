/**
 * Issue #20 (P1/P2, v1.109.0) — operativni HACCP tok: zapadli termini,
 * strukturirane meritve, odstopanja, korektivni ukrepi in verifikacija.
 *
 * ČISTI MOTOR (brez DB uvozov v jedru — vzorec three-way-match/food-cost):
 *  - časovni pas lokacije prek Intl (brez zunanjih knjižnic, DST-varno),
 *  - izračun terminov načrta (daily/weekly/monthly + dueTime),
 *  - evaluacija meritve proti pravilom NAČRTA (strežnik odloča status),
 *  - posnetek pravil (ruleSnapshot) — zgodovinska nespremenljivost,
 *  - razvrščanje stanj izvedbe (zapadlo/v teku/izvedeno/odstopanje/…).
 *
 * Uredba (ES) 852/2004 čl. 5: kritične meje + spremljanje + korektivni ukrepi
 * + redno preverjanje. Sistem je orodje za dosledno izvedbo in dokazovanje —
 * NE nadomešča odgovorne osebe in NE zagotavlja pravne skladnosti.
 */
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import { isMissingSchemaError } from '@/lib/prisma-missing'

/* ═══════════════ 1. ČASOVNI PAS (Intl, DST-varen) ═══════════════ */

/** Odmik trenutnega UTC časa do lokalnega časa pasu (ms). DST-varen. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const m: Record<string, number> = {}
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') m[p.type] = Number(p.value)
  }
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, m.hour === 24 ? 0 : m.hour, m.minute, m.second)
  return asUTC - instant.getTime()
}

export interface LocalDate {
  y: number
  m: number // 1-12
  d: number // 1-31
}

/**
 * Lokalni datum (+ ura/min) trenutka v pasu. Pasuja k "kateri je DANES v
 * lokalnem pasu" — prelom dneva teče po lokaciji, ne po UTC (issue: "v
 * časovnem pasu lokacije").
 */
export function zonedDateParts(instant: Date, timeZone: string): LocalDate & { hh: number; mm: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const m: Record<string, number> = {}
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') m[p.type] = Number(p.value)
  }
  return { y: m.year, m: m.month, d: m.day, hh: m.hour === 24 ? 0 : m.hour, mm: m.minute }
}

/**
 * Lokalni (y, m, d, hh, mm) v pasu → UTC trenutek. Dvostopenjski poskus z
 * korekcijo odmika (prehod DST): prvi poskus predpostavi odmik "ugibanja",
 * drugi preveri dejanski odmik rezultata. Neobstoječ lokalni čas (pomladni
 * prehod) se preslika v naslednji veljavni trenutek — dokumentirano.
 */
export function zonedTimeToUtc(y: number, month: number, day: number, hh: number, mm: number, timeZone: string): Date {
  const guess = Date.UTC(y, month - 1, day, hh, mm, 0)
  const off1 = tzOffsetMs(new Date(guess), timeZone)
  let ts = guess - off1
  const off2 = tzOffsetMs(new Date(ts), timeZone)
  if (off2 !== off1) ts = guess - off2 // prehod DST med ugotavljanjem
  return new Date(ts)
}

/** Dan v tednu lokalnega datuma: 1 = ponedeljek … 7 = nedelja. */
export function localWeekday(date: LocalDate): number {
  const wd = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay() // 0=ned
  return wd === 0 ? 7 : wd
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function localDateKey(date: LocalDate): string {
  return `${date.y}-${pad2(date.m)}-${pad2(date.d)}`
}

/* ═══════════════ 2. PRAVILA NAČRTA IN EVALUACIJA MERITVE ═══════════════ */

export type MeasureKind = 'number' | 'confirm'
export type ThresholdDirection = 'below' | 'above' | 'between' | 'none'
export type HaccpSeverity = 'ok' | 'warning' | 'critical'

/** Pravila, po katerih strežnik OCENI meritev (iz načrta ali posnetka). */
export interface PlanRule {
  measureKind: MeasureKind
  unit: string
  direction: ThresholdDirection
  /** 'below': v ≤ okLimit → ok; v ≤ warnLimit → warning; sicer critical. */
  okLimit: number | null
  warnLimit: number | null
  /** 'between': rangeMin ≤ v ≤ rangeMax → ok; zunaj → critical. */
  rangeMin: number | null
  rangeMax: number | null
  /** Potrditvene kontrole: izid fail je critical (sicer warning). */
  critical: boolean
  /** Ali korektivni ukrep ZAPRE odstopanje šele po verifikaciji. */
  requiresVerification: boolean
}

export const DIRECTIONS: readonly ThresholdDirection[] = ['below', 'above', 'between', 'none']
export const MEASURE_KINDS: readonly MeasureKind[] = ['number', 'confirm']

const EPS = 1e-9

/**
 * Strogi numerični parser telesa zahteve (razlikuje od num() iz map.ts, ki ima
 * fallback 0): null/undefined/prazen niz/NaN → null (manjkajoča meritev je
 * NAPAKA, ne 0 — 0 °C je legitimna vrednost!).
 */
export function numStrict(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'object' && v !== null && 'toNumber' in (v as Record<string, unknown>)) {
    try {
      const n = (v as { toNumber(): number }).toNumber()
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }
  // "4,5" → 4.5 (slovenski decimalni ločilnik iz POS vnosnih polj)
  const s = typeof v === 'string' ? v.trim().replace(',', '.') : v
  const n = typeof s === 'number' ? s : Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Oceni NUMERIČNO meritev proti pravilom. Strežnik je edini odločitelj —
 * klient NE more prijaviti "ok" čez kritično mejo (issue P1).
 */
export function evalMeasurement(rule: PlanRule, value: number): HaccpSeverity {
  if (rule.measureKind !== 'number') return 'ok' // potrditvene kontrole ne numeric
  switch (rule.direction) {
    case 'below':
      if (rule.okLimit === null) return 'ok' // samo-beleženje brez meje
      if (value <= rule.okLimit + EPS) return 'ok'
      if (rule.warnLimit !== null && value <= rule.warnLimit + EPS) return 'warning'
      return 'critical'
    case 'above':
      if (rule.okLimit === null) return 'ok'
      if (value >= rule.okLimit - EPS) return 'ok'
      if (rule.warnLimit !== null && value >= rule.warnLimit - EPS) return 'warning'
      return 'critical'
    case 'between':
      if (rule.rangeMin === null || rule.rangeMax === null) return 'ok'
      if (value >= rule.rangeMin - EPS && value <= rule.rangeMax + EPS) return 'ok'
      return 'critical' // zunaj obseja je takoj kritično (brez sive cone)
    default:
      return 'ok' // 'none': samo-beleženje
  }
}

/** Oceni POTRDITVENO kontrolo (čiščenje/dostava/usposabljanje …). */
export function evalConfirm(rule: PlanRule, outcome: 'pass' | 'fail'): HaccpSeverity {
  if (outcome === 'pass') return 'ok'
  return rule.critical ? 'critical' : 'warning'
}

/** Človeku berljiv opis pragu (posnetek za UI + izvoz). */
export function thresholdText(rule: PlanRule): string {
  if (rule.measureKind === 'confirm') return rule.critical ? 'izid: OK/neOK (kritično)' : 'izid: OK/neOK'
  const u = rule.unit ? ` ${rule.unit}` : ''
  switch (rule.direction) {
    case 'below':
      return rule.okLimit === null
        ? `beleženje${u}`
        : `≤ ${rule.okLimit}${u}${rule.warnLimit !== null ? ` · opozorilo ≤ ${rule.warnLimit}${u}` : ''}`
    case 'above':
      return rule.okLimit === null
        ? `beleženje${u}`
        : `≥ ${rule.okLimit}${u}${rule.warnLimit !== null ? ` · opozorilo ≥ ${rule.warnLimit}${u}` : ''}`
    case 'between':
      return rule.rangeMin === null || rule.rangeMax === null
        ? `beleženje${u}`
        : `${rule.rangeMin}–${rule.rangeMax}${u}`
    default:
      return `beleženje${u}`
  }
}

/* ═══════════════ 3. TERMINI NAČRTA (occurrences) ═══════════════ */

export interface PlanScheduleFields {
  id: string
  frequency: string // daily | weekly | monthly
  dueTime: string | null // "HH:MM"
  weekday: number | null // 1-7 (pon-ned), za weekly
  monthDay: number | null // 1-28, za monthly
}

export interface Occurrence {
  /** `${planId}|YYYY-MM-DD` — stabilna identiteta termina (dedup). */
  key: string
  planId: string
  /** lokalni datum termina YYYY-MM-DD */
  date: string
  /** UTC trenutek zapadlosti */
  dueAt: Date
}

/** Veljaven "HH:MM" (00:00–23:59)? */
export function isValidDueTime(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
}

/**
 * Termin načrta za določen LOKALNI datum (ali null, če ta dan ni termina).
 * MonthDay je omejen na 1-28 (enak datum v vsakem mesecu — brez amputacije
 * februarja; issue: "razložljiva pogostost").
 */
export function occurrenceForDate(
  plan: PlanScheduleFields,
  date: LocalDate,
  timeZone: string,
): Occurrence | null {
  const freq = plan.frequency
  if (freq === 'weekly') {
    if (plan.weekday === null || localWeekday(date) !== plan.weekday) return null
  } else if (freq === 'monthly') {
    if (plan.monthDay === null || date.d !== plan.monthDay) return null
  } else if (freq !== 'daily') {
    return null
  }
  const [hh, mm] = isValidDueTime(plan.dueTime ?? '') ? (plan.dueTime as string).split(':').map(Number) : [10, 0]
  const dueAt = zonedTimeToUtc(date.y, date.m, date.d, hh, mm, timeZone)
  return { key: `${plan.id}|${localDateKey(date)}`, planId: plan.id, date: localDateKey(date), dueAt }
}

/* ═══════════════ 4. STANJA IZVEDBE + PLOŠČA TERMINOV ═══════════════ */

export type EntryState = 'legacy' | 'done' | 'deviation' | 'awaiting_verification' | 'closed'
export type ScheduleItemState =
  | 'overdue' // zapadlo — ni zapisa, rok je pretekel
  | 'pending' // v teku — današnji termin, rok še ni pretekel
  | 'upcoming' // prihodnji termin (izven danes)
  | 'done' // izvedeno (ok)
  | 'deviation' // odstopanje — čaka korektivni ukrep
  | 'awaiting_verification' // korektiv izveden — čaka ponovno preverbo
  | 'closed' // odstopanje potrjeno zaprto

/** Zemljevid vnosa → stanje na plošči (legacy vrstice pošteno preslikane). */
export function stateOfEntry(entry: { entryState: string; status: string }): ScheduleItemState {
  switch (entry.entryState) {
    case 'done':
      return 'done'
    case 'deviation':
      return 'deviation'
    case 'awaiting_verification':
      return 'awaiting_verification'
    case 'closed':
      return 'closed'
    default: {
      // legacy: stanja ni — izpelje se iz statusa (ok → izvedeno, drugače odstopanje)
      return entry.status === 'ok' ? 'done' : 'deviation'
    }
  }
}

export interface SchedulePlanView {
  id: string
  name: string
  category: string
  target: string
  steps: string[]
  responsible: string
  frequency: string
  dueTime: string | null
  weekday: number | null
  monthDay: number | null
  rule: PlanRule | null
}

export interface ScheduleEntryView {
  id: string
  occurrenceKey: string
  entryState: string
  status: string
  numericValue: number | null
  unit: string
  measuredAt: Date
}

export interface ScheduleItem {
  plan: SchedulePlanView
  date: string
  dueAt: string // ISO
  state: ScheduleItemState
  entry?: ScheduleEntryView
}

/**
 * Plošča terminov: zadnjih daysBack dni + dnevi do daysFwd naprej (po lokalnem
 * koledarju). "Dnevi brez izvedbe so vidni kot zapadli" (issue Testi).
 */
export function buildSchedule(
  plans: (SchedulePlanView & PlanScheduleFields)[],
  entriesByOccurrence: Map<string, ScheduleEntryView>,
  timeZone: string,
  now: Date,
  daysBack: number,
  daysFwd: number,
): ScheduleItem[] {
  const today = zonedDateParts(now, timeZone)
  const items: ScheduleItem[] = []
  for (const plan of plans) {
    for (let off = -daysBack; off <= daysFwd; off++) {
      const d = new Date(Date.UTC(today.y, today.m - 1, today.d + off))
      const date: LocalDate = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
      const occ = occurrenceForDate(plan, date, timeZone)
      if (!occ) continue
      const entry = entriesByOccurrence.get(occ.key)
      let state: ScheduleItemState
      if (entry) {
        state = stateOfEntry(entry)
      } else if (occ.dueAt.getTime() <= now.getTime()) {
        state = 'overdue'
      } else {
        state = off === 0 ? 'pending' : 'upcoming'
      }
      items.push({ plan, date: occ.date, dueAt: occ.dueAt.toISOString(), state, entry })
    }
  }
  items.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.plan.id.localeCompare(b.plan.id)))
  return items
}

/* ═══════════════ 5. POSNETEK PRAVIL (zgodovinska nespremenljivost) ═══════════════ */

export interface RuleSnapshot extends PlanRule {
  planName: string
  planVersion: number
}

/** Posnetek pravil načrta ob meritvi (kasnejša sprememba načrta NE spremeni pomena zapisa). */
export function ruleSnapshotOf(
  plan: {
    name: string
    version: number | null
    measureKind: string | null
    unit: string | null
    direction: string | null
    okLimit: unknown
    warnLimit: unknown
    rangeMin: unknown
    rangeMax: unknown
    critical: boolean | null
    requiresVerification: boolean | null
  },
): RuleSnapshot {
  return {
    planName: plan.name,
    planVersion: plan.version ?? 1,
    measureKind: plan.measureKind === 'number' ? 'number' : 'confirm',
    unit: plan.unit ?? '',
    direction: (DIRECTIONS as readonly string[]).includes(plan.direction ?? '') ? (plan.direction as ThresholdDirection) : 'none',
    okLimit: numOrNull(plan.okLimit),
    warnLimit: numOrNull(plan.warnLimit),
    rangeMin: numOrNull(plan.rangeMin),
    rangeMax: numOrNull(plan.rangeMax),
    critical: plan.critical ?? false,
    requiresVerification: plan.requiresVerification ?? true,
  }
}

/** Preberi posnetek iz Json/ String stolpca (dialektno varno). */
export function parseRuleSnapshot(raw: unknown): RuleSnapshot | null {
  const v = jparse<RuleSnapshot | null>(raw, null)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Partial<RuleSnapshot>
  if (r.measureKind !== 'number' && r.measureKind !== 'confirm') return null
  return {
    planName: String(r.planName ?? ''),
    planVersion: Number(r.planVersion ?? 0) || 0,
    measureKind: r.measureKind,
    unit: String(r.unit ?? ''),
    direction: (DIRECTIONS as readonly string[]).includes(String(r.direction)) ? (r.direction as ThresholdDirection) : 'none',
    okLimit: numOrNull(r.okLimit),
    warnLimit: numOrNull(r.warnLimit),
    rangeMin: numOrNull(r.rangeMin),
    rangeMax: numOrNull(r.rangeMax),
    critical: Boolean(r.critical),
    requiresVerification: r.requiresVerification === undefined ? true : Boolean(r.requiresVerification),
  }
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/* ═══════════════ 6. VALIDACIJSKA PRAVILA NAČRTA (POST/PATCH) ═══════════════ */

export interface PlanRuleInput {
  measureKind?: MeasureKind
  unit?: string
  direction?: ThresholdDirection
  okLimit?: number | null
  warnLimit?: number | null
  rangeMin?: number | null
  rangeMax?: number | null
  critical?: boolean
  requiresVerification?: boolean
}

export interface ScheduleInput {
  frequency?: string
  dueTime?: string
  weekday?: number | null
  monthDay?: number | null
}

/**
 * Veljavnost NOVIH polj načrta. Vrača { error } ali null (veljavno).
 * Issue: "Za temperaturi podpri vrednost in enoto; za čiščenje … ustrezne
 * vrednosti/izid, ne univerzalnega številskega obrazca" — number ZAHTeva
 * enoto + smiselne meje glede na smer.
 */
export function validatePlanRuleInput(rule: PlanRuleInput, sched: ScheduleInput): string | null {
  const mk = rule.measureKind ?? 'confirm'
  if (mk === 'number') {
    if (!rule.unit || !rule.unit.trim()) return 'Numerična kontrola zahteva enoto (npr. °C).'
    if (rule.unit.length > 8) return 'Enota je predolga (največ 8 znakov).'
    const dir = rule.direction ?? 'none'
    if (dir === 'below' || dir === 'above') {
      if (rule.okLimit === null || rule.okLimit === undefined) return `Smer "${dir}" zahteva mejo OK (okLimit).`
      if (rule.warnLimit !== null && rule.warnLimit !== undefined) {
        if (dir === 'below' && rule.warnLimit < rule.okLimit) return 'Opozorilna meja mora biti ≥ meji OK (smer below).'
        if (dir === 'above' && rule.warnLimit > rule.okLimit) return 'Opozorilna meja mora biti ≤ meji OK (smer above).'
      }
    } else if (dir === 'between') {
      if (rule.rangeMin === null || rule.rangeMin === undefined || rule.rangeMax === null || rule.rangeMax === undefined) {
        return 'Smer "between" zahteva rangeMin in rangeMax.'
      }
      if (rule.rangeMin > rule.rangeMax) return 'rangeMin mora biti ≤ rangeMax.'
    }
  } else if (rule.direction && rule.direction !== 'none') {
    return 'Potrditvena kontrola ne uporablja smeri pragov.'
  }
  if (sched.frequency === 'weekly' && (sched.weekday === null || sched.weekday === undefined)) {
    return 'Tedenska pogostost zahteva dan v tednu (1-7).'
  }
  if (sched.frequency === 'monthly' && (sched.monthDay === null || sched.monthDay === undefined)) {
    return 'Mesečna pogostost zahteva dan v mesecu (1-28).'
  }
  if (sched.dueTime !== undefined && sched.dueTime !== null && !isValidDueTime(sched.dueTime)) {
    return 'Rok mora biti v obliki HH:MM.'
  }
  if (sched.weekday !== null && sched.weekday !== undefined && (sched.weekday < 1 || sched.weekday > 7)) {
    return 'Dan v tednu mora biti 1-7 (1 = ponedeljek).'
  }
  if (sched.monthDay !== null && sched.monthDay !== undefined && (sched.monthDay < 1 || sched.monthDay > 28)) {
    return 'Dan v mesecu mora biti 1-28 (enak v vsakem mesecu).'
  }
  return null
}

/* ═══════════════ 7. CSV IZVOZ ═══════════════ */

export interface ReportRow {
  /** sledljivost do originalnega zapisa (issue: "polja sledljiva do originala") */
  id: string
  date: string
  planName: string
  category: string
  target: string
  value: string
  status: string
  state: string
  corrective: string
  verified: string
  employee: string
}

/** CSV z BOM + `;` (računovodska konvencija projekta). */
export function haccpReportCsv(rows: ReportRow[]): string {
  const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`
  const head = ['ID zapisa', 'Datum', 'Načrt', 'Kategorija', 'Cilj', 'Meritev', 'Status', 'Stanje', 'Korektivni ukrep', 'Verifikacija', 'Izvedel']
  const lines = [head.map(esc).join(';')]
  for (const r of rows) {
    lines.push([r.id, r.date, r.planName, r.category, r.target, r.value, r.status, r.state, r.corrective, r.verified, r.employee].map(esc).join(';'))
  }
  return `\uFEFF${lines.join('\n')}\n`
}

/* ═══════════════ 8. CAPABILITY PROBE (DDL-gated, 60 s TTL) ═══════════════ */

const PROBE_TTL_MS = 60_000

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL aplikaciji / v testih). Z vrednostjo jo vsili. */
export function resetHaccpOpsProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/**
 * Ali NOVI operativni stolpci (HaccpEntry.planId … + HaccpAction tabela)
 * obstajajo na trenutni bazi? Dokler produkcija ne izvede DDL koraka
 * (/api/admin/migrate-haccp-ops), rute graceful degradirajo (vzorec
 * haccp-plans/cash-movements): plošča/poročilo → 503, pisanja z novimi
 * polji → 503; OBSTOJEČI tokovi (načrti brez novih polj, ad-hoc vnosi,
 * zgodovina) delujejo nespremenjeno.
 */
export async function haccpOpsColumnsReady(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe('SELECT "planId" FROM "HaccpEntry" LIMIT 1')
    cached = { value: true, at: Date.now() }
  } catch (e) {
    cached = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return cached.value
}
