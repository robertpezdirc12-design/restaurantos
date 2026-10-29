/**
 * Task 54 — org allow-lista na SEZNAMSKIH endpointih (locationScope, audit §13 omejitev).
 *
 * Prej: centralne vloge videle sezname VSEH lokacij (locationScope → {} za centralne).
 * Zdaj: locationScope za centralne vloge vrne locationId IN [lokacije svoje org + nevezane
 * legacy (propertyId null)] — migracijsko varno, isti pravilnik kot assertTenantScope/
 * assertOrgScope (Task 52): neznana org uporabnika → brez filtra (produkcija z nevezanimi
 * lokacijami se ne regresira), bootstrap → break-glass.
 *
 * DB-backed (dev SQLite): dve org drevesi (orgA/orgB) + legacy lokacija brez propertyId.
 * Vsi ID-ji s predpono `torgl-` (idempotentno, cleanup v afterAll — obrnjen FK vrstni red).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as ordersGET } from '../src/app/api/orders/route'

const PREFIX = 'torgl-'
const RUN = Date.now().toString(36)

let orgA = '', brandA = '', propA = ''
let orgB = '', brandB = '', propB = ''
let locA1 = '', locA2 = '', locB1 = '', locLegacy = ''
let adminA = '', adminB = '', adminLegacy = '', waiterA = ''
let orderA1 = '', orderA2 = '', orderB1 = '', orderLEG = ''
let orderSeq = 7100

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(url: string, token: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

const isResp = (r: unknown): r is Response => r instanceof Response

/** ID — žetone gradi test s tok() (lekcija Task 52: dvojno ovijanje = lažni 403). */
async function seedEmployee(name: string, role: string, loc: string, pinSeq: number): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
  const pin = `${9100 + pinSeq}`
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${name}`, email: `${PREFIX}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  return id
}

async function seedOrder(loc: string): Promise<string> {
  const n = ++orderSeq
  const o = await db.order.create({
    data: { id: `${PREFIX}ord-${n}-${RUN}`, locationId: loc, orderNumber: n, status: 'open', paymentStatus: 'unpaid' },
  })
  return o.id
}

/** vsi route.ts pod src/app/api — statična regresija: ni več SINHRONIH locationScope klicev */
function walkRoutes(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkRoutes(p))
    else if (e.name === 'route.ts') out.push(p)
  }
  return out
}

async function listOrderIds(token: string): Promise<string[]> {
  const res = await ordersGET(req('/api/orders', token))
  expect(isResp(res)).toBe(true)
  if (isResp(res)) expect(res.status).toBe(200)
  const body = await res.json()
  expect(Array.isArray(body?.orders)).toBe(true)
  return (body.orders as { id: string }[]).map((o) => o.id)
}

beforeAll(async () => {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
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
  adminB = await seedEmployee('adminB', 'admin', locB1, 2)
  adminLegacy = await seedEmployee('adminLEG', 'admin', locLegacy, 3)
  waiterA = await seedEmployee('waiterA', 'waiter', locA1, 4)

  orderA1 = await seedOrder(locA1)
  orderA2 = await seedOrder(locA2)
  orderB1 = await seedOrder(locB1)
  orderLEG = await seedOrder(locLegacy)
})

describe('Task 54 — org allow-lista na seznamih (locationScope ŽIVO)', () => {
  it('centralna orgA vidi svoji lokaciji + legacy, NE orgB', async () => {
    const ids = await listOrderIds(tok(adminA, 'a', 'ADMIN', locA1))
    expect(ids).toContain(orderA1)
    expect(ids).toContain(orderA2) // druga lokacije iste org — VIDNA (org meja, ne lokacijska)
    expect(ids).toContain(orderLEG) // nevezana legacy lokacija — migracijsko varno vidna
    expect(ids).not.toContain(orderB1) // tuja org — FILTRIRANA
  })

  it('centralna orgB vidi svojo + legacy, NE orgA', async () => {
    const ids = await listOrderIds(tok(adminB, 'b', 'ADMIN', locB1))
    expect(ids).toContain(orderB1)
    expect(ids).toContain(orderLEG)
    expect(ids).not.toContain(orderA1)
    expect(ids).not.toContain(orderA2)
  })

  it('MIGRACIJSKO VARNO: admin z legacy lokacijo (org neznana) → brez org filtra (vidi vse)', async () => {
    const ids = await listOrderIds(tok(adminLegacy, 'l', 'ADMIN', locLegacy))
    expect(ids).toContain(orderA1)
    expect(ids).toContain(orderA2)
    expect(ids).toContain(orderB1)
    expect(ids).toContain(orderLEG)
  })

  it('bootstrap admin (break-glass) vidi vse', async () => {
    const ids = await listOrderIds(tok('bootstrap', 'Bootstrap', 'ADMIN', null))
    expect(ids).toContain(orderA1)
    expect(ids).toContain(orderB1)
    expect(ids).toContain(orderLEG)
  })

  it('staff (waiter) — lokacijski sloj NESPREMENJEN: izključno svoja lokacija', async () => {
    const ids = await listOrderIds(tok(waiterA, 'w', 'WAITER', locA1))
    expect(ids).toContain(orderA1)
    expect(ids).not.toContain(orderA2) // tudi ISTE org ne sme (lokacijska meja staffu)
    expect(ids).not.toContain(orderB1)
    expect(ids).not.toContain(orderLEG)
  })
})

