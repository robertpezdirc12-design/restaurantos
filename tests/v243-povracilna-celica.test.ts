import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid, num } from '@/lib/map'
import { gcTxSign } from '../src/lib/giftcards'
import { APP_VERSION } from '../src/lib/version'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as checksPOST } from '../src/app/api/orders/[id]/checks/route'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { POST as stornoPOST } from '../src/app/api/receipts/[id]/storno/route'

/**
 * v1.243.0 — POVRAČILNA CELICA (docs/PRIMERJAVA-VMESNIKOV-2026 §17).
 *
 * Nadaljevanje računske celice (v1.239.0 §16 B: storno negira Payment vrstice).
 * Ta val zapre vrzel, ki jo je računska celica pustila pri INSTRUMENTIH:
 * negacija Payment vrstice je računovodski sloj — ob plačilu so se sredstva
 * GIBALA tudi po vrednostnih instrumentih, storno pa jih ni vrnil:
 *
 *  A) darilna kartica: unovčenje je odbilo saldo (CAS + GC 'redeem'), storno
 *     NI vrnil sredstev na kartico — gostu je vrednost izginila (Toast:
 *     refund returns funds to the ORIGINAL tender).
 *  B) unovčene točke: odjem je znižal pointsBalance (CAS + LT 'redeem'),
 *     storno točk NI vrnil — plačilo s točkami je bilo nepovratno.
 *  C) zaslužene točke: earn ob plačilu je povečal balance + lifetime + tier,
 *     storno zaslužka NI negiral — gost je obdržal točke za VRNJENO blago.
 *  D) kupon: odkup je status 'redeedmed' za vedno — ob polnem povračilu
 *     naročila kupon ostane porabljen, čeprav popusta ni bil nikoli izkoristil.
 *  E) sledljivost: zrcalne Payment vrstice niso nosile giftCardId /
 *     loyaltyAccountId / loyaltyPointsUsed — instrument na negativni vrstici
 *     ni bil identificiran.
 *
 * 0 DDL · 0 odvisnosti · 0 novih i18n ključev (sporočila strežniška SL).
 */

const PREFIX = 'v243-'
const TS = Date.now()

const read = (p: string) => readFileSync(p, 'utf8')
const stornoSrc = read('src/app/api/receipts/[id]/storno/route.ts')
const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/* ── fiksture ── */
let locA = ''
let mgrA = ''
let ownA = ''
let tokMgr = ''
let tokOwn = ''
let itemPiva = ''
let itemJedi = ''
let table1 = ''
let guestId = ''

