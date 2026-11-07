import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid, num } from '@/lib/map'
import {
  parsePriceOverrideMeta,
  composePriceOverrideMeta,
  validatePriceOverrideInput,
  MAX_PRICE_OVERRIDE_EUR,
} from '../src/lib/price-override'
import {
  CANONICAL_PERMISSIONS,
  PERMISSION_LABELS,
  resolvePermissions,
} from '../src/lib/permissions'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { APP_VERSION } from '../src/lib/version'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as pricePOST } from '../src/app/api/orders/[id]/price-override/route'
import { POST as voidPOST } from '../src/app/api/orders/[id]/void/route'
import { POST as fursPOST } from '../src/app/api/furs/route'

/**
 * v1.249.0 — CENOVNI VAL (docs/PRIMERJAVA-VMESNIKOV-2026 §23).
 *
 * Odložena točka §22 D kot lastni denarni val (disciplina §15/§16): Lightspeed
 * junij 2026 »authorized staff can now override an item's price directly on
 * the POS during an active order«.
 *
 *  A) ČIST SLOJ price-override.ts — parse defenzivno (mrtva shramba
 *     OrderItem.modifiersJson kot nosilec metapodatkov, 0 DDL), compose,
 *     validate strogo (cena ≥ 0 z vezico/piko, razlog OBVEZEN).
 *  B) ŽIVA RUTA /api/orders/[id]/price-override — pravica orders.priceOverride,
 *     tabu 409 (plačano naročilo / plačan izstavek / preklicano / ista cena),
 *     DDV preračunan v isti TX, totals CAS, revizija ORDER_ITEM_PRICE_OVERRIDE.
 *  C) ŽIG na posnetku računa — Receipt.itemsJson nosi priceOverride {from,to}
 *     samo za preganjene postavke (nepreganjene byte-identične).
 *  D) UI — gumb v NaročiloSheet z istimi varovali kot preklic + ✱ oznaka.
 *  E) PRAVICE — kanonični ključ, vodstvo privzeto, natakar NE.
 *
 * 0 DDL · 0 novih odvisnosti · 0 AI.
 */

const PREFIX = 'v249-'
const TS = Date.now()

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const routeSrc = read('src/app/api/orders/[id]/price-override/route.ts')
const libSrc = read('src/lib/price-override.ts')
const issueSrc = read('src/lib/furs/issue.ts')
const fursDetailSrc = read('src/app/api/furs/[id]/route.ts')
const permSrc = read('src/lib/permissions.ts')
const exceptionsRouteSrc = read('src/app/api/reports/exceptions/route.ts')
const exceptionsCardSrc = read('src/components/tabs/exceptions-card.tsx')
const schemaSrc = read('prisma/schema.prisma')
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
let waiterA = ''
let tokMgr = ''
let tokWaiter = ''
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
    await db.counter.deleteMany({ where: { name: { startsWith: `receipt:${locId}` } } }).catch(() => null)
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
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: `BLGV249A${TS}`,
      taxId: 'SI12345678', registerNumber: 'BLG-V249-01A', country: 'SI', timezone: 'Europe/Ljubljana' },
  })).id
  mgrA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Vodja A`, email: `${PREFIX}-mgr-a-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-ma-${TS}`, locationId: locA },
  })).id
  tokMgr = createToken({ sub: mgrA, name: `${PREFIX} Vodja A`, role: 'MANAGER', loc: locA, sv: 0 })
  waiterA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Natakar A`, email: `${PREFIX}-waiter-a-${TS}@test.local`, role: 'waiter', pin: `${PREFIX}-pin-wa-${TS}`, locationId: locA },
  })).id
  tokWaiter = createToken({ sub: waiterA, name: `${PREFIX} Natakar A`, role: 'WAITER', loc: locA, sv: 0 })

  const menuA = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const catA = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuA } })).id
  itemPiva = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Piva`, price: 3.5, categoryId: catA, vatRate: 22 } })).id
  itemJedi = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Jedi`, price: 8, categoryId: catA, vatRate: 22 } })).id
  table1 = (await db.table.create({ data: { id: nid(), number: 92, capacity: 4, locationId: locA, status: 'available' } })).id
})

