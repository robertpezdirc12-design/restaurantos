import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid, num } from '@/lib/map'
import { shiftPaymentBuckets } from '../src/lib/shift-payment-buckets'
import { APP_VERSION } from '../src/lib/version'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as checksPOST } from '../src/app/api/orders/[id]/checks/route'
import { POST as voidPOST } from '../src/app/api/orders/[id]/void/route'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { GET as fursGET } from '../src/app/api/furs/[id]/route'
import { POST as stornoPOST } from '../src/app/api/receipts/[id]/storno/route'
import { GET as tipsGET } from '../src/app/api/tips/route'

/**
 * v1.239.0 — RAČUNSKA CELICA (docs/PRIMERJAVA-VMESNIKOV-2026 §16).
 *
 * Nadaljevanje denarnega vala (v1.238.0 §15 I, B-načrti). Štiri najdbe iz
 * poglobljene raziskave (Toast/Square/Lightspeed reference), vse POTRJENE v kodi:
 *
 *  A) Z-poročilo izmene je MEŠAN račun (gotovina + kartica) metalo v »drugo« —
 *     gotovinski del je izpadel iz pričakovane gotovine predala → namišljena
 *     razlika ob zaključku. Square/Toast: način plačila je lastnost DELA, ne
 *     računa; X/Z izvoz je že agregiral po vrsticah — Z-poročilo, živi pregled,
 *     preview variance in dnevni e-mail so zdaj na istem motorju.
 *  B) Storno NI negiral vrstic Payment — napitnina ostala pozitivna za vedno
 *     (dnevni bazen je računal preveč). Toast: refund negira vsak del po
 *     izvirnem načinu; bazen vidi obe vrstici (neto 0).
 *  C) Ponatisk računa izstavka je izpeljal postavke iz ŽIVEGA naročila — račun
 *     izstavka #1 je pokazal postavke VSEH izstavkov; dodajanje/preklic po
 *     izdaji je spreminjal podobo fiskalnega dokumenta. Toast/Square: račun je
 *     posnetek trenutka izdaje (Receipt.checkId + itemsJson).
 *  D) Void postavke na ŽE PLAČANEM izstavku delno plačanega naročila je šel
 *     skozi brez vračila → Σ izstavkov > Order.total, R1 poroča višje.
 *     Toast: izdani račun se spreminja SAMO s fiskalnim stornom (409 + pot);
 *     per-check storno na 'partial' naročilu je zdaj odprta (prej past 409).
 *
 * 1 DDL (aditivni stolpci Receipt.checkId/itemsJson) · 0 odvisnosti · 0 AI.
 */

const PREFIX = 'v239-'
const TS = Date.now()

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const mapSrc = read('src/lib/map.ts')
const opsSrc = read('src/lib/ops.ts')
const issueSrc = read('src/lib/furs/issue.ts')
const fursDetailSrc = read('src/app/api/furs/[id]/route.ts')
const stornoSrc = read('src/app/api/receipts/[id]/storno/route.ts')
const tipsSrc = read('src/app/api/tips/route.ts')
const shiftsSrc = read('src/app/api/shifts/route.ts')
const movementsSrc = read('src/app/api/shifts/movements/route.ts')
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
    // v1.299.0 (izteg v243 apliciran sem): INVOICE_ISSUE piše entityId = RECEIPT id
    // (ne orderId) in details brez predpone; publishEvent piše EventLog (InvoiceCreated)
    // z nid() id-jem in predpono SAMO v locationId. Po izbrisu lokacije spodaj ju
    // široki sweep ne vidi več (AuditLog sicer naključno ujame case-insensitive
    // LIKE 'stockded' ↔ "stockDeduction" v details — a le, če sweep teče ZA tem
    // testom; EventLog payload brez tega ključa ni ujet NIKOLI). Briši po
    // locationId DOKLER lokacija še živi.
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

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  await cleanupFixtures()

  locA = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: `BLGV239A${TS}`,
      taxId: 'SI12345678', registerNumber: 'BLG-V239-01A', country: 'SI', timezone: 'Europe/Ljubljana' },
  })).id
  mgrA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Vodja A`, email: `${PREFIX}-mgr-a-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-ma-${TS}`, locationId: locA },
  })).id
  tokMgr = createToken({ sub: mgrA, name: `${PREFIX} Vodja A`, role: 'MANAGER', loc: locA, sv: 0 })
  ownA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Lastnik A`, email: `${PREFIX}-own-a-${TS}@test.local`, role: 'owner', pin: `${PREFIX}-pin-oa-${TS}`, locationId: locA },
  })).id
  tokOwn = createToken({ sub: ownA, name: `${PREFIX} Lastnik A`, role: 'OWNER', loc: locA, sv: 0 })

  const menuA = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const catA = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuA } })).id
  itemPiva = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Piva`, price: 3.5, categoryId: catA, vatRate: 22 } })).id
  itemJedi = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Jedi`, price: 8, categoryId: catA, vatRate: 22 } })).id
  table1 = (await db.table.create({ data: { id: nid(), number: 91, capacity: 4, locationId: locA, status: 'available' } })).id
})