/** Reverse-FK čiščenje (idempotentno — beforeAll IN afterAll). */
async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { code: { startsWith: `${PREFIX}-` } } })
  const locIds = locs.map((l) => l.id)
  for (const locId of locIds) {
    const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const o of orders) {
      const items = await db.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.orderItemModifier.deleteMany({ where: { orderItemId: { in: items.map((i) => i.id) } } }).catch(() => null)
      const stx = await db.stockTransaction.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.stockBatchAllocation.deleteMany({ where: { stockTransactionId: { in: stx.map((t) => t.id) } } }).catch(() => null)
      const checks = await db.check.findMany({ where: { orderId: o.id }, select: { id: true } })
      for (const c of checks) {
        await db.giftCardTransaction.deleteMany({ where: { checkId: c.id } }).catch(() => null)
        await db.loyaltyTransaction.deleteMany({ where: { checkId: c.id } }).catch(() => null)
      }
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { OR: [{ entityId: o.id }, { details: { contains: PREFIX } }] } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.stockTransaction.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.orderItem.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.order.deleteMany({ where: { id: o.id } }).catch(() => null)
    }
    const tables = await db.table.findMany({ where: { locationId: locId }, select: { id: true } })
    await db.eventLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    // v1.299.0 (13. reset — najdba klasifikacije): INVOICE_ISSUE piše AuditLog z
    // entityId = RECEIPT id (ne orderId) in details BREZ predpone (maskirana GC
    // številka) → ozki per-order filter ({entityId: o.id} / {details: PREFIX})
    // ju ne vidi; publishEvent piše EventLog (InvoiceCreated) z nid() id-jem in
    // predpono SAMO v locationId. Ker spodaj lokacijo izbrišemo, ju kasnejši
    // široki sweep ne more ujeti več (kaskada locationId v sweepu potrebuje ŽIVO
    // vrstico Location s predponskim imenom — izteg v1.283.0, tu apliciran na
    // ozki čistilec). NAKLJUČNA VAROSTNA MREŽA (razkrita v1.299.0): AuditLog
    // details vsebujejo ključ "stockDeduction" — Prisma SQLite contains se
    // prevaja v CASE-INSENSITIVE LIKE, zato predpona 'stockded' (stock-deduction)
    // UJAME te vrstice, A LE če široki sweep teče ZA tem testom (readdir red);
    // EventLog payload nima tega ključa → ni ujet NIKOLI (kumulacija +22/tek
    // v243+v249+v239, prej napačno pripisana kot »demo-realna rast«). Zato
    // briši po locationId DOKLER lokacija še živi — deterministično, brez
    // odvisnosti od vrstnega reda datotek.
    await db.auditLog.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.eventLog.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.table.deleteMany({ where: { locationId: locId } }).catch(() => null)
    const menus = await db.menu.findMany({ where: { locationId: locId }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.menuItemModifierGroup.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
    // instrumenti fiksture: darilne kartice, računi zvestobe, kuponi, gostje
    const gcs = await db.giftCard.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const g of gcs) {
      await db.giftCardTransaction.deleteMany({ where: { giftCardId: g.id } }).catch(() => null)
    }
    await db.giftCard.deleteMany({ where: { id: { in: gcs.map((g) => g.id) } } }).catch(() => null)
    const las = await db.loyaltyAccount.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const a of las) {
      await db.loyaltyTransaction.deleteMany({ where: { loyaltyAccountId: a.id } }).catch(() => null)
    }
    await db.loyaltyAccount.deleteMany({ where: { id: { in: las.map((a) => a.id) } } }).catch(() => null)
    await db.coupon.deleteMany({ where: { locationId: locId } }).catch(() => null)
    if (guestId) await db.guest.deleteMany({ where: { id: guestId } }).catch(() => null)
    await db.employee.deleteMany({ where: { locationId: locId } }).catch(() => null)
    // v1.288.0: tudi števec naročil (nextSequence ga ustvari za vsako lokacijo z API-naročili; izmerjeno 49 mrtvih 'order:<nid>' — lokacijski dokaz za 0a izteg je bil izbrisan prej)
    await db.counter.deleteMany({ where: { name: { in: [`receipt:${locId}`, `order:${locId}`] } } }).catch(() => null)
    await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
  }
}

/** Ponastavi naročila med skupinami (vsak test ustvari sveže naročilo). */
async function resetOrders() {
  const orders = await db.order.findMany({ where: { locationId: locA }, select: { id: true } })
  for (const o of orders) {
    const items = await db.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } })
    await db.orderItemModifier.deleteMany({ where: { orderItemId: { in: items.map((i) => i.id) } } }).catch(() => null)
    const checks = await db.check.findMany({ where: { orderId: o.id }, select: { id: true } })
    for (const c of checks) {
      await db.giftCardTransaction.deleteMany({ where: { checkId: c.id } }).catch(() => null)
      await db.loyaltyTransaction.deleteMany({ where: { checkId: c.id } }).catch(() => null)
    }
    await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
    await db.eventLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
    await db.check.deleteMany({ where: { orderId: o.id } }).catch(() => null)
    await db.receipt.deleteMany({ where: { orderId: o.id } }).catch(() => null)
    await db.stockTransaction.deleteMany({ where: { orderId: o.id } }).catch(() => null)
    await db.orderItem.deleteMany({ where: { orderId: o.id } }).catch(() => null)
    await db.order.deleteMany({ where: { id: o.id } }).catch(() => null)
  }
  await db.table.updateMany({ where: { locationId: locA }, data: { status: 'available' } })
}

/** Sveže naročilo s pivo + jedjo (skupaj 11,50 €). */
async function freshOrder(): Promise<string> {
  const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
    tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }, { menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
  }))
  expect(created.status).toBe(201)
  const co = (await created.json()) as { order: { id: string } }
  return co.order.id
}

/** Darilna kartica fiksture z dano vrednostjo. */
async function giftCard(balance: number, cardNumber: string): Promise<string> {
  const id = nid()
  await db.giftCard.create({
    data: { id, cardNumber, balance, initialBalance: balance, status: 'active', ownerName: `${PREFIX} Gost`, locationId: locA },
  })
  await db.giftCardTransaction.create({
    data: { id: nid(), giftCardId: id, type: 'issue', amount: balance, balanceAfter: balance, note: `${PREFIX} izdaja` },
  })
  return id
}

