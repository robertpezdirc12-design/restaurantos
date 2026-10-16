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
import { POST as migratePaylinkPOST } from '../src/app/api/admin/migrate-paylink/route'
import { POST as migratePaylinkSplitPOST } from '../src/app/api/admin/migrate-paylink-split/route'
import { payLinkReady, resetPayLinkProbe } from '@/lib/paylink/core'

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
let ownerA = ''
let item5 = ''
let item350 = ''
const TABLE_POOL: string[] = []
let tableCursor = 0

let tokenWaiterA = ''
let tokenWaiterB = ''
let tokenKitchenA = ''
let tokenCleanerA = ''
let tokenOwnerA = ''

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
  ownerA = (await db.employee.create({ data: { id: nid(), name: `${PREFIX} Lastnik A`, email: `${PREFIX}-owner-a-${TS}@test.local`, role: 'owner', pin: `${PREFIX}-pin-ow-${TS}`, locationId: locA } })).id

  tokenWaiterA = createToken({ sub: waiterA, name: `${PREFIX} Natakar A`, role: 'WAITER', loc: locA, sv: 0 })
  tokenWaiterB = createToken({ sub: waiterB, name: `${PREFIX} Natakar B`, role: 'WAITER', loc: locB, sv: 0 })
  tokenKitchenA = createToken({ sub: kitchenA, name: `${PREFIX} Kuhar A`, role: 'KITCHEN', loc: locA, sv: 0 })
  tokenCleanerA = createToken({ sub: cleanerA, name: `${PREFIX} Čistilec A`, role: 'CLEANER', loc: locA, sv: 0 })
  tokenOwnerA = createToken({ sub: ownerA, name: `${PREFIX} Lastnik A`, role: 'OWNER', loc: locA, sv: 0 })

  const menuA = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const catA = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuA } })).id
  item5 = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Jedi 5`, price: 5, categoryId: catA, vatRate: 22 } })).id
  item350 = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Prigrizek 3.5`, price: 3.5, categoryId: catA, vatRate: 22 } })).id
  // P1-6: več testov → več naročil (vsaka mkOrder zasede mizo do konca suite-a)
  for (let n = 81; n <= 148; n++) {
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
    const payment = await db.payment.findFirst({ where: { idempotencyKey: `plkset:${oid}#p0` } })
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

  test('checkout: 201 redirect + znesek/napitnina ZAKLEPANA + KANONIČNA seja prijavljena (#37)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_plnk'
    let called = ''
    let createBody = ''
    let createHeaders: Record<string, string> = {}
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      called = String(url)
      if (called.includes('api.stripe.com/v1/checkout/sessions') && (init?.method || 'GET') === 'POST') {
        createBody = String(init?.body || '')
        createHeaders = (init?.headers as Record<string, string>) || {}
        return new Response(JSON.stringify({ id: 'cs_plnk_1', url: 'https://checkout.stripe.com/c/pay/cs_plnk_1' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const { id: oid } = await mkOrder()
      const link = await mkLink(oid)
      const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 2.26 }), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(201)
      const data = (await res.json()) as { redirect: string; amount: number; share: number; sessionId: string }
      expect(data.redirect).toContain('checkout.stripe.com')
      expect(data.amount).toBe(24.83) // delež + napitnina (seja)
      expect(data.share).toBe(22.57) // P1-6: amount = delež BREZ napitnine
      expect(called).toContain('api.stripe.com')
      // #37: seja je VEZANA na konkretno povezavo/naročilo/lokacijo (server-side)
      expect(createBody).toContain(`metadata%5BpayLinkId%5D=${encodeURIComponent(link.id)}`)
      expect(createBody).toContain(`metadata%5BorderId%5D=${encodeURIComponent(oid)}`)
      expect(createBody).toContain(`client_reference_id=${encodeURIComponent(link.id)}`)
      expect(createBody).toContain('metadata%5BexpectedAmountCents%5D=2483')
      expect(String(createHeaders['idempotency-key'] || '')).toContain(`paylink-${link.id}-`)
      const row = await db.payLink.findUnique({ where: { token: link.token } })
      expect(Number(row?.amount)).toBe(22.57)
      expect(Number(row?.tip)).toBe(2.26)
      // #37: KANONIČNI sessionId je atomarno prijavljen na povezavi
      expect(row?.sessionId).toBe('cs_plnk_1')
      // še NI plačano — seja čaka
      expect(row?.status).toBe('open')
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('verifySession: plačana KANONIČNA seja → kanonični FURS zaključek + pi_ sled', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_plnk'
    const { id: oid } = await mkOrder()
    const link = await mkLink(oid)
    // zakleni znesek + KANONIČNO sejo (kot bi ju checkout — #37)
    await db.payLink.update({ where: { token: link.token }, data: { amount: 22.57, tip: 2.26, sessionId: 'cs_plnk_2' } })
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('api.stripe.com/v1/checkout/sessions/cs_plnk_2')) {
        return new Response(JSON.stringify({
          id: 'cs_plnk_2', object: 'checkout.session', status: 'complete', mode: 'payment',
          payment_status: 'paid', payment_intent: 'pi_plnk_2', amount_total: 2483, currency: 'eur',
          client_reference_id: link.id,
          metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2483', currency: 'eur' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_plnk_2' }), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(200)
      const data = (await res.json()) as { status: string; receipt: { totalWithTip: number } }
      expect(data.status).toBe('paid')
      expect(data.receipt.totalWithTip).toBe(24.83)
      const payment = await db.payment.findFirst({ where: { idempotencyKey: `plkset:${oid}#p0` } })
      expect(payment?.authorizationCode).toBe('pi_plnk_2')
      expect(payment?.type).toBe('card')
      // #37: revizija nosi omejeno sled seje (ne-skrivna oblika)
      const audit = await db.auditLog.findFirst({ where: { action: 'PAY_LINK_PAID', entityId: link.id } })
      expect(audit?.details).toContain('session=cs_plnk_2…')
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('verifySession: napačen znesek seje → 409 (neposrednost)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_plnk'
    const { id: oid } = await mkOrder()
    const link = await mkLink(oid)
    await db.payLink.update({ where: { token: link.token }, data: { amount: 22.57, tip: 2.26, sessionId: 'cs_plnk_3' } })
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('api.stripe.com/v1/checkout/sessions/cs_plnk_3')) {
        return new Response(JSON.stringify({
          id: 'cs_plnk_3', status: 'complete', mode: 'payment', payment_status: 'paid',
          payment_intent: 'pi_plnk_3', amount_total: 9999, currency: 'eur',
          metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2483', currency: 'eur' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_plnk_3' }), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(409)
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })
})

describe('paylink — produkcijski DDL korak (migrate-paylink + 503 degradacija)', () => {
  test('migrate-paylink: 401 brez žetona, 403 waiter (ni centralen), owner → alreadyApplied (SQLite ima tabelo)', async () => {
    expect((await migratePaylinkPOST(req('/api/admin/migrate-paylink', '', 'POST', {}))).status).toBe(401)
    expect((await migratePaylinkPOST(req('/api/admin/migrate-paylink', tokenWaiterA, 'POST', {}))).status).toBe(403)
    const res = await migratePaylinkPOST(req('/api/admin/migrate-paylink', tokenOwnerA, 'POST', {}))
    expect(res.status).toBe(200)
    const data = (await res.json()) as { alreadyApplied: boolean }
    expect(data.alreadyApplied).toBe(true) // dev SQLite: db push je tabelo že ustvaril
    expect(await payLinkReady()).toBe(true)
  })

  test('503 degradacija: tabela manjka → javna ruta 503; obnovitev → spet deluje (PENDING simulacija)', async () => {
    const { id: oid } = await mkOrder()
    const link = await mkLink(oid)
    try {
      // PENDING simulacija (issue-10 vzorec iz migrations-console): drop tabelo
      // (tolerantno, če je tabela ravno že padla — vzporedni worker)
      await db.$executeRawUnsafe('DROP TABLE "PayLink"').catch((e) => {
        if (!String((e as Error).message).includes('no such table')) throw e
      })
      resetPayLinkProbe()
      const res = await publicPayGET(req(`/api/public/pay/${link.token}`, ''), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(503)
      // ponovna vzpostavitev (DDL rute brez ALTER CONSTRAINT — SQLite kompatibilno;
      // produkcijski Postgres dobi CELOTEN DDL prek /api/admin/migrate-paylink).
      // issue #2 CI: IDEMPOTENTNO (IF NOT EXISTS) — suite poganja datoteke v
      // VZPOREDNIH workerjih nad skupno SQLite bazo; med oknom drop→create je
      // lahko sočasni worker (npr. delegacija migracijske konzole) tabelo že
      // znova postavil. Semantika testa se ne spremeni: po obnovitvi mora
      // obstajati tabela in javna ruta vrniti 404 (prazna) namesto 503.
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "PayLink" (
        "id" TEXT NOT NULL,
        "token" TEXT NOT NULL,
        "orderId" TEXT NOT NULL,
        "locationId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'open',
        "phone" TEXT NOT NULL DEFAULT '',
        "smsDetail" TEXT NOT NULL DEFAULT '',
        "amount" DECIMAL(65,30),
        "tip" DECIMAL(65,30),
        "splitIndex" INTEGER NOT NULL DEFAULT 1,
        "splitCount" INTEGER NOT NULL DEFAULT 1,
        "approvalCode" TEXT NOT NULL DEFAULT '',
        "sessionId" TEXT,
        "expiresAt" DATETIME,
        "paidAt" DATETIME,
        "receiptId" TEXT,
        "createdBy" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "PayLink_pkey" PRIMARY KEY ("id")
      )`)
      await db.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "PayLink_token_key" ON "PayLink"("token")')
      // P1-6: orderId NI VEČ unikaten (N povezav na naročilo)
      await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "PayLink_createdAt_idx" ON "PayLink"("createdAt")')
      await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "PayLink_locationId_idx" ON "PayLink"("locationId")')
      await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "PayLink_status_idx" ON "PayLink"("status")')
      resetPayLinkProbe()
      // tabela je prazna (vrstica je padla z dropom) — token ne obstaja → čist 404, ne več 500/503
      const res2 = await publicPayGET(req(`/api/public/pay/${link.token}`, ''), { params: Promise.resolve({ token: link.token }) })
      expect(res2.status).toBe(404)
      expect(await payLinkReady()).toBe(true)
    } finally {
      // varovalka: tabela MORA obstajati za ostale datoteke suite
      const ok2 = await (async () => { try { await db.$queryRawUnsafe('SELECT 1 FROM "PayLink" LIMIT 1'); return true } catch { return false } })()
      if (!ok2) {
        await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "PayLink" (
          "id" TEXT NOT NULL, "token" TEXT NOT NULL, "orderId" TEXT NOT NULL, "locationId" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'open', "phone" TEXT NOT NULL DEFAULT '', "smsDetail" TEXT NOT NULL DEFAULT '',
          "amount" DECIMAL(65,30), "tip" DECIMAL(65,30),
          "splitIndex" INTEGER NOT NULL DEFAULT 1, "splitCount" INTEGER NOT NULL DEFAULT 1, "approvalCode" TEXT NOT NULL DEFAULT '',
          "expiresAt" DATETIME, "paidAt" DATETIME,
          "receiptId" TEXT, "createdBy" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL, CONSTRAINT "PayLink_pkey" PRIMARY KEY ("id")
        )`)
        await db.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "PayLink_token_key" ON "PayLink"("token")').catch(() => null)
      }
      resetPayLinkProbe()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// P1-6 (v1.87.0) — SPLIT PO GOSTIH: N povezav na naročilo (vsak gost svoj
// QR/delež) + vmesna plačila (partial) + končni račun prek FURS jedra +
// POS zaključek preostanka + varovalke konservativnosti zneska.
// ═══════════════════════════════════════════════════════════════════════════
describe('paylink — P1-6 SPLIT PO GOSTIH (N povezav, partial, končni račun)', () => {
  test('1. split izdaja: 3 povezave, centno natančni deleži (Σ = 22,57), audit SPLIT_CREATED', async () => {
    const { id: oid } = await mkOrder()
    const res = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid }) })
    expect(res.status).toBe(201)
    const data = (await res.json()) as { links: { token: string; url: string; qrDataUrl: string; amount: number; splitIndex: number; splitCount: number }[] }
    expect(data.links).toHaveLength(3)
    for (const l of data.links) {
      expect(l.token).toMatch(HEX32_RE)
      expect(l.url).toContain(`/pay/${l.token}`)
      expect(l.qrDataUrl).toMatch(/^data:image\/png;base64,/)
      expect(l.splitCount).toBe(3)
    }
    expect(data.links.map((l) => l.splitIndex)).toEqual([1, 2, 3])
    // 22,57 € = 2257 centov / 3 → 753, 752, 752
    expect(data.links.map((l) => l.amount)).toEqual([7.53, 7.52, 7.52])
    expect(data.links.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(22.57, 2)
    const rows = await db.payLink.findMany({ where: { orderId: oid }, orderBy: { splitIndex: 'asc' } })
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.status === 'open')).toBe(true)
    const audit = await db.auditLog.findFirst({ where: { action: 'PAY_LINK_SPLIT_CREATED', details: { contains: `order=#` } } })
    expect(audit).toBeTruthy()
  })

  test('2. idempotentna izdaja niza (brez split namena): isti žetoni + existing', async () => {
    const { id: oid } = await mkOrder()
    const r1 = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 2 }), { params: Promise.resolve({ id: oid }) })
    const d1 = (await r1.json()) as { links: { token: string }[] }
    const r2 = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', {}), { params: Promise.resolve({ id: oid }) })
    expect(r2.status).toBe(200)
    const d2 = (await r2.json()) as { links: { token: string }[]; existing: boolean }
    expect(d2.existing).toBe(true)
    expect(d2.links.map((l) => l.token)).toEqual(d1.links.map((l) => l.token))
  })

  test('3. nova split izdaja: obstoječe odprte povezave superseded', async () => {
    const { id: oid } = await mkOrder()
    await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid }) })
    const r2 = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 2 }), { params: Promise.resolve({ id: oid }) })
    expect(r2.status).toBe(201)
    const rows = await db.payLink.findMany({ where: { orderId: oid } })
    expect(rows.filter((r) => r.status === 'superseded')).toHaveLength(3)
    expect(rows.filter((r) => r.status === 'open')).toHaveLength(2)
  })

  test('4. javni GET na delež: split kontekst (delež, plačanih, preostanek)', async () => {
    const { id: oid } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { token: string }[] }
    const res = await publicPayGET(req(`/api/public/pay/${d.links[1].token}`, ''), { params: Promise.resolve({ token: d.links[1].token }) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { status: string; bill: { totalDue: number }; split: { index: number; count: number; share: number; paidShares: number; remaining: number } }
    expect(data.status).toBe('open')
    expect(data.bill.totalDue).toBe(22.57)
    expect(data.split).toMatchObject({ index: 2, count: 3, share: 7.52, paidShares: 0, remaining: 22.57 })
  })

  test('5. vmesni delež: plačan brez računa — order partial, approval na vrstici, audit SHARE_PAID', async () => {
    const { id: oid } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { token: string; id: string }[] }
    const res = await publicPayPOST(req(`/api/public/pay/${d.links[0].token}`, '', 'POST', { tip: 0.75 }), { params: Promise.resolve({ token: d.links[0].token }) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { status: string; share: number; tip: number; approvalCode: string; receiptPending: boolean; split: { paidShares: number } }
    expect(data.status).toBe('paid')
    expect(data.share).toBe(7.53)
    expect(data.tip).toBe(0.75)
    expect(data.approvalCode).toMatch(/^SIM-/)
    expect(data.receiptPending).toBe(true)
    expect(data.split.paidShares).toBe(1)

    const row = await db.payLink.findUnique({ where: { token: d.links[0].token } })
    expect(row?.status).toBe('paid')
    expect(Number(row?.amount)).toBe(7.53)
    expect(Number(row?.tip)).toBe(0.75)
    expect(row?.approvalCode).toMatch(/^SIM-/)
    expect(row?.receiptId).toBeNull()
    const order = await db.order.findUnique({ where: { id: oid } })
    expect(order?.paymentStatus).toBe('partial')
    expect(order?.status).not.toBe('paid')
    const receipts = await db.receipt.findMany({ where: { orderId: oid } })
    expect(receipts).toHaveLength(0) // račun ŠELE ob zadnjem deležu
    const audit = await db.auditLog.findFirst({ where: { entityId: row?.id, action: 'PAY_LINK_SHARE_PAID' } })
    expect(audit?.userId).toBe(null)
    // javni GET na plačanem deležu: paid + receiptPending + paidShares
    const res2 = await publicPayGET(req(`/api/public/pay/${d.links[0].token}`, ''), { params: Promise.resolve({ token: d.links[0].token }) })
    const data2 = (await res2.json()) as { status: string; receiptPending: boolean; split: { paidShares: number; receiptPending: boolean } }
    expect(data2.status).toBe('paid')
    expect(data2.receiptPending).toBe(true)
    expect(data2.split.paidShares).toBe(1)
    // tip > delež → 400 (na drugem, še odprtem deležu)
    const bad = await publicPayPOST(req(`/api/public/pay/${d.links[1].token}`, '', 'POST', { tip: 8 }), { params: Promise.resolve({ token: d.links[1].token }) })
    expect(bad.status).toBe(400)
  })

  test('6. ZADNJI delež: končni račun prek FURS jedra — parts = deleži, tip = Σ, miza cleaning', async () => {
    const { id: oid, table } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { token: string }[] }
    await publicPayPOST(req(`/api/public/pay/${d.links[0].token}`, '', 'POST', { tip: 0.75 }), { params: Promise.resolve({ token: d.links[0].token }) })
    await publicPayPOST(req(`/api/public/pay/${d.links[1].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[1].token }) })
    const res = await publicPayPOST(req(`/api/public/pay/${d.links[2].token}`, '', 'POST', { tip: 0.5 }), { params: Promise.resolve({ token: d.links[2].token }) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { status: string; receipt: { receiptNumber: string; eor: string | null; total: number; tip: number; totalWithTip: number; paymentMethod: string }; replayed: boolean }
    expect(data.status).toBe('paid')
    expect(data.receipt.eor).toMatch(UUID_RE)
    expect(data.receipt.total).toBe(22.57)
    expect(data.receipt.tip).toBe(1.25) // 0,75 + 0 + 0,50
    expect(data.receipt.totalWithTip).toBe(23.82)
    expect(data.receipt.paymentMethod).toBe('mixed') // 3 kartični deli

    const order = await db.order.findUnique({ where: { id: oid } })
    expect(order?.status).toBe('paid')
    expect(order?.paymentStatus).toBe('paid')
    const tableNum = Number(table.replace('Miza ', ''))
    const tbl = await db.table.findFirst({ where: { number: tableNum, locationId: locA } })
    expect(tbl?.status).toBe('cleaning')

    // Payment vrstice: 3 deli (vsak s svojo odobritvijo SIM-)
    const check = await db.check.findFirst({ where: { orderId: oid } })
    const payments = await db.payment.findMany({ where: { checkId: check?.id } })
    expect(payments).toHaveLength(3)
    expect(payments.every((p) => p.type === 'card' && p.authorizationCode?.startsWith('SIM-'))).toBe(true)
    expect(payments.reduce((s, p) => s + Number(p.amount), 0)).toBeCloseTo(22.57, 2)
    // idempotenca: plkset:<orderId>
    expect(payments.some((p) => p.idempotencyKey?.startsWith(`plkset:${oid}`))).toBe(true)
    // VSI linki niza: paid + receiptId zapisan
    const rows = await db.payLink.findMany({ where: { orderId: oid } })
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.status === 'paid' && row.receiptId != null)).toBe(true)
    // dvojni klik zadnjega → 409
    const again = await publicPayPOST(req(`/api/public/pay/${d.links[2].token}`, '', 'POST', { tip: 0 }), { params: Promise.resolve({ token: d.links[2].token }) })
    expect(again.status).toBe(409)
  })

  test('7. POS zaključek preostanka: 2 deleža pobrana, POS plača preostanek → en račun (deli + povezave)', async () => {
    const { id: oid } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { token: string }[] }
    await publicPayPOST(req(`/api/public/pay/${d.links[0].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[0].token }) })
    await publicPayPOST(req(`/api/public/pay/${d.links[1].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[1].token }) })
    // POS: gost 3 odšel brez plačila — osebje pritisne GOTOVINA (klasična pot
    // brez parts): jedro samodejno plača SAMO PREOSTANEK 7,52 € (Toast-style
    // odprti balance — pobrani deleži se prištejejo med dele)
    const pos = await fursPOST(req('/api/furs', tokenWaiterA, 'POST', {
      orderId: oid, type: 'cash', tip: 0,
      clientOperationId: `${PREFIX}-pos2-${TS}-${oid.slice(-4)}`,
    }))
    expect(pos.status).toBe(201)
    const order = await db.order.findUnique({ where: { id: oid } })
    expect(order?.paymentStatus).toBe('paid')
    const receipt = await db.receipt.findFirst({ where: { orderId: oid } })
    expect(Number(receipt?.total)).toBe(22.57)
    expect(receipt?.paymentMethod).toBe('mixed') // cash 7,52 + 2 kartična deleža
    // EKSPlicitni parts z napačno vsoto (staff ročno vpiše CELOTO 22,57 namesto
    // preostanka) → 400 z namigom o pobranih deležih (fail-closed, jasno sporočilo)
    const { id: oid2 } = await mkOrder()
    const r2 = await paylinkPOST(req(`/api/orders/${oid2}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid2 }) })
    const d2 = (await r2.json()) as { links: { token: string }[] }
    await publicPayPOST(req(`/api/public/pay/${d2.links[0].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d2.links[0].token }) })
    const tooMuch = await fursPOST(req('/api/furs', tokenWaiterA, 'POST', { orderId: oid2, parts: [{ type: 'cash', amount: 22.57 }], clientOperationId: `${PREFIX}-pos3-${TS}-${oid2.slice(-4)}` }))
    expect(tooMuch.status).toBe(400)
    const tm = (await tooMuch.json()) as { error: string }
    expect(tm.error).toContain('prek plačilnih povezav')
  })

  test('8. račun se spremeni (postavka dodana po izdaji) → 409 pred pobiranjem denarja', async () => {
    const { id: oid } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 2 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { token: string }[] }
    await publicPayPOST(req(`/api/public/pay/${d.links[0].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[0].token }) })
    // kuhar doda postavko (račun zrase nad Σ deležev)
    await db.orderItem.create({ data: { id: nid(), orderId: oid, menuItemId: item5, quantity: 2, price: 5, vatRate: 22, vatAmount: 2.02, menuItemName: 'Dodano' } })
    const res = await publicPayPOST(req(`/api/public/pay/${d.links[1].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[1].token }) })
    expect(res.status).toBe(409)
    const data = (await res.json()) as { error: string }
    expect(data.error).toContain('Račun se je spremenil')
    // denar NI pobran (link ostane open)
    const row = await db.payLink.findUnique({ where: { token: d.links[1].token } })
    expect(row?.status).toBe('open')
  })

  test('9. neenakomeren split: amounts validacija (vsota = preostanek)', async () => {
    const { id: oid } = await mkOrder()
    const bad = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { amounts: [30, 1] }), { params: Promise.resolve({ id: oid }) })
    expect(bad.status).toBe(400)
    const good = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { amounts: [20, 2.57] }), { params: Promise.resolve({ id: oid }) })
    expect(good.status).toBe(201)
    const data = (await good.json()) as { links: { amount: number }[] }
    expect(data.links.map((l) => l.amount)).toEqual([20, 2.57])
    // splitCount > 10 → 400
    const { id: oid2 } = await mkOrder()
    const tooMany = await paylinkPOST(req(`/api/orders/${oid2}/paylink`, tokenWaiterA, 'POST', { splitCount: 11 }), { params: Promise.resolve({ id: oid2 }) })
    expect(tooMany.status).toBe(400)
  })

  test('10. revokacija: DELETE prekliče VSE odprte (plačanih ne)', async () => {
    const { id: oid } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { token: string }[] }
    await publicPayPOST(req(`/api/public/pay/${d.links[0].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[0].token }) })
    const del = await paylinkDELETE(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'DELETE'), { params: Promise.resolve({ id: oid }) })
    expect(del.status).toBe(200)
    const rows = await db.payLink.findMany({ where: { orderId: oid } })
    expect(rows.filter((row) => row.status === 'revoked')).toHaveLength(2)
    expect(rows.filter((row) => row.status === 'paid')).toHaveLength(1)
  })

  test('11. reissue na partial naročilu: nove povezave nad PREOSTANEK', async () => {
    const { id: oid } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 3 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { token: string }[] }
    await publicPayPOST(req(`/api/public/pay/${d.links[0].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[0].token }) }) // 7,53 plačano
    // gost 2 odšel: staff prekliče preostali 2, izda nov split 2 nad preostanek 15,04
    await paylinkDELETE(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'DELETE'), { params: Promise.resolve({ id: oid }) })
    const r2 = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 2 }), { params: Promise.resolve({ id: oid }) })
    expect(r2.status).toBe(201)
    const d2 = (await r2.json()) as { links: { amount: number; splitIndex: number; splitCount: number }[] }
    // 15,04 = 1504 cent / 2 → 752, 752
    expect(d2.links.map((l) => l.amount)).toEqual([7.52, 7.52])
    expect(d2.links[0].splitCount).toBe(2)
    // plačilo obeh novih + stari delež = 22,57 → končni račun
    await publicPayPOST(req(`/api/public/pay/${d2.links[0].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d2.links[0].token }) })
    const res = await publicPayPOST(req(`/api/public/pay/${d2.links[1].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d2.links[1].token }) })
    expect(res.status).toBe(200)
    const order = await db.order.findUnique({ where: { id: oid } })
    expect(order?.paymentStatus).toBe('paid')
    const receipt = await db.receipt.findFirst({ where: { orderId: oid } })
    expect(Number(receipt?.total)).toBe(22.57)
  })

  test('12. GET obnova: zadnji delež plačan v konkurenci (brez zaključka) → GET dokonča niz', async () => {
    const { id: oid } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 2 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { token: string }[] }
    await publicPayPOST(req(`/api/public/pay/${d.links[0].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[0].token }) })
    await publicPayPOST(req(`/api/public/pay/${d.links[1].token}`, '', 'POST', {}), { params: Promise.resolve({ token: d.links[1].token }) })
    // oba deleža plačana → račun obstaja prek obnove GET (recovery pot)
    const res = await publicPayGET(req(`/api/public/pay/${d.links[0].token}`, ''), { params: Promise.resolve({ token: d.links[0].token }) })
    const data = (await res.json()) as { status: string; receipt: { total: number } | null }
    expect(data.status).toBe('paid')
    expect(data.receipt?.total).toBe(22.57)
    const order = await db.order.findUnique({ where: { id: oid } })
    expect(order?.paymentStatus).toBe('paid')
  })

  test('13. SMS ponovno pošiljanje na posamezni povezavi (brez rotacije žetonov)', async () => {
    const { id: oid } = await mkOrder()
    const r = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { splitCount: 2 }), { params: Promise.resolve({ id: oid }) })
    const d = (await r.json()) as { links: { id: string; token: string }[] }
    const res = await paylinkPOST(req(`/api/orders/${oid}/paylink`, tokenWaiterA, 'POST', { sms: [{ linkId: d.links[1].id, phone: '+38640999888' }] }), { params: Promise.resolve({ id: oid }) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { links: { token: string }[]; existing: boolean; smsResults: { linkId: string; sms: { sent: boolean; detail: string } }[] }
    expect(data.existing).toBe(true)
    expect(data.links.map((l) => l.token)).toEqual(d.links.map((l) => l.token)) // ŽETONI SE NE ROTIRAJO
    expect(data.smsResults).toHaveLength(1)
    expect(data.smsResults[0].sms.sent).toBe(false) // SMS ni konfiguriran (fail-soft)
    expect(data.smsResults[0].sms.detail).toContain('SMS ni konfiguriran')
    const row = await db.payLink.findUnique({ where: { token: d.links[1].token } })
    expect(row?.phone).toBe('+38640999888')
  })
})

describe('paylink — P1-6 migracija paylink-split (DDL korak)', () => {
  test('401 brez žetona, 403 waiter (ni centralen), owner → alreadyApplied (SQLite ima stolpce)', async () => {
    expect((await migratePaylinkSplitPOST(req('/api/admin/migrate-paylink-split', '', 'POST', {}))).status).toBe(401)
    expect((await migratePaylinkSplitPOST(req('/api/admin/migrate-paylink-split', tokenWaiterA, 'POST', {}))).status).toBe(403)
    const res = await migratePaylinkSplitPOST(req('/api/admin/migrate-paylink-split', tokenOwnerA, 'POST', {}))
    expect(res.status).toBe(200)
    const data = (await res.json()) as { alreadyApplied: boolean }
    expect(data.alreadyApplied).toBe(true) // dev SQLite: db push ima stolpce
    expect(await payLinkReady()).toBe(true)
  })
})
