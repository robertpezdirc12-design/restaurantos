/**
 * Delovni čas — clock-in/clock-out (GitLab issue #1, triage ⑥) — čista logika (brez DB/IO).
 *
 * Kanonični tok: zaposleni se prijavi na izmeno (clock-in → TimeEntry active,
 * payRate posnetek iz primarne EmployeeJob) → odmor začetek/konec (breakStart/
 * breakEnd, breakMinutes se akumulira) → odjava (clock-out → totalMinutes +
 * totalPay, status ostane active do managerske potrditve) → manager pregleda
 * (approve/dispute) → ure (totalMinutes) se uporabijo za delitev napitnin po
 * urah (/api/tips dayBasisRows — obstoječa pot, ki doslej ni imela podatkov).
 *
 * Pravila:
 * - ENAKO aktiven vnos na zaposlenega (409 ob ponovnem clock-in).
 * - Odmor: break-start brez odprtega breakStart; break-end samo z odprtim
 *   breakStart; clock-out z odprtim odmorom ga samodejno zaključi (brez
 *   mrtvih stanj — ura se šteje do clock-out).
 * - totalMinutes = max(0, round((clockOut − clockIn)/60000) − breakMinutes)
 *   — ISTA konvencija kot entryMinutesInRange v tips.ts (zaokroži bruto,
 *   odšteje odmor), da se ure v napitninah in poročilih ujemajo.
 * - totalPay v centih: round(totalMinutes × payRateCents / 60) — celoštevilčno,
 *   brez float drifta (npr. 450 min × 8,50 €/h = 63,75 €).
 * - Status je zaprt seznam active/approved/disputed z zaprtimi prehodi
 *   (aktivna menedžerska recenzija; disputed lahko nazaj v approved).
 * - Tip vnosa: regular/overtime/holiday/sick/vacation (zaprt seznam).
 * - Ročni (popravljeni) vnos managerja: clockIn < clockOut, preteklost
 *   (≤ 31 dni nazaj, ne v prihodnosti), break ≤ bruto izmena.
 */

export const TIMECLOCK_TYPES = ['regular', 'overtime', 'holiday', 'sick', 'vacation'] as const
export type TimeclockType = (typeof TIMECLOCK_TYPES)[number]

export const TIMECLOCK_TYPE_LABELS: Record<TimeclockType, string> = {
  regular: 'Navadno',
  overtime: 'Nadure',
  holiday: 'Praznik',
  sick: 'Bolniška',
  vacation: 'Dopust',
}

export const TIMECLOCK_STATUSES = ['active', 'approved', 'disputed'] as const
export type TimeclockStatus = (typeof TIMECLOCK_STATUSES)[number]

export function isTimeclockStatus(v: unknown): v is TimeclockStatus {
  return typeof v === 'string' && (TIMECLOCK_STATUSES as readonly string[]).includes(v)
}

export function isTimeclockType(v: unknown): v is TimeclockType {
  return typeof v === 'string' && (TIMECLOCK_TYPES as readonly string[]).includes(v)
}

export const TIMECLOCK_STATUS_LABELS: Record<TimeclockStatus, string> = {
  active: 'V teku/V čakanju',
  approved: 'Potrjeno',
  disputed: 'Sporno',
}

/** Odprti prehodi menedžerske recenzije (terminalnih stanj ni — recenzija je krožna) */
const ALLOWED_TRANSITIONS: Record<TimeclockStatus, TimeclockStatus[]> = {
  active: ['approved', 'disputed'],
  disputed: ['approved'],
  approved: ['disputed'],
}

export function canTransitionStatus(from: TimeclockStatus, to: TimeclockStatus): boolean {
  return from !== to && ALLOWED_TRANSITIONS[from].includes(to)
}

export function transitionStatusError(from: TimeclockStatus, to: TimeclockStatus): string {
  if (from === to) return `Vnos je že v stanju »${TIMECLOCK_STATUS_LABELS[from]}«.`
  return `Nedovoljen prehod »${TIMECLOCK_STATUS_LABELS[from]}« → »${TIMECLOCK_STATUS_LABELS[to]}«.`
}

/** Navedba ure v centih (snapshottano ob clock-in iz primarne delovne mesta) */
export function payRateToCents(payRate: number): number {
  return Math.round(payRate * 100)
}

/** Bruto minute izmenjave (strop; zaokroži na celo minuto) */
export function grossMinutes(clockInMs: number, clockOutMs: number): number {
  if (!(clockOutMs > clockInMs)) return 0
  return Math.round((clockOutMs - clockInMs) / 60000)
}

