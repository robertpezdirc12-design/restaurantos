/**
 * Issue #38 (P1) — EventLog tenant/lokacijski ključ:
 *  - GET /api/events: org-bound OWNER/ADMIN vidi SAMO dogodke svoje organizacije
 *    (filter nad DB stolpcem EventLog.locationId — lažen payload.locationId ne
 *    more preskočiti obsega); isti obseg za pending/failed števce;
 *  - bootstrap admin = break-glass globalni pregled (edini vidi NULL-location
 *    legacy/sistemske dogodke);
 *  - centralna vloga z NEZNANO organizacijo → fail-closed (prazno, števci 0);
 *  - MANAGER z settings.manage → GET 403 (requireCentralRole) in dispatch 403
 *    (prej zgolj settings.manage → globalni dispatch tujih tenantov);
 *  - dispatchPending(scope): org central obdeluje SAMO svoje dogodke (tuji in
 *    NULL ostanejo nedotaknjeni); bootstrap dispatch vse;
 *  - publishEvent: locationId IZKLJUČNO iz opts (verifikovani vir), NIKOLI iz
 *    klientovega payload-a; pot prek realne rute (stocktake submit) zapiše
 *    kanonično lokacijo.
 *
 * NAMENOMA: sejanje dogodkov BREZ publishEvent klicev v beforeAll (objave
 * sprožijo detached dispatchPending, ki bi predelal sejana stanja); pot prek
 * realne rute je v zadnjem describe-u, kjer njeni stranski učinki ne morejo
 * prelomiti prejšnjih trditev.
 *
 * ID-ji s predpono `i38-` (sweep beforeAll/afterAll + eksplicitni cleanup
 * EventLog/AuditLog po entityId/id predponi).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { publishEvent, __resetHandlersForTests } from '../src/lib/events'
import { GET as eventsGET } from '../src/app/api/events/route'
import { POST as dispatchPOST } from '../src/app/api/events/dispatch/route'
import { POST as stocktakeOpenPOST } from '../src/app/api/stocktakes/route'
import { POST as submitPOST } from '../src/app/api/stocktakes/[id]/submit/route'

const PREFIX = 'i38-'
const RUN = Date.now().toString(36)

let orgA = '', brandA = '', propA = '', locA = ''
let orgB = '', brandB = '', propB = '', locB = ''
let locUnbound = ''
let adminA = '', adminB = '', adminUnbound = '', managerA = ''

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}
const bootTok = () => createToken({ sub: 'bootstrap', name: 'Bootstrap', role: 'ADMIN', loc: null, sv: 0 })

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const isResp = (r: unknown): r is Response => r instanceof Response

async function status(r: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const v = (await (r as Promise<unknown> | Response)) as unknown
  expect(isResp(v)).toBe(true)
  const res = v as Response
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function seedEmployee(name: string, role: string, loc: string | null, pinSeq: number): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
  const pin = String(10000000 + ([...`${id}${pinSeq}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 89999999, 7)))
  const fields = employeePinFields(pin, `${id}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${name}`, email: `${id}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  return id
}

interface Ev { id: string; type?: string; locationId: string | null; status?: string; payload?: Record<string, unknown> }
async function seedEvent(e: Ev): Promise<string> {
  await db.eventLog.create({
    data: {
      // unikaten tip sonde: GET filter type=I38Probe zagotovi vidnost tudi v
      // akumulirani ci-fresh bazi (take-limit ne more potisniti sond čez rob)
      id: e.id, type: e.type ?? 'I38Probe', entityType: 'InventoryItem',
      entityId: e.id, payload: JSON.stringify(e.payload ?? {}), status: e.status ?? 'pending',
      locationId: e.locationId,
    },
  })
  return e.id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  locA = `${PREFIX}locA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locB = `${PREFIX}locB-${RUN}`
  locUnbound = `${PREFIX}locU-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'I38 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'BA' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'PA' } })
  await db.location.create({ data: { id: locA, name: 'I38 A', code: `${PREFIX}A-${RUN}`, propertyId: propA } })
  await db.organization.create({ data: { id: orgB, name: 'I38 Org B', slug: `${PREFIX}b-${RUN}` } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'BB' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'PB' } })
  await db.location.create({ data: { id: locB, name: 'I38 B', code: `${PREFIX}B-${RUN}`, propertyId: propB } })
  // nevezana legacy lokacija (propertyId null) — njeni dogodki: fail-closed
  await db.location.create({ data: { id: locUnbound, name: 'I38 U', code: `${PREFIX}U-${RUN}` } })

  adminA = await seedEmployee('adminA', 'ADMIN', locA, 1)
  adminB = await seedEmployee('adminB', 'ADMIN', locB, 2)
  adminUnbound = await seedEmployee('adminU', 'ADMIN', locUnbound, 3)
  managerA = await seedEmployee('managerA', 'MANAGER', locA, 4)

  // zaloga za popis (pot prek realne rute — zadnji describe)
  await db.inventoryItem.create({ data: { id: `${PREFIX}invA-${RUN}`, name: `${PREFIX} Sol`, unit: 'kg', quantity: 5, minQuantity: 1, costPerUnit: 1, locationId: locA } })
  await db.inventoryItem.create({ data: { id: `${PREFIX}invB-${RUN}`, name: `${PREFIX} Poper`, unit: 'kg', quantity: 5, minQuantity: 1, costPerUnit: 1, locationId: locB } })

  // dogodki (BREZ publishEvent — noben detached dispatch ne moti sejanih stanj):
  // orgA ×2 (pending + failed), orgB ×2 (pending), legacy NULL ×1,
  // locUnbound ×1, lažni-payload ×1 (locationId=locB v stolpcu, locA v payloadu)
  await seedEvent({ id: `${PREFIX}ev-a1-${RUN}`, locationId: locA, status: 'pending' })
  await seedEvent({ id: `${PREFIX}ev-a2-${RUN}`, locationId: locA, status: 'failed' })
  await seedEvent({ id: `${PREFIX}ev-b1-${RUN}`, locationId: locB, status: 'pending' })
  await seedEvent({ id: `${PREFIX}ev-b2-${RUN}`, locationId: locB, status: 'pending' })
  await seedEvent({ id: `${PREFIX}ev-null-${RUN}`, locationId: null, status: 'pending' })
  await seedEvent({ id: `${PREFIX}ev-unbound-${RUN}`, locationId: locUnbound, status: 'pending' })
  await seedEvent({ id: `${PREFIX}ev-fake-${RUN}`, locationId: locB, status: 'pending', payload: { locationId: locA } })
})

afterAll(async () => {
  await db.eventLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } })
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: PREFIX } }, { entityId: 'dispatch' }] } })
  await sweepTestFixtures(db, [PREFIX])
})

/* ═══════════════════ GET /api/events — tenant obseg ═══════════════════ */