afterAll(async () => {
  await cleanupFixtures()
  await sweepTestFixtures(db, [PREFIX])
})

/* ─────────── A — čisti sloj price-override.ts ─────────── */

describe('v1.249.0 A — čisti sloj: parse/compose/validate (mrtva shramba modifiersJson)', () => {
  test('A1: parse — legacy vrednosti so BREZ oznake (self-healing, ne napaka)', () => {
    expect(parsePriceOverrideMeta('[]')).toBeNull()
    expect(parsePriceOverrideMeta('{}')).toBeNull()
    expect(parsePriceOverrideMeta('')).toBeNull()
    expect(parsePriceOverrideMeta(null)).toBeNull()
    expect(parsePriceOverrideMeta(undefined)).toBeNull()
    expect(parsePriceOverrideMeta('ne-veljaven json')).toBeNull()
  })

  test('A2: parse — veljavna oznaka {from,to,at,by}', () => {
    const m = parsePriceOverrideMeta(composePriceOverrideMeta({ from: 8, to: 6.5, at: '2026-11-04T14:00:00.000Z', by: 'Vodja' }))
    expect(m).not.toBeNull()
    expect(m!.from).toBe(8)
    expect(m!.to).toBe(6.5)
    expect(m!.at).toBe('2026-11-04T14:00:00.000Z')
    expect(m!.by).toBe('Vodja')
  })

  test('A3: parse — že-parsan objekt (Json stolpec) in protislovja ven', () => {
    expect(parsePriceOverrideMeta({ priceOverride: { from: 1, to: 2, at: 'x', by: 'y' } })).not.toBeNull()
    expect(parsePriceOverrideMeta({ priceOverride: { from: -1, to: 2, at: 'x', by: 'y' } })).toBeNull()
    expect(parsePriceOverrideMeta({ priceOverride: { from: 1, to: 'abc', at: 'x', by: 'y' } })).toBeNull()
    expect(parsePriceOverrideMeta({ priceOverride: { from: 1, to: 2 } })).toBeNull()
    expect(parsePriceOverrideMeta([{ priceOverride: {} }])).toBeNull()
    expect(parsePriceOverrideMeta({ drugo: 1 })).toBeNull()
  })

  test('A4: compose — okrogla pot skozi parse (2 decimalki)', () => {
    const s = composePriceOverrideMeta({ from: 3.505, to: 4.204, at: 'T', by: 'B' })
    const m = parsePriceOverrideMeta(s)
    expect(m!.from).toBe(3.51)
    expect(m!.to).toBe(4.2)
  })

  test('A5: validate — število, niz s PIKO in niz z VEJICO so vsi veljavni', () => {
    expect(validatePriceOverrideInput({ price: 4.5, reason: 'dnevna cena' })).toEqual({ ok: true, price: 4.5, reason: 'dnevna cena' })
    expect(validatePriceOverrideInput({ price: '4.50', reason: 'dnevna cena' })).toEqual({ ok: true, price: 4.5, reason: 'dnevna cena' })
    expect(validatePriceOverrideInput({ price: '4,50', reason: 'dnevna cena' })).toEqual({ ok: true, price: 4.5, reason: 'dnevna cena' })
    expect(validatePriceOverrideInput({ price: 0, reason: 'gost na domu' })).toEqual({ ok: true, price: 0, reason: 'gost na domu' })
  })

  test('A6: validate — zavrnitve: negativna, prevelika, manjkajoča, nerazumljiva', () => {
    expect(validatePriceOverrideInput({ price: -1, reason: 'test' }).ok).toBe(false)
    expect(validatePriceOverrideInput({ price: MAX_PRICE_OVERRIDE_EUR + 1, reason: 'test' }).ok).toBe(false)
    expect(validatePriceOverrideInput({ reason: 'brez cene' }).ok).toBe(false)
    expect(validatePriceOverrideInput({ price: 'abc', reason: 'test' }).ok).toBe(false)
    expect(validatePriceOverrideInput(null).ok).toBe(false)
    expect(validatePriceOverrideInput({ price: 5 }).ok).toBe(false) // razlog OBVEZEN
    expect(validatePriceOverrideInput({ price: 5, reason: 'ab' }).ok).toBe(false) // ≥ 3 znaki
  })

  test('A7: validate — razlog se potrdi in kapira; 2 decimalki', () => {
    const r = validatePriceOverrideInput({ price: 5.999, reason: '  dogovor z gostom  ' })
    expect(r).toEqual({ ok: true, price: 6, reason: 'dogovor z gostom' })
    const long = validatePriceOverrideInput({ price: 5, reason: 'x'.repeat(500) })
    expect(long.ok).toBe(true)
    if (long.ok) expect(long.reason.length).toBe(200)
  })

  test('A8: čisti sloj — 0 uvozov (vzorec v248 čistih slojev)', () => {
    expect(libSrc).not.toContain("from '")
    expect(libSrc).not.toContain('require(')
  })
})

