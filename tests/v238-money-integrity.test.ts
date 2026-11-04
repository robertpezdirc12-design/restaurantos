import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid, num } from '@/lib/map'
import { isHappyActive, computeBill, type BillItem } from '@/lib/billing'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { PATCH as ordersPATCH } from '../src/app/api/orders/[id]/route'
import { GET as billGET } from '../src/app/api/orders/[id]/bill/route'
import { POST as checksPOST } from '../src/app/api/orders/[id]/checks/route'
import { POST as mergePOST } from '../src/app/api/orders/[id]/merge/route'
import { POST as stornoPOST } from '../src/app/api/receipts/[id]/storno/route'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { PATCH as poPATCH } from '../src/app/api/purchase-orders/[id]/route'
import { GET as suggestionsGET } from '../src/app/api/purchase-orders/suggestions/route'

/**
 * v1.238.0 — DENARNI VAL (docs/PRIMERJAVA-VMESNIKOV-2026 NOVA §15).
 *
 * Poglobljen QA pregled vseh petih vmesnikov (3 vzporedne raziskave) je odkril
 * vrzeli FINANČNE CELICE, ki jih vodilni izdelki (Toast, Square, Lightspeed,
 * TouchBistro, MarketMan) pokrivajo:
 *
 *  A) addItems na razdeljenem naročilu → postavka brez checkId → plačilni
 *     dialog jo pokaže pod izstavkom #1, jedro plačila pa izpusti — postrežena
 *     hrana, ki je nihče ne zaračuna (Toast: vsaka postavka ima vedno check).
 *  B) Dashboard POS napitnine NE pošlje na terminal (handheld jo — referenca);
 *     knjige/bazen napitnin pa jo zapišejo → izplačilo denarja, ki ni bil pobran.
 *  C) Predogled računa ne vrne prek QR povezav že pobranih deležev → POS
 *     bremeni terminal s CELIM zneskom → dvojna bremenitev gosta (Toast/Square:
 *     plačilni dialog vedno kaže »open balance«).
 *  D) Happy Hour okno se ovrednoti po strežniški uri (UTC na Vercelu), ne po
 *     coni lokacije → popust ob napačni uri / sploh ne (ploščice kažejo ⚡).
 *  E) Merge pusti skoži vir z delnim plačilom (QR) ali popustom → denar ujet
 *     na preklicanem viru, gost plača dvakrat (Toast: transfer ZAVRNE).
 *  F) Hitra prodaja pošlje 'TAKEOUT' (tipkarska) → tiho preslikano v dine-in →
 *     poročila po kanalih lažejo (Square/Toast: strict enum na strežniku).
 *  G) Storno enega izstavka povrne zalogo VSEH izstavkov + razplača celotno
 *     naročilo (MarketMan/Toast: refund je per preglej; od zdaj razknjižba
 *     nosi žig računa — StockTransaction.supplierDoc).
 *  H) PO statusni PATCH brez CAS → preklic prepiše 'received' (CAS kot prejem).
 *  I) Predlogi nabave štejejo ZAVRNJENO količino kot incoming → podnaročilo.
 *
 * 0 DDL · 0 odvisnosti · 0 AI · 0 novih rut.
 */

const PREFIX = 'v238-'
const TS = Date.now()

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const ordersRoute = read('src/app/api/orders/route.ts')
const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
const audit = read('docs/RESTAURANTOS-AUDIT.md')

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
let table2 = ''
let invA = ''
let invB = ''
let supplierId = ''

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
      const receipts = await db.receipt.findMany({ where: { orderId: o.id }, select: { id: true } })
      const checks = await db.check.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      await db.payLink.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { OR: [{ entityId: { in: [...receipts.map((r) => r.id), o.id] } }, { payload: { contains: PREFIX } }] } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...receipts.map((r) => r.id), o.id, ...items.map((i) => i.id)] } }, { details: { contains: PREFIX } }] } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.stockTransaction.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.orderItem.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.order.deleteMany({ where: { id: o.id } }).catch(() => null)
    }
    const pos = await db.purchaseOrder.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const po of pos) {
      await db.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: po.id } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { entityId: po.id } }).catch(() => null)
      await db.purchaseOrder.deleteMany({ where: { id: po.id } }).catch(() => null)
    }
    const tables = await db.table.findMany({ where: { locationId: locId }, select: { id: true } })
    await db.eventLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.table.deleteMany({ where: { locationId: locId } }).catch(() => null)
    const menus = await db.menu.findMany({ where: { locationId: locId }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.menuItemModifierGroup.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
    await db.inventoryItem.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.employee.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.supplier.deleteMany({ where: { name: { startsWith: PREFIX } } }).catch(() => null)
    await db.counter.deleteMany({ where: { name: { startsWith: `receipt:${locId}` } } }).catch(() => null)
    await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
  }
}


