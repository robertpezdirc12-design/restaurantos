/**
 * Issue #9 (P2, v1.119.0) — sinhronizacija menija po kanalih (backend + testi).
 *
 * Pokrito (po dizajnu 9-design + pogodbi 9-backend):
 *  A. JAVNA RUTA GET /api/public/menu/availability?qr=|x-device-token:
 *     avtentikacija IDENTIČNA /api/public/menu (resolveQrToken 32-hex mizni
 *     žeton ALI kiosk DeviceRegistry + deviceAlive(['kiosk']) → locationId
 *     strežniško rešen); 401 brez obeh / slab QR / slab device; vsebina ≡
 *     loadPublicMenu items (id/isAvailable/price num()); ETag (sha256
 *     minimalnega payloada) + If-None-Match → 304 s praznim telesom;
 *     rate limit 60/min/IP (61. klic → 429); QR tuje lokacije → strežnik
 *     reši lokacijo IZ žetona (200, meni te lokacije, različen etag).
 *     OPOMBA: menu ruta za slab QR vrača 404 — ta ruta (lahek polling vir)
 *     po pogodbi vrača enotno 401 z ISTEM sporočilom.
 *  B. orderSource 'delivery': podpisan Glovo webhook (HMAC-SHA256 na raw
 *     bodyju, secret iz Integration.apiSecret) → 200 → naročilo v DB ima
 *     orderSource='delivery' (idempotencyKey `glovo:i9-…`); dvojnik istega
 *     platformOrderId → replay (ISTO naročilo, brez dvojnika) in vir ostane
 *     'delivery' (replay-context varovalka primerja tudi orderSource).
 *     ZAHTEVA: edina Integration vrstica s provider='glovo' je naša fiksatura
 *     (drugo stanje = tuj secret → 401/503) — teče na sveži bazi (ci-fresh).
 *  C. ADAPTER CONTRACT (src/lib/channel-sync.ts): register/getChannelAdapter
 *     ('mock' registriran, neznan key → null); syncAvailabilityToChannel z
 *     provider 'mock' → ok:true + Integration.lastSyncAt/lastSyncStatus='ok' +
 *     IntegrationLog outbound 'availability-push' + audit CHANNEL_SYNC_OK;
 *     provider 'nonexistent-provider' → BLOKIRANO (ok:false,
 *     blocked='no-adapter-registered', Integration.lastSyncStatus='blocked' —
 *     DOSLEDNA izbira namesto 'error', ker gre za register ključavnico, ne
 *     napako adapterja) + audit CHANNEL_SYNC_FAILED + 0 omrežnih klicev;
 *     neobstoječ integrationId → ok:false (NE meče).
 *  D. REGISTRI: APP_VERSION 1.134.0 (register dvigne vsak val — zadnji: v1.134.0 issue #75); 'i9-' v TEST_PREFIXES; 0 DDL —
 *     schema.sqlite.prisma BREZ ChannelSync/availability-sync modelov,
 *     Webhook/WebhookDelivery NE-prevzeti (channel-sync jih ne omenja).
 *
 * Fiksture s predpono i9- (TEST_PREFIXES že dodan); kaskadni izbris v
 * afterAll (order po idempotencyKey, integrationLog, integration,
 * deviceRegistry, table po qrToken/id, employee, menu drevo, eventLog po
 * locationId/payload, auditLog po entityId/details, counter po imenu
 * sekvenge) + sweepTestFixtures([P]) varovalka — 0 ostankov.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { createHmac } from 'crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import { loadPublicMenu } from '../src/lib/guest'
import {
  registerChannelAdapter,
  getChannelAdapter,
  syncAvailabilityToChannel,
  type ChannelAvailabilityItem,
} from '../src/lib/channel-sync'
import { GET as availabilityGET } from '../src/app/api/public/menu/availability/route'
import { POST as webhookPOST } from '../src/app/api/delivery/webhook/[provider]/route'
import { webhookIdempotencyKey } from '../src/lib/delivery'

const P = 'i9-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

// QR žetoni: 32 hex znakov (resolveQrToken sprejme samo hex ≥ 16)
const QR1 = (Date.now().toString(16) + 'b1'.repeat(32)).slice(0, 32) // miza na lokaciji 1
const QR2 = (Date.now().toString(16) + 'c2'.repeat(32)).slice(0, 32) // miza na lokaciji 2 (tuja)
const KIOSK_DEVICE_ID = `${P}kiosk-dev-${RUN}`
const GLOVO_SECRET = `${P}glovo-secret-${RUN}`
const PLAT_ID = `${P}glovo-${RUN}`
// v1.159.0: ključ idempotence je vezan na lokacijo (isti ID dveh lokacij ne trči)
let IDEM = `glovo:${PLAT_ID}`

let loc1 = ''
let loc2 = ''
let miA = '', miB = '', miC = '' // lokacija 1: 10 € · 12,50 € (86) · 8 €
let miD = ''                    // lokacija 2: 5 €
let tbl1 = '', tbl2 = ''
let kioskDev = ''
let empAdmin = ''
let intMock = '', intBlocked = '', intGlovo = ''

/** GET zahtevek availability rute (qr ali device header, unikaten IP po želji). */
function areq(qr?: string, device?: string, ip = '10.9.0.1', extraHeaders?: Record<string, string>): NextRequest {
  const url = `http://localhost:3000/api/public/menu/availability${qr ? `?qr=${qr}` : ''}`
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      ...(device ? { 'x-device-token': device } : {}),
      ...(ip ? { 'x-forwarded-for': ip } : {}),
      ...(extraHeaders || {}),
    },
  })
}