afterAll(async () => {
  await cleanupFixtures()
  await sweepTestFixtures(db, [PREFIX])
})

/* ─────────── A — Z-poročilo: vedra po VRSTICAH Payment (mešana plačila) ─────────── */

describe('v1.239.0 A — shiftPaymentBuckets: mešan račun prispeva v SVOJA vedra', () => {
  test('A1: mešan račun (gotovina 4 + kartica 8) → cash 4, card 8, alternate 0', async () => {
    await resetOrders()
    const orderId = nid()
    const checkId = nid()
    const from = new Date(Date.now() - 60_000)
    const to = new Date(Date.now() + 60_000)
    await db.order.create({ data: { id: orderId, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, tableId: table1, type: 'dine-in', status: 'paid', paymentStatus: 'paid', paymentMethod: 'mixed', subtotal: 9.84, tax: 2.16, total: 12, totalWithTip: 12, paidAt: new Date() } })
    await db.check.create({ data: { id: checkId, checkNumber: 1, orderId, paymentStatus: 'paid', paymentMethod: 'mixed', total: 12 } })
    await db.receipt.create({ data: {
      id: nid(), receiptNumber: `${PREFIX}-MIX-${TS}`, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: 9.84, vatBreakdown: '{}', totalVat: 2.16, discount: 0, total: 12, tip: 0, totalWithTip: 12,
      paymentMethod: 'mixed', isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
    } })
    await db.payment.create({ data: { id: nid(), checkId, amount: 4, tipAmount: 0, type: 'cash', status: 'completed', employeeId: mgrA } })
    await db.payment.create({ data: { id: nid(), checkId, amount: 8, tipAmount: 0, type: 'card', status: 'completed', employeeId: mgrA } })

    const bk = await shiftPaymentBuckets(db, { locationId: locA, from, to })
    // PREJ (po oznaki Receipt.paymentMethod='mixed'): celih 12 v »drugo«, gotovina 0
    expect(bk.source).toBe('payments')
    expect(bk.cash).toBe(4)
    expect(bk.card).toBe(8)
    expect(bk.mobile).toBe(0)
    expect(bk.alternate).toBe(0)
  })

  test('A2: legacy storno račun brez negacijskih vrstic → ročna korekcija v vedro originala', async () => {
    await resetOrders()
    const orderId = nid()
    const checkId = nid()
    const from = new Date(Date.now() - 60_000)
    const to = new Date(Date.now() + 60_000)
    await db.order.create({ data: { id: orderId, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, tableId: table1, type: 'dine-in', status: 'storno', paymentStatus: 'storno', paymentMethod: 'cash', subtotal: 8.2, tax: 1.8, total: 10, totalWithTip: 10, paidAt: new Date() } })
    await db.check.create({ data: { id: checkId, checkNumber: 1, orderId, paymentStatus: 'paid', paymentMethod: 'cash', total: 10 } })
    // izvirni pozitivni vrstici (v oknu — plačano in storno v isti izmeni)
    await db.payment.create({ data: { id: nid(), checkId, amount: 10, tipAmount: 0, type: 'cash', status: 'completed', employeeId: mgrA } })
    await db.receipt.create({ data: {
      id: nid(), receiptNumber: `${PREFIX}-ORIG-${TS}`, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: 8.2, vatBreakdown: '{}', totalVat: 1.8, discount: 0, total: 10, tip: 0, totalWithTip: 10,
      paymentMethod: 'cash', isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
    } })
    // LEGACY storno račun (pred v1.239.0): negativni račun, BREZ negacijskih vrstic
    await db.receipt.create({ data: {
      id: nid(), receiptNumber: `${PREFIX}-STOR-${TS}`, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: -8.2, vatBreakdown: '{}', totalVat: -1.8, discount: 0, total: -10, tip: 0, totalWithTip: -10,
      paymentMethod: 'cash', isCopy: false, isStorno: true, stornoOf: '', locationId: locA,
    } })

    const bk = await shiftPaymentBuckets(db, { locationId: locA, from, to })
    // +10 (vrstica) − 10 (korekcija legacy storna) = 0 — pred popravkom bi bilo +10
    expect(bk.cash).toBe(0)
  })

  test('A3: novi storno (negacijska vrstica v oknu) → neto SAMO po vrsticah, BREZ dvojne korekcije', async () => {
    await resetOrders()
    const orderId = nid()
    const checkId = nid()
    const from = new Date(Date.now() - 60_000)
    const to = new Date(Date.now() + 60_000)
    await db.order.create({ data: { id: orderId, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, tableId: table1, type: 'dine-in', status: 'storno', paymentStatus: 'storno', paymentMethod: 'cash', subtotal: 8.2, tax: 1.8, total: 10, totalWithTip: 10, paidAt: new Date() } })
    await db.check.create({ data: { id: checkId, checkNumber: 1, orderId, paymentStatus: 'paid', paymentMethod: 'cash', total: 10 } })
    await db.receipt.create({ data: {
      id: nid(), receiptNumber: `${PREFIX}-OR2-${TS}`, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: 8.2, vatBreakdown: '{}', totalVat: 1.8, discount: 0, total: 10, tip: 0, totalWithTip: 10,
      paymentMethod: 'cash', isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
    } })
    await db.receipt.create({ data: {
      id: nid(), receiptNumber: `${PREFIX}-ST2-${TS}`, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: -8.2, vatBreakdown: '{}', totalVat: -1.8, discount: 0, total: -10, tip: 0, totalWithTip: -10,
      paymentMethod: 'cash', isCopy: false, isStorno: true, stornoOf: '', locationId: locA, checkId,
    } })
    // izvirna + NEGACIJSKA vrstica (v1.239.0 pot)
    await db.payment.create({ data: { id: nid(), checkId, amount: 10, tipAmount: 0, type: 'cash', status: 'completed', employeeId: mgrA } })
    await db.payment.create({ data: { id: nid(), checkId, amount: -10, tipAmount: 0, type: 'cash', status: 'completed', employeeId: mgrA } })

    const bk = await shiftPaymentBuckets(db, { locationId: locA, from, to })
    // vrstice se neto same (+10 − 10); helper NE sme dodati še ročne korekcije (−10)
    expect(bk.cash).toBe(0)
  })

  test('A4: okno brez vrstic Payment (legacy) → padalo na račune (prejšnja logika)', async () => {
    await resetOrders()
    const orderId = nid()
    const from = new Date(Date.now() - 60_000)
    const to = new Date(Date.now() + 60_000)
    await db.order.create({ data: { id: orderId, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, tableId: table1, type: 'dine-in', status: 'paid', paymentStatus: 'paid', paymentMethod: 'cash', subtotal: 8.2, tax: 1.8, total: 10, totalWithTip: 10, paidAt: new Date() } })
    await db.receipt.create({ data: {
      id: nid(), receiptNumber: `${PREFIX}-LEG-${TS}`, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: 8.2, vatBreakdown: '{}', totalVat: 1.8, discount: 0, total: 10, tip: 0, totalWithTip: 10,
      paymentMethod: 'cash', isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
    } })
    const bk = await shiftPaymentBuckets(db, { locationId: locA, from, to })
    expect(bk.source).toBe('receipts')
    expect(bk.cash).toBe(10)
  })

  test('A5: vsi štirje klicišča uporabljajo skupni motor (source pins)', () => {
    expect(shiftsSrc).toContain('shiftPaymentBuckets')
    expect(shiftsSrc).toContain('if (payBuckets.source === \'payments\')')
    // preview variance
    expect(shiftsSrc).toContain('const bkPrev = await shiftPaymentBuckets(db,')
    // dnevni e-mail
    expect(shiftsSrc).toContain('const bkMail = await shiftPaymentBuckets(db,')
    // živi pregled premikov
    expect(movementsSrc).toContain('const bk = await shiftPaymentBuckets(db,')
    expect(movementsSrc).not.toContain("paymentMethod: 'cash'")
  })
})

