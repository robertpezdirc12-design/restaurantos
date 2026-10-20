/**
 * v1.157.0 — Stripe: uskladitev PLAČANE seje brez vrnitve gosta.
 *
 * PROBLEM: poravnava je bila vezana izključno na gostovo vrnitev na povezavo
 * (POST { verifySession } ali ponovno odprtje). Če gost zapre zavihek takoj po
 * plačilu, Stripe denar zajame, naročilo pa ostane 'unpaid' — brez računa,
 * brez Payment vrstice in brez revizije. Iskanje webhooka/reconciliation je
 * potrdilo, da ju ni (najdba audita).
 *
 * REŠITEV:
 *  1. podpisani Stripe webhook (`checkout.session.*`) — podpis se preveri PRED
 *     branjem dogodka; poravna SAMO kanonično sejo, vezano na povezavo prek
 *     metadata (payLinkId/orderId/locationId/znesek/valuta/mode) — enaka
 *     pravila kot #37, nikoli tuja seja;
 *  2. dnevna uskladitev (`reconcilePaidStripeSessions`) kot varovalka, če
 *     webhook ni konfiguriran/dostavljen; poravna le plačane kanonične seje;
 *  3. oboje gre skozi ISTO jedro kot javni POST (CAS open → paid, kanonični
 *     FURS zaključek) — en finančni učinek tudi ob dvojni dostavi.
 *
 * Testi NE kličejo Stripe API: podpis se izračuna lokalno, seja pa je
 * konstruirana v dogodku; uskladitev dobi fetcher kot injekcijo.
 *
 * Fixture predpona: v157-.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { verifyStripeSignature } from '@/lib/paylink/stripe-webhook'
import { reconcilePaidStripeSessions } from '@/lib/paylink/reconcile'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'
import { POST as paylinkPOST } from '../src/app/api/orders/[id]/paylink/route'
import { POST as stripeWebhookPOST } from '../src/app/api/public/stripe/webhook/route'

const P = 'v157-'
const TS = Date.now()
const SECRET = 'whsec_v157_test_secret'
const PREV_WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const PREV_STRIPE_KEY = process.env.STRIPE_SECRET_KEY
const PREV_FURS_ENV = process.env.FURS_ENVIRONMENT

let loc = ''
let waiter = ''
let tokenWaiter = ''
let item5 = ''
let item350 = ''
const TABLE_POOL: string[] = []
let tableCursor = 0
let orderSeq = 957001

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

async function mkLink(orderId: string): Promise<{ id: string; token: string }> {
  const res = await paylinkPOST(req(`/api/orders/${orderId}/paylink`, tokenWaiter, 'POST', {}), {
    params: Promise.resolve({ id: orderId }),
  })
  const data = (await res.json()) as { link: { id: string; token: string } }
  if (!data.link?.token) throw new Error(`mkLink failed: ${res.status}`)
  return data.link
}

/** Povezava, kot bi jo zaključil checkout: znesek/napitnina + kanonična seja. */
async function mkStripeLink(opts: { sessionId?: string; tip?: number; expiresAt?: Date | null } = {}): Promise<{
  orderId: string
  id: string
  token: string
  sessionId: string
}> {
  const orderId = await mkOrder()
  const link = await mkLink(orderId)
  const sessionId = opts.sessionId ?? `cs_${P}${TS}_${orderSeq++}`
  await db.payLink.update({
    where: { id: link.id },
    data: { amount: 18.5, tip: opts.tip ?? 0, sessionId, ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) },
  })
  return { orderId, ...link, sessionId }
}

interface SessionInput {
  sessionId: string
  linkId: string
  orderId: string
  locationId: string
  amountCents: number
  paymentIntent?: string
  metadata?: Record<string, string>
  status?: string
  paymentStatus?: string
  amountTotal?: number | null
  currency?: string
  mode?: string
}

