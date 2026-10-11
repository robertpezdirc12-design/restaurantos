import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { assertTenantScope, assertOrgScope, guardResource, chainForLocation, type TenantChain } from '../src/lib/tenant'
import { GET as orderGET, PATCH as orderPATCH } from '../src/app/api/orders/[id]/route'
import { POST as tablesPOST } from '../src/app/api/tables/route'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Task 52 — org meja (tenant boundary) POVEZANA v rute (audit P1):
 *  - assertTenantScope: migracijsko varna semantika (neznana veriga uporabnika/vira → pass;
 *    prej: `!userChain → 403` v nasprotju z dokumentacijo + tenantAllows);
 *  - guardResource nadomešča assertResourceLocation v vseh točkovnih rutah (28 datotek);
 *  - assertOrgScope za CREATE rute (requireUserLocation + org gate; 18 mest).
 * DB-backed (dev SQLite): dve org drevesi (orgA/orgB) + legacy lokacija brez propertyId.
 * Vsi ID-ji s predpono `torg-` (idempotentno, cleanup v afterAll).
 */

const PREFIX = 'torg-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let orgA = '', brandA = '', propA = ''
let orgB = '', brandB = '', propB = ''
let locA1 = '', locA2 = '', locB1 = '', locLegacy = ''
let adminA = '', adminLegacy = '', waiterA = ''
let orderA2 = '', orderB1 = ''
let tableNumber = 9000

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(url: string, tok: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const isResp = (r: unknown): r is Response => r instanceof Response
const chain = (o: Partial<TenantChain>): TenantChain => ({
  organizationId: null, brandId: null, propertyId: null, locationId: null, ...o,
})

async function seedEmployee(name: string, role: string, loc: string, pinSeq: number): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
  const fields = employeePinFields(pinOf(pinSeq), `${PREFIX}${name}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${name}`, email: `${PREFIX}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  return id // ID — žetone gradi test s tok(), dvojno ovijanje je bilo vzrok lažnih 403
}

async function seedOrder(loc: string, n: number) {
  return db.order.create({
    data: { id: `${PREFIX}ord-${n}-${RUN}`, locationId: loc, orderNumber: n, status: 'open', paymentStatus: 'unpaid' },
  })
}

/** vsi route.ts pod src/app/api — statična regresija: ni več golih assertResourceLocation klicev */
function walkRoutes(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkRoutes(p))
    else if (e.name === 'route.ts') out.push(p)
  }
  return out
}

beforeAll(async () => {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  // drevo orgA → brandA → propA → locA1 + locA2; drevo orgB → brandB → propB → locB1; legacy lokacija brez propertyId
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locA1 = `${PREFIX}locA1-${RUN}`; locA2 = `${PREFIX}locA2-${RUN}`
  locB1 = `${PREFIX}locB1-${RUN}`; locLegacy = `${PREFIX}locLEG-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'Org A', slug: `${PREFIX}orga-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: 'Org B', slug: `${PREFIX}orgb-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'Brand A' } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'Brand B' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'Prop A' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'Prop B' } })
  await db.location.create({ data: { id: locA1, name: 'A1', code: `${PREFIX}A1-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locA2, name: 'A2', code: `${PREFIX}A2-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB1, name: 'B1', code: `${PREFIX}B1-${RUN}`, propertyId: propB } })
  await db.location.create({ data: { id: locLegacy, name: 'LEG', code: `${PREFIX}LEG-${RUN}` } })

  adminA = await seedEmployee('adminA', 'admin', locA1, 1)
  adminLegacy = await seedEmployee('adminLEG', 'admin', locLegacy, 2)
  waiterA = await seedEmployee('waiterA', 'waiter', locA1, 3)

  orderA2 = (await seedOrder(locA2, 1)).id
  orderB1 = (await seedOrder(locB1, 2)).id
})

