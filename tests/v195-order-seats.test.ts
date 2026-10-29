import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { parseSeatOption } from '../src/lib/seat-assignments'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { PATCH as orderPATCH } from '../src/app/api/orders/[id]/route'
import { POST as syncPOST } from '../src/app/api/sync/route'
import { GET as checksGET } from '../src/app/api/orders/[id]/checks/route'

/**
 * N-27-1 (v1.195.0) — SEDEŽ PRI NAROČANJU (aktivni sedež tok; docs/TRZNA-VRZELI-2027.md).
 *
 * Izrecna opomba v1.193.0 (worklog MEJE): »sedeži se urejajo samo v plačilnem okviru
 * (orders.pay) — Square jih ima tudi pri naročanju, to ostaja odprta izboljšava, ne
 * vrzel.« v1.195.0 zapre to izboljšavo: `addItems[i].seat` (in `items[i].seat` pri
 * POST) — opcionalni sedež 1..10, null/izpuščeno = brez sedeža (obstoječi klienti
 * nespremenjeni). BREZ DDL (stolpec OrderItem.seat že v1.193.0).
 *
 * Merila:
 *  Č1 čisti sloj parseSeatOption (null/izpuščeno → null; 1..10 ok; 0/11/1.5/'abc' → napaka)
 *  G1 pravice (401 brez žetona, 403 brez orders.create, 404 tuje naročilo)
 *  G2 validacija (400 z sedežnim sporočilom — ne »Artikel ni na voljo«)
 *  G3 POST srečen tok (items[i].seat → OrderItem.seat v bazi; brez sedeža → null)
 *  G4 PATCH srečen tok (addItems[i].seat → nova postavka s sedežem)
 *  G5 offline sync (order.addItems op s sedežem; slab sedež → 400)
 *  G6 pregled (GET checks nosi seat; pregled po sedežih vidi dodane)
 *
 * ID-ji s predpono `v195-` (sweep beforeAll, cleanup afterAll).
 */

const PREFIX = 'v195-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let noPermToken = ''
let menuItemId = ''
let tableId = ''

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

/** Fixture naročila dobijo NASLEDNJO PROSTO orderNumber za lokacijo (isto pravilo kot
 *  nextSequence max+1) — fiksne številke kolizirajo s POST klici, ki med fixture klici
 *  prav tako dodelijo max+1 (P2002 na (locationId, orderNumber) — izmerjeno). */
