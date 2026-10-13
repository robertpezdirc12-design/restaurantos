/**
 * v1.85.0 — P0-2 iz TRZNA-VRZELI-2026 — PLAČILNA POVEZAVA (pay link): pogodba
 * javnega toka "QR položnica" (osebje izda povezavo → gost odpre /pay/<token> →
 * vidi račun → izbere napitnino → plača) SKOZI kanonične endpointe.
 *
 * Pokritje:
 *  1. 401 brez žetona (POST/DELETE paylink); 403 CLEANER/KITCHEN (brez orders.pay);
 *     403 tuja lokacija (Issue #4 §1 — isti varovalki kot plačilo);
 *  2. zlata pot WAITER: POST /api/orders → fire → POST paylink (token 32-hex, QR
 *     dataUrl, audit PAY_LINK_CREATED) → idempotentna izdaja (isti token) →
 *     javni GET (brez prijave! kanonični račun 22,57 €, provider=simulator) →
 *     javni POST plačilo z napitnino (2,26 €) → kanonični FURS zaključek:
 *     naročilo paid + miza cleaning + Payment card/SIM- + Receipt EOR +
 *     totalWithTip 24,83 + PayLink paid/receiptId + audit PAY_LINK_PAID (userId
 *     null — javni aktor);
 *  3. po plačilu: javni GET = plačano (št. računa/EOR), javni POST = 409,
 *     GET bill = 409 (kanonična ruta);
 *  4. revokacija (DELETE → javni POST 409, GET revoked);
 *  5. poteklo (expiresAt v preteklosti → GET expired, POST 409);
 *  6. superseded (POS plača prej → javni POST 409 'plačano drugje', GET superseded);
 *  7. izdaja na plačanem naročilu = 409; napitnina > znesek = 400;
 *  8. SMS fail-soft (brez Integration type=sms → sms.sent=false + detail);
 *  9. Stripe pot (STRIPE_SECRET_KEY + fetch stub): checkout seja → 201 redirect +
 *     znesek zaklenjen na povezavi; verifySession → paid + Payment
 *     authorizationCode=pi_… (kanonični FURS zaključek).
 *
 * Fixture predpona: plnk-; FURS simulacija prek FURS_ENVIRONMENT=simulation.
 * Čiščenje reverse-FK v afterAll + pred-čiščenje v beforeAll (trdoživost).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid } from '@/lib/map'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'
import { GET as billGET } from '../src/app/api/orders/[id]/bill/route'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { POST as paylinkPOST, DELETE as paylinkDELETE } from '../src/app/api/orders/[id]/paylink/route'
import { GET as publicPayGET, POST as publicPayPOST } from '../src/app/api/public/pay/[token]/route'

const PREFIX = 'plnk-'
const TS = Date.now()
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const HEX32_RE = /^[0-9a-f]{32}$/

// ── fiksture ──
let locA = ''
let locB = ''
let waiterA = ''
let waiterB = ''
let kitchenA = ''
let cleanerA = ''
let item5 = ''
let item350 = ''
const TABLE_POOL: string[] = []
let tableCursor = 0

let tokenWaiterA = ''
let tokenWaiterB = ''
let tokenKitchenA = ''
let tokenCleanerA = ''

let orderSeq = 891001
const PREV_FURS_ENV = process.env.FURS_ENVIRONMENT
const PREV_STRIPE_KEY = process.env.STRIPE_SECRET_KEY

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function mkOrder(): Promise<{ id: string; table: string }> {
  const idx = tableCursor++ % TABLE_POOL.length
  const tableId = TABLE_POOL[idx]
  const res = await ordersPOST(
    req('/api/orders', tokenWaiterA, 'POST', {
      tableId,
      guests: 2,
      items: [
        { menuItemId: item5, qty: 3 },
        { menuItemId: item350, qty: 1 },
      ],
      clientOperationId: `${PREFIX}-op-${TS}-${orderSeq++}`,
    }),
  )
  const data = (await res.json()) as { order?: { id: string }; id?: string }
  const id = data.order?.id || data.id || ''
  if (!id) throw new Error(`mkOrder failed: ${res.status}`)
  await firePOST(req(`/api/orders/${id}/fire`, tokenWaiterA, 'POST', {}), { params: Promise.resolve({ id }) })
  return { id, table: `Miza ${81 + idx}` }
}

async function mkLink(orderId: string, extra?: Record<string, unknown>): Promise<{ token: string; id: string }> {
  const res = await paylinkPOST(req(`/api/orders/${orderId}/paylink`, tokenWaiterA, 'POST', extra ?? {}), {
    params: Promise.resolve({ id: orderId }),
  })
  const data = (await res.json()) as { link: { token: string; id: string } }
  if (!data.link?.token) throw new Error(`mkLink failed: ${res.status}`)
  return data.link
}

/** Reverse-FK čiščenje vseh fiks tur te datoteke (idempotentno) */
async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { code: { startsWith: `${PREFIX}-` } } })
  for (const loc of locs) {
    const links = await db.payLink.findMany({ where: { locationId: loc.id }, select: { id: true } })
    const orders = await db.order.findMany({ where: { locationId: loc.id }, select: { id: true } })
    const orderIds = orders.map((o) => o.id)
    for (const oid of orderIds) {
      const receipts = await db.receipt.findMany({ where: { orderId: oid }, select: { id: true } })
      const receiptIds = receipts.map((r) => r.id)
      const checks = await db.check.findMany({ where: { orderId: oid }, select: { id: true } })
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { OR: [{ entityId: { in: [...receiptIds, oid] } }, { payload: { contains: PREFIX } }] } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...receiptIds, oid, ...links.map((l) => l.id)] } }, { details: { contains: PREFIX } }] } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.orderItem.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.order.deleteMany({ where: { id: oid } }).catch(() => null)
    }
    await db.auditLog.deleteMany({ where: { entityId: { in: links.map((l) => l.id) } } }).catch(() => null)
    await db.payLink.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    const tables = await db.table.findMany({ where: { locationId: loc.id }, select: { id: true } })
    await db.eventLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.table.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    const menus = await db.menu.findMany({ where: { locationId: loc.id }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
    await db.employee.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    await db.counter.deleteMany({ where: { name: `receipt:${loc.id}` } }).catch(() => null)
    await db.location.deleteMany({ where: { id: loc.id } }).catch(() => null)
  }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  process.env.FURS_ENVIRONMENT = 'simulation'
  delete process.env.STRIPE_SECRET_KEY
  await cleanupFixtures()

  locA = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: `BLGPLNKA${TS}`,
      taxId: 'SI12345678', registerNumber: 'BLG-PL-01A', fursEnvironment: 'simulation', country: 'SI' },
  })).id
  locB = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija B`, code: `${PREFIX}-B-${TS}`, premisesId: `BLGPLNKB${TS}`,
      taxId: 'SI87654321', registerNumber: 'BLG-PL-01B', fursEnvironment: 'simulation', country: 'SI' },
  })).id

  waiterA = (await db.employee.create({ data: { id: nid(), name: `${PREFIX} Natakar A`, email: `${PREFIX}-waiter-a-${TS}@test.local`, role: 'waiter', pin: `${PREFIX}-pin-wa-${TS}`, locationId: locA } })).id
  waiterB = (await db.employee.create({ data: { id: nid(), name: `${PREFIX} Natakar B`, email: `${PREFIX}-waiter-b-${TS}@test.local`, role: 'waiter', pin: `${PREFIX}-pin-wb-${TS}`, locationId: locB } })).id
  kitchenA = (await db.employee.create({ data: { id: nid(), name: `${PREFIX} Kuhar A`, email: `${PREFIX}-kitchen-a-${TS}@test.local`, role: 'kitchen', pin: `${PREFIX}-pin-ka-${TS}`, locationId: locA } })).id
  cleanerA = (await db.employee.create({ data: { id: nid(), name: `${PREFIX} Čistilec A`, email: `${PREFIX}-cleaner-a-${TS}@test.local`, role: 'cleaner', pin: `${PREFIX}-pin-cl-${TS}`, locationId: locA } })).id

  tokenWaiterA = createToken({ sub: waiterA, name: `${PREFIX} Natakar A`, role: 'WAITER', loc: locA, sv: 0 })
  tokenWaiterB = createToken({ sub: waiterB, name: `${PREFIX} Natakar B`, role: 'WAITER', loc: locB, sv: 0 })
  tokenKitchenA = createToken({ sub: kitchenA, name: `${PREFIX} Kuhar A`, role: 'KITCHEN', loc: locA, sv: 0 })
  tokenCleanerA = createToken({ sub: cleanerA, name: `${PREFIX} Čistilec A`, role: 'CLEANER', loc: locA, sv: 0 })

  const menuA = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const catA = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuA } })).id
  item5 = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Jedi 5`, price: 5, categoryId: catA, vatRate: 22 } })).id
  item350 = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Prigrizek 3.5`, price: 3.5, categoryId: catA, vatRate: 22 } })).id
  for (let n = 81; n <= 98; n++) {
    TABLE_POOL.push((await db.table.create({ data: { id: nid(), number: n, capacity: 4, locationId: locA, status: 'available' } })).id)
  }
})

afterAll(async () => {
  if (PREV_FURS_ENV === undefined) delete process.env.FURS_ENVIRONMENT
  else process.env.FURS_ENVIRONMENT = PREV_FURS_ENV
  if (PREV_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = PREV_STRIPE_KEY
  await cleanupFixtures()
})

describe('paylink — dostopne pravice (osebje)', () => {
  const mk = async (token: string) => {
    const { id: oid } = await mkOrder()
    return paylinkPOST(req(`/api/orders/${oid}/paylink`, token, 'POST', {}), { params: Promise.resolve({ id: oid }) })
  }
  test('401 brez žetona (POST + DELETE)', async () => {
    const { id: oid } = await mkOrder()
    expect((await paylinkPOST(req(`/api/orders/${oid}/paylink`, '', 'POST', {}), { params: Promise.resolve({ id: oid }) })).status).toBe(401)
    expect((await paylinkDELETE(req(`/api/orders/${oid}/paylink`, '', 'DELETE'), { params: Promise.resolve({ id: oid }) })).status).toBe(401)
  })
  test('403 CLEANER (brez orders.pay)', async () => {
    expect((await mk(tokenCleanerA)).status).toBe(403)
  })
  test('403 KITCHEN (brez orders.pay)', async () => {
    expect((await mk(tokenKitchenA)).status).toBe(403)
  })
  test('403 WAITER tuje lokacije (Issue #4 §1)', async () => {
    const { id: oid } = await mkOrder()
    expect((await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterB, 'POST', {}), { params: Promise.resolve({ id: oid }) })).status).toBe(403)
  })
})

describe('paylink — zlata pot (izda → javni ogled → javno plačilo → FURS)', () => {
  let oid = ''
  let linkToken = ''
  let tableLabel = ''

  test('1. POST paylink: token 32-hex + QR dataUrl + vrstica + audit', async () => {
    const made = await mkOrder()
    oid = made.id
    tableLabel = made.table
    const res = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', {}), { params: Promise.resolve({ id: oid }) })
    expect(res.status).toBe(201)
    const data = (await res.json()) as { link: { token: string; url: string; qrDataUrl: string; status: string } }
    expect(data.link.token).toMatch(HEX32_RE)
    expect(data.link.url).toContain(`/pay/${data.link.token}`)
    expect(data.link.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(data.link.status).toBe('open')
    linkToken = data.link.token
    const row = await db.payLink.findUnique({ where: { token: linkToken } })
    expect(row?.status).toBe('open')
    expect(row?.orderId).toBe(oid)
    const audit = await db.auditLog.findFirst({ where: { entityId: row?.id, action: 'PAY_LINK_CREATED' } })
    expect(audit?.userId).toBe(waiterA)
  })

  test('2. idempotentna izdaja: isti token (brez rotate)', async () => {
    const res = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', {}), { params: Promise.resolve({ id: oid }) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { link: { token: string; existing: boolean } }
    expect(data.link.token).toBe(linkToken)
    expect(data.link.existing).toBe(true)
  })

  test('3. javni GET (brez prijave): kanonični račun 22,57 € + simulator', async () => {
    const res = await publicPayGET(req(`/api/public/pay/${linkToken}`, ''), { params: Promise.resolve({ token: linkToken }) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      status: string; provider: string; bill: { totalDue: number; subtotal: number }; order: { orderNumber: number; table: string | null }; location: { name: string }
    }
    expect(data.status).toBe('open')
    expect(data.provider).toBe('simulator')
    expect(data.bill.subtotal).toBe(18.5)
    expect(data.bill.totalDue).toBe(22.57)
    expect(data.order.table).toBe(tableLabel)
    expect(data.location.name).toBe(`${PREFIX} Lokacija A`)
  })

  test('4. javni GET neznan token → 404 (ne razkriva)', async () => {
    expect((await publicPayGET(req('/api/public/pay/' + 'f'.repeat(32), ''), { params: Promise.resolve({ token: 'f'.repeat(32) }) })).status).toBe(404)
    expect((await publicPayGET(req('/api/public/pay/short', ''), { params: Promise.resolve({ token: 'short' }) })).status).toBe(404)
  })

  test('5. javni POST plačilo z napitnino → kanonični FURS zaključek', async () => {
    const res = await publicPayPOST(req(`/api/public/pay/${linkToken}`, '', 'POST', { tip: 2.26 }), { params: Promise.resolve({ token: linkToken }) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { status: string; receipt: { receiptNumber: string; eor: string | null; totalWithTip: number; tip: number; paymentMethod: string } }
    expect(data.status).toBe('paid')
    expect(data.receipt.eor).toMatch(UUID_RE)
    expect(data.receipt.totalWithTip).toBe(24.83)
    expect(data.receipt.tip).toBe(2.26)
    expect(data.receipt.paymentMethod).toBe('card')

    const order = await db.order.findUnique({ where: { id: oid } })
    expect(order?.status).toBe('paid')
    expect(order?.paymentStatus).toBe('paid')
    const order2 = await db.order.findUnique({ where: { id: oid }, select: { tableId: true } })
    const table = await db.table.findUnique({ where: { id: order2?.tableId || '' } })
    expect(table?.status).toBe('cleaning')
    const payment = await db.payment.findFirst({ where: { idempotencyKey: `plk:${linkToken}#p0` } })
    expect(payment?.type).toBe('card')
    expect(payment?.authorizationCode).toMatch(/^SIM-/)
    expect(payment?.status).toBe('completed')
    const linkRow = await db.payLink.findUnique({ where: { token: linkToken } })
    expect(linkRow?.status).toBe('paid')
    expect(linkRow?.receiptId).toBeTruthy()
    const audit = await db.auditLog.findFirst({ where: { entityId: linkRow?.id, action: 'PAY_LINK_PAID' } })
    expect(audit?.userId).toBe(null)
  })

  test('6. po plačilu: javni GET = plačano, javni POST = 409, bill = 409', async () => {
    const res = await publicPayGET(req(`/api/public/pay/${linkToken}`, ''), { params: Promise.resolve({ token: linkToken }) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { status: string; receipt: { receiptNumber: string } }
    expect(data.status).toBe('paid')
    expect(data.receipt.receiptNumber).toBeTruthy()

    expect((await publicPayPOST(req(`/api/public/pay/${linkToken}`, '', 'POST', { tip: 0 }), { params: Promise.resolve({ token: linkToken }) })).status).toBe(409)
    expect((await billGET(req(`/api/orders/${oid}/bill`, tokenWaiterA), { params: Promise.resolve({ id: oid }) })).status).toBe(409)
  })

  test('7. izdaja na plačanem naročilu → 409', async () => {
    expect((await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', {}), { params: Promise.resolve({ id: oid }) })).status).toBe(409)
  })
})

describe('paylink — mrtve povezave (revokacija / poteklo / superseded)', () => {
  test('revokacija: DELETE → javni POST 409, GET revoked', async () => {
    const { id: oid } = await mkOrder()
    const link = await mkLink(oid)
    const del = await paylinkDELETE(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'DELETE'), { params: Promise.resolve({ id: oid }) })
    expect(del.status).toBe(200)
    expect((await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 0 }), { params: Promise.resolve({ token: link.token }) })).status).toBe(409)
    const res = await publicPayGET(req(`/api/public/pay/${link.token}`, ''), { params: Promise.resolve({ token: link.token }) })
    const data = (await res.json()) as { status: string }
    expect(data.status).toBe('revoked')
    const audit = await db.auditLog.findFirst({ where: { entityId: link.id, action: 'PAY_LINK_REVOKED' } })
    expect(audit?.userId).toBe(waiterA)
  })

  test('poteklo: expiresAt v preteklosti → GET expired, POST 409', async () => {
    const { id: oid } = await mkOrder()
    const link = await mkLink(oid)
    await db.payLink.update({ where: { token: link.token }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    const res = await publicPayGET(req(`/api/public/pay/${link.token}`, ''), { params: Promise.resolve({ token: link.token }) })
    const data = (await res.json()) as { status: string }
    expect(data.status).toBe('expired')
    expect((await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 0 }), { params: Promise.resolve({ token: link.token }) })).status).toBe(409)
  })

  test('superseded: POS plača prej → javni POST 409, GET superseded', async () => {
    const { id: oid } = await mkOrder()
    const link = await mkLink(oid)
    const pos = await fursPOST(req('/api/furs', tokenWaiterA, 'POST', { orderId: oid, type: 'cash', clientOperationId: `${PREFIX}-pos-${TS}-${oid.slice(-4)}` }))
    expect(pos.status).toBe(201)
    expect((await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 0 }), { params: Promise.resolve({ token: link.token }) })).status).toBe(409)
    const res = await publicPayGET(req(`/api/public/pay/${link.token}`, ''), { params: Promise.resolve({ token: link.token }) })
    const data = (await res.json()) as { status: string }
    expect(data.status).toBe('superseded')
  })
})

