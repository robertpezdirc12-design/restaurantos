/**
 * OPS-11 val 1 (v1.80.0) — visual menu thumbnails + KDS per-station delay threshold.
 * Pure units, NO db fixtures.
 *
 * Covers:
 *  - src/lib/kds-delays.ts OPS-11 additions:
 *      delayThresholdForTarget(target) = max(10, ceil(target × 1.25)),
 *        invalid target (< 1, NaN, null, undefined) → the global 10;
 *      isLatePrep(prepMin, target?) — strictly above the resolved threshold,
 *        WITHOUT a target = the historical global 10 min (back-compat parity
 *        with shouldAskDelayReason);
 *      kdsDelayDetails — optional additive `threshold` key (legacy shape intact
 *        when the threshold is not resolved).
 *
 * Pure data only — no DB, no auth, no fixtures.
 */
import { describe, it, expect } from 'bun:test'
import {
  KDS_DELAY_THRESHOLD_MIN,
  delayThresholdForTarget,
  isLatePrep,
  shouldAskDelayReason,
  kdsDelayDetails,
} from '../src/lib/kds-delays'

describe('OPS-11 delayThresholdForTarget (max(10, ceil(target × 1.25)))', () => {
  it('missing / unusable target → global 10', () => {
    expect(delayThresholdForTarget(undefined)).toBe(10)
    expect(delayThresholdForTarget(null)).toBe(10)
    expect(delayThresholdForTarget(Number.NaN)).toBe(10)
    expect(delayThresholdForTarget(0)).toBe(10)
    expect(delayThresholdForTarget(-5)).toBe(10)
  })
  it('targets whose scaled value stays below 10 → clamped to 10', () => {
    expect(delayThresholdForTarget(5)).toBe(10) // ceil(6.25) = 7 → max(10, 7)
    expect(delayThresholdForTarget(3.9)).toBe(10) // ceil(4.875) = 5 → max(10, 5)
    expect(delayThresholdForTarget(1)).toBe(10) // ceil(1.25) = 2
    expect(delayThresholdForTarget(7.9)).toBe(10) // ceil(9.875) = 10 → max(10, 10)
  })
  it('ceil is taken BEFORE the max (boundary 8 → 10, 8.1 → 11)', () => {
    expect(delayThresholdForTarget(8)).toBe(10) // ceil(10) = 10
    expect(delayThresholdForTarget(8.1)).toBe(11) // ceil(10.125) = 11
    expect(delayThresholdForTarget(9)).toBe(12) // ceil(11.25) = 12
  })
  it('standard station targets', () => {
    expect(delayThresholdForTarget(10)).toBe(13) // ceil(12.5)
    expect(delayThresholdForTarget(15)).toBe(19) // ceil(18.75)
    expect(delayThresholdForTarget(60)).toBe(75) // ceil(75)
  })
  it('never below the global threshold constant', () => {
    for (const t of [1, 2, 4, 5, 6, 7, 7.99]) {
      expect(delayThresholdForTarget(t)).toBeGreaterThanOrEqual(KDS_DELAY_THRESHOLD_MIN)
    }
  })
})

describe('OPS-11 isLatePrep — back-compat WITHOUT a target (global 10 min)', () => {
  it('strictly above 10 → late; 10.0 exactly and below → not late', () => {
    expect(isLatePrep(10)).toBe(false)
    expect(isLatePrep(9.99)).toBe(false)
    expect(isLatePrep(0)).toBe(false)
    expect(isLatePrep(10.5)).toBe(true)
    expect(isLatePrep(45)).toBe(true)
  })
  it('identical decisions to the legacy shouldAskDelayReason', () => {
    for (const m of [0, 5, 9.99, 10, 10.01, 12.34, 100]) {
      expect(isLatePrep(m)).toBe(shouldAskDelayReason(m))
    }
  })
  it('null-ish / non-finite prepMin → never late (same guard as the legacy decision)', () => {
    expect(isLatePrep(Number.NaN)).toBe(false)
    expect(isLatePrep(Number.POSITIVE_INFINITY)).toBe(false) // non-finite = no usable measurement
    expect(isLatePrep(Number.NaN, 15)).toBe(false)
  })
})

describe('OPS-11 isLatePrep — WITH a per-station target', () => {
  it('threshold 13 (target 10): boundary and above', () => {
    expect(isLatePrep(12.9, 10)).toBe(false)
    expect(isLatePrep(13, 10)).toBe(false) // boundary = not late (same convention as the board)
    expect(isLatePrep(13.1, 10)).toBe(true)
  })
  it('threshold 19 (target 15): 18.9 OK, 19.5 late', () => {
    expect(isLatePrep(18.9, 15)).toBe(false)
    expect(isLatePrep(19.5, 15)).toBe(true)
  })
  it('small target (5) clamps to the global 10 — never stricter than before', () => {
    expect(isLatePrep(9.9, 5)).toBe(false)
    expect(isLatePrep(10.5, 5)).toBe(true)
  })
  it('invalid target (null / 0 / negative) → global 10', () => {
    expect(isLatePrep(10.5, null)).toBe(true)
    expect(isLatePrep(10.5, 0)).toBe(true)
    expect(isLatePrep(10.5, -3)).toBe(true)
    expect(isLatePrep(9.9, null)).toBe(false)
  })
})

describe('OPS-11 kdsDelayDetails — additive threshold key', () => {
  it('with threshold → payload carries the threshold at bump time', () => {
    const d = kdsDelayDetails({ orderItemId: 'i2', menuItemName: 'Burger', reason: 'busy', prepMin: 14.25, orderId: 'o2', threshold: 13 })
    expect(d.threshold).toBe(13)
    expect(d.prepMin).toBe(14.3) // rounding unchanged
    expect(d.reason).toBe('busy')
  })
  it('without threshold → EXACT legacy shape (back-compat with OPS-9 payload)', () => {
    const d = kdsDelayDetails({ orderItemId: 'i1', menuItemName: 'Burek', reason: 'redo', prepMin: 12.349999, orderId: 'o1' })
    expect(d).toEqual({ orderItemId: 'i1', menuItemName: 'Burek', reason: 'redo', prepMin: 12.3, orderId: 'o1' })
    expect('threshold' in d).toBe(false)
  })
})

describe('OPS-11 threshold chain used by the client live timer', () => {
  it('station target from GET /api/kitchen → threshold → red/late decision', () => {
    // KITCHEN bucket with PrepStation.avgPrepTime = 15 (schema default) → threshold 19
    const threshold = delayThresholdForTarget(15)
    expect(threshold).toBe(19)
    expect(isLatePrep(threshold + 0.1, 15)).toBe(true)
    expect(isLatePrep(threshold - 0.1, 15)).toBe(false)
    // bucket without an active station (null target) → historical 10 min
    expect(delayThresholdForTarget(null)).toBe(KDS_DELAY_THRESHOLD_MIN)
    expect(isLatePrep(10.5, null)).toBe(true)
  })
})