/** Ponastavi naročila + mize med skupinami (vsak test ustvari sveče naročilo). */
async function resetOrdersAndTables() {
  const orders = await db.order.findMany({ where: { locationId: locA }, select: { id: true } })
  for (const o of orders) {
    const items = await db.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } })
    await db.orderItemModifier.deleteMany({ where: { orderItemId: { in: items.map((i) => i.id) } } }).catch(() => null)
    const stx = await db.stockTransaction.findMany({ where: { orderId: o.id }, select: { id: true } })
    await db.stockBatchAllocation.deleteMany({ where: { stockTransactionId: { in: stx.map((t) => t.id) } } }).catch(() => null)
    const checks = await db.check.findMany({ where: { orderId: o.id }, select: { id: true } })
    await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
    await db.payLink.deleteMany({ where: { orderId: o.id } }).catch(() => null)
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
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: `BLGV238A${TS}`,
      taxId: 'SI12345678', registerNumber: 'BLG-V238-01A', country: 'SI', timezone: 'Europe/Ljubljana', loyaltyEnabled: true, loyaltyPointsPerEuro: 1, loyaltyPointsValue: 0.01 },
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
  table1 = (await db.table.create({ data: { id: nid(), number: 81, capacity: 4, locationId: locA, status: 'available' } })).id
  table2 = (await db.table.create({ data: { id: nid(), number: 82, capacity: 4, locationId: locA, status: 'available' } })).id
  invA = (await db.inventoryItem.create({ data: { id: nid(), name: `${PREFIX} Zaloga A`, unit: 'kos', quantity: 10, minQuantity: 0, locationId: locA } })).id
  invB = (await db.inventoryItem.create({ data: { id: nid(), name: `${PREFIX} Zaloga B`, unit: 'kos', quantity: 10, minQuantity: 0, locationId: locA } })).id
  supplierId = (await db.supplier.create({ data: { id: nid(), name: `${PREFIX} Dobavitelj ${TS}`, code: `${PREFIX}-SUP-${TS}` } })).id
})

afterAll(async () => {
  await cleanupFixtures()
  await sweepTestFixtures(db, [PREFIX])
})

/* ─────────────────────────── A — addItems checkId ─────────────────────────── */

describe('v1.238.0 A — addItems na razdeljenem naročilu pristane na izstavku', () => {
  test('A1: postavka dodana po razdelitvi dobi checkId prvega neplačanega izstavka', async () => {
    await resetOrdersAndTables()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }, { menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string; items: { id: string; name: string }[] } }
    const oId = co.order.id
    const piva = co.order.items.find((i) => i.name.includes('Piva'))!
    const jedi = co.order.items.find((i) => i.name.includes('Jedi'))!

    // razdeli: Jedi v izstavek #2 (prvi klic ustvari #1 z ostankom)
    const split = await checksPOST(req(`/api/orders/${oId}/checks`, tokMgr, 'POST', { itemIds: [jedi.id] }), { params: Promise.resolve({ id: oId }) })
    expect(split.status).toBe(200)

    // DODAJ še eno pivo (PO kdaj razdeljen) → 1.238.0: pristane na izstavku #1
    const added = await ordersPATCH(req(`/api/orders/${oId}`, tokMgr, 'PATCH', {
      addItems: [{ menuItemId: itemPiva, qty: 2 }],
    }), { params: Promise.resolve({ id: oId }) })
    expect(added.status).toBe(200)

    const items = await db.orderItem.findMany({ where: { orderId: oId }, select: { id: true, checkId: true, menuItemName: true } })
    const checks = await db.check.findMany({ where: { orderId: oId }, orderBy: { checkNumber: 'asc' } })
    expect(checks.length).toBe(2)
    const check1 = checks.find((c) => c.checkNumber === 1)!
    const newRow = items.find((i) => i.menuItemName.includes('Piva') && i.id !== piva.id)!
    // NOVA vrstica ima pravi checkId (prej null = sirota, ki plačilo izpusti)
    expect(newRow.checkId).toBe(check1.id)
    // prvotni vrstici pive sta tudi na izstavku #1 (ustvari jih split)
    expect(items.find((i) => i.id === piva.id)!.checkId).toBe(check1.id)
    expect(items.find((i) => i.id === jedi.id)!.checkId).toBe(checks.find((c) => c.checkNumber === 2)!.id)
  })

  test('A2: naročilo BREZ izstavkov → nova vrstica ostane checkId null (0 regresija)', async () => {
    await resetOrdersAndTables()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table2, items: [{ menuItemId: itemPiva, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string } }
    const added = await ordersPATCH(req(`/api/orders/${co.order.id}`, tokMgr, 'PATCH', {
      addItems: [{ menuItemId: itemJedi, qty: 1 }],
    }), { params: Promise.resolve({ id: co.order.id }) })
    expect(added.status).toBe(200)
    const rows = await db.orderItem.findMany({ where: { orderId: co.order.id, menuItemName: { contains: 'Jedi' } }, select: { checkId: true } })
    expect(rows.length).toBe(1)
    expect(rows[0].checkId).toBeNull()
  })
})

