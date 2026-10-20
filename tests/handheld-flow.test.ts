/**
 * v1.84.0 — P0-1 iz TRZNA-VRZELI-2026 — HANDHELD TOK: pogodba celotnega poteka
 * (Mize → naroči → DODAJ → fire → račun → plačilo), kakor ga izvaja /handheld UI —
 * skozi KANONIČNE endpointe, z vlogo WAITER (natakar ima orders.create + orders.pay,
 * vendar NE kitchen.update — točno vloga handheld naprave).
 *
 * Pokritje (zaporedje = UI sekvenca strani src/app/handheld/page.tsx):
 *  1. 401 brez žetona (orders POST / fire / bill / furs) — predprijava handhelda;
 *  2. zlata pot WAITER: POST /api/orders (miza → occupied CAS, postavke z opombo,
 *     replay z istim clientOperationId = offline-vrstna pogodba: replayed, isti id,
 *     brez duplikatov) → PATCH addItems (gumb "Dodaj artikle") → POST fire (vse
 *     pending → fired + order.firedAt + revizija ORDER_FIRED) → ponoven fire
 *     (idempotenten: alreadyFired) → GET bill (kanonični znesek 18,50) →
 *     POST /api/furs gotovina + napitnina (naročilo → paid, miza → cleaning
 *     samodejno, EOR iz simulacije);
 *  3. GET bill na plačanem naročilu → 409 (drugi natakar / poznejši poskus);
 *  4. KITCHEN: 403 na fire (manjka orders.create) + 403 na bill (manjka orders.pay)
 *     — kuhinja handhelda ne more izvesti;
 *  5. WAITER tuje lokacije: 403 na bill (assertResourceLocation).
 *
 * Fixture predpona: hhfl- (lokacije/zaposleni/meni/mize/naročila); FURS simulacija
 * prek FURS_ENVIRONMENT=simulation + location.fursEnvironment (enako kot furspost-).
 * Čiščenje reverse-FK v afterAll + pred-čiščenje v beforeAll ( odpornost na trčen tek).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid } from '@/lib/map'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { PATCH as ordersPATCH } from '../src/app/api/orders/[id]/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'
import { GET as billGET } from '../src/app/api/orders/[id]/bill/route'

const PREFIX = 'hhfl-'
const TS = Date.now()

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

// ── fiksture (napolnjene v beforeAll) ──
let locA = ''
let locB = ''
let waiterA = ''
let waiterB = ''
let kitchenA = ''
let item5 = ''
let item350 = ''
let table1 = ''
let tableB = ''

let tokenWaiterA = ''
let tokenWaiterB = ''
let tokenKitchenA = ''

let orderId = ''
let orderSeq = 890001

const PREV_FURS_ENV = process.env.FURS_ENVIRONMENT

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Reverse-FK čiščenje vseh fiks tur te datoteke (idempotentno — beforeAll IN afterAll) */
async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { code: { startsWith: `${PREFIX}-` } } })
  const locIds = locs.map((l) => l.id)
  for (const locId of locIds) {
    const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
    const orderIds = orders.map((o) => o.id)
    for (const oid of orderIds) {
      const receipts = await db.receipt.findMany({ where: { orderId: oid }, select: { id: true } })
      const receiptIds = receipts.map((r) => r.id)
      const checks = await db.check.findMany({ where: { orderId: oid }, select: { id: true } })
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      // (audit okt-2026 №27) Prej je tukaj stal še `deleteMany({ where: { orderId: oid } })`.
      // Payment nima stolpca orderId (prisma/schema.prisma:2052 — edina pot do naročila je
      // Check.checkId), zato stavek VEDNO vrže `Unknown argument 'orderId'` in ga
      // .catch(() => null) pogoltne: 12× na tek, brez učinka. Prehod po checkId zgoraj je
      // edini veljaven in že pokriva vsa plačila tega naročila.
      await db.eventLog.deleteMany({ where: { OR: [{ entityId: { in: [...receiptIds, oid] } }, { payload: { contains: PREFIX } }] } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...receiptIds, oid] } }, { details: { contains: PREFIX } }] } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.orderItem.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.order.deleteMany({ where: { id: oid } }).catch(() => null)
    }
    const tables = await db.table.findMany({ where: { locationId: locId }, select: { id: true } })
    await db.eventLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.table.deleteMany({ where: { locationId: locId } }).catch(() => null)
    const menus = await db.menu.findMany({ where: { locationId: locId }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
    await db.employee.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.counter.deleteMany({ where: { name: `receipt:${locId}` } }).catch(() => null)
    await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
  }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  process.env.FURS_ENVIRONMENT = 'simulation'
  await cleanupFixtures()

  locA = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: `BLGHHFLA${TS}`,
      taxId: 'SI12345678', registerNumber: 'BLG-HH-01A', fursEnvironment: 'simulation', country: 'SI' },
  })).id
  locB = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija B`, code: `${PREFIX}-B-${TS}`, premisesId: `BLGHHFLB${TS}`,
      taxId: 'SI87654321', registerNumber: 'BLG-HH-01B', fursEnvironment: 'simulation', country: 'SI' },
  })).id

  waiterA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Natakar A`, email: `${PREFIX}-waiter-a-${TS}@test.local`, role: 'waiter', pin: `${PREFIX}-pin-wa-${TS}`, locationId: locA },
  })).id
  waiterB = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Natakar B`, email: `${PREFIX}-waiter-b-${TS}@test.local`, role: 'waiter', pin: `${PREFIX}-pin-wb-${TS}`, locationId: locB },
  })).id
  kitchenA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Kuhar A`, email: `${PREFIX}-kitchen-a-${TS}@test.local`, role: 'kitchen', pin: `${PREFIX}-pin-ka-${TS}`, locationId: locA },
  })).id

  tokenWaiterA = createToken({ sub: waiterA, name: `${PREFIX} Natakar A`, role: 'WAITER', loc: locA, sv: 0 })
  tokenWaiterB = createToken({ sub: waiterB, name: `${PREFIX} Natakar B`, role: 'WAITER', loc: locB, sv: 0 })
  tokenKitchenA = createToken({ sub: kitchenA, name: `${PREFIX} Kuhar A`, role: 'KITCHEN', loc: locA, sv: 0 })

  const menuA = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const catA = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuA } })).id
  item5 = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Jedi 5`, price: 5, categoryId: catA, vatRate: 22 } })).id
  item350 = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Prigrizek 3.5`, price: 3.5, categoryId: catA, vatRate: 22 } })).id
  table1 = (await db.table.create({ data: { id: nid(), number: 71, capacity: 4, locationId: locA, status: 'available' } })).id
  tableB = (await db.table.create({ data: { id: nid(), number: 72, capacity: 2, locationId: locB, status: 'available' } })).id
})

