/**
 * v1.163.0 — IntegrationLog ne sme hraniti osebnih podatkov gosta.
 *
 * Najdba: dostavni webhook je ob napaki preslikave (422) in ob izjemi pri
 * ustvarjanju naročila v `IntegrationLog.requestData` zapisal CEL surov payload
 * platforme — ime, telefon, naslov, mesto, poštno številko in dostavna navodila
 * gosta. Dnevnik integracij je operativna diagnostika, ne arhiv osebnih
 * podatkov; obdelava PII je dovoljena samo tam, kjer je poslovno potrebna
 * (naročilo/DeliveryInfo), ne pa v trajni, neomejeno hranjeni log vrstici.
 *
 * Pogodba:
 *  - napaka preslikave in napaka ustvarjanja zapišeta SAMO operativni povzetek
 *    (platforma, platformski ID naročila, število preslikanih/nepreslikanih
 *    artiklov) — nobenega imena, telefona, naslova ali opomb gosta;
 *  - uspešna pot ostane povzetek (platformski ID), brez PII;
 *  - statusCode/errorMessage ostaneta, ker sta nosilca diagnoze.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { createHmac } from 'crypto'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { employeePinFields } from '../src/lib/auth'
import { POST as scopedPOST } from '../src/app/api/delivery/webhook/[provider]/[integration]/route'

const P = 'v163-'
const RUN = Date.now().toString(36)
const SECRET = `${P}secret-${RUN}`

let locId = ''
let intId = ''
let itemId = ''
let hiddenId = ''

const PII = {
  name: `${P}Ana Novaković`,
  phone: '+38640999163',
  address: `${P}Skrivna ulica 7`,
  city: `${P}Tajno mesto`,
  postCode: '9163',
  details: `${P}ne zvoniti, pusti pri vratih`,
}

let seq = 0

function signedReq(payload: unknown): NextRequest {
  const raw = JSON.stringify(payload)
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')
  const url = `http://localhost:3000/api/delivery/webhook/wolt/${intId}`
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': sig,
      'x-forwarded-for': `10.163.${Date.now() % 250}.${Math.floor(Math.random() * 250)}`,
    },
    body: raw,
  })
}

function call(payload: unknown) {
  return scopedPOST(signedReq(payload), { params: Promise.resolve({ provider: 'wolt', integration: intId }) })
}

function woltPayload(platformOrderId: string, items: unknown[]): Record<string, unknown> {
  return {
    order: {
      id: platformOrderId,
      customer: { name: PII.name, phone: PII.phone },
      delivery: { address: PII.address, city: PII.city, post_code: PII.postCode, details: PII.details },
      items,
    },
  }
}

async function logsFor(plat: string) {
  return db.integrationLog.findMany({
    where: { integrationId: intId, action: 'order.create', requestData: { contains: plat } },
    select: { status: true, statusCode: true, errorMessage: true, requestData: true },
  })
}

function jsonOf(requestData: unknown): Record<string, unknown> {
  return JSON.parse(String(requestData)) as Record<string, unknown>
}

function expectNoGuestPii(text: string): void {
  for (const [field, marker] of Object.entries(PII)) {
    expect(`${field}: ${text}`).not.toContain(marker)
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

beforeAll(async () => {
  await cleanup()

  locId = `${P}loc-${RUN}`
  await db.location.create({
    data: { id: locId, name: `${P}Lokacija`, code: `V163-${RUN.toUpperCase()}`, premisesId: `${P}prem-${RUN}` },
  })

  const menu = await db.menu.create({ data: { id: `${P}menu-${RUN}`, name: `${P}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${P}cat-${RUN}`, name: `${P}Jedi`, menuId: menu.id, sortOrder: 1 } })

  itemId = `${P}mi-${RUN}`
  await db.menuItem.create({
    data: { id: itemId, name: `${P}Pica`, price: 10, categoryId: cat.id, isAvailable: true, sortOrder: 1 },
  })
  hiddenId = `${P}mi-hidden-${RUN}`
  await db.menuItem.create({
    data: { id: hiddenId, name: `${P}Skrita jed`, price: 8, categoryId: cat.id, isAvailable: false, sortOrder: 2 },
  })

  const f = employeePinFields(String(Date.now()).slice(-6), `${P}admin@test.local`)
  await db.employee.create({
    data: {
      id: `${P}admin-${RUN}`, name: `${P}Admin`, email: `${P}admin@test.local`,
      role: 'admin', status: 'active', sessionVersion: 0, locationId: locId,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })

  intId = `${P}int-${RUN}`
  await db.integration.create({
    data: {
      id: intId, name: `${P}Wolt`, type: 'delivery', provider: 'wolt',
      locationId: locId, isActive: true, apiSecret: SECRET,
    },
  })
})

afterAll(async () => {
  await cleanup()
})

describe('v1.163.0 — IntegrationLog brez PII gosta', () => {
  it('zavrnjena preslikava (422): operativni povzetek, brez imena/telefona/naslova/opomb', async () => {
    seq++
    const plat = `${P}mapping-${seq}-${RUN}`
    const res = await call(woltPayload(plat, [{ name: `${P}Neznan artikel`, quantity: 1 }]))
    expect(res.status).toBe(422)

    const rows = await logsFor(plat)
    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row.statusCode).toBe(422)
    expect(row.errorMessage).toContain('preslikati')
    expectNoGuestPii(String(row.requestData))
    expectNoGuestPii(row.errorMessage)

    const data = jsonOf(row.requestData)
    expect(data.provider).toBe('wolt')
    expect(data.platformOrderId).toBe(plat)
    expect(data.items).toBe(0)
    expect(data.unmapped).toBe(1)
  })

  it('izjema pri ustvarjanju naročila: operativni povzetek, brez PII', async () => {
    seq++
    const plat = `${P}throw-${seq}-${RUN}`
    // Artikel se preslika po ID-ju (mapiranje ne gleda na razpoložljivost),
    // createOrderCore pa ga zavrne → catch veja webhooka.
    const res = await call(woltPayload(plat, [{ menuItemId: hiddenId, quantity: 1 }]))
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error?: string }).error).toContain('Artikli ne obstajajo')

    const rows = await logsFor(plat)
    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row.statusCode).toBe(422)
    expect(row.errorMessage).toContain('Artikli ne obstajajo')
    expectNoGuestPii(String(row.requestData))
    expectNoGuestPii(row.errorMessage)

    const data = jsonOf(row.requestData)
    expect(data.provider).toBe('wolt')
    expect(data.platformOrderId).toBe(plat)
    expect(data.items).toBe(1)
    expect(data.unmapped).toBe(0)
  })

  it('uspešno naročilo: dnevnik ostane povzetek s platformskim ID-jem, brez PII', async () => {
    seq++
    const plat = `${P}ok-${seq}-${RUN}`
    const res = await call(woltPayload(plat, [{ menuItemId: itemId, quantity: 2 }]))
    expect(res.status).toBe(200)

    const rows = await logsFor(plat)
    expect(rows.length).toBe(1)
    expect(rows[0].statusCode).toBe(200)
    expectNoGuestPii(String(rows[0].requestData))
    expect(jsonOf(rows[0].requestData).platformOrderId).toBe(plat)
  })
})