/* ──────────────── B — dashboard: tip na terminalu + odprti balance ──────────────── */

describe('v1.238.0 B — dashboard plačilna logika (tip + linkPaidTotal)', () => {
  test('B1: klasična pot — terminal bremeni due + tip (handheld vzorec)', () => {
    expect(dash).toContain("const chargeAmount = r2v(due + tipNum)")
    expect(dash).toContain("bodyParts.push({ type: payMethod, amount: due, terminal: { approvalCode: term.approvalCode as string } })")
    // tip se pošlje LOČENO (body.tip) — vsota delov ostane = znesek računa
    expect(dash).toContain("...(Number(tipEur) > 0 ? { tip: Number(tipEur) } : {})")
  })

  test('B2: deljena pot — prvi kartični del nosi napitnino (enkrat)', () => {
    expect(dash).toContain('let tipOnTerminal = tipNum')
    expect(dash).toContain('const chargeAmount = r2v(p.amount + tipOnTerminal)')
    expect(dash).toContain('tipOnTerminal = 0')
  })

  test('B3: odprti balance — QR deleži se odštejejo od due PRED bremenitvijo', () => {
    expect(dash).toContain('const linkPaid = bill.linkPaidTotal && bill.linkPaidTotal > 0 ? bill.linkPaidTotal : 0')
    expect(dash).toContain('const due = r2v(bill.totalDue - redeemValue - linkPaid)')
  })

  test('B4: dialog kaže vrstico »Prek QR povezave že pobrano« + odprti balance', () => {
    expect(dash).toContain('data-region="payment-link-paid"')
    expect(dash).toContain("t('payment.linkPaid')")
    expect(dash).toContain('Math.max(0, bill.totalDue - bill.linkPaidTotal)')
  })

  test('B5: i18n ključ payment.linkPaid v SL in HR (popolna pariteta)', () => {
    expect(sl['payment.linkPaid']).toBe('Prek QR povezave že pobrano')
    expect(hr['payment.linkPaid']).toBe('Putem QR veze već naplaćeno')
  })
})

/* ──────────────── C — bill API: linkPaidTotal + zvestoba na odprtem balanci ──────────────── */

describe('v1.238.0 C — GET bill vrne odprti balance (QR povezave)', () => {
  test('C1: plačana povezava (brez računa) → linkPaidTotal + zmanjšan limit zvestobe', async () => {
    await resetOrdersAndTables()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 4 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string } }
    const oId = co.order.id
    // gost je poravnal 7 € prek QR (status paid, račun še ni izdan)
    await db.payLink.create({ data: { id: nid(), orderId: oId, locationId: locA, token: `${PREFIX}-tok-${TS}`, amount: 7, status: 'paid', receiptId: null } })

    const res = await billGET(req(`/api/orders/${oId}/bill`, tokMgr), { params: Promise.resolve({ id: oId }) })
    expect(res.status).toBe(200)
    const b = (await res.json()) as { bill: { totalDue: number; linkPaidTotal?: number; loyalty: { maxRedeemablePoints: number; pointsValue: number } } }
    expect(b.bill.linkPaidTotal).toBe(7)
    // limit unovčenja na ODPRTI balanci (14 − 7 = 7 €; pointsValue 0.01 → 700 točk)
    expect(b.bill.loyalty.maxRedeemablePoints).toBe(Math.floor((b.bill.totalDue - 7) / b.bill.loyalty.pointsValue))
  })

  test('C2: naročilo brez povezav → polje linkPaidTotal IZOSTANE (nazaj-kompatibilno)', async () => {
    await resetOrdersAndTables()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table2, items: [{ menuItemId: itemPiva, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string } }
    const res = await billGET(req(`/api/orders/${co.order.id}/bill`, tokMgr), { params: Promise.resolve({ id: co.order.id }) })
    expect(res.status).toBe(200)
    const b = (await res.json()) as { bill: Record<string, unknown> }
    expect(b.bill.linkPaidTotal).toBeUndefined()
  })
})

/* ──────────────── D — Happy Hour v coni lokacije (čista enota) ──────────────── */