afterAll(async () => {
  if (PREV_FURS_ENV === undefined) delete process.env.FURS_ENVIRONMENT
  else process.env.FURS_ENVIRONMENT = PREV_FURS_ENV
  await cleanupFixtures()
})

describe('handheld tok — predprijava (401)', () => {
  test('brez žetona: orders POST / fire / bill / furs → 401', async () => {
    expect((await ordersPOST(req('/api/orders', '', 'POST', { items: [] }))).status).toBe(401)
    expect((await firePOST(req('/api/orders/x/fire', '', 'POST', {}), { params: Promise.resolve({ id: 'x' }) })).status).toBe(401)
    expect((await billGET(req('/api/orders/x/bill', ''), { params: Promise.resolve({ id: 'x' }) })).status).toBe(401)
    expect((await fursPOST(req('/api/furs', '', 'POST', { orderId: 'x' }))).status).toBe(401)
  })
})

describe('handheld tok — zlata pot WAITER (mize → naroči → dodaj → fire → račun → plačilo)', () => {
  test('1. POST /api/orders: ustvari naročilo, zasede mizo, shrani opombo postavke', async () => {
    const res = await ordersPOST(req('/api/orders', tokenWaiterA, 'POST', {
      tableId: table1,
      items: [
        { menuItemId: item5, qty: 2 },
        { menuItemId: item350, qty: 1, note: 'brez čebule' },
      ],
      guests: 3,
      clientOperationId: `hhfl-create-${TS}`,
    }))
    expect(res.status).toBe(201)
    const body = await res.json()
    orderId = body.order.id
    expect(body.order.status).toBe('OPEN')
    expect(body.order.items).toHaveLength(2) // item5×2 + item350×1 — route združi po artiklu

    const tbl = await db.table.findUnique({ where: { id: table1 } })
    expect(tbl?.status).toBe('occupied') // CAS zasedenje mize
    const items = await db.orderItem.findMany({ where: { orderId }, orderBy: { menuItemId: 'asc' } })
    const noted = items.find((it) => it.menuItemId === item350)
    expect(noted?.notes).toBe('brez čebule') // opomba iz košarice handhelda
    expect(items.every((it) => it.status === 'pending')).toBe(true)
    expect(items.find((it) => it.menuItemId === item5)?.quantity).toBe(2)
    const ord = await db.order.findUnique({ where: { id: orderId } })
    expect(ord?.splitCount).toBe(3) // gostje se v DB shranijo kot splitCount (mapOrder → guests)
    expect(ord?.subtotal.toNumber ? ord.subtotal.toNumber() : Number(ord?.subtotal)).toBe(11.07) // NETO osnova (13,50 končnih − 2,43 DDV)
  })

  test('2. replay z istim clientOperationId → isti id, replayed, brez duplikatov (offline vrsta)', async () => {
    const res = await ordersPOST(req('/api/orders', tokenWaiterA, 'POST', {
      tableId: table1,
      items: [{ menuItemId: item5, qty: 2 }, { menuItemId: item350, qty: 1, note: 'brez čebule' }],
      guests: 3,
      clientOperationId: `hhfl-create-${TS}`,
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.replayed).toBe(true)
    expect(body.order.id).toBe(orderId)
    expect(await db.order.count({ where: { id: orderId } })).toBe(1)
    expect(await db.orderItem.count({ where: { orderId } })).toBe(2) // ni duplikata postavk
  })

  test('3. PATCH addItems (gumb "Dodaj artikle") → 4. postavka, skupaj 18,50', async () => {
    const res = await ordersPATCH(req(`/api/orders/${orderId}`, tokenWaiterA, 'PATCH', {
      addItems: [{ menuItemId: item5, qty: 1 }],
    }), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(200)
    expect(await db.orderItem.count({ where: { orderId } })).toBe(3) // +1 vrstica (brez združevanja)
    const ord = await db.order.findUnique({ where: { id: orderId } })
    expect(Number(ord?.subtotal)).toBe(15.17) // 18,50 končnih − 3,33 DDV
  })

  test('4. POST fire → vse pending postavke fired, order.firedAt, revizija ORDER_FIRED', async () => {
    const res = await firePOST(req(`/api/orders/${orderId}/fire`, tokenWaiterA, 'POST', {}), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.firedCount).toBe(3)
    expect(body.alreadyFired).toBe(false)

    const items = await db.orderItem.findMany({ where: { orderId } })
    expect(items.every((it) => it.status === 'fired')).toBe(true)
    const ord = await db.order.findUnique({ where: { id: orderId } })
    expect(ord?.firedAt).not.toBeNull()

    const audits = await db.auditLog.findMany({ where: { entityType: 'Order', entityId: orderId, action: 'ORDER_FIRED' } })
    expect(audits.length).toBe(1)
  })

  test('5. ponoven fire → idempotenten (alreadyFired, firedCount 0)', async () => {
    const res = await firePOST(req(`/api/orders/${orderId}/fire`, tokenWaiterA, 'POST', {}), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.alreadyFired).toBe(true)
    expect(body.firedCount).toBe(0)
    expect(await db.orderItem.count({ where: { orderId, status: 'fired' } })).toBe(3)
  })

  test('6. GET bill → kanonični znesek 18,50 (server odloča, ne UI)', async () => {
    const res = await billGET(req(`/api/orders/${orderId}/bill`, tokenWaiterA), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bill.subtotal).toBe(15.17) // NETO osnova — cena artiklov je KONČNA (z DDV)
    expect(body.bill.tax).toBe(3.33) // DDV, izvlečen iz 18,50 (1,80 + 0,63 + 0,90)
    expect(body.bill.totalDue).toBe(18.5) // = vsota prikazanih cen — gost plača točno toliko
    expect(body.order.id).toBe(orderId)
  })

  test('7. POST /api/furs gotovina + napitnina → paid, EOR, miza samodejno v čiščenje', async () => {
    const res = await fursPOST(req('/api/furs', tokenWaiterA, 'POST', {
      orderId,
      type: 'cash',
      tip: 1.5,
      clientOperationId: `hhfl-pay-${TS}`,
    }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.invoice.eor).toMatch(UUID_RE) // EOR iz FURS simulacije

    const ord = await db.order.findUnique({ where: { id: orderId } })
    expect(ord?.paymentStatus).toBe('paid')
    expect(ord?.status).toBe('paid')
    expect(ord?.paidAt).not.toBeNull()
    // zneski zaključka živijo na Računu (fiskalni dokument), ne na Order
    const receipt = await db.receipt.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' } })
    expect(Number(receipt?.total)).toBe(18.5) // = vsota prikazanih cen (DDV je že v ceni)
    expect(Number(receipt?.tip)).toBe(1.5)
    expect(Number(receipt?.totalWithTip)).toBe(20)

    const tbl = await db.table.findUnique({ where: { id: table1 } })
    expect(tbl?.status).toBe('cleaning') // samodejni prehod po plačilu (DIRTY v UI)
  })

  test('8. GET bill na plačanem naročilu → 409', async () => {
    const res = await billGET(req(`/api/orders/${orderId}/bill`, tokenWaiterA), { params: Promise.resolve({ id: orderId }) })
    expect(res.status).toBe(409)
  })
})

describe('handheld tok — varnostne meje', () => {
  let orderKitchen = ''

  beforeAll(async () => {
    // odprto naročilo za negativne primere (neplačano)
    const ord = await db.order.create({
      data: { id: nid(), orderNumber: orderSeq++, locationId: locA, tableId: null, status: 'open', paymentStatus: 'unpaid', subtotal: 0, tax: 0, total: 0, employeeId: waiterA },
    })
    orderKitchen = ord.id
    await db.orderItem.create({
      data: { id: nid(), orderId: ord.id, menuItemId: item5, quantity: 1, price: 5, vatRate: 22, vatAmount: 1.1, menuItemName: `${PREFIX} Jedi 5`, status: 'pending' },
    })
  })

  test('KITCHEN ne more fire (manjka orders.create) → 403', async () => {
    const res = await firePOST(req(`/api/orders/${orderKitchen}/fire`, tokenKitchenA, 'POST', {}), { params: Promise.resolve({ id: orderKitchen }) })
    expect(res.status).toBe(403)
  })

  test('KITCHEN ne more odpreti računa (manjka orders.pay) → 403', async () => {
    const res = await billGET(req(`/api/orders/${orderKitchen}/bill`, tokenKitchenA), { params: Promise.resolve({ id: orderKitchen }) })
    expect(res.status).toBe(403)
  })

  test('WAITER tuje lokacije ne more odpreti računa → 403', async () => {
    const res = await billGET(req(`/api/orders/${orderKitchen}/bill`, tokenWaiterB), { params: Promise.resolve({ id: orderKitchen }) })
    expect(res.status).toBe(403)
  })
})