/* ─────────── B — živa ruta: pravice, tabuji, DDV, totals, revizija ─────────── */

describe('v1.249.0 B — POST /api/orders/[id]/price-override (živo, sqlite)', () => {
  test('B1: natakar BREZ pravice → 403; vodja (privzeto ENHANCED) → 200', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string; items: { id: string }[] } }
    const oId = co.order.id
    const itId = co.order.items[0]!.id

    const denied = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokWaiter, 'POST', { itemId: itId, price: 6, reason: 'preizkus brez pravice' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(denied.status).toBe(403)

    const okRes = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: itId, price: 6, reason: 'dnevna cena rib' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(okRes.status).toBe(200)
  })

  test('B2: 404 naročilo / 404 tuja postavka', async () => {
    await resetOrders()
    const missing = await pricePOST(
      req(`/api/orders/ne-obstaja/price-override`, tokMgr, 'POST', { itemId: 'x', price: 5, reason: 'test' }),
      { params: Promise.resolve({ id: 'ne-obstaja' }) },
    )
    expect(missing.status).toBe(404)

    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }], type: 'DINE_IN', guests: 1,
    }))
    const co = (await created.json()) as { order: { id: string } }
    const foreign = await pricePOST(
      req(`/api/orders/${co.order.id}/price-override`, tokMgr, 'POST', { itemId: 'tuja-postavka', price: 5, reason: 'test' }),
      { params: Promise.resolve({ id: co.order.id }) },
    )
    expect(foreign.status).toBe(404)
  })

  test('B3: ista cena → 400; razlog manjka → 400; neveljavna cena → 400', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 1,
    }))
    const co = (await created.json()) as { order: { id: string; items: { id: string }[] } }
    const oId = co.order.id
    const itId = co.order.items[0]!.id

    const same = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: itId, price: 8, reason: 'ista cena' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(same.status).toBe(400)

    const noReason = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: itId, price: 6 }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(noReason.status).toBe(400)

    const badPrice = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: itId, price: -2, reason: 'negativna' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(badPrice.status).toBe(400)
  })

  test('B4: SREČNA POT — cena 8 → 6,50: cena + DDV + oznaka + totals v ENI transakciji', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemJedi, qty: 2 }], type: 'DINE_IN', guests: 2,
    }))
    expect(created.status).toBe(201)
    const co = (await created.json()) as { order: { id: string; items: { id: string }[] } }
    const oId = co.order.id
    const itId = co.order.items[0]!.id

    const before = await db.order.findUnique({ where: { id: oId }, select: { subtotal: true, tax: true, total: true } })
    expect(num(before!.total)).toBe(16) // 2 × 8,00

    const res = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: itId, price: 6.5, reason: 'dogovor z gostom' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(res.status).toBe(200)
    const j = (await res.json()) as { overridden: { oldPrice: number; newPrice: number; delta: number }; order: { total: number; items: { priceOverride: { from: number; to: number } | null }[] } }
    expect(j.overridden.oldPrice).toBe(8)
    expect(j.overridden.newPrice).toBe(6.5)
    expect(j.overridden.delta).toBe(-3) // (6,50 − 8) × 2

    const item = await db.orderItem.findUnique({ where: { id: itId } })
    expect(num(item!.price)).toBe(6.5)
    // DDV preračunan v isti TX: 13,00 bruto pri 22 % → DDV 2,35 (ne stari 2,88)
    expect(num(item!.vatAmount)).toBeCloseTo(2.34, 2)
    // oznaka v mrtvi shrambi (0 DDL)
    const meta = parsePriceOverrideMeta(item!.modifiersJson)
    expect(meta).not.toBeNull()
    expect(meta!.from).toBe(8)
    expect(meta!.to).toBe(6.5)
    expect(meta!.by).toContain('Vodja')
    // totals so bili preračunani (13,00 namesto 16,00) — mapa jih nosi
    expect(j.order.total).toBe(13)
    // aditivno polje v odgovoru (mapOrderItem)
    const mapped = j.order.items.find((i) => parsePriceOverrideMeta('') === null && i.priceOverride)
    expect(mapped?.priceOverride).toEqual({ from: 8, to: 6.5, at: meta!.at, by: meta!.by })
  })

  test('B5: revizija ORDER_ITEM_PRICE_OVERRIDE v verigi (PO commitu) — stara/nova/delta/razlog', async () => {
    const aud = await db.auditLog.findFirst({
      where: { action: 'ORDER_ITEM_PRICE_OVERRIDE', details: { contains: 'dogovor z gostom' } },
      orderBy: { timestamp: 'desc' },
    })
    expect(aud).toBeTruthy()
    const d = JSON.parse(aud!.details) as { oldPrice: number; newPrice: number; delta: number; reason: string; by: string; item: string; quantity: number }
    expect(d.oldPrice).toBe(8)
    expect(d.newPrice).toBe(6.5)
    expect(d.delta).toBe(-3)
    expect(d.reason).toBe('dogovor z gostom')
    expect(d.by).toContain('Vodja')
    expect(d.quantity).toBe(2)
  })

  test('B6: PONOVNA sprememba — from je sedanjost (6,50 → 7), previousOverride v reviziji', async () => {
    const orders = await db.order.findMany({ where: { locationId: locA, status: 'open' }, select: { id: true } })
    const oId = orders[0]!.id
    const it = await db.orderItem.findFirst({ where: { orderId: oId } })
    const res = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: it!.id, price: 7, reason: 'popravek zjutraj' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(res.status).toBe(200)
    const item = await db.orderItem.findUnique({ where: { id: it!.id } })
    const meta = parsePriceOverrideMeta(item!.modifiersJson)
    expect(meta!.from).toBe(6.5)
    expect(meta!.to).toBe(7)
    const aud = await db.auditLog.findFirst({
      where: { action: 'ORDER_ITEM_PRICE_OVERRIDE', details: { contains: 'popravek zjutraj' } },
      orderBy: { timestamp: 'desc' },
    })
    const d = JSON.parse(aud!.details) as { previousOverride: { from: number; to: number } | undefined }
    expect(d.previousOverride).toEqual({ from: 8, to: 6.5, at: expect.any(String), by: expect.any(String) })
  })

  test('B7: preklicana postavka → 409', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 1,
    }))
    const co = (await created.json()) as { order: { id: string; items: { id: string }[] } }
    const oId = co.order.id
    const itId = co.order.items[0]!.id

    const voided = await voidPOST(
      req(`/api/orders/${oId}/void`, tokMgr, 'POST', { itemId: itId, reason: 'napačen vnos' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(voided.status).toBe(200)

    const denied = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: itId, price: 5, reason: 'preklicana' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(denied.status).toBe(409)
  })

  test('B8: PLAČANO naročilo → 409 (fiskalni storno je ločena pot)', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 1,
    }))
    const co = (await created.json()) as { order: { id: string; items: { id: string }[] } }
    const oId = co.order.id
    const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', {
      orderId: oId, type: 'cash', clientOperationId: `${PREFIX}-furs-b8-${TS}`,
    }))
    expect(paid.status).toBe(201)

    const denied = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: co.order.items[0]!.id, price: 5, reason: 'prepozno' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(denied.status).toBe(409)
    const msg = (await denied.json()) as { error: string }
    expect(msg.error).toContain('fiskalni storno')
  })

  test('B9: postavka na PLAČANEM izstavku delno plačanega naročila → 409 (§16 D)', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }, { menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    const co = (await created.json()) as { order: { id: string; items: { id: string; name: string }[] } }
    const oId = co.order.id
    const jedi = co.order.items.find((i) => i.name.includes('Jedi'))!
    const piva = co.order.items.find((i) => i.name.includes('Piva'))!

    const split = await (await import('../src/app/api/orders/[id]/checks/route')).POST(
      req(`/api/orders/${oId}/checks`, tokMgr, 'POST', { itemIds: [jedi.id] }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(split.status).toBe(200)
    const checks = await db.check.findMany({ where: { orderId: oId }, orderBy: { checkNumber: 'asc' } })
    const check1 = checks.find((c) => c.checkNumber === 1)!

    const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', {
      orderId: oId, checkId: check1.id, type: 'cash', clientOperationId: `${PREFIX}-furs-b9-${TS}`,
    }))
    expect(paid.status).toBe(201)
    const mid = await db.order.findUnique({ where: { id: oId }, select: { paymentStatus: true } })
    expect(mid?.paymentStatus).toBe('partial')

    // postavka PLAČANEGA izstavka (Piva — split je Jedi prestavil na izstavek #2,
    // izstavek #1 = OSTATEK = Piva) → 409
    const denied = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: piva.id, price: 2, reason: 'na plačenem' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(denied.status).toBe(409)
    expect(((await denied.json()) as { error: string }).error).toContain('plačanem izstavku')

    // Jedi na NEPLAČANEM izstavku #2 istega 'partial' naročila ostane dovoljena
    // (Toast: refund ne razplača celote — odprti izstavki živijo naprej)
    const allowed = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: jedi.id, price: 6, reason: 'odprti izstavek' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(allowed.status).toBe(200)
  })

  test('B10: vir pina — ruta nosi CAS (price: curItem.price v where) + recalc v isti TX', () => {
    expect(routeSrc).toContain("requirePermission(req, 'orders.priceOverride')")
    expect(routeSrc).toContain('where: { id: itemId, orderId: id, voided: false, price: curItem.price }')
    expect(routeSrc).toContain('vatFromGross')
    expect(routeSrc).toContain('recalcOrderTotals(id, tx)')
    expect(routeSrc).toContain('ORDER_ITEM_PRICE_OVERRIDE')
    // razlog OBVEZEN v validaciji (ne politika izjem):
    expect(routeSrc).not.toContain('requireReasonVoid')
  })
})