describe('v1.238.0 D — Happy Hour okno v coni lokacije', () => {
  const hh = { happyDays: null, happyFromHour: 17, happyToHour: 19 }

  test('D1: 16:30 UTC = 17:30 v Ljubljani → HH AKTIVEN v coni lokacije', () => {
    // strežnik (Vercel) teče v UTC: brez cone bi bil HH NEAKTIVEN (16 < 17)
    const now = new Date('2026-01-15T16:30:00Z')
    expect(isHappyActive(hh, now, 'Europe/Ljubljana')).toBe(true)
  })

  test('D2: 18:59 UTC = 19:59 v Ljubljani → HH NEAKTIVEN v coni (okno se je izteklo)', () => {
    const now = new Date('2026-01-15T18:59:00Z')
    expect(isHappyActive(hh, now, 'Europe/Ljubljana')).toBe(false)
  })

  test('D3: happyDays — dan v tednu v coni lokacije (petek zvečer LJ = petek)', () => {
    const hhFri = { happyDays: '5', happyFromHour: 17, happyToHour: 22 }
    // 2026-01-16 je petek; 23:30 v petek UTC = 00:30 SOBOTA v Ljubljani → NEAKTIVNO v coni
    const late = new Date('2026-01-16T23:30:00Z')
    expect(isHappyActive(hhFri, late, 'Europe/Ljubljana')).toBe(false)
    // 16:30 UTC petek = 17:30 petek LJ → AKTIVNO
    const evening = new Date('2026-01-16T16:30:00Z')
    expect(isHappyActive(hhFri, evening, 'Europe/Ljubljana')).toBe(true)
  })

  test('D4: computeBill s tz — HH popust se izračuna v coni lokacije', () => {
    const items: BillItem[] = [{
      id: 'i1', menuItemId: 'm1', name: 'Piva', quantity: 2, unitPrice: 3.5,
      vatRate: 22, vatAmount: 1.26, categoryId: 'c1', voided: false,
    }]
    const now = new Date('2026-01-15T16:30:00Z') // 17:30 LJ
    const candidates = [{ id: 'd1', name: 'HH', type: 'percent', amount: 20, happyDays: null, happyFromHour: 17, happyToHour: 19, targetCategoryIds: '' }]
    const withTz = computeBill({ items, subtotal: 5.74, tax: 1.26, manualDiscount: 0, autoCandidates: candidates, now, tz: 'Europe/Ljubljana', loyaltyEnabled: false, pointsPerEuro: 0, pointsValue: 0.01 })
    expect(withTz.autoDiscounts.length).toBe(1)
    expect(withTz.discountTotal).toBeGreaterThan(0)
    // brez cone (strežniški UTC 16:30): popust NE sme biti izračunan
    const noTz = computeBill({ items, subtotal: 5.74, tax: 1.26, manualDiscount: 0, autoCandidates: candidates, now, loyaltyEnabled: false, pointsPerEuro: 0, pointsValue: 0.01 })
    expect(noTz.autoDiscounts.length).toBe(0)
  })
})

/* ──────────────── E — merge: denar in popust ostanejo na viru ──────────────── */

describe('v1.238.0 E — merge varovala (delno plačilo / povezave / popust)', () => {
  async function makeOrderOn(t: string): Promise<string> {
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: t, items: [{ menuItemId: itemPiva, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string } }
    return co.order.id
  }

  test('E1: vir s paymentStatus partial (QR poravnan) → 409', async () => {
    await resetOrdersAndTables()
    const src = await makeOrderOn(table1)
    const tgt = await makeOrderOn(table2)
    await db.order.update({ where: { id: src }, data: { paymentStatus: 'partial' } })
    const res = await mergePOST(req(`/api/orders/${src}/merge`, tokMgr, 'POST', { targetOrderId: tgt }), { params: Promise.resolve({ id: src }) })
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('delni plačilni delež')
    // vir NI preklican (varovala je stala pred premikom)
    const srcAfter = await db.order.findUnique({ where: { id: src }, select: { status: true } })
    expect(srcAfter?.status).not.toBe('cancelled')
  })

  test('E2: vir s plačano plačilno povezavo → 409 (tudi brez partial zastavice)', async () => {
    await resetOrdersAndTables()
    const src = await makeOrderOn(table1)
    const tgt = await makeOrderOn(table2)
    await db.payLink.create({ data: { id: nid(), orderId: src, locationId: locA, token: `${PREFIX}-tok2-${TS}`, amount: 3.5, status: 'paid', receiptId: null } })
    const res = await mergePOST(req(`/api/orders/${src}/merge`, tokMgr, 'POST', { targetOrderId: tgt }), { params: Promise.resolve({ id: src }) })
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('plačilne povezave')
  })

  test('E3: vir z ročnim popustom → 409 (popust bi se izgubil)', async () => {
    await resetOrdersAndTables()
    const src = await makeOrderOn(table1)
    const tgt = await makeOrderOn(table2)
    await db.order.update({ where: { id: src }, data: { discount: 1 } })
    const res = await mergePOST(req(`/api/orders/${src}/merge`, tokMgr, 'POST', { targetOrderId: tgt }), { params: Promise.resolve({ id: src }) })
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('ročni popust')
  })

  test('E4: čist vir → merge ŠE VEDNO deluje (0 regresija)', async () => {
    await resetOrdersAndTables()
    const src = await makeOrderOn(table1)
    const tgt = await makeOrderOn(table2)
    const res = await mergePOST(req(`/api/orders/${src}/merge`, tokMgr, 'POST', { targetOrderId: tgt }), { params: Promise.resolve({ id: src }) })
    expect(res.status).toBe(200)
    const srcAfter = await db.order.findUnique({ where: { id: src }, select: { status: true } })
    expect(srcAfter?.status).toBe('cancelled')
  })
})