describe('issue #38 — GET /api/events tenant obseg', () => {
  it('ADMIN orgA vidi SAMO dogodke orgA (locA); tujih NULL/unbound ne', async () => {
    const r = await status(eventsGET(req('/api/events?type=I38Probe', tok(adminA, 'aA', 'ADMIN', locA))))
    expect(r.code).toBe(200)
    const evts = r.body.events as { id: string; locationId: string | null }[]
    const ids = evts.map((e) => e.id)
    expect(ids).toContain(`${PREFIX}ev-a1-${RUN}`)
    expect(ids).toContain(`${PREFIX}ev-a2-${RUN}`)
    for (const never of [`${PREFIX}ev-b1-${RUN}`, `${PREFIX}ev-b2-${RUN}`, `${PREFIX}ev-null-${RUN}`, `${PREFIX}ev-unbound-${RUN}`, `${PREFIX}ev-fake-${RUN}`]) {
      expect(ids).not.toContain(never)
    }
    // vsi vidni dogodki so vezani na locA
    for (const e of evts) expect(e.locationId).toBe(locA)
  })

  it('ADMIN orgB vidi SAMO dogodke orgB', async () => {
    const r = await status(eventsGET(req('/api/events?type=I38Probe', tok(adminB, 'aB', 'ADMIN', locB))))
    expect(r.code).toBe(200)
    const ids = (r.body.events as { id: string }[]).map((e) => e.id)
    expect(ids).toContain(`${PREFIX}ev-b1-${RUN}`)
    expect(ids).toContain(`${PREFIX}ev-fake-${RUN}`) // stolpec locB → orgB ga vidi (lažen payload je neškodljiv)
    for (const never of [`${PREFIX}ev-a1-${RUN}`, `${PREFIX}ev-a2-${RUN}`, `${PREFIX}ev-null-${RUN}`, `${PREFIX}ev-unbound-${RUN}`]) {
      expect(ids).not.toContain(never)
    }
  })

  it('lažen payload.locationId NE more preskočiti obsega (filter nad DB stolpcem)', async () => {
    // ev-fake ima locationId=locB v DB, locA v payloadu → orgA NE vidi
    const r = await status(eventsGET(req('/api/events?type=I38Probe&status=pending', tok(adminA, 'aA', 'ADMIN', locA))))
    expect(r.code).toBe(200)
    const ids = (r.body.events as { id: string }[]).map((e) => e.id)
    expect(ids).not.toContain(`${PREFIX}ev-fake-${RUN}`)
  })

  it('števci pending/failed nad ISTIM obsegom kot seznam (DB primerjava, isti where)', async () => {
    const r = await status(eventsGET(req('/api/events', tok(adminA, 'aA', 'ADMIN', locA))))
    expect(r.code).toBe(200)
    const q = r.body.queue as { pending: number; failed: number }
    const orgLocs = await db.location.findMany({ where: { Property: { Brand: { organizationId: orgA } } }, select: { id: true } })
    const inA = { locationId: { in: orgLocs.map((l) => l.id) } }
    const [pend, fail] = await Promise.all([
      db.eventLog.count({ where: { ...inA, status: 'pending' } }),
      db.eventLog.count({ where: { ...inA, status: 'failed' } }),
    ])
    expect(q.pending).toBe(pend)
    expect(q.failed).toBe(fail)
    expect(q.pending).toBe(1) // ev-a1
    expect(q.failed).toBe(1)  // ev-a2
  })

  it('bootstrap admin vidi VSE (break-glass global) — tudi NULL/unbound legacy', async () => {
    const r = await status(eventsGET(req('/api/events?type=I38Probe', bootTok())))
    expect(r.code).toBe(200)
    const ids = (r.body.events as { id: string }[]).map((e) => e.id)
    for (const must of [`${PREFIX}ev-a1-${RUN}`, `${PREFIX}ev-b1-${RUN}`, `${PREFIX}ev-null-${RUN}`, `${PREFIX}ev-unbound-${RUN}`, `${PREFIX}ev-fake-${RUN}`]) {
      expect(ids).toContain(must)
    }
  })

  it('centralna vloga z NEZNANO organizacijo → fail-closed (prazno, števci 0)', async () => {
    const r = await status(eventsGET(req('/api/events', tok(adminUnbound, 'aU', 'ADMIN', locUnbound))))
    expect(r.code).toBe(200)
    expect(r.body.events).toEqual([])
    const q = r.body.queue as { pending: number; failed: number }
    expect(q.pending).toBe(0)
    expect(q.failed).toBe(0)
  })

  it('MANAGER (settings.manage) → GET 403 (centralna vloga je pogoj)', async () => {
    const r = await status(eventsGET(req('/api/events', tok(managerA, 'mA', 'MANAGER', locA))))
    expect(r.code).toBe(403)
  })

  it('minimalni DTO: brez payload/error vsebine; locationId viden (diagnostika)', async () => {
    const r = await status(eventsGET(req('/api/events?type=I38Probe', tok(adminA, 'aA', 'ADMIN', locA))))
    expect(r.code).toBe(200)
    const evts = r.body.events as Record<string, unknown>[]
    expect(evts.length).toBeGreaterThan(0)
    for (const e of evts) {
      expect(Object.keys(e)).not.toContain('payload')
      expect(Object.keys(e)).not.toContain('error')
      expect(Object.keys(e)).toContain('locationId')
    }
  })
})

