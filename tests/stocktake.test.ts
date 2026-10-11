/**
 * Task 57 — inventurni protokol (DB-backed, dev SQLite; harness vzorec Task 54).
 * Ciklus: odpri(201, snapshot) → 409 drugi odprti → vnos(2 vrstice) → 400 negativno
 * → oddaj → 409 vnos po oddaji → recount(DRAFT, recountCount=1) → ponovni vnos
 * → oddaj → sočasna prodaja (10→9) → potrdi(adjusted=2, varianceValue=-6,
 * previousQty=9, newQty=9.5) → 409 dvojni approve → 409 cancel odobrenega
 * → nov popis → cancel → recount preklicanega 409 → org izolacija (403)
 * → waiter 403. PREFIX tst57- (idempotentno, cleanup v afterAll — obrnjen FK).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as listGET, POST as openPOST } from '../src/app/api/stocktakes/route'
import { GET as detailGET, PATCH as itemsPATCH } from '../src/app/api/stocktakes/[id]/route'
import { POST as submitPOST } from '../src/app/api/stocktakes/[id]/submit/route'
import { POST as approvePOST } from '../src/app/api/stocktakes/[id]/approve/route'
import { POST as cancelPOST } from '../src/app/api/stocktakes/[id]/cancel/route'
import { POST as recountPOST } from '../src/app/api/stocktakes/[id]/recount/route'

const P = 'tst57-'
const RUN = Date.now().toString(36)
let locA = '', locB = '', tokA = '', tokB = '', tokW = ''
let it1 = '', it2 = '', it3 = ''
let stId = '', l1 = '', l2 = '', l3 = ''
let st2Id = ''

function tok(name: string, role: string, loc: string | null): string {
  return createToken({ sub: `${P}${name}-${RUN}`, name: `${P}${name}`, role, loc, sv: 0 })
}

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const isResp = (r: unknown): r is Response => r instanceof Response

async function seedEmployee(name: string, role: string, loc: string | null, seq: number): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const pin = `${9300 + seq}`
  const f = employeePinFields(pin, `${P}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${name}`, email: `${P}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

beforeAll(async () => {
  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A` } })
  await db.location.create({ data: { id: locB, code: `${P}LB`, name: `${P}Lokacija B` } })
  it1 = `${P}it1-${RUN}`
  it2 = `${P}it2-${RUN}`
  it3 = `${P}it3-${RUN}`
  await db.inventoryItem.createMany({
    data: [
      { id: it1, name: `${P}Moka`, unit: 'kg', quantity: 10, costPerUnit: 2, locationId: locA },
      { id: it2, name: `${P}Sladkor`, unit: 'kg', quantity: 5, costPerUnit: 1, locationId: locA },
      { id: it3, name: `${P}Olje`, unit: 'l', quantity: 7, costPerUnit: 3, locationId: locA },
    ],
  })
  await seedEmployee('mgrA', 'MANAGER', locA, 1)
  await seedEmployee('mgrB', 'MANAGER', locB, 2)
  await seedEmployee('waiter', 'WAITER', locA, 3)
  tokA = tok('mgrA', 'MANAGER', locA)
  tokB = tok('mgrB', 'MANAGER', locB)
  tokW = tok('waiter', 'WAITER', locA)
})

afterAll(async () => {
  await db.stockTransaction.deleteMany({ where: { inventoryItemId: { in: [it1, it2, it3] } } })
  await db.stocktake.deleteMany({ where: { locationId: { in: [locA, locB] } } })
  await db.inventoryItem.deleteMany({ where: { id: { in: [it1, it2, it3] } } })
  await db.employee.deleteMany({ where: { id: { startsWith: P } } })
  await db.location.deleteMany({ where: { id: { in: [locA, locB] } } })
})

describe('Task 57 — inventurni protokol', () => {
  it('odpri → 201 DRAFT + snapshot količin', async () => {
    const r = await openPOST(req('POST', '/api/stocktakes', tokA, { note: 'mesečni popis' }))
    expect(r.status).toBe(201)
    const b = await r.json()
    stId = b.stocktake.id
    expect(b.stocktake.status).toBe('DRAFT')
    expect(b.stocktake.total).toBe(3)
    expect(b.stocktake.counted).toBe(0)
    const first = b.stocktake.items.find((i: { inventoryItemId: string }) => i.inventoryItemId === it1)
    l1 = first.id
    l2 = b.stocktake.items.find((i: { inventoryItemId: string }) => i.inventoryItemId === it2).id
    l3 = b.stocktake.items.find((i: { inventoryItemId: string }) => i.inventoryItemId === it3).id
    expect(first.expectedQty).toBe(10)
  })

  it('drugi odprti popis na isti lokaciji → 409', async () => {
    const r = await openPOST(req('POST', '/api/stocktakes', tokA, {}))
    expect(isResp(r)).toBe(true)
    if (!isResp(r)) return
    expect(r.status).toBe(409)
  })

  it('vnosi: 2 vrstici → saved=2 + countedQty obstane', async () => {
    const r = await itemsPATCH(req('PATCH', `/api/stocktakes/${stId}`, tokA, { items: [{ id: l1, countedQuantity: 9.5 }, { id: l2, countedQuantity: 0, lineNote: 'prazno' }] }), { params: Promise.resolve({ id: stId }) })
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.saved).toBe(2)
    const d = await (await detailGET(req('GET', `/api/stocktakes/${stId}`, tokA), { params: Promise.resolve({ id: stId }) })).json()
    expect(d.stocktake.counted).toBe(2)
    const line1 = d.stocktake.items.find((i: { inventoryItemId: string }) => i.inventoryItemId === it1)
    expect(line1.countedQty).toBe(9.5)
    const line2 = d.stocktake.items.find((i: { inventoryItemId: string }) => i.inventoryItemId === it2)
    expect(line2.countedQty).toBe(0)
  })

  it('negativna količina → 400', async () => {
    const r = await itemsPATCH(req('PATCH', `/api/stocktakes/${stId}`, tokA, { items: [{ id: l1, countedQuantity: -1 }] }), { params: Promise.resolve({ id: stId }) })
    expect(isResp(r)).toBe(true)
    if (!isResp(r)) return
    expect(r.status).toBe(400)
  })

  it('oddaj → SUBMITTED; vnos po oddaji → 409', async () => {
    const r = await submitPOST(req('POST', `/api/stocktakes/${stId}/submit`, tokA), { params: Promise.resolve({ id: stId }) })
    expect(r.status).toBe(200)
    expect((await r.json()).status).toBe('SUBMITTED')
    const p = await itemsPATCH(req('PATCH', `/api/stocktakes/${stId}`, tokA, { items: [{ id: l1, countedQuantity: 1 }] }), { params: Promise.resolve({ id: stId }) })
    expect(isResp(p)).toBe(true)
    if (!isResp(p)) return
    expect(p.status).toBe(409)
  })

  it('recount → DRAFT + recountCount=1; ponovni vnos + oddaja', async () => {
    const r = await recountPOST(req('POST', `/api/stocktakes/${stId}/recount`, tokA), { params: Promise.resolve({ id: stId }) })
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.status).toBe('DRAFT')
    expect(b.recountCount).toBe(1)
    const p = await itemsPATCH(req('PATCH', `/api/stocktakes/${stId}`, tokA, { items: [{ id: l3, countedQuantity: 7 }] }), { params: Promise.resolve({ id: stId }) })
    expect(p.status).toBe(200)
    const s = await submitPOST(req('POST', `/api/stocktakes/${stId}/submit`, tokA), { params: Promise.resolve({ id: stId }) })
    expect(s.status).toBe(200)
  })

  it('sočasna prodaja (10→9) → approve: previousQty=9, newQty=9.5, varianceValue=-6', async () => {
    await db.inventoryItem.update({ where: { id: it1 }, data: { quantity: 9 } })
    const r = await approvePOST(req('POST', `/api/stocktakes/${stId}/approve`, tokA), { params: Promise.resolve({ id: stId }) })
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.status).toBe('APPROVED')
    expect(b.adjusted).toBe(2)
    expect(b.varianceValue).toBeCloseTo(-6, 5)
    const inv1 = await db.inventoryItem.findUnique({ where: { id: it1 } })
    expect(Number(inv1?.quantity)).toBe(9.5)
    const inv2 = await db.inventoryItem.findUnique({ where: { id: it2 } })
    expect(Number(inv2?.quantity)).toBe(0)
    const inv3 = await db.inventoryItem.findUnique({ where: { id: it3 } })
    expect(Number(inv3?.quantity)).toBe(7)
    const tx = await db.stockTransaction.findFirst({ where: { inventoryItemId: it1, type: 'STOCKTAKE' } })
    expect(tx).not.toBeNull()
    expect(Number(tx?.previousQty)).toBe(9)
    expect(Number(tx?.newQty)).toBe(9.5)
    const line1 = await db.stocktakeItem.findFirst({ where: { stocktakeId: stId, inventoryItemId: it1 } })
    expect(Number(line1?.varianceQuantity)).toBe(-0.5)
  })

  it('dvojni approve → 409; cancel odobrenega → 409', async () => {
    const a = await approvePOST(req('POST', `/api/stocktakes/${stId}/approve`, tokA), { params: Promise.resolve({ id: stId }) })
    expect(isResp(a)).toBe(true)
    if (!isResp(a)) return
    expect(a.status).toBe(409)
    const c = await cancelPOST(req('POST', `/api/stocktakes/${stId}/cancel`, tokA), { params: Promise.resolve({ id: stId }) })
    expect(isResp(c)).toBe(true)
    if (!isResp(c)) return
    expect(c.status).toBe(409)
  })

  it('nov popis → cancel → CANCELLED; recount preklicanega → 409', async () => {
    const o = await openPOST(req('POST', '/api/stocktakes', tokA, {}))
    expect(o.status).toBe(201)
    st2Id = (await o.json()).stocktake.id
    const c = await cancelPOST(req('POST', `/api/stocktakes/${st2Id}/cancel`, tokA), { params: Promise.resolve({ id: st2Id }) })
    expect(c.status).toBe(200)
    expect((await c.json()).status).toBe('CANCELLED')
    const rc = await recountPOST(req('POST', `/api/stocktakes/${st2Id}/recount`, tokA), { params: Promise.resolve({ id: st2Id }) })
    expect(isResp(rc)).toBe(true)
    if (!isResp(rc)) return
    expect(rc.status).toBe(409)
  })

  it('org/lokacijska izolacija: manager B na popisu lokacije A → 403', async () => {
    const r = await approvePOST(req('POST', `/api/stocktakes/${stId}/approve`, tokB), { params: Promise.resolve({ id: stId }) })
    expect(isResp(r)).toBe(true)
    if (!isResp(r)) return
    expect(r.status).toBe(403)
  })

  it('waiter (brez inventory.manage) → 403; seznam vidi samo svoje lokacije', async () => {
    const w = await openPOST(req('POST', '/api/stocktakes', tokW, {}))
    expect(isResp(w)).toBe(true)
    if (!isResp(w)) return
    expect(w.status).toBe(403)
    const l = await listGET(req('GET', '/api/stocktakes', tokB))
    expect(l.status).toBe(200)
    const b = await l.json()
    expect(b.stocktakes.every((s: { locationId: string }) => s.locationId === locB)).toBe(true)
  })
})