/* ─────────── C — žig na posnetku računa (Receipt.itemsJson) ─────────── */

describe('v1.249.0 C — FURS posnetek: priceOverride žig samo na preganjenih vrsticah', () => {
  test('C1: vir — issue.ts vzame oznako v billItems in jo da na posnetek; branje posreduje', () => {
    expect(issueSrc).toContain("import { parsePriceOverrideMeta } from '@/lib/price-override'")
    expect(issueSrc).toContain('priceOverride: parsePriceOverrideMeta(it.modifiersJson)')
    // aditivno — ključ IZOSTANE za nepreganjene:
    expect(issueSrc).toContain("...(it.priceOverride ? { priceOverride: { from: it.priceOverride.from, to: it.priceOverride.to } } : {})")
    expect(fursDetailSrc).toContain('priceOverride')
  })

  test('C2: ŽIVO — preganjena postavka na izdanem računu nosi {from,to}; nastrojena NE', async () => {
    await resetOrders()
    const created = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1, items: [{ menuItemId: itemPiva, qty: 1 }, { menuItemId: itemJedi, qty: 1 }], type: 'DINE_IN', guests: 2,
    }))
    const co = (await created.json()) as { order: { id: string; items: { id: string; name: string }[] } }
    const oId = co.order.id
    const jedi = co.order.items.find((i) => i.name.includes('Jedi'))!
    const piva = co.order.items.find((i) => i.name.includes('Piva'))!

    // samo Jedi (8 → 6,50) je preganjena; Piva ostane 3,50
    const res = await pricePOST(
      req(`/api/orders/${oId}/price-override`, tokMgr, 'POST', { itemId: jedi.id, price: 6.5, reason: 'C2 žig' }),
      { params: Promise.resolve({ id: oId }) },
    )
    expect(res.status).toBe(200)

    const paid = await fursPOST(req('/api/furs', tokMgr, 'POST', {
      orderId: oId, type: 'cash', clientOperationId: `${PREFIX}-furs-c2-${TS}`,
    }))
    expect(paid.status).toBe(201)

    const receipt = await db.receipt.findFirst({ where: { orderId: oId }, orderBy: { createdAt: 'desc' } })
    expect(receipt).toBeTruthy()
    const snap = JSON.parse(receipt!.itemsJson) as { name: string; price: number; priceOverride?: { from: number; to: number } }[]
    const jediLine = snap.find((s) => s.name.includes('Jedi'))!
    expect(jediLine.price).toBe(6.5)
    expect(jediLine.priceOverride).toEqual({ from: 8, to: 6.5 })
    const pivaLine = snap.find((s) => s.name.includes('Piva'))!
    expect(pivaLine.price).toBe(3.5)
    expect(pivaLine.priceOverride).toBeUndefined() // aditivno — byte-identično
    // total računa po novi ceni: 3,50 + 6,50 = 10,00
    expect(num(receipt!.total)).toBe(10)
  })
})

