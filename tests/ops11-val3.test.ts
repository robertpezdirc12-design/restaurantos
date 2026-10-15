/**
 * OPS-11 val 3 (v1.82.0) — Vercel cron + AP overdue reminders, NO db fixtures.
 *
 * Covers:
 *  - src/lib/cron-daily.ts (pure): localDateKey, shouldRunDaily (daily-cron
 *    idempotency guard), startOfDay, daysOverdue, filterOverdueAps (open +
 *    dueDate < today 00:00, paid excluded, max 20 clamp).
 *  - src/lib/daily-email.ts: digest text builder — "Zapadle obveznosti"
 *    overdue-AP section (present only when entries exist), day-overdue wording,
 *    shiftSummaryEmailText output unchanged when the section is absent,
 *    dailyDigestEmailText subject/window label.
 *  - src/lib/push-events.ts: PUSH_EVENT_TYPES registry (AP_OVERDUE present, unique).
 *  - src/lib/push.ts: apOverduePushPayload payload shape.
 *
 * Pure data only — no DB, no auth, no fixtures.
 */
import { describe, expect, test } from 'bun:test'
import {
  localDateKey,
  shouldRunDaily,
  startOfDay,
  daysOverdue,
  filterOverdueAps,
  MAX_OVERDUE_APS,
  type ApOverdueLike,
} from '../src/lib/cron-daily'
import { shiftSummaryEmailText, dailyDigestEmailText, type ShiftSummaryData } from '../src/lib/daily-email'
import { PUSH_EVENT_TYPES } from '../src/lib/push-events'
import { apOverduePushPayload } from '../src/lib/push'

/** Fixed "now": 2025-06-15 12:00 local — day math is local-time by design. */
const NOW = new Date(2025, 5, 15, 12, 0, 0, 0)

const ap = (over: Partial<ApOverdueLike> = {}): ApOverdueLike => ({
  status: 'open',
  dueDate: new Date(2025, 5, 10, 8, 30), // 5 days before NOW
  ...over,
})

const baseDigest = (): ShiftSummaryData => ({
  shiftId: 's1',
  shiftDate: new Date(2025, 5, 14, 8, 0, 0),
  from: new Date(2025, 5, 14, 8, 0, 0),
  to: new Date(2025, 5, 14, 16, 0, 0),
  locationId: 'loc1',
  gross: 1220.5,
  net: 1000.41,
  vat: 220.09,
  covers: 38,
  payments: [{ method: 'cash', amount: 300 }],
  topItems: [{ name: 'Kruh', qty: 5 }],
})

/* ─────────── A) localDateKey ─────────── */

describe('ops11/3: localDateKey', () => {
  test('renders zero-padded YYYY-MM-DD in local time', () => {
    expect(localDateKey(NOW)).toBe('2025-06-15')
    expect(localDateKey(new Date(2025, 0, 3, 23, 59))).toBe('2025-01-03')
  })
  test('accepts ISO strings and returns "" for garbage', () => {
    expect(localDateKey('2025-06-15T10:00:00')).toBe('2025-06-15')
    expect(localDateKey('not-a-date')).toBe('')
    expect(localDateKey(null as unknown as Date)).toBe('')
  })
})

/* ─────────── B) shouldRunDaily (idempotency guard) ─────────── */

describe('ops11/3: shouldRunDaily (cron idempotency guard)', () => {
  test('runs when the marker is absent/empty/garbage', () => {
    expect(shouldRunDaily(null, NOW)).toBe(true)
    expect(shouldRunDaily(undefined, NOW)).toBe(true)
    expect(shouldRunDaily('', NOW)).toBe(true)
    expect(shouldRunDaily('garbage', NOW)).toBe(true)
  })
  test('skips when lastRunDate equals today (same-day Vercel retry)', () => {
    expect(shouldRunDaily('2025-06-15', NOW)).toBe(false)
    expect(shouldRunDaily('  2025-06-15  ', NOW)).toBe(false) // tolerant trim
  })
  test('runs when lastRunDate is yesterday or older', () => {
    expect(shouldRunDaily('2025-06-14', NOW)).toBe(true)
    expect(shouldRunDaily('2024-12-31', NOW)).toBe(true)
  })
  test('never runs when "today" itself is unparseable', () => {
    expect(shouldRunDaily(null, 'not-a-date')).toBe(false)
  })
})

