/**
 * Issue #4 §11 — unit testi za skupni rate limiter (src/lib/rate-limit.ts).
 * Čist in-memory modul — brez DB/omrežja. __resetRateLimitForTests zagotavlja
 * determinističnost med testi (state je procesni, bun test pogan datoteke v istem procesu).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  rateLimitShared,
  rateLimitSharedAsync,
  __resetRateLimitForTests,
  __resetStoreForTests,
} from '@/lib/rate-limit'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('rateLimitShared — burst', () => {
  beforeEach(() => __resetRateLimitForTests())

  test('limit 3 → prvi 3 klici dovoljeni, 4. zavrnjen', () => {
    const k = 'burst:kljuc'
    expect(rateLimitShared(k, 3, 60_000).allowed).toBe(true)
    expect(rateLimitShared(k, 3, 60_000).allowed).toBe(true)
    const third = rateLimitShared(k, 3, 60_000)
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)
    const fourth = rateLimitShared(k, 3, 60_000)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
  })

  test('nezavisni ključi si ne delajo vedra', () => {
    expect(rateLimitShared('a:1', 1, 60_000).allowed).toBe(true)
    expect(rateLimitShared('a:1', 1, 60_000).allowed).toBe(false)
    expect(rateLimitShared('a:2', 1, 60_000).allowed).toBe(true)
  })
})

describe('rateLimitShared — okno poteče', () => {
  beforeEach(() => __resetRateLimitForTests())

  test('windowMs 30 — po 50 ms je spet dovoljeno', async () => {
    const k = 'window:kljuc'
    expect(rateLimitShared(k, 1, 30).allowed).toBe(true)
    expect(rateLimitShared(k, 1, 30).allowed).toBe(false) // še v istem oknu
    await sleep(50) // okno (30 ms) poteče
    const after = rateLimitShared(k, 1, 30)
    expect(after.allowed).toBe(true)
    expect(after.remaining).toBe(0) // sveže vedro
  })
})

describe('rateLimitShared — bounded keys (omejen pomnilnik)', () => {
  beforeEach(() => __resetRateLimitForTests())

  test('10_005 unikatnih ključev → limiter ostane funkcionalen, najstarejši vedra izrine', () => {
    const N = 10_005 // MAX_BOUNDED_KEYS je 10_000 → 5+ najstarejših mora biti izrinjenih
    let first: ReturnType<typeof rateLimitShared> | undefined
    for (let i = 0; i < N; i++) {
      const r = rateLimitShared(`bound:key${i}`, 5, 60_000)
      if (i === 0) first = r
    }

    // prvi ključ (najstarejši) je bil izrinjen → nov klic ustvari SVEŽE vedro
    // (allowed, remaining = limit-1) — obnašanje ostane konzistentno, brez crasha
    const again = rateLimitShared('bound:key0', 5, 60_000)
    expect(again.allowed).toBe(true)
    expect(again.remaining).toBe(4)
    expect(again.resetAt).toBeGreaterThanOrEqual(first!.resetAt)

    // najnovejši ključ je ŠE vedo sleden → count se nadaljuje (remaining 3, ne 4)
    const recent = rateLimitShared(`bound:key${N - 1}`, 5, 60_000)
    expect(recent.allowed).toBe(true)
    expect(recent.remaining).toBe(3)

    // limiter po poplavi ključev še vedno pravilno zavrača presežke
    const k = 'bound:after-flood'
    expect(rateLimitShared(k, 2, 60_000).allowed).toBe(true)
    expect(rateLimitShared(k, 2, 60_000).allowed).toBe(true)
    expect(rateLimitShared(k, 2, 60_000).allowed).toBe(false)
  })
})

/* ───── Issue #10 P2-1 — store-aware limiter (RateLimitStore seam) ───── */

describe('rateLimitSharedAsync — memory default (issue #10 P2-1)', () => {
  beforeEach(() => { __resetRateLimitForTests(); __resetStoreForTests() })

  test('brez Upstash env = enako vedenje kot sync verzija', async () => {
    const k = 'store:kljuc1'
    expect((await rateLimitSharedAsync(k, 2, 60_000)).allowed).toBe(true)
    expect((await rateLimitSharedAsync(k, 2, 60_000)).allowed).toBe(true)
    expect((await rateLimitSharedAsync(k, 2, 60_000)).allowed).toBe(false)
  })
})

