import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  portalPolicyOf,
  trackKeyOf,
  verifyTrackKey,
  openStateAt,
  newPortalToken,
  PORTAL_POLICY_DEFAULTS,
} from '../src/lib/web-portal'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { localDateKey, zonedDateParts } from '../src/lib/haccp-ops'
import { GET as publicGET, POST as publicPOST } from '../src/app/api/public/web-portal/route'
import { GET as statusGET } from '../src/app/api/public/web-portal/status/route'
import { GET as settingsGET, PUT as settingsPUT, DELETE as settingsDELETE } from '../src/app/api/web-portal/route'

/**
 * P1 #8 (v1.190.0) — LASTNI SPLETNI PORTAL ZA NAROČILA (/s/<token>).
 *
 * Tržna vrzel P1 #8 (docs/TRZNA-VRZELI-2026.md §4 #8, matrica »Lastni portal
 * za spletna naročila« ✗ proti Lightspeed/Toast/Square): QR meni/kiosk rešujeta
 * gosta NA lokaciji; manjkal je javni portal, kjer gost NAROČI prevzem/dostavo
 * od zunaj in naročilo prileti direktno v POS.
 *
 * Merila:
 *  Č1 čisti sloj (src/lib/web-portal.ts, brez IO): politika s clami,
 *     HMAC sledenja (determinizem + timing-safe), odprto/zaprto urnika
 *     (tedenska vrstica, odmor, posebni dan, prekoračitev polnoči, unknown).
 *  Č2 javni API: GET meni + politika (404 neznani token), POST skozi
 *     KANONIČNO jedro (createOrderCore, vir 'web'): 404/400/409 poti,
 *     cena iz DB, dostavnina iz politike LOKACIJE (client fee ignoriran),
 *     minimalni znesek, idempotenten replay, revizija brez PII, javno
 *     sledenje statusa (HMAC — napačen ključ = 404, tuj vir = 404).
 *  Č3 nastavitve osebja (/api/web-portal): 401/403, inicializacija + izdaja
 *     tokena, rotacija (stara povezava takoj mrtva, sledenje ostane),
 *     meje, vklop brez načina → 400, izklop, revizija.
 *  Č4 ožičenje: migracijska konzola, obe shemi, kartica v zavihku Nastavitve,
 *     gostovska stran /s, i18n pariteta SL/HR + EN pokritost web.store.*.
 *
 * ID-ji s predpono `v190wp-` (sweep beforeAll + afterAll).
 */

const PREFIX = 'v190wp-'
const RUN = Date.now().toString(36)

let locA = '' // polni portal (prevzem + dostava, dostavnina 2.50)
let locMin = '' // portal z minimalnim zneskom 25 € (samo prevzem)
let locClosed = '' // portal na posebnem dnevu zaprto
let locInit = '' // BREZ portala — inicializacijski test (Č3)
let adminToken = ''
let waiterToken = ''

let portalAToken = ''
let portalMinToken = ''
let portalClosedToken = ''

let itemAId = ''
let itemMinId = ''
let itemSoldOutId = ''

