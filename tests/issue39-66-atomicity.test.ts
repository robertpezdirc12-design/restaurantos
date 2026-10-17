/**
 * Issue #39 (P1) — ATOMARNOST preklica postavke:
 *  - claim postavke (CAS z vezavo orderId), razlog, preračun in zapis
 *    Order.subtotal/tax/total/totalWithTip v ENI transakciji;
 *  - padec PO claimu (SQLite trigger FORCIRA napako) → rollback postavke/razloga;
 *  - sočasna void DVEH različnih postavk (Promise.all) → obe uspešno, končni
 *    zneski točno ustrezajo preostalim postavkam (optimistični CAS + retry);
 *  - sočasni void + addItems → BREZ izgubljenega posodobitve (totals ≡ recalc);
 *  - odgovor/audit: amountRemovedFromOrder (NETO, brez davka) — NE "refund".
 *
 * Issue #66 (P1) — SERIALIZACIJA popisa:
 *  - PATCH claim DRAFT + zapisi vrstic v ENI transakciji (vezava stocktakeId
 *    v sami mutaciji);
 *  - RACE: submit zmagá MED PATCH-validacijo (monkey-patch findMany — točno
 *    okno, ki ga issue opisuje) → PATCH 409, vrstice NEPREDOSTAVLJENE, brez
 *    audit lažnega uspeha;
 *  - rollback: trigger na StocktakeItem → brez delnih zapisov, status DRAFT;
 *  - PATCH zmagá → submit zaklene TOČNO shranjene količine; recount ponovno
 *    odpre (SUBMITTED → DRAFT) in PATCH spet deluje;
 *  - tuja vrstica (drug popis) → 400; tujа lokacija → 403.
 *
 * ID-ji s predpono `i3966-` (idempotentno, sweep beforeAll/afterAll; nid-idji
 * popisov se počistijo preko lokacijskega prehoda + eksplicitnega afterAll).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { num } from '../src/lib/map'
import { recalcOrderTotals } from '../src/lib/ops'
import { POST as orderVoidPOST } from '../src/app/api/orders/[id]/void/route'
import { PATCH as orderPATCH } from '../src/app/api/orders/[id]/route'
import { PATCH as stocktakePATCH } from '../src/app/api/stocktakes/[id]/route'
import { POST as stocktakeOpenPOST } from '../src/app/api/stocktakes/route'
import { POST as submitPOST } from '../src/app/api/stocktakes/[id]/submit/route'
import { POST as recountPOST } from '../src/app/api/stocktakes/[id]/recount/route'
import { POST as approvePOST } from '../src/app/api/stocktakes/[id]/approve/route'

const PREFIX = 'i3966-'
const RUN = Date.now().toString(36)

let orgA = '', brandA = '', propA = ''
let locA = '', locB = ''
let managerA = '', managerB = '', waiterA = ''
let menuId = '', catId = '', miId = ''
let voidReasonA = ''
let invS1 = '', invS2 = ''
let stId = '', stBId = ''
let stLineIds: string[] = []
let orderSeq = 39660

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

/** Žetoni s POLNIM imenom (route zapisuje user.name v countedByName/audit). */
function tokM(): string {
  return createToken({ sub: managerA, name: `${PREFIX}managerA`, role: 'MANAGER', loc: locA, sv: 0 })
}
function tokMB(): string {
  return createToken({ sub: managerB, name: `${PREFIX}managerB`, role: 'MANAGER', loc: locB, sv: 0 })
}
function tokW(): string {
  return createToken({ sub: waiterA, name: `${PREFIX}waiterA`, role: 'WAITER', loc: locA, sv: 0 })
}

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const isResp = (r: unknown): r is Response => r instanceof Response

