import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { assertDevDatabase, sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { ORDER_MUTABLE_PAYMENT, ORDER_MUTABLE_STATUS } from '../src/lib/ops'
import { webhookIdempotencyKey } from '../src/lib/delivery'
import { PATCH as deliveryPATCH } from '../src/app/api/delivery/route'
import { POST as webhookPOST } from '../src/app/api/delivery/webhook/[provider]/route'
import { POST as discountPOST } from '../src/app/api/orders/[id]/discount/route'
import { POST as mergePOST } from '../src/app/api/orders/[id]/merge/route'

/**
 * v1.148.0 — razred napak iz revizije #10 (SOČASNOST / IZGUBLJENA DIRKA) na
 * PREOSTALIH pisalcih terminalnega stanja naročila.
 *
 * Skupna oblika napake: ruta naročilo PREBERE, ga izven transakcije overi in nato
 * zapiše z BREZPOGOJNIM update-om. Med branjem in zapisom sme plačilo, preklic ali
 * združevanje commitniti — izgubljena dirka je nato pisala čez zaključeno stanje.
 * v1.145.0 je popravil `orders/[id]`, kitchen, move in merge; trditev, da je
 * »plačilna pot že imela veljaven CAS«, je bila v1.148.0 ovrgnena (glej
 * tests/order-concurrency.test.ts, F/H-skupina). Ta datoteka pokriva štiri pisalce,
 * ki jih takrat ni popravil nihče:
 *
 *  A) PATCH /api/delivery           — dostavni statusni tok je lahko PREKLICAL že
 *     plačano naročilo (EOR račun ostane na 'cancelled' dokumentu).
 *  B) POST /api/orders/[id]/discount — CAS je pogojeval SAMO plačilno stanje, merge
 *     in ročni preklic pa na viru PUSTITA paymentStatus 'unpaid' → popust se je
 *     pripel naročilu, ki ga v prodajnem toku ni več.
 *  C) POST /api/delivery/webhook/[provider] — platformni preklic je pisal čez
 *     plačilo, ki je commitnilo po zunanjem branju stanja.
 *  D) pini vira — administrativen pregled, da nobena od štirih datotek nima več
 *     brezpogojnega zapisa stanja in da nobena ne kopira belega seznama iz `ops.ts`.
 *
 * `/api/admin/cleanup-demo` (čistilec zastarelih listkov) je pokrit SAMO z D-pinom:
 * ruto v purge-načinu bi zahtevala globalen poseg v dev bazo (regexi čez VSE
 * zaposlene, dobavitelje in menije), kar bi med tekom pobrisalo fiksature drugih
 * datotek — end-to-end test te rute namerno NI napisan.
 *
 * Fiksature s predpono `aw10-`; cleanup = sweepTestFixtures.
 */

const P = 'aw10-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locId = ''
let managerId = ''
let waiterId = ''
let miId = ''
let intGlovo = ''

const GLOVO_SECRET = `${P}glovo-secret-${RUN}`
const PLAT = (n: number) => `${P}plat-${RUN}-${n}`

let ipSeq = 0
const nextIp = () => `10.42.7.${++ipSeq}`

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function tokenFor(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

/** Podpisan Glovo webhook POST (HMAC-SHA256 nad raw bodyjem — vzorec issue9/delivery). */
function glovoWebhook(payload: unknown): NextRequest {
  const raw = JSON.stringify(payload)
  const sig = 'sha256=' + createHmac('sha256', GLOVO_SECRET).update(raw, 'utf8').digest('hex')
  return new NextRequest('http://localhost:3000/api/delivery/webhook/glovo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sig, 'x-forwarded-for': nextIp() },
    body: raw,
  })
}

let seq = 0
/** Dostavno naročilo: DeliveryInfo mora NASTATI PRED naročilom (Order.deliveryInfoId → FK). */
async function seedDeliveryOrder(
  status: string, paymentStatus: string, diStatus = 'confirmed',
): Promise<{ orderId: string; diId: string }> {
  seq++
  const diId = `${P}di-${seq}-${RUN}`
  const orderId = `${P}ord-${seq}-${RUN}`
  await db.deliveryInfo.create({
    data: { id: diId, address: `${P}Ulica 12`, city: 'Ljubljana', postCode: '1000', recipientName: `${P}Gost`, status: diStatus },
  })
  await db.order.create({
    data: {
      id: orderId, locationId: locId, orderNumber: 8100 + seq, type: 'delivery',
      status, paymentStatus, total: 10, subtotal: 8.2, tax: 1.8, deliveryInfoId: diId,
    },
  })
  await db.orderItem.create({
    data: { id: `${P}it-${seq}-${RUN}`, orderId, menuItemId: miId, quantity: 1, price: 10, vatRate: 22, vatAmount: 1.8, menuItemName: 'Aw10 testni artikel', status: 'preparing' },
  })
  return { orderId, diId }
}

/** Navadno naročilo z enim artiklom; `extra` dopolni polja, ki jih test zahteva. */
async function seedOrder(status = 'open', paymentStatus = 'unpaid', extra: Record<string, unknown> = {}) {
  seq++
  const id = `${P}ord-${seq}-${RUN}`
  await db.order.create({
    data: { id, locationId: locId, orderNumber: 8300 + seq, status, paymentStatus, total: 10, subtotal: 8.2, tax: 1.8, ...extra },
  })
  await db.orderItem.create({
    data: { id: `${P}it-${seq}-${RUN}`, orderId: id, menuItemId: miId, quantity: 1, price: 10, vatRate: 22, vatAmount: 1.8, menuItemName: 'Aw10 testni artikel', status: 'preparing' },
  })
  return db.order.findUnique({ where: { id } })
}

const orderRow = (id: string) => db.order.findUnique({ where: { id } })
const diRow = (id: string) => db.deliveryInfo.findUnique({ where: { id } })
const countAudits = (action: string, entityId: string) => db.auditLog.count({ where: { action, entityId } })

beforeAll(async () => {
  assertDevDatabase()
  await sweepTestFixtures(db, [P])
  const loc = await db.location.create({
    data: { id: `${P}loc-${RUN}`, name: `${P}Lokacija`, code: `AW10-${RUN.toUpperCase()}`, premisesId: `aw10-prem-${RUN}`, taxId: 'SI12345678' },
  })
  locId = loc.id
  const f1 = employeePinFields(`${PIN_BASE}1`, `${P}manager-${RUN}@test.local`)
  managerId = (await db.employee.create({
    data: { id: `${P}emp-manager-${RUN}`, name: `${P}Manager`, email: `${P}manager-${RUN}@test.local`, role: 'manager', status: 'active', sessionVersion: 0, locationId: locId, pin: f1.pin, pinLookup: f1.pinLookup },
  })).id
  const f2 = employeePinFields(`${PIN_BASE}2`, `${P}waiter-${RUN}@test.local`)
  waiterId = (await db.employee.create({
    data: { id: `${P}emp-waiter-${RUN}`, name: `${P}Natakar`, email: `${P}waiter-${RUN}@test.local`, role: 'waiter', status: 'active', sessionVersion: 0, locationId: locId, pin: f2.pin, pinLookup: f2.pinLookup },
  })).id
  const menu = await db.menu.create({ data: { id: `${P}menu-${RUN}`, name: 'Aw10 meni', locationId: locId } })
  const cat = await db.category.create({ data: { id: `${P}cat-${RUN}`, name: 'Aw10 kategorija', menuId: menu.id } })
  miId = (await db.menuItem.create({ data: { id: `${P}mi-${RUN}`, name: 'Aw10 testni artikel', price: 10, categoryId: cat.id } })).id

  // Webhook ruta poišče secret z GLOBALNIM findFirst({provider}) — ostanek
  // prejšnjega (crashanega) teka ali druga testna integracija bi premaknila
  // podpis in lokacijo. Datoteke tečejo ZAPORIEDNO (brez --parallel), zato je
  // brisanje predponiranih ostankov varno; assertDevDatabase() zgoraj zagotovi,
  // da gre za lokalno SQLite bazo.
  await db.integration.deleteMany({ where: { provider: { in: ['glovo', 'wolt'] } } })
  intGlovo = `${P}int-glovo-${RUN}`
  await db.integration.create({
    data: { id: intGlovo, name: `${P}Glovo`, type: 'delivery', provider: 'glovo', locationId: locId, isActive: true, apiSecret: GLOVO_SECRET },
  })
})

afterAll(async () => {
  await db.integration.deleteMany({ where: { id: intGlovo } })
  const res = await sweepTestFixtures(db, [P])
  expect(res.errors).toEqual([])
  expect(res.remainingLocations).toBe(0)
})

/* ─────────────── A) PATCH /api/delivery — preklic dostave ─────────────── */

describe('A — PATCH /api/delivery: preklic dostave sme pisati SAMO v mutabilno naročilo', () => {
  test('ŽE PLAČANO naročilo → 409 in ROLLBACK dostavnega statusa (brez revizijske sledi)', async () => {
    const { orderId, diId } = await seedDeliveryOrder('paid', 'paid', 'confirmed')
    expect(await diRow(diId)).not.toBeNull()

    const res = await deliveryPATCH(req('/api/delivery', tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', {
      orderId, status: 'cancelled', note: 'Gost je odpovedal',
    }))
    expect(res.status).toBe(409)

    // Rollback: `tx.deliveryInfo.update` se je zgodil PRED claimom → moral je pasti
    const di = await diRow(diId)
    expect(di?.status).toBe('confirmed')
    const row = await orderRow(orderId)
    expect(row?.status).toBe('paid')
    expect(row?.paymentStatus).toBe('paid')
    expect(row?.cancelledAt).toBeNull()
    expect(await countAudits('DELIVERY_STATUS_UPDATE', diId)).toBe(0)
  })

  test('KONTROLA: brezpogojen zapis (stara oblika) PLAČANO naročilo kljub vsemu prekliče', async () => {
    const { orderId } = await seedDeliveryOrder('paid', 'paid', 'confirmed')
    // Stara koda je bila `tx.order.update({ where: { id }, data: { status: 'cancelled', … } })`.
    // Kontrola dokaže, da test zgoraj ni prazen: brez pogoja zapis PREKLICE plačano naročilo.
    const old = await db.order.updateMany({
      where: { id: orderId },
      data: { status: 'cancelled', cancelReason: 'KONTROLA stara pot', cancelledAt: new Date() },
    })
    expect(old.count).toBe(1)
    expect((await orderRow(orderId))?.status).toBe('cancelled')
  })

  test('happy path: odprto naročilo → 200, naročilo preklicano z razlogom in časom', async () => {
    const { orderId, diId } = await seedDeliveryOrder('sent', 'unpaid', 'confirmed')
    const res = await deliveryPATCH(req('/api/delivery', tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', {
      orderId, status: 'cancelled', note: 'Paket ni na voljo',
    }))
    expect(res.status).toBe(200)
    const row = await orderRow(orderId)
    expect(row?.status).toBe('cancelled')
    expect(row?.cancelReason).toBe('Paket ni na voljo')
    expect(row?.cancelledAt).not.toBeNull()
    expect((await diRow(diId))?.status).toBe('cancelled')
    expect(await countAudits('DELIVERY_STATUS_UPDATE', diId)).toBe(1)
  })

  test('preklican vir (status terminalen, paymentStatus »unpaid«) → 409 brez sprememb', async () => {
    // stanje, ki ga PUSTI združevanje in ročni preklic: plačilno stanje je še
    // vedno 'unpaid', zato ga CAS brez status-pogoja ne vidi
    const { orderId, diId } = await seedDeliveryOrder('cancelled', 'unpaid', 'pending')
    const before = (await orderRow(orderId))?.cancelReason
    const res = await deliveryPATCH(req('/api/delivery', tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', {
      orderId, status: 'cancelled',
    }))
    expect(res.status).toBe(409)
    expect((await diRow(diId))?.status).toBe('pending')
    expect((await orderRow(orderId))?.cancelReason).toBe(before)
    expect(await countAudits('DELIVERY_STATUS_UPDATE', diId)).toBe(0)
  })

  test('brez dostavnih podatkov → 404 (vrata pred claimom, brez stranskih učinkov)', async () => {
    const plain = await seedOrder('sent', 'unpaid')
    const res = await deliveryPATCH(req('/api/delivery', tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', {
      orderId: plain!.id, status: 'cancelled',
    }))
    expect(res.status).toBe(404)
    expect((await orderRow(plain!.id))?.status).toBe('sent')
  })
})

