/**
 * OPS-10 val 2 (v1.78.0) — Customer display promocije (idle carousel).
 *
 * PURE MODULE — no db imports here; the Integration row read/write lives in the
 * API routes (same split as recurring-po.ts / delivery.ts).
 *
 * Storage (ZERO DDL): an Integration row (name='display-promos', type='other',
 * provider='internal') keeps the ads in its config JSON:
 *   { "ads": [{ "id", "imageUrl", "durationSec", "active" }, ...] }   // max 5
 *
 * Rules:
 *  - imageUrl must be http(s) — data:/javascript: etc. are rejected (display is a
 *    public-facing 24/7 screen);
 *  - durationSec clamped to 5-120 (default DEFAULT_PROMO_DURATION_SEC = 15);
 *  - max MAX_PROMOS ads, deduped by id (missing/garbage id → auto-generated);
 *  - garbage input sanitizes to { ads: [] } (tolerant read — never throws);
 *  - activeAds() filters for the display state payload (client picks the phase).
 */

export const MAX_PROMOS = 5
export const DEFAULT_PROMO_DURATION_SEC = 15
export const MIN_PROMO_DURATION_SEC = 5
export const MAX_PROMO_DURATION_SEC = 120

/** Integration row marker (name=..., type='other'). */
export const DISPLAY_PROMOS_MARKER = 'display-promos'

export interface DisplayPromo {
  id: string
  imageUrl: string
  durationSec: number
  active: boolean
}

let promoIdSeq = 0
/** Deterministic-enough auto id (monotonic counter + time — unique within one process). */
function nextPromoId(): string {
  promoIdSeq += 1
  return `promo-${Date.now().toString(36)}-${promoIdSeq.toString(36)}`
}

/** Pure: http(s) URL check — the wall display must never be pointed at non-web schemes. */
export function isValidPromoUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (!s || s.length > 2048) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Pure: sanitize an unknown payload into { ads: DisplayPromo[] }.
 * Invalid entries are dropped (bad URL); valid ones are normalized
 * (id auto-generated when missing, duration clamped, dedupe by id — first wins).
 */
export function sanitizePromos(raw: unknown): { ads: DisplayPromo[] } {
  let cfg = raw
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg) } catch { return { ads: [] } }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ads: [] }
  const list = (cfg as { ads?: unknown }).ads
  if (!Array.isArray(list)) return { ads: [] }
  const ads: DisplayPromo[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (ads.length >= MAX_PROMOS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const o = entry as Record<string, unknown>
    if (!isValidPromoUrl(o.imageUrl)) continue
    const rawDur = Number(o.durationSec)
    const durationSec = Number.isFinite(rawDur)
      ? Math.min(MAX_PROMO_DURATION_SEC, Math.max(MIN_PROMO_DURATION_SEC, Math.round(rawDur)))
      : DEFAULT_PROMO_DURATION_SEC
    const idRaw = typeof o.id === 'string' ? o.id.trim() : ''
    let id = idRaw || nextPromoId()
    while (seen.has(id)) id = `${id}-${nextPromoId()}`
    seen.add(id)
    ads.push({ id, imageUrl: String(o.imageUrl).trim(), durationSec, active: o.active !== false })
  }
  return { ads }
}

/** Pure: only active ads (what the display carousel actually rotates). */
export function activeAds(ads: DisplayPromo[]): DisplayPromo[] {
  if (!Array.isArray(ads)) return []
  return ads.filter((a) => a && a.active === true)
}
