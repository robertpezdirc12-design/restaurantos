import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { parseSeatAssignments, seatOverview, buildSeatSplitPlan } from '../src/lib/seat-assignments'
import { PUT as seatsPUT, GET as seatsGET } from '../src/app/api/orders/[id]/seats/route'
import { POST as seatSplitPOST } from '../src/app/api/orders/[id]/checks/seats/route'
import { GET as checksGET } from '../src/app/api/orders/[id]/checks/route'

/**
 * P3 #20 (v1.193.0) — SEAT-LEVEL management (raven sedeža, Square vzorec).
 *
 * Tržna vrzel (docs/TRZNA-VRZELI-2026.md §4 P3 #20): »sedeži trenutno samo števec« —
 * postavka ne ve, KDO jo je naročil. v1.193.0 doda:
 *  - OrderItem.seat (aditivni ničeni stolpec — DDL konzola »order-item-seats«);
 *  - PUT/GET /api/orders/[id]/seats (polni nadomestni načrt + pregled po sedežih);
 *  - POST /api/orders/[id]/checks/seats (vsak zaseden sedež → svoj izstavek,
 *    brez sedeža → bazni izstavek #1; rebalans kot split po gostih v1.185.0);
 *  - čisti sloj src/lib/seat-assignments.ts (validacija, pregled, načrt).
 *
 * Merila:
 *  Č1 čisti sloj (validacija načrta, pregled po sedežih, načrt splita — determinizem)
 *  G1 pravice (401 brez žetona, 403 brez orders.pay, 404 tuje naročilo)
 *  G2 validacija (400: slab sedež, postavka na dveh sedežih, tuj/voided id)
 *  G3 konservativnost (409: plačano naročilo, plačan izstavek, izstavek s plačilom)
 *  G4 srečen tok PUT (dodelitev + pregled + polni nadomestni počisti omenjene)
 *  G5 srečen tok splita (2 sedeža + brez → 3 izstavki, baza #1 ohrani id, audit)
 *  G6 rebalans (ponovni klic ne doda izstavkov)
 *  G7 en sam zaseden sedež → 409 (ničesar za razdeliti — brez lažnega uspeha)
 *  G8 voided postavke izključene iz načrta in pregleda
 *
 * ID-ji s predpono `v193-` (sweep beforeAll, cleanup afterAll).
 */

const PREFIX = 'v193-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let noPayToken = ''
let menuItemId = ''

function req(url: string, token: string | null, method = 'POST', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

let itemSeq = 0

async function seedItem(orderId: string, name: string, price: number, qty = 1, voided = false, seat: number | null = null): Promise<{ id: string; seat: number | null }> {
  itemSeq += 1
  const row = await db.orderItem.create({
    data: {
      id: `${PREFIX}it${itemSeq}-${RUN}`, orderId, menuItemId, menuItemName: name, quantity: qty, price, vatRate: 22, vatAmount: 0,
      status: 'fired', voided, seat,
    },
  })
  return { id: row.id, seat: row.seat ?? null }
}

async function openOrder(orderNumber: number, status = 'open', paymentStatus = 'unpaid') {
  return db.order.create({ data: { id: `${PREFIX}o${orderNumber}-${RUN}`, locationId: locId, orderNumber, status, paymentStatus } })
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `V193-${RUN.toUpperCase()}`, premisesId: `${PREFIX}prem-${RUN}`, country: 'SI' },
  })
  locId = loc.id
  adminId = `${PREFIX}admin-${RUN}`
  const adminPin = employeePinFields(`9${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...adminPin },
  })
  const cleanerPin = employeePinFields(`8${RUN.slice(-5)}`, `${PREFIX}clean-${RUN}@test.local`)
  const waiter = await db.employee.create({
    data: { id: `${PREFIX}clean-${RUN}`, name: `${PREFIX}Cistilka`, email: `${PREFIX}clean-${RUN}@test.local`, role: 'CLEANER', status: 'active', sessionVersion: 0, locationId: locId, ...cleanerPin },
  })
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  menuItemId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Artikel`, price: 10, categoryId: cat.id } })).id
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  noPayToken = createToken({ sub: waiter.id, name: `${PREFIX}Cistilka`, role: 'CLEANER', loc: locId, sv: 0 })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

/* ───────────────────────── Č1 — čisti sloj (brez baze) ───────────────────────── */

