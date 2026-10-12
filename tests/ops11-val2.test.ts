/**
 * OPS-11 val 2 (v1.81.0) — display campaign schedule + AP_NEW push, NO db fixtures.
 *
 * Covers:
 *  - src/lib/display-promos.ts: isValidDateStr (strict 'YYYY-MM-DD' incl. leap-year
 *    and real-calendar checks), isAdInWindow (no bounds / start / end / both /
 *    inclusive boundaries / invalid-tolerant), sanitizePromos (invalid date field
 *    stripped, ad kept; valid dates verbatim), activeAds (window filtering +
 *    back-compat default now).
 *  - src/lib/push-events.ts: PUSH_EVENT_TYPES registry (AP_NEW present, unique).
 *  - src/lib/push.ts: apNewPushPayload (AP_NEW payload shape {apNumber, supplierName,
 *    amount, dueDate} → notification text; dueDate null tolerated).
 *
 * Pure data only — no DB, no auth, no fixtures.
 */
import { describe, expect, test } from 'bun:test'
import {
  isValidDateStr,
  isAdInWindow,
  sanitizePromos,
  activeAds,
  type DisplayPromo,
} from '../src/lib/display-promos'
import { PUSH_EVENT_TYPES } from '../src/lib/push-events'
import { apNewPushPayload, PUSH_EVENT_TYPES as PUSH_EVENTS_REEXPORT } from '../src/lib/push'

/** Fixed "now": 2025-06-15 12:00 local — window math is local-time by design. */
const NOW = new Date(2025, 5, 15, 12, 0, 0, 0)
const ad = (over: Partial<DisplayPromo> = {}): DisplayPromo => ({
  id: 'a1',
  imageUrl: 'https://a/1.jpg',
  durationSec: 10,
  active: true,
  ...over,
})

/* ─────────── A) isValidDateStr ─────────── */

describe('ops11/2: isValidDateStr (strict YYYY-MM-DD)', () => {
  test('valid dates accepted', () => {
    expect(isValidDateStr('2025-01-15')).toBe(true)
    expect(isValidDateStr('2024-02-29')).toBe(true) // leap year
    expect(isValidDateStr('2000-02-29')).toBe(true) // div-400 leap year
    expect(isValidDateStr(' 2025-12-31 ')).toBe(true) // tolerant trim
  })
  test('leap-year rules enforced', () => {
    expect(isValidDateStr('2023-02-29')).toBe(false)
    expect(isValidDateStr('1900-02-29')).toBe(false) // div-100, not div-400
    expect(isValidDateStr('2024-02-30')).toBe(false)
  })
  test('format strictly enforced (no datetime, no alt separators)', () => {
    for (const bad of ['2025-1-5', '15.01.2025', '2025/01/15', '2025-01-15T00:00:00', '20250115', '', 'x', '2025-01-15x']) {
      expect(isValidDateStr(bad)).toBe(false)
    }
  })
  test('impossible calendar dates and non-strings rejected', () => {
    expect(isValidDateStr('2025-13-01')).toBe(false)
    expect(isValidDateStr('2025-00-10')).toBe(false)
    expect(isValidDateStr('2025-01-00')).toBe(false)
    expect(isValidDateStr('2025-01-32')).toBe(false)
    expect(isValidDateStr('2025-04-31')).toBe(false)
    expect(isValidDateStr(42)).toBe(false)
    expect(isValidDateStr(null)).toBe(false)
    expect(isValidDateStr(undefined)).toBe(false)
    expect(isValidDateStr(new Date())).toBe(false)
  })
})

/* ─────────── B) isAdInWindow ─────────── */

