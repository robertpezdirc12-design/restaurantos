/**
 * OPS-9 val 3 (v1.76.0) — pure units, NO db fixtures.
 *
 * Covers:
 *  - src/lib/kds-delays.ts: delay threshold decision (prepMin > 10 → reason dialog),
 *    computePrepMin (firedAt → minutes, skew guarded), catalog validation,
 *    audit details payload (prepMin rounded to 1 decimal).
 *  - src/lib/kds-stats.ts: kdsDelayCounts — AuditLog KDS_DELAY details aggregation
 *    over the fixed catalog (unknown/garbage skipped, sorted desc).
 *  - src/lib/delivery.ts: auto-accept config resolution (enabled + provider match;
 *    disabled; unknown provider; garbage config defaults) + ETA pickup.
 *  - src/lib/allergens.ts: parseAllergens (comma / JSON array / dedupe), chip union,
 *    exclusion filter (selected → hidden, empty → all visible).
 *
 * Pure data only — no DB, no auth, no fixtures.
 */
import { describe, expect, test } from 'bun:test'
import {
  KDS_DELAY_REASONS,
  KDS_DELAY_THRESHOLD_MIN,
  shouldAskDelayReason,
  isValidDelayReason,
  computePrepMin,
  kdsDelayDetails,
} from '../src/lib/kds-delays'
import { kdsDelayCounts } from '../src/lib/kds-stats'
import {
  resolveAutoAcceptConfig,
  autoAcceptsProvider,
  estimatedTimeFromMinutes,
  DELIVERY_AUTO_ACCEPT_PROVIDERS,
} from '../src/lib/delivery'
import { parseAllergens, allergenUnion, filterByAllergens } from '../src/lib/allergens'

/* ─────────── A) KDS delay threshold decision ─────────── */

describe('kds-delays: shouldAskDelayReason (prepMin > 10 → dialog)', () => {
  test('strictly above threshold', () => {
    expect(shouldAskDelayReason(KDS_DELAY_THRESHOLD_MIN + 0.1)).toBe(true)
    expect(shouldAskDelayReason(10.5)).toBe(true)
    expect(shouldAskDelayReason(45)).toBe(true)
  })
  test('at or below threshold → direct bump (no dialog)', () => {
    expect(shouldAskDelayReason(10)).toBe(false)
    expect(shouldAskDelayReason(9.99)).toBe(false)
    expect(shouldAskDelayReason(0)).toBe(false)
  })
  test('missing / unusable data → no dialog', () => {
    expect(shouldAskDelayReason(null)).toBe(false)
    expect(shouldAskDelayReason(undefined)).toBe(false)
    expect(shouldAskDelayReason(Number.NaN)).toBe(false)
  })
})

describe('kds-delays: computePrepMin + catalog validation', () => {
  test('(now − firedAt)/60000', () => {
    const fired = new Date('2026-01-15T18:00:00Z')
    const now = new Date(fired.getTime() + 12.5 * 60000)
    expect(computePrepMin(fired, now)).toBeCloseTo(12.5, 6)
  })
  test('no firedAt or negative diff → null (skew guarded)', () => {
    expect(computePrepMin(null, new Date())).toBeNull()
    const now = new Date('2026-01-15T18:00:00Z')
    expect(computePrepMin(new Date(now.getTime() + 60000), now)).toBeNull()
  })
  test('catalog membership', () => {
    expect(KDS_DELAY_REASONS).toEqual(['out_of_stock', 'busy', 'equipment', 'redo', 'other'])
    expect(isValidDelayReason('busy')).toBe(true)
    expect(isValidDelayReason('out_of_stock')).toBe(true)
    expect(isValidDelayReason('free_text')).toBe(false)
    expect(isValidDelayReason(42)).toBe(false)
    expect(isValidDelayReason(null)).toBe(false)
  })
  test('audit details: prepMin rounded to 1 decimal, full payload shape', () => {
    const d = kdsDelayDetails({ orderItemId: 'i1', menuItemName: 'Burek', reason: 'busy', prepMin: 12.349999, orderId: 'o1' })
    expect(d).toEqual({ orderItemId: 'i1', menuItemName: 'Burek', reason: 'busy', prepMin: 12.3, orderId: 'o1' })
  })
})

describe('kds-stats: kdsDelayCounts (AuditLog KDS_DELAY aggregation)', () => {
  test('counts per catalog reason, sorted desc', () => {
    const rows = [
      { details: JSON.stringify({ reason: 'busy' }) },
      { details: JSON.stringify({ reason: 'busy' }) },
      { details: JSON.stringify({ reason: 'out_of_stock' }) },
      { details: JSON.stringify({ reason: 'other' }) },
    ]
    expect(kdsDelayCounts(rows)).toEqual([
      { reason: 'busy', count: 2 },
      { reason: 'other', count: 1 },
      { reason: 'out_of_stock', count: 1 },
    ])
  })
  test('unknown / missing / unparseable reasons skipped', () => {
    const rows = [
      { details: JSON.stringify({ reason: 'not_in_catalog' }) },
      { details: JSON.stringify({ nope: true }) },
      { details: 'not-json{{' },
      { details: null },
      {},
    ]
    expect(kdsDelayCounts(rows)).toEqual([])
  })
  test('empty input → empty report', () => {
    expect(kdsDelayCounts([])).toEqual([])
  })
})

/* ─────────── B) Delivery auto-accept config ─────────── */

