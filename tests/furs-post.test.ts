/**
 * Test 32-c — P1 točka 4 (audit §12): transakcijska logika POST /api/furs
 * (plačilo + fiskalni dokument + razknjiževanje zalog + revizija v ENI transakciji).
 *
 * Pokritje:
 *  - veselja pot: unpaid naročilo → račun z ZOI (MD5, 32 hex) / EOR (UUID) v simulaciji,
 *    naročilo → paid, SALE StockTransactions po recepturah, AuditLog INVOICE_ISSUE,
 *    številka računa po sekvenci lokacije (`leto-mesec-sek-PREMISES`);
 *  - DVOJNI PLAČILNI POSKUS: isti idempotenčni ključ (clientOperationId → Payment.idempotencyKey
 *    `key#p0`) → replay vrne ISTI račun (200, replayed), brez duplikatov računov/plačil/odjema;
 *  - SOČASNI dvojni klic (Promise.all): CAS (order.paymentStatus != paid) + SQLite serializacija
 *    → točno EN račun, točno EN prehod v paid;
 *  - CAS replay BREZ idempotenčnega ključa (že plačano → najden "twin" račun → replayed);
 *  - dovoljenja (orders.pay manjka → 403), tuja lokacija (assertResourceLocation → 403),
 *    neplačljivo stanje (409), manjkajoče/neobstoječe naročilo (400/404);
 *  - deljeno plačilo (parts: cash + card z odobritvijo terminala → mixed, 2 Payment vrstici),
 *    zavrnjena vsota delov (400) in kartica brez approvalCode (402).
 *
 * Fixture predpona: furspost- (lokacije, zaposleni, artikli, naročila); čiščenje po reverse-FK
 * v afterAll (plus pred-čiščenje v beforeAll za odpornost na trčen prejšnjega poganjanja).
 * Opomba: FURS simulacija je nastavljena prek FURS_ENVIRONMENT=simulation + location.fursEnvironment
 * (route: process.env.FURS_ENVIRONMENT || location.fursEnvironment || 'simulation').
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid, num } from '@/lib/map'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { POST as stornoPOST } from '../src/app/api/receipts/[id]/storno/route'
import { PATCH as ordersPATCH } from '../src/app/api/orders/[id]/route'

const PREFIX = 'furspost'
const PREMISES_A = 'BLGFPOSTA'
const PREMISES_B = 'BLGFPOSTB'
const TS = Date.now()

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const ZOI_RE = /^[0-9a-f]{32}$/

// ── fiksture (napolnjene v beforeAll) ──
let locA: { id: string }
let locB: { id: string }
let mgrA: { id: string; name: string }
let mgrB: { id: string; name: string }
let chefA: { id: string; name: string }
let mi22: { id: string; name: string }
let mi95: { id: string; name: string }
let invAId: string
let invBId: string
let menuAId: string
let catAId: string
let orderSeq = 870001

const PREV_FURS_ENV = process.env.FURS_ENVIRONMENT

let tokenA = ''
let tokenB = ''
let tokenChef = ''

interface ItemSpec {
  menuItemId: string
  name: string
  quantity: number
  unitPrice: number
  vatRate: number
}

/** VAT po postavki v centih (konsistentno z OrderItem.vatAmount, ki ga route kar vzame) */
const vatOf = (base: number, rate: number) => Math.round((base * rate + Number.EPSILON)) / 100