/* ═══════════════════ POST /api/events/dispatch ═══════════════════ */

describe('issue #38 — POST /api/events/dispatch', () => {
  it('MANAGER z settings.manage → 403 (ne more sprožiti globalne obdelave)', async () => {
    const r = await status(dispatchPOST(req('/api/events/dispatch', tok(managerA, 'mA', 'MANAGER', locA), 'POST', {})))
    expect(r.code).toBe(403)
  })

  it('centralna vloga z neznano org → 403 (izrecna platformna operacija)', async () => {
    const r = await status(dispatchPOST(req('/api/events/dispatch', tok(adminUnbound, 'aU', 'ADMIN', locUnbound), 'POST', {})))
    expect(r.code).toBe(403)
  })

  it('ADMIN orgA dispatcha SAMO svoje dogodke — tuji/NULL/unbound ostanejo pending', async () => {
    __resetHandlersForTests() // brez handlerjev → dispatchi "uspešni" (processed)
    const r = await status(dispatchPOST(req('/api/events/dispatch', tok(adminA, 'aA', 'ADMIN', locA), 'POST', { limit: 100 })))
    expect(r.code).toBe(200)
    const d = r.body.dispatched as { processed: number; failed: number; scanned: number }
    expect(d.failed).toBe(0)
    expect(d.scanned).toBe(2) // ev-a1 (pending) + ev-a2 (failed, poskus < 5)
    // orgA dogodki so processed
    const a1 = await db.eventLog.findUnique({ where: { id: `${PREFIX}ev-a1-${RUN}` }, select: { status: true } })
    const a2 = await db.eventLog.findUnique({ where: { id: `${PREFIX}ev-a2-${RUN}` }, select: { status: true } })
    expect(a1?.status).toBe('processed')
    expect(a2?.status).toBe('processed')
    // orgB + NULL + unbound: NEDOTAKNJENI (pending)
    for (const id of [`${PREFIX}ev-b1-${RUN}`, `${PREFIX}ev-b2-${RUN}`, `${PREFIX}ev-null-${RUN}`, `${PREFIX}ev-unbound-${RUN}`, `${PREFIX}ev-fake-${RUN}`]) {
      const row = await db.eventLog.findUnique({ where: { id }, select: { status: true } })
      expect(row?.status).toBe('pending')
    }
    // audit zapis akcije (akter + obseg + števke, brez vsebine dogodkov)
    const audit = await db.auditLog.findFirst({ where: { action: 'EVENTS_DISPATCH' }, orderBy: { id: 'desc' } })
    expect(audit).not.toBeNull()
    expect(audit?.userId).toBe(adminA)
  })

  it('bootstrap dispatch obdavi vse (globalni break-glass) — tudi NULL/legacy', async () => {
    __resetHandlersForTests()
    // №30: bootstrap je GLOBALNA pot, zato njegovo število ni odvisno samo od te
    // datoteke. Prej je `toBe(5)` v CI-ju padel z "Expected 5, Received 6" in ni
    // povedal, KDO je onesnažil. Dejanski vzrok je bil P1008 v
    // tests/order-concurrency.test.ts: tam je preklicni handler držal pisalno
    // ključavnico (SQLite dopušča enega samega pisalca), `db.eventLog.update()` v
    // src/lib/events.ts:175 je bil prekinjen in je za seboj pustil vrstico
    // stanja 'pending'.
    // Sedaj: lastnih vrst je točno 5 (trdo), tuje se preštejejo in IMENUJEJO —
    // aritmetika ostane natančna, odpoved pa vodi do storilca namesto do števke.
    const tujke = await db.eventLog.findMany({
      where: { status: 'pending', NOT: { id: { startsWith: PREFIX } } },
      select: { id: true, type: true },
    })
    expect(await db.eventLog.count({ where: { status: 'pending', id: { startsWith: PREFIX } } })).toBe(5)
    const r = await status(dispatchPOST(req('/api/events/dispatch', bootTok(), 'POST', { limit: 100 })))
    expect(r.code).toBe(200)
    const d = r.body.dispatched as { processed: number }
    expect(d.processed, `tuje pending vrste (onesnaženje pred tem testom): ${tujke.slice(0, 5).map((t) => `${t.id}=${t.type}`).join(', ') || 'ni jih'}`).toBe(5 + tujke.length)
    for (const id of [`${PREFIX}ev-b1-${RUN}`, `${PREFIX}ev-b2-${RUN}`, `${PREFIX}ev-null-${RUN}`, `${PREFIX}ev-unbound-${RUN}`, `${PREFIX}ev-fake-${RUN}`]) {
      const row = await db.eventLog.findUnique({ where: { id }, select: { status: true } })
      expect(row?.status).toBe('processed')
    }
  })

  it('odgovor dispatcha vsebuje SAMO števke (brez id-jev/payload-a tujih dogodkov)', async () => {
    __resetHandlersForTests()
    const r = await status(dispatchPOST(req('/api/events/dispatch', bootTok(), 'POST', { limit: 1 })))
    expect(r.code).toBe(200)
    const body = JSON.stringify(r.body)
    expect(body).not.toContain(`${PREFIX}ev-`)
    expect(body).not.toContain('payload')
  })
})