/** Plačaj naročilo prek /api/furs in vrni id računa. */
async function payOrder(oId: string, body: Record<string, unknown>, key: string): Promise<string> {
  const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', { orderId: oId, ...body, clientOperationId: `${PREFIX}-${key}-${TS}` }))
  expect(paid.status).toBe(201)
  const inv = (await paid.json()) as { invoice: { id: string } }
  return inv.invoice.id
}

/** Storniraj račun (razlog po politiki #19). */
async function storno(receiptId: string, reason: string) {
  return stornoPOST(
    req(`/api/receipts/${receiptId}/storno`, tokOwn, 'POST', { reason }),
    { params: Promise.resolve({ id: receiptId }) },
  )
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  await cleanupFixtures()

  locA = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: `BLGV243A${TS}`,
      taxId: 'SI12345678', registerNumber: 'BLG-V243-01A', country: 'SI', timezone: 'Europe/Ljubljana',
      loyaltyEnabled: true, loyaltyPointsPerEuro: 1, loyaltyPointsValue: 0.01 },
  })).id
  mgrA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Vodja A`, email: `${PREFIX}-mgr-a-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-ma-${TS}`, locationId: locA },
  })).id
  tokMgr = createToken({ sub: mgrA, name: `${PREFIX} Vodja A`, role: 'MANAGER', loc: locA, sv: 0 })
  ownA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Lastnik A`, email: `${PREFIX}-own-a-${TS}@test.local`, role: 'owner', pin: `${PREFIX}-pin-oa-${TS}`, locationId: locA },
  })).id
  tokOwn = createToken({ sub: ownA, name: `${PREFIX} Lastnik A`, role: 'OWNER', loc: locA, sv: 0 })
  guestId = (await db.guest.create({ data: { id: nid(), lastName: `${PREFIX} Gost`, email: `${PREFIX}-gost-${TS}@test.local` } })).id

  const menuA = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const catA = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuA } })).id
  itemPiva = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Piva`, price: 3.5, categoryId: catA, vatRate: 22 } })).id
  itemJedi = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Jedi`, price: 8, categoryId: catA, vatRate: 22 } })).id
  table1 = (await db.table.create({ data: { id: nid(), number: 93, capacity: 4, locationId: locA, status: 'available' } })).id
})

afterAll(async () => {
  await cleanupFixtures()
  await sweepTestFixtures(db, [PREFIX])
})

/* ─────────── A — darilna kartica: storno vrne sredstva NA KARTICO ─────────── */