async function createOrder(specs: ItemSpec[], status = 'open') {
  const orderId = nid()
  const subtotal = specs.reduce((s, it) => s + it.unitPrice * it.quantity, 0)
  const tax = specs.reduce((s, it) => s + vatOf(it.unitPrice * it.quantity, it.vatRate), 0)
  const order = await db.order.create({
    data: {
      id: orderId,
      orderNumber: orderSeq++,
      locationId: locA.id,
      status,
      paymentStatus: 'unpaid',
      type: 'dine-in',
      subtotal,
      tax,
      total: subtotal + tax,
      employeeId: mgrA.id,
    },
  })
  for (const it of specs) {
    await db.orderItem.create({
      data: {
        id: nid(),
        orderId,
        menuItemId: it.menuItemId,
        quantity: it.quantity,
        price: it.unitPrice,
        vatRate: it.vatRate,
        vatAmount: vatOf(it.unitPrice * it.quantity, it.vatRate),
        menuItemName: it.name,
        status: 'served',
      },
    })
  }
  return order
}

function fursReq(token: string, body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/furs', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const payA = (body: Record<string, unknown>) => fursPOST(fursReq(tokenA, body))

/** Reverse-FK čiščenje vseh fiks tur te datoteke (idempotentno — uporabljeno v beforeAll IN afterAll) */
async function cleanupFixtures() {
  const locs = await db.location.findMany({
    where: { OR: [{ premisesId: PREMISES_A }, { premisesId: PREMISES_B }, { code: { startsWith: `${PREFIX}-` } }] },
    select: { id: true },
  })
  for (const { id: locId } of locs) {
    const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
    const orderIds = orders.map((o) => o.id)
    for (const orderId of orderIds) {
      const stx = await db.stockTransaction.findMany({ where: { orderId }, select: { id: true } })
      await db.stockBatchAllocation.deleteMany({ where: { stockTransactionId: { in: stx.map((t) => t.id) } } })
      await db.stockTransaction.deleteMany({ where: { orderId } })
      const receipts = await db.receipt.findMany({ where: { orderId }, select: { id: true } })
      const receiptIds = receipts.map((r) => r.id)
      await db.auditLog.deleteMany({
        where: { OR: [{ entityType: 'Receipt', entityId: { in: receiptIds } }, { entityType: 'Order', entityId: orderId }] },
      })
      await db.eventLog.deleteMany({ where: { entityId: { in: receiptIds } } })
      const checks = await db.check.findMany({ where: { orderId }, select: { id: true } })
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } })
      await db.check.deleteMany({ where: { orderId } })
      await db.receipt.deleteMany({ where: { orderId } })
      await db.orderItem.deleteMany({ where: { orderId } })
      await db.order.deleteMany({ where: { id: orderId } })
    }
    const invs = await db.inventoryItem.findMany({ where: { locationId: locId }, select: { id: true } })
    const invIds = invs.map((i) => i.id)
    await db.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: invIds } } })
    await db.recipeItem.deleteMany({ where: { inventoryItemId: { in: invIds } } })
    await db.inventoryItem.deleteMany({ where: { id: { in: invIds } } })
    const menus = await db.menu.findMany({ where: { locationId: locId }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } })
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } })
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } })
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } })
    await db.employee.deleteMany({ where: { locationId: locId } })
    await db.counter.deleteMany({ where: { name: `receipt:${locId}` } })
    await db.location.deleteMany({ where: { id: locId } })
  }
}