/** Route handler vrne obljubljeno vrednost — awaitamo jo TUKAJ. */
async function status(r: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const v = (await (r as Promise<unknown> | Response)) as unknown
  expect(isResp(v)).toBe(true)
  const res = v as Response
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function seedEmployee(name: string, role: string, loc: string, pinSeq: number): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
  // pinLookup je globalno unikaten PO PIN-u — PIN izpeljemo iz unikatnega ID-ja
  const pin = String(10000000 + ([...`${id}${pinSeq}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 89999999, 7)))
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${name}`, email: `${PREFIX}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  return id
}

interface SeedItem {
  id: string
  qty: number
  price: number
  vatRate: number
  vatAmount: number
  discountAmount?: number
  status?: string
}

/** Naročilo s postavkami + zneski "kot bi jih izračunal recalc" (predvoid stanje). */
async function seedOrderWithItems(loc: string, items: SeedItem[]): Promise<{ orderId: string; itemIds: string[] }> {
  const orderId = `${PREFIX}ord-${++orderSeq}-${RUN}`
  await db.order.create({
    data: { id: orderId, locationId: loc, orderNumber: orderSeq, status: 'open', paymentStatus: 'unpaid', type: 'dine-in' },
  })
  let subtotal = 0
  let tax = 0
  const itemIds: string[] = []
  for (const it of items) {
    await db.orderItem.create({
      data: {
        id: `${PREFIX}${it.id}-${RUN}`, orderId, menuItemId: miId, menuItemName: `${PREFIX} ${it.id}`,
        quantity: it.qty, price: it.price, vatRate: it.vatRate, vatAmount: it.vatAmount,
        discountAmount: it.discountAmount ?? 0, status: it.status ?? 'pending',
      },
    })
    itemIds.push(`${PREFIX}${it.id}-${RUN}`)
    // Naloga #6: price je KONČNA cena → subtotal je NETO osnova (line − DDV),
    // total pa kar vsota končnih cen (recalc povzame isto pravilo).
    subtotal += it.price * it.qty - it.vatAmount
    tax += it.vatAmount
  }
  await db.order.update({
    where: { id: orderId },
    data: { subtotal, tax, total: subtotal + tax, totalWithTip: subtotal + tax },
  })
  return { orderId, itemIds }
}

function voidReq(orderId: string, itemId: string, extra: Record<string, unknown> = {}) {
  return orderVoidPOST(req(`/api/orders/${orderId}/void`, tok(managerA, 'm', 'MANAGER', locA), 'POST', { itemId, reasonId: voidReasonA, ...extra }), { params: Promise.resolve({ id: orderId }) })
}

async function openStocktake(loc: string, token: string): Promise<{ id: string; lines: string[] }> {
  const r = await status(stocktakeOpenPOST(req('/api/stocktakes', token, 'POST', { note: `${PREFIX} popis` })))
  expect(r.code).toBe(201)
  const st = r.body.stocktake as { id: string; items: { id: string }[] }
  return { id: st.id, lines: st.items.map((i) => i.id) }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  locA = `${PREFIX}locA-${RUN}`; locB = `${PREFIX}locB-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'I3966 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'BA' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'PA' } })
  await db.location.create({ data: { id: locA, name: 'I3966 A', code: `${PREFIX}A-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB, name: 'I3966 B', code: `${PREFIX}B-${RUN}` } })

  managerA = await seedEmployee('managerA', 'MANAGER', locA, 1)
  managerB = await seedEmployee('managerB', 'MANAGER', locB, 2)
  waiterA = await seedEmployee('waiterA', 'WAITER', locA, 3)

  // meni (OrderItem FK + addItems test)
  menuId = (await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: 'I3966 Meni', locationId: locA } })).id
  catId = (await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: 'I3966 Kategorija', menuId } })).id
  miId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: 'I3966 Pizza', price: 10, vatRate: 22, categoryId: catId, isAvailable: true } })).id

  // katalog razlogov preklica
  voidReasonA = (await db.voidReason.create({
    data: { id: `${PREFIX}vr-${RUN}`, name: 'I3966 razlog', sortOrder: 1, locationId: locA },
  })).id

  // zaloga za popis (obe lokaciji — tujа vrstica test)
  invS1 = (await db.inventoryItem.create({ data: { id: `${PREFIX}inv1-${RUN}`, name: `${PREFIX} Moka`, unit: 'kg', quantity: 10, minQuantity: 1, costPerUnit: 2, locationId: locA } })).id
  invS2 = (await db.inventoryItem.create({ data: { id: `${PREFIX}inv2-${RUN}`, name: `${PREFIX} Solata`, unit: 'kg', quantity: 5, minQuantity: 1, costPerUnit: 1, locationId: locA } })).id
  await db.inventoryItem.create({ data: { id: `${PREFIX}invB-${RUN}`, name: `${PREFIX} Olje B`, unit: 'l', quantity: 7, minQuantity: 1, costPerUnit: 3, locationId: locB } })

  // popis A (več testov) + popis B (tuja vrstica)
  const stA = await openStocktake(locA, tok(managerA, 'm', 'MANAGER', locA))
  stId = stA.id
  stLineIds = stA.lines
  const stB = await openStocktake(locB, tok(managerB, 'mb', 'MANAGER', locB))
  stBId = stB.id
})

afterAll(async () => {
  // eksplicitno počisti audite z nid-entityId (popisi) pred sweep-om
  await db.auditLog.deleteMany({ where: { entityId: { in: [stId, stBId] } } })
  await db.stockTransaction.deleteMany({ where: { inventoryItemId: { in: [invS1, invS2, `${PREFIX}invB-${RUN}`] } } })
  await sweepTestFixtures(db, [PREFIX])
})

/* ════════════════════════════ Issue #39 — void ════════════════════════════ */

describe('issue #39 — atomaren preklic postavke + preračun', () => {
  it('happy path: ena transakcija — postavka voided, zneski (22 % + 9,5 % + popust + totalWithTip) točno, amountRemovedFromOrder (NE refund), 1 audit', async () => {
    // iA: 2×10 @22 % (ddv 3,28); iB: 1×5 @9,5 % (ddv 0,43); iC: 1×8 @22 % (ddv 1,45, popust vrstice 1)
    const { orderId, itemIds } = await seedOrderWithItems(locA, [
      { id: 'a', qty: 2, price: 10, vatRate: 22, vatAmount: 3.28 },
      { id: 'b', qty: 1, price: 5, vatRate: 9.5, vatAmount: 0.43 },
      { id: 'c', qty: 1, price: 8, vatRate: 22, vatAmount: 1.45, discountAmount: 1 },
    ])
    const before = await db.order.findUnique({ where: { id: orderId } })
    expect(num(before?.total)).toBeCloseTo(33, 2)

    const r = await status(voidReq(orderId, itemIds[1]))
    expect(r.code).toBe(200)
    const voided = r.body.voided as Record<string, unknown>
    // #39: nedvoumen izraz — NETO zmanjšanje (brez davka), NI "refund"
    expect(voided.amountRemovedFromOrder).toBe(5)
    expect(Object.keys(voided)).not.toContain('refund')
    expect(voided.reason).toBe('I3966 razlog')

    // postavka: preklicana + razlog iz kataloga; sosednji NET
    const bItem = await db.orderItem.findUnique({ where: { id: itemIds[1] } })
    expect(bItem?.voided).toBe(true)
    expect(bItem?.voidReasonId).toBe(voidReasonA)
    for (const other of [itemIds[0], itemIds[2]]) {
      const it = await db.orderItem.findUnique({ where: { id: other } })
      expect(it?.voided).toBe(false)
    }

    // zneski ≡ recalc nad preostalimi (iA + iC): 23,27 neto + 4,73 ddv = 28,00 za plačilo
    const after = await db.order.findUnique({ where: { id: orderId } })
    expect(num(after?.subtotal)).toBeCloseTo(23.27, 2)
    expect(num(after?.tax)).toBeCloseTo(4.73, 2)
    expect(num(after?.total)).toBeCloseTo(28, 2)
    expect(num(after?.totalWithTip)).toBeCloseTo(28, 2)

    // audit: točno en dogodek, ključ amountRemovedFromOrder
    const audits = await db.auditLog.findMany({ where: { action: 'ORDER_ITEM_VOID', entityId: itemIds[1] } })
    expect(audits.length).toBe(1)
    expect(String(audits[0]?.details)).toContain('"amountRemovedFromOrder":5')
    expect(String(audits[0]?.details)).not.toContain('"refund"')
  })

  it('ponovljen void iste postavke → 409 (CAS) + NE ustvari drugega audita', async () => {
    const { orderId, itemIds } = await seedOrderWithItems(locA, [
      { id: 'd', qty: 1, price: 6, vatRate: 22, vatAmount: 1.08 },
    ])
    const first = await status(voidReq(orderId, itemIds[0]))
    expect(first.code).toBe(200)
    const auditsBefore = await db.auditLog.count({ where: { action: 'ORDER_ITEM_VOID', entityId: itemIds[0] } })
    const second = await status(voidReq(orderId, itemIds[0]))
    expect(second.code).toBe(409)
    expect(await db.auditLog.count({ where: { action: 'ORDER_ITEM_VOID', entityId: itemIds[0] } })).toBe(auditsBefore)
  })

  it('SOČASNA void DVEH RAZLIČNIH postavk istega naročila (Promise.all) → obe 200, obe voided, končni zneski TOČNO preostanka', async () => {
    const { orderId, itemIds } = await seedOrderWithItems(locA, [
      { id: 'e1', qty: 2, price: 10, vatRate: 22, vatAmount: 3.28 },
      { id: 'e2', qty: 1, price: 5, vatRate: 9.5, vatAmount: 0.43 },
      { id: 'e3', qty: 1, price: 8, vatRate: 22, vatAmount: 1.45, discountAmount: 1 },
    ])
    // vzporedni klici (ista semantika kot produkcijska dirka) — optimistični CAS
    // + retry poskrbita, da obe uspešno izvedeta, ZADNJI zapis pa vsebuje OBA preklica
    const [r1, r2] = await Promise.all([status(voidReq(orderId, itemIds[0])), status(voidReq(orderId, itemIds[2]))])
    expect([r1.code, r2.code]).toEqual([200, 200])
    const i1 = await db.orderItem.findUnique({ where: { id: itemIds[0] } })
    const i3 = await db.orderItem.findUnique({ where: { id: itemIds[2] } })
    expect(i1?.voided).toBe(true)
    expect(i3?.voided).toBe(true)
    // preostane SAMO i2: 4,57 neto + 0,43 ddv = 5,00 za plačilo
    const after = await db.order.findUnique({ where: { id: orderId } })
    expect(num(after?.subtotal)).toBeCloseTo(4.57, 2)
    expect(num(after?.tax)).toBeCloseTo(0.43, 2)
    expect(num(after?.total)).toBeCloseTo(5, 2)
    expect(num(after?.totalWithTip)).toBeCloseTo(5, 2)
    // en audit na postavko
    expect(await db.auditLog.count({ where: { action: 'ORDER_ITEM_VOID', entityId: { in: itemIds } } })).toBe(2)
  })

  it('ROLLBACK po claimu: SQLite trigger FORCIRA napako na Order UPDATE → postavka/razlog ostanejo NEPREKLICANI, zneski nespremenjeni, brez audita', async () => {
    const { orderId, itemIds } = await seedOrderWithItems(locA, [
      { id: 'f', qty: 1, price: 7, vatRate: 22, vatAmount: 1.26 },
    ])
    const trig = `i3966_fail_order_${RUN}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trig} BEFORE UPDATE ON "Order" WHEN NEW."id" = '${orderId}' BEGIN SELECT RAISE(ABORT, 'i3966 forced'); END`)
    try {
      // transakcija pade na koraku (d) — claim iz (b) se mora povrniti (rollback)
      await expect(status(voidReq(orderId, itemIds[0]))).rejects.toThrow()
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trig}`)
    }
    const it = await db.orderItem.findUnique({ where: { id: itemIds[0] } })
    expect(it?.voided).toBe(false)
    expect(it?.voidReasonId).toBe(null)
    const order = await db.order.findUnique({ where: { id: orderId } })
    expect(num(order?.subtotal)).toBeCloseTo(5.74, 2) // 7,00 končnih − 1,26 DDV (nespremenjeno)
    expect(num(order?.total)).toBeCloseTo(7, 2)
    expect(await db.auditLog.count({ where: { action: 'ORDER_ITEM_VOID', entityId: itemIds[0] } })).toBe(0)
  })

  it('itemId TUJEGA naročila → 404; tuja postavka ostane voided=false (CAS veže orderId)', async () => {
    const oa = await seedOrderWithItems(locA, [{ id: 'g1', qty: 1, price: 9, vatRate: 22, vatAmount: 1.62 }])
    const ob = await seedOrderWithItems(locA, [{ id: 'g2', qty: 1, price: 4, vatRate: 9.5, vatAmount: 0.34 }])
    const r = await status(voidReq(oa.orderId, ob.itemIds[0]))
    expect(r.code).toBe(404)
    const foreign = await db.orderItem.findUnique({ where: { id: ob.itemIds[0] } })
    expect(foreign?.voided).toBe(false)
    const own = await db.orderItem.findUnique({ where: { id: oa.itemIds[0] } })
    expect(own?.voided).toBe(false)
  })

  it('plačano naročilo → 409 (fiskalni storno je ločena pot)', async () => {
    const orderId = `${PREFIX}ord-paid-${RUN}`
    await db.order.create({ data: { id: orderId, locationId: locA, orderNumber: ++orderSeq, status: 'paid', paymentStatus: 'paid', type: 'dine-in' } })
    const itemId = (await db.orderItem.create({ data: { id: `${PREFIX}paidit-${RUN}`, orderId, menuItemId: miId, menuItemName: 'X', quantity: 1, price: 5, vatRate: 22, vatAmount: 0.9, status: 'served' } })).id
    const r = await status(voidReq(orderId, itemId))
    expect(r.code).toBe(409)
    const it = await db.orderItem.findUnique({ where: { id: itemId } })
    expect(it?.voided).toBe(false)
  })

  it('SOČASNI void + addItems (Promise.all) → BREZ izgubljenega posodobitve: končni zneski ≡ recalc nad končno množico vrstic', async () => {
    const { orderId, itemIds } = await seedOrderWithItems(locA, [
      { id: 'h1', qty: 1, price: 10, vatRate: 22, vatAmount: 1.82 },
    ])
    const addItemsReq = orderPATCH(
      req(`/api/orders/${orderId}`, tok(managerA, 'm', 'MANAGER', locA), 'PATCH', { addItems: [{ menuItemId: miId, qty: 2 }] }),
      { params: Promise.resolve({ id: orderId }) },
    )
    const [voidRes, addRes] = await Promise.all([status(voidReq(orderId, itemIds[0])), status(addItemsReq)])
    // obe operaciji uspeta (retry na izgubljeno CAS dirko); kakorkoli se izmenjata,
    // končno stanje mora biti DOSLEDNO — to je definicija "brez lost-update"
    expect(voidRes.code).toBe(200)
    expect([200, 201]).toContain(addRes.code)
    // i1 preklicana, NOVA vrstica dodana
    expect((await db.orderItem.findUnique({ where: { id: itemIds[0] } }))?.voided).toBe(true)
    const finalItems = await db.orderItem.findMany({ where: { orderId } })
    expect(finalItems.length).toBe(2)
    // kanonična trditev: zneski v vrstici ≡ recalcFormule nad DEJANSKIM stanjem
    const expected = await recalcOrderTotals(orderId)
    const after = await db.order.findUnique({ where: { id: orderId } })
    expect(num(after?.subtotal)).toBeCloseTo(expected.subtotal, 2)
    expect(num(after?.tax)).toBeCloseTo(expected.tax, 2)
    expect(num(after?.total)).toBeCloseTo(expected.total, 2)
    expect(num(after?.totalWithTip)).toBeCloseTo(expected.total, 2)
  })
})