function paidSession(input: SessionInput): Record<string, unknown> {
  return {
    id: input.sessionId,
    object: 'checkout.session',
    status: input.status ?? 'complete',
    mode: input.mode ?? 'payment',
    payment_status: input.paymentStatus ?? 'paid',
    payment_intent: input.paymentIntent ?? `pi_${P}${TS}`,
    amount_total: input.amountTotal === undefined ? input.amountCents : input.amountTotal,
    currency: input.currency ?? 'eur',
    client_reference_id: input.linkId,
    metadata: {
      payLinkId: input.linkId,
      orderId: input.orderId,
      locationId: input.locationId,
      expectedAmountCents: String(input.amountCents),
      currency: 'eur',
      ...(input.metadata ?? {}),
    },
  }
}

function eventRaw(session: Record<string, unknown>, type = 'checkout.session.completed'): string {
  return JSON.stringify({ id: `evt_${P}${TS}_${orderSeq++}`, object: 'event', type, data: { object: session } })
}

function signRaw(raw: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex')
  return `t=${t},v1=${sig}`
}

function whReq(raw: string, signature: string | null): NextRequest {
  return new NextRequest('http://localhost:3000/api/public/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
    body: raw,
  })
}

function sessionView(session: Record<string, unknown>): {
  id: string | null
  paid: boolean
  paymentIntent: string | null
  amountTotalCents: number | null
  currency: string | null
  sessionStatus: string | null
  mode: string | null
  metadata: Record<string, string> | null
  clientReferenceId: string | null
} {
  return {
    id: String(session.id || '') || null,
    paid: session.payment_status === 'paid',
    paymentIntent: (session.payment_intent as string) || null,
    amountTotalCents: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: (session.currency as string) || null,
    sessionStatus: (session.status as string) || null,
    mode: (session.mode as string) || null,
    metadata: (session.metadata as Record<string, string>) || null,
    clientReferenceId: (session.client_reference_id as string) || null,
  }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  process.env.FURS_ENVIRONMENT = 'simulation'
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  delete process.env.STRIPE_SECRET_KEY

  loc = (
    await db.location.create({
      data: {
        id: `${P}loc-${TS}`,
        name: `${P} Lokacija`,
        code: `${P}code-${TS}`,
        premisesId: `BLGV157${TS}`,
        taxId: 'SI12345678',
        registerNumber: 'BLG-V157-01',
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
  for (let n = 171; n <= 182; n++) {
    TABLE_POOL.push((await db.table.create({ data: { id: `${P}table-${n}-${TS}`, number: n, capacity: 4, locationId: loc, status: 'available' } })).id)
  }
})

afterAll(async () => {
  if (PREV_FURS_ENV === undefined) delete process.env.FURS_ENVIRONMENT
  else process.env.FURS_ENVIRONMENT = PREV_FURS_ENV
  if (PREV_WH_SECRET === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = PREV_WH_SECRET
  if (PREV_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = PREV_STRIPE_KEY
  await sweepTestFixtures(db, [P])
})

describe('verifyStripeSignature — podpis Stripe-Signature (pred branjem dogodka)', () => {
  const now = 1_700_000_000_000
  const t = Math.floor(now / 1000)
  const raw = '{"id":"evt_test"}'
  const good = `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`, 'utf8').digest('hex')}`

  test('veljaven podpis → true', () => {
    expect(verifyStripeSignature(raw, good, SECRET, { now })).toBe(true)
  })
  test('spremenjeno telo → false', () => {
    expect(verifyStripeSignature(raw + ' ', good, SECRET, { now })).toBe(false)
  })
  test('napačna skrivnost → false', () => {
    expect(verifyStripeSignature(raw, good, 'whsec_wrong', { now })).toBe(false)
  })
  test('prestar podpis (izven tolerance) → false', () => {
    expect(verifyStripeSignature(raw, good, SECRET, { now: now + 301_000 })).toBe(false)
  })
  test('podpis iz prihodnosti (izven tolerance) → false', () => {
    expect(verifyStripeSignature(raw, good, SECRET, { now: now - 301_000 })).toBe(false)
  })
  test('več v1 podpisov: zadostuje eden veljaven', () => {
    const header = `t=${t},v1=${'0'.repeat(64)},v1=${good.split('v1=')[1]}`
    expect(verifyStripeSignature(raw, header, SECRET, { now })).toBe(true)
  })
  test('manjkajoč/zlomljen header ali prazna skrivnost → false', () => {
    expect(verifyStripeSignature(raw, null, SECRET, { now })).toBe(false)
    expect(verifyStripeSignature(raw, 'garbage', SECRET, { now })).toBe(false)
    expect(verifyStripeSignature(raw, `t=${t}`, SECRET, { now })).toBe(false)
    expect(verifyStripeSignature(raw, good, '', { now })).toBe(false)
  })
})

describe('Stripe webhook — plačana seja brez vrnitve gosta', () => {
  test('kanonična plačana seja → poravnano (račun, naročilo, Payment, revizija)', async () => {
    const l = await mkStripeLink({ tip: 2.26 })
    const session = paidSession({
      sessionId: l.sessionId,
      linkId: l.id,
      orderId: l.orderId,
      locationId: loc,
      amountCents: 2076,
      paymentIntent: `pi_${P}ok_${TS}`,
    })
    const raw = eventRaw(session)
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { received: boolean; settled?: boolean }
    expect(body.received).toBe(true)
    expect(body.settled).toBe(true)

    const linkRow = await db.payLink.findUnique({ where: { id: l.id } })
    expect(linkRow?.status).toBe('paid')
    expect(linkRow?.receiptId).toBeTruthy()
    const order = await db.order.findUnique({ where: { id: l.orderId } })
    expect(order?.paymentStatus).toBe('paid')
    expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(1)
    const payment = await db.payment.findFirst({ where: { idempotencyKey: `plkset:${l.orderId}#p0` } })
    expect(payment?.authorizationCode).toBe(`pi_${P}ok_${TS}`)
    const audit = await db.auditLog.findFirst({ where: { action: 'PAY_LINK_PAID', entityId: l.id } })
    expect(audit?.details).toContain(`session=${l.sessionId.slice(0, 14)}`)
  })

  test('ponovljena dostava istega dogodka → EN finančni učinek', async () => {
    const l = await mkStripeLink()
    const session = paidSession({ sessionId: l.sessionId, linkId: l.id, orderId: l.orderId, locationId: loc, amountCents: 1850 })
    const raw = eventRaw(session)
    expect((await stripeWebhookPOST(whReq(raw, signRaw(raw)))).status).toBe(200)
    expect((await stripeWebhookPOST(whReq(raw, signRaw(raw)))).status).toBe(200)
    expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(1)
    expect(await db.payment.count({ where: { idempotencyKey: { startsWith: `plkset:${l.orderId}` } } })).toBe(1)
  })

  test('napačen podpis → 400, povezava ostane odprta', async () => {
    const l = await mkStripeLink()
    const raw = eventRaw(paidSession({ sessionId: l.sessionId, linkId: l.id, orderId: l.orderId, locationId: loc, amountCents: 1850 }))
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw, 'whsec_wrong')))
    expect(res.status).toBe(400)
    expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('open')
    expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(0)
  })

  test('brez STRIPE_WEBHOOK_SECRET → 503 (fail-closed, brez branja dogodka)', async () => {
    const l = await mkStripeLink()
    const raw = eventRaw(paidSession({ sessionId: l.sessionId, linkId: l.id, orderId: l.orderId, locationId: loc, amountCents: 1850 }))
    delete process.env.STRIPE_WEBHOOK_SECRET
    try {
      const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
      expect(res.status).toBe(503)
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = SECRET
    }
    expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('open')
  })

  test('tuja seja (ni kanonična) → 200 ignored + revizija, brez poravnave', async () => {
    const l = await mkStripeLink({ sessionId: `cs_${P}canon_${TS}` })
    const raw = eventRaw(
      paidSession({
        sessionId: `cs_${P}other_${TS}`,
        linkId: l.id,
        orderId: l.orderId,
        locationId: loc,
        amountCents: 1850,
        paymentIntent: `pi_${P}other_${TS}`,
      }),
    )
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ignored?: string; settled?: boolean }
    expect(body.ignored).toBe('unknown_session')
    expect(body.settled).toBe(false)
    expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('open')
    expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(0)
    expect(await db.auditLog.count({ where: { action: 'PAY_LINK_STRIPE_REVIEW', entityId: l.id } })).toBeGreaterThan(0)
  })

  test('znesek seje se ne ujema → 200 ignored amount, brez poravnave', async () => {
    const l = await mkStripeLink()
    const raw = eventRaw(
      paidSession({ sessionId: l.sessionId, linkId: l.id, orderId: l.orderId, locationId: loc, amountCents: 1850, amountTotal: 100 }),
    )
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
    const body = (await res.json()) as { ignored?: string }
    expect(res.status).toBe(200)
    expect(body.ignored).toBe('amount')
    expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('open')
    expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(0)
    expect(await db.auditLog.count({ where: { action: 'PAY_LINK_STRIPE_REVIEW', entityId: l.id } })).toBeGreaterThan(0)
  })

  test('vezava na tuje naročilo → ignored binding', async () => {
    const l = await mkStripeLink()
    const raw = eventRaw(
      paidSession({
        sessionId: l.sessionId,
        linkId: l.id,
        orderId: `${P}tuje-${TS}`,
        locationId: loc,
        amountCents: 1850,
      }),
    )
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ignored?: string }).ignored).toBe('binding')
    expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('open')
  })

  test('naročilo plačano drugje → ignored order_paid + povezava superseded', async () => {
    const l = await mkStripeLink()
    await db.order.update({ where: { id: l.orderId }, data: { paymentStatus: 'paid' } })
    const raw = eventRaw(paidSession({ sessionId: l.sessionId, linkId: l.id, orderId: l.orderId, locationId: loc, amountCents: 1850 }))
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ignored?: string }).ignored).toBe('order_paid')
    expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('superseded')
    expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(0)
  })

  test('potekla povezava s PLAČANO sejo → vseeno poravnano (denar je zajet)', async () => {
    const l = await mkStripeLink({ expiresAt: new Date(Date.now() - 60_000) })
    const raw = eventRaw(paidSession({ sessionId: l.sessionId, linkId: l.id, orderId: l.orderId, locationId: loc, amountCents: 1850 }))
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { settled?: boolean }).settled).toBe(true)
    expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('paid')
    expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(1)
  })

  test('neplačana seja → ignored not_paid (brez učinka)', async () => {
    const l = await mkStripeLink()
    const raw = eventRaw(
      paidSession({ sessionId: l.sessionId, linkId: l.id, orderId: l.orderId, locationId: loc, amountCents: 1850, paymentStatus: 'unpaid', status: 'open' }),
    )
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ignored?: string }).ignored).toBe('not_paid')
    expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('open')
  })

  test('drug tip dogodka → ignored event_type', async () => {
    const raw = JSON.stringify({ id: `evt_${P}other`, type: 'payment_intent.created', data: { object: { id: 'pi_x' } } })
    const res = await stripeWebhookPOST(whReq(raw, signRaw(raw)))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ignored?: string }).ignored).toBe('event_type')
  })

  test('deljeni deleži: prvi webhook → partial brez računa; zadnji → končni račun', async () => {
    const orderId = await mkOrder()
    const splitRes = await paylinkPOST(req(`/api/orders/${orderId}/paylink`, tokenWaiter, 'POST', { splitCount: 2 }), {
      params: Promise.resolve({ id: orderId }),
    })
    const split = (await splitRes.json()) as { links?: { id: string; token: string; amount: number }[] }
    expect(split.links?.length).toBe(2)
    const [first, second] = split.links!
    await db.payLink.update({ where: { id: first.id }, data: { tip: 0, sessionId: `cs_${P}split1_${TS}` } })
    await db.payLink.update({ where: { id: second.id }, data: { tip: 0, sessionId: `cs_${P}split2_${TS}` } })

    const raw1 = eventRaw(
      paidSession({ sessionId: `cs_${P}split1_${TS}`, linkId: first.id, orderId, locationId: loc, amountCents: 925 }),
    )
    expect(((await (await stripeWebhookPOST(whReq(raw1, signRaw(raw1)))).json()) as { settled?: boolean }).settled).toBe(true)
    expect((await db.order.findUnique({ where: { id: orderId } }))?.paymentStatus).toBe('partial')
    expect(await db.receipt.count({ where: { orderId } })).toBe(0)
    expect((await db.payLink.findUnique({ where: { id: first.id } }))?.status).toBe('paid')

    const raw2 = eventRaw(
      paidSession({ sessionId: `cs_${P}split2_${TS}`, linkId: second.id, orderId, locationId: loc, amountCents: 925 }),
    )
    expect(((await (await stripeWebhookPOST(whReq(raw2, signRaw(raw2)))).json()) as { settled?: boolean }).settled).toBe(true)
    expect((await db.order.findUnique({ where: { id: orderId } }))?.paymentStatus).toBe('paid')
    expect(await db.receipt.count({ where: { orderId } })).toBe(1)
    const rows = await db.payLink.findMany({ where: { orderId } })
    expect(rows.every((r) => r.status === 'paid' && r.receiptId != null)).toBe(true)
  })
})