beforeAll(async () => {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  process.env.FURS_ENVIRONMENT = 'simulation'
  await cleanupFixtures()

  locA = await db.location.create({
    data: {
      id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: PREMISES_A,
      taxId: 'SI12345678', registerNumber: 'BLG-001A', fursEnvironment: 'simulation', country: 'SI',
    },
  })
  locB = await db.location.create({
    data: {
      id: nid(), name: `${PREFIX} Lokacija B`, code: `${PREFIX}-B-${TS}`, premisesId: PREMISES_B,
      taxId: 'SI87654321', registerNumber: 'BLG-001B', fursEnvironment: 'simulation', country: 'SI',
    },
  })
  mgrA = await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Manager A`, email: `${PREFIX}-mgr-a-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-a-${TS}`, locationId: locA.id },
  })
  mgrB = await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Manager B`, email: `${PREFIX}-mgr-b-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-b-${TS}`, locationId: locB.id },
  })
  chefA = await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Kuhar A`, email: `${PREFIX}-chef-${TS}@test.local`, role: 'chef', pin: `${PREFIX}-pin-c-${TS}`, locationId: locA.id },
  })
  tokenA = createToken({ sub: mgrA.id, name: mgrA.name, role: 'MANAGER', loc: locA.id, sv: 0 })
  tokenB = createToken({ sub: mgrB.id, name: mgrB.name, role: 'MANAGER', loc: locB.id, sv: 0 })
  tokenChef = createToken({ sub: chefA.id, name: chefA.name, role: 'KITCHEN', loc: locA.id, sv: 0 })

  menuAId = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA.id } })).id
  catAId = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuAId } })).id
  mi22 = await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} artikel 22%`, price: 10, categoryId: catAId, vatRate: 22 } })
  mi95 = await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} artikel 9.5%`, price: 20, categoryId: catAId, vatRate: 9.5 } })
  invAId = (await db.inventoryItem.create({
    data: { id: nid(), name: `${PREFIX} sestavina A`, unit: 'l', quantity: 100, costPerUnit: 1, locationId: locA.id },
  })).id
  invBId = (await db.inventoryItem.create({
    data: { id: nid(), name: `${PREFIX} sestavina B`, unit: 'kg', quantity: 50, costPerUnit: 0.5, locationId: locA.id },
  })).id
  await db.recipeItem.create({ data: { id: nid(), menuItemId: mi22.id, inventoryItemId: invAId, quantityPerServing: 2, unit: 'l' } })
  await db.recipeItem.create({ data: { id: nid(), menuItemId: mi95.id, inventoryItemId: invBId, quantityPerServing: 1, unit: 'kg' } })
})

afterAll(async () => {
  if (PREV_FURS_ENV === undefined) delete process.env.FURS_ENVIRONMENT
  else process.env.FURS_ENVIRONMENT = PREV_FURS_ENV
  await cleanupFixtures()
})

describe('POST /api/furs — veselja pot (plačilo + račun + zaloga + revizija v eni transakciji)', () => {
  test('unpaid naročilo → 201: račun z ZOI/EOR (simulacija), naročilo paid, zaloge odštete, revizija INVOICE_ISSUE', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 2, unitPrice: 10, vatRate: 22 },
      { menuItemId: mi95.id, name: mi95.name, quantity: 1, unitPrice: 20, vatRate: 9.5 },
    ])
    const seqBefore = await db.receipt.count({ where: { locationId: locA.id } })
    const res = await payA({ orderId: order.id, type: 'cash', clientOperationId: `${PREFIX}-happy-${TS}` })
    expect(res.status).toBe(201)
    const body = await res.json()

    // račun: EOR = UUID, ZOI = 32 hex MD5, fiskalni status simulacije = verified
    expect(body.invoice.id).toBeDefined()
    expect(body.invoice.eor).toMatch(UUID_RE)
    expect(body.invoice.zoi).toMatch(ZOI_RE)
    expect(body.invoice.fiscalStatus).toBe('verified')
    expect(body.invoice.fiscalVerified).toBe(true)
    expect(body.fursEnvironment).toBe('simulation')
    expect(body.invoice.total).toBe(46.3)
    expect(body.invoice.paymentMethod).toBe('cash')

    // številka računa: `leto-mesec-sek-PREMISES` (sek = count ob izdaji + 1)
    const now = new Date()
    const expectedNum = `${now.getFullYear()}-${now.getMonth() + 1}-${seqBefore + 1}-${PREMISES_A}`
    expect(body.invoice.invoiceNumber).toBe(expectedNum)

    // naročilo → paid (status + paymentStatus + paidAt + paymentMethod)
    const paid = await db.order.findUnique({ where: { id: order.id } })
    expect(paid?.status).toBe('paid')
    expect(paid?.paymentStatus).toBe('paid')
    expect(paid?.paidAt).not.toBeNull()
    expect(paid?.paymentMethod).toBe('cash')
    expect(body.order.status).toBe('PAID')

    // zaloge: SALE po recepturah (mi22×2 → 2×2=4 od sestavine A; mi95×1 → 1 od sestavine B)
    const stx = await db.stockTransaction.findMany({ where: { orderId: order.id, type: 'SALE' } })
    expect(stx).toHaveLength(2)
    const byItem = new Map(stx.map((t) => [t.inventoryItemId, t]))
    expect(num(byItem.get(invAId)?.quantity)).toBe(-4)
    expect(num(byItem.get(invBId)?.quantity)).toBe(-1)
    expect(byItem.get(invAId)?.orderId).toBe(order.id)
    const invAAfter = await db.inventoryItem.findUnique({ where: { id: invAId } })
    expect(num(invAAfter?.quantity)).toBe(96)

    // revizija: INVOICE_ISSUE z details (številka računa, simulacija, odjem zalog)
    const audit = await db.auditLog.findFirst({ where: { action: 'INVOICE_ISSUE', entityType: 'Receipt', entityId: body.invoice.id } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(String(audit?.details))
    expect(details.receiptNumber).toBe(expectedNum)
    expect(details.simulation).toBe(true)
    expect(details.stockDeduction.lines).toBe(2)

    // Payment vrstica z idempotenčnim ključem `key#p0`
    const payment = await db.payment.findFirst({ where: { idempotencyKey: `${PREFIX}-happy-${TS}#p0` } })
    expect(payment).not.toBeNull()
    expect(num(payment?.amount)).toBe(46.3)
    expect(payment?.type).toBe('cash')
    expect(payment?.employeeId).toBe(mgrA.id)

    // razčlenba DDV na računu (ključi toFixed(2), kot jih piše route)
    const receiptRow = await db.receipt.findFirst({ where: { orderId: order.id } })
    const vb = JSON.parse(String(receiptRow?.vatBreakdown))
    expect(vb['22.00']).toEqual({ base: 20, vat: 4.4 })
    expect(vb['9.50']).toEqual({ base: 20, vat: 1.9 })
    expect(num(receiptRow?.totalVat)).toBe(6.3)
    expect(num(receiptRow?.subtotal)).toBe(40)
  })

  test('številčenje po sekvenci lokacije: naslednji račun dobi sek+1', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const seqBefore = await db.receipt.count({ where: { locationId: locA.id } })
    const res = await payA({ orderId: order.id, type: 'cash' })
    expect(res.status).toBe(201)
    const body = await res.json()
    const now = new Date()
    expect(body.invoice.invoiceNumber).toBe(`${now.getFullYear()}-${now.getMonth() + 1}-${seqBefore + 1}-${PREMISES_A}`)
  })
})