describe('Task 52 — org meja: enote (tenant.ts)', () => {
  it('assertTenantScope: tuja org → 403; ista org → pass', async () => {
    const user = { sub: 'x', name: 'x', role: 'ADMIN', loc: locA1, sv: 0 }
    const deny = await assertTenantScope(user, chain({ organizationId: 'org-tuj', locationId: 'l-x' }))
    expect(isResp(deny)).toBe(true)
    if (isResp(deny)) expect(deny.status).toBe(403)
    const own = await assertTenantScope(user, chain({ organizationId: orgA, brandId: brandA, propertyId: propA, locationId: locA2 }))
    expect(own).toBeNull()
  })

  it('assertTenantScope (golo jedro): nestralcna vloga z znano org → org primerjava velja tudi njej', async () => {
    // guardResource v rutah prej 403-a po lokacijskem sloju (waiter nikoli ne pride sem);
    // golo jedro pa primerja verige ne glede na vlogo — dokumentirano v JSDoc.
    const waiter = { sub: 'x', name: 'x', role: 'WAITER', loc: locA1, sv: 0 }
    const deny = await assertTenantScope(waiter, chain({ organizationId: 'org-tuj', locationId: 'l-x' }))
    expect(isResp(deny)).toBe(true)
    if (isResp(deny)) expect(deny.status).toBe(403)
    // org fast-path (assertOrgScope) zanje takoj spusti — lokacijski sloj je že varoval:
    expect(await assertOrgScope(waiter, locB1)).toBeNull()
  })

  it('MIGRACIJSKO VARNO (popravek v1.53.0): neznana veriga uporabnika → pass (prej 403)', async () => {
    const user = { sub: 'x', name: 'x', role: 'ADMIN', loc: null, sv: 0 }
    const r = await assertTenantScope(user, chain({ organizationId: 'org-tuj', locationId: 'l-x' }))
    expect(r).toBeNull()
  })

  it('assertTenantScope: vir brez verige (legacy) → pass; bootstrap → pass', async () => {
    const user = { sub: 'x', name: 'x', role: 'ADMIN', loc: locA1, sv: 0 }
    expect(await assertTenantScope(user, null)).toBeNull()
    const boot = { sub: 'bootstrap', name: 'b', role: 'ADMIN', loc: null, sv: 0 }
    expect(await assertTenantScope(boot, chain({ organizationId: 'org-tuj' }))).toBeNull()
  })

  it('assertOrgScope: locId → veriga; neobstoječa/manjkajoča lokacija → pass; nestralcna → brez poizvedb', async () => {
    const admin = { sub: adminA, name: 'a', role: 'ADMIN', loc: locA1, sv: 0 }
    expect(isResp(await assertOrgScope(admin, locB1))).toBe(true)
    expect(await assertOrgScope(admin, locA2)).toBeNull()
    expect(await assertOrgScope(admin, 'torg-neobstaja')).toBeNull()
    expect(await assertOrgScope(admin, undefined)).toBeNull()
    const waiter = { sub: waiterA, name: 'w', role: 'WAITER', loc: locA1, sv: 0 }
    expect(await assertOrgScope(waiter, locB1)).toBeNull() // lokacijski sloj varuje (fast path)
  })

  it('chainForLocation: povezana lokacija nosi org/brand/property; legacy → null orgi', async () => {
    const a = await chainForLocation(locA1)
    expect(a?.organizationId).toBe(orgA)
    expect(a?.brandId).toBe(brandA)
    expect(a?.propertyId).toBe(propA)
    const legacy = await chainForLocation(locLegacy)
    expect(legacy).not.toBeNull()
    expect(legacy?.organizationId).toBeNull()
  })

  it('guardResource: staff na tujo lokacijo → 403 (lokacijski sloj), centralni v isti org → pass', async () => {
    const waiter = { sub: waiterA, name: 'w', role: 'WAITER', loc: locA1, sv: 0 }
    const denied = await guardResource(waiter, locB1)
    expect(isResp(denied)).toBe(true)
    const admin = { sub: adminA, name: 'a', role: 'ADMIN', loc: locA1, sv: 0 }
    expect(await guardResource(admin, locA2)).toBeNull()
  })
})