/* ─────────────── B) POST /api/orders/[id]/discount ─────────────── */

describe('B — popust: write-time CAS pogojuje tudi STATUS (ne samo plačilnega stanja)', () => {
  const token = () => tokenFor(waiterId, 'w', 'WAITER', locId)
  const post = (id: string, body: unknown) =>
    discountPOST(req(`/api/orders/${id}/discount`, token(), 'POST', body), { params: Promise.resolve({ id }) })

  test('ŽE PREKLICAN vir z artikli → 409, popust ostane 0, brez DISCOUNT_APPLIED', async () => {
    const order = await seedOrder('cancelled', 'unpaid', { cancelReason: 'Ročni preklic', cancelledAt: new Date() })
    const res = await post(order!.id, { type: 'percent', amount: 10, name: `${P}Popust`, reason: 'Gost praznuje' })
    expect(res.status).toBe(409)
    expect(Number((await orderRow(order!.id))?.discount)).toBe(0)
    expect(await countAudits('DISCOUNT_APPLIED', order!.id)).toBe(0)
  })

  test('KONTROLA: stari CAS (samo paymentStatus) na preklicanem viru ŠE VEDNO zapiše popust', async () => {
    const order = await seedOrder('cancelled', 'unpaid')
    // Prepisan pogoj iz v1.147.0 in nižje: `where: { id, paymentStatus: { in: PAYABLE }, discount: 0 }`
    const old = await db.order.updateMany({
      where: { id: order!.id, paymentStatus: { in: [...ORDER_MUTABLE_PAYMENT] }, discount: 0 },
      data: { discount: 1.23 },
    })
    expect(old.count).toBe(1)
    expect(Number((await orderRow(order!.id))?.discount)).toBe(1.23)
  })

  test('združen vir (realna pot skozi merge) → popust NI pripet', async () => {
    const src = await seedOrder('sent', 'unpaid')
    const tgt = await seedOrder('sent', 'unpaid')
    const merge = await mergePOST(req(`/api/orders/${src!.id}/merge`, token(), 'POST', { targetOrderId: tgt!.id }), { params: Promise.resolve({ id: src!.id }) })
    expect(merge.status).toBe(200)
    const res = await post(src!.id, { type: 'percent', amount: 10, name: `${P}Popust`, reason: 'Gost praznuje' })
    // Zavrne lahko eno od dveh vrat: ničelna osnova (postavke so seljene na cilj) ALI
    // write-time CAS. Oboje je pravilno — bistvo: popust NIKOLI ne zadenje vira.
    expect(res.status).not.toBe(200)
    expect([400, 409]).toContain(res.status)
    const row = await orderRow(src!.id)
    expect(row?.status).toBe('cancelled')
    expect(Number(row?.discount)).toBe(0)
    expect(await countAudits('DISCOUNT_APPLIED', src!.id)).toBe(0)
  })

  test('happy path: odprto naročilo → 200, discount > 0 + ena revizijska sled', async () => {
    const order = await seedOrder('open', 'unpaid')
    const res = await post(order!.id, { type: 'percent', amount: 10, name: `${P}Popust`, reason: 'Gost praznuje' })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { discount?: number }
    expect(j.discount).toBe(1)
    expect(Number((await orderRow(order!.id))?.discount)).toBe(1)
    expect(await countAudits('DISCOUNT_APPLIED', order!.id)).toBe(1)
  })

  test('plačano naročilo → 409 že ob prihodu (obstoječa vrata ostanejo)', async () => {
    const order = await seedOrder('paid', 'paid', { paidAt: new Date() })
    const res = await post(order!.id, { type: 'percent', amount: 10, reason: 'Gost praznuje' })
    expect(res.status).toBe(409)
    expect(Number((await orderRow(order!.id))?.discount)).toBe(0)
  })

  test('brez razloga → 400 (ročni popust je izjema; validacija pred zapisom)', async () => {
    const order = await seedOrder('open', 'unpaid')
    const res = await post(order!.id, { type: 'percent', amount: 10 })
    expect(res.status).toBe(400)
    expect(Number((await orderRow(order!.id))?.discount)).toBe(0)
  })
})