/* ─────────── B — storno negira Payment vrstice; bazen napitnin neto ─────────── */

describe('v1.239.0 B — storno negira plačila + dnevni bazen napitnin', () => {
  test('B1: mešano plačilo z napitnino → storno piše zrcalne negacijske vrstice (neto 0)', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }, { menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string; items: { id: string; name: string }[] } }
    const oId = co.order.id

    // MEŠANO plačilo: 4 € gotovina + 7,50 € kartica (SIM- odobritev) + 1 € napitnina
    const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', {
      orderId: oId, tip: 1,
      parts: [
        { type: 'cash', amount: 4 },
        { type: 'card', amount: 7.5, terminal: { approvalCode: `SIM-${PREFIX}-${TS}` } },
      ],
      clientOperationId: `${PREFIX}-furs-b1-${TS}`,
    }))
    expect(paid.status).toBe(201)
    const inv = (await paid.json()) as { invoice: { id: string; invoiceNumber: string } }
    expect(inv.invoice.invoiceNumber).toBeTruthy()

    // vrstice PRED stornom: pozitivne, tip na prvem delu
    const check = await db.check.findFirst({ where: { orderId: oId } })
    expect(check).toBeTruthy()
    const before = await db.payment.findMany({ where: { checkId: check!.id }, orderBy: { createdAt: 'asc' } })
    expect(before.length).toBe(2)
    expect(before.filter((p) => num(p.amount) > 0).reduce((s, p) => s + num(p.tipAmount), 0)).toBe(1)

    // STORNO → negacijske vrstice
    const res = await stornoPOST(req(`/api/receipts/${inv.invoice.id}/storno`, tokOwn, 'POST', { reason: `${PREFIX} testni storno` }), { params: Promise.resolve({ id: inv.invoice.id }) })
    expect(res.status).toBe(201)
    const j = (await res.json()) as { storno: { negatedPaymentRows: number }; order: { paymentStatus: string } }
    expect(j.storno.negatedPaymentRows).toBe(2)
    expect(j.order.paymentStatus).toBe('storno')

    const after = await db.payment.findMany({ where: { checkId: check!.id } })
    expect(after.length).toBe(4)
    const netAmount = after.reduce((s, p) => s + num(p.amount), 0)
    const netTip = after.reduce((s, p) => s + num(p.tipAmount), 0)
    expect(Math.round(netAmount * 100)).toBe(0)
    expect(Math.round(netTip * 100)).toBe(0)
    // negacijske vrstice so zrcalo: isti tip kot original
    const neg = after.filter((p) => num(p.amount) < 0)
    expect(neg.map((p) => p.type).sort()).toEqual(['card', 'cash'])
  })

  test('B2: dnevni bazen napitnin po stornu → neto 0 (prej: napitnina ostala)', async () => {
    // B1 je storniral edini račun dneva s tipom → bazen mora biti 0/0
    const res = await tipsGET(req(`/api/tips?date=${new Date().toISOString().slice(0, 10)}&locationId=${locA}`, tokOwn))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { totals: { totalCents: number; cashCents: number; nonCashCents: number } }
    // vse napitnine fiksture dneva so iz tega lokacijskega okna in so negirane
    expect(j.totals.totalCents).toBe(0)
    expect(j.totals.cashCents).toBe(0)
    expect(j.totals.nonCashCents).toBe(0)
  })

  test('B3: per-check storno na delno plačanem naročilu — odpre pot (prej: past 409)', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }, { menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string; items: { id: string; name: string }[] } }
    const oId = co.order.id
    const jedi = co.order.items.find((i) => i.name.includes('Jedi'))!

    const split = await checksPOST(req(`/api/orders/${oId}/checks`, tokMgr, 'POST', { itemIds: [jedi.id] }), { params: Promise.resolve({ id: oId }) })
    expect(split.status).toBe(200)
    const checks = await db.check.findMany({ where: { orderId: oId }, orderBy: { checkNumber: 'asc' } })
    expect(checks.length).toBe(2)
    const check1 = checks.find((c) => c.checkNumber === 1)!

    // plačaj SAMO izstavek #1 (piva 3,50, kartica, SIM)
    const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', {
      orderId: oId, checkId: check1.id, type: 'card', terminal: { approvalCode: `SIM-${PREFIX}-c1-${TS}` },
      clientOperationId: `${PREFIX}-furs-b3-${TS}`,
    }))
    expect(paid.status).toBe(201)
    const inv = (await paid.json()) as { invoice: { id: string } }
    const orderMid = await db.order.findUnique({ where: { id: oId }, select: { paymentStatus: true } })
    expect(orderMid?.paymentStatus).toBe('partial')

    // storno računa izstavka #1 na 'partial' naročilu → 201 (prej 409 past)
    const res = await stornoPOST(req(`/api/receipts/${inv.invoice.id}/storno`, tokOwn, 'POST', { reason: `${PREFIX} per-check storno` }), { params: Promise.resolve({ id: inv.invoice.id }) })
    expect(res.status).toBe(201)
    const j = (await res.json()) as { order: { paymentStatus: string }; storno: { negatedPaymentRows: number } }
    // naročilo ostane 'partial' (izstavek #2 je še odprt — Toast: refund ne razplača celote)
    expect(j.order.paymentStatus).toBe('partial')
    expect(j.storno.negatedPaymentRows).toBe(1)
    // negirane SAMO vrstice izstavka #1
    const negRows = await db.payment.findMany({ where: { checkId: check1.id, amount: { lt: 0 } } })
    expect(negRows.length).toBe(1)
  })
})

