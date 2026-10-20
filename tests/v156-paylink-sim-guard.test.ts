/**
 * v1.156.0 — javna plačilna povezava: strežniška meja SIMULATORJA.
 *
 * PROBLEM: `resolvePayProvider` vrne simulator, kadar ni Stripe konfiguracije —
 * tudi v produkciji. Javni POST je nato brez vsakega pravega plačila poklical
 * `simulatedCharge` (vedno odobreno, SIM- koda) in poravnal delež/naročilo. Meja
 * fiskalnega profila (issue #53) je obstajala, a je javna pot ni preverjala;
 * jedro FURS pa je deleže povezav prištevalo brez politike dokazovanja (issue #49).
 *
 * REŠITEV (dve plasti):
 *  1. javna ruta pred simulatorjem vpraša `payLinkSimulationAllowed` — dovoljeno
 *     SAMO v strežniško določenem simulacijskem/testnem profilu; sicer 503 brez
 *     kakršnegakoli finančnega učinka;
 *  2. jedro FURS zavrne SIM- delež povezave, ko simulacija ni aktivna (obramba
 *     pred vrsticami, poravnanimi pred to izdajo).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { payLinkSimulationAllowed } from '@/lib/paylink/core'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { nid } from '@/lib/map'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'
import { GET as billGET } from '../src/app/api/orders/[id]/bill/route'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { POST as paylinkPOST } from '../src/app/api/orders/[id]/paylink/route'
import { GET as publicPayGET, POST as publicPayPOST } from '../src/app/api/public/pay/[token]/route'

type Env = {
  FURS_ENVIRONMENT?: string
  FURS_ALLOW_SIMULATION?: string
  FURS_PRODUCTION_TEST_MODE?: string
  NODE_ENV?: string
}

describe('payLinkSimulationAllowed — strežniška fiskalna meja', () => {
  test('globalno produkcijsko okolje → simulator NI dovoljen (tudi ob Location=simulation)', () => {
    const env: Env = { FURS_ENVIRONMENT: 'production', NODE_ENV: 'test' }
    expect(payLinkSimulationAllowed('simulation', env)).toBe(false)
    expect(payLinkSimulationAllowed('test', env)).toBe(false)
  })

  test('globalna simulacija → simulator dovoljen', () => {
    expect(payLinkSimulationAllowed('simulation', { FURS_ENVIRONMENT: 'simulation', NODE_ENV: 'test' })).toBe(true)
  })

  test('brez konfiguracije v produkcijskem runtimeu → fail-closed (false)', () => {
    expect(payLinkSimulationAllowed(null, { NODE_ENV: 'production' })).toBe(false)
  })

  test('razvoj/testni runtime brez konfiguracije → simulacija dovoljena (obstoječe dev vedenje)', () => {
    expect(payLinkSimulationAllowed(null, { NODE_ENV: 'test' })).toBe(true)
  })

  test('izrecen FURS_PRODUCTION_TEST_MODE + simulation → dovoljen (lastnikova odločitev)', () => {
    expect(
      payLinkSimulationAllowed(null, {
        NODE_ENV: 'production',
        FURS_ENVIRONMENT: 'simulation',
        FURS_PRODUCTION_TEST_MODE: 'true',
      }),
    ).toBe(true)
  })

  test('neveljavna vrednost (typo) → fail-closed (false)', () => {
    expect(payLinkSimulationAllowed(null, { FURS_ENVIRONMENT: 'prod', NODE_ENV: 'production' })).toBe(false)
  })

  test('FURS_ALLOW_SIMULATION ne prisili simulatorja ob produkcijskem okolju', () => {
    expect(
      payLinkSimulationAllowed('simulation', {
        FURS_ENVIRONMENT: 'production',
        FURS_ALLOW_SIMULATION: 'true',
        NODE_ENV: 'production',
      }),
    ).toBe(false)
  })
})

// ── integracija: javna ruta + jedro FURS ──

const P = 'v156p-'
const TS = Date.now()
const PREV_FURS_ENV = process.env.FURS_ENVIRONMENT
const PREV_STRIPE_KEY = process.env.STRIPE_SECRET_KEY

let loc = ''
let waiter = ''
let tokenWaiter = ''
let item5 = ''
let item350 = ''
const TABLE_POOL: string[] = []
let tableCursor = 0
let orderSeq = 956001

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function mkOrder(): Promise<string> {
  const idx = tableCursor++ % TABLE_POOL.length
  const res = await ordersPOST(
    req('/api/orders', tokenWaiter, 'POST', {
      tableId: TABLE_POOL[idx],
      guests: 2,
      items: [
        { menuItemId: item5, qty: 3 },
        { menuItemId: item350, qty: 1 },
      ],
      clientOperationId: `${P}op-${TS}-${orderSeq++}`,
    }),
  )
  const data = (await res.json()) as { order?: { id: string }; id?: string }
  const id = data.order?.id || data.id || ''
  if (!id) throw new Error(`mkOrder failed: ${res.status}`)
  await firePOST(req(`/api/orders/${id}/fire`, tokenWaiter, 'POST', {}), { params: Promise.resolve({ id }) })
  return id
}

async function mkLink(orderId: string): Promise<{ token: string; id: string }> {
  const res = await paylinkPOST(req(`/api/orders/${orderId}/paylink`, tokenWaiter, 'POST', {}), {
    params: Promise.resolve({ id: orderId }),
  })
  const data = (await res.json()) as { link: { token: string; id: string } }
  if (!data.link?.token) throw new Error(`mkLink failed: ${res.status}`)
  return data.link
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  process.env.FURS_ENVIRONMENT = 'production'
  delete process.env.STRIPE_SECRET_KEY

  loc = (
    await db.location.create({
      data: {
        id: `${P}loc-${TS}`,
        name: `${P} Lokacija`,
        code: `${P}code-${TS}`,
        premisesId: `BLGV156P${TS}`,
        taxId: 'SI12345678',
        registerNumber: 'BLG-V156P-01',
        fursEnvironment: 'simulation',
        country: 'SI',
      },
    })
  ).id
  waiter = (
    await db.employee.create({
      data: { id: `${P}waiter-${TS}`, name: `${P} Natakar`, email: `${P}waiter-${TS}@test.local`, role: 'waiter', pin: `${P}pin-${TS}`, locationId: loc },
    })
  ).id
  tokenWaiter = createToken({ sub: waiter, name: `${P} Natakar`, role: 'WAITER', loc, sv: 0 })

  const menu = (await db.menu.create({ data: { id: `${P}menu-${TS}`, name: `${P} meni`, locationId: loc } })).id
  const cat = (await db.category.create({ data: { id: `${P}cat-${TS}`, name: `${P} kategorija`, menuId: menu } })).id
  item5 = (await db.menuItem.create({ data: { id: `${P}item5-${TS}`, name: `${P} Jedi 5`, price: 5, categoryId: cat, vatRate: 22 } })).id
  item350 = (await db.menuItem.create({ data: { id: `${P}item35-${TS}`, name: `${P} Prigrizek 3.5`, price: 3.5, categoryId: cat, vatRate: 22 } })).id
  for (let n = 61; n <= 68; n++) {
    TABLE_POOL.push((await db.table.create({ data: { id: `${P}table-${n}-${TS}`, number: n, capacity: 4, locationId: loc, status: 'available' } })).id)
  }
})

afterAll(async () => {
  if (PREV_FURS_ENV === undefined) delete process.env.FURS_ENVIRONMENT
  else process.env.FURS_ENVIRONMENT = PREV_FURS_ENV
  if (PREV_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = PREV_STRIPE_KEY
  await sweepTestFixtures(db, [P])
})

describe('produkcijski profil — javna plačilna povezava', () => {
  test('GET označi simulator kot nedovoljen; POST 503 BREZ finančnega učinka', async () => {
    const oid = await mkOrder()
    const link = await mkLink(oid)

    const getRes = await publicPayGET(req(`/api/public/pay/${link.token}`, ''), { params: Promise.resolve({ token: link.token }) })
    expect(getRes.status).toBe(200)
    const view = (await getRes.json()) as { status: string; provider: string; simulatorAllowed?: boolean }
    expect(view.status).toBe('open')
    expect(view.provider).toBe('simulator')
    expect(view.simulatorAllowed).toBe(false)

    const postRes = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 0 }), {
      params: Promise.resolve({ token: link.token }),
    })
    expect(postRes.status).toBe(503)
    const post = (await postRes.json()) as { error?: string }
    expect(post.error).toContain('ni na voljo')

    const linkRow = await db.payLink.findUnique({ where: { token: link.token } })
    expect(linkRow?.status).toBe('open')
    expect(linkRow?.receiptId).toBe(null)
    expect(linkRow?.approvalCode).toBe('')
    const order = await db.order.findUnique({ where: { id: oid } })
    expect(order?.paymentStatus).toBe('unpaid')
    expect(await db.payment.findFirst({ where: { idempotencyKey: `plkset:${oid}` } })).toBe(null)
    expect(await db.receipt.count({ where: { orderId: oid } })).toBe(0)
  })

  test('v simulacijskem profilu GET označi simulator kot dovoljen (polje ni trdo false)', async () => {
    process.env.FURS_ENVIRONMENT = 'simulation'
    try {
      const oid = await mkOrder()
      const link = await mkLink(oid)
      const res = await publicPayGET(req(`/api/public/pay/${link.token}`, ''), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(200)
      const view = (await res.json()) as { simulatorAllowed?: boolean }
      expect(view.simulatorAllowed).toBe(true)
    } finally {
      process.env.FURS_ENVIRONMENT = 'production'
    }
  })

  test('jedro FURS: SIM- delež povezave v produkciji → 402 (obramba pred starimi vrsticami)', async () => {
    const oid = await mkOrder()
    const link = await mkLink(oid)
    const billRes = await billGET(req(`/api/orders/${oid}/bill`, tokenWaiter), { params: Promise.resolve({ id: oid }) })
    const bill = (await billRes.json()) as { bill?: { totalDue?: number } }
    const total = Math.round(Number(bill.bill?.totalDue || 0) * 100) / 100
    expect(total).toBe(18.5)

    await db.payLink.update({
      where: { id: link.id },
      data: { status: 'paid', amount: total, tip: 0, approvalCode: 'SIM-LEGACY', paidAt: new Date() },
    })

    const res = await fursPOST(
      req('/api/furs', tokenWaiter, 'POST', {
        orderId: oid,
        parts: [],
        clientOperationId: `${P}furs-${TS}-${orderSeq++}`,
      }),
    )
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('simulacijskem')
    expect(await db.receipt.count({ where: { orderId: oid } })).toBe(0)
    const order = await db.order.findUnique({ where: { id: oid } })
    expect(order?.paymentStatus).toBe('unpaid')
  })
})
