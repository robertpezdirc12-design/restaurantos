/**
 * v1.211.0 — HOTFIX CI typecheck-prod: OrderItem.status ENUM pogodba (Postgres).
 *
 * Kontekst: v1.210.0 je v PATCH /api/orders/[id] (addItems) uvedel TIPIZIRAN
 * `addItemsBody` (prej `body.addItems.map(...)` — `body` je `any`, torej je bil
 * `rows` implicitno `any` in tsc je spregledal vse). S pravim tipom je prišlo na
 * plan latentno nesorazmerje: pod Postgres shemo je `OrderItem.status` ENUM
 * (`OrderItemStatus`), `itemStatusToDB()` pa vrača prosti `string` → TS2322,
 * Vercel deploy v1.210.0 FAILED (lokalno zeleno, ker lokalni klient generira iz
 * schema.sqlite.prisma, kjer je status navaden String — točno razred, ki ga
 * job `typecheck-prod` lovi že od v1.129.0; prejšnja mreža je bila slepa, ker
 * je bila vrstica skrita za `any`).
 *
 * Popravek (vzorec sync/route.ts:253, zelenega od v1.112.0):
 *   `status: itemStatusToDB('PENDING') as OrderItemStatus`
 *   z type-only uvozom iz '@/lib/prisma-types' (brez odvisnosti od klienta).
 *
 * Merila:
 *  Č1 ENUM pogodba (PURE, 0 baze): enum literalji v prisma/schema.prisma ↔
 *     literal unija v src/lib/prisma-types.ts (drift garda) + vsi znani
 *     itemStatusToDB izhodi so člani enuma (pod PostgreSQL ne sme pasti
 *     »invalid input value for enum«) + itemStatusToDB('PENDING') = 'pending'.
 *  Č2 disk kontrakt: route nosi cast + type-only uvoz; učiteljski vzorec v
 *     sync/route.ts ostaja (obe mesti istega razreda).
 *  Č3 registri: verzija 1.211.0 (toBe + ubežen regex), oznaka slike ↔
 *     APP_VERSION (docker-compose.yml ↔ version.ts).
 *
 * 0 fikstur baze — sweep ni potreben (demo podatki nedotaknjeni).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { itemStatusToDB } from '../src/lib/map'
import { APP_VERSION } from '../src/lib/version'

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/* ── Č1 — ENUM pogodba (Postgres shema ↔ lib unija ↔ mapanje) ─────────────── */
describe('v1.211.0 — hotfix Č1: OrderItemStatus ENUM pogodba', () => {
  /** literalji enuma iz prisma/schema.prisma (produkcija = PostgreSQL/Neon). */
  const schemaEnumValues = (): string[] => {
    const schema = read('prisma/schema.prisma')
    const m = schema.match(/enum OrderItemStatus \{([^}]*)\}/)
    expect(m).not.toBeNull()
    return (m as RegExpMatchArray)[1]
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((l) => l.length > 0 && !l.startsWith('//'))
  }

  /** literal unija iz src/lib/prisma-types.ts (vir casta). */
  const libUnionValues = (): string[] => {
    const lib = read('src/lib/prisma-types.ts')
    const m = lib.match(/export type OrderItemStatus = ([^\n]+)/)
    expect(m).not.toBeNull()
    return (m as RegExpMatchArray)[1]
      .split('|')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
  }

  it('schema enum ↔ lib unija: ISTA množica literalov (drift garda)', () => {
    const schemaSet = schemaEnumValues().sort()
    const libSet = libUnionValues().sort()
    expect(schemaSet.length).toBeGreaterThan(0)
    expect(libSet).toEqual(schemaSet)
  })

  it('vsi itemStatusToDB izhodi so člani enuma (Postgres ne sme dobiti neznanega niza)', () => {
    const members = new Set(schemaEnumValues())
    // znani UI statusi iz state machine naročila (route.ts § STATE MACHINE)
    const uiStatuses = ['PENDING', 'FIRED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED', 'VOIDED']
    for (const s of uiStatuses) {
      const db = itemStatusToDB(s)
      expect(members.has(db)).toBe(true)
    }
  })

  it('itemStatusToDB neznani vstopi fail-soft na člana enuma', () => {
    const members = new Set(schemaEnumValues())
    expect(itemStatusToDB('PENDING')).toBe('pending')
    expect(members.has(itemStatusToDB(''))).toBe(true)
    expect(members.has(itemStatusToDB('NEZNAN_STATUS'))).toBe(true)
  })
})

/* ── Č2 — disk kontrakt (route cast + učiteljski vzorec) ──────────────────── */
describe('v1.211.0 — hotfix Č2: disk kontrakt tipizacije statusa', () => {
  it('orders/[id]/route.ts: status nosi cast na OrderItemStatus', () => {
    const route = read('src/app/api/orders/[id]/route.ts')
    expect(route).toContain("status: itemStatusToDB('PENDING') as OrderItemStatus")
    // uvoz MORA biti type-only (brez pogojev baze v produkcijski poti)
    expect(route).toContain("import type { OrderItemStatus } from '@/lib/prisma-types'")
  })

  it('sync/route.ts: učiteljski vzorec ostaja na obeh mestih', () => {
    const sync = read('src/app/api/sync/route.ts')
    expect(sync).toContain("itemStatusToDB('PENDING') as OrderItemStatus")
    expect(sync).toContain("itemStatusToDB(status) as OrderItemStatus")
  })

  it('prisma-types.ts: unija je type-level pogodba (brez runtime uvozov klienta)', () => {
    const lib = read('src/lib/prisma-types.ts')
    expect(lib).toContain('pending')
    expect(lib).toMatch(/export type OrderItemStatus =/)
  })
})

/* ── Č3 — registri (verzija + oznaka slike) ───────────────────────────────── */
describe('v1.211.0 — hotfix Č3: registri', () => {
  it('verzija 1.212.0 (toBe + ubežen regex)', () => {
    expect(APP_VERSION).toBe('1.212.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.212\.0'/)
  })

  it('oznaka slike ↔ APP_VERSION (docker-compose.yml)', () => {
    const compose = read('deploy/docker-compose.yml')
    const tag = compose.match(/image: restaurantos:([^\s"]+)/)
    expect(tag).not.toBeNull()
    expect((tag as RegExpMatchArray)[1]).toBe(APP_VERSION)
  })
})