describe('v1.193.0 — čisti sloj sedežev', () => {
  test('Č1a parseSeatAssignments: veljaven načrt + prazen = počisti vse', () => {
    const ok = parseSeatAssignments({ assignments: [{ seat: 1, itemIds: [' a ', 'b'] }, { seat: 10, itemIds: ['c'] }] })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.assignments[0]).toEqual({ seat: 1, itemIds: ['a', 'b'] }) // obrezano
      expect(ok.assignments[1]).toEqual({ seat: 10, itemIds: ['c'] })
    }
    const clear = parseSeatAssignments({ assignments: [] })
    expect(clear.ok).toBe(true)
  })

  test('Č1b parseSeatAssignments: neveljavni vnosi → ok:false s sporočilom', () => {
    expect(parseSeatAssignments(null).ok).toBe(false)
    expect(parseSeatAssignments({}).ok).toBe(false)
    expect(parseSeatAssignments({ assignments: 'vse' }).ok).toBe(false)
    for (const badSeat of [0, 11, 1.5, 'dva']) {
      const r = parseSeatAssignments({ assignments: [{ seat: badSeat, itemIds: ['a'] }] })
      expect(r.ok, `seat=${String(badSeat)}`).toBe(false)
    }
    expect(parseSeatAssignments({ assignments: [{ seat: 1, itemIds: [] }] }).ok).toBe(false)
    expect(parseSeatAssignments({ assignments: [{ seat: 1, itemIds: [''] }] }).ok).toBe(false)
    // ista postavka v dveh sedežih
    const cross = parseSeatAssignments({ assignments: [{ seat: 1, itemIds: ['a'] }, { seat: 2, itemIds: ['a'] }] })
    expect(cross.ok).toBe(false)
    if (!cross.ok) expect(cross.error).toContain('več sedežem')
    // dvakrat v istem sedežu
    const dup = parseSeatAssignments({ assignments: [{ seat: 3, itemIds: ['a', 'a'] }] })
    expect(dup.ok).toBe(false)
  })

  test('Č1c seatOverview: skupine naraščajoče, »brez sedeža« zadnji, voided izključeni, vsote r2', () => {
    const ov = seatOverview([
      { id: 'i3', name: 'C', quantity: 1, price: 2.5, seat: null, voided: false },
      { id: 'i2', name: 'B', quantity: 2, price: 3.0, seat: 2, voided: false },
      { id: 'i1', name: 'A', quantity: 1, price: 18.9, seat: 1, voided: false },
      { id: 'i4', name: 'Void', quantity: 5, price: 9.99, seat: 1, voided: true },
    ])
    expect(ov.map((g) => g.seat)).toEqual([1, 2, null])
    expect(ov[0].itemIds).toEqual(['i1'])
    expect(ov[0].total).toBe(18.9)
    expect(ov[1].total).toBe(6.0)
    expect(ov[2].itemIds).toEqual(['i3'])
    // brez postavk → prazen pregled
    expect(seatOverview([])).toEqual([])
  })

  test('Č1d buildSeatSplitPlan: <2 zasedena sedeža → napaka; sicer determinističen načrt', () => {
    const single = buildSeatSplitPlan([{ id: 'a', quantity: 1, price: 5, seat: 1, voided: false }])
    expect(single.ok).toBe(false)
    if (!single.ok) expect(single.error).toContain('vsaj dva')

    const plan = buildSeatSplitPlan([
      { id: 'u2', quantity: 1, price: 4.5, seat: null, voided: false },
      { id: 's2b', quantity: 1, price: 3.0, seat: 2, voided: false },
      { id: 's2a', quantity: 2, price: 3.0, seat: 2, voided: false },
      { id: 's1', quantity: 1, price: 18.9, seat: 1, voided: false },
      { id: 'dead', quantity: 9, price: 9, seat: 3, voided: true },
    ])
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.groups.map((g) => g.seat)).toEqual([1, 2])
      expect(plan.groups[0].itemIds).toEqual(['s1'])
      expect(plan.groups[1].itemIds).toEqual(['s2a', 's2b']) // po id znotraj sedeža
      expect(plan.groups[1].total).toBe(9.0)
      expect(plan.unassignedItemIds).toEqual(['u2'])
    }
  })
})

/* ───────────────────────── G1 — pravice ───────────────────────── */