describe('POST /api/furs — dvojni plačilni poskus (idempotenca)', () => {
  test('isti clientOperationId dvakrat → drugi klic vrne ISTI račun (replayed), brez duplikatov', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const key = `${PREFIX}-replay-${TS}`
    const invBefore = await db.inventoryItem.findUnique({ where: { id: invAId } })
    const qtyBefore = num(invBefore?.quantity)
    const res1 = await payA({ orderId: order.id, type: 'cash', clientOperationId: key })
    expect(res1.status).toBe(201)
    const body1 = await res1.json()

    const res2 = await payA({ orderId: order.id, type: 'cash', clientOperationId: key })
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.replayed).toBe(true)
    expect(body2.invoice.id).toBe(body1.invoice.id)
    expect(body2.invoice.invoiceNumber).toBe(body1.invoice.invoiceNumber)
    expect(body2.order.status).toBe('PAID')

    // NI duplikatov: 1 račun, 1 plačilo, 1 Check, odjem zalog samo 1×
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(1)
    const checks = await db.check.findMany({ where: { orderId: order.id } })
    expect(checks).toHaveLength(1)
    expect(await db.payment.count({ where: { checkId: checks[0].id } })).toBe(1)
    expect(await db.stockTransaction.count({ where: { orderId: order.id, type: 'SALE' } })).toBe(1)
    const invAfter = await db.inventoryItem.findUnique({ where: { id: invAId } })
    expect(num(invAfter?.quantity)).toBe(qtyBefore - 2) // 1× artikel × 2/serving — samo EN odjem (brez duplikata)
  })

  test('sočasni dvojni klic (Promise.all) → točno EN račun, EN prehod v paid (CAS + SQLite serializacija)', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const key = `${PREFIX}-conc-${TS}`
    const [ra, rb] = await Promise.allSettled([
      payA({ orderId: order.id, type: 'cash', clientOperationId: key }),
      payA({ orderId: order.id, type: 'cash', clientOperationId: key }),
    ])
    expect(ra.status).toBe('fulfilled')
    expect(rb.status).toBe('fulfilled')
    const resA = (ra as PromiseFulfilledResult<Response>).value
    const resB = (rb as PromiseFulfilledResult<Response>).value
    // niti en klic ne sme 500/409: zmagovalca 201, izgubljenec 200 replay (CAS vrne twin / P2002 replay)
    for (const r of [resA, resB]) expect([200, 201]).toContain(r.status)
    const bodyA = await resA.json()
    const bodyB = await resB.json()
    // oba odgovora se nanašata na ISTI račun
    expect(bodyB.invoice.id).toBe(bodyA.invoice.id)
    const createdStatuses = [resA.status, resB.status]
    expect(createdStatuses).toContain(201)
    for (const [i, s] of createdStatuses.entries()) {
      if (s === 200) expect([bodyA, bodyB][i].replayed).toBe(true)
    }
    // invarianta: točno en račun, en prehod v paid
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(1)
    const paid = await db.order.findUnique({ where: { id: order.id } })
    expect(paid?.paymentStatus).toBe('paid')
    expect(paid?.status).toBe('paid')
    const checks = await db.check.findMany({ where: { orderId: order.id } })
    expect(checks).toHaveLength(1)
    expect(await db.payment.count({ where: { checkId: checks[0].id } })).toBe(1)
    expect(await db.stockTransaction.count({ where: { orderId: order.id, type: 'SALE' } })).toBe(1)
  })

  test('CAS replay BREZ idempotenčnega ključa: ponovni klic na plačano naročilo → twin račun (replayed)', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const res1 = await payA({ orderId: order.id, type: 'cash' })
    expect(res1.status).toBe(201)
    const body1 = await res1.json()

    // drugi klic brez clientOperationId: CAS (paymentStatus != paid) izgubi dirko → najden twin
    const res2 = await payA({ orderId: order.id, type: 'cash' })
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.replayed).toBe(true)
    expect(body2.invoice.id).toBe(body1.invoice.id)
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(1)
  })
})