/* ─────────── D — UI: gumb z varovali, dialog, ✱ oznaka ─────────── */

describe('v1.249.0 D — UI montaža (NaročiloSheet)', () => {
  test('D1: gumb 💰 z ISTIMI tremi varovali kot preklic', () => {
    expect(dash).toContain("hasPerm('orders.priceOverride') && orderSheet.paymentStatus !== 'paid' && !it.checkPaid")
    expect(dash).toContain("title={t('prc.button')}")
    expect(dash).toContain('<Coins className="w-3 h-3" />')
  })

  test('D2: dialog — trenutna cena readonly, nova cena decimal, razlog obvezen', () => {
    expect(dash).toContain("t('prc.title')")
    expect(dash).toContain('id="prc-current"')
    expect(dash).toContain('id="prc-new"')
    expect(dash).toContain('inputMode="decimal"')
    expect(dash).toContain('id="prc-reason"')
    expect(dash).toContain('confirmPriceOverride()')
  })

  test('D3: ✱ oznaka na vrstici s tooltipom (prejšnja cena + kdo)', () => {
    expect(dash).toContain('it.priceOverride &&')
    // v1.276.0 CI-fix: tooltip cene gre skozi fmtEUR (centralni formatir,
    // sl-SI vejica) — prevez pina iz toFixed(2) oblike
    expect(dash).toContain("title={`${t('prc.mark')}: ${fmtEUR(it.priceOverride.from)} → ${fmtEUR(it.priceOverride.to)} · ${it.priceOverride.by}`}")
  })

  test('D4: OrderItemT nosi priceOverride; i18n ključi prc.* v SL/HR', () => {
    expect(dash).toContain('priceOverride?: { from: number; to: number; at: string; by: string } | null')
    for (const k of ['prc.button', 'prc.title', 'prc.current', 'prc.new', 'prc.newPh', 'prc.reason', 'prc.reasonPh', 'prc.confirm', 'prc.done', 'prc.invalid', 'prc.reasonMissing', 'prc.mark']) {
      expect(sl[k]).toBeTruthy()
      expect(hr[k]).toBeTruthy()
    }
    expect(sl['exc.report.kind.price_override']).toBe('Sprememba cene')
    expect(hr['exc.report.kind.price_override']).toBe('Promjena cijene')
  })

  test('D5: poročilo izjem — nova vrsta price_override (ruta + kartica)', () => {
    expect(exceptionsRouteSrc).toContain("ORDER_ITEM_PRICE_OVERRIDE: 'price_override'")
    expect(exceptionsRouteSrc).toContain("case 'price_override':")
    expect(exceptionsCardSrc).toContain("'price_override'")
    expect(exceptionsCardSrc).toContain('price_override: ')
  })
})