/* ─────────── C — posnetek postavk računa (ponatisk = trenutek izdaje) ─────────── */

describe('v1.239.0 C — Receipt.checkId + itemsJson posnetek', () => {
  test('C1: per-check račun nosi SAMO postavke izstavka; branje vrača posnetek', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 2 }, { menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string; items: { id: string; name: string }[] } }
    const oId = co.order.id
    const jedi = co.order.items.find((i) => i.name.includes('Jedi'))!

    const split = await checksPOST(req(`/api/orders/${oId}/checks`, tokMgr, 'POST', { itemIds: [jedi.id] }), { params: Promise.resolve({ id: oId }) })
    expect(split.status).toBe(200)
    const checks = await db.check.findMany({ where: { orderId: oId }, orderBy: { checkNumber: 'asc' } })
    const check1 = checks.find((c) => c.checkNumber === 1)!

    const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', {
      orderId: oId, checkId: check1.id, type: 'cash', clientOperationId: `${PREFIX}-furs-c1-${TS}`,
    }))
    expect(paid.status).toBe(201)
    const inv = (await paid.json()) as { invoice: { id: string } }

    // ZAPIS: račun nosi checkId + posnetek SAMO pive (2× 3,50 = 7)
    const row = await db.receipt.findUnique({ where: { id: inv.invoice.id }, select: { checkId: true, itemsJson: true } })
    expect(row?.checkId).toBe(check1.id)
    const snap = typeof row?.itemsJson === 'string' ? (JSON.parse(row!.itemsJson as string) as unknown[]) : (row?.itemsJson as unknown[])
    expect(Array.isArray(snap)).toBe(true)
    expect(snap!.length).toBe(1)
    const snapItem = snap![0] as { name: string; qty: number; amount: number }
    expect(snapItem.name.includes('Piva')).toBe(true)
    expect(snapItem.qty).toBe(2)

    // BRANJE: GET /api/furs/[id] → SAMO piva (prej: vse 3 postavke naročila)
    const detail = await fursGET(req(`/api/furs/${inv.invoice.id}`, tokMgr), { params: Promise.resolve({ id: inv.invoice.id }) })
    expect(detail.status).toBe(200)
    const d = (await detail.json()) as { receipt: { items: { name: string; qty: number }[] } }
    expect(d.receipt.items.length).toBe(1)
    expect(d.receipt.items[0].name.includes('Piva')).toBe(true)
    expect(d.receipt.items[0].qty).toBe(2)
  })

  test('C2: ponatisk STORNO računa pokaže iste postavke (negirane)', async () => {
    // nadaljevanje C1 stanja: izstavek #1 je plačan; storniraj
    const openOrder = await db.order.findFirst({ where: { locationId: locA, paymentStatus: 'partial' }, orderBy: { createdAt: 'desc' } })
    expect(openOrder).toBeTruthy()
    const rcpt = await db.receipt.findFirst({ where: { orderId: openOrder!.id, isStorno: false }, orderBy: { createdAt: 'desc' } })
    expect(rcpt).toBeTruthy()
    const res = await stornoPOST(req(`/api/receipts/${rcpt!.id}/storno`, tokOwn, 'POST', { reason: `${PREFIX} storno C2` }), { params: Promise.resolve({ id: rcpt!.id }) })
    expect(res.status).toBe(201)
    const j = (await res.json()) as { invoice: { id: string } }

    const detail = await fursGET(req(`/api/furs/${j.invoice.id}`, tokMgr), { params: Promise.resolve({ id: j.invoice.id }) })
    expect(detail.status).toBe(200)
    const d = (await detail.json()) as { receipt: { items: { name: string; qty: number; amount: number }[]; total: number } }
    // posnetek se je prenesel: ista postavka (piva), negiran znesek
    expect(d.receipt.items.length).toBe(1)
    expect(d.receipt.items[0].name.includes('Piva')).toBe(true)
    expect(d.receipt.items[0].amount).toBeLessThan(0)
    expect(d.receipt.total).toBeLessThan(0)
  })

  test('C3: legacy račun brez posnetka → izpeljava iz živih postavk (nazaj-kompatibilno)', async () => {
    await resetOrders()
    const orderId = nid()
    await db.order.create({ data: { id: orderId, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, tableId: table1, type: 'dine-in', status: 'paid', paymentStatus: 'paid', paymentMethod: 'cash', subtotal: 3.5, tax: 0.7, total: 4.2, totalWithTip: 4.2, paidAt: new Date() } })
    await db.orderItem.create({ data: { id: nid(), orderId, menuItemId: itemPiva, quantity: 1, price: 4.2, vatRate: 22, vatAmount: 0.76, menuItemName: `${PREFIX} Piva`, status: 'served' } })
    const rId = nid()
    await db.receipt.create({ data: {
      id: rId, receiptNumber: `${PREFIX}-LEG-C3-${TS}`, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: 3.44, vatBreakdown: '{}', totalVat: 0.76, discount: 0, total: 4.2, tip: 0, totalWithTip: 4.2,
      paymentMethod: 'cash', isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
    } })
    const detail = await fursGET(req(`/api/furs/${rId}`, tokMgr), { params: Promise.resolve({ id: rId }) })
    expect(detail.status).toBe(200)
    const d = (await detail.json()) as { receipt: { items: { name: string }[] } }
    expect(d.receipt.items.length).toBe(1)
    expect(d.receipt.items[0].name.includes('Piva')).toBe(true)
  })

  test('C4: izdaja piše checkId + itemsJson; branje ima prednost posnetka (source pins)', () => {
    expect(issueSrc).toContain('checkId: check.id')
    expect(issueSrc).toContain('itemsJson: jstr(receiptSnapshotItems)')
    expect(issueSrc).toContain('const receiptSnapshotItems = (checkScope ? checkScope.items : billItems).map')
    expect(fursDetailSrc).toContain('snapshotItems.length > 0')
    expect(fursDetailSrc).toContain('typeof r.itemsJson === \'string\' ? JSON.parse(r.itemsJson)')
    expect(stornoSrc).toContain('checkId: original.checkId')
  })
})