describe('POST /api/furs — dovoljenja, lokacija in stanje naročila', () => {
  test('kuhar (brez orders.pay) → 403 z jasnim sporočilom; naročilo ostane neplačano', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const res = await fursPOST(fursReq(tokenChef, { orderId: order.id, type: 'cash' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(String(body.error)).toContain('orders.pay')
    const after = await db.order.findUnique({ where: { id: order.id } })
    expect(after?.paymentStatus).toBe('unpaid')
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(0)
  })

  test('manager lokacije B poskuša plačati naročilo lokacije A → 403 (assertResourceLocation)', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const res = await fursPOST(fursReq(tokenB, { orderId: order.id, type: 'cash' }))
    expect(res.status).toBe(403)
    const after = await db.order.findUnique({ where: { id: order.id } })
    expect(after?.paymentStatus).toBe('unpaid')
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(0)
  })

  test('naročilo v neplačljivem stanju (cancelled) → 409', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ], 'cancelled')
    const res = await payA({ orderId: order.id, type: 'cash' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(String(body.error)).toContain('plačljivem stanju')
  })

  test('neobstoječe naročilo → 404; manjkajoč orderId → 400', async () => {
    const res404 = await payA({ orderId: 'ne-obstaja-000', type: 'cash' })
    expect(res404.status).toBe(404)
    const res400 = await payA({ type: 'cash' })
    expect(res400.status).toBe(400)
    expect(String((await res400.json()).error)).toContain('orderId')
  })
})