describe('v1.243.0 A — storno povrne saldo darilne kartice', () => {
  test('A1: plačilo 10 € z darilno kartico + 1,50 gotovine → storno vrne 10 € NA KARTICO', async () => {
    await resetOrders()
    const gcId = await giftCard(10, `GC-${PREFIX}-A1-${TS}`)
    const oId = await freshOrder()

    const rid = await payOrder(oId, {
      parts: [{ type: 'giftcard', amount: 10, giftCardId: gcId }, { type: 'cash', amount: 1.5 }],
    }, 'a1')

    // plačilo je odbilo saldo (10 → 0) in zapisalo 'redeem' vrstico
    const mid = await db.giftCard.findUnique({ where: { id: gcId } })
    expect(num(mid?.balance)).toBe(0)
    expect(await db.giftCardTransaction.count({ where: { giftCardId: gcId, type: 'redeem' } })).toBe(1)

    const res = await storno(rid, `${PREFIX} testni storno A1`)
    expect(res.status).toBe(201)
    const j = (await res.json()) as { storno: { valueRefunds: { giftCards: number; giftCardTotal: number } } }
    expect(j.storno.valueRefunds.giftCards).toBe(1)
    expect(j.storno.valueRefunds.giftCardTotal).toBe(10)

    // saldo je NAZAJ na kartici
    const after = await db.giftCard.findUnique({ where: { id: gcId } })
    expect(num(after?.balance)).toBe(10)
    // 'refund' vrstica: pozitiven znesek (konvencija gcTxSign), balanceAfter 10
    const refundRow = await db.giftCardTransaction.findFirst({ where: { giftCardId: gcId, type: 'refund' } })
    expect(refundRow).toBeTruthy()
    expect(num(refundRow?.amount)).toBe(10)
    expect(num(refundRow?.balanceAfter)).toBe(10)
    expect(refundRow?.orderId).toBe(oId)
    // ledžer invarianta: vsota podpisanih zneskov = saldo (10 izdaja − 10 redeem + 10 refund = 10)
    const all = await db.giftCardTransaction.findMany({ where: { giftCardId: gcId } })
    const ledger = all.reduce((s, t) => s + num(t.amount), 0)
    expect(Math.round(ledger * 100)).toBe(Math.round(num(after?.balance) * 100))
  })

  test('A2: dve kartici v enem plačilu → storno vrne OBE', async () => {
    await resetOrders()
    const gc1 = await giftCard(5, `GC-${PREFIX}-A2a-${TS}`)
    const gc2 = await giftCard(5, `GC-${PREFIX}-A2b-${TS}`)
    const oId = await freshOrder()

    const rid = await payOrder(oId, {
      parts: [{ type: 'giftcard', amount: 5, giftCardId: gc1 }, { type: 'giftcard', amount: 5, giftCardId: gc2 }, { type: 'cash', amount: 1.5 }],
    }, 'a2')

    const res = await storno(rid, `${PREFIX} testni storno A2`)
    expect(res.status).toBe(201)
    const j = (await res.json()) as { storno: { valueRefunds: { giftCards: number; giftCardTotal: number } } }
    expect(j.storno.valueRefunds.giftCards).toBe(2)
    expect(j.storno.valueRefunds.giftCardTotal).toBe(10)
    expect(num((await db.giftCard.findUnique({ where: { id: gc1 } }))?.balance)).toBe(5)
    expect(num((await db.giftCard.findUnique({ where: { id: gc2 } }))?.balance)).toBe(5)
  })

  test('A3: izbrisana kartica → fail-open: storno uspe, opomba v odgovoru, računovodstvo pravilno', async () => {
    await resetOrders()
    const gcId = await giftCard(10, `GC-${PREFIX}-A3-${TS}`)
    const oId = await freshOrder()
    const rid = await payOrder(oId, {
      parts: [{ type: 'giftcard', amount: 10, giftCardId: gcId }, { type: 'cash', amount: 1.5 }],
    }, 'a3')

    // kartica umre PRED stornom (transakcije + kartica; Payment.giftCardId → SetNull)
    await db.giftCardTransaction.deleteMany({ where: { giftCardId: gcId } })
    await db.giftCard.deleteMany({ where: { id: gcId } })

    const res = await storno(rid, `${PREFIX} testni storno A3`)
    expect(res.status).toBe(201)
    const j = (await res.json()) as { storno: { valueRefunds: { giftCards: number; notes?: string[] } } }
    // instrumenta NI bilo mogoče povrniti — iskrena opomba, ne tiha izguba
    expect(j.storno.valueRefunds.giftCards).toBe(0)
    expect(j.storno.valueRefunds.notes?.length).toBe(1)
    expect(j.storno.valueRefunds.notes?.[0]).toContain('Darilna kartica')
    // računovodski sloj je kljub temu pravilen: neto 0 na checku
    const check = await db.check.findFirst({ where: { orderId: oId } })
    const rows = await db.payment.findMany({ where: { checkId: check!.id } })
    expect(Math.round(rows.reduce((s, p) => s + num(p.amount), 0) * 100)).toBe(0)
  })

  test('A4: centno-natančna aritmetika — 10,10 − 0,20 + 0,20 = 10,10 (brez REAL drifta)', async () => {
    await resetOrders()
    // kartica 10,10; naročilo 11,50: GC 0,20 + gotovina 11,30
    const gcId = await giftCard(10.1, `GC-${PREFIX}-A4-${TS}`)
    const oId = await freshOrder()

    const rid = await payOrder(oId, {
      parts: [{ type: 'giftcard', amount: 0.2, giftCardId: gcId }, { type: 'cash', amount: 11.3 }],
    }, 'a4')

    const res = await storno(rid, `${PREFIX} testni storno A4`)
    expect(res.status).toBe(201)
    const after = await db.giftCard.findUnique({ where: { id: gcId } })
    expect(Math.round(num(after?.balance) * 100)).toBe(1010)
  })
})

/* ─────────── B — unovčene točke: storno jih vrne na saldo ─────────── */