describe('v1.193.0 — sedeži: pravice in varovalke', () => {
  test('G1a brez žetona → 401 (PUT in split)', async () => {
    const o = await openOrder(970000)
    const put = await seatsPUT(req(`/api/orders/${o.id}/seats`, null, 'PUT', { assignments: [{ seat: 1, itemIds: ['x'] }] }), { params: Promise.resolve({ id: o.id }) })
    expect(put.status).toBe(401)
    const split = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, null, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(split.status).toBe(401)
  })

  test('G1b CLEANER brez orders.pay → 403 (PUT, GET, split)', async () => {
    const o = await openOrder(970001)
    const put = await seatsPUT(req(`/api/orders/${o.id}/seats`, noPayToken, 'PUT', { assignments: [] }), { params: Promise.resolve({ id: o.id }) })
    expect(put.status).toBe(403)
    const get = await seatsGET(req(`/api/orders/${o.id}/seats`, noPayToken, 'GET'), { params: Promise.resolve({ id: o.id }) })
    expect(get.status).toBe(403)
    const split = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, noPayToken, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(split.status).toBe(403)
  })

  test('G1c neznano naročilo → 404', async () => {
    const put = await seatsPUT(req(`/api/orders/${PREFIX}manjka-${RUN}/seats`, adminToken, 'PUT', { assignments: [] }), { params: Promise.resolve({ id: `${PREFIX}manjka-${RUN}` }) })
    expect(put.status).toBe(404)
    const split = await seatSplitPOST(req(`/api/orders/${PREFIX}manjka-${RUN}/checks/seats`, adminToken, 'POST'), { params: Promise.resolve({ id: `${PREFIX}manjka-${RUN}` }) })
    expect(split.status).toBe(404)
  })

  /* ───────────────────────── G2 — validacija ───────────────────────── */

  test('G2a PUT: slab sedež / postavka na dveh sedežih → 400', async () => {
    const o = await openOrder(970002)
    const it = await seedItem(o.id, 'Kava', 2.5)
    const badSeat = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [{ seat: 11, itemIds: [it.id] }] }), { params: Promise.resolve({ id: o.id }) })
    expect(badSeat.status).toBe(400)
    const cross = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [{ seat: 1, itemIds: [it.id] }, { seat: 2, itemIds: [it.id] }] }), { params: Promise.resolve({ id: o.id }) })
    expect(cross.status).toBe(400)
  })

  test('G2b PUT: tuj id in voided id → 400', async () => {
    const o = await openOrder(970003)
    await seedItem(o.id, 'Kava', 2.5)
    const voided = await seedItem(o.id, 'Void', 5, 1, true)
    const foreign = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [{ seat: 1, itemIds: [`${PREFIX}tuje-${RUN}`] }] }), { params: Promise.resolve({ id: o.id }) })
    expect(foreign.status).toBe(400)
    const voidRes = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [{ seat: 1, itemIds: [voided.id] }] }), { params: Promise.resolve({ id: o.id }) })
    expect(voidRes.status).toBe(400)
  })

  /* ───────────────────────── G3 — konservativnost ───────────────────────── */

  test('G3a plačano naročilo → 409 (PUT in split)', async () => {
    const o = await openOrder(970004, 'paid', 'paid')
    await seedItem(o.id, 'Kava', 2.5)
    const put = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [] }), { params: Promise.resolve({ id: o.id }) })
    expect(put.status).toBe(409)
    const split = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, adminToken, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(split.status).toBe(409)
  })

  test('G3b plačan izstavek → 409', async () => {
    const o = await openOrder(970005)
    await seedItem(o.id, 'Kava', 2.5)
    await db.check.create({ data: { id: `${PREFIX}chkPaid-${RUN}`, checkNumber: 1, orderId: o.id, paymentStatus: 'paid' } })
    const put = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [] }), { params: Promise.resolve({ id: o.id }) })
    expect(put.status).toBe(409)
  })

  test('G3c izstavek s plačilom (paymentStatus unpaid!) → 409', async () => {
    const o = await openOrder(970006)
    await seedItem(o.id, 'Kava', 2.5)
    const chk = await db.check.create({ data: { id: `${PREFIX}chkPay-${RUN}`, checkNumber: 1, orderId: o.id, paymentStatus: 'unpaid' } })
    await db.payment.create({ data: { id: `${PREFIX}pay-${RUN}`, checkId: chk.id, amount: 2.5, type: 'cash' } })
    const split = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, adminToken, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(split.status).toBe(409)
  })
})

/* ───────────────────────── G4–G8 — srečni tokovi ───────────────────────── */