/* ═══════════════════ publishEvent — verifikovani vir ═══════════════════ */

describe('issue #38 — publishEvent kanonični locationId', () => {
  it('locationId iz opts (verifikovani vir) — NE iz klientovega payload-a', async () => {
    __resetHandlersForTests()
    const id = await publishEvent('StockChanged', {
      entityType: 'InventoryItem',
      entityId: `${PREFIX}pub-${RUN}`,
      payload: { locationId: locA },        // lažen "klient" vir
      locationId: locB,                     // verifikovani strežniški vir
    })
    expect(id).not.toBeNull()
    const row = await db.eventLog.findUnique({ where: { id: id as string }, select: { locationId: true } })
    expect(row?.locationId).toBe(locB)      // DB stolpec = strežniška resnica
  })

  it('realna pot: stocktake open+submit zapišeta EventLog s kanonično lokacijo popisa', async () => {
    __resetHandlersForTests()
    // popis A (MANAGER na locA)
    const openA = await status(stocktakeOpenPOST(req('/api/stocktakes', tok(managerA, 'mA', 'MANAGER', locA), 'POST', { note: `${PREFIX} popis A` })))
    expect(openA.code).toBe(201)
    const stA = (openA.body.stocktake as { id: string }).id
    const subA = await status(submitPOST(req(`/api/stocktakes/${stA}/submit`, tok(managerA, 'mA', 'MANAGER', locA), 'POST', {}), { params: Promise.resolve({ id: stA }) }))
    expect(subA.code).toBe(200)
    // popis B (ADMIN na locB)
    const openB = await status(stocktakeOpenPOST(req('/api/stocktakes', tok(adminB, 'aB', 'ADMIN', locB), 'POST', { note: `${PREFIX} popis B` })))
    expect(openB.code).toBe(201)
    const stB = (openB.body.stocktake as { id: string }).id
    const subB = await status(submitPOST(req(`/api/stocktakes/${stB}/submit`, tok(adminB, 'aB', 'ADMIN', locB), 'POST', {}), { params: Promise.resolve({ id: stB }) }))
    expect(subB.code).toBe(200)

    const rowsA = await db.eventLog.findMany({ where: { type: 'StocktakeSubmitted', entityId: stA }, select: { locationId: true } })
    expect(rowsA.length).toBe(1)
    expect(rowsA[0].locationId).toBe(locA)
    const rowsB = await db.eventLog.findMany({ where: { type: 'StocktakeSubmitted', entityId: stB }, select: { locationId: true } })
    expect(rowsB.length).toBe(1)
    expect(rowsB[0].locationId).toBe(locB)
  })
})