describe('v1.243.0 B — storno povrne unovčene točke zvestobe', () => {
  test('B1: plačilo s 500 točkami (5 €) → storno vrne točke; saldo/lifetime sta točno rekonstruirana', async () => {
    await resetOrders()
    const accId = nid()
    await db.loyaltyAccount.create({
      data: { id: accId, customerName: `${PREFIX} Zvesti Gost`, customerPhone: '+38640111222', pointsBalance: 500, lifetimePoints: 500, tier: 'silver', isActive: true, locationId: locA },
    })
    const oId = await freshOrder()

    // 500 tk (5 €) + gotovina 6,50 = 11,50
    const rid = await payOrder(oId, {
      loyaltyAccountId: accId, loyaltyPointsUsed: 500, type: 'cash',
    }, 'b1')

    // plačilo: −500 (redeem) + zaslužek floor(11,5 × 1) = 11 → balance 11, lifetime 511
    const mid = await db.loyaltyAccount.findUnique({ where: { id: accId } })
    expect(mid?.pointsBalance).toBe(11)
    expect(mid?.lifetimePoints).toBe(511)

    const res = await storno(rid, `${PREFIX} testni storno B1`)
    expect(res.status).toBe(201)
    const j = (await res.json()) as { storno: { valueRefunds: { redeemedPoints: number; negatedEarnedPoints: number } } }
    expect(j.storno.valueRefunds.redeemedPoints).toBe(500)
    expect(j.storno.valueRefunds.negatedEarnedPoints).toBe(11)

    // PO stornu: točno prvotno stanje (500/500) — redeem povrnjen, earn negiran
    const after = await db.loyaltyAccount.findUnique({ where: { id: accId } })
    expect(after?.pointsBalance).toBe(500)
    expect(after?.lifetimePoints).toBe(500)

    // zrcalni vrstici: redeem +500 (monetaryValue −5) in earn −11 (monetaryValue −11,50)
    const redeemMirror = await db.loyaltyTransaction.findFirst({ where: { loyaltyAccountId: accId, type: 'redeem', points: 500 } })
    expect(redeemMirror).toBeTruthy()
    expect(num(redeemMirror?.monetaryValue)).toBe(-5)
    const earnMirror = await db.loyaltyTransaction.findFirst({ where: { loyaltyAccountId: accId, type: 'earn', points: -11 } })
    expect(earnMirror).toBeTruthy()
    expect(num(earnMirror?.monetaryValue)).toBe(-11.5)
    // ledžer: vsota points vseh vrstic računa = 0 (vsak par se negira)
    const rows = await db.loyaltyTransaction.findMany({ where: { loyaltyAccountId: accId, orderId: oId } })
    expect(rows.reduce((s, r) => s + r.points, 0)).toBe(0)
  })

  test('B2: povračilo točk NE vrača lifetimePoints (odjem ga ni dotaknil)', async () => {
    await resetOrders()
    const accId = nid()
    await db.loyaltyAccount.create({
      data: { id: accId, customerName: `${PREFIX} Gost B2`, pointsBalance: 100, lifetimePoints: 100, isActive: true, locationId: locA },
    })
    const oId = await freshOrder()
    // 100 tk = 1 € + gotovina 10,50
    const rid = await payOrder(oId, { loyaltyAccountId: accId, loyaltyPointsUsed: 100, type: 'cash' }, 'b2')

    const res = await storno(rid, `${PREFIX} testni storno B2`)
    expect(res.status).toBe(201)
    const after = await db.loyaltyAccount.findUnique({ where: { id: accId } })
    // balance: −100 +11 (earn) → 11; storno: +100 −11 → 100 (rekonstrukcija)
    expect(after?.pointsBalance).toBe(100)
    // lifetime: 100 +11 (earn) → 111; storno: −11 → 100 — earn se negira, redeem refund ga NE dotika
    expect(after?.lifetimePoints).toBe(100)
  })
})

/* ─────────── C — zaslužene točke: negacija z tierjem ─────────── */

