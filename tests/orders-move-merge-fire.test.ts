import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as movePOST } from '../src/app/api/orders/[id]/move/route'
import { POST as mergePOST } from '../src/app/api/orders/[id]/merge/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'

/**
 * P2 audit §54/§57 — selitev miz (move), združevanje naročil (merge), fire na kuhinjo.
 * DB-backed testi proti dev SQLite (db/custom.db). Vse vrstice s predpono `33a-`
 * (id-ji/e-pošte/PIN-i/kode lokacij), cleanup v afterAll v obratni smeri FK.
 * API rute se kličejo direktno (route handlerji z NextRequest) — brez HTTP strežnika.
 */

const PREFIX = '33a-'
const RUN = Date.now().toString(36)

const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locA = ''
let locB = ''
let waiterId = ''

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

async function seedEmployee(name: string, role: string, pin: string, loc: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}emp-${name}-${RUN}`,
      name: `${PREFIX}${name}`,
      email: `${PREFIX}${name}-${RUN}@test.local`,
      role,
      status: 'active',
      sessionVersion: 0,
      locationId: loc,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
}

interface SeedOrderOpts {
  loc?: string
  tableId?: string | null
  status?: string
  paymentStatus?: string
}
let ordSeq = 33900
async function seedOrder(suffix: string, opts: SeedOrderOpts = {}) {
  const locationId = opts.loc ?? locA
  return db.order.create({
    data: {
      id: `${PREFIX}ord-${suffix}-${RUN}`,
      orderNumber: ++ordSeq,
      locationId,
      tableId: opts.tableId ?? null,
      status: opts.status ?? 'open',
      paymentStatus: opts.paymentStatus ?? 'unpaid',
      subtotal: 0, tax: 0, total: 0,
    },
  })
}

interface SeedItemOpts {
  status?: string
  voided?: boolean
  price?: number
  qty?: number
  vatAmount?: number
  checkId?: string
  firedAt?: Date
}
async function seedItem(orderId: string, suffix: string, opts: SeedItemOpts = {}) {
  return db.orderItem.create({
    data: {
      id: `${PREFIX}itm-${suffix}-${RUN}`,
      orderId,
      menuItemId: miA(),
      quantity: opts.qty ?? 1,
      price: opts.price ?? 5,
      vatRate: 22,
      vatAmount: opts.vatAmount ?? 0,
      menuItemName: `${PREFIX}Jed`,
      status: opts.status ?? 'pending',
      voided: opts.voided ?? false,
      ...(opts.checkId ? { checkId: opts.checkId } : {}),
      ...(opts.firedAt ? { firedAt: opts.firedAt } : {}),
    },
  })
}

let menuItemId = ''
const miA = () => menuItemId

afterAll(async () => {
  // obratna smer FK: dogodki/revizija → postavke/računi → naročila → mize → meni → zaposleni → lokacije
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: PREFIX } }, { payload: { contains: PREFIX } }] } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { orderId: { startsWith: `${PREFIX}ord-` } } }).catch(() => null)
  await db.check.deleteMany({ where: { orderId: { startsWith: `${PREFIX}ord-` } } }).catch(() => null)
  await db.order.deleteMany({ where: { id: { startsWith: `${PREFIX}ord-` } } }).catch(() => null)
  await db.table.deleteMany({ where: { id: { startsWith: `${PREFIX}tbl-` } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { startsWith: `${PREFIX}mi-` } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: `${PREFIX}cat-` } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: `${PREFIX}menu-` } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { OR: [{ id: locA || '__x__' }, { id: locB || '__x__' }] } }).catch(() => null)
})

async function setup() {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  const a = await db.location.create({
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `33AA-${RUN.toUpperCase()}`, premisesId: `33a-prem-a-${RUN}` },
  })
  const b = await db.location.create({
    data: { id: `${PREFIX}loc-b-${RUN}`, name: `${PREFIX}Lokacija B`, code: `33AB-${RUN.toUpperCase()}`, premisesId: `33a-prem-b-${RUN}` },
  })
  locA = a.id
  locB = b.id
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locA } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  const mi = await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Jed`, price: 10, categoryId: cat.id } })
  menuItemId = mi.id
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(1), locA)
  const kitchen = await seedEmployee('kitchen', 'kitchen', pinOf(2), locA)
  waiterId = waiter.id
  return {
    waiter: tokenFor(waiter.id, waiter.name, 'WAITER', locA),
    kitchen: tokenFor(kitchen.id, kitchen.name, 'KITCHEN', locA),
  }
}

