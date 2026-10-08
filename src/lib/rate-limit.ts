/**
 * Issue #4 §6 — skupni rate limiter z OMEJENIM pomnilnikom (bounded memory + TTL).
 * Issue #10 P2-1 — distribucijski seam: RateLimitStore vmesnik + Upstash REST
 * adapter (dormant: aktiven SAMO ko sta nastavljeni UPSTASH_REDIS_REST_URL in
 * UPSTASH_REDIS_REST_TOKEN; brez njiju ostane memory store, vedenje nespremenjeno).
 *
 * Zakaj: prej sta obstajala dva neodvisna in-memory limiterja (guest.ts, delivery.ts),
 * delivery brez size cap → neomejena rast. Ta modul je ENOTEN vir za vse javne endpointe.
 *
 * Omejitve (pošteno dokumentirano): memory store je per-process (efektivni limit =
 * limit × instanc, cold start ponastavi). Upstash store omogoča deljeni state čez
 * instance brez dodatnih odvisnosti (REST API, fetch). Infra odločitev ostaja pri
 * uporabniku (issue #10: "ne uvajati Redis brez soglasja") — adapter je pripravljen,
 * a neaktiven do env nastavitve.
 *
 * Pravila:
 *  - MAX_BOUNDED_KEYS: LRU-style odstranjevanje najstarejših vnosov (Map vrstni red).
 *  - sweepExpired(): periodično čiščenje poteklih vnosov (vsak SWEEP_INTERVAL klicev).
 *  - fail behavior: false = zavrnjeno (route vrne 429); legitimen POS promet ima višje limite.
 *  - Upstash napaka → preklop na memory store za tisti klic (graceful degradation,
 *    zaščita ostaja deluje vsaj per-instance) + console.error (opazljivo, ne tiho).
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

/** Jedro (memory): true = dovoljeno, false = presežen limit. Ključ: `context:dimenzija` (IP/token). */
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

/** Združljivost z obstoječimi klici (guest.ts/delivery.ts): boolean API. Memory-only. */
export function rateLimitBool(key: string, limit: number, windowMs = 60_000): boolean {
  return rateLimitShared(key, limit, windowMs).allowed
}

/* ───── Issue #10 P2-1 — RateLimitStore vmesnik (distribucijski seam) ───── */

export interface RateLimitStore {
  readonly name: string
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>
}

/** Privzeti store: isti bounded-memory mehanizem kot zgoraj (vedenje nespremenjeno). */
export const memoryStore: RateLimitStore = {
  name: 'memory',
  async hit(key, limit, windowMs) {
    return rateLimitShared(key, limit, windowMs)
  },
}

/* ───── Upstash REST store (brez SDK — samo fetch; dormant do env nastavitve) ───── */

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '')
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

export const upstashConfigured = Boolean(UPSTASH_URL && UPSTASH_TOKEN)

async function upstashCommand(args: string[]): Promise<string | null> {
  const res = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    signal: AbortSignal.timeout(1_500),
  })
  if (!res.ok) throw new Error(`upstash ${res.status}`)
  const data = (await res.json()) as { result?: string | number | null }
  return data.result == null ? null : String(data.result)
}

/**
 * Upstash store: atomarni INCR + PEXPIRE ob prvem zadetku (fiksno okno).
 * Napaka → NE tiho; kličoča koda pade nazaj na memory store (glej rateLimitSharedAsync).
 */
export const upstashStore: RateLimitStore = {
  name: 'upstash',
  async hit(key, limit, windowMs) {
    const redisKey = `rl:${key}`
    const count = Number(await upstashCommand(['INCR', redisKey]))
    if (count === 1) await upstashCommand(['PEXPIRE', redisKey, String(Math.ceil(windowMs))])
    let resetAt = Date.now() + windowMs
    const pttl = await upstashCommand(['PTTL', redisKey])
    if (pttl && Number(pttl) > 0) resetAt = Date.now() + Number(pttl)
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt }
  },
}

let activeStore: RateLimitStore | null = null

/** Aktiven store: Upstash, če je konfiguriran, sicer memory (deterministično, env-read ob prvem klicu). */
function getStore(): RateLimitStore {
  if (activeStore) return activeStore
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '')
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || ''
  activeStore = url && token ? upstashStore : memoryStore
  return activeStore
}

/** Test-only: ponastavi izbiro store-a (env se ponovno prebere ob naslednjem klicu). */
export function __resetStoreForTests(): void {
  activeStore = null
}

/**
 * Kanonični store-aware limiter (issue #10 P2-1). Vse NOVE rabe naj kličejo to.
 * Upstash napaka → graceful padec na memory store za ta klic (zaščita ohranjena).
 */
export async function rateLimitSharedAsync(key: string, limit: number, windowMs = 60_000): Promise<RateLimitResult> {
  const store = getStore()
  if (store.name === 'memory') return memoryStore.hit(key, limit, windowMs)
  try {
    return await upstashStore.hit(key, limit, windowMs)
  } catch (err) {
    console.error(`[rate-limit] upstash napaka (${String(err)}) → memory fallback`, { key: key.split(':')[0] })
    return memoryStore.hit(key, limit, windowMs)
  }
}

/** Boolean različica store-aware limiterja (za obstoječe klicne vzorce). */
export async function rateLimitBoolAsync(key: string, limit: number, windowMs = 60_000): Promise<boolean> {
  return (await rateLimitSharedAsync(key, limit, windowMs)).allowed
}

/** Test-only: počisti vse buckete (izvoženo za deterministične teste). */
export function __resetRateLimitForTests(): void {
  buckets.clear()
  callsSinceSweep = 0
}