describe('v1.243.0 C — storno negira zaslužene točke (vrnjeno blago ne zasluži)', () => {
  test('C1: earn prek pragova tierja → negacija vrne tier na prejšnjo stopnjo', async () => {
    await resetOrders()
    const accId = nid()
    // 95 lifetime: earn 11 → 106 = SILVER (≥100); po negaciji nazaj 95 = BRONZE
    await db.loyaltyAccount.create({
      data: { id: accId, customerName: `${PREFIX} Gost C1`, pointsBalance: 95, lifetimePoints: 95, tier: 'bronze', isActive: true, locationId: locA },
    })
    const oId = await freshOrder()
    const rid = await payOrder(oId, { loyaltyAccountId: accId, type: 'cash' }, 'c1')

    const mid = await db.loyaltyAccount.findUnique({ where: { id: accId } })
    expect(mid?.lifetimePoints).toBe(106)
    expect(mid?.tier).toBe('silver')

    const res = await storno(rid, `${PREFIX} testni storno C1`)
    expect(res.status).toBe(201)
    const after = await db.loyaltyAccount.findUnique({ where: { id: accId } })
    expect(after?.pointsBalance).toBe(95)
    expect(after?.lifetimePoints).toBe(95)
    expect(after?.tier).toBe('bronze')
  })

  test('C2: zaslužene točke so bile medtem PORABLJENE → saldo pade NEGATIVNO (dolg)', async () => {
    await resetOrders()
    const accId = nid()
    await db.loyaltyAccount.create({
      data: { id: accId, customerName: `${PREFIX} Gost C2`, pointsBalance: 0, lifetimePoints: 0, isActive: true, locationId: locA },
    })
    const oId = await freshOrder()
    const rid = await payOrder(oId, { loyaltyAccountId: accId, type: 'cash' }, 'c2')

    // earn 11 je na saldu; gost jih medtem porabi (ročna prilagoditev −11)
    await db.loyaltyAccount.update({ where: { id: accId }, data: { pointsBalance: 0 } })
    await db.loyaltyTransaction.create({
      data: { id: nid(), loyaltyAccountId: accId, type: 'redeem', points: -11, reason: `${PREFIX} poraba med štetjem` },
    })

    const res = await storno(rid, `${PREFIX} testni storno C2`)
    expect(res.status).toBe(201)
    const after = await db.loyaltyAccount.findUnique({ where: { id: accId } })
    // 0 − 11 = −11: točke za vrnjeno blago so dolg (unovčenje blokira pogoj >=)
    expect(after?.pointsBalance).toBe(-11)
    expect(after?.lifetimePoints).toBe(0)
  })

  test('C3: ročna prilagoditev (brez checkId) NI dotaknjena z negacijo', async () => {
    await resetOrders()
    const accId = nid()
    await db.loyaltyAccount.create({
      data: { id: accId, customerName: `${PREFIX} Gost C3`, pointsBalance: 50, lifetimePoints: 50, isActive: true, locationId: locA },
    })
    // ročni earn (brez checkId — po veri spreminjanj vodstva, ne plačilo)
    const manualId = nid()
    await db.loyaltyTransaction.create({
      data: { id: manualId, loyaltyAccountId: accId, type: 'earn', points: 50, reason: `${PREFIX} ročna prilagoditev` },
    })
    const oId = await freshOrder()
    const rid = await payOrder(oId, { loyaltyAccountId: accId, type: 'cash' }, 'c3')

    const res = await storno(rid, `${PREFIX} testni storno C3`)
    expect(res.status).toBe(201)
    // ročna vrstica ostaja, njenih točk negacija NI odnesla
    const manual = await db.loyaltyTransaction.findUnique({ where: { id: manualId } })
    expect(manual).toBeTruthy()
    expect(manual?.points).toBe(50)
    // saldo: 50 (seja) + 11 (earn) − 11 (negacija) = 50 — ročne točke NISO odnesene
    const after = await db.loyaltyAccount.findUnique({ where: { id: accId } })
    expect(after?.pointsBalance).toBe(50)
  })
})

/* ─────────── D — kupon: ponovna izdaja ob polnem povračilu ─────────── */

