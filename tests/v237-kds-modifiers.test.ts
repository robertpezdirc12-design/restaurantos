import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid } from '@/lib/map'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { GET as kitchenGET } from '../src/app/api/kitchen/route'
import { POST as voidPOST } from '../src/app/api/orders/[id]/void/route'
import { buildKitchenTicketLines } from '../src/lib/devices/print'

/**
 * v1.237.0 — POLISH VAL 3 (docs/PRIMERJAVA-VMESNIKOV-2026 NOVA §14).
 *
 * Raziskava december 2026 / januar 2027 — Toast product updates:
 * »New KDS now supports horizontal modifier display mode« (avgust 2026) +
 * »chimes only for changed tickets in Horizontal modifier display mode«
 * (oktober 2026) + Square KDS vodnik 2026 (»It makes modifiers visible« —
 * naročilo brez opcij je naročilo, ki ga kuhinja ugiba).
 *
 * VRZEL: izbrane opcije postavke (OrderItemModifier, OSS-10 v1.209.0) so
 * v bazi OBSTAJALE, a GET /api/kitchen ni vključil relacije — KDS zaslon
 * in tiskani listki s KDS gumbov so pokazali SAMO ime artikla (kuhar ne
 * vidi »0,5 L«/»zveča sira«). printKitchenTicket je poslal
 * `it.modifiers ?? []` = vedno prazno s te poti.
 *
 * 0 DDL · 0 odvisnosti · 0 AI · 0 novih rut (include + render).
 */

const PREFIX = 'v237-'
const TS = Date.now()

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const kitchenRoute = read('src/app/api/kitchen/route.ts')
const streamRoute = read('src/app/api/kitchen/stream/route.ts')
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
let tokMgr = ''
let itemPiva = ''
let itemJedi = ''
let table1 = ''
let grpVelikost = ''
let grpDodatek = ''
let mod03 = ''
let mod05 = ''
let modZveca = ''
let orderId = ''

/** Reverse-FK čiščenje (idempotentno — beforeAll IN afterAll). */
async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { code: { startsWith: `${PREFIX}-` } } })
  const locIds = locs.map((l) => l.id)
  for (const locId of locIds) {
    const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
    for (const o of orders) {
      const items = await db.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.orderItemModifier.deleteMany({ where: { orderItemId: { in: items.map((i) => i.id) } } }).catch(() => null)
      const receipts = await db.receipt.findMany({ where: { orderId: o.id }, select: { id: true } })
      const checks = await db.check.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { OR: [{ entityId: { in: [...receipts.map((r) => r.id), o.id] } }, { payload: { contains: PREFIX } }] } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...receipts.map((r) => r.id), o.id, ...items.map((i) => i.id)] } }, { details: { contains: PREFIX } }] } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: o.id } }).catch(() => null)
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
    const grps = await db.modifierGroup.findMany({ where: { locationId: locId }, select: { id: true } })
    await db.modifier.deleteMany({ where: { modifierGroupId: { in: grps.map((g) => g.id) } } }).catch(() => null)
    await db.modifierGroup.deleteMany({ where: { id: { in: grps.map((g) => g.id) } } }).catch(() => null)
    await db.employee.deleteMany({ where: { locationId: locId } }).catch(() => null)
    await db.counter.deleteMany({ where: { name: `receipt:${locId}` } }).catch(() => null)
    await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
  }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  await cleanupFixtures()

  locA = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} Lokacija A`, code: `${PREFIX}-A-${TS}`, premisesId: `BLGV237A${TS}`,
      taxId: 'SI12345678', registerNumber: 'BLG-V237-01A', country: 'SI' },
  })).id
  mgrA = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} Vodja A`, email: `${PREFIX}-mgr-a-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-ma-${TS}`, locationId: locA },
  })).id
  tokMgr = createToken({ sub: mgrA, name: `${PREFIX} Vodja A`, role: 'MANAGER', loc: locA, sv: 0 })

  const menuA = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const catA = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId: menuA } })).id
  itemPiva = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Piva`, price: 3.5, categoryId: catA, vatRate: 22 } })).id
  itemJedi = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Jedi`, price: 8, categoryId: catA, vatRate: 22 } })).id
  table1 = (await db.table.create({ data: { id: nid(), number: 73, capacity: 4, locationId: locA, status: 'available' } })).id

  // OSS-10 struktura: skupini opcij (Velikost + Dodatek), povezani na artikel Piva
  grpVelikost = (await db.modifierGroup.create({ data: { id: nid(), name: `${PREFIX} Velikost`, locationId: locA, required: true, minSelect: 1, maxSelect: 1 } })).id
  grpDodatek = (await db.modifierGroup.create({ data: { id: nid(), name: `${PREFIX} Dodatek`, locationId: locA, required: false, minSelect: 0, maxSelect: 2 } })).id
  mod03 = (await db.modifier.create({ data: { id: nid(), name: '0,3 L', price: 0, modifierGroupId: grpVelikost, sortOrder: 1 } })).id
  mod05 = (await db.modifier.create({ data: { id: nid(), name: '0,5 L', price: 1.5, modifierGroupId: grpVelikost, sortOrder: 2 } })).id
  modZveca = (await db.modifier.create({ data: { id: nid(), name: 'Zvečana', price: 0.8, modifierGroupId: grpDodatek, sortOrder: 1 } })).id
  await db.menuItemModifierGroup.create({ data: { id: nid(), menuItemId: itemPiva, modifierGroupId: grpVelikost } })
  await db.menuItemModifierGroup.create({ data: { id: nid(), menuItemId: itemPiva, modifierGroupId: grpDodatek } })
})