/* ─────────── C) startOfDay + daysOverdue ─────────── */

describe('ops11/3: startOfDay + daysOverdue (digest zapadlost formatting)', () => {
  test('startOfDay zeroes time-of-day', () => {
    const d = startOfDay(new Date(2025, 5, 15, 12, 34, 56, 789))
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([2025, 5, 15, 0, 0, 0, 0])
  })
  test('yesterday = 1 day overdue; N days back = N', () => {
    expect(daysOverdue(new Date(2025, 5, 14, 23, 59), NOW)).toBe(1)
    expect(daysOverdue(new Date(2025, 5, 10), NOW)).toBe(5)
    expect(daysOverdue(new Date(2025, 4, 16), NOW)).toBe(30)
  })
  test('today/future = 0; time-of-day ignored', () => {
    expect(daysOverdue(new Date(2025, 5, 15, 0, 0), NOW)).toBe(0)
    expect(daysOverdue(new Date(2025, 5, 20), NOW)).toBe(0)
  })
  test('missing or invalid dueDate → 0 (never negative)', () => {
    expect(daysOverdue(null, NOW)).toBe(0)
    expect(daysOverdue('garbage', NOW)).toBe(0)
    expect(daysOverdue('2025-06-14', 'not-a-date')).toBe(0)
  })
})

/* ─────────── D) filterOverdueAps ─────────── */

describe('ops11/3: filterOverdueAps (open + dueDate < today, max clamp)', () => {
  test('selects open overdue, keeps input order', () => {
    const rows = [ap(), ap({ dueDate: new Date(2025, 5, 12) })]
    const out = filterOverdueAps(rows, NOW)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(rows[0])
  })
  test('excludes paid, other statuses and missing status', () => {
    const rows = [
      ap({ status: 'paid' }),
      ap({ status: 'void' }),
      ap({ status: null }),
      ap(),
    ]
    expect(filterOverdueAps(rows, NOW)).toEqual([rows[3]])
  })
  test('excludes due-today, future and missing/invalid dueDate', () => {
    const rows = [
      ap({ dueDate: new Date(2025, 5, 15, 0, 0) }), // today 00:00 — NOT strictly before
      ap({ dueDate: new Date(2025, 5, 20) }),
      ap({ dueDate: null }),
      ap({ dueDate: 'garbage' }),
      ap({ dueDate: '2025-06-10T00:00:00' }),
    ]
    expect(filterOverdueAps(rows, NOW)).toEqual([rows[4]])
  })
  test('clamps to MAX_OVERDUE_APS (20) and honors a custom max', () => {
    // 25 overdue rows (April 1..25 — all strictly before NOW)
    const many = Array.from({ length: 25 }, (_, i) => ap({ dueDate: new Date(2025, 3, 1 + i) }))
    expect(filterOverdueAps(many, NOW)).toHaveLength(MAX_OVERDUE_APS)
    expect(filterOverdueAps(many, NOW)).toHaveLength(20)
    expect(filterOverdueAps(many, NOW, 2)).toHaveLength(2)
    expect(filterOverdueAps(many, NOW, 0)).toHaveLength(0)
  })
  test('empty/null input → empty array', () => {
    expect(filterOverdueAps([], NOW)).toEqual([])
    expect(filterOverdueAps(null, NOW)).toEqual([])
    expect(filterOverdueAps(undefined, NOW)).toEqual([])
  })
})

/* ─────────── E) digest "Zapadle obveznosti" section ─────────── */