/* ─────────── E — pravice: kanonični ključ, vodstvo da, natakar ne ─────────── */

describe('v1.249.0 E — pravice orders.priceOverride', () => {
  test('E1: kanonični seznam + labela', () => {
    expect((CANONICAL_PERMISSIONS as readonly string[]).includes('orders.priceOverride')).toBe(true)
    expect(PERMISSION_LABELS['orders.priceOverride']).toContain('sprememba cene')
  })

  test('E2: vodstvo (manager/property_manager) PRIVZETO; natakar/kuhinja NE', () => {
    expect((resolvePermissions('manager', []) as readonly string[]).includes('orders.priceOverride')).toBe(true)
    expect((resolvePermissions('property_manager', []) as readonly string[]).includes('orders.priceOverride')).toBe(true)
    expect((resolvePermissions('owner', []) as readonly string[]).includes('orders.priceOverride')).toBe(true)
    expect((resolvePermissions('waiter', []) as readonly string[]).includes('orders.priceOverride')).toBe(false)
    expect((resolvePermissions('staff', []) as readonly string[]).includes('orders.priceOverride')).toBe(false)
    expect((resolvePermissions('chef', []) as readonly string[]).includes('orders.priceOverride')).toBe(false)
  })

  test('E3: override dodaja (issue #1 pravilo) — natakar z overrideom DOBI', () => {
    expect((resolvePermissions('waiter', ['orders.priceOverride']) as readonly string[]).includes('orders.priceOverride')).toBe(true)
  })

  test('E4: NI full-only (podelitev je lastnikova izbira — isto hierarhijo kot orders.void)', () => {
    expect(permSrc).not.toContain("'orders.priceOverride',\n] as const\n\n/**\n * ISSUE #75 5.1 (C1) — lastniški (FULL-only) ključi")
  })
})

