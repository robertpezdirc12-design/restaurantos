import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { PATCH as orderPATCH, DELETE as orderDELETE } from '../src/app/api/orders/[id]/route'

/**
 * Issue #47 + #48 — STATE MACHINE NAROČILA (v1.89.0):
 *  #47: ročni PATCH status=PAID je UKINJEN (brez Payment/Receipt/EOR bi ustvaril
 *       'plačano brez dokaza' + blokiral kanonično issueFursReceipt CAS pot);
 *  #48: terminalna matrika — cancelled/paid sta terminalna za VSE ročne prehode
 *       (prej CANCELLED → OPEN/SENT/PREPARED možen), addItems CAS je BELA LISTA
 *       (status IN (open,sent,prepared) AND paymentStatus IN (unpaid,partial) —
 *       prej samo paymentStatus !== 'paid'), preklic spravi paymentStatus v
 *       terminalno 'cancelled' in prekliče odprte plačilne povezave.
 *
 * ID-ji s predpono `i47-` (idempotentno, cleanup afterAll, obrnjen FK vrstni red).
 */

const PREFIX = 'i47-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locId = ''
let managerId = ''
let waiterId = ''
let miId = ''

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function tokenFor(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

async function seedEmployee(name: string, role: string, pin: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}${name}-${RUN}`, name: `${PREFIX}${name}`, email: `${PREFIX}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: locId,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
}

/** naročilo (po želji z mizo + začetnim stanjem) */
async function seedOrder(n: number, status = 'open', paymentStatus = 'unpaid', tableId?: string) {
  return db.order.create({
    data: { id: `${PREFIX}ord-${n}-${RUN}`, locationId: locId, orderNumber: 1000 + n, status, paymentStatus, ...(tableId ? { tableId } : {}) },
  })
}

async function seedLink(n: number, orderId: string, index = 1, count = 2) {
  return db.payLink.create({
    data: { id: `${PREFIX}pl${n}-${RUN}`, orderId, locationId: locId, token: `${PREFIX}tok${n}${RUN}`, status: 'open', amount: 5, splitIndex: index, splitCount: count },
  })
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `I47-${RUN.toUpperCase()}`, premisesId: `i47-prem-${RUN}` },
  })
  locId = loc.id
  const manager = await seedEmployee('manager', 'manager', pinOf(1))
  managerId = manager.id
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(2))
  waiterId = waiter.id
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: 'I47 Meni', locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: 'I47 Kategorija', menuId: menu.id } })
  miId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: 'I47 Pizza', price: 10, categoryId: cat.id } })).id
})

afterAll(async () => {
  // obrnjen FK vrstni red: plačilne povezave → postavke → naročila → mize →
  // revizija/dogodki → zaposleni → lokacija
  await db.payLink.deleteMany({ where: { orderId: { startsWith: `${PREFIX}ord-` } } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { orderId: { startsWith: `${PREFIX}ord-` } } }).catch(() => null)
  await db.order.deleteMany({ where: { id: { startsWith: `${PREFIX}ord-` } } }).catch(() => null)
  await db.table.deleteMany({ where: { locationId: locId || '__x__' } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: PREFIX } }, { payload: { contains: PREFIX } }] } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: `${PREFIX}` } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: locId || '__x__' } }).catch(() => null)
})