describe('ops11/3: digest overdue-AP section (Zapadle obveznosti)', () => {
  test('absent/empty overdueAps → NO section (optional)', () => {
    const { body } = shiftSummaryEmailText(baseDigest())
    expect(body).not.toContain('Zapadle obveznosti')
    const empty = shiftSummaryEmailText({ ...baseDigest(), overdueAps: [] })
    expect(empty.body).not.toContain('Zapadle obveznosti')
  })
  test('section renders apNumber, supplier, days-overdue wording and amount', () => {
    const { body } = shiftSummaryEmailText({
      ...baseDigest(),
      overdueAps: [
        { apNumber: 'AP-202506-000001', supplier: 'Mercator d.o.o.', daysOverdue: 1, amount: 100 },
        { apNumber: 'AP-202506-000002', supplier: 'Pekarna Kranj', daysOverdue: 2, amount: 42.5 },
        { apNumber: 'AP-202506-000003', supplier: 'Meta d.o.o.', daysOverdue: 5, amount: 1234.56 },
      ],
    })
    expect(body).toContain('Zapadle obveznosti (neplačani računi dobaviteljev):')
    expect(body).toContain('1. AP-202506-000001 · Mercator d.o.o. — 1 dan zamude · 100.00 EUR')
    expect(body).toContain('2. AP-202506-000002 · Pekarna Kranj — 2 dneva zamude · 42.50 EUR')
    expect(body).toContain('3. AP-202506-000003 · Meta d.o.o. — 5 dni zamude · 1234.56 EUR')
    // footer still last
    expect(body.trimEnd().endsWith('— Samodejno sporočilo RestavrantOS')).toBe(true)
  })
  test('dailyDigestEmailText: "dan" subject + Dan window label, same sections', () => {
    const d = dailyDigestEmailText(baseDigest())
    expect(d.subject).toContain('RestavrantOS — dnevni povzetek (dan')
    expect(d.body).toContain('Dan: 14. 06. 2025, 08:00')
    expect(d.body).not.toContain('Izmena:')
    const withAp = dailyDigestEmailText({
      ...baseDigest(),
      overdueAps: [{ apNumber: 'AP-1', supplier: 'X', daysOverdue: 3, amount: 9 }],
    })
    expect(withAp.body).toContain('Zapadle obveznosti')
  })
  test('shift builder keeps its legacy subject/label and stays byte-compatible without the new fields', () => {
    const { subject, body } = shiftSummaryEmailText(baseDigest())
    expect(subject).toContain('izmena')
    expect(body).toContain('Izmena: 14. 06. 2025, 08:00')
    expect(body).toContain('Dnevni povzetek prodaje')
  })
})

/* ─────────── F) AP_OVERDUE push registry + payload ─────────── */

describe('ops11/3: AP_OVERDUE push event', () => {
  test('registry: AP_OVERDUE present right after AP_NEW; unique; 16 types', () => {
    expect(PUSH_EVENT_TYPES).toContain('AP_OVERDUE')
    expect(PUSH_EVENT_TYPES.indexOf('AP_OVERDUE')).toBe(PUSH_EVENT_TYPES.indexOf('AP_NEW') + 1)
    expect(new Set(PUSH_EVENT_TYPES).size).toBe(PUSH_EVENT_TYPES.length)
    expect(PUSH_EVENT_TYPES.length).toBe(19) // v1.109.0: +HACCP_OVERDUE/HACCP_DEVIATION (#20)
  })
  test('apOverduePushPayload: shape {apNumber, supplierName, amount, daysOverdue} → notification text', () => {
    const p = apOverduePushPayload({ apNumber: 'AP-202506-000009', supplierName: 'Mercator d.o.o.', amount: 244, daysOverdue: 3 })
    expect(p.title).toBe('Zapadli račun dobavitelja')
    expect(p.body).toBe('AP-202506-000009 · Mercator d.o.o. · 244.00 € · zapadlo 3 dni')
    expect(p.url).toBe('/dashboard?tab=stroski')
    expect(p.tag).toBe('ap-overdue-AP-202506-000009')
  })
  test('apOverduePushPayload: singular/dual day wording and clamped negative input', () => {
    expect(apOverduePushPayload({ apNumber: 'A', supplierName: 'S', amount: 1, daysOverdue: 1 }).body).toContain('zapadlo 1 dan')
    expect(apOverduePushPayload({ apNumber: 'A', supplierName: 'S', amount: 1, daysOverdue: 2 }).body).toContain('zapadlo 2 dneva')
    expect(apOverduePushPayload({ apNumber: 'A', supplierName: 'S', amount: 1, daysOverdue: -5 }).body).toContain('zapadlo 0 dni')
  })
})