describe('rateLimitSharedAsync — Upstash store (issue #10 P2-1)', () => {
  const realFetch = globalThis.fetch
  const ORIG_ENV = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  }

  // v1.171.0 — LIMITERJEVA NASTAVITEV MORA VEN. Prejšnja različica je samo
  // vrnila `fetch`, env pa je pustila nastavljen: `activeStore` je modulski
  // keš, zato je vsaka kasnejša testna datotela v istem procesu dobila
  // Upstash store in je omejevanje odvisilo od tega, kdo ima zaden `fetch`.
  afterEach(() => {
    globalThis.fetch = realFetch
    if (ORIG_ENV.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL
    else process.env.UPSTASH_REDIS_REST_URL = ORIG_ENV.url
    if (ORIG_ENV.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
    else process.env.UPSTASH_REDIS_REST_TOKEN = ORIG_ENV.token
    __resetStoreForTests()
    __resetRateLimitForTests()
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    if (ORIG_ENV.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL
    else process.env.UPSTASH_REDIS_REST_URL = ORIG_ENV.url
    if (ORIG_ENV.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
    else process.env.UPSTASH_REDIS_REST_TOKEN = ORIG_ENV.token
    __resetStoreForTests()
    __resetRateLimitForTests()
  })

  function withUpstashEnv(fn: (url: string) => Promise<Response>): void {
    process.env.UPSTASH_REDIS_REST_URL = 'https://test-rest.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'
    __resetStoreForTests()
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input)
      return fn(url)
    }) as typeof fetch
  }

  test('Upstash INCR/PEXPIRE pot — dovoli do limita', async () => {
    const counts = new Map<string, number>()
    withUpstashEnv(async (url) => {
      const dec = decodeURIComponent(url)
      const m = dec.match(/\/rl:([^/]+)\/(.+)$/)
      if (dec.includes('/INCR/')) {
        const key = dec.split('/INCR/')[1]
        const c = (counts.get(key) || 0) + 1
        counts.set(key, c)
        return new Response(JSON.stringify({ result: c }), { status: 200 })
      }
      if (dec.includes('/PEXPIRE/')) return new Response(JSON.stringify({ result: 1 }), { status: 200 })
      if (dec.includes('/PTTL/')) return new Response(JSON.stringify({ result: 60_000 }), { status: 200 })
      void m
      return new Response(JSON.stringify({ error: 'unknown' }), { status: 400 })
    })

    const k = 'up:kljuc1'
    expect((await rateLimitSharedAsync(k, 2, 60_000)).allowed).toBe(true)
    expect((await rateLimitSharedAsync(k, 2, 60_000)).allowed).toBe(true)
    const third = await rateLimitSharedAsync(k, 2, 60_000)
    expect(third.allowed).toBe(false)
    expect(third.remaining).toBe(0)
  })

  test('Upstash napaka → graceful padec na memory store (zaščita ohranjena)', async () => {
    withUpstashEnv(async () => new Response('upstash down', { status: 503 }))
    const k = 'fb:kljuc1'
    // fallback memory: 1. klic dovoljen (napaka zalogirana v konzolo, ne vržen)
    const r1 = await rateLimitSharedAsync(k, 1, 60_000)
    expect(r1.allowed).toBe(true)
    const r2 = await rateLimitSharedAsync(k, 1, 60_000)
    expect(r2.allowed).toBe(false)
  })

  /**
   * v1.171.0 — odpoved CI-ja (run 39905677431, 8 × „Expected: 429, Received: 200").
   *
   * `tests/rate-limit.test.ts` je uhajal UPSTASH env, `tests/v170-offline-queue-limits.test.ts`
   * pa `globalThis.fetch` s stubom, ki vrača `{ results: [] }` BREZ polja `result`.
   * Kombinacija: `upstashCommand` dobi HTTP 200 → `data.result == null` → `Number(null)`
   * je 0 → `0 <= limit` → DOVOLJENO. Limiter je torej tiho prenehal omejevati vsako
   * javno rutje v procesu, omrežne napake pa ni bilo (stub nikoli ne vrže) — zato
   * lokalno zelen, CI rdeč.
   *
   * Pogodba: neuskladen odgovor (manjkajoč/Ne-številsen `result`) je NAPAKA zaloga,
   * ne «nič zadetkov». Limiter mora pasti na memory store, kjer se štetje nadaljuje.
   */
  test('Upstash 200 brez polja result → NEJE tiho dovoljeno: padec na memory store', async () => {
    withUpstashEnv(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }))
    const k = 'bad:posresult'
    expect((await rateLimitSharedAsync(k, 1, 60_000)).allowed).toBe(true)
    expect((await rateLimitSharedAsync(k, 1, 60_000)).allowed).toBe(false)
    expect((await rateLimitSharedAsync(k, 1, 60_000)).allowed).toBe(false)
  })

  test('Upstash 200 z ne-številsen result → enako: padec na memory store, NE slepo zavračanje', async () => {
    withUpstashEnv(async () => new Response(JSON.stringify({ result: 'OK' }), { status: 200 }))
    const k = 'bad:numbers'
    // prvi klic mora biti DOVOLJEN (memory fallback začne novo vedro), ne zavrnjen
    expect((await rateLimitSharedAsync(k, 1, 60_000)).allowed).toBe(true)
    expect((await rateLimitSharedAsync(k, 1, 60_000)).allowed).toBe(false)
  })
})