/** Podpisan Glovo webhook POST (HMAC-SHA256 nad raw bodyjem — vzorec delivery.test.ts). */
function glovoWebhook(payload: unknown, ip = `10.9.1.${Date.now() % 200}`): NextRequest {
  const raw = JSON.stringify(payload)
  const sig = 'sha256=' + createHmac('sha256', GLOVO_SECRET).update(raw, 'utf8').digest('hex')
  return new NextRequest('http://localhost:3000/api/delivery/webhook/glovo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sig, 'x-forwarded-for': ip },
    body: raw,
  })
}

const glovoPayload = () => ({
  order: {
    id: PLAT_ID,
    customer: { first_name: 'Ana', last_name: 'Novak', phone: '+38640123456' },
    delivery_address: { street: `${P}Ulica 1`, city: 'Ljubljana', post_code: '1000', details: '3. nadstropje' },
    products: [
      { menuItemId: miA, quantity: 2 },
      { menuItemId: miC, quantity: 1, note: `${P}brez čebule` },
    ],
    delivery_fee: 2.5,
    packaging_fee: 0.5,
    eta_minutes: 25,
  },
})

/* ─────────────── Fiksture + čiščenje ─────────────── */

async function cleanup() {
  // dokaz/vsi otroci z nid() id (brez predpone) najprej po znanih poljih
  await db.auditLog.deleteMany({
    where: { OR: [{ entityId: { startsWith: P } }, { details: { contains: P } }] },
  }).catch(() => null)
  await db.eventLog.deleteMany({
    where: { OR: [{ entityId: { startsWith: P } }, { payload: { contains: P } }, { locationId: { startsWith: P } }] },
  }).catch(() => null)
  // sekvenca naročil (Counter name = `order:<locationId>`)
  await db.counter.deleteMany({ where: { name: { startsWith: `order:${P}` } } }).catch(() => null)
  // platformsko naročilo (idempotencyKey `glovo:i9-…`; orderItem brišemo eksplicitno,
  // čeprav Cascade obstaja — isti vrstni red kot i65 vzorec)
  await db.orderItem.deleteMany({ where: { Order: { idempotencyKey: { startsWith: `glovo:${P}` } } } }).catch(() => null)
  await db.deliveryInfo.deleteMany({ where: { Order: { idempotencyKey: { startsWith: `glovo:${P}` } } } }).catch(() => null)
  await db.order.deleteMany({ where: { idempotencyKey: { startsWith: `glovo:${P}` } } }).catch(() => null)
  // integracije (IntegrationLog kaskadno z Integration, a eksplicitno prvo)
  await db.integrationLog.deleteMany({ where: { integrationId: { startsWith: P } } }).catch(() => null)
  await db.integration.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  // kiosk naprava, mize (po id IN po qrToken), zaposleni, meni drevo
  await db.deviceRegistry.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.table.deleteMany({
    where: { OR: [{ id: { startsWith: P } }, { qrToken: { in: [QR1, QR2] } }] },
  }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  // org drevo ni ustvarjeno, a po pogodbi počistimo morebitne i9- ostanke
  await db.property.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.brand.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.organization.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  // varovalka za vse ostalo (ID_SWEEP/lokacijski/besedilni prehodi)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()

  // lokaciji ×2 (druga = tuja lokacija za QR resolucijo)
  loc1 = `${P}loc1-${RUN}`
  loc2 = `${P}loc2-${RUN}`
  await db.location.create({ data: { id: loc1, name: `${P}Ljubljana`, code: `I9A-${RUN.toUpperCase()}`, premisesId: `${P}prem1-${RUN}` } })
  await db.location.create({ data: { id: loc2, name: `${P}Maribor`, code: `I9B-${RUN.toUpperCase()}`, premisesId: `${P}prem2-${RUN}` } })

  // meni lokacije 1: 3 artikli (en 86/razprodan) z DISTINCTNIM sortOrder (stabilen ETag)
  const menu1 = await db.menu.create({ data: { id: `${P}menu1-${RUN}`, name: `${P}Meni 1`, locationId: loc1 } })
  const cat1 = await db.category.create({ data: { id: `${P}cat1-${RUN}`, name: `${P}Jedi`, menuId: menu1.id, sortOrder: 1 } })
  miA = `${P}mi-a-${RUN}`
  miB = `${P}mi-b-${RUN}`
  miC = `${P}mi-c-${RUN}`
  await db.menuItem.create({ data: { id: miA, name: `${P}Juha`, price: 10, categoryId: cat1.id, isAvailable: true, sortOrder: 1 } })
  await db.menuItem.create({ data: { id: miB, name: `${P}Zrezek`, price: 12.5, categoryId: cat1.id, isAvailable: false, sortOrder: 2 } })
  await db.menuItem.create({ data: { id: miC, name: `${P}Solata`, price: 8, categoryId: cat1.id, isAvailable: true, sortOrder: 3 } })

  // meni lokacije 2: 1 artikel
  const menu2 = await db.menu.create({ data: { id: `${P}menu2-${RUN}`, name: `${P}Meni 2`, locationId: loc2 } })
  const cat2 = await db.category.create({ data: { id: `${P}cat2-${RUN}`, name: `${P}Jedi 2`, menuId: menu2.id, sortOrder: 1 } })
  miD = `${P}mi-d-${RUN}`
  await db.menuItem.create({ data: { id: miD, name: `${P}Pica`, price: 5, categoryId: cat2.id, isAvailable: true, sortOrder: 1 } })

  // mizi s QR žetonoma (veljavna 32-hex, qrEnabled)
  tbl1 = `${P}tbl1-${RUN}`
  tbl2 = `${P}tbl2-${RUN}`
  await db.table.create({ data: { id: tbl1, number: 980, locationId: loc1, qrToken: QR1, qrEnabled: true } })
  await db.table.create({ data: { id: tbl2, number: 981, locationId: loc2, qrToken: QR2, qrEnabled: true } })

  // kiosk naprava (type='kiosk', NE preklicana)
  kioskDev = `${P}kiosk-${RUN}`
  await db.deviceRegistry.create({
    data: { id: kioskDev, deviceId: KIOSK_DEVICE_ID, name: `${P}Kiosk`, locationId: loc1, type: 'kiosk', status: 'offline' },
  })

  // zaposleni (sistemski vir webhooka — FK zahteva vsaj enega aktivnega)
  const f = employeePinFields(`${PIN_BASE}1`, `${P}admin@test.local`)
  empAdmin = `${P}admin-${RUN}`
  await db.employee.create({
    data: {
      id: empAdmin, name: `${P}Admin`, email: `${P}admin@test.local`,
      role: 'admin', status: 'active', sessionVersion: 0, locationId: loc1,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })

  // integracije: mock (adapter obstaja) · nonexistent-provider (blokirano) · glovo (webhook)
  intMock = `${P}int-mock-${RUN}`
  await db.integration.create({
    data: { id: intMock, name: `${P}Mock kanal`, type: 'other', provider: 'mock', locationId: loc1, isActive: true },
  })
  intBlocked = `${P}int-blocked-${RUN}`
  await db.integration.create({
    data: { id: intBlocked, name: `${P}Neznan kanal`, type: 'other', provider: 'nonexistent-provider', locationId: loc1, isActive: true },
  })
  intGlovo = `${P}int-glovo-${RUN}`
  IDEM = webhookIdempotencyKey('glovo', PLAT_ID, loc1)
  await db.integration.create({
    data: { id: intGlovo, name: `${P}Glovo`, type: 'delivery', provider: 'glovo', locationId: loc1, isActive: true, apiSecret: GLOVO_SECRET },
  })
})

afterAll(async () => {
  await cleanup()
})

/* ─────────────── A. JAVNA AVAILABILITY RUTA ─────────────── */

describe('A. GET /api/public/menu/availability — avtentikacija + vsebina + ETag', () => {
  it('200 s QR žetonom: availability ≡ loadPublicMenu (id/isAvailable/price) + etag/no-store/generatedAt', async () => {
    const res = await availabilityGET(areq(QR1))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { generatedAt?: string; availability?: Array<{ id: string; isAvailable: boolean; price: number }> }
    expect(j.generatedAt).toBeTruthy()
    expect(Array.isArray(j.availability)).toBe(true)

    const menu = await loadPublicMenu(loc1)
    expect(j.availability?.length).toBe(menu.items.length)
    expect(j.availability).toEqual(menu.items.map((i) => ({ id: i.id, isAvailable: i.isAvailable, price: i.price })))
    // konkretne vrednosti (vključno 86 stanje in Decimal→num ceno)
    expect(j.availability?.find((x) => x.id === miA)).toEqual({ id: miA, isAvailable: true, price: 10 })
    expect(j.availability?.find((x) => x.id === miB)).toEqual({ id: miB, isAvailable: false, price: 12.5 })
    expect(typeof j.availability?.[0]?.price).toBe('number')

    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('200 s kiosk napravo (x-device-token) + heartbeat (status/lastSeenAt osvežena)', async () => {
    const res = await availabilityGET(areq(undefined, KIOSK_DEVICE_ID))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { availability?: Array<{ id: string }> }
    expect(j.availability?.length).toBe(3)
    expect(j.availability?.map((x) => x.id).sort()).toEqual([miA, miB, miC].sort())
    const dev = await db.deviceRegistry.findUnique({ where: { id: kioskDev } })
    expect(dev?.status).toBe('online')
    expect(dev?.lastSeenAt).not.toBeNull()
  })

  it('401 brez qr in brez device tokena', async () => {
    const res = await availabilityGET(areq())
    expect(res.status).toBe(401)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toBe('Manjka QR token ali identiteta naprave.')
  })

  it('401 s slabim QR žetonom (neznana 32-hex vrednost)', async () => {
    const res = await availabilityGET(areq('f'.repeat(32)))
    expect(res.status).toBe(401)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toBe('QR koda ni veljavna ali je naročanje po QR izklopljeno.')
  })

  it('401 s slabim device tokenom (neznana kiosk naprava)', async () => {
    const res = await availabilityGET(areq(undefined, `${P}neznan-kiosk-${RUN}`))
    expect(res.status).toBe(401)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toBe('Kiosk naprava ni registrirana.')
  })

  it('ETag: drugi klic z if-none-match=etag → 304 s praznim telesom in istim etagom', async () => {
    const r1 = await availabilityGET(areq(QR1, undefined, '10.9.0.5'))
    expect(r1.status).toBe(200)
    const etag = r1.headers.get('etag')
    expect(etag).toBeTruthy()
    const r2 = await availabilityGET(areq(QR1, undefined, '10.9.0.5', { 'if-none-match': etag as string }))
    expect(r2.status).toBe(304)
    expect(await r2.text()).toBe('')
    expect(r2.headers.get('etag')).toBe(etag)
    expect(r2.headers.get('cache-control')).toBe('no-store')
    // napačen etag → polni 200 (ne 304)
    const r3 = await availabilityGET(areq(QR1, undefined, '10.9.0.5', { 'if-none-match': '"deadbeef"' }))
    expect(r3.status).toBe(200)
  })

  it('QR tuje lokacije → strežnik reši lokacijo IZ žetona (200, meni lokacije 2, različen etag)', async () => {
    const rMain = await availabilityGET(areq(QR1, undefined, '10.9.0.6'))
    const rOther = await availabilityGET(areq(QR2, undefined, '10.9.0.6'))
    expect(rOther.status).toBe(200)
    const j = (await rOther.json()) as { availability?: Array<{ id: string }> }
    expect(j.availability?.map((x) => x.id)).toEqual([miD])
    expect(rOther.headers.get('etag')).toBeTruthy()
    expect(rOther.headers.get('etag')).not.toBe(rMain.headers.get('etag'))
  })

  it('rate limit 60/min po IP: 61. klic → 429', async () => {
    const ip = `${P}rl-${RUN}` // unikaten ključ, da ne moti ostalih testov
    let last = 0
    for (let i = 0; i < 60; i++) {
      const r = await availabilityGET(areq(QR1, undefined, ip))
      last = r.status
      expect([200, 304]).toContain(r.status)
    }
    expect(last).toBeLessThan(400)
    const blocked = await availabilityGET(areq(QR1, undefined, ip))
    expect(blocked.status).toBe(429)
    const j = (await blocked.json()) as { error?: string }
    expect(j.error).toContain('Preveč zahtevkov')
  })
})

/* ─────────────── B. orderSource 'delivery' (webhook) ─────────────── */

describe('B. Glovo webhook → orderSource delivery + idempotenca', () => {
  // POGOJ: edina aktivna glovo integracija je naša fiksatura; stara pot zahteva
  // ENOLIČNO ujemanje podpisa (v1.159.0) — na dev.db s tujimi vrsticami ta sklop
  // NI mogoč; teče na sveži bazi (ci-fresh). vsak B test preveri predpogoj eksplicitno.
  async function expectCleanGlovoState(): Promise<void> {
    const pick = await db.integration.findFirst({ where: { provider: 'glovo' }, select: { id: true } })
    if (pick?.id !== intGlovo) {
      throw new Error(
        `B-sklop zahteva, da je edina Integration vrstica s provider='glovo' naša fiksatura (${intGlovo}); ` +
          `najdena: ${pick?.id ?? 'nič'}. Poženi na sveži bazi (ci-fresh).`,
      )
    }
  }

  it('podpisan webhook → 200; naročilo ima orderSource="delivery" (ključ vezan na lokacijo)', async () => {
    await expectCleanGlovoState()
    const res = await webhookPOST(glovoWebhook(glovoPayload()), { params: Promise.resolve({ provider: 'glovo' }) })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { received?: boolean; orderId?: string; orderNumber?: number }
    expect(j.received).toBe(true)
    expect(j.orderId).toBeTruthy()

    const order = await db.order.findUnique({
      where: { idempotencyKey: IDEM },
      select: { id: true, orderSource: true, type: true, locationId: true, status: true },
    })
    expect(order).not.toBeNull()
    expect(order?.orderSource).toBe('delivery')
    expect(order?.type).toBe('delivery') // tip ostaja DELIVERY (dine-in/takeaway logika nedotaknjena)
    expect(order?.locationId).toBe(loc1) // vezava na lokacijo integracije
    expect(order?.id).toBe(j.orderId)
  })

  it('dvojnik istega platformOrderId → replay (ISTO naročilo, 0 dvojnikov), vir ostane delivery', async () => {
    await expectCleanGlovoState()
    const res = await webhookPOST(glovoWebhook(glovoPayload()), { params: Promise.resolve({ provider: 'glovo' }) })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { received?: boolean; replayed?: boolean }
    expect(j.received).toBe(true)
    expect(j.replayed).toBe(true)

    const count = await db.order.count({ where: { idempotencyKey: IDEM } })
    expect(count).toBe(1)
    const order = await db.order.findUnique({ where: { idempotencyKey: IDEM }, select: { orderSource: true } })
    expect(order?.orderSource).toBe('delivery')
  })
})

/* ─────────────── C. ADAPTER CONTRACT (channel-sync) ─────────────── */

describe('C. channel-sync — register/ključavnica/sinhronizacija', () => {
  const ITEMS: ChannelAvailabilityItem[] = [
    { id: miA, isAvailable: true, price: 10 },
    { id: miB, isAvailable: false, price: 12.5 },
    { id: miC, isAvailable: true, price: 8 },
  ]

  it("registerChannelAdapter + getChannelAdapter: 'mock' je registriran, custom key deluje, unknown → null", () => {
    const mock = getChannelAdapter('mock')
    expect(mock).not.toBeNull()
    expect(mock?.key).toBe('mock')

    // custom adapter: registracija NE pokliče push (0 klicev)
    const key = `${P}kanal-${RUN}`
    let pushes = 0
    registerChannelAdapter({
      key,
      async push() {
        pushes++
        return { ok: true, syncedAt: new Date(), detail: 'test adapter', statusCode: 200 }
      },
    })
    expect(getChannelAdapter(key)?.key).toBe(key)
    expect(pushes).toBe(0)

    expect(getChannelAdapter('unknown')).toBeNull()
    expect(getChannelAdapter('')).toBeNull()
    expect(getChannelAdapter('glovo')).toBeNull() // proizvajalec NI registriran (blokirano)
  })

  it('syncAvailabilityToChannel z provider "mock" → ok + Integration.lastSync* + IntegrationLog outbound + audit OK', async () => {
    const res = await syncAvailabilityToChannel(intMock, ITEMS)
    expect(res.ok).toBe(true)
    expect(res.detail).toBe('mock — 0 artiklov poslanih zunaj')
    expect(res.statusCode).toBe(200)
    expect(res.blocked).toBeUndefined()

    const integ = await db.integration.findUnique({ where: { id: intMock } })
    expect(integ?.lastSyncStatus).toBe('ok')
    expect(integ?.lastSyncAt).not.toBeNull()
    expect(integ?.lastSyncError).toBe('')

    const log = await db.integrationLog.findFirst({
      where: { integrationId: intMock, action: 'availability-push' },
      orderBy: { createdAt: 'desc' },
    })
    expect(log).not.toBeNull()
    expect(log?.direction).toBe('outbound')
    expect(log?.status).toBe('ok')
    expect(log?.statusCode).toBe(200)
    expect(JSON.parse(String(log?.requestData ?? '[]'))).toEqual(ITEMS)
    expect(String(log?.responseData ?? '')).toBe('mock — 0 artiklov poslanih zunaj')

    const audit = await db.auditLog.count({ where: { action: 'CHANNEL_SYNC_OK', entityId: intMock } })
    expect(audit).toBe(1)
  })

  it('provider "nonexistent-provider" → BLOKIRANO: ok:false + blocked + lastSyncStatus="blocked" + audit FAILED + 0 omrežnih klicev', async () => {
    const origFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const res = await syncAvailabilityToChannel(intBlocked, ITEMS)
      expect(res.ok).toBe(false)
      expect(res.blocked).toBe('no-adapter-registered')
      expect(res.detail).toContain('ni registriran')

      const integ = await db.integration.findUnique({ where: { id: intBlocked } })
      expect(integ?.lastSyncStatus).toBe('blocked')
      expect(integ?.lastSyncAt).not.toBeNull()
      expect(integ?.lastSyncError).toContain('ni registriran')

      const log = await db.integrationLog.findFirst({
        where: { integrationId: intBlocked, action: 'availability-push' },
        orderBy: { createdAt: 'desc' },
      })
      expect(log).not.toBeNull()
      expect(log?.direction).toBe('outbound')
      expect(log?.status).toBe('blocked')

      const audit = await db.auditLog.count({ where: { action: 'CHANNEL_SYNC_FAILED', entityId: intBlocked } })
      expect(audit).toBe(1)

      // mock/register NIKOLI ne kliče pravega omrežja
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('uspešna sync NIKOLI ne kliče omrežja (mock adapter = 0 fetch klicev)', async () => {
    const origFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const res = await syncAvailabilityToChannel(intMock, ITEMS)
      expect(res.ok).toBe(true)
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('neobstoječ integrationId → ok:false (NE meče)', async () => {
    const res = await syncAvailabilityToChannel(`${P}neobstaja-${RUN}`, ITEMS)
    expect(res.ok).toBe(false)
    expect(res.blocked).toBe('integration-not-found')
    expect(res.detail).toContain('ne obstaja')
  })
})

/* ─────────────── D. REGISTRI ─────────────── */

describe('D. Registri — verzija / sweep predpona / 0 DDL', () => {
  it('APP_VERSION je 1.137.0', () => {
    expect(APP_VERSION).toBe('1.187.0')
  })

  it("TEST_PREFIXES vsebuje 'i9-'", () => {
    expect(TEST_PREFIXES.includes('i9-')).toBe(true)
  })

  it('0 DDL: schema BREZ channel-sync modelov; Webhook/WebhookDelivery NE-prevzeti', () => {
    const schema = readFileSync(join(import.meta.dir, '..', 'prisma', 'schema.sqlite.prisma'), 'utf8')
    expect(/channelsync/i.test(schema)).toBe(false)
    expect(/availability-sync/i.test(schema)).toBe(false)
    expect(/channelavailability/i.test(schema)).toBe(false)
    // obstoječi (NEZAPOSLENI) modeli ostanejo nedotaknjeni — channel-sync ju NE prevzame
    expect(schema).toContain('model WebhookDelivery')
    expect(schema).toContain('model Webhook ')
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'channel-sync.ts'), 'utf8')
    expect(/webhookdelivery/i.test(src)).toBe(false)
    expect(/outboxevent/i.test(src)).toBe(false)
  })
})