describe('delivery auto-accept: resolveAutoAcceptConfig', () => {
  test('missing config → defaults (enabled=true, all providers) — backward compatible', () => {
    expect(resolveAutoAcceptConfig(null)).toEqual({ enabled: true, providers: ['glovo', 'wolt'] })
    expect(resolveAutoAcceptConfig(undefined)).toEqual({ enabled: true, providers: ['glovo', 'wolt'] })
    expect(resolveAutoAcceptConfig('garbage')).toEqual({ enabled: true, providers: ['glovo', 'wolt'] })
    expect(resolveAutoAcceptConfig(['not-an-object'])).toEqual({ enabled: true, providers: ['glovo', 'wolt'] })
  })
  test('explicit enabled + provider match', () => {
    const cfg = resolveAutoAcceptConfig({ enabled: true, providers: ['Glovo'] })
    expect(cfg.enabled).toBe(true)
    expect(autoAcceptsProvider(cfg, 'glovo')).toBe(true)
    expect(autoAcceptsProvider(cfg, 'GLOVO')).toBe(true)
  })
  test('disabled → no provider matches', () => {
    const cfg = resolveAutoAcceptConfig({ enabled: false, providers: ['glovo', 'wolt'] })
    expect(cfg.enabled).toBe(false)
    expect(autoAcceptsProvider(cfg, 'glovo')).toBe(false)
    expect(autoAcceptsProvider(cfg, 'wolt')).toBe(false)
  })
  test('unknown provider never matches; unknown providers filtered out of config', () => {
    const cfg = resolveAutoAcceptConfig({ enabled: true, providers: ['uber_eats', 'glovo', '', 'WOLT'] })
    expect(cfg.providers).toEqual(['glovo', 'wolt'])
    expect(autoAcceptsProvider(cfg, 'uber_eats')).toBe(false)
    expect(autoAcceptsProvider(cfg, 'wolt')).toBe(true)
  })
  test('enabled with empty/invalid providers falls back to the known set', () => {
    const cfg = resolveAutoAcceptConfig({ enabled: true, providers: [] })
    expect(cfg.providers).toEqual([...DELIVERY_AUTO_ACCEPT_PROVIDERS])
    expect(resolveAutoAcceptConfig({ enabled: true, providers: 'nope' }).providers).toEqual(['glovo', 'wolt'])
  })
  test('fallbackEnabled=false when the caller requires it', () => {
    expect(resolveAutoAcceptConfig(null, false).enabled).toBe(false)
    expect(resolveAutoAcceptConfig({}, false).enabled).toBe(false)
  })
})

describe('delivery auto-accept: estimatedTimeFromMinutes (ETA pickup)', () => {
  test('positive minutes → future Date', () => {
    const now = new Date('2026-01-15T18:00:00Z')
    const eta = estimatedTimeFromMinutes(35, now)
    expect(eta).not.toBeNull()
    expect(eta!.getTime()).toBe(now.getTime() + 35 * 60000)
  })
  test('garbage / out-of-range → null (skip ETA entirely)', () => {
    expect(estimatedTimeFromMinutes(undefined, new Date())).toBeNull()
    expect(estimatedTimeFromMinutes('abc', new Date())).toBeNull()
    expect(estimatedTimeFromMinutes(0, new Date())).toBeNull()
    expect(estimatedTimeFromMinutes(-5, new Date())).toBeNull()
    expect(estimatedTimeFromMinutes(5000, new Date())).toBeNull()
  })
})

/* ─────────── C) QR menu allergen filter ─────────── */

const ITEMS = [
  { id: 'a', name: 'Burek', allergens: 'gluten, laktoza' },
  { id: 'b', name: 'Salata', allergens: '' },
  { id: 'c', name: 'Sir', allergens: 'laktoza' },
  { id: 'd', name: 'Kolač', allergens: 'gluten; jajca, Oreščki' },
]

describe('allergens: parseAllergens (write format = comma-separated string)', () => {
  test('comma / semicolon / slash separators, trimmed', () => {
    expect(parseAllergens('gluten, laktoza')).toEqual(['gluten', 'laktoza'])
    expect(parseAllergens('gluten;jajca')).toEqual(['gluten', 'jajca'])
    expect(parseAllergens(' gluten / oreščki ')).toEqual(['gluten', 'oreščki'])
  })
  test('empty / null / whitespace → []', () => {
    expect(parseAllergens('')).toEqual([])
    expect(parseAllergens(null)).toEqual([])
    expect(parseAllergens(undefined)).toEqual([])
    expect(parseAllergens('   ')).toEqual([])
  })
  test('JSON array string tolerated (defensive)', () => {
    expect(parseAllergens('["gluten","laktoza"]')).toEqual(['gluten', 'laktoza'])
    expect(parseAllergens('["gluten", 42]')).toEqual(['gluten'])
  })
  test('case-insensitive dedupe, first casing wins', () => {
    expect(parseAllergens('Gluten, GLUTEN, gluten')).toEqual(['Gluten'])
  })
})

describe('allergens: chip union across items', () => {
  test('union preserves first-seen order/casing, deduped', () => {
    expect(allergenUnion(ITEMS, (it) => it.allergens)).toEqual(['gluten', 'laktoza', 'jajca', 'Oreščki'])
  })
})

describe('allergens: exclusion filter', () => {
  test('empty selection → all visible', () => {
    expect(filterByAllergens(ITEMS, (it) => it.allergens, []).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })
  test('item matching a selected allergen is HIDDEN', () => {
    expect(filterByAllergens(ITEMS, (it) => it.allergens, ['gluten']).map((i) => i.id)).toEqual(['b', 'c'])
  })
  test('multi-select hides every item containing ANY selected allergen', () => {
    expect(filterByAllergens(ITEMS, (it) => it.allergens, ['gluten', 'laktoza']).map((i) => i.id)).toEqual(['b'])
  })
  test('selection is case-insensitive against data', () => {
    expect(filterByAllergens(ITEMS, (it) => it.allergens, ['OREŠČKI']).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})
