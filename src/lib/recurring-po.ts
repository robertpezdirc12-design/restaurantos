/**
 * OPS-9 val 2 (v1.75.0) — ponavljajoče naročilnice (recurring purchase orders).
 *
 * Persistence (ZERO DDL): an Integration row (name='recurring-po', type='other',
 * provider='internal') keeps the rules in its config JSON:
 *   { "rules": [{ "id", "supplierId", "items": [{"inventoryItemId","qty"}],
 *                 "weekdays": [1,4], "hour": 8, "everyWeeks": 1,
 *                 "active": true, "lastRun": null, "nextRun": "ISO" }] }
 *
 * Weekday numbering follows Date#getDay(): 0 = Sunday ... 6 = Saturday.
 * The UI renders them Monday-first (Pon/Tor/Sre/Čet/Pet/Sob/Ned).
 *
 * Scheduling semantics (pure, deterministic):
 *   computeNextRun(rule, from) — the earliest (weekday ∈ rule.weekdays, hour =
 *   rule.hour:00 local) datetime STRICTLY after `from`, in a week whose offset
 *   from `from`'s week is a multiple of everyWeeks (Google-Calendar-style
 *   biweekly phase: after a run, the same week's remaining weekdays still fire,
 *   then the cycle skips (everyWeeks-1) weeks).
 *   isDue(rule, now) — active rule whose stored nextRun is in the past.
 */

export const RECURRING_PO_MARKER = 'recurring-po'

export interface RecurringRuleItem {
  inventoryItemId: string
  qty: number
}

export interface RecurringRule {
  id: string
  supplierId: string
  items: RecurringRuleItem[]
  /** Date#getDay() numbers, 0 = Sunday ... 6 = Saturday */
  weekdays: number[]
  /** hour of day 6..18 (local time) */
  hour: number
  /** every N weeks, 1..4 */
  everyWeeks: number
  active: boolean
  lastRun: string | null
  nextRun: string | null
}

export interface RecurringPoConfig {
  rules: RecurringRule[]
}

/** Monday 00:00 local of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const day = d.getDay()
  const shift = (day + 6) % 7 // Monday-first offset
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - shift, 0, 0, 0, 0)
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Next scheduled run strictly after `from`. Returns null when the rule has no
 * valid weekdays (cannot be scheduled — the route validates this away).
 */
export function computeNextRun(
  rule: Pick<RecurringRule, 'weekdays' | 'hour' | 'everyWeeks'>,
  from: Date | string,
): Date | null {
  const base = typeof from === 'string' ? new Date(from) : new Date(from.getTime())
  if (isNaN(base.getTime())) return null

  const wds = [...new Set(rule.weekdays)].filter((w) => Number.isInteger(w) && w >= 0 && w <= 6)
  if (wds.length === 0) return null
  const hour = Number.isInteger(rule.hour) && rule.hour >= 0 && rule.hour <= 23 ? rule.hour : 8
  const every = Math.max(1, Math.min(4, Number.isInteger(rule.everyWeeks) ? rule.everyWeeks : 1))

  const baseWeek = startOfWeek(base).getTime()

  // scan forward: worst case spans everyWeeks weeks + one full weekday cycle
  for (let d = 0; d <= 7 * every + 7; d++) {
    const cand = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, hour, 0, 0, 0)
    if (cand.getTime() <= base.getTime()) continue
    if (!wds.includes(cand.getDay())) continue
    const weekOffset = Math.round((startOfWeek(cand).getTime() - baseWeek) / WEEK_MS)
    if (weekOffset % every !== 0) continue
    return cand
  }
  return null
}

/**
 * Is the rule due for evaluation at `now`? Inactive rules never fire; a rule
 * without a parseable nextRun is NEVER auto-fired (idempotent default — the
 * route sets nextRun on every create/toggle/run).
 */
export function isDue(rule: Pick<RecurringRule, 'active' | 'nextRun'>, now: Date | string): boolean {
  if (!rule.active) return false
  const next = rule.nextRun ? new Date(rule.nextRun) : null
  if (!next || isNaN(next.getTime())) return false
  const t = typeof now === 'string' ? new Date(now) : now
  return next.getTime() <= t.getTime()
}

/** Sanitize an unknown config payload into a rules array (tolerant, never throws). */
export function parseRecurringConfig(raw: unknown): RecurringRule[] {
  let cfg = raw
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg) } catch { return [] }
  }
  if (!cfg || typeof cfg !== 'object') return []
  const rules = (cfg as { rules?: unknown }).rules
  if (!Array.isArray(rules)) return []
  return rules.filter((r): r is RecurringRule =>
    !!r && typeof r === 'object' && typeof (r as RecurringRule).id === 'string',
  )
}
