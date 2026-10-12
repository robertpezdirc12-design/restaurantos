import { NextRequest } from 'next/server'
import { requireAuth, isResponse, ok } from '@/lib/api'
import {
  DURS_UPSTREAM_URL, VIES_UPSTREAM_URL, classifyDursQuery, normalizeDursInput,
  normalizeDursResponse, normalizeViesResponse, pickDursEntry,
  type DursEntry,
} from '@/lib/durs'

/**
 * OPS-8 val 2 (v1.72.0) — DURS preverjanje DDV zavezanca (proxy ddv.inetis.com).
 *
 * GET /api/durs/check?q=<davčna|SI davčna|naziv|matična|TRR>
 *   → { results: DursEntry[], entry: DursEntry | null }
 *
 * Permission: requireAuth (any authenticated user — read-only; the user enters the number).
 * Cache: in-memory Map, TTL 24h (FURS lists update daily). Errors:
 *   - q < 3 chars           → 400 { error: 'too_short' }
 *   - upstream 429          → 429 { error: 'rate_limited' }
 *   - upstream fail/timeout → 502 { error: 'upstream' }
 *   - no hits               → 200 { results: [], entry: null }
 * Timeout: 6s (AbortSignal.timeout). UI: 'Check VAT' button (supplier dialog + settings).
 *
 * OPS-9 val 2 (v1.75.0) — VIES: EU-prefixed foreign VAT numbers (classifyDursQuery
 * === 'eu', prefix NOT SI) go to ec.europa.eu VIES REST instead of Inetis, with the
 * SAME response shape ({results, entry}) + source badges ('vies' / 'inetis').
 * SI and free-text (names) keep the existing Inetis path.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX = 200
const UPSTREAM_TIMEOUT_MS = 6000

interface CacheSlot {
  at: number
  results: DursEntry[]
}
const cache = new Map<string, CacheSlot>()

function cacheGet(key: string): CacheSlot | null {
  const slot = cache.get(key)
  if (!slot) return null
  if (Date.now() - slot.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return slot
}

function cacheSet(key: string, results: DursEntry[]): void {
  if (cache.size >= CACHE_MAX) {
    // evict oldest (Map preserves insertion order)
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), results })
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const qRaw = req.nextUrl.searchParams.get('q') || ''
  const q = normalizeDursInput(qRaw)
  if (q.length < 3) {
    return ok({ error: 'too_short' }, 400)
  }

  const cached = cacheGet(q)
  if (cached) {
    return ok({ results: cached.results, entry: pickDursEntry(cached.results, qRaw), cached: true })
  }

  // OPS-9 val 2 — foreign EU VAT number → VIES REST (same shape as DURS results)
  if (classifyDursQuery(q) === 'eu') {
    const cc = q.slice(0, 2).toUpperCase()
    const vatNum = q.slice(2).toUpperCase()
    try {
      const res = await fetch(`${VIES_UPSTREAM_URL}/${cc}/vat/${encodeURIComponent(vatNum)}`, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (res.status === 429) {
        return ok({ error: 'rate_limited' }, 429)
      }
      if (!res.ok) {
        return ok({ error: 'upstream' }, 502)
      }
      const raw = (await res.json().catch(() => null)) as unknown
      if (raw === null) {
        return ok({ error: 'upstream' }, 502)
      }
      let entry = normalizeViesResponse(raw)
      if (entry) {
        // VIES REST omits countryCode on both valid and invalid answers — vatId is built
        // from the query (cc + vatNumber) whenever the raw mapping lacks the prefix
        entry = { ...entry, taxNumber: entry.taxNumber || vatNum.replace(/\D/g, ''), vatId: entry.vatId.startsWith(cc) ? entry.vatId : `${cc}${vatNum}` }
      }
      const results: DursEntry[] = entry ? [entry] : []
      cacheSet(q, results)
      return ok({ results, entry, source: 'vies' })
    } catch {
      // timeout / network failure — upstream unreachable
      return ok({ error: 'upstream' }, 502)
    }
  }

  try {
    const res = await fetch(`${DURS_UPSTREAM_URL}?isci=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    })
    if (res.status === 429) {
      return ok({ error: 'rate_limited' }, 429)
    }
    if (!res.ok) {
      return ok({ error: 'upstream' }, 502)
    }
    const raw = (await res.json().catch(() => null)) as unknown
    if (raw === null) {
      return ok({ error: 'upstream' }, 502)
    }
    const results: DursEntry[] = normalizeDursResponse(raw).map((e) => ({ ...e, source: 'inetis' as const }))
    cacheSet(q, results)
    return ok({ results, entry: pickDursEntry(results, qRaw), source: 'inetis' })
  } catch {
    // timeout / network failure — upstream unreachable
    return ok({ error: 'upstream' }, 502)
  }
}