describe('Issue #47 — ročni status PAID je ukinjen', () => {
  test('MANAGER PATCH status=PAID → 409 z usmeritvom na plačilno pot; DB popolnoma nespremenjen', async () => {
    const order = await seedOrder(1)
    const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { status: 'PAID' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(409)
    expect(String((await res.json()).error)).toContain('ni več podprt')
    const row = await db.order.findUnique({ where: { id: order.id } })
    expect(row?.status).toBe('open')
    expect(row?.paymentStatus).toBe('unpaid')
    expect(row?.paidAt).toBeNull()
    // Payment je vezan na Check (OPS-7), ne neposredno na Order — preverimo oboje
    expect(await db.check.count({ where: { orderId: order.id } })).toBe(0)
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(0)
  })

  test('WAITER PATCH status=PAID → 403 (RBAC vrata pred zavrnitvijo — pooblastilo se še vedno preverja)', async () => {
    const order = await seedOrder(2)
    const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(waiterId, 'w', 'WAITER', locId), 'PATCH', { status: 'PAID' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(403)
  })

  test('CENTRAL ADMIN PATCH status=PAID → 409 (enako pravilo za vse vloge — override ni break-glass)', async () => {
    const order = await seedOrder(3)
    const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'ADMIN', null), 'PATCH', { status: 'PAID' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(409)
  })
})

describe('Issue #48 — terminalna stanja so res terminalna', () => {
  test('DELETE (preklic) → status cancelled + paymentStatus terminalno cancelled', async () => {
    const order = await seedOrder(10)
    const res = await orderDELETE(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(200)
    const row = await db.order.findUnique({ where: { id: order.id } })
    expect(row?.status).toBe('cancelled')
    expect(row?.paymentStatus).toBe('cancelled')
  })

  test('po DELETE: PATCH addItems → 409, 0 novih postavk, zneski nespremenjeni', async () => {
    const order = await seedOrder(11)
    await orderDELETE(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    const before = await db.order.findUnique({ where: { id: order.id } })
    const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(waiterId, 'w', 'WAITER', locId), 'PATCH', { addItems: [{ menuItemId: miId, qty: 2 }] }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(409)
    expect(String((await res.json()).error)).toContain('zaključeno')
    expect(await db.orderItem.count({ where: { orderId: order.id } })).toBe(0)
    const after = await db.order.findUnique({ where: { id: order.id } })
    // Decimal → primarna primerjava (objektna identiteta bi lažno padla)
    expect(Number(after?.total ?? 0)).toBe(Number(before?.total ?? 0))
  })

  test('preklicano naročilo NE preide v OPEN/SENT/PREPARED prek običajnega PATCH', async () => {
    const order = await seedOrder(12)
    await orderDELETE(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    for (const st of ['OPEN', 'SENT', 'PREPARED']) {
      const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { status: st }), { params: Promise.resolve({ id: order.id }) })
      expect(res.status).toBe(409)
      expect(String((await res.json()).error)).toContain('terminalno')
    }
    const row = await db.order.findUnique({ where: { id: order.id } })
    expect(row?.status).toBe('cancelled')
  })

  test('plačano naročilo (status paid) → PATCH SENT in CANCELLED → 409 terminal', async () => {
    const order = await seedOrder(13, 'paid', 'paid')
    for (const st of ['SENT', 'CANCELLED', 'OPEN']) {
      const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { status: st }), { params: Promise.resolve({ id: order.id }) })
      expect(res.status).toBe(409)
    }
    const row = await db.order.findUnique({ where: { id: order.id } })
    expect(row?.status).toBe('paid')
    expect(row?.paymentStatus).toBe('paid')
  })

  test('PATCH status CANCELLED iz open+unpaid → 200; paymentStatus cancelled; miza → cleaning; audit', async () => {
    const table = await db.table.create({ data: { id: `${PREFIX}tbl-${RUN}`, number: 4711, locationId: locId } })
    const order = await seedOrder(14, 'open', 'unpaid', table.id)
    const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { status: 'CANCELLED', reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(200)
    const row = await db.order.findUnique({ where: { id: order.id } })
    expect(row?.status).toBe('cancelled')
    expect(row?.paymentStatus).toBe('cancelled')
    expect((await db.table.findUnique({ where: { id: table.id } }))?.status).toBe('cleaning')
    const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_STATUS_CANCELLED_OVERRIDE', entityId: order.id } })
    expect(audit).not.toBeNull()
  })

  test('PATCH status CANCELLED na paymentStatus storno → 409 (fiskalna negacija je terminalna)', async () => {
    const order = await seedOrder(15, 'paid', 'storno')
    const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { status: 'CANCELLED', reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(409)
  })

  test('DELETE na paymentStatus storno → 409 (nova varovalka — prej samo paid)', async () => {
    const order = await seedOrder(16, 'paid', 'storno')
    const res = await orderDELETE(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(409)
    expect(String((await res.json()).error)).toContain('storniranega')
  })

  test('addItems BELA LISTA: open+unpaid → 200 (status samodejno sent); partial → 200', async () => {
    const o1 = await seedOrder(20)
    const r1 = await orderPATCH(req(`/api/orders/${o1.id}`, tokenFor(waiterId, 'w', 'WAITER', locId), 'PATCH', { addItems: [{ menuItemId: miId, qty: 1 }] }), { params: Promise.resolve({ id: o1.id }) })
    expect(r1.status).toBe(200)
    expect(await db.orderItem.count({ where: { orderId: o1.id } })).toBe(1)
    expect((await db.order.findUnique({ where: { id: o1.id } }))?.status).toBe('sent')
    const o2 = await seedOrder(21, 'sent', 'partial')
    const r2 = await orderPATCH(req(`/api/orders/${o2.id}`, tokenFor(waiterId, 'w', 'WAITER', locId), 'PATCH', { addItems: [{ menuItemId: miId, qty: 1 }] }), { params: Promise.resolve({ id: o2.id }) })
    expect(r2.status).toBe(200)
    expect(await db.orderItem.count({ where: { orderId: o2.id } })).toBe(1)
  })

  test('addItems na terminalni paymentStatus (cancelled / storno / paid) → 409', async () => {
    for (const [n, ps] of [[22, 'cancelled'], [23, 'storno'], [24, 'paid']] as const) {
      const order = await seedOrder(n, 'sent', ps)
      const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(waiterId, 'w', 'WAITER', locId), 'PATCH', { addItems: [{ menuItemId: miId, qty: 1 }] }), { params: Promise.resolve({ id: order.id }) })
      expect(res.status).toBe(409)
      expect(await db.orderItem.count({ where: { orderId: order.id } })).toBe(0)
    }
  })

  test('preklic prek PATCH CANCELLED prekliče ODPRE plačilne povezave (superseded)', async () => {
    const order = await seedOrder(30)
    const l1 = await seedLink(1, order.id, 1, 2)
    const l2 = await seedLink(2, order.id, 2, 2)
    const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { status: 'CANCELLED', reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(200)
    expect((await db.payLink.findUnique({ where: { id: l1.id } }))?.status).toBe('superseded')
    expect((await db.payLink.findUnique({ where: { id: l2.id } }))?.status).toBe('superseded')
  })

  test('preklic prek DELETE prav tako prekliče odprte plačilne povezave', async () => {
    const order = await seedOrder(31)
    const l1 = await seedLink(3, order.id, 1, 3)
    const res = await orderDELETE(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(200)
    expect((await db.payLink.findUnique({ where: { id: l1.id } }))?.status).toBe('superseded')
  })

  test('PATCH note na preklicanem naročilu → 200 (vsebina naročila, ne stanje — issue #48 opomba)', async () => {
    const order = await seedOrder(32)
    await orderDELETE(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    const res = await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(waiterId, 'w', 'WAITER', locId), 'PATCH', { note: 'gost je odšel pred plačilom' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(200)
    expect((await db.order.findUnique({ where: { id: order.id } }))?.notes).toBe('gost je odšel pred plačilom')
  })
})