describe('paylink — validacija + SMS fail-soft', () => {
  test('napitnina > znesek računa → 400', async () => {
    const { id: oid } = await mkOrder()
    const link = await mkLink(oid)
    const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 22.58 }), { params: Promise.resolve({ token: link.token }) })
    expect(res.status).toBe(400)
  })

  test('SMS brez konfiguracije: fail-soft (sent=false + razlog)', async () => {
    const { id: oid } = await mkOrder()
    const res = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { phone: '+38640123456' }), { params: Promise.resolve({ id: oid }) })
    expect(res.status).toBe(201)
    const data = (await res.json()) as { link: { sms: { sent: boolean; detail: string } | null } }
    expect(data.link.sms?.sent).toBe(false)
    expect(data.link.sms?.detail).toContain('SMS ni konfiguriran')
    const row = await db.payLink.findFirst({ where: { orderId: oid } })
    expect(row?.phone).toBe('+38640123456')
    expect(row?.smsDetail).toContain('SMS ni konfiguriran')
  })
})

describe('paylink — Stripe pot (ponudnik prek env, fetch stub)', () => {
  const origFetch = globalThis.fetch

  test('checkout: 201 redirect + znesek/napitnina ZAKLEPANA na povezavi', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_plnk'
    let called = ''
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      called = String(url)
      if (called.includes('api.stripe.com/v1/checkout/sessions') && (init?.method || 'GET') === 'POST') {
        return new Response(JSON.stringify({ id: 'cs_plnk_1', url: 'https://checkout.stripe.com/c/pay/cs_plnk_1' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const { id: oid } = await mkOrder()
      const link = await mkLink(oid)
      const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 2.26 }), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(201)
      const data = (await res.json()) as { redirect: string; amount: number }
      expect(data.redirect).toContain('checkout.stripe.com')
      expect(data.amount).toBe(24.83)
      expect(called).toContain('api.stripe.com')
      const row = await db.payLink.findUnique({ where: { token: link.token } })
      expect(Number(row?.amount)).toBe(24.83)
      expect(Number(row?.tip)).toBe(2.26)
      // še NI plačano — seja čaka
      expect(row?.status).toBe('open')
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('verifySession: plačana seja → kanonični FURS zaključek + pi_ sled', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_plnk'
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('api.stripe.com/v1/checkout/sessions/cs_plnk_2')) {
        return new Response(JSON.stringify({ id: 'cs_plnk_2', payment_status: 'paid', payment_intent: 'pi_plnk_2', amount_total: 2483 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const { id: oid } = await mkOrder()
      const link = await mkLink(oid)
      // zakleni znesek (kot bi ga checkout)
      await db.payLink.update({ where: { token: link.token }, data: { amount: 24.83, tip: 2.26 } })
      const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_plnk_2' }), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(200)
      const data = (await res.json()) as { status: string; receipt: { totalWithTip: number } }
      expect(data.status).toBe('paid')
      expect(data.receipt.totalWithTip).toBe(24.83)
      const payment = await db.payment.findFirst({ where: { idempotencyKey: `plk:${link.token}#p0` } })
      expect(payment?.authorizationCode).toBe('pi_plnk_2')
      expect(payment?.type).toBe('card')
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('verifySession: napačen znesek seje → 409 (neposrednost)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_plnk'
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('api.stripe.com/v1/checkout/sessions/cs_plnk_3')) {
        return new Response(JSON.stringify({ id: 'cs_plnk_3', payment_status: 'paid', payment_intent: 'pi_plnk_3', amount_total: 9999 }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const { id: oid } = await mkOrder()
      const link = await mkLink(oid)
      await db.payLink.update({ where: { token: link.token }, data: { amount: 24.83, tip: 2.26 } })
      const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_plnk_3' }), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(409)
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })
})

