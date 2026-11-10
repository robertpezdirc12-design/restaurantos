import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { roleToUI } from '../src/lib/map'
import { POST as receiptSnapshotPOST } from '../src/app/api/admin/migrate-receipt-snapshot/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { APP_VERSION } from '../src/lib/version'

/**
 * HOTFIX v1.239.1 — DDL pot računske celice (v1.239.0 Receipt.checkId +
 * itemsJson). Val v1.239.0 je dodal 1 aditivno DDL, a ZABIL vpis v
 * KNOWN_DRIFTS allowlist — neon-smoke drift vrata so izmerila 2
 * nepričakovana stavka (CI run 41596980960 @ c0f8b13) → CI rdeč, deploy
 * blokiran. Ta hotfix sledi vzorcu coupons-waitlist (v1.219.1): admin ruta
 * + register + konzola + allowlist + i18n + verzija.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const P = 'v2391-'
const RUN = String(Date.now()).slice(-8)
const PIN = String(Date.now()).slice(-6)

let org: string, brand: string, prop: string, loc1: string
let adminNoLocId: string, managerLocId: string

function authReq(path: string, token: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': '10.239.1.1' },
    body: JSON.stringify(body),
  })
}

function bearer(userId: string, role: string, loc: string | null): string {
  return createToken({ sub: userId, name: P, role: roleToUI(role), loc, sv: 0 })
}

async function seedEmployee(id: string, role: string, loc: string | null, seq: number): Promise<string> {
  const email = `${id}@test.local`
  const f = employeePinFields(`${PIN}${seq}`, email)
  await db.employee.create({
    data: { id, name: `${P}${id}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
  })
  return id
}

async function cleanup() {
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.property.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.brand.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.organization.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()
  org = `${P}org-${RUN}`; brand = `${P}brand-${RUN}`; prop = `${P}prop-${RUN}`; loc1 = `${P}loc1-${RUN}`
  await db.organization.create({ data: { id: org, name: `${P}Org`, slug: `${P}-${RUN}` } })
  await db.brand.create({ data: { id: brand, organizationId: org, name: `${P}Brand` } })
  await db.property.create({ data: { id: prop, brandId: brand, name: `${P}Prop` } })
  await db.location.create({ data: { id: loc1, name: `${P}Lokacija1`, code: `V1${RUN}A`, propertyId: prop, timezone: 'Europe/Ljubljana', currency: 'EUR' } })
  adminNoLocId = await seedEmployee(`${P}admin-${RUN}`, 'admin', null, 1)
  managerLocId = await seedEmployee(`${P}mloc-${RUN}`, 'manager', loc1, 2)
})

afterAll(async () => {
  await cleanup()
})

/* ── A · ruta v živo (dev SQLite: stolpca iz db push zrcala → preskok) ──── */

describe('v1.239.1 A · migrate-receipt-snapshot ruta', () => {
  it('A1: idempotentna na dev SQLite ( že iz zrcala → 200 + skipped, 0 applied)', async () => {
    const res = await receiptSnapshotPOST(authReq('/api/admin/migrate-receipt-snapshot', bearer(adminNoLocId, 'admin', null), {}))
    expect(res.status).toBe(200)
    const d = (await res.json()) as { applied?: string[]; skipped?: string[]; alreadyApplied?: boolean }
    expect(Array.isArray(d.applied)).toBe(true)
    expect(Array.isArray(d.skipped)).toBe(true)
    expect(d.applied).toHaveLength(0) // dev SQLite ima stolpca prek db push zrcala
    expect(d.alreadyApplied).toBe(true)
  })

  it('A2: drugi klic ostane idempotenten (nič se ne podvoji)', async () => {
    const res = await receiptSnapshotPOST(authReq('/api/admin/migrate-receipt-snapshot', bearer(adminNoLocId, 'admin', null), {}))
    expect(res.status).toBe(200)
    const d = (await res.json()) as { applied?: string[]; alreadyApplied?: boolean }
    expect(d.applied).toHaveLength(0)
    expect(d.alreadyApplied).toBe(true)
  })

  it('A3: manager (ne-centralna vloga) → 403 (samo centralne)', async () => {
    const res = await receiptSnapshotPOST(authReq('/api/admin/migrate-receipt-snapshot', bearer(managerLocId, 'manager', loc1), {}))
    expect([403, 401]).toContain(res.status)
  })
})

/* ── B · izvorna koda rute (statika — dialekt, probe, audit) ────────────── */

describe('v1.239.1 B · izvorna koda rute', () => {
  const src = read('src/app/api/admin/migrate-receipt-snapshot/route.ts')

  it('B1: dialektna ločitev itemsJson — PG JSONB / SQLite TEXT', () => {
    expect(src).toContain("ALTER TABLE \"Receipt\" ADD COLUMN \"itemsJson\" JSONB NOT NULL DEFAULT '[]'")
    expect(src).toContain("ALTER TABLE \"Receipt\" ADD COLUMN \"itemsJson\" TEXT NOT NULL DEFAULT '[]'")
    expect(src).toContain("startsWith('file:')")
  })

  it('B2: probe PRED vsakim stavkom (idempotenca) + checkId TEXT na obeh dialektih', () => {
    expect(src).toContain('SELECT "checkId" FROM "Receipt" LIMIT 1')
    expect(src).toContain('SELECT "itemsJson" FROM "Receipt" LIMIT 1')
    expect(src).toContain("ALTER TABLE \"Receipt\" ADD COLUMN \"checkId\" TEXT NOT NULL DEFAULT ''")
    expect(src).toContain('no such column')
  })

  it('B3: audit veriga + centralna vloga', () => {
    expect(src).toContain('SCHEMA_MIGRATION_RECEIPT_SNAPSHOT')
    expect(src).toContain('requireCentralRole')
  })
})

