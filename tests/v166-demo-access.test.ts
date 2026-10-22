/**
 * v1.166.0 — ZAČASNI demo dostop brez gesla (lastnikova zahteva 21. 10. 2026:
 * «nadaljuj z zasloni, najprej naredi demo dostop, da ne vpisujem gesel za
 * testiranje; potem odstranimo»).
 *
 * Tri stvari so tu zavarovane, ker je dostop nameno začasn:
 *  1. vrata so vedno OMEJENA z rokom (nikoli neomejena — obstoječa disciplina
 *     issue #7 / v1.148.0),
 *  2. demo sme teči samo na lastni bazi `prisma/db/demo.db`; `dev.db` je
 *     testna baza in je deljen vir (pravilo P-10) — vanje launcher ne sme pisati,
 *  3. začasni dostop NE sme razkriti produkcijskega lokalnega profila
 *     (`localEnv()` ostane DEMO_LOGIN_ENABLED=0, sicer bi bil brezgeslni vstop
 *     dosegljiv celemu lokalnemu omrežju).
 *
 * Odstranitev: izbriši `src/lib/demo-runtime.ts`, `scripts/demo-start.ts`,
 * `bun run demo` iz package.json, to datoteko in `docs/DEMO-DOSTOP.md`.
 * Baze se ni dotakniti — `prisma/db/` je gitignirana (`db/`).
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { demoGate } from '../src/app/api/auth/demo-login/route'
import { localEnv, type LocalSecrets } from '../src/lib/local-runtime'
import { DEMO_EMAIL, demoDbPath, demoEnv } from '../src/lib/demo-runtime'
import { demoHistoryPlan, DEMO_HISTORY_DAYS, type DemoHistoryInput } from '../src/lib/demo-history'

const ROOT = path.resolve(import.meta.dir, '..')
const NOW = new Date('2026-10-21T12:00:00Z')

const KEYS = ['DATABASE_URL', 'DEMO_LOGIN_ENABLED', 'DEMO_LOGIN_EMAIL', 'DEMO_LOGIN_EXPIRES_AT'] as const

let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = {}
  for (const k of KEYS) saved[k] = process.env[k]
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('demo dostop v1.166.0 — začasna vrata z rokom', () => {
  it('D1 demoEnv() odpre vrata in jim vedno nastavi prihodnji rok', () => {
    const env = demoEnv({ now: NOW })
    for (const k of KEYS) process.env[k] = env[k]!
    const gate = demoGate(NOW)
    expect(gate.open).toBe(true)
    expect((gate as { expiresAt?: Date }).expiresAt).toBeInstanceOf(Date)
    expect((gate as { expiresAt: Date }).expiresAt.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('D2 ko rok poteče, se vrata same zaprejo (brez posega v kodo)', () => {
    const env = demoEnv({ now: NOW })
    const expiresAt = new Date(env.DEMO_LOGIN_EXPIRES_AT)
    process.env.DEMO_LOGIN_ENABLED = env.DEMO_LOGIN_ENABLED
    process.env.DEMO_LOGIN_EXPIRES_AT = env.DEMO_LOGIN_EXPIRES_AT
    const after = new Date(expiresAt.getTime() + 1000)
    const gate = demoGate(after)
    expect(gate.open).toBe(false)
    expect((gate as { code?: string }).code).toBe('DEMO_LOGIN_EXPIRED')
  })

  it('D3 roka ni mogoče izpustiti: brez `days` in z `days` mora biti veljaven ISO zapis', () => {
    for (const env of [demoEnv(), demoEnv({ now: NOW, days: 1 })]) {
      expect(() => new Date(env.DEMO_LOGIN_EXPIRES_AT)).not.toThrow()
      expect(Number.isNaN(new Date(env.DEMO_LOGIN_EXPIRES_AT).getTime())).toBe(false)
      expect(env.DEMO_LOGIN_ENABLED).toBe('1')
    }
    // neveljaven ISO bi bil tiha napaka: demoGate je fail-closed, a launcher ne
    // sme proizvesti take vrednosti niti iznegativnega roka
    expect(() => demoEnv({ now: NOW, days: -1 })).toThrow()
    expect(() => demoEnv({ now: NOW, days: 0 })).toThrow()
  })

  it('D4 DATABASE_URL sme kazeti samo na demo.db — nikoli na dev.db ali oblačno bazo', () => {
    const env = demoEnv({ now: NOW })
    expect(env.DATABASE_URL.startsWith('file:')).toBe(true)
    expect(env.DATABASE_URL.endsWith('/prisma/db/demo.db')).toBe(true)
    expect(env.DATABASE_URL).not.toContain('dev.db')
    expect(env.DATABASE_URL).not.toMatch(/^postgres(ql)?:\/\//)
    expect(path.basename(demoDbPath(ROOT))).toBe('demo.db')
    expect(demoDbPath(ROOT)).toBe(path.join(ROOT, 'prisma', 'db', 'demo.db'))
  })

  it('D5 pripeti račun res je vodstven in brez MFA — sicer bi demo vrata vrnila 403', () => {
    const seed = readFileSync(path.join(ROOT, 'prisma', 'seed.ts'), 'utf8')
    const row = seed.match(/\{\s*id:\s*nid\('emp-admin'\)[^\n]*\}/)
    expect(row).not.toBeNull()
    expect(row![0]).toContain(`email: '${DEMO_EMAIL}'`)
    expect(row![0]).toContain("role: 'admin'")
    expect(row![0]).not.toContain('mfaEnabled')
    expect(demoEnv({ now: NOW }).DEMO_LOGIN_EMAIL).toBe(DEMO_EMAIL)
  })

  it('D6 začasni dostop ne razreši produkcijskega lokalnega profila (LAN izpostavljen)', () => {
    const secrets: LocalSecrets = {
      version: 1,
      appSecret: 'a'.repeat(48),
      pinLookupSalt: 'b'.repeat(48),
      cronSecret: 'c'.repeat(48),
      createdAt: NOW.toISOString(),
    }
    const shipped = localEnv(secrets, path.join(ROOT, 'podatki', 'restaurantos.db'))
    expect(shipped.DEMO_LOGIN_ENABLED).toBe('0')
    expect(shipped.BOOTSTRAP_ADMIN_EMAIL).toBe('')
    expect(shipped.BOOTSTRAP_ADMIN_PIN).toBe('')
    // demo profil NE predstavlja izdanega lokalnega profila
    expect(demoEnv({ now: NOW }).RESTAURANTOS_LOCAL).toBeUndefined()
  })

  it('D7 `bun run demo` je najavljen v package.json in uporablja launcher', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts.demo).toBe('bun scripts/demo-start.ts')
    expect(existsSync(path.join(ROOT, 'scripts', 'demo-start.ts'))).toBe(true)
    const src = readFileSync(path.join(ROOT, 'scripts', 'demo-start.ts'), 'utf8')
    expect(src).toContain('demoEnv')
    expect(src).not.toContain('runLocalSetup')
    expect(src).not.toMatch(/DATABASE_URL\s*=\s*['"]file:.*dev\.db/)
  })
})

// ── D8–D13: demo zgodovina (brez nje sta analitiki na Pregledu prazni) ─────────
const MENU = [
  { id: 'm1', name: 'Kranjska klobasa', price: 8.9, vatRate: 22 },
  { id: 'm2', name: 'Goveja juha', price: 4.5, vatRate: 22 },
  { id: 'm3', name: 'Lasagne', price: 12.4, vatRate: 22 },
  { id: 'm4', name: 'Laško pivo 0,5l', price: 2.8, vatRate: 22 },
]
const INPUT: DemoHistoryInput = {
  now: new Date('2026-10-21T18:00:00Z'),
  locationId: 'loc-demo',
  startOrderNumber: 41000,
  menu: MENU,
  tables: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
  employees: [
    { id: 'e-admin', role: 'admin' },
    { id: 'e-staff', role: 'staff' },
    { id: 'e-chef', role: 'chef' },
  ],
}

const startOfToday = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }

describe('demo zgodovina v1.166.0 — načrtovalnik generira dosledne, deterministične zapise', () => {
  it('D8 launcher naloži zgodovino, izdani lokalni profil pa ne', () => {
    const src = readFileSync(path.join(ROOT, 'scripts', 'demo-start.ts'), 'utf8')
    expect(src).toContain('seed-demo-history.ts')
    expect(existsSync(path.join(ROOT, 'scripts', 'seed-demo-history.ts'))).toBe(true)
    // `bun run local` in samodejna namestitev NE smeta vsebovati demo zgodovine
    const local = readFileSync(path.join(ROOT, 'scripts', 'local-start.ts'), 'utf8')
    expect(local).not.toContain('seed-demo-history')
  })

  it('D9 vsako plačano naročilo je v oknu in nikoli v prihodnosti', () => {
    // Ura obiska vpliva samo na urni filter in na varovalko pred prihodnostjo
    // (gen. uporablja lokalni čas, zato je datum sestavljen lokalno). En sam
    // `now` varovalke ne zajame: seme je fiksno in naročilo čez mejo pač ne
    // pade nanjo. Zato preletimo vse odprte ure + uro pred odprtjem.
    const VISIT_HOURS = [9, 11, 12, 13, 14, 17, 18, 19, 20, 21]
    for (const hour of VISIT_HOURS) {
      const input: DemoHistoryInput = { ...INPUT, now: new Date(2026, 9, 21, hour, 0, 0, 0) }
      const { orders } = demoHistoryPlan(input)
      const since = input.now.getTime() - DEMO_HISTORY_DAYS * 86_400_000
      expect(orders.length).toBeGreaterThan(0)
      for (const o of orders) {
        expect(o.status).toBe('paid')
        expect(o.paymentStatus).toBe('paid')
        expect(o.paidAt.getTime()).toBeGreaterThanOrEqual(since)
        expect(o.paidAt.getTime()).toBeLessThanOrEqual(input.now.getTime())
        expect(o.createdAt.getTime()).toBeLessThanOrEqual(o.paidAt.getTime())
        expect(o.locationId).toBe('loc-demo')
        expect(o.items.length).toBeGreaterThan(0)
      }
    }
  })

  it('D10 danes mora biti nekaj prometa, sicer je kartica »Prihodek danes« prazna', () => {
    const today = startOfToday(INPUT.now).getTime()
    const paidToday = demoHistoryPlan(INPUT).orders.filter((o) => o.paidAt.getTime() >= today)
    expect(paidToday.length).toBeGreaterThan(0)
    for (const o of paidToday) expect(o.paidAt.getTime()).toBeLessThanOrEqual(INPUT.now.getTime())
  })

  it('D11 seštevek je dosleden: subtotal = artiki, total = subtotal + ddv, številke naročil edinstvene', () => {
    const { orders } = demoHistoryPlan(INPUT)
    const seen = new Set<number>()
    for (const o of orders) {
      expect(seen.has(o.orderNumber)).toBe(false)
      seen.add(o.orderNumber)
      expect(o.orderNumber).toBeGreaterThan(INPUT.startOrderNumber)
      const subtotal = Math.round(o.items.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100
      expect(o.subtotal).toBe(subtotal)
      expect(Math.round((o.subtotal + o.tax) * 100) / 100).toBe(o.total)
      expect(o.tax).toBeGreaterThan(0)
      for (const i of o.items) {
        expect(i.quantity).toBeGreaterThan(0)
        expect(MENU.some((m) => m.id === i.menuItemId)).toBe(true)
      }
    }
  })

  it('D12 delovni vnosi so zaključeni in plačani po uri, sicer labor % ostane 0', () => {
    const { entries } = demoHistoryPlan(INPUT)
    expect(entries.length).toBeGreaterThan(0)
    const days = new Set(entries.map((e) => startOfToday(e.clockIn).getTime()))
    expect(days.size).toBeGreaterThan(1)
    for (const e of entries) {
      expect(e.clockOut).not.toBeNull()
      expect(e.clockIn.getTime()).toBeLessThanOrEqual(INPUT.now.getTime())
      expect(e.totalMinutes).toBeGreaterThan(0)
      const expected = Math.round(((e.totalMinutes / 60) * e.payRate) * 100) / 100
      expect(e.totalPay).toBe(expected)
      expect(e.locationId).toBe('loc-demo')
    }
  })

  it('D13 načrtovalnik je determinističen — dvakrat klicani vrnejo isti razpored', () => {
    expect(JSON.stringify(demoHistoryPlan(INPUT))).toBe(JSON.stringify(demoHistoryPlan(INPUT)))
    // prazen meni / prazne mize / prazna ekipa ne smejo povzročiti pada
    expect(demoHistoryPlan({ ...INPUT, menu: [] })).toEqual({ orders: [], entries: [] })
    expect(demoHistoryPlan({ ...INPUT, tables: [] }).orders).toEqual([])
  })
})