/* ─────────────── C) POST /api/delivery/webhook/glovo — platformni preklic ─────────────── */

describe('C — dostavni webhook: platformni preklic ne piše čez zaključeno naročilo', () => {
  const cancelCall = (platformOrderId: string) =>
    webhookPOST(glovoWebhook({ status: 'cancelled', order: { id: platformOrderId } }), { params: Promise.resolve({ provider: 'glovo' }) })

  /** Naročilo, ustvarjeno IZVEN rute (ročno), z idempotencyKey kot ga piše webhook. */
  async function seedWebhookOrder(status: string, paymentStatus: string, platformOrderId: string) {
    seq++
    const diId = `${P}wh-di-${seq}-${RUN}`
    const orderId = `${P}wh-${seq}-${RUN}`
    await db.deliveryInfo.create({ data: { id: diId, address: `${P}Ulica 1`, status: 'confirmed' } })
    await db.order.create({
      data: {
        id: orderId, locationId: locId, orderNumber: 8500 + seq, type: 'delivery', status, paymentStatus,
        total: 10, subtotal: 8.2, tax: 1.8, deliveryInfoId: diId,
        idempotencyKey: webhookIdempotencyKey('glovo', platformOrderId),
        orderSource: 'delivery',
      },
    })
    return { orderId, diId }
  }

  test('ŽE PLAČANO naročilo → 200 {ignored:true}, brez preklica in brez sledi', async () => {
    const plat = PLAT(1)
    const { orderId, diId } = await seedWebhookOrder('paid', 'paid', plat)
    const res = await cancelCall(plat)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, ignored: true })
    const row = await orderRow(orderId)
    expect(row?.status).toBe('paid')
    expect(row?.cancelledAt).toBeNull()
    expect((await diRow(diId))?.status).toBe('confirmed')
    expect(await countAudits('DELIVERY_ORDER_CANCELLED', orderId)).toBe(0)
    // plačano naročilo je finančna izjema — dnevnik jo mora pisati LOČENO od
    // »ni naročila« (sicer operater ne ve, ali je šlo za zamujen create ali preklic)
    expect(await db.integrationLog.count({
      where: {
        integrationId: intGlovo,
        AND: [
          { requestData: { contains: 'cancel ignoriran — naročilo je že plačano' } },
          { requestData: { contains: plat } },
        ],
      },
    })).toBe(1)
  })

  test('preklican vir (residualni „unpaid") → 200 {ignored:true}, dostava nedotaknjena', async () => {
    const plat = PLAT(2)
    const { orderId, diId } = await seedWebhookOrder('cancelled', 'unpaid', plat)
    const res = await cancelCall(plat)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, ignored: true })
    expect((await diRow(diId))?.status).toBe('confirmed')
    expect(await countAudits('DELIVERY_ORDER_CANCELLED', orderId)).toBe(0)
    // Integracijski dnevnik BELEŽI razlog zamene (operater mora videti, kaj se je
    // zgodilo), revizijski del pa ostane čist. Filtrira se PO platformskem id-ju,
    // da števec ne odvisen od vrstnega reda testov v datoteki.
    expect(await db.integrationLog.count({
      where: {
        integrationId: intGlovo,
        AND: [
          { requestData: { contains: 'cancel ignoriran — naročilo je medtem zaključeno' } },
          { requestData: { contains: plat } },
        ],
      },
    })).toBe(1)
  })

  test('happy path: odprto naročilo → 200 {cancelled:true}, preklic + dostava + ena sled', async () => {
    const plat = PLAT(3)
    const { orderId, diId } = await seedWebhookOrder('sent', 'unpaid', plat)
    const res = await cancelCall(plat)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, cancelled: true })
    const row = await orderRow(orderId)
    expect(row?.status).toBe('cancelled')
    expect(row?.cancelReason).toContain('glovo webhook')
    expect(row?.cancelledAt).not.toBeNull()
    expect((await diRow(diId))?.status).toBe('cancelled')
    expect(await countAudits('DELIVERY_ORDER_CANCELLED', orderId)).toBe(1)
  })

  test('podvojen preklic istega naročila → drugi {ignored:true} in samo ENA sled', async () => {
    const plat = PLAT(4)
    const { orderId } = await seedWebhookOrder('open', 'unpaid', plat)
    expect(await cancelCall(plat).then((r) => r.json())).toEqual({ received: true, cancelled: true })
    expect(await cancelCall(plat).then((r) => r.json())).toEqual({ received: true, ignored: true })
    expect(await countAudits('DELIVERY_ORDER_CANCELLED', orderId)).toBe(1)
  })

  test('napačen podpis → 401 pred kakršnim koli posegom', async () => {
    const plat = PLAT(5)
    const { orderId } = await seedWebhookOrder('open', 'unpaid', plat)
    const raw = JSON.stringify({ status: 'cancelled', order: { id: plat } })
    const bad = new NextRequest('http://localhost:3000/api/delivery/webhook/glovo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': 'sha256=' + '0'.repeat(64), 'x-forwarded-for': nextIp() },
      body: raw,
    })
    const res = await webhookPOST(bad, { params: Promise.resolve({ provider: 'glovo' }) })
    expect(res.status).toBe(401)
    expect((await orderRow(orderId))?.status).toBe('open')
  })
})