/* ── C · register ↔ konzola ↔ allowlist ↔ i18n povezanost ───────────────── */

describe('v1.239.1 C · povezanost registrov', () => {
  it('C1: register vsebuje receipt-snapshot z obema stolpcema v probi', () => {
    const entry = SCHEMA_MIGRATIONS.find((m) => m.id === 'receipt-snapshot')
    expect(entry).toBeDefined()
    expect(entry!.descKey).toBe('mig.receiptSnapshot.desc')
    expect(entry!.endpoint).toBe('/api/admin/migrate-receipt-snapshot')
    const reg = read('src/lib/schema-migrations.ts')
    expect(reg).toContain("['Receipt', 'checkId']")
    expect(reg).toContain("['Receipt', 'itemsJson']")
  })

  it('C2: konzola delegira na novo ruto (HANDLERS)', () => {
    const console_ = read('src/app/api/admin/migrations/route.ts')
    expect(console_).toContain("import { POST as receiptSnapshotPOST } from '../migrate-receipt-snapshot/route'")
    expect(console_).toContain("'receipt-snapshot': receiptSnapshotPOST")
  })

  it('C3: KNOWN_DRIFTS allowlist vsebuje vnos (CI vrata spet zelena)', () => {
    const drift = read('scripts/drift-check.ts')
    expect(drift).toContain('isReceiptSnapshotStatement')
    expect(drift).toContain("id: 'receipt-snapshot'")
  })

  it('C4: i18n ključ v obeh jezikih (pariteta)', () => {
    expect(read('src/lib/i18n/sl.ts')).toContain("'mig.receiptSnapshot.desc'")
    expect(read('src/lib/i18n/hr.ts')).toContain("'mig.receiptSnapshot.desc'")
  })

  it('C5: endpoint kaže na obstoječo rutо na disku (integriteta Task 64-b)', () => {
    const p = join(ROOT, 'src', 'app', 'api', 'admin', 'migrate-receipt-snapshot', 'route.ts')
    expect(readFileSync(p, 'utf8').length).toBeGreaterThan(0)
  })
})

/* ── D · HOTFIX v1.239.2 — FK sonda coupons-waitlist (vrstice, ne izjema) ── */

describe('v1.239.2 D · FK sonda migrate-coupons-waitlist', () => {
  it('D1: sonda gleda VRSTICE pg_constraint, ne odsotnost izjeme', () => {
    const src = read('src/app/api/admin/migrate-coupons-waitlist/route.ts')
    // FIX vzorec: eksplicitna preverba dolžine rezultata
    expect(src).toContain("SELECT 1 AS one FROM pg_constraint WHERE conname = 'Coupon_guestId_fkey'")
    expect(src).toContain('Array.isArray(fkRows) && fkRows.length === 0')
    // STARI (napačni) vzorec exists() na pg_constraint je ODSTRANJEN
    expect(src).not.toContain('exists(`SELECT 1 FROM pg_constraint')
    // ADD CONSTRAINT stavek ostaja (izvede se, ko vrstic ni)
    expect(src).toContain('ADD CONSTRAINT "Coupon_guestId_fkey"')
  })

  it('D2: exists() helper ostane za TABELE/STOLPCE (izjema = manjka) — nespremenjen', () => {
    const src = read('src/app/api/admin/migrate-coupons-waitlist/route.ts')
    expect(src).toContain('SELECT 1 FROM "Coupon" LIMIT 1')
    expect(src).toContain('SELECT "notifyStatus" FROM "WaitlistEntry" LIMIT 1')
  })

  it('D3: SQLite pot ostaja preskok (db push zrcalo nosi FK)', () => {
    const src = read('src/app/api/admin/migrate-coupons-waitlist/route.ts')
    expect(src).toContain("skipped.push('Coupon_guestId_fkey (sqlite: db push zrcalo)')")
  })
})

/* ── Ž · verzija + dokumentacija ────────────────────────────────────────── */

describe('v1.239.1 Ž · verzija in dokumenti', () => {
  it('Ž1: APP_VERSION je trenutna (veriga: v1.239.1 DDL pot + v1.239.2 FK sonda)', () => {
    expect(APP_VERSION).toBe('1.303.0')
    expect(read('src/lib/version.ts')).toContain("'1.303.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.303.0')
  })

  it('Ž2: AUDIT števci usklajeni (3968/3968) + POSODOBITEV v1.239.1 (živi ključ ostane)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('4324 ključev SL in 4324 HR')
    expect(audit).toContain('**POSODOBITEV (hotfix v1.239.1):**')
  })

  it('Ž3: PRIMERJAVA §16 omenja DDL pot (doc-truth hotfixa)', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('migrate-receipt-snapshot')
  })
})