describe('ops11/2: isAdInWindow (inclusive local bounds at fixed NOW 2025-06-15 12:00)', () => {
  test('no bounds (or garbage ad) → always in window', () => {
    expect(isAdInWindow({}, NOW)).toBe(true)
    expect(isAdInWindow({ startDate: undefined, endDate: undefined }, NOW)).toBe(true)
    expect(isAdInWindow(null as unknown as { startDate?: string }, NOW)).toBe(true)
  })
  test('start-only: inclusive at 00:00:00.000 of the start day', () => {
    expect(isAdInWindow({ startDate: '2025-06-15' }, NOW)).toBe(true) // same day 12:00
    expect(isAdInWindow({ startDate: '2025-06-14' }, NOW)).toBe(true) // started yesterday
    expect(isAdInWindow({ startDate: '2025-06-16' }, NOW)).toBe(false) // tomorrow
    expect(isAdInWindow({ startDate: '2025-06-15' }, new Date(2025, 5, 15, 0, 0, 0, 0))).toBe(true) // exact midnight
    expect(isAdInWindow({ startDate: '2025-06-15' }, new Date(2025, 5, 14, 23, 59, 59, 999))).toBe(false)
  })
  test('end-only: inclusive through 23:59:59.999 of the end day', () => {
    expect(isAdInWindow({ endDate: '2025-06-15' }, NOW)).toBe(true) // last day
    expect(isAdInWindow({ endDate: '2025-06-16' }, NOW)).toBe(true) // ends tomorrow
    expect(isAdInWindow({ endDate: '2025-06-14' }, NOW)).toBe(false) // ended yesterday
    expect(isAdInWindow({ endDate: '2025-06-15' }, new Date(2025, 5, 15, 23, 59, 59, 999))).toBe(true) // last ms
    expect(isAdInWindow({ endDate: '2025-06-15' }, new Date(2025, 5, 16, 0, 0, 0, 0))).toBe(false) // next day
  })
  test('both bounds: open only inside [start 00:00, end 23:59:59.999]', () => {
    const w = { startDate: '2025-06-10', endDate: '2025-06-20' }
    expect(isAdInWindow(w, NOW)).toBe(true)
    expect(isAdInWindow(w, new Date(2025, 5, 10, 0, 0, 0, 0))).toBe(true)
    expect(isAdInWindow(w, new Date(2025, 5, 20, 23, 59, 59, 999))).toBe(true)
    expect(isAdInWindow(w, new Date(2025, 5, 9, 23, 59, 59, 999))).toBe(false)
    expect(isAdInWindow(w, new Date(2025, 5, 21, 0, 0, 0, 0))).toBe(false)
  })
  test('invalid date strings are tolerant → treated as no bound', () => {
    expect(isAdInWindow({ startDate: 'garbage' }, NOW)).toBe(true)
    expect(isAdInWindow({ endDate: '2025-13-40' }, NOW)).toBe(true)
    expect(isAdInWindow({ startDate: 'nope', endDate: '2025-06-14' }, NOW)).toBe(false) // valid end still applies
    expect(isAdInWindow({ startDate: '2025-06-16', endDate: 'junk' }, NOW)).toBe(false) // valid start still applies
  })
})

/* ─────────── C) sanitizePromos with schedule ─────────── */

describe('ops11/2: sanitizePromos — campaign date fields', () => {
  test('valid dates kept verbatim; absent dates stay absent', () => {
    const out = sanitizePromos(
      { ads: [{ id: 'w1', imageUrl: 'https://a/1.jpg', durationSec: 10, startDate: '2025-06-01', endDate: '2025-06-30' }] },
      NOW,
    )
    expect(out.ads.length).toBe(1)
    expect(out.ads[0].startDate).toBe('2025-06-01')
    expect(out.ads[0].endDate).toBe('2025-06-30')
    const bare = sanitizePromos({ ads: [{ imageUrl: 'https://a/2.jpg' }] }, NOW)
    expect(bare.ads[0].startDate).toBeUndefined()
    expect(bare.ads[0].endDate).toBeUndefined()
  })
  test('invalid date → FIELD stripped, the ad itself is kept (tolerant, not dropped)', () => {
    const out = sanitizePromos(
      { ads: [{ id: 'w2', imageUrl: 'https://a/2.jpg', durationSec: 10, startDate: '15.06.2025', endDate: '2025-02-30' }] },
      NOW,
    )
    expect(out.ads.length).toBe(1)
    expect(out.ads[0].id).toBe('w2')
    expect(out.ads[0].imageUrl).toBe('https://a/2.jpg')
    expect(out.ads[0].startDate).toBeUndefined()
    expect(out.ads[0].endDate).toBeUndefined()
  })
  test('mixed validity: valid bound kept while the invalid sibling is stripped', () => {
    const out = sanitizePromos(
      { ads: [{ id: 'w3', imageUrl: 'https://a/3.jpg', durationSec: 10, startDate: '2025-06-01', endDate: 42 }] },
      NOW,
    )
    expect(out.ads[0].startDate).toBe('2025-06-01')
    expect(out.ads[0].endDate).toBeUndefined()
  })
})

