/**
 * OPS-11 val 3 (v1.82.0) — PURE helpers for /api/cron/daily (DB-free, unit-tested).
 *
 * Zero imports by design: the daily-cron orchestration (route) and the digest
 * builder (daily-email.ts) both rely on these, and tests/ops11-val3.test.ts
 * covers them without any DB fixture.
 *
 * Integration marker persistence (zero DDL): an Integration row
 * (name='cron-daily-state', type='other', provider='internal') keeps
 *   { "lastRunDate": "YYYY-MM-DD", "lastRunAt": "ISO" }
 * so a Vercel cron retry on the same day is a no-op (200 + ran:false).
 */

/** Integration marker name for the daily-cron idempotency state. */
export const CRON_DAILY_MARKER = 'cron-daily-state'

/** Max overdue AccountsPayable rows processed per run (anti-spam clamp). */
export const MAX_OVERDUE_APS = 20

/** Local calendar date key 'YYYY-MM-DD' (local getters — DST-safe day math). */
export function localDateKey(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  if (!dt || isNaN(dt.getTime())) return ''
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Idempotency guard: the daily cron may run only once per LOCAL calendar day.
 * Empty/invalid/absent lastRunDate → run (fail-open: a corrupted marker must
 * not silently disable the daily job forever; worst case is a duplicate run,
 * and every step below is itself idempotent).
 */
export function shouldRunDaily(lastRunDate: unknown, today: Date | string): boolean {
  const todayKey = localDateKey(today)
  if (!todayKey) return false // cannot determine "today" → do not run
  const last = typeof lastRunDate === 'string' ? lastRunDate.trim() : ''
  return last !== todayKey
}

/** Midnight (00:00:00.000 local) of `d`'s calendar day. */
export function startOfDay(d: Date | string): Date {
  const dt = typeof d === 'string' ? new Date(d) : new Date(d.getTime())
  if (!dt || isNaN(dt.getTime())) return new Date(NaN)
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0)
}

/**
 * Full days overdue: today00:00 − due00:00 in whole days (>= 0; future → 0).
 * Time-of-day components are ignored (a dueDate at 23:59 yesterday is 1 day
 * overdue at 00:00 today).
 */
export function daysOverdue(dueDate: Date | string | null | undefined, today: Date | string): number {
  if (!dueDate) return 0
  const due = typeof dueDate === 'string' ? new Date(dueDate) : dueDate
  if (!due || isNaN(due.getTime())) return 0
  const t0 = startOfDay(today)
  if (isNaN(t0.getTime())) return 0
  const diff = t0.getTime() - startOfDay(due).getTime()
  return Math.max(0, Math.round(diff / 86_400_000))
}

/** Minimal structural type the AP filter needs (works on Prisma rows and fixtures). */
export interface ApOverdueLike {
  status?: string | null
  dueDate: Date | string | null
}

/**
 * Overdue supplier-invoice filter (pure): status EXACTLY 'open' (paid/void are
 * never nagged) AND dueDate strictly before today's midnight; result clamped to
 * `max` (default MAX_OVERDUE_APS = 20) ordered as given (caller sorts by dueDate).
 */
export function filterOverdueAps<T extends ApOverdueLike>(aps: readonly T[] | null | undefined, today: Date | string, max: number = MAX_OVERDUE_APS): T[] {
  const t0 = startOfDay(today)
  if (isNaN(t0.getTime())) return []
  return (aps || [])
    .filter((ap) => {
      if (!ap) return false
      if (String(ap.status || '').toLowerCase() !== 'open') return false
      if (!ap.dueDate) return false
      const due = typeof ap.dueDate === 'string' ? new Date(ap.dueDate) : ap.dueDate
      if (!due || isNaN(due.getTime())) return false
      return startOfDay(due).getTime() < t0.getTime()
    })
    .slice(0, Math.max(0, max))
}