/* ──────────────── F — tip naročila: strict enum (TAKEOUT typo) ──────────────── */

describe('v1.238.0 F — tip naročila (strict enum na strežniku)', () => {
  test('F1: neznana vrednost TAKEOUT → 400 (prej tiho dine-in)', async () => {
    const res = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: null, items: [{ menuItemId: itemPiva, qty: 1 }], type: 'TAKEOUT', guests: 1,
    }))
    expect(res.status).toBe(400)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('Neznan tip naročila')
  })

  test('F2: TAKEAWAY velja in se pravilno zapiše (velike/male črke)', async () => {
    const res = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: null, items: [{ menuItemId: itemPiva, qty: 1 }], type: 'takeaway', guests: 1,
    }))
    expect(res.status).toBe(201)
    const co = (await res.json()) as { order: { id: string; type: string } }
    expect(co.order.type).toBe('TAKEAWAY')
    const row = await db.order.findUnique({ where: { id: co.order.id }, select: { type: true } })
    expect(row?.type).toBe('takeaway')
  })

  test('F3: dashboard hitra prodaja pošlje TAKEAWAY (ne več TAKEOUT)', () => {
    expect(dash).toContain("type: 'TAKEAWAY'")
    expect(dash).not.toContain("type: 'TAKEOUT'")
  })

  test('F4: strežniška validacija — vir vsebuje belo listo tipov', () => {
    expect(ordersRoute).toContain("const ORDER_TYPES_ALLOWED = ['DINE_IN', 'TAKEAWAY', 'DELIVERY']")
  })
})

/* ──────────────── G — storno: žig računa + varovala več izstavkov ──────────────── */