const setupP = setup()

async function seedTable(suffix: string, number: number, loc: string, status = 'available') {
  return db.table.create({ data: { id: `${PREFIX}tbl-${suffix}-${RUN}`, number, locationId: loc, status } })
}

// ─────────────────────────── Permissions ───────────────────────────

describe('33-a permissions: move/merge/fire zahtevajo orders.create', () => {
  test('KITCHEN (brez orders.create) → fire 403', async () => {
    const t = await setupP
    const o = await seedOrder('perm-fire')
    const res = await firePOST(req(`/api/orders/${o.id}/fire`, t.kitchen, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(403)
  })

  test('KITCHEN → move 403', async () => {
    const t = await setupP
    const o = await seedOrder('perm-move')
    const res = await movePOST(req(`/api/orders/${o.id}/move`, t.kitchen, 'POST', { tableId: 'x' }), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(403)
  })

  test('KITCHEN → merge 403', async () => {
    const t = await setupP
    const o = await seedOrder('perm-merge')
    const res = await mergePOST(req(`/api/orders/${o.id}/merge`, t.kitchen, 'POST', { targetOrderId: 'x' }), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(403)
  })

  test('brez žetona → 401', async () => {
    const o = await seedOrder('perm-401')
    const res = await firePOST(req(`/api/orders/${o.id}/fire`, 'neveljaven', 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(401)
  })
})

// ─────────────────────────── Move (§54) ───────────────────────────

describe('33-a POST /api/orders/[id]/move', () => {
  test('srečna pot: tableId spremenjen, stara miza prosta, nova zasedena + revizija', async () => {
    const t = await setupP
    const t1 = await seedTable('mv1a', 3401, locA, 'occupied')
    const t3 = await seedTable('mv1b', 3403, locA, 'available')
    const o = await seedOrder('mv1', { tableId: t1.id })
    const res = await movePOST(req(`/api/orders/${o.id}/move`, t.waiter, 'POST', { tableId: t3.id }), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(200)
    const dbOrder = await db.order.findUnique({ where: { id: o.id } })
    expect(dbOrder?.tableId).toBe(t3.id)
    expect((await db.table.findUnique({ where: { id: t1.id } }))?.status).toBe('available')
    expect((await db.table.findUnique({ where: { id: t3.id } }))?.status).toBe('occupied')
    const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_MOVE', entityId: o.id } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(String(audit?.details ?? '{}'))
    expect(details.fromTableId).toBe(t1.id)
    expect(details.toTableId).toBe(t3.id)
  })

  test('stara miza OSTANE zasedena, če ima še eno odprto naročilo', async () => {
    const t = await setupP
    const t1 = await seedTable('mv2a', 3404, locA, 'occupied')
    const t3 = await seedTable('mv2b', 3405, locA, 'available')
    const o1 = await seedOrder('mv2a', { tableId: t1.id })
    await seedOrder('mv2b', { tableId: t1.id }) // drugo odprto naročilo na stari mizi
    const res = await movePOST(req(`/api/orders/${o1.id}/move`, t.waiter, 'POST', { tableId: t3.id }), { params: Promise.resolve({ id: o1.id }) })
    expect(res.status).toBe(200)
    expect((await db.table.findUnique({ where: { id: t1.id } }))?.status).toBe('occupied')
  })

  test('ciljna miza z drugim odprtim naročilom → 409', async () => {
    const t = await setupP
    const t1 = await seedTable('mv3a', 3406, locA, 'occupied')
    const t2 = await seedTable('mv3b', 3407, locA, 'occupied')
    const o = await seedOrder('mv3a', { tableId: t1.id })
    await seedOrder('mv3b', { tableId: t2.id }) // zasedena ciljna miza
    const res = await movePOST(req(`/api/orders/${o.id}/move`, t.waiter, 'POST', { tableId: t2.id }), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(409)
    expect((await db.order.findUnique({ where: { id: o.id } }))?.tableId).toBe(t1.id)
  })

  test('miza druge lokacije → 400', async () => {
    const t = await setupP
    const t1 = await seedTable('mv4a', 3408, locA, 'occupied')
    const tb = await seedTable('mv4b', 3451, locB, 'available')
    const o = await seedOrder('mv4', { tableId: t1.id })
    const res = await movePOST(req(`/api/orders/${o.id}/move`, t.waiter, 'POST', { tableId: tb.id }), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(400)
  })

  test('isti tableId → 400', async () => {
    const t = await setupP
    const t1 = await seedTable('mv5a', 3409, locA, 'occupied')
    const o = await seedOrder('mv5', { tableId: t1.id })
    const res = await movePOST(req(`/api/orders/${o.id}/move`, t.waiter, 'POST', { tableId: t1.id }), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(400)
  })

  test('neobstoječa miza → 404', async () => {
    const t = await setupP
    const t1 = await seedTable('mv6a', 3410, locA, 'occupied')
    const o = await seedOrder('mv6', { tableId: t1.id })
    const res = await movePOST(req(`/api/orders/${o.id}/move`, t.waiter, 'POST', { tableId: '33a-neobstaja' }), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(404)
  })

  test('plačano naročilo → 409', async () => {
    const t = await setupP
    const t1 = await seedTable('mv7a', 3411, locA, 'occupied')
    const t3 = await seedTable('mv7b', 3412, locA, 'available')
    const o = await seedOrder('mv7', { tableId: t1.id, paymentStatus: 'paid' })
    const res = await movePOST(req(`/api/orders/${o.id}/move`, t.waiter, 'POST', { tableId: t3.id }), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(409)
  })
})

// ─────────────────────────── Merge (§54) ───────────────────────────

describe('33-a POST /api/orders/[id]/merge', () => {
  test('srečna pot: postavke pri cilju, vir preklican, totali preračunani, miza prosta', async () => {
    const t = await setupP
    const t1 = await seedTable('mg1a', 3413, locA, 'occupied')
    const src = await seedOrder('mg1src', { tableId: t1.id })
    const tgt = await seedOrder('mg1tgt')
    // cilj: 1 postavka (10 €, DDV 2.20)
    await seedItem(tgt.id, 'mg1t1', { price: 10, qty: 1, vatAmount: 2.2 })
    await db.order.update({ where: { id: tgt.id }, data: { subtotal: 10, tax: 2.2, total: 12.2 } })
    // vir: pending 2×5 € (DDV 2.20), fired 1×3 € (DDV 0.66), preklicana 99 € (ostane pri viru)
    await seedItem(src.id, 'mg1s1', { price: 5, qty: 2, vatAmount: 2.2, status: 'pending' })
    await seedItem(src.id, 'mg1s2', { price: 3, qty: 1, vatAmount: 0.66, status: 'fired' })
    await seedItem(src.id, 'mg1s3', { price: 99, qty: 1, vatAmount: 0, status: 'cancelled' })

    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, t.waiter, 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.mergedItems).toBe(2)
    expect(j.sourceCancelled).toBe(true)

    const srcRow = await db.order.findUnique({ where: { id: src.id }, include: { OrderItem: true } })
    expect(srcRow?.status).toBe('cancelled')
    expect(String(srcRow?.cancelReason)).toContain(String(await tgtRowNumber(tgt.id)))
    expect(srcRow?.paymentStatus).toBe('unpaid') // zgodovina plačil ostane
    // preklicana postavka ostane pri viru (ne sme vplivati na totalle cilja)
    expect(srcRow?.OrderItem.length).toBe(1)
    expect(srcRow?.OrderItem[0]?.status).toBe('cancelled')

    const tgtRow = await db.order.findUnique({ where: { id: tgt.id }, include: { OrderItem: true } })
    expect(tgtRow?.OrderItem.length).toBe(3)
    expect(Number(tgtRow?.subtotal)).toBeCloseTo(23, 2)  // 10 + 10 + 3
    expect(Number(tgtRow?.tax)).toBeCloseTo(5.06, 2)     // 2.2 + 2.2 + 0.66
    expect(Number(tgtRow?.total)).toBeCloseTo(28.06, 2)

    // miza vira sproščena (vir je edino naročilo na njej)
    expect((await db.table.findUnique({ where: { id: t1.id } }))?.status).toBe('available')

    const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_MERGE', entityId: src.id } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(String(audit?.details ?? '{}'))
    expect(details.sourceOrderId).toBe(src.id)
    expect(details.targetOrderId).toBe(tgt.id)
    expect(details.movedItems).toBe(2)
    const evt = await db.eventLog.findFirst({ where: { type: 'OrderMerged', entityId: tgt.id } })
    expect(evt).not.toBeNull()
  })

  test('čez lokaciji (cilj na drugi lokaciji) → 400', async () => {
    const t = await setupP
    const src = await seedOrder('mg2src', { loc: locA })
    const tgt = await seedOrder('mg2tgt', { loc: locB })
    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, t.waiter, 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    expect(res.status).toBe(400)
  })

  test('združevanje samo s seboj → 400', async () => {
    const t = await setupP
    const src = await seedOrder('mg3')
    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, t.waiter, 'POST', { targetOrderId: src.id }), { params: Promise.resolve({ id: src.id }) })
    expect(res.status).toBe(400)
  })

  test('cilj preklican → 409', async () => {
    const t = await setupP
    const src = await seedOrder('mg4src')
    const tgt = await seedOrder('mg4tgt', { status: 'cancelled' })
    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, t.waiter, 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    expect(res.status).toBe(409)
  })

  test('postavke vira že na računu (checkId) → 409, vir nespremenjen', async () => {
    const t = await setupP
    const src = await seedOrder('mg5src')
    const tgt = await seedOrder('mg5tgt')
    const chk = await db.check.create({ data: { id: `${PREFIX}chk-${RUN}`, checkNumber: 1, orderId: src.id, total: 5 } })
    await seedItem(src.id, 'mg5i1', { price: 5, checkId: chk.id })
    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, t.waiter, 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    expect(res.status).toBe(409)
    expect((await db.order.findUnique({ where: { id: src.id } }))?.status).toBe('open')
    const items = await db.orderItem.findMany({ where: { orderId: src.id } })
    expect(items.length).toBe(1)
    expect(items[0]?.orderId).toBe(src.id)
  })

  test('neobstoječ cilj → 404', async () => {
    const t = await setupP
    const src = await seedOrder('mg6')
    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, t.waiter, 'POST', { targetOrderId: '33a-neobstaja' }), { params: Promise.resolve({ id: src.id }) })
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────── Fire (§57) ───────────────────────────

describe('33-a POST /api/orders/[id]/fire', () => {
  test('srečna pot: order.firedAt + pending postavke → fired z firedAt; že fired in voided nedotaknjeni', async () => {
    const t = await setupP
    const o = await seedOrder('fi1')
    const old = new Date('2020-01-01T10:00:00Z')
    const p1 = await seedItem(o.id, 'fi1a', { price: 5, status: 'pending' })
    const p2 = await seedItem(o.id, 'fi1b', { price: 5, status: 'pending' })
    const pre = await seedItem(o.id, 'fi1c', { price: 3, status: 'fired', firedAt: old })
    const voided = await seedItem(o.id, 'fi1d', { price: 9, status: 'pending', voided: true })

    const res = await firePOST(req(`/api/orders/${o.id}/fire`, t.waiter, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.firedCount).toBe(2)
    expect(j.alreadyFired).toBe(false)

    const oRow = await db.order.findUnique({ where: { id: o.id } })
    expect(oRow?.firedAt).not.toBeNull()
    for (const it of [p1, p2]) {
      const row = await db.orderItem.findUnique({ where: { id: it.id } })
      expect(row?.status).toBe('fired')
      expect(row?.firedAt).not.toBeNull()
      expect(new Date(row!.firedAt!).getTime()).toBe(new Date(oRow!.firedAt!).getTime())
    }
    const preRow = await db.orderItem.findUnique({ where: { id: pre.id } })
    expect(preRow?.status).toBe('fired')
    expect(new Date(preRow!.firedAt!).getTime()).toBe(old.getTime()) // original firedAt ohranjen
    const vRow = await db.orderItem.findUnique({ where: { id: voided.id } })
    expect(vRow?.status).toBe('pending') // voided ni poslan na kuhinjo

    const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_FIRED', entityId: o.id } })
    expect(audit).not.toBeNull()
    expect(JSON.parse(String(audit?.details ?? '{}')).firedItems).toBe(2)
    const evt = await db.eventLog.findFirst({ where: { type: 'OrderFired', entityId: o.id } })
    expect(evt).not.toBeNull()
  })

  test('idempotenten: drugi klic → 200, firedAt nespremenjen, postavke nespremenjene', async () => {
    const t = await setupP
    const o = await seedOrder('fi2')
    const p1 = await seedItem(o.id, 'fi2a', { price: 5, status: 'pending' })
    const r1 = await firePOST(req(`/api/orders/${o.id}/fire`, t.waiter, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(r1.status).toBe(200)
    const first = await db.order.findUnique({ where: { id: o.id } })
    const r2 = await firePOST(req(`/api/orders/${o.id}/fire`, t.waiter, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(r2.status).toBe(200)
    const j2 = await r2.json()
    expect(j2.alreadyFired).toBe(true)
    expect(j2.firedCount).toBe(0)
    const second = await db.order.findUnique({ where: { id: o.id } })
    expect(new Date(second!.firedAt!).getTime()).toBe(new Date(first!.firedAt!).getTime())
    const row = await db.orderItem.findUnique({ where: { id: p1.id } })
    expect(row?.status).toBe('fired')
    const audits = await db.auditLog.count({ where: { action: 'ORDER_FIRED', entityId: o.id } })
    expect(audits).toBe(1)
  })

  test('brez pending postavk → 200 s firedCount 0 (dokumentirana izbira: idempotentna prijaznost)', async () => {
    const t = await setupP
    const o = await seedOrder('fi3')
    await seedItem(o.id, 'fi3a', { price: 5, status: 'fired', firedAt: new Date() })
    const res = await firePOST(req(`/api/orders/${o.id}/fire`, t.waiter, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.firedCount).toBe(0)
    expect((await db.order.findUnique({ where: { id: o.id } }))?.firedAt).not.toBeNull()
  })

  test('plačano naročilo → 409', async () => {
    const t = await setupP
    const o = await seedOrder('fi4', { paymentStatus: 'paid' })
    const res = await firePOST(req(`/api/orders/${o.id}/fire`, t.waiter, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(409)
  })

  test('neobstoječe naročilo → 404', async () => {
    const t = await setupP
    const res = await firePOST(req('/api/orders/33a-neobstaja/fire', t.waiter, 'POST'), { params: Promise.resolve({ id: '33a-neobstaja' }) })
    expect(res.status).toBe(404)
  })

  test('waiter ima orders.create → fire uspešen (permission happy path)', async () => {
    const t = await setupP
    const o = await seedOrder('fi5')
    await seedItem(o.id, 'fi5a', { price: 5, status: 'pending' })
    const res = await firePOST(req(`/api/orders/${o.id}/fire`, t.waiter, 'POST'), { params: Promise.resolve({ id: o.id }) })
    expect(res.status).toBe(200)
    expect((await db.order.findUnique({ where: { id: o.id } }))?.firedAt).not.toBeNull()
    expect(waiterId).toBeTruthy()
  })
})

/** pomožnik: orderNumber cilja (za cancelReason preverbo) */
async function tgtRowNumber(orderId: string): Promise<number> {
  const row = await db.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } })
  return row?.orderNumber ?? -1
}
