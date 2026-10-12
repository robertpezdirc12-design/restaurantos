/**
 * OPS-10 val 2 (v1.78.0) — front-of-house pure units, NO db fixtures.
 *
 * Covers:
 *  - src/lib/upsell.ts: sanitizeUpsellConfig (unknown ids, self-reference,
 *    duplicates, max 3 per item, max 200 items, garbage input) + upsellsForItemId
 *    (copy semantics, cap, absent key).
 *  - src/lib/display-promos.ts: sanitizePromos (bad URL rejected, durationSec
 *    clamp 5-120, default 15, max 5, id dedupe, auto-generated id, active default,
 *    string/tolerant input) + activeAds (only active).
 *
 * Pure data only — no DB, no auth, no fixtures.
 */
import { describe, expect, test } from 'bun:test'
import {
  MAX_UPSELLS,
  MAX_UPSELL_ITEMS,
  sanitizeUpsellConfig,
  upsellsForItemId,
} from '../src/lib/upsell'
import {
  MAX_PROMOS,
  DEFAULT_PROMO_DURATION_SEC,
  MIN_PROMO_DURATION_SEC,
  MAX_PROMO_DURATION_SEC,
  isValidPromoUrl,
  sanitizePromos,
  activeAds,
  type DisplayPromo,
} from '../src/lib/display-promos'

/* ─────────── A) Kiosk upsell config ─────────── */

describe('upsell: sanitizeUpsellConfig', () => {
  const ids = new Set(['a', 'b', 'c', 'd'])

  test('unknown ids removed (keys and suggestions)', () => {
    const out = sanitizeUpsellConfig({ a: ['x', 'b'], ghost: ['b'] }, ids)
    expect(out).toEqual({ a: ['b'] })
  })
  test('self-reference removed', () => {
    expect(sanitizeUpsellConfig({ a: ['a', 'b'] }, ids)).toEqual({ a: ['b'] })
  })
  test('duplicates removed, order preserved', () => {
    expect(sanitizeUpsellConfig({ a: ['b', 'b', 'c', 'b'] }, ids)).toEqual({ a: ['b', 'c'] })
  })
  test('max 3 suggestions per item (MAX_UPSELLS)', () => {
    const raw = { a: ['b', 'c', 'd', 'a', 'b'] } // 5 valid-ish candidates
    const out = sanitizeUpsellConfig(raw, ids)
    expect(Object.keys(out)).toEqual(['a'])
    expect(out.a.length).toBe(MAX_UPSELLS)
    expect(out.a).toEqual(['b', 'c', 'd'])
  })
  test('max 200 items kept (first N by appearance)', () => {
    const valid = new Set(Array.from({ length: 400 }, (_, i) => `i${i}`))
    const raw: Record<string, string[]> = {}
    for (let i = 0; i < 250; i++) raw[`i${i}`] = [`i${i + 1}`]
    const out = sanitizeUpsellConfig(raw, valid)
    expect(Object.keys(out).length).toBe(MAX_UPSELL_ITEMS)
    expect(out['i0']).toEqual(['i1']) // first ones survive
    expect(out['i249']).toBeUndefined() // beyond the cap dropped
  })
  test('non-object input → {} (string/array/null/undefined/number)', () => {
    for (const bad of ['{"a":["b"]}', ['a'], null, undefined, 42, true]) {
      expect(sanitizeUpsellConfig(bad, ids)).toEqual({})
    }
  })
  test('non-array / empty suggestion lists are dropped', () => {
    expect(sanitizeUpsellConfig({ a: 'b', b: [], c: ['a'] }, ids)).toEqual({ c: ['a'] })
  })
  test('garbage entries inside the array are skipped', () => {
    expect(sanitizeUpsellConfig({ a: [null, 42, {}, '   ', 'b'] }, ids)).toEqual({ a: ['b'] })
  })
  test('ids are trimmed', () => {
    expect(sanitizeUpsellConfig({ ' a ': ['  b  '] }, ids)).toEqual({ a: ['b'] })
  })
})

describe('upsell: upsellsForItemId', () => {
  test('returns a copy capped at MAX_UPSELLS', () => {
    const cfg = { a: ['b', 'c', 'd', 'e'] }
    const out = upsellsForItemId(cfg, 'a')
    expect(out).toEqual(['b', 'c', 'd'])
    // copy semantics: mutating the result must not touch the config
    out.push('x')
    expect(cfg.a).toEqual(['b', 'c', 'd', 'e'])
  })
  test('absent key / bad config → []', () => {
    expect(upsellsForItemId({ a: ['b'] }, 'zz')).toEqual([])
    expect(upsellsForItemId({} as Record<string, string[]>, 'a')).toEqual([])
    expect(upsellsForItemId(undefined as unknown as Record<string, string[]>, 'a')).toEqual([])
    expect(upsellsForItemId({ a: 'nope' } as unknown as Record<string, string[]>, 'a')).toEqual([])
  })
})

/* ─────────── B) Display promos ─────────── */

