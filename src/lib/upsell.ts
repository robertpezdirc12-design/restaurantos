/**
 * OPS-10 val 2 (v1.78.0) — Kiosk upsell ("Dodaj še …") konfiguracija.
 *
 * PURE MODULE — no db imports here; server-side Integration row helpers live in
 * src/app/api/kiosk-upsell/route.ts (same split as recurring-po.ts / delivery.ts).
 *
 * Storage (ZERO DDL): an Integration row (name='kiosk-upsell', type='other',
 * provider='internal') keeps the mapping in its config JSON:
 *   { "menuItemId": ["suggestedMenuItemId", ...], ... }   // 1-3 suggestions per item
 *
 * Rules (benchmark: 1-3 suggestions per item lifts AOV 10-30 %):
 *  - unknown item ids are dropped (config is always validated against the live menu);
 *  - self-reference and duplicates are removed;
 *  - max MAX_UPSELLS suggestions per item, max MAX_UPSELL_ITEMS source items;
 *  - garbage input sanitizes to {} (tolerant read — never throws).
 */

/** Max suggestions per menu item. */
export const MAX_UPSELLS = 3
/** Max source items tracked in the config (guards against unbounded growth). */
export const MAX_UPSELL_ITEMS = 200

export interface UpsellConfig {
  [menuItemId: string]: string[]
}

/** Integration row marker (name=..., type='other'). */
export const KIOSK_UPSELL_MARKER = 'kiosk-upsell'

/** Pure: strip noise from an arbitrary string into a trimmed non-empty id candidate. */
function cleanId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s : null
}

/**
 * Pure: sanitize an unknown payload into an UpsellConfig.
 *  - non-object input (string/array/null/…) → {};
 *  - unknown ids (not in validItemIds) are dropped — both keys and suggestions;
 *  - self-reference + duplicates removed, per-item order preserved;
 *  - max MAX_UPSELLS suggestions per item, items sorted by first appearance,
 *    capped at MAX_UPSELL_ITEMS;
 *  - items left with an empty suggestion list are dropped entirely.
 */
export function sanitizeUpsellConfig(raw: unknown, validItemIds: Set<string>): UpsellConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: UpsellConfig = {}
  let kept = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_UPSELL_ITEMS) break
    const itemId = cleanId(key)
    if (!itemId || !validItemIds.has(itemId)) continue
    if (!Array.isArray(value)) continue
    const seen = new Set<string>([itemId]) // self-reference guard (seed with the item itself)
    const suggestions: string[] = []
    for (const v of value) {
      if (suggestions.length >= MAX_UPSELLS) break
      const sug = cleanId(v)
      if (!sug || !validItemIds.has(sug) || seen.has(sug)) continue
      seen.add(sug)
      suggestions.push(sug)
    }
    if (suggestions.length > 0) {
      out[itemId] = suggestions
      kept += 1
    }
  }
  return out
}

/** Pure: suggestions for one item — a fresh copy, capped at MAX_UPSELLS, [] when absent. */
export function upsellsForItemId(config: UpsellConfig, itemId: string): string[] {
  const list = config?.[itemId]
  if (!Array.isArray(list)) return []
  return list.slice(0, MAX_UPSELLS)
}