describe('v1.243.0 D — storno ponovno izda kupon ob polnem povračilu', () => {
  /** Kupon fiksture v stanju 'redeemed' na danem naročilu. */
  async function redeemedCoupon(orderId: string, code: string): Promise<string> {
    const id = nid()
    await db.coupon.create({
      data: {
        id, code, guestId, reason: 'manual', percent: 10, status: 'redeemed',
        issuedAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() + 30 * 86_400_000),
        redeemedAt: new Date(), orderId, locationId: locA, note: `${PREFIX} ročna izdaja`,
      },
    })
    return id
  }

  test('D1: polni povračilo enojnega računa → kapon nazaj v issued', async () => {
    await resetOrders()
    const oId = await freshOrder()
    await db.order.update({ where: { id: oId }, data: { discount: 1.15 } })
    const cId = await redeemedCoupon(oId, `${PREFIX}-D1-${TS}`)

    const rid = await payOrder(oId, { type: 'cash' }, 'd1')
    const res = await storno(rid, `${PREFIX} testni storno D1`)
    expect(res.status).toBe(201)
    const j = (await res.json()) as { storno: { valueRefunds: { couponReissued: string | null } } }
    expect(j.storno.valueRefunds.couponReissued).toBe(`${PREFIX}-D1-${TS}`)

    const after = await db.coupon.findUnique({ where: { id: cId } })
    expect(after?.status).toBe('issued')
    expect(after?.redeemedAt).toBeNull()
    expect(after?.orderId).toBeNull()
    expect(after?.note).toContain('Ponovno izdan ob stornu')
    // revizija COUPON_REISSUED obstaja
    const audit = await db.auditLog.findFirst({ where: { action: 'COUPON_REISSUED', entityId: cId } })
    expect(audit).toBeTruthy()
  })

  test('D2: več računov — storno PRVEGA (brat še živ) → kupon OSTANE redeemed', async () => {
    await resetOrders()
    const oId = await freshOrder()
    await db.order.update({ where: { id: oId }, data: { discount: 1.15 } })
    await redeemedCoupon(oId, `${PREFIX}-D2-${TS}`)

    // split na 2 izstavka (piva / jedi)
    const items = await db.orderItem.findMany({ where: { orderId: oId } })
    const jedi = items.find((i) => i.menuItemId === itemJedi)!
    const split = await checksPOST(req(`/api/orders/${oId}/checks`, tokMgr, 'POST', { itemIds: [jedi.id] }), { params: Promise.resolve({ id: oId }) })
    expect(split.status).toBe(200)
    const checks = await db.check.findMany({ where: { orderId: oId }, orderBy: { checkNumber: 'asc' } })
    expect(checks.length).toBe(2)

    const r1 = await payOrder(oId, { checkId: checks[0].id, type: 'cash' }, 'd2a')
    const r2 = await payOrder(oId, { checkId: checks[1].id, type: 'cash' }, 'd2b')

    // storno PRVEGA: drugi račun še živi → kupon ne
    const res1 = await storno(r1, `${PREFIX} testni storno D2 prvi`)
    expect(res1.status).toBe(201)
    const j1 = (await res1.json()) as { storno: { valueRefunds: { couponReissued: string | null } }; order: { paymentStatus: string } }
    expect(j1.storno.valueRefunds.couponReissued).toBeNull()
    expect(j1.order.paymentStatus).toBe('paid')
    const mid = await db.coupon.findFirst({ where: { code: `${PREFIX}-D2-${TS}` } })
    expect(mid?.status).toBe('redeemed')

    // storno ZADNJEGA: živih računov ni več → kupon se izda nazaj
    const res2 = await storno(r2, `${PREFIX} testni storno D2 drugi`)
    expect(res2.status).toBe(201)
    const j2 = (await res2.json()) as { storno: { valueRefunds: { couponReissued: string | null } } }
    expect(j2.storno.valueRefunds.couponReissued).toBe(`${PREFIX}-D2-${TS}`)
    const after = await db.coupon.findFirst({ where: { code: `${PREFIX}-D2-${TS}` } })
    expect(after?.status).toBe('issued')
    expect(after?.orderId).toBeNull()
  })

  test('D3: delno plačano naročilo (odprt izstavek) → kupon OSTANE redeemed', async () => {
    await resetOrders()
    const oId = await freshOrder()
    await db.order.update({ where: { id: oId }, data: { discount: 1.15 } })
    await redeemedCoupon(oId, `${PREFIX}-D3-${TS}`)

    const items = await db.orderItem.findMany({ where: { orderId: oId } })
    const jedi = items.find((i) => i.menuItemId === itemJedi)!
    const split = await checksPOST(req(`/api/orders/${oId}/checks`, tokMgr, 'POST', { itemIds: [jedi.id] }), { params: Promise.resolve({ id: oId }) })
    expect(split.status).toBe(200)
    const checks = await db.check.findMany({ where: { orderId: oId }, orderBy: { checkNumber: 'asc' } })

    // plačaj SAMO izstavek #1 → naročilo 'partial' (izstavek #2 odprt)
    const rid = await payOrder(oId, { checkId: checks[0].id, type: 'cash' }, 'd3')
    const res = await storno(rid, `${PREFIX} testni storno D3`)
    expect(res.status).toBe(201)
    const j = (await res.json()) as { storno: { valueRefunds: { couponReissued: string | null } }; order: { paymentStatus: string } }
    expect(j.order.paymentStatus).toBe('partial')
    expect(j.storno.valueRefunds.couponReissued).toBeNull()
    const after = await db.coupon.findFirst({ where: { code: `${PREFIX}-D3-${TS}` } })
    expect(after?.status).toBe('redeemed')
  })

  test('D4: naročilo brez kupona (ad-hoc popust) → storno čist, brez ponovne izdaje', async () => {
    await resetOrders()
    const oId = await freshOrder()
    await db.order.update({ where: { id: oId }, data: { discount: 1.15 } })

    const rid = await payOrder(oId, { type: 'cash' }, 'd4')
    const res = await storno(rid, `${PREFIX} testni storno D4`)
    expect(res.status).toBe(201)
    const j = (await res.json()) as { storno: { valueRefunds: { couponReissued: string | null } } }
    expect(j.storno.valueRefunds.couponReissued).toBeNull()
  })
})