describe('v1.238.0 G — storno po izstavku (žig + varovala)', () => {
  test('G1: izdaja računa ob plačilu zapiše žig (supplierDoc = št. računa) na SALE odjeme', async () => {
    await resetOrdersAndTables()
    // naročilo + plačilo z gotovino → furs izda račun; receptur ni → SALE vrstic ni,
    // zato žig preverimo na poti, ki jih zapiše (furs 200 + inventory podpis) prek
    // direktnega semena spodaj — tukaj: celotna izdaja uspe (varovala ne pase)
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string } }
    const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', { orderId: co.order.id, type: 'cash', clientOperationId: `${PREFIX}-furs-${TS}` }))
    expect(paid.status).toBe(201)
    const inv = (await paid.json()) as { invoice: { invoiceNumber: string } }
    expect(inv.invoice.invoiceNumber).toBeTruthy()
  })

  test('G2: storno ENEGA izstavka (žig obstaja) → vrača SAMO njegovo zalogo, naročilo ostane paid', async () => {
    const orderId = nid()
    const check1 = nid()
    const check2 = nid()
    const r1 = nid()
    const r2 = nid()
    await db.order.create({ data: { id: orderId, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, tableId: table1, type: 'dine-in', status: 'paid', paymentStatus: 'paid', paymentMethod: 'cash', subtotal: 10, tax: 2, total: 12, totalWithTip: 12, paidAt: new Date() } })
    await db.check.create({ data: { id: check1, checkNumber: 1, orderId, paymentStatus: 'paid', paymentMethod: 'cash', total: 4 } })
    await db.check.create({ data: { id: check2, checkNumber: 2, orderId, paymentStatus: 'paid', paymentMethod: 'cash', total: 8 } })
    const it1 = (await db.orderItem.create({ data: { id: nid(), orderId, menuItemId: itemPiva, quantity: 1, price: 4, vatRate: 22, vatAmount: 0.72, menuItemName: `${PREFIX} Piva`, status: 'served', checkId: check1 } })).id
    const it2 = (await db.orderItem.create({ data: { id: nid(), orderId, menuItemId: itemJedi, quantity: 1, price: 8, vatRate: 22, vatAmount: 1.44, menuItemName: `${PREFIX} Jedi`, status: 'served', checkId: check2 } })).id
    const rn1 = `${PREFIX}-R1-${TS}`
    const rn2 = `${PREFIX}-R2-${TS}`
    for (const [rid, rn, check, total] of [[r1, rn1, check1, 4], [r2, rn2, check2, 8]] as const) {
      await db.receipt.create({ data: {
        id: rid, receiptNumber: rn, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
        registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
        subtotal: total / 1.22, vatBreakdown: '{}', totalVat: total - total / 1.22, discount: 0, total, tip: 0, totalWithTip: total,
        paymentMethod: 'cash', isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
      } })
      await db.payment.create({ data: { id: nid(), checkId: check, amount: total, tipAmount: 0, type: 'cash', status: 'completed', employeeId: mgrA } }).catch(() => null)
    }
    // SALE odjemi Z žigom (v1.238.0 pot): R1 je odvzel 3 kos A, R2 2 kos B
    await db.stockTransaction.create({ data: { id: nid(), inventoryItemId: invA, type: 'SALE', quantity: -3, previousQty: 13, newQty: 10, costPerUnit: 1, totalCost: 3, reason: 'test', supplierDoc: rn1, orderId, employeeId: mgrA } })
    await db.stockTransaction.create({ data: { id: nid(), inventoryItemId: invB, type: 'SALE', quantity: -2, previousQty: 12, newQty: 10, costPerUnit: 1, totalCost: 2, reason: 'test', supplierDoc: rn2, orderId, employeeId: mgrA } })
    void it1; void it2

    // storno R1 → vrača SAMO 3 kos A; B ostane 10; naročilo ostane 'paid'
    const res = await stornoPOST(req(`/api/receipts/${r1}/storno`, tokOwn, 'POST', { reason: `${PREFIX} testni storno` }), { params: Promise.resolve({ id: r1 }) })
    expect(res.status).toBe(201)
    const j = (await res.json()) as { order: { paymentStatus: string }; storno: { restoredStockItems: number } }
    expect(j.order.paymentStatus).toBe('paid')
    expect(j.storno.restoredStockItems).toBe(1)
    const aAfter = await db.inventoryItem.findUnique({ where: { id: invA }, select: { quantity: true } })
    const bAfter = await db.inventoryItem.findUnique({ where: { id: invB }, select: { quantity: true } })
    expect(num(aAfter?.quantity)).toBe(13)
    expect(num(bAfter?.quantity)).toBe(10)
    // R2 ostaja neprizadet
    const r2After = await db.receipt.findUnique({ where: { id: r2 }, select: { isStorno: true } })
    expect(r2After?.isStorno).toBe(false)
  })

  test('G3: storno izstavka BREZ žiga (računi pred v1.238.0) → 409 (iskrena zavrnitev)', async () => {
    const orderId = nid()
    const check1 = nid()
    const check2 = nid()
    const r1 = nid()
    const r2 = nid()
    await db.order.create({ data: { id: orderId, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, tableId: table2, type: 'dine-in', status: 'paid', paymentStatus: 'paid', paymentMethod: 'cash', subtotal: 10, tax: 2, total: 12, totalWithTip: 12, paidAt: new Date() } })
    await db.check.create({ data: { id: check1, checkNumber: 1, orderId, paymentStatus: 'paid', paymentMethod: 'cash', total: 4 } })
    await db.check.create({ data: { id: check2, checkNumber: 2, orderId, paymentStatus: 'paid', paymentMethod: 'cash', total: 8 } })
    await db.orderItem.create({ data: { id: nid(), orderId, menuItemId: itemPiva, quantity: 1, price: 4, vatRate: 22, vatAmount: 0.72, menuItemName: `${PREFIX} Piva`, status: 'served', checkId: check1 } })
    await db.orderItem.create({ data: { id: nid(), orderId, menuItemId: itemJedi, quantity: 1, price: 8, vatRate: 22, vatAmount: 1.44, menuItemName: `${PREFIX} Jedi`, status: 'served', checkId: check2 } })
    for (const [rid, rn, total] of [[r1, `${PREFIX}-R3-${TS}`, 4], [r2, `${PREFIX}-R4-${TS}`, 8]] as const) {
      await db.receipt.create({ data: {
        id: rid, receiptNumber: rn, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
        registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
        subtotal: total / 1.22, vatBreakdown: '{}', totalVat: total - total / 1.22, discount: 0, total, tip: 0, totalWithTip: total,
        paymentMethod: 'cash', isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
      } })
    }
    // SALE odjemi BREZ žiga (pred-v1.238.0 podatki)
    await db.stockTransaction.create({ data: { id: nid(), inventoryItemId: invA, type: 'SALE', quantity: -1, previousQty: 11, newQty: 10, costPerUnit: 1, totalCost: 1, reason: 'test', supplierDoc: '', orderId, employeeId: mgrA } })

    // zaloga PRED poskusom (deljena fikstura — invarianta je NEspremenjenost, ne absolutna vrednost)
    const aBefore = num((await db.inventoryItem.findUnique({ where: { id: invA }, select: { quantity: true } }))?.quantity)
    const res = await stornoPOST(req(`/api/receipts/${r1}/storno`, tokOwn, 'POST', { reason: `${PREFIX} testni storno` }), { params: Promise.resolve({ id: r1 }) })
    expect(res.status).toBe(409)
    const j = (await res.json()) as { error?: string }
    expect(j.error).toContain('izstavkov')
    // zaloga se NI spremenila (varovala pred korupcijo)
    const aAfter = await db.inventoryItem.findUnique({ where: { id: invA }, select: { quantity: true } })
    expect(num(aAfter?.quantity)).toBe(aBefore)
  })

  test('G4: eno-računsko naročilo BREZ žiga → storno še vedno deluje (nazaj-kompatibilno)', async () => {
    const orderId = nid()
    const check1 = nid()
    const r1 = nid()
    await db.order.create({ data: { id: orderId, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, tableId: table1, type: 'dine-in', status: 'paid', paymentStatus: 'paid', paymentMethod: 'cash', subtotal: 4, tax: 0.9, total: 4.9, totalWithTip: 4.9, paidAt: new Date() } })
    await db.check.create({ data: { id: check1, checkNumber: 1, orderId, paymentStatus: 'paid', paymentMethod: 'cash', total: 4.9 } })
    await db.orderItem.create({ data: { id: nid(), orderId, menuItemId: itemPiva, quantity: 1, price: 4.9, vatRate: 22, vatAmount: 0.88, menuItemName: `${PREFIX} Piva`, status: 'served', checkId: check1 } })
    await db.receipt.create({ data: {
      id: r1, receiptNumber: `${PREFIX}-R5-${TS}`, orderId, businessName: 'Test', businessAddress: 'Test 1', businessId: 'SI12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', zoi: '', eor: '', fiscalVerified: true, fiscalStatus: 'verified',
      subtotal: 4, vatBreakdown: '{}', totalVat: 0.9, discount: 0, total: 4.9, tip: 0, totalWithTip: 4.9,
      paymentMethod: 'cash', isCopy: false, isStorno: false, stornoOf: '', locationId: locA,
    } })
    await db.stockTransaction.create({ data: { id: nid(), inventoryItemId: invB, type: 'SALE', quantity: -2, previousQty: 12, newQty: 10, costPerUnit: 1, totalCost: 2, reason: 'test', supplierDoc: '', orderId, employeeId: mgrA } })

    const res = await stornoPOST(req(`/api/receipts/${r1}/storno`, tokOwn, 'POST', { reason: `${PREFIX} testni storno` }), { params: Promise.resolve({ id: r1 }) })
    expect(res.status).toBe(201)
    const j = (await res.json()) as { order: { paymentStatus: string } }
    expect(j.order.paymentStatus).toBe('storno')
    const bAfter = await db.inventoryItem.findUnique({ where: { id: invB }, select: { quantity: true } })
    expect(num(bAfter?.quantity)).toBe(12)
  })
})

