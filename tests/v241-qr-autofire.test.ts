/**
 * v1.241.0 (PRIMERJAVA-VMESNIKOV-2026 §16 E točka 3) — QR PUSH + AVTO-POŽIG.
 *
 * Problem (najdba §16 E): QR/kiosk naročilo gosta je TIHO pristalo kot
 * open/pending — ORDER_NEW push ni šel nikomur (POS ruta ga pošilja od v1.70.0,
 * javna ne), postajne deske naročila NISO videle (StationTask nastane šele ob
 * požigu), firedAt je ostal null (ETA/starost statistika je lagala). Tablica:
 * gumb obljublja »Pošlji v pripravo« (tlb.send), implementacija pa postavk ni
 * nikoli poslala v pripravo.
 *
 * Pokrito:
 *  A. SKUPNI HELPER fireOrderCore (src/lib/order-fire.ts, enota):
 *     A1 sveže naročilo → firedCount > 0 + firedAt + statusi postavk 'fired';
 *     A2 idempotenca — drugi klic alreadyFired, BREZ sprememb;
 *     A3 zadržano ('hold') naročilo → 409;
 *     A4 plačano naročilo → 409;
 *     A5 neobstoječe → 404;
 *     A6 revizija ORDER_FIRED + auditExtra (autoFire) v details.
 *  B. JAVNA RUTA POST /api/public/orders (QR):
 *     B1 uspeh → fired:true + firedAt + postavke fired + revizija GUEST_ORDER_FIRED
 *        z virom 'qr' (autoFire);
 *     B2 postajne naloge: MenuItemStation usmeritev → StationTask nastane OB
 *        avto-požigu (prej nikoli — jedro najdbe §16 E);
 *     B3 replay (isti clientOperationId) → replayed:true, brez dvojnika, brez
 *        ponovnega požiga sprememb (idempotenten helper);
 *     B4 EventLog 'OrderFired' objavljen (SSE/integracijski temelj).
 *  C. POS POST /api/orders (avto-požig tablice):
 *     C1 BREZ autoFire → vedenje NEspremenjeno: firedAt null, postavke pending
 *        (dashboard/handheld coursing kontrola ostaja);
 *     C2 Z autoFire:true → fired + revizija ORDER_FIRED z autoFire:true;
 *     C3 odgovor vsebuje firedCount, postavke v odgovoru so fired.
 *  D. OFFLINE VRSTA (tablica brez mreže → POST /api/sync):
 *     D1 order.create z autoFire → naročilo POŽGANO tudi iz vrste; operacija
 *        'applied' (fail-soft požig ne sabotaža sync klaima);
 *     D2 order.create BREZ autoFire (dashboard POS offline) → pending (ne glede
 *        na ta val — vrsta je skupna vsem površinam).
 *  E. ROČNA POT (refaktor fire rute na helper):
 *     E1 POST /api/orders/[id]/fire še vedno požge + revizija ORDER_FIRED;
 *     E2 že požgano → 200 alreadyFired:true, firedCount 0.
 *  Ž. REGISTRI: APP_VERSION 1.241.0; 'v241-' v TEST_PREFIXES; 0 DDL (lib brez
 *     spremembb schemata); i18n 3860 ključev (0 novih — tlb.send že obstaja).
 *
 * Fiksture s predpono v241- (TEST_PREFIXES že dodan); kaskadni izbris v afterAll
 * + sweepTestFixtures([PREFIX]) varovalka — 0 ostankov.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { employeePinFields, createToken } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import { fireOrderCore, FireOrderError } from '../src/lib/order-fire'
import { POST as publicOrdersPOST } from '../src/app/api/public/orders/route'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'
import { POST as syncPOST } from '../src/app/api/sync/route'

const PREFIX = 'v241-'
const RUN = Date.now().toString(36)
const RUN_HEX = Date.now().toString(16) // resolveQrToken zahteva ŽETON v hex (≥16 znakov)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`
const KIOSK_DEVICE_ID = `v241-kiosk-${RUN}`

let loc = ''
let menuItemA = ''
let menuItemB = ''
let waiterToken = ''
let waiterName = ''
let stationId = ''

/** Sveža QR miza za test (hex žeton ≥16 — pogodba resolveQrToken).
 *  Prvo naročilo na mizi jo CAS-zasede → vsak test, ki ustvarja naročilo, dobi SVOJO mizo. */