/* ══════════════════════════ Issue #66 — stocktake ══════════════════════════ */

describe('issue #66 — serializacija PATCH/submit/recount popisa', () => {
  let l1 = '', l2 = ''

  beforeAll(() => {
    l1 = stLineIds[0]
    l2 = stLineIds[1]
  })

  it('PATCH happy path: saved + zapis v DB + audit STOCKTAKE_ITEMS_SAVED (po commitu)', async () => {
    const r = await status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokM(), 'PATCH', { items: [{ id: l1, countedQuantity: 9.5 }, { id: l2, countedQuantity: 0, lineNote: 'prazno' }] }), { params: Promise.resolve({ id: stId }) }))
    expect(r.code).toBe(200)
    expect(r.body.saved).toBe(2)
    const row1 = await db.stocktakeItem.findUnique({ where: { id: l1 } })
    expect(num(row1?.countedQuantity)).toBeCloseTo(9.5, 3)
    expect(row1?.countedByName).toBe(`${PREFIX}managerA`)
    const row2 = await db.stocktakeItem.findUnique({ where: { id: l2 } })
    expect(num(row2?.countedQuantity)).toBe(0)
    expect(await db.auditLog.count({ where: { action: 'STOCKTAKE_ITEMS_SAVED', entityId: stId } })).toBe(1)
  })

  it('submit → SUBMITTED zaklene TOČNO shranjene količine; PATCH nato → 409, BREZ spremembe vrstic in BREZ novega audita', async () => {
    const s = await status(submitPOST(req(`/api/stocktakes/${stId}/submit`, tokM(), 'POST'), { params: Promise.resolve({ id: stId }) }))
    expect(s.code).toBe(200)
    expect((await db.stocktake.findUnique({ where: { id: stId } }))?.status).toBe('SUBMITTED')

    const p = await status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokM(), 'PATCH', { items: [{ id: l1, countedQuantity: 1 }] }), { params: Promise.resolve({ id: stId }) }))
    expect(p.code).toBe(409)
    expect(num((await db.stocktakeItem.findUnique({ where: { id: l1 } }))?.countedQuantity)).toBeCloseTo(9.5, 3)
    expect(await db.auditLog.count({ where: { action: 'STOCKTAKE_ITEMS_SAVED', entityId: stId } })).toBe(1)
  })

  it('RACE (točno okno iz issue-ja): submit zmagá MED PATCH-validacijo → PATCH 409, vrstice NEPREMENJENE, brez audit lažnega uspeha', async () => {
    // recount odpre popis (SUBMITTED → DRAFT) — vnosi ostanejo
    const rc = await status(recountPOST(req(`/api/stocktakes/${stId}/recount`, tokM(), 'POST'), { params: Promise.resolve({ id: stId }) }))
    expect(rc.code).toBe(200)

    // monkey-patch: med PATCH-ovo pred-transakcijsko validacijo (findMany) steče
    // submit in Committira SUBMITTED — natanko zaporedje iz issue body-ja
    const origFindMany = db.stocktakeItem.findMany.bind(db.stocktakeItem)
    let midFlightFired = false
    const auditsBefore = await db.auditLog.count({ where: { action: 'STOCKTAKE_ITEMS_SAVED', entityId: stId } })
    try {
      ;(db.stocktakeItem as unknown as { findMany: unknown }).findMany = async (...args: unknown[]) => {
        if (!midFlightFired) {
          midFlightFired = true
          const s = await status(submitPOST(req(`/api/stocktakes/${stId}/submit`, tokM(), 'POST'), { params: Promise.resolve({ id: stId }) }))
          expect(s.code).toBe(200)
        }
        return origFindMany(...(args as Parameters<typeof origFindMany>))
      }
      const p = await status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokM(), 'PATCH', { items: [{ id: l1, countedQuantity: 2 }] }), { params: Promise.resolve({ id: stId }) }))
      expect(p.code).toBe(409)
    } finally {
      ;(db.stocktakeItem as unknown as { findMany: unknown }).findMany = origFindMany
    }
    expect(midFlightFired).toBe(true)
    // ni poznilh sprememb: l1 ohranja prejšnji vnos, status SUBMITTED, brez audita
    expect(num((await db.stocktakeItem.findUnique({ where: { id: l1 } }))?.countedQuantity)).toBeCloseTo(9.5, 3)
    expect((await db.stocktake.findUnique({ where: { id: stId } }))?.status).toBe('SUBMITTED')
    expect(await db.auditLog.count({ where: { action: 'STOCKTAKE_ITEMS_SAVED', entityId: stId } })).toBe(auditsBefore)
  })

  it('ROLLBACK: trigger na StocktakeItem FORCIRA napako PO claimu → brez delnih zapisov, status ostane DRAFT, brez audita', async () => {
    // recount → DRAFT (trigger test teče na odprtem popisu)
    const rc = await status(recountPOST(req(`/api/stocktakes/${stId}/recount`, tokM(), 'POST'), { params: Promise.resolve({ id: stId }) }))
    expect(rc.code).toBe(200)
    const auditsBefore = await db.auditLog.count({ where: { action: 'STOCKTAKE_ITEMS_SAVED', entityId: stId } })
    const trig = `i3966_fail_sti_${RUN}`
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trig} BEFORE UPDATE ON "StocktakeItem" WHEN NEW."stocktakeId" = '${stId}' BEGIN SELECT RAISE(ABORT, 'i3966 forced sti'); END`)
    try {
      await expect(status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokM(), 'PATCH', { items: [{ id: l2, countedQuantity: 3 }] }), { params: Promise.resolve({ id: stId }) }))).rejects.toThrow()
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trig}`)
    }
    // l2 ohranja prejšnji vnos (0), status DRAFT, claim se je povrnil
    expect(num((await db.stocktakeItem.findUnique({ where: { id: l2 } }))?.countedQuantity)).toBe(0)
    expect((await db.stocktake.findUnique({ where: { id: stId } }))?.status).toBe('DRAFT')
    expect(await db.auditLog.count({ where: { action: 'STOCKTAKE_ITEMS_SAVED', entityId: stId } })).toBe(auditsBefore)
  })

  it('TUJA vrstica (popis druge lokacije) → 400 (ne pripada temu popisu); tuj upravljalec → 403', async () => {
    const stBLines = (await db.stocktakeItem.findMany({ where: { stocktakeId: stBId } })).map((l) => l.id)
    expect(stBLines.length).toBeGreaterThan(0)
    const r = await status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokM(), 'PATCH', { items: [{ id: stBLines[0], countedQuantity: 1 }] }), { params: Promise.resolve({ id: stId }) }))
    expect(r.code).toBe(400)
    // vrstice popisa B ostanejo brez vnosa
    expect((await db.stocktakeItem.findUnique({ where: { id: stBLines[0] } }))?.countedQuantity).toBe(null)
    // cross-location guard ostaja: managerB ne more popisati popisa A
    const g = await status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokMB(), 'PATCH', { items: [{ id: l1, countedQuantity: 1 }] }), { params: Promise.resolve({ id: stId }) }))
    expect(g.code).toBe(403)
    // waiter brez inventory.manage → 403
    const w = await status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokW(), 'PATCH', { items: [{ id: l1, countedQuantity: 1 }] }), { params: Promise.resolve({ id: stId }) }))
    expect(w.code).toBe(403)
  })

  it('PATCH po recountu spet deluje (recount odpre vrata) → submit zaklene TOČNO shranjeno; approve uporabi SVEŽE vrstice', async () => {
    // DRAFT (po prejšnjem testu) → nov vnos 9,5 (isti) + l2 = 2
    const p = await status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokM(), 'PATCH', { items: [{ id: l2, countedQuantity: 2 }] }), { params: Promise.resolve({ id: stId }) }))
    expect(p.code).toBe(200)
    expect(num((await db.stocktakeItem.findUnique({ where: { id: l2 } }))?.countedQuantity)).toBe(2)

    const s = await status(submitPOST(req(`/api/stocktakes/${stId}/submit`, tokM(), 'POST'), { params: Promise.resolve({ id: stId }) }))
    expect(s.code).toBe(200)
    // submit je zaklenel TOČNO shranjene količine (l2 = 2)
    expect(num((await db.stocktakeItem.findUnique({ where: { id: l2 } }))?.countedQuantity)).toBe(2)

    // approve: sveže vrstice znotraj transakcije (utrditev #66) — popoln cikel
    const a = await status(approvePOST(req(`/api/stocktakes/${stId}/approve`, tokM(), 'POST'), { params: Promise.resolve({ id: stId }) }))
    expect(a.code).toBe(200)
    expect(a.body.status).toBe('APPROVED')
    // inventura zapisana: l1 (moka 10 → 9,5) in l2 (solata 5 → 2)
    const moka = await db.inventoryItem.findUnique({ where: { id: invS1 } })
    const solata = await db.inventoryItem.findUnique({ where: { id: invS2 } })
    expect(num(moka?.quantity)).toBeCloseTo(9.5, 3)
    expect(num(solata?.quantity)).toBe(2)
    // zaklenjen: PATCH po APPROVED → 409
    const late = await status(stocktakePATCH(req(`/api/stocktakes/${stId}`, tokM(), 'PATCH', { items: [{ id: l1, countedQuantity: 1 }] }), { params: Promise.resolve({ id: stId }) }))
    expect(late.code).toBe(409)
  })
})