/* ─────────── E — sledljivost zrcalnih Payment vrstic ─────────── */

describe('v1.243.0 E — zrcalne vrstice nosijo identifikacijo instrumenta', () => {
  test('E1: negacijska vrstica giftcard dela nosi giftCardId; loyalty dela nosi loyaltyAccountId + točke', async () => {
    await resetOrders()
    const gcId = await giftCard(5, `GC-${PREFIX}-E1-${TS}`)
    const accId = nid()
    await db.loyaltyAccount.create({
      data: { id: accId, customerName: `${PREFIX} Gost E1`, pointsBalance: 300, lifetimePoints: 300, isActive: true, locationId: locA },
    })
    const oId = await freshOrder()

    // 300 tk (3 €) + GC 5 + gotovina 3,50 = 11,50
    const rid = await payOrder(oId, {
      loyaltyAccountId: accId, loyaltyPointsUsed: 300,
      parts: [{ type: 'giftcard', amount: 5, giftCardId: gcId }, { type: 'cash', amount: 3.5 }],
    }, 'e1')

    const res = await storno(rid, `${PREFIX} testni storno E1`)
    expect(res.status).toBe(201)

    const check = await db.check.findFirst({ where: { orderId: oId } })
    const rows = await db.payment.findMany({ where: { checkId: check!.id, amount: { lt: 0 } } })
    expect(rows.length).toBe(3)
    const gcNeg = rows.find((r) => r.type === 'giftcard')
    expect(gcNeg?.giftCardId).toBe(gcId)
    const loyNeg = rows.find((r) => r.type === 'loyalty')
    expect(loyNeg?.loyaltyAccountId).toBe(accId)
    expect(loyNeg?.loyaltyPointsUsed).toBe(300)
    // vsota para loyalty: +3 − 3 = 0 (računovodstvo neto)
    const loyAll = await db.payment.findMany({ where: { checkId: check!.id, type: 'loyalty' } })
    expect(Math.round(loyAll.reduce((s, p) => s + num(p.amount), 0) * 100)).toBe(0)
  })
})

/* ─────────── Ž — registri (dokumentirana resnica) ─────────── */

describe('v1.243.0 Ž — registri', () => {
  test('Ž1: verzija je dvignjena na 1.243.0', () => {
    expect(APP_VERSION).toBe('1.307.0')
  })

  test('Ž2: raziskava §17 je dokumentirana (PRIMERJAVA-VMESNIKOV-2026)', () => {
    expect(doc).toContain('POVRAČILNA CELICA')
    expect(doc).toContain('v1.243.0')
  })

  test('Ž3: storno ruta implementira vse tri povračilne poti + ponovno izdajo', () => {
    expect(stornoSrc).toContain("type: 'refund'")
    expect(stornoSrc).toContain('COUPON_REISSUED')
    expect(stornoSrc).toContain('tierForPoints')
    expect(stornoSrc).toContain('valueRefunds')
    // A: CAS povračilo na kartico
    expect(stornoSrc).toContain('Povračilo ob stornu računa')
    // B/C: zrcali LoyaltyTransaction
    expect(stornoSrc).toContain('Povračilo unovčenih točk ob stornu računa')
    expect(stornoSrc).toContain('Negacija zaslužka ob stornu računa')
  })

  test('Ž4: konvencija predznakov GC ledžerja — refund je POZITIVEN (gcTxSign)', () => {
    expect(gcTxSign('refund')).toBe(1)
    expect(gcTxSign('redeem')).toBe(-1)
  })

  test('Ž5: higiena fiksur — v243- je v TEST_PREFIXES (sweep pozna val)', () => {
    const sweep = read('tests/helpers/fixture-sweep.ts')
    expect(sweep).toContain("'v243-'")
  })
})