afterAll(async () => {
  await cleanupFixtures()
})

describe('v1.237.0 A — API: modifikatorji pridejo na KDS (include relacije)', () => {
  test('A1: naročilo z izbranimi opcijami → queue postavka nosi modifiers po imenih', async () => {
    const res = await ordersPOST(req('/api/orders', tokMgr, 'POST', {
      tableId: table1,
      items: [
        { menuItemId: itemPiva, qty: 2, modifiers: [{ modifierId: mod05 }, { modifierId: modZveca }] },
        { menuItemId: itemJedi, qty: 1 },
      ],
      guests: 2,
      clientOperationId: `v237-opcije-${TS}`,
    }))
    expect(res.status).toBe(201)
    const created = (await res.json()) as { order: { id: string; items: { name: string; modifiers?: string[] }[] } }
    orderId = created.order.id
    // POS/urejevalnik (orders API) jih je nosil že prej (orderInclude od v1.209.0)
    const pivaLine = created.order.items.find((i) => i.name.includes('Piva'))
    expect(pivaLine?.modifiers).toEqual(['0,5 L', 'Zvečana'])

    // KDS vrsta — TO je popravek v1.237.0: include OrderItemModifier
    const kres = await kitchenGET(req('/api/kitchen', tokMgr))
    expect(kres.status).toBe(200)
    const k = (await kres.json()) as { queue: { id: string; items: { name: string; modifiers?: string[] }[] }[] }
    const ticket = k.queue.find((o) => o.id === orderId)
    expect(ticket).toBeTruthy()
    const kpiva = ticket!.items.find((i) => i.name.includes('Piva'))
    expect(kpiva?.modifiers).toEqual(['0,5 L', 'Zvečana'])
    // postavka BREZ izbranih opcij: prazno polje (include prisoten), ne undefined
    const kjedi = ticket!.items.find((i) => i.name.includes('Jedi'))
    expect(kjedi?.modifiers).toEqual([])
  })

  test('A2: preklicana postavka nosi svoje opcije (kuhar ve, KATERA varianta ne gre več)', async () => {
    const kres = await kitchenGET(req('/api/kitchen', tokMgr))
    const k = (await kres.json()) as { queue: { id: string; items: { id: string; name: string }[] }[] }
    const ticket = k.queue.find((o) => o.id === orderId)
    const pivaItem = ticket!.items.find((i) => i.name.includes('Piva'))
    expect(pivaItem).toBeTruthy()

    const vres = await voidPOST(
      req(`/api/orders/${orderId}/void`, tokMgr, 'POST', { itemId: pivaItem!.id, reason: 'napačna velikost' }),
      { params: Promise.resolve({ id: orderId }) },
    )
    expect(vres.status).toBe(200)

    const kres2 = await kitchenGET(req('/api/kitchen', tokMgr))
    const k2 = (await kres2.json()) as { queue: { id: string; items: unknown[]; voidedItems: { name: string; modifiers?: string[]; voidReasonName?: string | null }[] }[] }
    const t2 = k2.queue.find((o) => o.id === orderId)
    expect(t2).toBeTruthy()
    // preklicana Piva še vedno pripoveduje svojo varianto (v1.236.0 vidnost + v1.237.0 opcije)
    const voidedPiva = t2!.voidedItems.find((v) => v.name.includes('Piva'))
    expect(voidedPiva).toBeTruthy()
    expect(voidedPiva!.modifiers).toEqual(['0,5 L', 'Zvečana'])
    // prosti tekst razloga → pošteno brez imena kataloga (v1.236.0 disciplina)
    expect(voidedPiva!.voidReasonName).toBeNull()
  })

  test('A3: vir — include OrderItemModifier v GLAVNI poizvedbi in v poizvedbi preklicanih', () => {
    expect(kitchenRoute).toContain('OrderItemModifier: { select: { name: true } }')
    // obe pojavitvi: glavna vrsta + voidedRows (vsaj 2)
    const hits = kitchenRoute.split('OrderItemModifier: { select: { name: true } }').length - 1
    expect(hits).toBeGreaterThanOrEqual(2)
  })

  test('A4: SSE pretok NESPREMENJEN (tok nosi podpis, klient naloži vrsto — 0 sprememb)', () => {
    expect(streamRoute).not.toContain('OrderItemModifier')
    expect(streamRoute).toContain('kitchenSignature')
  })
})