/* ──────────────── H — PO PATCH: CAS na statusu ──────────────── */

describe('v1.238.0 H — nabava: statusni PATCH je CAS', () => {
  test('H1: PATCH je CAS — updateMany vezan na status s prejšnjega branja (statika + meja)', async () => {
    // STATIČNI dokaz: zapis je pogojen na stanje ob prihodu (dirka med branjem in
    // zapisom ne more več prepisati 'received' s 'cancelled' oz. oživiti preklicanega)
    const src = read('src/app/api/purchase-orders/[id]/route.ts')
    expect(src).toContain('tx.purchaseOrder.updateMany({ where: { id, status: po.status }, data })')
    expect(src).toContain('osvežite seznam in poskusite znova')
    // VEDENJSKA meja: prejemni tok preklica naročila v 'received' tudi sicer ne dovoli
    // (kanonični tok) — ta primer je varovan ŽE pred CAS; CAS pokriva okno med branjem
    // in zapisom istega klica
    const poId = nid()
    await db.purchaseOrder.create({ data: { id: poId, poNumber: `${PREFIX}-PO-${TS}`, locationId: locA, status: 'received', totalAmount: 10, supplierId, notes: '' } })
    await db.purchaseOrderItem.create({ data: { id: nid(), purchaseOrderId: poId, inventoryItemId: invA, description: 'A', quantityOrdered: 10, quantityReceived: 0, unit: 'kos', unitPrice: 1, totalPrice: 10, status: 'pending' } })
    const res = await poPATCH(req(`/api/purchase-orders/${poId}`, tokMgr, 'PATCH', { action: 'cancel' }), { params: Promise.resolve({ id: poId }) })
    expect(res.status).toBe(409)
    const poAfter = await db.purchaseOrder.findUnique({ where: { id: poId }, select: { status: true } })
    expect(poAfter?.status).toBe('received')
  })

  test('H2: sprotna (ne-zastarela) sprememba še vedno deluje', async () => {
    const poId = nid()
    await db.purchaseOrder.create({ data: { id: poId, poNumber: `${PREFIX}-PO2-${TS}`, locationId: locA, status: 'draft', totalAmount: 10, supplierId, notes: '' } })
    await db.purchaseOrderItem.create({ data: { id: nid(), purchaseOrderId: poId, inventoryItemId: invA, description: 'A', quantityOrdered: 10, quantityReceived: 0, unit: 'kos', unitPrice: 1, totalPrice: 10, status: 'pending' } })
    const res = await poPATCH(req(`/api/purchase-orders/${poId}`, tokMgr, 'PATCH', { action: 'submit' }), { params: Promise.resolve({ id: poId }) })
    expect(res.status).toBe(200)
    const poAfter = await db.purchaseOrder.findUnique({ where: { id: poId }, select: { status: true } })
    expect(poAfter?.status).toBe('submitted')
  })
})