/* ─────────────── D) pini vira (administrativni pregled) ─────────────── */

const SRC = (rel: string) => readFileSync(join(import.meta.dir, '..', 'src', ...rel.split('/')), 'utf8')

describe('D — pini vira: noben od štirih pisalcev nima več brezpogojnega zapisa', () => {
  test('delivery ruta: claim + DeliveryRejected, brez tx.order.update(', () => {
    const src = SRC('app/api/delivery/route.ts')
    expect(src).toContain('claimMutableOrder(tx, order.id')
    expect(src).toContain('class DeliveryRejected extends Error')
    expect(src).toContain('throw new DeliveryRejected(')
    expect(src).toContain('e instanceof DeliveryRejected')
    // `tx.order.update(` (BZ updateMany) = brezpogojen zapis terminalnega stanja
    expect(src).not.toContain('tx.order.update(')
    expect(src).not.toContain('db.order.update(')
  })

  test('webhook ruta: claim neposredno ob zapisu, ignoriranje vrne 2xx', () => {
    const src = SRC('app/api/delivery/webhook/[provider]/route.ts')
    expect(src).toContain('claimMutableOrder(db, existing.id')
    expect(src).not.toContain('db.order.update(')
    // dve poti, ki platformi vrneta 2xx (brez naročila / izgubljena dirka) —
    // sicer bi platforma preklic vsakič znova poslala
    expect((src.match(/received: true, ignored: true/g) || []).length).toBe(2)
  })

  test('cleanup-demo: oba pogoja v posameznem zapisu + oboje uvoženo iz ops.ts', () => {
    const src = SRC('app/api/admin/cleanup-demo/route.ts')
    expect(src).toContain("import { ORDER_MUTABLE_PAYMENT, ORDER_MUTABLE_STATUS } from '@/lib/ops'")
    expect(src).toContain('status: { in: [...ORDER_MUTABLE_STATUS] }')
    expect(src).toContain('paymentStatus: { in: [...ORDER_MUTABLE_PAYMENT] }')
    expect(src).toContain('cancelled.count === 0')
    expect(src).not.toContain('db.order.update(')
  })

  test('discount ruta: BELI SEZNAM NI KOPIJA, status-pogoj je v obeh CAS zapisih', () => {
    const src = SRC('app/api/orders/[id]/discount/route.ts')
    expect(src).toContain('const PAYABLE = ORDER_MUTABLE_PAYMENT')
    expect(src).not.toContain("const PAYABLE = ['unpaid'")
    expect((src.match(/status: \{ in: \[\.\.\.ORDER_MUTABLE_STATUS\] \}/g) || []).length).toBe(2)
  })
})
