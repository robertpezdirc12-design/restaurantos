/**
 * Issue #4 §6 — skupni rate limiter z OMEJENIM pomnilnikom (bounded memory + TTL).
 *
 * Zakaj: prej sta obstajala dva neodvisna in-memory limiterja (guest.ts, delivery.ts),
 * delivery brez size cap → neomejena rast. Ta modul je ENOTEN vir za vse javne endpointe.
 *
 * Omejitve (pošteno dokumentirano, §17 D/Remaining): state je per-process.
 * Na serverless/multi-instance deploymentu je efektivni limit = limit × instanc in
 * cold start ga ponastavi. Polno distribuiran state zahteva zunanji store (Redis/Upstash)
 * — trenutni deployment (single Neon DB + Vercel) tega nima; mehanizem je združljiv
 * z dejanskim deploymentom in ima omejen pomnilnik + TTL, kot zahteva issue.
 *
 * Pravila:
 *  - MAX_BOUNDED_KEYS: LRU-style odstranjevanje najstarejših vnosov (Map vrstni red).
 *  - sweepExpired(): periodično čiščenje poteklih vnosov (vsak SWEEP_INTERVAL klicev).
 *  - fail behavior: false = zavrnjeno (route vrne 429); legitimen POS promet ima višje limite.
 */

const buckets = new Map<string, { count: number; reset: number }>()

const MAX_BOUNDED_KEYS = 10_000
const SWEEP_INTERVAL = 1_000
let callsSinceSweep = 0

function sweepExpired(now: number): void {
  if (buckets.size < 512) return
  for (const [k, v] of buckets) {
    if (v.reset < now) buckets.delete(k)
  }
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

/** Jedro: true = dovoljeno, false = presežen limit. Ključ: `context:dimenzija` (IP/token). */
export function rateLimitShared(key: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now()
  callsSinceSweep++
  if (callsSinceSweep >= SWEEP_INTERVAL) {
    callsSinceSweep = 0
    sweepExpired(now)
  }
  const b = buckets.get(key)
  if (!b || b.reset < now) {
    // Bounded memory: ob vnosu čez prag odstrani najstarejše (Map ohranja vrstni red vnosov)
    while (buckets.size >= MAX_BOUNDED_KEYS) {
      const oldest = buckets.keys().next().value
      if (oldest === undefined) break
      buckets.delete(oldest)
    }
    buckets.set(key, { count: 1, reset: now + windowMs })
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs }
  }
  b.count++
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.reset }
}

/** Združljivost z obstoječimi klici (guest.ts/delivery.ts): boolean API. */
export function rateLimitBool(key: string, limit: number, windowMs = 60_000): boolean {
  return rateLimitShared(key, limit, windowMs).allowed
}

/** Test-only: počisti vse buckete (izvoženo za deterministične teste). */
export function __resetRateLimitForTests(): void {
  buckets.clear()
  callsSinceSweep = 0
}
