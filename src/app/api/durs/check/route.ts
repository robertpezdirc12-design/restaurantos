import { NextRequest } from 'next/server'
import { requireAuth, isResponse, ok } from '@/lib/api'
import {
  DURS_UPSTREAM_URL, normalizeDursInput, normalizeDursResponse, pickDursEntry,
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
    const results = normalizeDursResponse(raw)
    cacheSet(q, results)
    return ok({ results, entry: pickDursEntry(results, qRaw) })
  } catch {
    // timeout / network failure — upstream unreachable
    return ok({ error: 'upstream' }, 502)
  }
}