/** Skupaj minute (ISTA konvencija kot entryMinutesInRange v tips.ts) */
export function totalMinutesCalc(clockInMs: number, clockOutMs: number, breakMinutes: number): number {
  return Math.max(0, grossMinutes(clockInMs, clockOutMs) - Math.max(0, Math.round(breakMinutes || 0)))
}

/** Žive minute aktivnega vnosa (prikaz v UI) */
export function liveMinutes(clockInMs: number, nowMs: number, breakMinutes: number): number {
  return totalMinutesCalc(clockInMs, nowMs, breakMinutes)
}

/** Odmor delta v minutah (break-end) — zaokroženo navzdol na celo minuto */
export function breakDeltaMinutes(breakStartMs: number, breakEndMs: number): number {
  if (!(breakEndMs > breakStartMs)) return 0
  return Math.floor((breakEndMs - breakStartMs) / 60000)
}

/** Plačilo v centih: round(min × rateCents / 60) — celoštevilčno, brez drifta */
export function totalPayCents(totalMinutes: number, payRateCents: number): number {
  if (totalMinutes <= 0 || payRateCents <= 0) return 0
  return Math.round((totalMinutes * payRateCents) / 60)
}

export interface ManualEntryInput {
  clockInMs: number
  clockOutMs: number
  breakMinutes: number
  type: string
  note?: string
}

export interface ValidatedManualEntry {
  clockInMs: number
  clockOutMs: number
  breakMinutes: number
  type: TimeclockType
  note: string
}

const MAX_NOTE = 500
const MANUAL_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000
const FUTURE_SKEW_MS = 5 * 60 * 1000

/** Validacija ročnega (popravljenega) vnosa managerja — vrne { ok, error?, value? } */
export function validateManualEntry(input: ManualEntryInput, nowMs: number): { ok: boolean; error?: string; value?: ValidatedManualEntry } {
  const { clockInMs, clockOutMs } = input
  if (!Number.isFinite(clockInMs) || !Number.isFinite(clockOutMs)) {
    return { ok: false, error: 'Časa prijave in odjave sta obvezna.' }
  }
  if (clockOutMs <= clockInMs) {
    return { ok: false, error: 'Čas odjave mora biti za časom prijave.' }
  }
  if (clockInMs > nowMs + FUTURE_SKEW_MS) {
    return { ok: false, error: 'Prijava ne sme biti v prihodnosti.' }
  }
  if (clockInMs < nowMs - MANUAL_LOOKBACK_MS) {
    return { ok: false, error: 'Popravek je mogoč samo za zadnjih 31 dni.' }
  }
  const breakMinutes = Math.max(0, Math.round(Number(input.breakMinutes) || 0))
  const gross = grossMinutes(clockInMs, clockOutMs)
  if (breakMinutes > gross) {
    return { ok: false, error: `Odmor (${breakMinutes} min) ne sme biti daljši od izmene (${gross} min).` }
  }
  const type = String(input.type || 'regular') as TimeclockType
  if (!(TIMECLOCK_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: 'Neznan tip vnosa.' }
  }
  const note = String(input.note || '').trim().slice(0, MAX_NOTE)
  return { ok: true, value: { clockInMs, clockOutMs, breakMinutes, type, note } }
}

export interface TimeclockEntryLike {
  clockIn: Date | string
  clockOut: Date | string | null
  breakMinutes: number
  type: string
  status: string
}

const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime())

/** Statistika nad množico vnosov (minute po tipih, skupaj, potrjeno/sporno) */
export function timeclockStats(entries: TimeclockEntryLike[]) {
  let totalMinutes = 0
  const byType: Record<string, number> = {}
  let approvedMinutes = 0
  let disputedCount = 0
  let activeCount = 0
  for (const e of entries) {
    const st = e.status
    if (st === 'active') activeCount += 1
    if (st === 'disputed') disputedCount += 1
    const mins = e.clockOut
      ? totalMinutesCalc(ms(e.clockIn), ms(e.clockOut), e.breakMinutes)
      : 0 // aktiven vnos ni štet v skupaj (šteje se ob odjavi; živo v UI)
    totalMinutes += mins
    if (st === 'approved') approvedMinutes += mins
    byType[e.type] = (byType[e.type] || 0) + mins
  }
  const topType = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  return {
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 100) / 100,
    approvedMinutes,
    disputedCount,
    activeCount,
    byType,
    topType: topType as TimeclockType | null,
    entryCount: entries.length,
  }
}

/** "7 h 30 min" / "45 min" — prikaz trajanja */
export function durationLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}

/** plačilo label — "63,75 €" */
export function payLabel(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €'
}
