/**
 * AUDIT-FIX (v1.82.1) — regresijski testi za varnostne popravke prvega popravilnega vala.
 *
 * 1. waste/route.ts: umaknjen findFirst() fallback (§10 politika — centralna vloga
 *    brez lokacije + legacy artikel brez lokacije bi knjižila odpad na NAKLJUČNO
 *    lokacijo). Sedaj: fail-closed 400 z jasnim sporočilom.
 * 2. setup/status: rate limit (30/min/IP) — prej neomejen javni endpoint z 3 DB COUNT.
 * 3. Razrez monolita dashboard-tabs.tsx: barrel nazajkompatibilnost (vsak prej
 *    uvožen simbol ostaja izvoz iz @/components/dashboard-tabs) + datoteke tabs/ obstajajo.
 *
 * Fixture predpona: afx- (FK obratni vrstni red v afterAll).
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields, timingSafeEqualStr } from '../src/lib/auth'
import { POST as wastePOST } from '../src/app/api/waste/route'
import { GET as setupStatusGET } from '../src/app/api/setup/status/route'

const PREFIX = 'afx-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

function req(url: string, token: string | null, method = 'GET', body?: unknown, ip?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (ip) headers['x-forwarded-for'] = ip
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.wasteRecord.deleteMany({ where: { locationId: { startsWith: `${PREFIX}loc-` } } }).catch(() => null)
  await db.inventoryItem.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: `${PREFIX}` } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: `${PREFIX}loc-` } } }).catch(() => null)
})

const setupP = (async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: {
      id: `${PREFIX}loc-${RUN}`,
      name: `${PREFIX}Lokacija`,
      code: `AFX-${RUN.toUpperCase()}`,
      premisesId: `afx-prem-${RUN}`,
    },
  })
  // ADMIN brez lokacije (loc: null) — centralna vloga; ravno ta je sprožila findFirst bug
  const fields = employeePinFields(`${PIN_BASE}9`, `${PREFIX}admin-${RUN}@test.local`)
  const admin = await db.employee.create({
    data: {
      id: `${PREFIX}admin-${RUN}`,
      name: `${PREFIX}admin`,
      email: `${PREFIX}admin-${RUN}@test.local`,
      role: 'admin',
      status: 'active',
      sessionVersion: 0,
      locationId: null,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
  return {
    locId: loc.id,
    adminNoLocToken: createToken({ sub: admin.id, name: admin.name, role: 'ADMIN', loc: null, sv: 0 }),
  }
})()

describe('AUDIT-FIX v1.82.1 — waste: findFirst fallback umaknjen (fail-closed)', () => {
  test('ADMIN brez lokacije + artikel BREZ lokacije → 400 (prej: naključna lokacija prek findFirst)', async () => {
    const { adminNoLocToken } = await setupP
    // legacy artikel BREZ locationId
    const item = await db.inventoryItem.create({
      data: {
        id: `${PREFIX}item-noloc-${RUN}`,
        name: `${PREFIX}articlek bez lokacije`,
        unit: 'kg',
        quantity: 10,
        costPerUnit: 2,
      },
    })
    const res = await wastePOST(
      req('/api/waste', adminNoLocToken, 'POST', {
        itemId: item.id,
        quantity: 1,
        reason: 'pokvarjeno',
        idempotencyKey: `afx-${RUN}-1`,
      }),
    )
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(String(data.error || '')).toContain('Lokacija ni določljiva')
    // artikel NIMA odpada (odštevanje se ni zgodilo)
    const row = await db.inventoryItem.findUnique({ where: { id: item.id } })
    expect(Number(row?.quantity)).toBe(10)
  })

  test('ADMIN brez lokacije + artikel Z lokacijo → 201 (item.locationId je varovana pot, guardResource dovoli centralni)', async () => {
    const { adminNoLocToken, locId } = await setupP
    const item = await db.inventoryItem.create({
      data: {
        id: `${PREFIX}item-loc-${RUN}`,
        name: `${PREFIX}articlek z lokacijo`,
        unit: 'kg',
        quantity: 10,
        costPerUnit: 2,
        locationId: locId,
      },
    })
    const res = await wastePOST(
      req('/api/waste', adminNoLocToken, 'POST', {
        itemId: item.id,
        quantity: 2,
        reason: 'pokvarjeno',
        idempotencyKey: `afx-${RUN}-2`,
      }),
    )
    expect(res.status).toBe(201)
    const row = await db.inventoryItem.findUnique({ where: { id: item.id } })
    expect(Number(row?.quantity)).toBe(8)
    // zapis odpada KNJIŽEN na lokacijo artikla (eksplicitna, ne naključna)
    const wr = await db.wasteRecord.findFirst({ where: { idempotencyKey: `afx-${RUN}-2` } })
    expect(wr?.locationId).toBe(locId)
  })
})

describe('AUDIT-FIX v1.82.1 — setup/status rate limit (30/min/IP)', () => {
  test('31. klic z istega IP v minuti → 429 (prej: neomejeno, 3 DB COUNT na klic)', async () => {
    const ip = `10.99.${Date.now() % 250}.7`
    let saw429 = false
    let lastStatus = 0
    for (let i = 0; i < 32; i++) {
      const res = await setupStatusGET(req('/api/setup/status', null, 'GET', undefined, ip))
      lastStatus = res.status
      if (res.status === 429) { saw429 = true; break }
      expect(res.status).toBe(200)
    }
    expect(saw429).toBe(true)
    expect(lastStatus).toBe(429)
    // različen IP ni prizadet (limit je per-IP)
    const other = await setupStatusGET(req('/api/setup/status', null, 'GET', undefined, '10.7.7.7'))
    expect(other.status).toBe(200)
  })
})

describe('AUDIT-FIX v1.82.1 — timingSafeEqualStr (login pin pot)', () => {
  test('enaki nizi → true, različni → false, različne dolžine → false (brez meta)', () => {
    expect(timingSafeEqualStr('abc123', 'abc123')).toBe(true)
    expect(timingSafeEqualStr('abc123', 'abc124')).toBe(false)
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false)
    expect(timingSafeEqualStr('', '')).toBe(true)
    // hex digest obliki (pinLookup): case-insensitive prijava poti normalizira klicatelj
    expect(timingSafeEqualStr('aBc'.toLowerCase(), 'AbC'.toLowerCase())).toBe(true)
  })
})

describe('AUDIT-FIX v1.82.1 — razrez monolita dashboard-tabs (barrel nazajkompatibilnost)', () => {
  const COMP = join(import.meta.dir, '../src/components')

  test('src/components/tabs/ obstaja z vsaj 2 izluščenima domenama', () => {
    expect(existsSync(join(COMP, 'tabs'))).toBe(true)
    const files = readdirSync(join(COMP, 'tabs')).filter((f) => f.endsWith('.tsx'))
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files).toContain('ops-cards.tsx')
    expect(files).toContain('nabava-tab.tsx')
  })

  test('dashboard-tabs.tsx je barrel: re-exporti vseh prej kanoničnih simbolov + monolit < 7000 vrst.', () => {
    const src = readFileSync(join(COMP, 'dashboard-tabs.tsx'), 'utf-8')
    // re-exporti
    for (const sym of [
      'SalesByHourCard', 'LaborCostCard', 'DursCheckButton', 'NotificationsCard',
      'BatchesCard', 'BatchPrepCard', 'UpsellCard', 'DisplayPromosCard', 'NabavaTab',
    ]) {
      expect(src).toContain(sym)
    }
    expect(src).toContain("from './tabs/ops-cards'")
    expect(src).toContain("from './tabs/nabava-tab'")
    // monolit se je skrčil (9217 → cilj < 7000 v prvem valu)
    const lines = src.split('\n').length
    expect(lines).toBeLessThan(7000)
  })

  test('scaffold src/app/api/route.ts (Hello world, brez auth) je izbrisan', () => {
    expect(existsSync(join(import.meta.dir, '../src/app/api/route.ts'))).toBe(false)
  })

  test('PIN_LOOKUP_SALT: javna konstanta ni več produkcija fallback (dev/test ostaja)', async () => {
    const src = readFileSync(join(import.meta.dir, '../src/lib/auth.ts'), 'utf-8')
    // izvedena sol iz APP_SECRET v produkciji (brez env) — ne javna konstanta
    expect(src).toContain("createHmac('sha256', APP_SECRET)")
    // dev/test fallback ostaja (prijava v testih temelji na njem)
    expect(src).toContain("'restaurantos-pin-lookup-v1'")
    // glasnе opozorilo v produkciji
    expect(src).toContain('PIN_LOOKUP_SALT ni nastavljen')
  })
})