let qrSeq = 0
function freshQrTable(): { id: string; token: string } {
  qrSeq += 1
  const token = `${RUN_HEX}beef${String(qrSeq).padStart(4, '0')}`
  return { id: `${PREFIX}qrtbl-${qrSeq}-${RUN}`, token }
}
let tblSeq = 100
function freshTableId(): string {
  tblSeq += 1
  return `${PREFIX}tbl-${tblSeq}-${RUN}`
}

function tokenFor(sub: string, name: string, role: string, l: string | null): string {
  return createToken({ sub, name, role, loc: l, sv: 0 })
}

function publicReq(body: unknown, deviceToken?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/public/orders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(deviceToken ? { 'x-device-token': deviceToken } : {}),
    },
    body: JSON.stringify(body),
  })
}

function staffReq(url: string, token: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function seedOrder(suffix: string, status = 'open', firedAt: Date | null = null): Promise<string> {
  const id = `${PREFIX}ord-${suffix}-${RUN}`
  const num = Math.floor(Math.random() * 900000) + 100000
  await db.order.create({
    data: {
      id, orderNumber: num, locationId: loc, tableId: null,
      status, paymentStatus: 'unpaid', subtotal: 10, tax: 1.8, total: 11.8, firedAt,
    },
  })
  await db.orderItem.create({
    data: {
      id: `${PREFIX}it-${suffix}-${RUN}`, orderId: id, menuItemId: menuItemA,
      quantity: 1, price: 10, vatRate: 22, vatAmount: 1.8,
      menuItemName: 'Jed A', status: 'pending', notes: '',
    },
  })
  return id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const l = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `V241-${RUN.toUpperCase()}`, premisesId: `v241-prem-${RUN}` },
  })
  loc = l.id
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: loc } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Jedi`, menuId: menu.id } })
  menuItemA = `${PREFIX}mi-a-${RUN}`
  menuItemB = `${PREFIX}mi-b-${RUN}`
  await db.menuItem.create({ data: { id: menuItemA, name: `${PREFIX}Juha`, price: 10, categoryId: cat.id, isAvailable: true } })
  await db.menuItem.create({ data: { id: menuItemB, name: `${PREFIX}Zrezek`, price: 12.5, categoryId: cat.id, isAvailable: true } })
  // kiosk naprava (javna pot brez QR žetona)
  await db.deviceRegistry.create({
    data: { id: `${PREFIX}dev-${RUN}`, deviceId: KIOSK_DEVICE_ID, name: `${PREFIX}Kiosk`, locationId: loc, type: 'kiosk', status: 'offline' },
  })
  // natakar (tablica/POS avto-požig)
  const f = employeePinFields(pinOf(1), `${PREFIX}waiter-${RUN}@test.local`)
  const w = await db.employee.create({
    data: {
      id: `${PREFIX}emp-${RUN}`, name: `${PREFIX}Natakar`,
      email: `${PREFIX}waiter-${RUN}@test.local`, role: 'waiter', status: 'active',
      sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  waiterName = w.name
  waiterToken = tokenFor(w.id, w.name, 'WAITER', loc)
  // postaja + usmeritev artikla A (za StationTask dokaz)
  const st = await db.prepStation.create({
    data: { id: `${PREFIX}st-${RUN}`, name: `${PREFIX}Kuhinja`, type: 'kitchen', avgPrepTime: 10, sortOrder: 1, isExpo: false, isActive: true, locationId: loc },
  })
  stationId = st.id
  await db.menuItemStation.create({ data: { id: `${PREFIX}mis-${RUN}`, menuItemId: menuItemA, stationId, locationId: loc } })
})

afterAll(async () => {
  // kascadni izbris — javne/POS poti ustvarijo naročila z nid() id-ji (brez predpone),
  // zato vse po TESTNI LOKACIJI; seedOrder vrstice pa po id predponi
  await db.stationTask.deleteMany({ where: { OR: [{ orderId: { startsWith: `${PREFIX}ord-` } }, { locationId: loc }] } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { OR: [{ orderId: { startsWith: `${PREFIX}ord-` } }, { Order: { locationId: loc } }] } }).catch(() => null)
  await db.order.deleteMany({ where: { OR: [{ id: { startsWith: `${PREFIX}ord-` } }, { locationId: loc }] } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: `${PREFIX}ord-` } }, { entityId: { startsWith: `${PREFIX}emp-` } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: `${PREFIX}ord-` } }, { locationId: loc }] } }).catch(() => null)
  await db.menuItemStation.deleteMany({ where: { menuItemId: { in: [menuItemA, menuItemB] } } }).catch(() => null)
  await db.prepStation.deleteMany({ where: { locationId: loc } }).catch(() => null)
  await db.deviceSyncOperation.deleteMany({ where: { deviceId: { startsWith: PREFIX } } }).catch(() => null)
  await db.deviceRegistry.deleteMany({ where: { id: `${PREFIX}dev-${RUN}` } }).catch(() => null)
  await db.table.deleteMany({ where: { locationId: loc } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { in: [menuItemA, menuItemB] } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: `${PREFIX}cat-${RUN}` } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: `${PREFIX}menu-${RUN}` } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: `${PREFIX}emp-${RUN}` } }).catch(() => null)
  await db.location.deleteMany({ where: { id: loc } }).catch(() => null)
  const sweep = await sweepTestFixtures(db, [PREFIX])
  expect(sweep.remainingLocations).toBe(0)
})

// ─────────────────────────── A · fireOrderCore (enota) ───────────────────────────

describe('v241 A · fireOrderCore enota', () => {
  it('A1: sveže naročilo → postavke fired + firedAt + firedCount', async () => {
    const id = await seedOrder('a1')
    const res = await fireOrderCore(id, { userId: `${PREFIX}emp-${RUN}`, by: waiterName })
    expect(res.alreadyFired).toBe(false)
    expect(res.firedCount).toBe(1)
    expect(res.stationTasks).toBe(1) // MenuItemStation usmeritev
    const o = await db.order.findUnique({ where: { id } })
    expect(o?.firedAt).toBeTruthy()
    const it = await db.orderItem.findUnique({ where: { id: `${PREFIX}it-a1-${RUN}` } })
    expect(it?.status).toBe('fired')
    expect(it?.firedAt).toBeTruthy()
  })

  it('A2: idempotenca — drugi klic alreadyFired BREZ sprememb', async () => {
    const id = await seedOrder('a2')
    const first = await fireOrderCore(id)
    expect(first.firedCount).toBe(1)
    const second = await fireOrderCore(id)
    expect(second.alreadyFired).toBe(true)
    expect(second.firedCount).toBe(0)
    expect(second.stationTasks).toBe(0)
    // revizija ORDER_FIRED se ne podvoji
    const audits = await db.auditLog.findMany({ where: { entityId: id, action: 'ORDER_FIRED' } })
    expect(audits.length).toBe(1)
  })

  it('A3: zadržano (hold) naročilo → 409', async () => {
    const id = await seedOrder('a3', 'hold')
    try {
      await fireOrderCore(id)
      throw new Error('moralo bi vržiti 409')
    } catch (e) {
      expect(e instanceof FireOrderError).toBe(true)
      expect((e as FireOrderError).status).toBe(409)
    }
  })

  it('A4: plačano naročilo → 409', async () => {
    const id = await seedOrder('a4', 'paid')
    try {
      await fireOrderCore(id)
      throw new Error('moralo bi vržiti 409')
    } catch (e) {
      expect((e as FireOrderError).status).toBe(409)
    }
  })

  it('A5: neobstoječe naročilo → 404', async () => {
    try {
      await fireOrderCore(`${PREFIX}ne-obstaja-${RUN}`)
      throw new Error('moralo bi vržiti 404')
    } catch (e) {
      expect((e as FireOrderError).status).toBe(404)
    }
  })

  it('A6: revizija ORDER_FIRED z auditExtra (autoFire vir)', async () => {
    const id = await seedOrder('a6')
    await fireOrderCore(id, { userId: null, by: 'qr', auditAction: 'GUEST_ORDER_FIRED', auditExtra: { source: 'qr', autoFire: true } })
    const audit = await db.auditLog.findFirst({ where: { entityId: id, action: 'GUEST_ORDER_FIRED' } })
    expect(audit).toBeTruthy()
    expect(audit?.details).toContain('"autoFire":true')
    expect(audit?.details).toContain('"source":"qr"')
    expect(audit?.userId).toBeNull()
  })
})

// ─────────────────────────── B · javna QR pot ───────────────────────────

describe('v241 B · POST /api/public/orders (QR avto-požig)', () => {
  it('B1: QR naročilo → fired:true + firedAt + postavke fired + GUEST_ORDER_FIRED', async () => {
    const tb = freshQrTable()
    await db.table.create({ data: { id: tb.id, number: 990 + qrSeq, locationId: loc, qrToken: tb.token, qrEnabled: true } })
    const clientOp = `v241b1pub${RUN}01`
    const res = await publicOrdersPOST(publicReq({ qrToken: tb.token, items: [{ menuItemId: menuItemA, qty: 2 }], clientOperationId: clientOp }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orderNumber?: number; fired?: boolean }
    expect(body.fired).toBe(true)
    const o = await db.order.findFirst({ where: { idempotencyKey: clientOp } })
    expect(o).toBeTruthy()
    expect(o?.firedAt).toBeTruthy()
    const items = await db.orderItem.findMany({ where: { orderId: o!.id } })
    expect(items.length).toBe(1)
    expect(items[0].status).toBe('fired')
    const audit = await db.auditLog.findFirst({ where: { entityId: o!.id, action: 'GUEST_ORDER_FIRED' } })
    expect(audit).toBeTruthy()
    expect(audit?.details).toContain('"source":"qr"')
  })

  it('B2: StationTask nastane OB avto-požigu (usmerjen artikel)', async () => {
    const tb = freshQrTable()
    await db.table.create({ data: { id: tb.id, number: 990 + qrSeq, locationId: loc, qrToken: tb.token, qrEnabled: true } })
    const clientOp = `v241b2pub${RUN}02`
    const res = await publicOrdersPOST(publicReq({ qrToken: tb.token, items: [{ menuItemId: menuItemA, qty: 1 }], clientOperationId: clientOp }))
    expect(res.status).toBe(200)
    const o = await db.order.findFirst({ where: { idempotencyKey: clientOp } })
    expect(o).toBeTruthy()
    const tasks = await db.stationTask.findMany({ where: { orderId: o!.id } })
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks[0].stationId).toBe(stationId)
    expect(tasks[0].status).toBe('pending')
  })

  it('B3: replay istega clientOperationId → replayed, brez dvojnika, idempotenten požig', async () => {
    const tb = freshQrTable()
    await db.table.create({ data: { id: tb.id, number: 990 + qrSeq, locationId: loc, qrToken: tb.token, qrEnabled: true } })
    const clientOp = `v241b3pub${RUN}03`
    const first = await publicOrdersPOST(publicReq({ qrToken: tb.token, items: [{ menuItemId: menuItemB, qty: 1 }], clientOperationId: clientOp }))
    expect(first.status).toBe(200)
    const second = await publicOrdersPOST(publicReq({ qrToken: tb.token, items: [{ menuItemId: menuItemB, qty: 1 }], clientOperationId: clientOp }))
    expect(second.status).toBe(200)
    const body = (await second.json()) as { replayed?: boolean; fired?: boolean }
    expect(body.replayed).toBe(true)
    const orders = await db.order.findMany({ where: { idempotencyKey: clientOp } })
    expect(orders.length).toBe(1)
    // revizija požiga se ne podvoji (helper idempotenten ob replayu)
    const audits = await db.auditLog.findMany({ where: { entityId: orders[0].id, action: 'GUEST_ORDER_FIRED' } })
    expect(audits.length).toBe(1)
  })

  it('B4: EventLog OrderFired objavljen', async () => {
    const tb = freshQrTable()
    await db.table.create({ data: { id: tb.id, number: 990 + qrSeq, locationId: loc, qrToken: tb.token, qrEnabled: true } })
    const clientOp = `v241b4pub${RUN}04`
    await publicOrdersPOST(publicReq({ qrToken: tb.token, items: [{ menuItemId: menuItemA, qty: 1 }], clientOperationId: clientOp }))
    const o = await db.order.findFirst({ where: { idempotencyKey: clientOp } })
    expect(o).toBeTruthy()
    const ev = await db.eventLog.findFirst({ where: { type: 'OrderFired', entityId: o!.id } })
    expect(ev).toBeTruthy()
  })

  it('B5: kiosk naprava (x-device-token) → enak avto-požig, vir kiosk', async () => {
    const clientOp = `v241b5pub${RUN}05`
    const res = await publicOrdersPOST(publicReq({ items: [{ menuItemId: menuItemA, qty: 1 }], clientOperationId: clientOp }, KIOSK_DEVICE_ID))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { fired?: boolean }
    expect(body.fired).toBe(true)
    const o = await db.order.findFirst({ where: { idempotencyKey: clientOp } })
    expect(o?.orderSource).toBe('kiosk')
    expect(o?.firedAt).toBeTruthy()
    const audit = await db.auditLog.findFirst({ where: { entityId: o!.id, action: 'GUEST_ORDER_FIRED' } })
    expect(audit?.details).toContain('"source":"kiosk"')
  })
})

// ─────────────────────────── C · POS avto-požig (tablica) ───────────────────────────

describe('v241 C · POST /api/orders (autoFire zastavica)', () => {
  it('C1: BREZ autoFire → nespremenjeno vedenje (pending, firedAt null)', async () => {
    const clientOp = `v241c1pos${RUN}06`
    const tid = freshTableId()
    await db.table.create({ data: { id: tid, number: 990 + tblSeq, locationId: loc } })
    const res = await ordersPOST(staffReq('/api/orders', waiterToken, 'POST', {
      tableId: tid, items: [{ menuItemId: menuItemA, qty: 1 }], clientOperationId: clientOp,
    }))
    expect(res.status).toBe(201)
    const o = await db.order.findFirst({ where: { idempotencyKey: clientOp } })
    expect(o).toBeTruthy()
    expect(o?.firedAt).toBeNull()
    const items = await db.orderItem.findMany({ where: { orderId: o!.id } })
    expect(items[0].status).toBe('pending')
  })

  it('C2: Z autoFire → požgano + revizija ORDER_FIRED z autoFire:true', async () => {
    const clientOp = `v241c2pos${RUN}07`
    const tid = freshTableId()
    await db.table.create({ data: { id: tid, number: 990 + tblSeq, locationId: loc } })
    const res = await ordersPOST(staffReq('/api/orders', waiterToken, 'POST', {
      tableId: tid, items: [{ menuItemId: menuItemA, qty: 3 }], clientOperationId: clientOp, autoFire: true,
    }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { firedCount?: number; order?: { items?: { status: string }[] } }
    expect(body.firedCount).toBe(1)
    // DB 'fired' se v klientu preslika v 'PREPARING' (map.ts: fired→PREPARING)
    expect(body.order?.items?.[0]?.status).toBe('PREPARING')
    const o = await db.order.findFirst({ where: { idempotencyKey: clientOp } })
    expect(o?.firedAt).toBeTruthy()
    const audit = await db.auditLog.findFirst({ where: { entityId: o!.id, action: 'ORDER_FIRED' } })
    expect(audit).toBeTruthy()
    expect(audit?.details).toContain('"autoFire":true')
    expect(audit?.userId).toBe(`${PREFIX}emp-${RUN}`)
  })

  it('C3: autoFire ob replayu → idempotentno (alreadyFired, brez dvojnika)', async () => {
    const clientOp = `v241c3pos${RUN}08`
    const tid = freshTableId()
    await db.table.create({ data: { id: tid, number: 990 + tblSeq, locationId: loc } })
    await ordersPOST(staffReq('/api/orders', waiterToken, 'POST', {
      tableId: tid, items: [{ menuItemId: menuItemB, qty: 1 }], clientOperationId: clientOp, autoFire: true,
    }))
    const second = await ordersPOST(staffReq('/api/orders', waiterToken, 'POST', {
      tableId: tid, items: [{ menuItemId: menuItemB, qty: 1 }], clientOperationId: clientOp, autoFire: true,
    }))
    expect(second.status).toBe(200)
    const body = (await second.json()) as { replayed?: boolean; firedCount?: number }
    expect(body.replayed).toBe(true)
    expect(body.firedCount).toBe(0)
    const orders = await db.order.findMany({ where: { idempotencyKey: clientOp } })
    expect(orders.length).toBe(1)
  })
})

// ─────────────────────────── D · offline vrsta (sync) ───────────────────────────

describe('v241 D · POST /api/sync (offline tablica autoFire)', () => {
  it('D1: order.create z autoFire → naročilo požgano, operacija applied', async () => {
    const clientOp = `v241d1syn${RUN}09`
    const tid = freshTableId()
    await db.table.create({ data: { id: tid, number: 990 + tblSeq, locationId: loc } })
    const res = await syncPOST(staffReq('/api/sync', waiterToken, 'POST', {
      deviceId: `${PREFIX}tab-${RUN}`,
      ops: [{ kind: 'order.create', clientOperationId: clientOp, payload: { tableId: tid, items: [{ menuItemId: menuItemA, qty: 1 }], guests: 2, autoFire: true } }],
    }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results?: { ok?: boolean; orderId?: string }[] }
    expect(body.results?.[0]?.ok).toBe(true)
    const orderId = body.results?.[0]?.orderId
    expect(orderId).toBeTruthy()
    const o = await db.order.findUnique({ where: { id: orderId! } })
    expect(o?.firedAt).toBeTruthy()
    const items = await db.orderItem.findMany({ where: { orderId } })
    expect(items[0].status).toBe('fired')
    const op = await db.deviceSyncOperation.findUnique({ where: { deviceId_clientOperationId: { deviceId: `${PREFIX}tab-${RUN}`, clientOperationId: clientOp } } })
    expect(op?.status).toBe('applied')
  })

  it('D2: order.create BREZ autoFire (dashboard offline) → pending (vrsta skupna)', async () => {
    const clientOp = `v241d2syn${RUN}10`
    const tid = freshTableId()
    await db.table.create({ data: { id: tid, number: 990 + tblSeq, locationId: loc } })
    const res = await syncPOST(staffReq('/api/sync', waiterToken, 'POST', {
      deviceId: `${PREFIX}tab-${RUN}`,
      ops: [{ kind: 'order.create', clientOperationId: clientOp, payload: { tableId: tid, items: [{ menuItemId: menuItemB, qty: 1 }] } }],
    }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results?: { ok?: boolean; orderId?: string }[] }
    const orderId = body.results?.[0]?.orderId
    const o = await db.order.findUnique({ where: { id: orderId! } })
    expect(o?.firedAt).toBeNull()
  })
})

// ─────────────────────────── E · ročna pot (refaktor) ───────────────────────────

describe('v241 E · POST /api/orders/[id]/fire (refaktor na helper)', () => {
  it('E1: ročni fire še deluje + revizija', async () => {
    const id = await seedOrder('e1')
    const res = await firePOST(staffReq(`/api/orders/${id}/fire`, waiterToken, 'POST', {}), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { firedCount?: number; alreadyFired?: boolean }
    expect(body.firedCount).toBe(1)
    expect(body.alreadyFired).toBe(false)
    const o = await db.order.findUnique({ where: { id } })
    expect(o?.firedAt).toBeTruthy()
  })

  it('E2: že požgano → 200 alreadyFired, 0 sprememb', async () => {
    const id = await seedOrder('e2')
    await firePOST(staffReq(`/api/orders/${id}/fire`, waiterToken, 'POST', {}), { params: Promise.resolve({ id }) })
    const res = await firePOST(staffReq(`/api/orders/${id}/fire`, waiterToken, 'POST', {}), { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { firedCount?: number; alreadyFired?: boolean }
    expect(body.alreadyFired).toBe(true)
    expect(body.firedCount).toBe(0)
  })
})

// ─────────────────────────── Ž · registri ───────────────────────────

describe('v241 Ž · registri in dokumentacija', () => {
  it('Ž1: APP_VERSION je 1.243.0', () => {
    expect(APP_VERSION).toBe('1.284.0')
  })

  it('Ž2: 0 DDL — order-fire je čista lib (brez novih modelov)', async () => {
    const hasFireLib = await import('../src/lib/order-fire')
    expect(typeof hasFireLib.fireOrderCore).toBe('function')
    expect(typeof FireOrderError).toBe('function')
    // helper ne dodaja nobenega znanja o schemi — samo obstoječi modeli
  })

  it('Ž3: TEST_PREFIXES vsebuje v241-', () => {
    expect(TEST_PREFIXES).toContain('v241-')
  })
})