describe('POST /api/furs — deljeno plačilo (parts)', () => {
  test('cash 26.30 + card 20.00 (z odobritvijo) → mixed, 2 Payment vrstici s ključema #p0/#p1', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 2, unitPrice: 10, vatRate: 22 },
      { menuItemId: mi95.id, name: mi95.name, quantity: 1, unitPrice: 20, vatRate: 9.5 },
    ])
    // total = 40 + 6.3 = 46.30
    const res = await payA({
      orderId: order.id,
      parts: [
        { type: 'cash', amount: 26.3 },
        { type: 'card', amount: 20, terminal: { approvalCode: `APPR-${TS}` } },
      ],
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.invoice.paymentMethod).toBe('mixed')
    expect(body.invoice.total).toBe(46.3)

    const checks = await db.check.findMany({ where: { orderId: order.id } })
    expect(checks).toHaveLength(1)
    const payments = await db.payment.findMany({ where: { checkId: checks[0].id }, orderBy: { createdAt: 'asc' } })
    expect(payments).toHaveLength(2)
    const cashPart = payments.find((p) => p.type === 'cash')
    const cardPart = payments.find((p) => p.type === 'card')
    expect(num(cashPart?.amount)).toBe(26.3)
    expect(num(cardPart?.amount)).toBe(20)
    expect(cardPart?.authorizationCode).toBe(`APPR-${TS}`)
    // vsota delov = za plačanje (preprečitev preplačila)
    expect(payments.reduce((s, p) => s + num(p.amount), 0)).toBe(46.3)
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(1)
  })

  test('artikel z AKTIVNO serijo → celotna transakcija pade (P2003) → 500, stanje se čisto odmeta', async () => {
    // ⚠️ REALNI BUG (najden s tests/stock-deduction.test.ts, 32-c): deductStockForOrderTx
    // vstavi StockBatchAllocation (inventory.ts:124) PRED StockTransaction (inventory.ts:137)
    // → FK kršitev P2003 takoj, ko prodani artikel ima ACTIVE InventoryBatch.
    // Ta e2e dokaz pokaže vpliv: plačilo NEDELOUJE (500) za tako naročilo.
    // Omogočite po popravku (ustvari StockTransaction pred zanko po serijah).
    const inv = await db.inventoryItem.create({
      data: { id: nid(), name: `${PREFIX} sestavina s serijo`, unit: 'l', quantity: 50, costPerUnit: 1, locationId: locA.id },
    })
    await db.inventoryBatch.create({
      data: {
        id: nid(), inventoryItemId: inv.id, locationId: locA.id, lotNumber: `${PREFIX}-lot-${TS}`,
        quantityInitial: 20, quantityRemaining: 20, status: 'ACTIVE', expiryDate: new Date(Date.now() + 7 * 86_400_000),
      },
    })
    const mi = await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} artikel s serijo`, price: 5, categoryId: catAId, vatRate: 22 } })
    await db.recipeItem.create({ data: { id: nid(), menuItemId: mi.id, inventoryItemId: inv.id, quantityPerServing: 1, unit: 'l' } })
    const order = await createOrder([{ menuItemId: mi.id, name: mi.name, quantity: 1, unitPrice: 5, vatRate: 22 }])

    const res = await payA({ orderId: order.id, type: 'cash', clientOperationId: `${PREFIX}-bug-${TS}` })
    // pričakovano po popravku: 201; pred popravkom: P2003 → 500 (route catch-all)
    expect(res.status).toBe(201)
    const body = await res.json()
    // alokacije vezane na obstoječi StockTransaction
    const stx = await db.stockTransaction.findFirst({ where: { orderId: order.id, type: 'SALE' } })
    expect(stx).not.toBeNull()
    const allocs = await db.stockBatchAllocation.findMany({ where: { stockTransactionId: stx!.id } })
    expect(allocs).toHaveLength(1)
    expect(body.invoice.total).toBe(6.1)
  })

  test('vsota delov ≠ znesek za plačanje → 400 in BREZ računa/plačila', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 2, unitPrice: 10, vatRate: 22 },
      { menuItemId: mi95.id, name: mi95.name, quantity: 1, unitPrice: 20, vatRate: 9.5 },
    ])
    const res = await payA({
      orderId: order.id,
      parts: [{ type: 'cash', amount: 10 }],
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(String(body.error)).toContain('Vsota delov plačila')
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(0)
    expect(await db.check.count({ where: { orderId: order.id } })).toBe(0)
    const after = await db.order.findUnique({ where: { id: order.id } })
    expect(after?.paymentStatus).toBe('unpaid')
  })

  test('kartični del BREZ odobritve terminala → 402', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const res = await payA({
      orderId: order.id,
      parts: [{ type: 'card', amount: 12.2 }],
    })
    expect(res.status).toBe(402)
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(0)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Naloga 37 (audit priporočilo Task 31-a) — terminalna stanja so KONČNA:
 *  - storno naročila → ponovno plačilo prek /api/furs je ZAVRJENO (409) — prej:
 *    CAS '!= paid' je spustil 'storno' → NOV fiskalni račun nad že negirano prodajo
 *    (deductStock replay zaščita sicer zadrži dvojno razknjižbo, a račun bi bil izdan);
 *  - 'cancelled' paymentStatus → prav tako zavrnjeno (bela lista CAS);
 *  - ročni PAID override (/api/orders/[id]) na stornoed naročilu → 409 (prej: override
 *    je prepisal 'storno' → 'paid' brez računa/plačila — računovodsko nekonsistentno);
 *  - "twin" replay (izguba CAS dirke) išče IZKLJUČNO originalni račun (isStorno=false).
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('POST /api/furs — terminalna stanja: storno/cancelled so KONČNA (Naloga 37)', () => {
  test('stornirano naročilo → ponovno plačilo 409, BREZ novega računa/plačila', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    // 1. plačilo (originalni račun)
    const res1 = await payA({ orderId: order.id, type: 'cash', clientOperationId: `${PREFIX}-storno37-${TS}` })
    expect(res1.status).toBe(201)
    const inv1 = (await res1.json()).invoice
    // 2. fiskalni storno (koti /api/furs: isti furs.issue dovoljenje, lokacija A)
    const stornoToken = createToken({ sub: mgrA.id, name: mgrA.name, role: 'MANAGER', loc: locA.id, sv: 0 })
    const resS = await stornoPOST(
      new NextRequest('http://localhost/api/receipts/x/storno', { method: 'POST', headers: { authorization: `Bearer ${stornoToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'testni storno razlog' }) }),
      { params: Promise.resolve({ id: inv1.id }) },
    )
    expect(resS.status).toBe(201)
    expect((await resS.json()).order.paymentStatus).toBe('storno')
    // 3. ponovni plačilni poskus → ZAVRJEN (terminalno stanje)
    const res2 = await payA({ orderId: order.id, type: 'cash', clientOperationId: `${PREFIX}-storno37-retry-${TS}` })
    expect(res2.status).toBe(409)
    expect(String((await res2.json()).error)).toContain('stornirano')
    // invarianta: točno 2 računa (original + storno negacija), brez tretjega; brez novega Check/Payment
    const receipts = await db.receipt.findMany({ where: { orderId: order.id }, select: { id: true, isStorno: true } })
    expect(receipts).toHaveLength(2)
    expect(receipts.filter((r) => r.isStorno)).toHaveLength(1)
    expect(await db.check.count({ where: { orderId: order.id } })).toBe(1)
    const dbOrder = await db.order.findUnique({ where: { id: order.id } })
    expect(dbOrder?.paymentStatus).toBe('storno')
  })

  test('paymentStatus=cancelled → 409 (preklicano)', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    await db.order.update({ where: { id: order.id }, data: { paymentStatus: 'cancelled' } })
    const res = await payA({ orderId: order.id, type: 'cash' })
    expect(res.status).toBe(409)
    expect(String((await res.json()).error)).toContain('preklicano')
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(0)
  })

  test('ročni PAID override na stornoed naročilu → 409 (paymentStatus ostane storno)', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const res1 = await payA({ orderId: order.id, type: 'cash', clientOperationId: `${PREFIX}-ovr37-${TS}` })
    expect(res1.status).toBe(201)
    const inv1 = (await res1.json()).invoice
    const stornoToken = createToken({ sub: mgrA.id, name: mgrA.name, role: 'MANAGER', loc: locA.id, sv: 0 })
    const resS = await stornoPOST(
      new NextRequest('http://localhost/api/receipts/x/storno', { method: 'POST', headers: { authorization: `Bearer ${stornoToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'testni storno razlog' }) }),
      { params: Promise.resolve({ id: inv1.id }) },
    )
    expect(resS.status).toBe(201)
    // override poskus → 409 (issue #47: ročni PAID UKINJEN — zavrnjen šele pred
    // izvedbo, sporočilo usmerja na plačilno pot; paymentStatus ostane 'storno')
    const resO = await ordersPATCH(
      new NextRequest(`http://localhost/api/orders/${order.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'PAID' }) }),
      { params: Promise.resolve({ id: order.id }) },
    )
    expect(resO.status).toBe(409)
    expect(String((await resO.json()).error)).toContain('ni več podprt')
    const dbOrder = await db.order.findUnique({ where: { id: order.id } })
    expect(dbOrder?.paymentStatus).toBe('storno')
    expect(dbOrder?.status).toBe('paid') // status nespremenjen — override zavrnjen v celoti
  })

  test('"twin" replay išče samo originalni račun (isStorno=false), ne storno negacije', async () => {
    const order = await createOrder([
      { menuItemId: mi22.id, name: mi22.name, quantity: 1, unitPrice: 10, vatRate: 22 },
    ])
    const res1 = await payA({ orderId: order.id, type: 'cash', clientOperationId: `${PREFIX}-twin37-${TS}` })
    expect(res1.status).toBe(201)
    const original = (await res1.json()).invoice
    // simuliraj storno račun BREZ spreminjanja order.paymentStatus (tj. okno dirke
    // med storno transakcijo in plačilnim klicem — order je še 'paid', storno račun obstaja)
    await db.receipt.create({
      data: {
        id: nid(), receiptNumber: `2026-1-999999-T37`, orderId: order.id, locationId: locA.id,
        isStorno: true, stornoOf: original.id, businessName: 'T37', businessAddress: 'T37',
        businessId: 'T37', taxId: 'SI12345678', subtotal: -12.2, totalVat: -2.2, discount: 0,
        total: -12.2, vatBreakdown: JSON.stringify({ '22.00': { base: -10, vat: -2.2 } }),
        paymentMethod: 'cash', fiscalStatus: 'verified', fiscalVerified: true,
      },
    })
    // drugi klic brez ključa → CAS izgubi dirko (paymentStatus='paid') → twin lookup:
    // mora vrniti ORIGINALNI račun, ne storno negacije
    const res2 = await payA({ orderId: order.id, type: 'cash' })
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.replayed).toBe(true)
    expect(body2.invoice.id).toBe(original.id)
  })
})