describe('v1.193.0 — sedeži: srečni tokovi', () => {
  test('G4 PUT dodelitev: pregled odraža sedeže, polni nadomestni počisti omenjene', async () => {
    const o = await openOrder(970007)
    const a = await seedItem(o.id, 'Zebra pečenka', 18.9)
    const b = await seedItem(o.id, 'Burek', 3.5)
    const c = await seedItem(o.id, 'Juha', 4.5)

    const put = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', {
      assignments: [{ seat: 1, itemIds: [a.id] }, { seat: 2, itemIds: [b.id, c.id] }],
    }), { params: Promise.resolve({ id: o.id }) })
    expect(put.status).toBe(200)
    const pj = (await put.json()) as { assigned: number; overview: { seat: number | null; items: number; total: number }[] }
    expect(pj.assigned).toBe(3)
    expect(pj.overview.map((g) => g.seat)).toEqual([1, 2])

    // GET odraža isti pregled
    const get = await seatsGET(req(`/api/orders/${o.id}/seats`, adminToken, 'GET'), { params: Promise.resolve({ id: o.id }) })
    expect(get.status).toBe(200)
    const gj = (await get.json()) as { overview: { seat: number | null; total: number }[]; items: { id: string; seat: number | null }[] }
    expect(gj.overview.map((g) => g.seat)).toEqual([1, 2])
    expect(gj.overview[0].total).toBe(18.9)
    expect(gj.overview[1].total).toBe(8.0)
    const seatOf = (id: string) => gj.items.find((it) => it.id === id)?.seat ?? null
    expect(seatOf(a.id)).toBe(1)
    expect(seatOf(b.id)).toBe(2)

    // polni nadomestni: ponovni PUT brez postavke `c` POČISTI njen sedež (ne zadrži)
    const put2 = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', {
      assignments: [{ seat: 1, itemIds: [a.id, b.id] }],
    }), { params: Promise.resolve({ id: o.id }) })
    expect(put2.status).toBe(200)
    const get2 = await seatsGET(req(`/api/orders/${o.id}/seats`, adminToken, 'GET'), { params: Promise.resolve({ id: o.id }) })
    const gj2 = (await get2.json()) as { items: { id: string; seat: number | null }[] }
    const seatOf2 = (id: string) => gj2.items.find((it) => it.id === id)?.seat ?? null
    expect(seatOf2(a.id)).toBe(1)
    expect(seatOf2(b.id)).toBe(1)
    expect(seatOf2(c.id)).toBeNull()
  })

  test('G5 split po sedežih: 2 zasedena + brez → 3 izstavki, baza #1 ohrani id, audit, GET checks odraža', async () => {
    const o = await openOrder(970008)
    const a = await seedItem(o.id, 'Zebra pečenka', 18.9)
    const b = await seedItem(o.id, 'Burek', 3.5)
    const c = await seedItem(o.id, 'Juha', 4.5)
    await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', {
      assignments: [{ seat: 1, itemIds: [a.id] }, { seat: 2, itemIds: [b.id] }],
    }), { params: Promise.resolve({ id: o.id }) })

    const baseCheck = await db.check.create({ data: { id: `${PREFIX}chkBase-${RUN}`, checkNumber: 1, orderId: o.id, paymentStatus: 'unpaid' } })

    const res = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, adminToken, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { checks: { id: string; checkNumber: number; seat: number | null; items: number; total: number | null }[] }
    expect(body.checks).toHaveLength(3)
    expect(body.checks.map((k) => k.seat)).toEqual([null, 1, 2])
    expect(body.checks.map((k) => k.checkNumber)).toEqual([1, 2, 3])
    // bazni izstavek ohrani id, nosi samo postavke brez sedeža
    expect(body.checks[0].id).toBe(baseCheck.id)
    expect(body.checks[0].items).toBe(1)
    expect(body.checks[0].total).toBe(4.5)
    expect(body.checks[1].total).toBe(18.9)
    expect(body.checks[2].total).toBe(3.5)

    // postavke so fizično na pravih izstavkih
    const after = await db.orderItem.findMany({ where: { orderId: o.id }, select: { id: true, checkId: true } })
    const checkOf = (id: string) => after.find((it) => it.id === id)?.checkId ?? null
    expect(checkOf(c.id)).toBe(baseCheck.id)
    expect(checkOf(a.id)).not.toBe(baseCheck.id)
    expect(checkOf(b.id)).not.toBe(baseCheck.id)
    expect(checkOf(a.id)).not.toBe(checkOf(b.id))

    // revizijska veriga
    const audit = await db.auditLog.findFirst({ where: { entityType: 'Order', entityId: o.id, action: 'ORDER_CHECK_SEAT_SPLIT' } })
    expect(audit).not.toBeNull()

    // GET checks odraža 3 izstavke + sedeže na postavkah
    const checksRes = await checksGET(req(`/api/orders/${o.id}/checks`, adminToken, 'GET'), { params: Promise.resolve({ id: o.id }) })
    const cj = (await checksRes.json()) as { checkCount: number; items: { id: string; checkNumber: number | null; seat: number | null }[] }
    expect(cj.checkCount).toBe(3)
    const rowOf = (id: string) => cj.items.find((it) => it.id === id)
    expect(rowOf(a.id)?.seat).toBe(1)
    expect(rowOf(b.id)?.seat).toBe(2)
    expect(rowOf(c.id)?.seat).toBeNull()
  })

  test('G6 rebalans: ponovni split ne doda izstavkov', async () => {
    const o = await openOrder(970009)
    const a = await seedItem(o.id, 'Zebra', 18.9)
    const b = await seedItem(o.id, 'Burek', 3.5)
    const c = await seedItem(o.id, 'Juha', 4.5)
    await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', {
      assignments: [{ seat: 1, itemIds: [a.id] }, { seat: 2, itemIds: [b.id, c.id] }],
    }), { params: Promise.resolve({ id: o.id }) })
    const first = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, adminToken, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(first.status).toBe(200)
    const again = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, adminToken, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(again.status).toBe(200)
    const aj = (await again.json()) as { checks: unknown[] }
    expect(aj.checks).toHaveLength(2) // 2 zasedena sedeža, nič brez sedeža → baza + sedeži... baza prazna ne nastane
    const count = await db.check.count({ where: { orderId: o.id } })
    expect(count).toBe(2)
  })

  test('G7 en sam zaseden sedež → 409 (brez lažnega uspeha)', async () => {
    const o = await openOrder(970010)
    const a = await seedItem(o.id, 'Kava', 2.5)
    const b = await seedItem(o.id, 'Sok', 3.0)
    await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [{ seat: 1, itemIds: [a.id, b.id] }] }), { params: Promise.resolve({ id: o.id }) })
    const res = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, adminToken, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error: string }
    expect(j.error).toContain('vsaj dva')
  })

  test('G8 voided postavke izključene iz pregleda in splita (tudi s sedežem v bazi)', async () => {
    const o = await openOrder(970011)
    const a = await seedItem(o.id, 'Kava', 2.5)
    const b = await seedItem(o.id, 'Sok', 3.0)
    // voided postavka z ostankom sedeža 3 v bazi — ne sme vplivati
    const v = await seedItem(o.id, 'Void', 50, 1, true, 3)
    // voided id ni dodeljiv (400)
    const bad = await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [{ seat: 1, itemIds: [v.id] }] }), { params: Promise.resolve({ id: o.id }) })
    expect(bad.status).toBe(400)
    await seatsPUT(req(`/api/orders/${o.id}/seats`, adminToken, 'PUT', { assignments: [{ seat: 1, itemIds: [a.id] }, { seat: 2, itemIds: [b.id] }] }), { params: Promise.resolve({ id: o.id }) })
    // pregled: samo sedeža 1 in 2 — sedež 3 (voided) ni viden
    const get = await seatsGET(req(`/api/orders/${o.id}/seats`, adminToken, 'GET'), { params: Promise.resolve({ id: o.id }) })
    const gj = (await get.json()) as { overview: { seat: number | null }[]; items: { id: string; seat: number | null }[] }
    expect(gj.overview.map((g) => g.seat)).toEqual([1, 2])
    // voided postavka ne sme prejeti sedeža od polnega nadomestnega načrta
    const vAfter = gj.items.find((it) => it.id === v.id)
    expect(vAfter).toBeUndefined()
    // split: 2 izstavka (sedeža 1 in 2) — voided sedež 3 ne ustvari izstavka,
    // prazna baza NE nastane (vse žive postavke imajo sedež)
    const res = await seatSplitPOST(req(`/api/orders/${o.id}/checks/seats`, adminToken, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(200)
    const sj = (await res.json()) as { checks: { seat: number | null }[] }
    expect(sj.checks.map((k) => k.seat).sort((x, y) => (x ?? 99) - (y ?? 99))).toEqual([1, 2])
    const chkCount = await db.check.count({ where: { orderId: o.id } })
    expect(chkCount).toBe(2)
  })
})
