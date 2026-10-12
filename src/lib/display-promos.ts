/**
 * OPS-10 val 2 (v1.78.0) — Customer display promocije (idle carousel).
 *
 * PURE MODULE — no db imports here; the Integration row read/write lives in the
 * API routes (same split as recurring-po.ts / delivery.ts).
 *
 * Storage (ZERO DDL): an Integration row (name='display-promos', type='other',
 * provider='internal') keeps the ads in its config JSON:
 *   { "ads": [{ "id", "imageUrl", "durationSec", "active",
 *               "startDate"?: 'YYYY-MM-DD', "endDate"?: 'YYYY-MM-DD' }, ...] }  // max 5
 *
 * Rules:
 *  - imageUrl must be http(s) — data:/javascript: etc. are rejected (display is a
 *    public-facing 24/7 screen);
 *  - durationSec clamped to 5-120 (default DEFAULT_PROMO_DURATION_SEC = 15);
 *  - max MAX_PROMOS ads, deduped by id (missing/garbage id → auto-generated);
 *  - OPS-11 val 2 (v1.81.0): campaign schedule — startDate/endDate are OPTIONAL
 *    strict 'YYYY-MM-DD' strings (local-time inclusive window). Invalid date
 *    strings are stripped on sanitize (tolerant — the ad itself is kept) and
 *    treated as "no bound" by isAdInWindow. activeAds() = active && in window.
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
  /** OPS-11 val 2 — campaign start (inclusive, 'YYYY-MM-DD'); undefined = no bound. */
  startDate?: string
  /** OPS-11 val 2 — campaign end (inclusive, 'YYYY-MM-DD'); undefined = no bound. */
  endDate?: string
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
 * Pure: strict 'YYYY-MM-DD' check — format AND a real calendar date
 * ('2024-02-29' valid leap day, '2023-02-29' / '2024-02-30' rejected).
 * Non-string / empty / trailing garbage → false.
 */
export function isValidDateStr(s: unknown): boolean {
  if (typeof s !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return false
  const probe = new Date(y, mo - 1, d, 12, 0, 0, 0) // noon avoids DST edge cases
  return probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d
}

/** Parse a valid 'YYYY-MM-DD' into a LOCAL Date at 00:00:00.000 (caller validates first). */
function startOfDayLocal(dateStr: string): Date {
  const [y, mo, d] = dateStr.trim().split('-').map(Number)
  return new Date(y, mo - 1, d, 0, 0, 0, 0)
}

/** Parse a valid 'YYYY-MM-DD' into a LOCAL Date at 23:59:59.999 (inclusive end of day). */
function endOfDayLocal(dateStr: string): Date {
  const [y, mo, d] = dateStr.trim().split('-').map(Number)
  return new Date(y, mo - 1, d, 23, 59, 59, 999)
}

/**
 * Pure: is the ad's campaign window open at `now` (local time)?
 *  - startDate: now >= start 00:00:00.000 (inclusive);
 *  - endDate:   now <= end 23:59:59.999 (inclusive — the whole last day shows);
 *  - missing/INVALID bound = no bound on that side (tolerant — garbage dates
 *    never hide an otherwise valid ad); no bounds at all → always true.
 */
export function isAdInWindow(ad: { startDate?: string; endDate?: string }, now: Date = new Date()): boolean {
  if (!ad || typeof ad !== 'object') return true
  const start = isValidDateStr(ad.startDate) ? startOfDayLocal(ad.startDate as string) : null
  if (start && now.getTime() < start.getTime()) return false
  const end = isValidDateStr(ad.endDate) ? endOfDayLocal(ad.endDate as string) : null
  if (end && now.getTime() > end.getTime()) return false
  return true
}

/**
 * Pure: sanitize an unknown payload into { ads: DisplayPromo[] }.
 * Invalid entries are dropped (bad URL); valid ones are normalized
 * (id auto-generated when missing, duration clamped, dedupe by id — first wins).
 * OPS-11 val 2: startDate/endDate are kept only when a strict 'YYYY-MM-DD'
 * (invalid → the FIELD is stripped, the ad itself stays — tolerant).
 * `now` is accepted for signature symmetry with activeAds() (format-only
 * validation here — window membership is NOT enforced on save).
 */
export function sanitizePromos(raw: unknown, now: Date = new Date()): { ads: DisplayPromo[] } {
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
    const ad: DisplayPromo = { id, imageUrl: String(o.imageUrl).trim(), durationSec, active: o.active !== false }
    // OPS-11 val 2: schedule fields — invalid strings are stripped (field-level,
    // tolerant), valid ones kept verbatim ('YYYY-MM-DD').
    if (isValidDateStr(o.startDate)) ad.startDate = String(o.startDate).trim()
    if (isValidDateStr(o.endDate)) ad.endDate = String(o.endDate).trim()
    ads.push(ad)
  }
  return { ads }
}

/**
 * Pure: only active ads within their campaign window (what the display carousel
 * actually rotates). Default `now` keeps every pre-1.81 call site behaving
 * exactly as before (active-only) for ads without a schedule.
 */
export function activeAds(ads: DisplayPromo[], now: Date = new Date()): DisplayPromo[] {
  if (!Array.isArray(ads)) return []
  return ads.filter((a) => a && a.active === true && isAdInWindow(a, now))
}