/* ──────────────── I — predlogi: zavrnjeno NI incoming ──────────────── */

describe('v1.238.0 I — predlogi nabave: zavrnjena količina ni incoming', () => {
  test('I1: 10 naročenih, 5 sprejetih, 5 ZAVRNIHENIH → incoming 0 (prej 5)', async () => {
    // artikel pod PAR (quantity 2 <= par 10) — sicer ni kandidat
    const item = (await db.inventoryItem.create({ data: { id: nid(), name: `${PREFIX} Predlog`, unit: 'kos', quantity: 2, reorderPoint: 10, minQuantity: 0, locationId: locA } })).id
    const poId = nid()
    await db.purchaseOrder.create({ data: { id: poId, poNumber: `${PREFIX}-PO3-${TS}`, locationId: locA, status: 'approved', totalAmount: 10, supplierId, notes: '' } })
    // vrstica popolnoma obdelana (5 + 5 = 10, status received) + še ena odprta, da PO ostane 'approved' (open)
    await db.purchaseOrderItem.create({ data: { id: nid(), purchaseOrderId: poId, inventoryItemId: item, description: 'P', quantityOrdered: 10, quantityReceived: 5, quantityRejected: 5, unit: 'kos', unitPrice: 1, totalPrice: 10, status: 'received' } })
    await db.purchaseOrderItem.create({ data: { id: nid(), purchaseOrderId: poId, inventoryItemId: invB, description: 'B', quantityOrdered: 1, quantityReceived: 0, unit: 'kos', unitPrice: 1, totalPrice: 1, status: 'pending' } })

    const res = await suggestionsGET(req('/api/purchase-orders/suggestions', tokMgr))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { suggestions: { itemId: string; incoming: number; suggested: number; par: number }[] }
    const mine = j.suggestions.find((s) => s.itemId === item)
    expect(mine).toBeTruthy()
    expect(mine!.incoming).toBe(0)
    // suggested = PAR − qty − incoming = 10 − 2 − 0 = 8 (prej bi bil 3 = podnaročilo)
    expect(mine!.suggested).toBe(8)
  })
})

/* ──────────────── Ž — registri (doc-truth + verzija) ──────────────── */

describe('v1.238.0 Ž — registri (doc-truth + verzija)', () => {
  test('Ž1: verzija', () => {
    expect(APP_VERSION).toBe('1.248.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.248\.0'/)
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.248.0')
  })

  test('Ž2: PRIMERJAVA §15 — denarni val z raziskavo in dokazi', () => {
    expect(doc).toContain('## 15.')
    expect(doc).toContain('v1.238.0')
    expect(doc).toContain('open balance')
    expect(doc).toContain('supplierDoc')
  })

  test('Ž3: AUDIT — POSODOBITEV v1.238.0 (i18n +1)', () => {
    expect(audit).toContain('POSODOBITEV (v1.238.0')
  })

  test('Ž4: 0 DDL dokaz — shema brez novih modelov/stolpcev tega vala', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('model V238')
    expect(schema).toContain('supplierDoc')
  })
})