/* ─────────── Ž — registri ─────────── */

describe('v1.249.0 Ž — registri in pini', () => {
  test('Ž1: verzija 1.249.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.276.0')
    const versionFile = read('src/lib/version.ts')
    expect(versionFile).toContain("'1.276.0'")
    const compose = read('deploy/docker-compose.yml')
    expect(compose).toContain('restaurantos:1.276.0')
  })

  test('Ž2: i18n pariteta SL/HR 4002/4002 (+13: prc×12 + exc.report.kind.price_override)', () => {
    expect(Object.keys(sl).length).toBe(4320)
    expect(Object.keys(hr).length).toBe(4320)
  })

  test('Ž3: dokumenti — PRIMERJAVA §23 CENOVNI VAL + AUDIT števci', () => {
    expect(doc).toContain('## 23. Raziskava maj/junij 2026 — CENOVNI VAL v1.249.0')
    expect(doc).toContain('orders.priceOverride')
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('4320 ključev SL in 4320 HR')
    expect(audit).toContain('**POSODOBITEV (v1.249.0, PRIMERJAVA-VMESNIKOV-2026 §23 — cenovni val):**')
  })

  test('Ž4: 0 DDL dokaz — shema brez novih modelov/stolpcev (mrtva shramba + komentar)', () => {
    // modifiersJson je ZGODOVINSKO ime — nosilec metapodatkov, ne nov stolpec:
    expect(schemaSrc).toContain('modifiersJson     String              @default("[]")')
    expect(schemaSrc).toContain('{"priceOverride":{from,to,at,by}} (0 DDL')
    // NI novega stolpca priceOverride v OrderItem:
    const orderItemBlock = schemaSrc.slice(schemaSrc.indexOf('model OrderItem {'), schemaSrc.indexOf('model OrderItemModifier'))
    expect(orderItemBlock).not.toMatch(/^\s+priceOverride\s/m)
  })

  test('Ž5: worklog vrhnji vnos nosi Task ID v1.249.0', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.276.0-decimalna-locila')
  })

  test('Ž6: ruta pošilja dogodev + push (osvežitev plošč PO commitu)', () => {
    expect(routeSrc).toContain("publishEvent('OrderItemPriceOverride'")
    expect(routeSrc).toContain("pushToLocationRoles(order.locationId, ['manager']")
  })

  test('Ž7: izjemno poročilo šteje |delta| (navzgor tudi)', () => {
    expect(exceptionsRouteSrc).toContain('Math.abs(num(d.delta))')
  })
})