describe('Task 52 — org meja: rute (živo čez handlarje)', () => {
  it('READ: admin orgA na naročilo orgB → 403 (nova org meja)', async () => {
    const res = await orderGET(req(`/api/orders/${orderB1}`, tok(adminA, 'a', 'ADMIN', locA1)), { params: Promise.resolve({ id: orderB1 }) })
    expect(res.status).toBe(403)
  })

  it('READ: admin orgA na naročilo iste org (druga lokacija) → 200', async () => {
    const res = await orderGET(req(`/api/orders/${orderA2}`, tok(adminA, 'a', 'ADMIN', locA1)), { params: Promise.resolve({ id: orderA2 }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body?.order?.id).toBe(orderA2)
  })

  it('MIGRACIJSKO VARNO: admin z legacy lokacijo (brez propertyId) sme brati povezano orgB → 200', async () => {
    const res = await orderGET(req(`/api/orders/${orderB1}`, tok(adminLegacy, 'l', 'ADMIN', locLegacy)), { params: Promise.resolve({ id: orderB1 }) })
    expect(res.status).toBe(200)
  })

  it('MIGRACIJSKO VARNO: admin orgA sme brati legacy vir (brez propertyId) → 200', async () => {
    const orderL = (await seedOrder(locLegacy, 3)).id
    try {
      const res = await orderGET(req(`/api/orders/${orderL}`, tok(adminA, 'a', 'ADMIN', locA1)), { params: Promise.resolve({ id: orderL }) })
      expect(res.status).toBe(200)
    } finally {
      await db.order.delete({ where: { id: orderL } })
    }
  })

  it('READ: bootstrap admin gre skozi (break-glass) → 200', async () => {
    const boot = tok('bootstrap', 'Bootstrap', 'ADMIN', null)
    const res = await orderGET(req(`/api/orders/${orderB1}`, boot), { params: Promise.resolve({ id: orderB1 }) })
    expect(res.status).toBe(200)
  })

  it('READ: staff (waiter) na tujo lokacijo → 403 (lokacijski sloj nespremenjen)', async () => {
    const res = await orderGET(req(`/api/orders/${orderB1}`, tok(waiterA, 'w', 'WAITER', locA1)), { params: Promise.resolve({ id: orderB1 }) })
    expect(res.status).toBe(403)
  })

  it('WRITE: PATCH naročila orgB kot admin orgA → 403', async () => {
    const res = await orderPATCH(
      req(`/api/orders/${orderB1}`, tok(adminA, 'a', 'ADMIN', locA1), 'PATCH', { note: 'org poskus' }),
      { params: Promise.resolve({ id: orderB1 }) }
    )
    expect(res.status).toBe(403)
  })

  it('CREATE: tabelca na tujo org (body.locationId = locB1) → 403 in NI ustvarjena', async () => {
    const number = ++tableNumber
    const res = await tablesPOST(req('/api/tables', tok(adminA, 'a', 'ADMIN', locA1), 'POST', { number, locationId: locB1 }))
    expect(res.status).toBe(403)
    const count = await db.table.count({ where: { locationId: locB1, number } })
    expect(count).toBe(0)
  })

  it('CREATE: tabelca na lastno org (locA2) → uspešno ustvarjena', async () => {
    const number = ++tableNumber
    const res = await tablesPOST(req('/api/tables', tok(adminA, 'a', 'ADMIN', locA1), 'POST', { number, locationId: locA2 }))
    expect(res.status).toBeLessThan(400)
    const count = await db.table.count({ where: { locationId: locA2, number } })
    expect(count).toBe(1)
  })
})

describe('Task 52 — statična regresija: migracija na guardResource', () => {
  it('v src/app/api ni več ENERGA klica assertResourceLocation (vse → guardResource)', () => {
    const routes = walkRoutes(join(process.cwd(), 'src/app/api'))
    const stale = routes.filter((f) => /assertResourceLocation\s*\(/.test(readFileSync(f, 'utf8')))
    expect(stale).toEqual([])
    expect(routes.length).toBeGreaterThan(50)
  })
})

afterAll(async () => {
  await db.order.deleteMany({ where: { id: { startsWith: `${PREFIX}ord-` } } })
  await db.table.deleteMany({ where: { locationId: { in: [locA1, locA2, locB1, locLegacy] } } })
  await db.employee.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.property.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.brand.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.organization.deleteMany({ where: { id: { startsWith: PREFIX } } })
})
