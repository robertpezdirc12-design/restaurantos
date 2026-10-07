/**
 * Issue #4 §11 — unit testi za skupni rate limiter (src/lib/rate-limit.ts).
 * Čist in-memory modul — brez DB/omrežja. __resetRateLimitForTests zagotavlja
 * determinističnost med testi (state je procesni, bun test pogan datoteke v istem procesu).
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { rateLimitShared, __resetRateLimitForTests } from '@/lib/rate-limit'

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