describe('v1.237.0 B — klient: horizontalna vrstica opcij (Toast horizontal mode)', () => {
  test('B1: vrstica pod imenom — data-region, ena vrstica, ločilo » · «, pogojno', () => {
    expect(dash).toContain('data-region="kds-item-modifiers"')
    expect(dash).toContain("itMods.join(' · ')")
    expect(dash).toContain('{itMods.length > 0 && (')
    // Toast horizontal mode: ena vrstica (break-words za dolge sezname), ne seznam
    const idx = dash.indexOf('data-region="kds-item-modifiers"')
    const block = dash.slice(idx - 200, idx + 400)
    expect(block).toContain('break-words')
    expect(block).not.toContain('<ul')
  })

  test('B2: dostopnost — sr-only predpona (kds.itemOptions) + title s celim seznamom', () => {
    const idx = dash.indexOf('data-region="kds-item-modifiers"')
    const block = dash.slice(idx - 300, idx + 500)
    expect(block).toContain("t('kds.itemOptions')")
    expect(block).toContain('sr-only')
    expect(block).toContain('title={itMods.join')
  })

  test('B3: preklicana vrstica nosi opcije prečrtano (kds-voided-modifiers)', () => {
    expect(dash).toContain('data-region="kds-voided-modifiers"')
    const idx = dash.indexOf('data-region="kds-voided-modifiers"')
    const block = dash.slice(idx - 300, idx + 300)
    expect(block).toContain('line-through')
  })

  test('B4: tip OrderItemT nosi modifiers (živ tip, ne assertions)', () => {
    expect(dash).toContain('modifiers?: string[]; voidReasonName?: string | null }')
  })
})

describe('v1.237.0 C — tisk: opcije na listku (prosti učinek include)', () => {
  test('C1: buildKitchenTicketLines riše »+ opcija« vrstice (obstoječa logika, prvič z pravimi podatki s KDS poti)', () => {
    const lines = buildKitchenTicketLines({
      orderNumber: 42,
      tableName: 'Miza 73',
      type: 'DINE_IN',
      items: [
        { name: 'Piva', qty: 2, note: null, station: 'KITCHEN', allergenWarning: '', allergenCodes: [], modifiers: ['0,5 L', 'Zvečana'] },
        { name: 'Jedi', qty: 1, note: null, station: 'KITCHEN', allergenWarning: '', allergenCodes: [], modifiers: [] },
      ],
    })
    const texts = lines.map((l) => l.text)
    expect(texts).toContain('   + 0,5 L')
    expect(texts).toContain('   + Zvečana')
    // postavka brez opcij → BREZ praznih »+ « vrstic
    const plusLines = texts.filter((t) => t.trim().startsWith('+ '))
    expect(plusLines).toEqual(['   + 0,5 L', '   + Zvečana'])
  })

  test('C2: printKitchenTicket naprej pošilja modifiers iz vrste (?? [] je varovalka, ne izgovor)', () => {
    expect(dash).toContain('modifiers: it.modifiers ?? []')
  })
})

describe('v1.237.0 D — i18n (SL + HR pariteta, 3857 → 3858)', () => {
  test('D1: nov ključ kds.itemOptions v obeh jezikih', () => {
    expect(sl['kds.itemOptions']).toBe('Izbrane opcije')
    expect(hr['kds.itemOptions']).toBe('Odabrane opcije')
  })

  test('D2: pariteta števcev 3858/3858', () => {
    expect(Object.keys(sl).length).toBe(3858)
    expect(Object.keys(hr).length).toBe(3858)
  })
})

describe('v1.237.0 Ž — registri (doc-truth + verzija)', () => {
  test('Ž1: verzija', () => {
    expect(APP_VERSION).toBe('1.237.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.237\.0'/)
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.237.0')
  })

  test('Ž2: PRIMERJAVA §14 (kako ima Toast / kako ima RestaurantOS z datotečnimi potmi)', () => {
    expect(doc).toContain('## 14.')
    expect(doc).toContain('horizontal modifier display mode')
    expect(doc).toContain('src/app/api/kitchen/route.ts')
    expect(doc).toContain('kds-item-modifiers')
    expect(doc).toContain('buildKitchenTicketLines')
    expect(doc).toContain('Sklep §14')
  })

  test('Ž3: AUDIT — števec i18n 3858 + POSODOBITEV v1.237.0', () => {
    expect(audit).toContain('3858 ključev SL in 3858 HR')
    expect(audit).toContain('POSODOBITEV (v1.237.0')
  })

  test('Ž4: 0 DDL — relacija OrderItemModifier obstaja od v1.209.0 (shema nespremenjena)', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).toContain('model OrderItemModifier')
  })
})