/* ─────────── D — void na plačanem izstavku → 409 (+ odprta storno pot) ─────────── */

describe('v1.239.0 D — void postavke na plačanem izstavku', () => {
  test('D1: postavka plačanega izstavka na partial naročilu → 409 z usmeritvijo na storno', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }, { menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string; items: { id: string; name: string }[] } }
    const oId = co.order.id
    const piva = co.order.items.find((i) => i.name.includes('Piva'))!
    const jedi = co.order.items.find((i) => i.name.includes('Jedi'))!

    const split = await checksPOST(req(`/api/orders/${oId}/checks`, tokMgr, 'POST', { itemIds: [jedi.id] }), { params: Promise.resolve({ id: oId }) })
    expect(split.status).toBe(200)
    const checks = await db.check.findMany({ where: { orderId: oId }, orderBy: { checkNumber: 'asc' } })
    const check1 = checks.find((c) => c.checkNumber === 1)!

    // plačaj izstavek #1 (piva) → naročilo 'partial'
    const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', {
      orderId: oId, checkId: check1.id, type: 'cash', clientOperationId: `${PREFIX}-furs-d1-${TS}`,
    }))
    expect(paid.status).toBe(201)

    // VOID postavke na PLAČANEM izstavku → 409 (prej: tiho skozi, denar brez vračila)
    const res = await voidPOST(req(`/api/orders/${oId}/void`, tokMgr, 'POST', { itemId: piva.id, reason: `${PREFIX} poskus` }), { params: Promise.resolve({ id: oId }) })
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error: string }
    expect(j.error).toContain('plačanem izstavku')
    // postavka NI preklicana
    const row = await db.orderItem.findUnique({ where: { id: piva.id }, select: { voided: true } })
    expect(row?.voided).toBe(false)
  })

  test('D2: postavka NEPLAČANEGA izstavka na istem partial naročilu → 200 (dovoljeno)', async () => {
    // stanje iz D1: izstavek #1 plačan, #2 (jedi) odprt
    const openOrder = await db.order.findFirst({ where: { locationId: locA, paymentStatus: 'partial' }, orderBy: { createdAt: 'desc' } })
    expect(openOrder).toBeTruthy()
    const jediRow = await db.orderItem.findFirst({ where: { orderId: openOrder!.id, menuItemName: { contains: 'Jedi' } } })
    expect(jediRow?.checkId).toBeTruthy()

    const res = await voidPOST(req(`/api/orders/${openOrder!.id}/void`, tokMgr, 'POST', { itemId: jediRow!.id, reason: `${PREFIX} dovoljen preklic` }), { params: Promise.resolve({ id: openOrder!.id }) })
    expect(res.status).toBe(200)
    const row = await db.orderItem.findUnique({ where: { id: jediRow!.id }, select: { voided: true } })
    expect(row?.voided).toBe(true)
  })

  test('D3: UI ne ponuja prepovedane poteze (source pins)', () => {
    // gumb skrit za checkPaid postavke
    expect(dash).toContain("orderSheet.paymentStatus !== 'paid' && !it.checkPaid")
    // mapper izpostavi checkPaid aditivno
    expect(mapSrc).toContain("checkPaid: it.Check ? (it.Check as { paymentStatus?: unknown }).paymentStatus === 'paid' : undefined")
    expect(mapSrc).toContain('checkId: (it.checkId as string | null | undefined) ?? null')
    // oba include nosita relacijo Check
    expect(opsSrc).toContain('Check: { select: { paymentStatus: true, checkNumber: true } }')
  })
})

/* ─────────── Ž — registri (verzija, dokumentacija) ─────────── */

describe('v1.239.0 Ž — registri', () => {
  test('Ž1: APP_VERSION = 1.240.0 (hotfix veriga: DDL pot + FK sonda)', () => {
    expect(APP_VERSION).toBe('1.309.0')
  })

  test('Ž2: raziskava dokumentirana v PRIMERJAVA §16', () => {
    expect(doc).toContain('## 16. Raziskava januar 2027 — RAČUNSKA CELICA v1.239.0')
  })

  test('Ž3: bazen napitnin vidi negacijske vrstice (filter not: 0)', () => {
    expect(tipsSrc).toContain('tipAmount: { not: 0 }')
    expect(tipsSrc).not.toContain('tipAmount: { gt: 0 }')
  })
})