async function createOrderWithItem(orderNumber: number, status = 'open', paymentStatus = 'unpaid'): Promise<{ orderId: string; itemId: string }> {
  const orderId = `${PREFIX}o${orderNumber}-${RUN}`
  const max = await db.order.aggregate({ where: { locationId: locId }, _max: { orderNumber: true } })
  const seq = (max._max.orderNumber ?? 0) + 1
  await db.order.create({ data: { id: orderId, locationId: locId, orderNumber: seq, status, paymentStatus, tableId } })
  const item = await db.orderItem.create({
    data: { id: `${PREFIX}oi${orderNumber}-${RUN}`, orderId, menuItemId, menuItemName: 'V195 Artikel', quantity: 1, price: 10, vatRate: 22, vatAmount: 0, status: 'fired' },
  })
  return { orderId, itemId: item.id }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `V195-${RUN.toUpperCase()}`, premisesId: `${PREFIX}prem-${RUN}`, country: 'SI' },
  })
  locId = loc.id
  tableId = `${PREFIX}tbl-${RUN}`
  await db.table.create({ data: { id: tableId, number: 901, locationId: locId, status: 'available' } })
  adminId = `${PREFIX}admin-${RUN}`
  const adminPin = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...adminPin },
  })
  const waiterPin = employeePinFields(`6${RUN.slice(-5)}`, `${PREFIX}clean-${RUN}@test.local`)
  const waiter = await db.employee.create({
    data: { id: `${PREFIX}clean-${RUN}`, name: `${PREFIX}Cistilka`, email: `${PREFIX}clean-${RUN}@test.local`, role: 'CLEANER', status: 'active', sessionVersion: 0, locationId: locId, ...waiterPin },
  })
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  menuItemId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Artikel`, price: 10, categoryId: cat.id } })).id
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  noPermToken = createToken({ sub: waiter.id, name: `${PREFIX}Cistilka`, role: 'CLEANER', loc: locId, sv: 0 })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

/* ───────────────────────── Č1 — čisti sloj (brez baze) ───────────────────────── */

describe('v1.195.0 — čisti sloj parseSeatOption', () => {
  test('Č1a izpuščeno/undefined/null/prazen niz → seat null (obstoječi klienti nespremenjeni)', () => {
    for (const v of [undefined, null, '']) {
      const r = parseSeatOption(v)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.seat).toBeNull()
    }
  })

  test('Č1b veljavne vrednosti 1..10 (številka in numeričen niz)', () => {
    for (const v of [1, 10, '5']) {
      const r = parseSeatOption(v)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.seat).toBe(Number(v))
    }
  })

  test('Č1c neveljavne vrednosti → napaka (0, 11, -1, 1.5, "abc")', () => {
    for (const v of [0, 11, -1, 1.5, 'abc', '2.7']) {
      const r = parseSeatOption(v)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('seat mora biti celo število')
    }
  })
})

/* ───────────────────────── G1 — pravice ───────────────────────── */

describe('v1.195.0 — pravice', () => {
  test('G1a POST brez žetona → 401', async () => {
    const res = await ordersPOST(req('/api/orders', null, 'POST', { items: [{ menuItemId, seat: 1 }] }))
    expect(res.status).toBe(401)
  })

  test('G1b PATCH s CLEANER (brez orders.create) → 403', async () => {
    const { orderId } = await createOrderWithItem(901)
    const res = await orderPATCH(req(`/api/orders/${orderId}`, noPermToken, 'PATCH', { addItems: [{ menuItemId, seat: 1 }] }), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(403)
  })

  test('G1c neznano naročilo → 404 (isti vzorec kot v193 G1c)', async () => {
    const res = await orderPATCH(req('/api/orders/ne-obstaja-v195', adminToken, 'PATCH', { addItems: [{ menuItemId, seat: 1 }] }), { params: Promise.resolve({ id: 'ne-obstaja-v195' }) })
    expect(res.status).toBe(404)
  })
})

/* ───────────────────────── G2 — validacija sedeža ───────────────────────── */

describe('v1.195.0 — validacija sedeža pri naročanju (400, ne tiho ignoriranje)', () => {
  test('G2a PATCH addItems seat=0 → 400 s sedežnim sporočilom', async () => {
    const { orderId } = await createOrderWithItem(903)
    const res = await orderPATCH(req(`/api/orders/${orderId}`, adminToken, 'PATCH', { addItems: [{ menuItemId, seat: 0 }] }), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(String(j?.error ?? '')).toContain('seat mora biti celo število')
  })

  test('G2b PATCH addItems seat="abc" → 400', async () => {
    const { orderId } = await createOrderWithItem(904)
    const res = await orderPATCH(req(`/api/orders/${orderId}`, adminToken, 'PATCH', { addItems: [{ menuItemId, seat: 'abc' }] }), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(400)
  })

  test('G2c POST items seat=11 → 400', async () => {
    const res = await ordersPOST(req('/api/orders', adminToken, 'POST', { locationId: locId, tableId, items: [{ menuItemId, seat: 11 }] }))
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(String(j?.error ?? '')).toContain('seat mora biti celo število')
  })
})

/* ───────────────────────── G3 — POST srečen tok ───────────────────────── */

describe('v1.195.0 — POST naročila s sedežem', () => {
  test('G3a items[i].seat → OrderItem.seat v bazi; brez sedeža → null', async () => {
    const res = await ordersPOST(req('/api/orders', adminToken, 'POST', {
      locationId: locId,
      tableId,
      items: [
        { menuItemId, qty: 1, seat: 2 },
        { menuItemId, qty: 2 }, // brez sedeža — starejši klient
      ],
    }))
    expect(res.status).toBe(201)
    const j = await res.json()
    const orderId = j?.order?.id ?? j?.id
    expect(orderId).toBeTruthy()
    const items = await db.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
    expect(items.length).toBe(2)
    const withSeat = items.filter((i) => i.seat === 2)
    const withoutSeat = items.filter((i) => i.seat === null)
    expect(withSeat.length).toBe(1)
    expect(withoutSeat.length).toBe(1)
    expect(withSeat[0].quantity).toBe(1)
    expect(withoutSeat[0].quantity).toBe(2)
  })
})

/* ───────────────────────── G4 — PATCH srečen tok ───────────────────────── */

describe('v1.195.0 — PATCH addItems s sedežem', () => {
  test('G4a dodane postavke nosijo sedež; obstoječe se ne premaknejo', async () => {
    const { orderId, itemId } = await createOrderWithItem(905)
    const res = await orderPATCH(req(`/api/orders/${orderId}`, adminToken, 'PATCH', {
      addItems: [
        { menuItemId, qty: 1, seat: 3 },
        { menuItemId, qty: 1, seat: 4 },
        { menuItemId, qty: 1 }, // brez sedeža
      ],
    }), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(200)
    const items = await db.orderItem.findMany({ where: { orderId } })
    const old = items.find((i) => i.id === itemId)
    expect(old?.seat ?? null).toBeNull() // obstoječa postavka ostaja brez sedeža
    const seats = items.filter((i) => i.id !== itemId).map((i) => i.seat).sort()
    expect(seats).toEqual([3, 4, null])
  })

  test('G4b pregled po sedežih (seatOverview vzorec) vidi dodane postavke', async () => {
    const { orderId } = await createOrderWithItem(906)
    await orderPATCH(req(`/api/orders/${orderId}`, adminToken, 'PATCH', {
      addItems: [{ menuItemId, qty: 2, seat: 1 }],
    }), { params: Promise.resolve({ id: orderId }) })
    const res = await checksGET(req(`/api/orders/${orderId}`, adminToken, 'GET', undefined), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(Array.isArray(j?.items)).toBe(true)
    const seated = (j.items as { seat: number | null }[]).filter((i) => i.seat === 1)
    expect(seated.length).toBe(1)
  })
})

/* ───────────────────────── G5 — offline sync pot ───────────────────────── */

describe('v1.195.0 — offline sync (order.addItems s sedežem)', () => {
  test('G5a op s sedežem → zapis s sedežem v bazi', async () => {
    const { orderId } = await createOrderWithItem(907)
    const res = await syncPOST(req('/api/sync', adminToken, 'POST', {
      deviceId: `${PREFIX}dev-${RUN}`,
      ops: [{ kind: 'order.addItems', clientOperationId: `${PREFIX}sync1-${RUN}`, payload: { orderId, addItems: [{ menuItemId, qty: 1, seat: 5 }] } }],
    }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j?.results?.[0]?.ok).toBe(true) // per-op izid (sync nikoli ne pada na ruti)
    const items = await db.orderItem.findMany({ where: { orderId } })
    const added = items.find((i) => i.seat === 5)
    expect(added).toBeTruthy()
    expect(added?.quantity).toBe(1)
  })

  test('G5b op s slabim sedežem → per-op napaka (fail-closed, ne tiho brez sedeža)', async () => {
    const { orderId } = await createOrderWithItem(908)
    const res = await syncPOST(req('/api/sync', adminToken, 'POST', {
      deviceId: `${PREFIX}dev-${RUN}`,
      ops: [{ kind: 'order.addItems', clientOperationId: `${PREFIX}sync2-${RUN}`, payload: { orderId, addItems: [{ menuItemId, qty: 1, seat: 99 }] } }],
    }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j?.results?.[0]?.ok).toBe(false)
    expect(String(j?.results?.[0]?.error ?? '')).toContain('seat mora biti celo število')
    const items = await db.orderItem.findMany({ where: { orderId } })
    expect(items.every((i) => i.seat === null)).toBe(true) // nič ni bilo zapisano
  })
})
