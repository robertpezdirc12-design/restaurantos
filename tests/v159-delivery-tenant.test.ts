/**
 * v1.159.0 — dostavni webhook: enolična vezava na lokacijo + podpis per-integration.
 *
 * Najdbe (iz lastnega pregleda, nadaljevanje audita):
 *  - `getPlatformSecret` in ruta sta izbirala PRVO Integration vrstico providerja
 *    brez lokacije in brez determinističnega vrstnega reda. Ob dveh aktivnih
 *    integracijah iste platforme (dve lokaciji) je podpis lahko preverjal secret
 *    ene, naročilo pa vezalo na lokacijo DRUGE.
 *  - idempotencyKey `glovo:<platformOrderId>` ni vseboval lokacije: enak
 *    platformski ID dveh računov (dve lokaciji) je drugo naročilo zavrnil kot
 *    replay s tujim kontekstom.
 *  - preslikava artiklov je iskala po ID/jmenu v CELOTNI bazi, ne v meniju
 *    ciljne lokacije; enako ime na dveh lokacijah je izbralo poljuben artikel,
 *    naročilo pa je nato padlo na "Artikel ni na voljo na tej lokaciji".
 *
 * Pogodba:
 *  - nova pot /api/delivery/webhook/[provider]/[integration] veže zahtevo na
 *    TOČNO integracijo (id, provider, aktivna) in njen secret;
 *  - stara pot brez segmenta ostane, a z več aktivnimi integracijami zahteva
 *    ENOLIČNO ujemanje podpisa; 0 ujemanj → 401, 2+ → 409 (brez zapisa);
 *  - idempotenca je vezana na lokacijo (hash), stari ključi brez lokacije se
 *    še vedno prepoznajo za replay/preklic (varnost selitve);
 *  - imena/ID-ji artiklov se rešujejo znotraj menija ciljne lokacije.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { createHmac } from 'crypto'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { employeePinFields } from '../src/lib/auth'
import { webhookIdempotencyKey, legacyWebhookIdempotencyKey } from '../src/lib/delivery'
import { POST as legacyPOST } from '../src/app/api/delivery/webhook/[provider]/route'
import { POST as scopedPOST } from '../src/app/api/delivery/webhook/[provider]/[integration]/route'

const P = 'v159-'
const RUN = Date.now().toString(36)
const SECRET_A = `${P}secret-a-${RUN}`
const SECRET_B = `${P}secret-b-${RUN}`
const SECRET_SAME = `${P}secret-same-${RUN}`
const ITEM_NAME = `${P}Pica`

let locA = ''
let locB = ''
let itemA = ''
let itemB = ''
let intA = ''
let intB = ''

function ip(): string {
  return `10.159.${Date.now() % 250}.${Math.floor(Math.random() * 250)}`
}

function signedReq(provider: string, integration: string | null, payload: unknown, secret: string): NextRequest {
  const raw = JSON.stringify(payload)
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  const url = `http://localhost:3000/api/delivery/webhook/${provider}${integration ? `/${integration}` : ''}`
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sig, 'x-forwarded-for': ip() },
    body: raw,
  })
}

function callLegacy(payload: unknown, secret: string) {
  return legacyPOST(signedReq('wolt', null, payload, secret), { params: Promise.resolve({ provider: 'wolt' }) })
}

function callScoped(integration: string, payload: unknown, secret: string) {
  return scopedPOST(signedReq('wolt', integration, payload, secret), {
    params: Promise.resolve({ provider: 'wolt', integration }),
  })
}

function woltPayload(platformOrderId: string, items: unknown[]): Record<string, unknown> {
  return {
    order: {
      id: platformOrderId,
      customer: { name: `${P}Ana`, phone: '+38640123456' },
      delivery: { address: `${P}Ulica 1`, city: 'Ljubljana', post_code: '1000', details: '' },
      items,
    },
  }
}

async function cleanup(): Promise<void> {
  await db.auditLog.deleteMany({
    where: { OR: [{ entityId: { startsWith: P } }, { details: { contains: P } }] },
  }).catch(() => null)
  await db.eventLog.deleteMany({
    where: { OR: [{ entityId: { startsWith: P } }, { payload: { contains: P } }, { locationId: { startsWith: P } }] },
  }).catch(() => null)
  await db.counter.deleteMany({ where: { name: { startsWith: `order:${P}` } } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { Order: { locationId: { startsWith: P } } } }).catch(() => null)
  await db.deliveryInfo.deleteMany({ where: { Order: { locationId: { startsWith: P } } } }).catch(() => null)
  await db.order.deleteMany({ where: { locationId: { startsWith: P } } }).catch(() => null)
  await db.integrationLog.deleteMany({ where: { integrationId: { startsWith: P } } }).catch(() => null)
  await db.integration.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

async function orderByKey(key: string) {
  return db.order.findUnique({ where: { idempotencyKey: key }, select: { id: true, locationId: true } })
}

beforeAll(async () => {
  await cleanup()

  locA = `${P}loc-a-${RUN}`
  locB = `${P}loc-b-${RUN}`
  await db.location.create({ data: { id: locA, name: `${P}Lok A`, code: `V159A-${RUN.toUpperCase()}`, premisesId: `${P}prem-a-${RUN}` } })
  await db.location.create({ data: { id: locB, name: `${P}Lok B`, code: `V159B-${RUN.toUpperCase()}`, premisesId: `${P}prem-b-${RUN}` } })

  const menuA = await db.menu.create({ data: { id: `${P}menu-a-${RUN}`, name: `${P}Meni A`, locationId: locA } })
  const catA = await db.category.create({ data: { id: `${P}cat-a-${RUN}`, name: `${P}Jedi A`, menuId: menuA.id, sortOrder: 1 } })
  const menuB = await db.menu.create({ data: { id: `${P}menu-b-${RUN}`, name: `${P}Meni B`, locationId: locB } })
  const catB = await db.category.create({ data: { id: `${P}cat-b-${RUN}`, name: `${P}Jedi B`, menuId: menuB.id, sortOrder: 1 } })

  // ENAKO ime na obeh lokacijah — preslikava po imenu mora izbrati artikel CILJNE lokacije
  itemA = `${P}mi-a-${RUN}`
  itemB = `${P}mi-b-${RUN}`
  await db.menuItem.create({ data: { id: itemA, name: ITEM_NAME, price: 10, categoryId: catA.id, isAvailable: true, sortOrder: 1 } })
  await db.menuItem.create({ data: { id: itemB, name: ITEM_NAME, price: 12, categoryId: catB.id, isAvailable: true, sortOrder: 1 } })

  const f = employeePinFields(String(Date.now()).slice(-6), `${P}admin@test.local`)
  await db.employee.create({
    data: {
      id: `${P}admin-${RUN}`, name: `${P}Admin`, email: `${P}admin@test.local`,
      role: 'admin', status: 'active', sessionVersion: 0, locationId: locA,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })

  intA = `${P}int-a-${RUN}`
  intB = `${P}int-b-${RUN}`
  await db.integration.create({
    data: { id: intA, name: `${P}Wolt A`, type: 'delivery', provider: 'wolt', locationId: locA, isActive: true, apiSecret: SECRET_A },
  })
  await db.integration.create({
    data: { id: intB, name: `${P}Wolt B`, type: 'delivery', provider: 'wolt', locationId: locB, isActive: true, apiSecret: SECRET_B },
  })
})

afterAll(async () => {
  await cleanup()
})

describe('v1.159.0 — idempotenca je vezana na lokacijo', () => {
  it('isti platformski ID na dveh lokacijah → različna ključa, oba ≤64; brez lokacije ostane stari zapis', () => {
    const a = webhookIdempotencyKey('wolt', 'X-1', locA)
    const b = webhookIdempotencyKey('wolt', 'X-1', locB)
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(b.length).toBeLessThanOrEqual(64)
    expect(legacyWebhookIdempotencyKey('wolt', 'X-1')).toBe('wolt:X-1')
    expect(webhookIdempotencyKey('wolt', 'X-1')).toBe('wolt:X-1')
    expect(webhookIdempotencyKey('wolt', 'X-1', locA)).toBe(webhookIdempotencyKey('wolt', 'X-1', locA))
  })
})

describe('v1.159.0 — eksplicitna integracija veže naročilo na svojo lokacijo', () => {
  it('artikel z ID-jem TUJE lokacije + enakim imenom → artikel ciljne lokacije, naročilo na locB', async () => {
    const plat = `${P}explicit-${RUN}`
    const res = await callScoped(intB, woltPayload(plat, [{ menuItemId: itemA, name: ITEM_NAME, quantity: 2 }]), SECRET_B)
    const j = (await res.json()) as { received?: boolean; orderId?: string }
    expect(res.status).toBe(200)
    expect(j.received).toBe(true)

    const order = await db.order.findUnique({ where: { idempotencyKey: webhookIdempotencyKey('wolt', plat, locB) }, select: { id: true, locationId: true } })
    expect(order?.locationId).toBe(locB)
    expect(order?.id).toBe(j.orderId)
    const items = await db.orderItem.findMany({ where: { orderId: order!.id }, select: { menuItemId: true } })
    expect(items.map((i) => i.menuItemId)).toEqual([itemB])
  })

  it('podpis z secretom DRUGE integracije → 401, brez naročila', async () => {
    const plat = `${P}wrongsig-${RUN}`
    const res = await callScoped(intB, woltPayload(plat, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_A)
    expect(res.status).toBe(401)
    expect(await db.order.count({ where: { idempotencyKey: { contains: plat } } })).toBe(0)
  })

  it('neznana ali neaktivna integracija → 404', async () => {
    const rUnknown = await callScoped(`${P}ni-je-${RUN}`, woltPayload(`${P}unknown-${RUN}`, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_B)
    expect(rUnknown.status).toBe(404)

    await db.integration.update({ where: { id: intA }, data: { isActive: false } })
    try {
      const rInactive = await callScoped(intA, woltPayload(`${P}inactive-${RUN}`, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_A)
      expect(rInactive.status).toBe(404)
    } finally {
      await db.integration.update({ where: { id: intA }, data: { isActive: true } })
    }
  })
})

describe('v1.159.0 — stara pot z več integracijami', () => {
  it('podpis se ujema z NATANKO eno integracijo → naročilo na njeni lokaciji', async () => {
    const plat = `${P}legacy-route-${RUN}`
    const res = await callLegacy(woltPayload(plat, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_B)
    expect(res.status).toBe(200)
    const order = await orderByKey(webhookIdempotencyKey('wolt', plat, locB))
    expect(order?.locationId).toBe(locB)
  })

  it('isti secret na obeh integracijah → 409 (ni mogoče enolično usmeriti), brez zapisa; eksplicitna pot deluje', async () => {
    await db.integration.updateMany({ where: { id: { in: [intA, intB] } }, data: { apiSecret: SECRET_SAME } })
    const plat = `${P}ambiguous-${RUN}`
    try {
      const res = await callLegacy(woltPayload(plat, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_SAME)
      expect(res.status).toBe(409)
      expect(await db.order.count({ where: { idempotencyKey: { contains: plat } } })).toBe(0)
    } finally {
      await db.integration.update({ where: { id: intA }, data: { apiSecret: SECRET_A } })
      await db.integration.update({ where: { id: intB }, data: { apiSecret: SECRET_B } })
    }
    const resScoped = await callScoped(intB, woltPayload(plat, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_B)
    expect(resScoped.status).toBe(200)
    const order = await orderByKey(webhookIdempotencyKey('wolt', plat, locB))
    expect(order?.locationId).toBe(locB)
  })

  it('enak platformski ID prek dveh integracij → dve naročili, vsako na svoji lokaciji (brez replaya)', async () => {
    const plat = `${P}collide-${RUN}`
    const rA = await callScoped(intA, woltPayload(plat, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_A)
    const rB = await callScoped(intB, woltPayload(plat, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_B)
    expect(rA.status).toBe(200)
    expect(rB.status).toBe(200)

    const oA = await orderByKey(webhookIdempotencyKey('wolt', plat, locA))
    const oB = await orderByKey(webhookIdempotencyKey('wolt', plat, locB))
    expect(oA?.locationId).toBe(locA)
    expect(oB?.locationId).toBe(locB)
    expect(oA?.id).not.toBe(oB?.id)
    const iA = await db.orderItem.findMany({ where: { orderId: oA!.id }, select: { menuItemId: true } })
    const iB = await db.orderItem.findMany({ where: { orderId: oB!.id }, select: { menuItemId: true } })
    expect(iA.map((i) => i.menuItemId)).toEqual([itemA])
    expect(iB.map((i) => i.menuItemId)).toEqual([itemB])
  })

  it('naročilo s STARIM ključem (brez lokacije) → replay, brez dvojnika (varnost selitve)', async () => {
    const plat = `${P}migrate-${RUN}`
    const di = `${P}di-${plat}`
    await db.deliveryInfo.create({ data: { id: di, address: `${P}Ulica 1`, status: 'confirmed' } })
    await db.order.create({
      data: {
        id: `${P}order-${plat}`, locationId: locB, orderNumber: 9000 + Math.floor(Math.random() * 900),
        type: 'delivery', status: 'pending', total: 10, subtotal: 8.2, tax: 1.8,
        deliveryInfoId: di, idempotencyKey: legacyWebhookIdempotencyKey('wolt', plat), orderSource: 'delivery',
      },
    })
    const res = await callLegacy(woltPayload(plat, [{ name: ITEM_NAME, quantity: 1 }]), SECRET_B)
    const j = (await res.json()) as { received?: boolean; replayed?: boolean }
    expect(res.status).toBe(200)
    expect(j.replayed).toBe(true)
    expect(await db.order.count({ where: { locationId: locB, idempotencyKey: { contains: plat } } })).toBe(1)
  })
})