describe('reconcilePaidStripeSessions — dnevna varovalka brez webhooka', () => {
  test('plačana kanonična seja → poravnana brez webhooka; drugi tek je no-op', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_v157_reconcile'
    try {
      const l = await mkStripeLink()
      const paid = sessionView(
        paidSession({
          sessionId: l.sessionId,
          linkId: l.id,
          orderId: l.orderId,
          locationId: loc,
          amountCents: 1850,
          paymentIntent: `pi_${P}rec_${TS}`,
        }),
      )
      const summary = await reconcilePaidStripeSessions({
        locationId: loc,
        fetcher: async (_secret, sessionId) => (sessionId === l.sessionId ? paid : { ...paid, paid: false }),
      })
      expect(summary.settled).toBeGreaterThanOrEqual(1)
      expect((await db.payLink.findUnique({ where: { id: l.id } }))?.status).toBe('paid')
      expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(1)

      const again = await reconcilePaidStripeSessions({
        locationId: loc,
        fetcher: async () => paid,
      })
      expect(again.settled).toBe(0)
      expect(await db.receipt.count({ where: { orderId: l.orderId } })).toBe(1)
    } finally {
      delete process.env.STRIPE_SECRET_KEY
    }
  })

  test('neplačana seja in napaka API → brez poravnave, napaka se šteje', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_v157_reconcile'
    try {
      const unpaidLink = await mkStripeLink()
      const failingLink = await mkStripeLink()
      const unpaid = sessionView(
        paidSession({
          sessionId: unpaidLink.sessionId,
          linkId: unpaidLink.id,
          orderId: unpaidLink.orderId,
          locationId: loc,
          amountCents: 1850,
          paymentStatus: 'unpaid',
          status: 'open',
        }),
      )
      const summary = await reconcilePaidStripeSessions({
        locationId: loc,
        fetcher: async (_secret, sessionId) => {
          if (sessionId === failingLink.sessionId) throw new Error('Stripe 503')
          return unpaid
        },
      })
      expect(summary.errors).toBeGreaterThanOrEqual(1)
      expect(summary.settled).toBe(0)
      expect((await db.payLink.findUnique({ where: { id: unpaidLink.id } }))?.status).toBe('open')
      expect((await db.payLink.findUnique({ where: { id: failingLink.id } }))?.status).toBe('open')
      expect(await db.receipt.count({ where: { orderId: unpaidLink.orderId } })).toBe(0)
    } finally {
      delete process.env.STRIPE_SECRET_KEY
    }
  })

  test('cron/daily vsebuje korak paylinks (uskladitev plačanih sej)', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/cron/daily/route.ts'), 'utf8')
    expect(src).toContain('reconcilePaidStripeSessions')
    expect(src).toContain('steps.paylinks')
  })
})