describe('promos: isValidPromoUrl', () => {
  test('http(s) accepted, other schemes and garbage rejected', () => {
    expect(isValidPromoUrl('https://cdn.example.com/x.jpg')).toBe(true)
    expect(isValidPromoUrl('http://10.0.0.2/a.png')).toBe(true)
    expect(isValidPromoUrl('javascript:alert(1)')).toBe(false)
    expect(isValidPromoUrl('data:image/png;base64,AAAA')).toBe(false)
    expect(isValidPromoUrl('ftp://x/y')).toBe(false)
    expect(isValidPromoUrl('not a url')).toBe(false)
    expect(isValidPromoUrl('')).toBe(false)
    expect(isValidPromoUrl(42)).toBe(false)
    expect(isValidPromoUrl(null)).toBe(false)
  })
})

describe('promos: sanitizePromos', () => {
  test('bad URL entries dropped, good ones kept', () => {
    const out = sanitizePromos({
      ads: [
        { imageUrl: 'https://a.example/x.jpg', durationSec: 10, active: true },
        { imageUrl: 'javascript:alert(1)', durationSec: 10, active: true },
        { imageUrl: '', durationSec: 10, active: true },
        { imageUrl: 'https://b.example/y.jpg' },
      ],
    })
    expect(out.ads.length).toBe(2)
    expect(out.ads[0].imageUrl).toBe('https://a.example/x.jpg')
    expect(out.ads[1].imageUrl).toBe('https://b.example/y.jpg')
  })
  test('durationSec clamped to 5-120, default 15', () => {
    const out = sanitizePromos({
      ads: [
        { imageUrl: 'https://a/1.jpg', durationSec: 1 },
        { imageUrl: 'https://a/2.jpg', durationSec: 999 },
        { imageUrl: 'https://a/3.jpg', durationSec: 15.7 },
        { imageUrl: 'https://a/4.jpg', durationSec: 'oops' },
        { imageUrl: 'https://a/5.jpg' },
      ],
    })
    expect(out.ads[0].durationSec).toBe(MIN_PROMO_DURATION_SEC)
    expect(out.ads[1].durationSec).toBe(MAX_PROMO_DURATION_SEC)
    expect(out.ads[2].durationSec).toBe(16) // rounded
    expect(out.ads[3].durationSec).toBe(DEFAULT_PROMO_DURATION_SEC)
    expect(out.ads[4].durationSec).toBe(DEFAULT_PROMO_DURATION_SEC)
  })
  test('max 5 promos', () => {
    const raw = { ads: Array.from({ length: 9 }, (_, i) => ({ imageUrl: `https://a/${i}.jpg`, durationSec: 10 })) }
    expect(sanitizePromos(raw).ads.length).toBe(MAX_PROMOS)
  })
  test('duplicate ids deduped (first wins); missing id auto-generated', () => {
    const out = sanitizePromos({
      ads: [
        { id: 'same', imageUrl: 'https://a/1.jpg', durationSec: 10 },
        { id: 'same', imageUrl: 'https://a/2.jpg', durationSec: 10 },
        { imageUrl: 'https://a/3.jpg', durationSec: 10 },
      ],
    })
    expect(out.ads.length).toBe(3)
    expect(out.ads[0].id).toBe('same')
    expect(out.ads[1].id).not.toBe('same')
    expect(out.ads[2].id).toBeTruthy()
    expect(new Set(out.ads.map((a) => a.id)).size).toBe(3)
  })
  test('active defaults to true; explicit false preserved', () => {
    const out = sanitizePromos({
      ads: [
        { imageUrl: 'https://a/1.jpg', durationSec: 10 },
        { imageUrl: 'https://a/2.jpg', durationSec: 10, active: false },
        { imageUrl: 'https://a/3.jpg', durationSec: 10, active: 'yes' },
      ],
    })
    expect(out.ads[0].active).toBe(true)
    expect(out.ads[1].active).toBe(false)
    expect(out.ads[2].active).toBe(true) // only a real false deactivates
  })
  test('garbage input → { ads: [] } (string JSON included)', () => {
    expect(sanitizePromos(null).ads).toEqual([])
    expect(sanitizePromos(42).ads).toEqual([])
    expect(sanitizePromos({ nope: 1 }).ads).toEqual([])
    expect(sanitizePromos({ ads: 'nope' }).ads).toEqual([])
    expect(sanitizePromos('not json').ads).toEqual([])
    const parsed = sanitizePromos('{"ads":[{"imageUrl":"https://a/1.jpg","durationSec":10}]}')
    expect(parsed.ads.length).toBe(1)
    expect(parsed.ads[0].imageUrl).toBe('https://a/1.jpg')
  })
  test('non-object entries inside ads are skipped', () => {
    const out = sanitizePromos({ ads: [null, 'x', 7, { imageUrl: 'https://a/1.jpg', durationSec: 12 }] })
    expect(out.ads.length).toBe(1)
    expect(out.ads[0].durationSec).toBe(12)
  })
})

describe('promos: activeAds', () => {
  test('only active promos pass through', () => {
    const ads: DisplayPromo[] = [
      { id: '1', imageUrl: 'https://a/1.jpg', durationSec: 10, active: true },
      { id: '2', imageUrl: 'https://a/2.jpg', durationSec: 10, active: false },
      { id: '3', imageUrl: 'https://a/3.jpg', durationSec: 10, active: true },
    ]
    expect(activeAds(ads).map((a) => a.id)).toEqual(['1', '3'])
  })
  test('empty / garbage input → []', () => {
    expect(activeAds([])).toEqual([])
    expect(activeAds(undefined as unknown as DisplayPromo[])).toEqual([])
    expect(activeAds(null as unknown as DisplayPromo[])).toEqual([])
  })
})