/* ─────────── D) activeAds with windows + back-compat ─────────── */

describe('ops11/2: activeAds — window filtering (fixed NOW)', () => {
  test('upcoming (start in the future) excluded; ended (end in the past) excluded; in-window included', () => {
    const ads: DisplayPromo[] = [
      ad({ id: 'future', startDate: '2025-06-16' }),
      ad({ id: 'past', endDate: '2025-06-14' }),
      ad({ id: 'current', startDate: '2025-06-01', endDate: '2025-06-30' }),
      ad({ id: 'noschedule' }),
    ]
    expect(activeAds(ads, NOW).map((a) => a.id)).toEqual(['current', 'noschedule'])
  })
  test('inactive ads stay excluded regardless of the window', () => {
    const ads: DisplayPromo[] = [
      ad({ id: 'off', active: false, startDate: '2025-06-01', endDate: '2025-06-30' }),
      ad({ id: 'on', active: true, startDate: '2025-06-01', endDate: '2025-06-30' }),
    ]
    expect(activeAds(ads, NOW).map((a) => a.id)).toEqual(['on'])
  })
  test('boundary days are inclusive: first and last campaign day are shown', () => {
    const ads: DisplayPromo[] = [ad({ id: 'first', startDate: '2025-06-15', endDate: '2025-06-20' })]
    expect(activeAds(ads, NOW).map((a) => a.id)).toEqual(['first'])
    const adsEnd: DisplayPromo[] = [ad({ id: 'last', startDate: '2025-06-10', endDate: '2025-06-15' })]
    expect(activeAds(adsEnd, NOW).map((a) => a.id)).toEqual(['last'])
  })
  test('back-compat: no window + no now argument → exactly the pre-1.81 behavior (active only)', () => {
    const ads: DisplayPromo[] = [
      { id: '1', imageUrl: 'https://a/1.jpg', durationSec: 10, active: true },
      { id: '2', imageUrl: 'https://a/2.jpg', durationSec: 10, active: false },
      { id: '3', imageUrl: 'https://a/3.jpg', durationSec: 10, active: true },
    ]
    expect(activeAds(ads).map((a) => a.id)).toEqual(['1', '3'])
    expect(activeAds([])).toEqual([])
    expect(activeAds(undefined as unknown as DisplayPromo[])).toEqual([])
  })
})

/* ─────────── E) AP_NEW push registry + payload ─────────── */

describe('ops11/2: AP_NEW push event', () => {
  test('registry: AP_NEW added next to the PO_* types; 14 unique event types (14th: OPS-11 val 3 AP_OVERDUE)', () => {
    expect(PUSH_EVENT_TYPES).toContain('AP_NEW')
    expect(PUSH_EVENT_TYPES.indexOf('AP_NEW')).toBe(PUSH_EVENT_TYPES.indexOf('PO_RECEIVED') + 1)
    expect(new Set(PUSH_EVENT_TYPES).size).toBe(PUSH_EVENT_TYPES.length)
    // OPS-11 val 3 (v1.82.0): AP_OVERDUE appended after AP_NEW → 13 → 14
    expect(PUSH_EVENT_TYPES.length).toBe(14)
    // push.ts re-exports the client-safe registry (back-compat for '@/lib/push' imports)
    expect(PUSH_EVENTS_REEXPORT).toBe(PUSH_EVENT_TYPES)
  })
  test('apNewPushPayload: AP_NEW shape {apNumber, supplierName, amount, dueDate} → notification text', () => {
    const p = apNewPushPayload({ apNumber: 'AP-2025-0042', supplierName: 'Mercator d.o.o.', amount: 244, dueDate: '2026-10-20T00:00:00.000Z' })
    expect(p.title).toBe('Nov dobaviteljev račun')
    expect(p.body).toBe('AP-2025-0042 · Mercator d.o.o. · 244.00 € · zapade 2026-10-20')
    expect(p.url).toBe('/dashboard?tab=stroski')
    expect(p.tag).toBe('ap-new-AP-2025-0042')
  })
  test('apNewPushPayload: dueDate null tolerated (no "zapade" suffix)', () => {
    const p = apNewPushPayload({ apNumber: 'AP-2025-0007', supplierName: 'Razno', amount: 10, dueDate: null })
    expect(p.body).toBe('AP-2025-0007 · Razno · 10.00 €')
  })
})