describe('Task 54 — statična regresija: vse rute awaitajo locationScope', () => {
  it('v src/app/api ni SINHRONIH locationScope klicev (vsi → await)', () => {
    const routes = walkRoutes(join(process.cwd(), 'src/app/api'))
    const stale = routes.filter((f) => /(?<!await )locationScope\(/.test(readFileSync(f, 'utf8')))
    expect(stale).toEqual([])
  })

  it('codemod je dejansko potrdil ≥ 20 rut z await locationScope', () => {
    const routes = walkRoutes(join(process.cwd(), 'src/app/api'))
    const wired = routes.filter((f) => readFileSync(f, 'utf8').includes('await locationScope('))
    // Task 57: stocktakes GET je 28. org-obsegan seznamski endpoint (async locationScope) —
    // Task 64: haccp/plans GET je 29. —
    // OPS-7 (v1.69.0): staff-shifts GET je 30. (urnik izmen, lokacijski obseg) —
    // pin se dviga samo z NOVO ruto, nikoli z umikom await (regresija ostaja zaščiten).
    // OPS-8 (v1.72.0): purchase-orders/suggestions GET je 31. (predlogi naročil) —
    // OPS-8 (v1.72.0): inventory/batches GET je 32. (serije / rok uporabe).
    // OPS-8 (v1.73.0): reports/gl GET je 33. (GL dnevnik — orientacijski dnevni obračun).
    // OPS-10 (v1.77.0): reports/sales-by-hour GET je 34. (prodaja po urah) —
    // OPS-10 (v1.77.0): reports/labor-cost GET je 35. (labor stroški).
    // OPS-10 (v1.79.0): batch-preparations GET je 36. (priprava po serijah — seznam batchov).
    // Issue #5 (v1.88.0): +11 rut (webhooks, monitoring/errors, integrations, locations/stats,
    // locations, kitchen/stats, kitchen, menu-engineering, recipes, discounts, purchase-orders —
    // org allow-lista namesto ročnih centralnih bypassov) → 47
    // Issue #65 (v1.96.0): import-eslog (apVisibleInScope — duplicate/replay tenant-scope,
    // list↔replay konsistentnost s /api/expenses) → 48
    // Issue #18 (v1.103.0): ap/[id]/match GET (tristransko ujemanje — predlogi PO
    // postavk v uporabnikovem obsegu) → 49
    // Issue #17 (v1.106.0): reports/food-cost GET (food-cost varianca — Artikli/
    // transakcije/naročila/inventure v uporabnikovem obsegu) → 50
    // Issue #19 (v1.107.0): reports/exceptions GET (poročilo finančnih izjem —
    // kanonične audit vrstice v uporabnikovem obsegu) → 51
    // Issue #20 (v1.109.0): haccp detail [id] GET + [id]/actions POST +
    // report GET (zapisi/dogodki v uporabnikovem obsegu) → 54
    // Issue #21 (v1.111.0): manager-call GET (klici vodje v uporabnikovem obsegu) → 55
    // Issue #14 (v1.112.0): prep-stations GET (KDS poimenovane postaje — seznam
    // postaj v uporabnikovem obsegu, additive KDS polja) → 56
    // Issue #12 (v1.113.0): purchase-orders/recommendations GET (priporočeni
    // nabavni nalogi — poraba/roki/pakiranja v uporabnikovem obsegu) → 57
    // Issue #24 (v1.114.0): labels GET (etikete pripravljene hrane — seznam
    // etiket znotraj obsega uporabnika, locationScope) → 58
    // Issue #22 (v1.115.0): payroll GET (obračunska obdobja — seznam obdobij
    // znotraj obsega uporabnika, locationScope) → 59
    // Issue #8 (v1.116.0): transfers GET (medlokacijski prenosi — seznam
    // prenosov znotraj obsega uporabnika, OR from/to locationScope) → 60
    // Issue #11 (v1.126.0): +5 rut (crm/segments, crm/guests, crm/guests/export,
    // crm/campaigns, crm/duplicates GET — segmenti/gosti/kampanje/dedupe v
    // uporabnikovem obsegu, locationScope) → 71
    // Issue #4 (v1.125.0): +6 rut (einvoices GET/detail/send/retry/xml/issue —
    // B2B e-računi: izdaja iz naročila v obsegu + seznam/dokaz/statusi v obsegu) → 66
    // P2-9 (v1.186.0): reports/ai-insights GET (vpogledi v uporabnikovem obsegu —
    // locationScope v ruti; reports/labor-forecast je PREDPOTUJUČI: scope nalaga
    // skupni loader labor-forecast-data, zato šteje naslednja ruta, ne ta) → 72
    // P2-10b (v1.187.0): coupons GET (kuponi v uporabnikovem obsegu — locationScope
    // v ruti; odkup gre prek orders/[id]/discount, ki ima guardResource že od #4) → 73
    expect(wired.length).toBe(73)
  })
})

afterAll(async () => {
  await db.order.deleteMany({ where: { id: { startsWith: `${PREFIX}ord-` } } })
  await db.employee.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.property.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.brand.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.organization.deleteMany({ where: { id: { startsWith: PREFIX } } })
})