function pubReq(url: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, { method: 'GET' })
}
function postReq(url: string, body: unknown, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
}
function staffReq(url: string, token: string | null): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}
function staffPut(body: unknown, token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/web-portal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}
function staffDel(body: unknown, token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/web-portal', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

async function isErr(p: Promise<Response>, status: number): Promise<Response> {
  const res = await p
  expect(res.status).toBe(status)
  return res
}

const todayKey = () => localDateKey(zonedDateParts(new Date(), 'Europe/Ljubljana'))

async function seedMenu(locationId: string, tag: string) {
  const menu = await db.menu.create({
    data: { id: `${PREFIX}menu-${tag}-${RUN}`, name: `${PREFIX}Jedilnik ${tag}`, locationId },
  })
  const cat = await db.category.create({
    data: { id: `${PREFIX}cat-${tag}-${RUN}`, name: `${PREFIX}Jedi`, menuId: menu.id },
  })
  return cat.id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])

  locA = (await db.location.create({
    data: { id: `${PREFIX}locA-${RUN}`, name: `${PREFIX}Lokacija A`, code: `V190A-${RUN.toUpperCase()}` },
  })).id
  locMin = (await db.location.create({
    data: { id: `${PREFIX}locMin-${RUN}`, name: `${PREFIX}Lokacija Min`, code: `V190M-${RUN.toUpperCase()}` },
  })).id
  locClosed = (await db.location.create({
    data: { id: `${PREFIX}locZ-${RUN}`, name: `${PREFIX}Lokacija Zaprta`, code: `V190Z-${RUN.toUpperCase()}` },
  })).id
  locInit = (await db.location.create({
    data: { id: `${PREFIX}locI-${RUN}`, name: `${PREFIX}Lokacija Init`, code: `V190I-${RUN.toUpperCase()}` },
  })).id

  // osebje: admin (FULL — settings.manage) + natakar (standard — 403)
  const aFields = employeePinFields(`9${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: `${PREFIX}admin-${RUN}`, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`,
      role: 'admin', status: 'active', sessionVersion: 0, locationId: locA, ...aFields,
    },
  })
  adminToken = createToken({ sub: `${PREFIX}admin-${RUN}`, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locA, sv: 0 })

  const wFields = employeePinFields(`8${RUN.slice(-5)}`, `${PREFIX}waiter-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: `${PREFIX}waiter-${RUN}`, name: `${PREFIX}Natakar`, email: `${PREFIX}waiter-${RUN}@test.local`,
      role: 'WAITER', status: 'active', sessionVersion: 0, locationId: locA, ...wFields,
    },
  })
  waiterToken = createToken({ sub: `${PREFIX}waiter-${RUN}`, name: `${PREFIX}Natakar`, role: 'WAITER', loc: locA, sv: 0 })

  // meniji (locClosed jih ne potrebuje — zaprto se zavre PRED reševanjem artiklov)
  const catA = await seedMenu(locA, 'a')
  itemAId = (await db.menuItem.create({
    data: { id: `${PREFIX}it-a-${RUN}`, name: `${PREFIX}Pica`, price: 3.5, vatRate: 9.5, categoryId: catA },
  })).id
  itemSoldOutId = (await db.menuItem.create({
    data: { id: `${PREFIX}it-x-${RUN}`, name: `${PREFIX}Kolac (86)`, price: 2.0, vatRate: 9.5, categoryId: catA, isAvailable: false },
  })).id
  const catMin = await seedMenu(locMin, 'm')
  itemMinId = (await db.menuItem.create({
    data: { id: `${PREFIX}it-m-${RUN}`, name: `${PREFIX}Juha`, price: 3.5, vatRate: 9.5, categoryId: catMin },
  })).id

  // portali (direktno v DB — nastavitvena ruta je pokrita ločeno v Č3)
  portalAToken = newPortalToken()
  await db.webOrderPortal.create({
    data: {
      id: `${PREFIX}wp-a-${RUN}`, locationId: locA, token: portalAToken,
      enabled: true, pickupEnabled: true, deliveryEnabled: true,
      deliveryFee: 2.5, minOrder: 0, prepMinutes: 15, note: 'Prevzem ob stranskih vratih.', trackSecret: `ts-a-${RUN}-${'x'.repeat(40)}`,
    },
  })
  portalMinToken = newPortalToken()
  await db.webOrderPortal.create({
    data: {
      id: `${PREFIX}wp-m-${RUN}`, locationId: locMin, token: portalMinToken,
      enabled: true, pickupEnabled: true, deliveryEnabled: false, minOrder: 25, prepMinutes: 20, trackSecret: `ts-m-${RUN}-${'x'.repeat(40)}`,
    },
  })
  portalClosedToken = newPortalToken()
  await db.webOrderPortal.create({
    data: {
      id: `${PREFIX}wp-z-${RUN}`, locationId: locClosed, token: portalClosedToken,
      enabled: true, pickupEnabled: true, deliveryEnabled: false, trackSecret: `ts-z-${RUN}-${'x'.repeat(40)}`,
    },
  })
  // posebni dan: ZAPRTO (prevlada tedenski vrstici, ki je sploh ni)
  await db.specialOpeningDay.create({
    data: { id: `${PREFIX}sp-${RUN}`, date: todayKey(), isClosed: true, openTime: '', closeTime: '', locationId: locClosed },
  })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

/* ───────────────────────── Č1 — čisti sloj ───────────────────────── */

describe('Č1 — čisti sloj web-portal (brez IO)', () => {
  test('politika: clami meje (izven meje → varni privzeti, meje uveljavlja pisanje), note ≤ 300', () => {
    const p = portalPolicyOf({
      pickupEnabled: true, deliveryEnabled: false,
      deliveryFee: 999, minOrder: 5000, prepMinutes: 100000, note: 'x'.repeat(500),
    })
    // vzorec widgetPolicyOf: vrednost IZVEN meje → privzeta (meje uveljavlja PUT)
    expect(p.deliveryFee).toBe(0)
    expect(p.minOrder).toBe(0)
    expect(p.prepMinutes).toBe(PORTAL_POLICY_DEFAULTS.prepMinutes)
    expect(p.note.length).toBe(300)

    const inBounds = portalPolicyOf({
      pickupEnabled: false, deliveryEnabled: true,
      deliveryFee: 2.5, minOrder: 25, prepMinutes: 12, note: 'ok',
    })
    expect(inBounds.deliveryFee).toBe(2.5)
    expect(inBounds.minOrder).toBe(25)
    expect(inBounds.prepMinutes).toBe(12)
    expect(inBounds.pickupEnabled).toBe(false)
    expect(inBounds.deliveryEnabled).toBe(true)

    const junk = portalPolicyOf({
      pickupEnabled: 1, deliveryEnabled: 0,
      deliveryFee: Number.NaN, minOrder: -5, prepMinutes: Number.NaN, note: null as unknown as string,
    })
    expect(junk.prepMinutes).toBe(PORTAL_POLICY_DEFAULTS.prepMinutes)
    expect(junk.deliveryFee).toBe(0)
    expect(junk.minOrder).toBe(0)
    expect(junk.pickupEnabled).toBe(true)
    expect(junk.deliveryEnabled).toBe(false)
  })

  test('HMAC sledenja: determinističen, loči naročila, timing-safe preverba', () => {
    const secret = 'abc123'
    const k5 = trackKeyOf(secret, 5)
    expect(k5).toBe(trackKeyOf(secret, 5))
    expect(k5).not.toBe(trackKeyOf(secret, 6))
    expect(k5).toHaveLength(32)
    expect(verifyTrackKey(secret, 5, k5)).toBe(true)
    expect(verifyTrackKey(secret, 5, `${k5.slice(0, 31)}0`)).toBe(false)
    expect(verifyTrackKey(secret, 6, k5)).toBe(false)
    expect(verifyTrackKey('', 5, k5)).toBe(false) // brez skrivnosti NIKOLI ne skozi
    expect(verifyTrackKey(secret, 5, '')).toBe(false)
  })

  const ROW = (over: Partial<{ dayOfWeek: number; openTime: string; closeTime: string; breakStart: string; breakEnd: string; isClosed: boolean }> = {}) => ({
    dayOfWeek: 1, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false, ...over,
  })

  test('urnik: odprto okno, odmor, zaprt dan, neznan dan', () => {
    // ponedeljek 10:00 → odprto; 15:00 → odmor; 23:00 → zaprto
    expect(openStateAt([ROW()], [], { weekday: 1, minutes: 10 * 60, dateKey: '2026-03-02' })).toBe('open')
    expect(openStateAt([ROW({ breakStart: '14:00', breakEnd: '16:00' })], [], { weekday: 1, minutes: 15 * 60, dateKey: '2026-03-02' })).toBe('closed')
    expect(openStateAt([ROW()], [], { weekday: 1, minutes: 23 * 60, dateKey: '2026-03-02' })).toBe('closed')
    expect(openStateAt([ROW()], [], { weekday: 3, minutes: 10 * 60, dateKey: '2026-03-04' })).toBe('unknown')
    expect(openStateAt([ROW({ isClosed: true })], [], { weekday: 1, minutes: 10 * 60, dateKey: '2026-03-02' })).toBe('closed')
  })

  test('urnik: posebni dan prevlada; prekoračitev polnoči je odprta čez polnoč', () => {
    expect(openStateAt([ROW()], [{ date: '2026-03-02', isClosed: true, openTime: '', closeTime: '', note: '' }], { weekday: 1, minutes: 10 * 60, dateKey: '2026-03-02' })).toBe('closed')
    expect(openStateAt([ROW({ isClosed: true })], [{ date: '2026-03-02', isClosed: false, openTime: '10:00', closeTime: '12:00', note: '' }], { weekday: 1, minutes: 11 * 60, dateKey: '2026-03-02' })).toBe('open')
    // nočni bar: 20:00–02:00 → 23:00 odprto, 01:00 (šteje za prejšnji dan okna) odprto, 05:00 zaprto
    const night = [ROW({ openTime: '20:00', closeTime: '02:00' })]
    expect(openStateAt(night, [], { weekday: 1, minutes: 23 * 60, dateKey: '2026-03-02' })).toBe('open')
    expect(openStateAt(night, [], { weekday: 1, minutes: 1 * 60, dateKey: '2026-03-02' })).toBe('open')
    expect(openStateAt(night, [], { weekday: 1, minutes: 10 * 60, dateKey: '2026-03-02' })).toBe('closed')
  })
})

/* ───────────────────────── Č2 — javni API ───────────────────────── */

describe('Č2 — GET /api/public/web-portal (meni + politika)', () => {
  test('404 za neznani in izklopljeni token', async () => {
    await isErr(publicGET(pubReq(`/api/public/web-portal?token=${'a'.repeat(32)}`)), 404)
  })

  test('200: politika + meni iz ISTEGA DB kot POS; 86 artikel je vidno razprodan', async () => {
    const res = await publicGET(pubReq(`/api/public/web-portal?token=${portalAToken}`))
    expect(res.status).toBe(200)
    const d = await res.json() as Record<string, unknown> & { items: { id: string; isAvailable: boolean }[] }
    expect(d.restaurant).toContain('Lokacija A')
    expect(d.open).toBe(true) // brez urnika = unknown = NE blokiramo
    expect(d.pickupEnabled).toBe(true)
    expect(d.deliveryEnabled).toBe(true)
    expect(d.deliveryFee).toBe(2.5)
    expect(d.minOrder).toBe(0)
    expect(d.etaMinutes).toBe(15)
    expect(d.note).toContain('stranskih vratih')
    expect(d.items.some((i) => i.id === itemAId && i.isAvailable)).toBe(true)
    expect(d.items.find((i) => i.id === itemSoldOutId)?.isAvailable).toBe(false)
  })
})

describe('Č2 — POST /api/public/web-portal (naročilo v kanonično jedro)', () => {
  const baseBody = (over: Record<string, unknown>) => ({
    token: portalAToken,
    fulfillment: 'pickup',
    customerName: 'Micka',
    customerPhone: '040123456',
    clientOperationId: `v190-op-${RUN}-1`,
    items: [{ menuItemId: itemAId, qty: 2 }],
    ...over,
  })

  test('404: neznan token', async () => {
    await isErr(publicPOST(postReq('/api/public/web-portal', baseBody({ token: 'b'.repeat(32) }))), 404)
  })

  test('400: neznan način, izklopljena dostava, manjkajoči ključi in kontakt', async () => {
    await isErr(publicPOST(postReq('/api/public/web-portal', baseBody({ fulfillment: 'teleport' }))), 400)
    await isErr(publicPOST(postReq('/api/public/web-portal', { ...baseBody({ token: portalMinToken, fulfillment: 'delivery', address: 'Cesta 1' }) })), 400)
    await isErr(publicPOST(postReq('/api/public/web-portal', baseBody({ clientOperationId: 'kratko' }))), 400)
    await isErr(publicPOST(postReq('/api/public/web-portal', baseBody({ customerName: '' }))), 400)
    await isErr(publicPOST(postReq('/api/public/web-portal', baseBody({ customerPhone: '' }))), 400)
    await isErr(publicPOST(postReq('/api/public/web-portal', baseBody({ fulfillment: 'delivery' }))), 400) // dostava brez naslova
  })

  test('409: zaprto (posebni dan) — pošteno zavrnjeno PRED reševanjem artiklov', async () => {
    const res = await isErr(publicPOST(postReq('/api/public/web-portal', baseBody({ token: portalClosedToken, items: [] }))), 409)
    const d = await res.json() as { error: string }
    expect(d.error).toContain('zaprta')
  })

  test('400: artikel razprodan (86) — cena/inventar se reši iz DB', async () => {
    await isErr(publicPOST(postReq('/api/public/web-portal', baseBody({ items: [{ menuItemId: itemSoldOutId, qty: 1 }] }))), 400)
  })

  test('400: minimalni znesek (politika lokacije)', async () => {
    const res = await isErr(publicPOST(postReq('/api/public/web-portal', {
      token: portalMinToken, fulfillment: 'pickup', customerName: 'A', customerPhone: '040',
      clientOperationId: `v190-op-${RUN}-min`, items: [{ menuItemId: itemMinId, qty: 1 }],
    })), 400)
    const d = await res.json() as { error: string }
    expect(d.error).toContain('minimalnim zneskom')
  })

  test('prevzem: naročilo gre skozi createOrderCore (vir web, tip takeaway), cena iz DB, revizija brez PII', async () => {
    const res = await publicPOST(postReq('/api/public/web-portal', baseBody({})))
    expect(res.status).toBe(200)
    const d = await res.json() as { replayed: boolean; orderNumber: number; status: string; total: number; etaMinutes: number; track: { n: number; k: string } }
    expect(d.replayed).toBe(false)
    expect(d.status).toBe('prejeto')
    expect(d.total).toBe(7) // 2 × 3.50 iz DB
    expect(d.etaMinutes).toBe(15)
    expect(verifyTrackKey(`ts-a-${RUN}-${'x'.repeat(40)}`, d.orderNumber, d.track.k)).toBe(true)

    const order = await db.order.findFirst({ where: { orderSource: 'web', orderNumber: d.orderNumber, locationId: locA } })
    expect(order).not.toBeNull()
    expect(order!.type).toBe('takeaway')
    expect(order!.customerName).toBe('Micka')
    expect(order!.customerPhone).toBe('040123456')
    expect(order!.notes).toContain('Prevzem')
    expect(order!.deliveryInfoId).toBeNull()

    // revizija: vir + način, BREZ telefona (PII higiena)
    const audit = await db.auditLog.findFirst({ where: { action: 'GUEST_ORDER_CREATED', entityId: order!.id } })
    expect(audit).not.toBeNull()
    expect(audit!.details).toContain('vir=web')
    expect(audit!.details).toContain('prevzem')
    expect(audit!.details).not.toContain('040123456')
  })

  test('replay: isti clientOperationId vrne ISTO naročilo (brez dvojnika)', async () => {
    const res = await publicPOST(postReq('/api/public/web-portal', baseBody({})))
    expect(res.status).toBe(200)
    const d = await res.json() as { replayed: boolean; orderNumber: number }
    expect(d.replayed).toBe(true)
    const count = await db.order.count({ where: { orderSource: 'web', locationId: locA } })
    expect(count).toBe(1)
  })

  test('dostava: DeliveryInfo s pristojbino IZ POLITIKE (client fee 99 ignoriran), ETA +15', async () => {
    const res = await publicPOST(postReq('/api/public/web-portal', baseBody({
      clientOperationId: `v190-op-${RUN}-d1`,
      fulfillment: 'delivery',
      address: 'Slovenska 1',
      city: 'Ljubljana',
      postCode: '1000',
      instructions: 'Zvonec na dvorišče',
      deliveryFee: 99, // napadalec pošlje svojo ceno
      items: [{ menuItemId: itemAId, qty: 2 }],
    })))
    expect(res.status).toBe(200)
    const d = await res.json() as { orderNumber: number; total: number; etaMinutes: number }
    expect(d.etaMinutes).toBe(30) // prepMinutes 15 + dostava 15
    expect(d.total).toBe(9.5) // 7.00 + dostavnina 2.50 (NE 99)

    const order = await db.order.findFirst({ where: { orderSource: 'web', orderNumber: d.orderNumber, locationId: locA }, include: { DeliveryInfo: true } })
    expect(order!.type).toBe('delivery')
    expect(Number(order!.DeliveryInfo!.deliveryFee)).toBe(2.5)
    expect(order!.DeliveryInfo!.address).toBe('Slovenska 1')
    expect(order!.DeliveryInfo!.recipientPhone).toBe('040123456')
    expect(order!.DeliveryInfo!.status).toBe('pending')
    expect(order!.notes).toContain('Dostava')
  })
})

describe('Č2 — GET /api/public/web-portal/status (HMAC sledenje)', () => {
  test('404: neznani portal, manjkajoči parametri', async () => {
    await isErr(statusGET(pubReq(`/api/public/web-portal/status?token=${'c'.repeat(32)}&n=1&k=x`)), 404)
    await isErr(statusGET(pubReq(`/api/public/web-portal/status?token=${portalAToken}&n=1`)), 400)
  })

  test('200: veljaven trackKey → whitelist polj; napačen ključ → 404 (brez razkrivanja)', async () => {
    const order = await db.order.findFirst({ where: { orderSource: 'web', locationId: locA }, include: { OrderItem: true } })
    const secret = `ts-a-${RUN}-${'x'.repeat(40)}`
    const k = trackKeyOf(secret, order!.orderNumber)
    const res = await statusGET(pubReq(`/api/public/web-portal/status?token=${portalAToken}&n=${order!.orderNumber}&k=${k}`))
    expect(res.status).toBe(200)
    const d = await res.json() as { orderNumber: number; status: string; total: number; items: unknown[] }
    expect(d.orderNumber).toBe(order!.orderNumber)
    expect(d.status).toBe('prejeto')
    expect(d.total).toBe(7)
    expect(d.items.length).toBe(order!.OrderItem.length)

    await isErr(statusGET(pubReq(`/api/public/web-portal/status?token=${portalAToken}&n=${order!.orderNumber}&k=${'0'.repeat(32)}`)), 404)
  })

  test('obseg: NOTRANJE mizno naročilo ni sledljivo prek portala (samo vir web)', async () => {
    // dine-in naročilo na lokaciji A (isti orderNumber prostor) z VELJAVNIM HMAC ključem
    const dineIn = await db.order.create({
      data: {
        id: `${PREFIX}dine-${RUN}`, orderNumber: 99001, locationId: locA, type: 'dine-in',
        status: 'open', paymentStatus: 'unpaid', orderSource: 'pos', total: 5,
      },
    })
    const secret = `ts-a-${RUN}-${'x'.repeat(40)}`
    const k = trackKeyOf(secret, dineIn.orderNumber)
    await isErr(statusGET(pubReq(`/api/public/web-portal/status?token=${portalAToken}&n=${dineIn.orderNumber}&k=${k}`)), 404)
  })
})

/* ───────────────────────── Č3 — nastavitve osebja ───────────────────────── */

describe('Č3 — /api/web-portal (nastavitve, settings.manage)', () => {
  test('401 brez žetona, 403 natakar (brez settings.manage)', async () => {
    await isErr(settingsGET(staffReq(`/api/web-portal?locationId=${locA}`, null)), 401)
    await isErr(settingsGET(staffReq(`/api/web-portal?locationId=${locA}`, waiterToken)), 403)
    await isErr(settingsPUT(staffPut({ locationId: locA }, waiterToken)), 403)
  })

  test('inicializacija: PUT ustvari vrstico + izda token SAMO v odgovoru PUT', async () => {
    const get0 = await settingsGET(staffReq(`/api/web-portal?locationId=${locInit}`, adminToken))
    const g0 = await get0.json() as { portal: null; token?: string }
    expect(g0.portal).toBeNull()
    expect(g0.token).toBeUndefined()

    const put = await settingsPUT(staffPut({
      locationId: locInit, enabled: true, prepMinutes: 12, note: 'Test opomba',
    }, adminToken))
    expect(put.status).toBe(200)
    const d = await put.json() as { portal: { enabled: boolean; prepMinutes: number; note: string }; token?: string; publicUrl?: string }
    expect(d.portal.enabled).toBe(true)
    expect(d.portal.prepMinutes).toBe(12)
    expect(d.portal.note).toBe('Test opomba')
    expect(d.token).toBeTruthy()
    expect(d.publicUrl).toBe(`/s/${d.token}`)

    // GET razkrije token, ker je vklopljen
    const get = await settingsGET(staffReq(`/api/web-portal?locationId=${locInit}`, adminToken))
    const g = await get.json() as { portal: { enabled: boolean }; token?: string }
    expect(g.portal.enabled).toBe(true)
    expect(g.token).toBeTruthy()
  })

  test('meje: prepMinutes 2 → 400; vklop brez načina prevzema → 400', async () => {
    await isErr(settingsPUT(staffPut({ locationId: locInit, prepMinutes: 2 }, adminToken)), 400)
    await isErr(settingsPUT(staffPut({ locationId: locInit, pickupEnabled: false, deliveryEnabled: false }, adminToken)), 400)
  })

  test('rotacija: NOV token, stara javna povezava takoj mrtva (trackSecret ostane)', async () => {
    // izdaj lokaciji A nov token in preveri staro/novo povezavo
    const oldRow = await db.webOrderPortal.findUnique({ where: { locationId: locA } })
    const oldSecret = oldRow!.trackSecret

    const put = await settingsPUT(staffPut({ locationId: locA, rotateToken: true }, adminToken))
    expect(put.status).toBe(200)
    const d = await put.json() as { token: string }
    expect(d.token).not.toBe(portalAToken)

    await isErr(publicGET(pubReq(`/api/public/web-portal?token=${portalAToken}`)), 404)
    const fresh = await publicGET(pubReq(`/api/public/web-portal?token=${d.token}`))
    expect(fresh.status).toBe(200)

    // sledenje STAREGA naročila preživi rotacijo (isti trackSecret)
    const order = await db.order.findFirst({ where: { orderSource: 'web', locationId: locA } })
    const k = trackKeyOf(oldSecret, order!.orderNumber)
    const st = await statusGET(pubReq(`/api/public/web-portal/status?token=${d.token}&n=${order!.orderNumber}&k=${k}`))
    expect(st.status).toBe(200)
    portalAToken = d.token // nadaljnji testi uporabljajo veljavni token
  })

  test('izklop: DELETE → enabled false, javna povezava 404, revizijski zapisa', async () => {
    // najprej privzeto izklopljena lokacija C (v beforeAll je bila brez portala)
    const del = await settingsDELETE(staffDel({ locationId: locClosed }, adminToken))
    expect(del.status).toBe(200)
    const del2 = await settingsDELETE(staffDel({ locationId: locClosed }, adminToken))
    expect(del2.status).toBe(200) // idempotentno
    await isErr(publicGET(pubReq(`/api/public/web-portal?token=${portalClosedToken}`)), 404)

    const updated = await db.auditLog.findFirst({ where: { action: 'WEB_PORTAL_UPDATED', entityType: 'WebOrderPortal' } })
    expect(updated).not.toBeNull()
    const disabled = await db.auditLog.findFirst({ where: { action: 'WEB_PORTAL_DISABLED', entityType: 'WebOrderPortal' } })
    expect(disabled).not.toBeNull()
  })
})

/* ───────────────────────── Č4 — ožičenje + i18n ───────────────────────── */

describe('Č4 — migracijska konzola, shemi, kartica, stran, i18n', () => {
  test('migracija web-portal je registrirana v konzoli (probe + endpoint)', () => {
    const entry = SCHEMA_MIGRATIONS.find((m) => m.id === 'web-portal')
    expect(entry).toBeDefined()
    expect(entry!.descKey).toBe('mig.webPortal.desc')
    expect(entry!.endpoint).toBe('/api/admin/migrate-web-portal')
    const consoleSrc = readFileSync('src/app/api/admin/migrations/route.ts', 'utf8')
    expect(consoleSrc).toContain("'web-portal': webPortalPOST")
  })

  test('model WebOrderPortal je v OBEH shemah (Postgres + SQLite mirror)', () => {
    expect(readFileSync('prisma/schema.prisma', 'utf8')).toContain('model WebOrderPortal')
    expect(readFileSync('prisma/schema.sqlite.prisma', 'utf8')).toContain('model WebOrderPortal')
  })

  test('kartica je v zavihku Nastavitve (dashboard), izvožena iz dashboard-tabs', () => {
    const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')
    expect(page).toContain('<WebPortalCard />')
    const tabs = readFileSync('src/components/dashboard-tabs.tsx', 'utf8')
    expect(tabs).toContain("export { WebPortalCard } from './tabs/web-portal-card'")
  })

  test('gostovska stran /s/<token> kliče javni API in ohranja sledenje', () => {
    const page = readFileSync('src/app/s/[token]/page.tsx', 'utf8')
    expect(page).toContain('/api/public/web-portal')
    expect(page).toContain('ro_web_track_')
    expect(page).toContain('clientOperationId')
    // varovalka v178: kontejner ne sme imeti nestabilnih odvisnosti fetch zanke
    expect(page).not.toMatch(/useEffect\(\(\) => \{[^}]*\}, \[pageErr\]/)
  })

  test('i18n: web.* pariteta SL/HR; EN pokriva celoten web.store.* (gostovska površina)', async () => {
    const { sl } = await import('../src/lib/i18n/sl')
    const { hr } = await import('../src/lib/i18n/hr')
    const { en } = await import('../src/lib/i18n/en')
    const slWeb = Object.keys(sl).filter((k) => k.startsWith('web.')).sort()
    const hrWeb = Object.keys(hr).filter((k) => k.startsWith('web.')).sort()
    expect(slWeb.length).toBeGreaterThanOrEqual(60)
    expect(hrWeb).toEqual(slWeb)
    for (const k of slWeb) {
      expect(String(sl[k]).length).toBeGreaterThan(0)
      expect(String(hr[k]).length).toBeGreaterThan(0)
    }
    const slStore = slWeb.filter((k) => k.startsWith('web.store.'))
    expect(slStore.length).toBeGreaterThanOrEqual(45)
    for (const k of slStore) expect(en[k]).toBeTruthy()
    // EN_GUEST_PREFIXES vključuje web.store. (centralna uveljavljava pokritosti)
    const { EN_GUEST_PREFIXES } = await import('../src/lib/i18n')
    expect(EN_GUEST_PREFIXES).toContain('web.store.')
  })

  test('javne napake portala so preslikane v i18n (vzorec P1-5)', async () => {
    const { guestApiErrorKey } = await import('../src/components/guest-i18n')
    expect(guestApiErrorKey('Spletna povezava ni veljavna ali je portal izklopljen.')).toBe('web.store.linkInvalid')
    expect(guestApiErrorKey('Restavracija je trenutno zaprta — spletna naročila sprejemamo med odprtim.')).toBe('web.store.closedNow')
    expect(guestApiErrorKey('Košarica je pod minimalnim zneskom spletnega naročila.')).toBe('web.store.minOrder')
  })

  test('kanonično jedro: vir web nosi kontakt gosta (customerName/customerPhone)', async () => {
    const order = await db.order.findFirst({ where: { orderSource: 'web', locationId: locA, type: 'takeaway' } })
    expect(order!.customerName).toBe('Micka')
    expect(order!.customerPhone).toBe('040123456')
  })
})
