/**
 * Issue #55 (P1) — POST /api/inventory: IZRECNA tenant-preverjena lokacija;
 * findFirst() fallback ("prva lokacija v bazi") UKINJEN; staff s klientovim
 * locationId ne more preusmeriti artikla.
 * Issue #58 (P1) — POST/PATCH /api/inventory: stroga validacija količin/cen
 * (NaN/±Infinity/neštevilski → 400, ne tiho 0; negativne/prevelike → 400);
 * opening balance → EKSPliciten StockTransaction RECEIVE ("Začetno stanje"),
 * NI GRN; PATCH previousQty FRESH znotraj transakcije.
 * Issue #59 (P1) — waste/[id]/reverse: ATOMIC CAS claim znotraj transakcije
 * (dve sočasni reverziji ISTEGA WasteRecord ne smeta dvakrat dodati zaloge;
 * druga zahteva → 409 brez dodatnega StockTransaction).
 * Issue #52 (P1) — deductStockForOrderTx: ledger ≡ DB — previousQty/newQty
 * iz FRESH post-decrement stanja (veriga transakcij se izravna z DB; prej sta
 * dva sočasna računa oba zapisala zastareli par 100→90 pri dejanski 80);
 * FEFO serija, ki po CAS retryjih izpade, se evidentira v opombi (ne tiho izgine).
 *
 * Vzorec: direktni uvoz route handlerjev (race-fixes-p1) + direkten klic
 * deductStockForOrderTx z db klientom kot Tx (stock-deduction).
 * Fiksature s predpono `i52-`; sweep beforeAll/afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { deductStockForOrderTx } from '../src/lib/inventory'
import { POST as inventoryPOST, PATCH as inventoryPATCH } from '../src/app/api/inventory/route'
import { POST as wasteReversePOST } from '../src/app/api/waste/[id]/reverse/route'
import { WASTE_REVERSAL_TX_TYPE, wasteReversalReason } from '../src/lib/waste'
import { num, nid } from '../src/lib/map'
import type { Prisma } from '@prisma/client'

const PREFIX = 'i52-'
const RUN = Date.now().toString(36)
type Tx = Prisma.TransactionClient

let orgA = '', propA = '', brandA = ''
let orgB = '', propB = '', brandB = ''
let locA1 = '', locB1 = '', locA2 = ''
let whA = '', whNoLoc = '', adminA = '', adminPlat = ''
let empId = ''
let empName = 'i52 zaposleni'
let menuId = '', catId = '', miSeq = 0
let ordSeq = 0

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

// žetoni z UI vlogami (UPPERCASE — kot jih izda prijava; isCentralRole primerja 'ADMIN')
function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function status(r: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = (await (r as Promise<unknown> | Response)) as Response
  expect(res instanceof Response).toBe(true)
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function seedEmployee(name: string, role: string, loc: string | null, pinSeq: number): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
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

async function mkInventory(quantity: number, opts: { name?: string; loc?: string } = {}) {
  const id = `${PREFIX}inv-${opts.name ?? nid().slice(0, 6)}-${RUN}`
  return db.inventoryItem.create({
    data: {
      id, name: `${PREFIX}${opts.name ?? `artikel ${id.slice(4, 10)}`}`, unit: 'kg',
      quantity, costPerUnit: 2, locationId: opts.loc ?? locA1,
    },
  })
}

let miSeqLocal = 0
async function mkMenuItemWithRecipe(recipe: { inventoryItemId: string; quantityPerServing: number }[]) {
  const mi = await db.menuItem.create({
    data: { id: `${PREFIX}mi-${++miSeqLocal}-${RUN}`, name: `${PREFIX} jed ${miSeqLocal}`, price: 10, categoryId: catId, vatRate: 22 },
  })
  for (const r of recipe) {
    await db.recipeItem.create({
      data: { id: `${PREFIX}ri-${mi.id.slice(4)}-${nid().slice(0, 6)}`, menuItemId: mi.id, inventoryItemId: r.inventoryItemId, quantityPerServing: r.quantityPerServing, unit: 'kg' },
    })
  }
  return mi.id
}

let ordSeqLocal = 0
async function mkOrderWithItem(menuItemId: string, quantity: number) {
  const orderId = `${PREFIX}ord-${++ordSeqLocal}-${RUN}`
  await db.order.create({
    data: {
      id: orderId, orderNumber: 970000 + ++ordSeq, locationId: locA1,
      status: 'paid', paymentStatus: 'paid', type: 'dine-in', employeeId: empId,
    },
  })
  await db.orderItem.create({
    data: {
      id: `${PREFIX}oi-${ordSeqLocal}-${RUN}`, orderId, menuItemId, quantity, price: 10, vatRate: 22, vatAmount: 2.2,
      menuItemName: `${PREFIX} postavka`, status: 'served', voided: false,
    },
  })
  return orderId
}

let wasteSeq = 0
async function mkWaste(inventoryItemId: string, quantity: number) {
  const id = `${PREFIX}waste-${++wasteSeq}-${RUN}`
  await db.wasteRecord.create({
    data: {
      id, locationId: locA1, inventoryItemId, quantity, unit: 'kg', reason: 'pokvarjeno',
      costPerUnit: 2, totalCost: quantity * 2, recordedByUserId: whA,
    },
  })
  return id
}

/** StockTransaction-e, povezane z artiklom (vsi testi) */
const txsFor = (inventoryItemId: string) =>
  db.stockTransaction.findMany({ where: { inventoryItemId }, orderBy: { createdAt: 'asc' } })

const countItems = () => db.inventoryItem.count({ where: { name: { startsWith: PREFIX } } })

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locA1 = `${PREFIX}locA1-${RUN}`; locB1 = `${PREFIX}locB1-${RUN}`; locA2 = `${PREFIX}locA2-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'I52 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: 'I52 Org B', slug: `${PREFIX}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'BA' } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'BB' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'PA' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'PB' } })
  await db.location.create({ data: { id: locA1, name: 'I52 A1', code: `${PREFIX}A1-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locA2, name: 'I52 A2', code: `${PREFIX}A2-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB1, name: 'I52 B1', code: `${PREFIX}B1-${RUN}`, propertyId: propB } })

  whA = await seedEmployee('whA', 'warehouse', locA1, 1)
  whNoLoc = await seedEmployee('whNoLoc', 'warehouse', null, 2)
  adminA = await seedEmployee('adminA', 'admin', locA1, 3)
  adminPlat = await seedEmployee('adminPlat', 'admin', null, 4)

  empId = await seedEmployee('emp', 'manager', locA1, 5)
  empName = 'i52 zaposleni'
  menuId = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA1 } })).id
  catId = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId } })).id
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #55 — izrecna, tenant-preverjena lokacija pri POST /api/inventory
// ════════════════════════════════════════════════════════════════════════════
describe('#55 POST /api/inventory — lokacija brez findFirst() fallbacka', () => {
  const whTok = () => tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1)

  it('warehouse z lokacijo A1 ustvari artikel → locationId A1 (brez body polja)', async () => {
    const before = await countItems()
    const r = await status(inventoryPOST(req('/api/inventory', whTok(), 'POST', { name: `${PREFIX} wh artikel ${RUN}`, qty: 0 })))
    expect(r.code).toBe(201)
    const after = await countItems()
    expect(after - before).toBe(1)
    const item = await db.inventoryItem.findFirst({ where: { name: `${PREFIX} wh artikel ${RUN}` } })
    expect(item?.locationId).toBe(locA1)
  })

  it('warehouse lokacije A1 pošlje body.locationId=B1 (tuja lokacija) → 403, BREZ artikla', async () => {
    const before = await countItems()
    const r = await status(inventoryPOST(req('/api/inventory', whTok(), 'POST', { name: `${PREFIX} redirect poskus ${RUN}`, locationId: locB1 })))
    expect(r.code).toBe(403)
    expect(await countItems()).toBe(before)
  })

  it('warehouse BREZ user.loc in brez eksplicitne lokacije → 403; findFirst() NI uporabljen (nič artikalov nikjer)', async () => {
    const before = await countItems()
    const r = await status(inventoryPOST(req('/api/inventory', tok(whNoLoc, `${PREFIX}whNoLoc`, 'WAREHOUSE', null), 'POST', { name: `${PREFIX} brez lokacije ${RUN}` })))
    expect(r.code).toBe(403)
    expect(await countItems()).toBe(before)
  })

  it('centralni admin orgA (locA1) poda lokacijo B1 iz orgB → 403, brez artikla (assertOrgScope)', async () => {
    const before = await countItems()
    const r = await status(inventoryPOST(req('/api/inventory', tok(adminA, `${PREFIX}adminA`, 'ADMIN', locA1), 'POST', { name: `${PREFIX} cross-org poskus ${RUN}`, locationId: locB1 })))
    expect(r.code).toBe(403)
    expect(await countItems()).toBe(before)
  })

  it('centralni admin orgA poda lokacijo A2 (ISTA org) → 201, locationId A2', async () => {
    const r = await status(inventoryPOST(req('/api/inventory', tok(adminA, `${PREFIX}adminA`, 'ADMIN', locA1), 'POST', { name: `${PREFIX} admin artikel ${RUN}`, locationId: locA2, qty: 0 })))
    expect(r.code).toBe(201)
    const item = await db.inventoryItem.findFirst({ where: { name: `${PREFIX} admin artikel ${RUN}` } })
    expect(item?.locationId).toBe(locA2)
  })

  it('platform admin (loc null) brez body.locationId → 400 (podajte locationId); z body lokacijo → 201', async () => {
    const r0 = await status(inventoryPOST(req('/api/inventory', tok(adminPlat, `${PREFIX}adminPlat`, 'ADMIN', null), 'POST', { name: `${PREFIX} plat brez ${RUN}` })))
    expect(r0.code).toBe(400)
    const r1 = await status(inventoryPOST(req('/api/inventory', tok(adminPlat, `${PREFIX}adminPlat`, 'ADMIN', null), 'POST', { name: `${PREFIX} plat z loc ${RUN}`, locationId: locB1, qty: 0 })))
    expect(r1.code).toBe(201)
    const item = await db.inventoryItem.findFirst({ where: { name: `${PREFIX} plat z loc ${RUN}` } })
    expect(item?.locationId).toBe(locB1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #58 — stroga validacija količin/cen + opening balance evidence
// ════════════════════════════════════════════════════════════════════════════
describe('#58 POST /api/inventory — validacija zavrne neveljavne vnose', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['negativna količina', { name: `${PREFIX} bad ${RUN}`, qty: -10 }],
    ['negativen minimalni prag', { name: `${PREFIX} bad ${RUN}`, minQty: -5 }],
    ['negativna cena', { name: `${PREFIX} bad ${RUN}`, cost: -2.5 }],
    ['neštevilski niz', { name: `${PREFIX} bad ${RUN}`, qty: 'abc' }],
    ['Infinity', { name: `${PREFIX} bad ${RUN}`, qty: 'Infinity' }],
    ['prevelika količina', { name: `${PREFIX} bad ${RUN}`, qty: 1e12 }],
  ]
  for (const [label, body] of cases) {
    it(`POST ${label} → 400, brez artikla (ne tiho 0)`, async () => {
      const before = await countItems()
      const r = await status(inventoryPOST(req('/api/inventory', tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'POST', body)))
      expect(r.code).toBe(400)
      expect(await countItems()).toBe(before)
    })
  }

  it('veljaven POST z qty=5 → 201 + StockTransaction RECEIVE (začetno stanje, NI GRN, brez serije)', async () => {
    const r = await status(inventoryPOST(req('/api/inventory', tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'POST', { name: `${PREFIX} opening ${RUN}`, qty: 5, minQty: 1, cost: 2.5 })))
    expect(r.code).toBe(201)
    const item = await db.inventoryItem.findFirst({ where: { name: `${PREFIX} opening ${RUN}` } })
    expect(item).toBeTruthy()
    expect(num(item?.quantity)).toBe(5)
    expect(num(item?.minQuantity)).toBe(1)
    expect(num(item?.costPerUnit)).toBe(2.5)
    const txs = await txsFor(item!.id)
    expect(txs.length).toBe(1)
    const t = txs[0]
    expect(t.type).toBe('RECEIVE')
    expect(num(t.quantity)).toBe(5)
    expect(num(t.previousQty)).toBe(0)
    expect(num(t.newQty)).toBe(5)
    expect(t.reason).toContain('Začetno stanje')
    expect(t.note).toContain('ni GRN')
    expect(t.employeeId).toBe(whA)
    // opening balance BREZ serije (InventoryBatch se ne ustvari)
    const batches = await db.inventoryBatch.count({ where: { inventoryItemId: item!.id } })
    expect(batches).toBe(0)
  })

  it('POST brez količine → 201, BREZ StockTransaction (ni opening dogodka)', async () => {
    const r = await status(inventoryPOST(req('/api/inventory', tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'POST', { name: `${PREFIX} zero qty ${RUN}`, unit: 'l' })))
    expect(r.code).toBe(201)
    const item = await db.inventoryItem.findFirst({ where: { name: `${PREFIX} zero qty ${RUN}` } })
    expect(num(item?.quantity)).toBe(0)
    expect(await txsFor(item!.id)).toHaveLength(0)
  })

  it('POST "1,5" (vejica) → 1,5 — slovenski decimalni format ostane podprt', async () => {
    const r = await status(inventoryPOST(req('/api/inventory', tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'POST', { name: `${PREFIX} vejica ${RUN}`, qty: '1,5' })))
    expect(r.code).toBe(201)
    const item = await db.inventoryItem.findFirst({ where: { name: `${PREFIX} vejica ${RUN}` } })
    expect(num(item?.quantity)).toBe(1.5)
  })
})

describe('#58 PATCH /api/inventory — ista validacija kot POST + sled stanja', () => {
  let itemId = ''
  beforeAll(async () => {
    const it = await mkInventory(10)
    itemId = it.id
  })

  const badCases: Array<[string, Record<string, unknown>]> = [
    ['negativen setQty', { id: 'X', setQty: -3 }],
    ['neštevilski cost', { id: 'X', cost: 'abc' }],
    ['NaN minQty', { id: 'X', minQty: 'NaN' }],
    ['neštevilski delta (prej tiho ignoriran)', { id: 'X', delta: 'abc' }],
    ['prevelik delta', { id: 'X', delta: 1e12 }],
  ]
  for (const [label, body] of badCases) {
    it(`PATCH ${label} → 400 (ne tiho 0/ignorirano)`, async () => {
      const before = await db.inventoryItem.findUnique({ where: { id: itemId } })
      const r = await status(inventoryPATCH(req('/api/inventory', tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'PATCH', { ...body, id: itemId })))
      expect(r.code).toBe(400)
      const after = await db.inventoryItem.findUnique({ where: { id: itemId } })
      expect(num(after?.quantity)).toBe(num(before?.quantity))
    })
  }

  it('PATCH delta "1,5" (vejica, pozitiven prejem) → 200, zaloga +1,5, StockTransaction RECEIVE newQty ≡ DB', async () => {
    const before = await db.inventoryItem.findUnique({ where: { id: itemId } })
    const prevQty = num(before?.quantity)
    const r = await status(inventoryPATCH(req('/api/inventory', tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'PATCH', { id: itemId, delta: '1,5' })))
    expect(r.code).toBe(200)
    const after = await db.inventoryItem.findUnique({ where: { id: itemId } })
    const newQty = num(after?.quantity)
    expect(newQty).toBe(prevQty + 1.5)
    const txs = await txsFor(itemId)
    expect(txs.length).toBe(1)
    expect(txs[0].type).toBe('RECEIVE')
    expect(num(txs[0].previousQty)).toBe(prevQty)
    expect(num(txs[0].newQty)).toBe(newQty) // ledger ≡ DB
  })

  it('PATCH setQty 5.5 → 200, StockTransaction ADJUST previousQty/newQty ≡ dejansko DB stanje', async () => {
    const before = await db.inventoryItem.findUnique({ where: { id: itemId } })
    const prevQty = num(before?.quantity)
    const r = await status(inventoryPATCH(req('/api/inventory', tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'PATCH', { id: itemId, setQty: 5.5 })))
    expect(r.code).toBe(200)
    const after = await db.inventoryItem.findUnique({ where: { id: itemId } })
    const newQty = num(after?.quantity)
    expect(newQty).toBe(5.5)
    const txs = await txsFor(itemId)
    expect(txs.length).toBe(2)
    const adj = txs[1]
    expect(adj.type).toBe('ADJUST')
    expect(num(adj.previousQty)).toBe(prevQty)
    expect(num(adj.newQty)).toBe(newQty)
    // invarianta: previousQty + quantity ≡ newQty (variance seštevljiv)
    expect(num(adj.previousQty) + num(adj.quantity)).toBeCloseTo(num(adj.newQty), 3)
  })

  it('PATCH negativen delta pod natančnostjo (−0,0004) → 400 (pod 3 decimalkami ni dovoljen premik)', async () => {
    const r = await status(inventoryPATCH(req('/api/inventory', tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'PATCH', { id: itemId, delta: -0.0004 })))
    expect(r.code).toBe(400)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #59 — atomarna reverzija odpada (CAS claim znotraj transakcije)
// ════════════════════════════════════════════════════════════════════════════
describe('#59 waste/[id]/reverse — CAS reverzija', () => {
  const reverseReq = (wasteId: string) =>
    wasteReversePOST(req(`/api/waste/${wasteId}/reverse`, tok(whA, `${PREFIX}whA`, 'WAREHOUSE', locA1), 'POST'), { params: Promise.resolve({ id: wasteId }) })

  it('prva reverzija → 200: zaloga +5, natanko EN povratni StockTransaction, povezan z WasteRecord', async () => {
    const inv = await mkInventory(10, { name: 'rev artikel 1' })
    await db.inventoryItem.update({ where: { id: inv.id }, data: { quantity: 5 } }) // po odpadu
    const wasteId = await mkWaste(inv.id, 5)
    const r = await status(reverseReq(wasteId))
    expect(r.code).toBe(200)
    const item = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(item?.quantity)).toBe(10) // 5 + 5, NE 15
    const rec = await db.wasteRecord.findUnique({ where: { id: wasteId } })
    expect(rec?.reversedAt).toBeTruthy()
    expect(rec?.reversalStockTransactionId).toBeTruthy()
    const revTx = await db.stockTransaction.findUnique({ where: { id: rec!.reversalStockTransactionId! } })
    expect(revTx?.type).toBe(WASTE_REVERSAL_TX_TYPE)
    expect(num(revTx?.quantity)).toBe(5)
    expect(num(revTx?.previousQty)).toBe(5)
    expect(num(revTx?.newQty)).toBe(10)
    expect(revTx?.reason).toBe(wasteReversalReason(wasteId))
  })

  it('DRUGA reverzija istega zapisa → 409; zaloga NI spremenjena, brez novega StockTransaction', async () => {
    // lastna fiksatura (samozadostno — ne odvisno od prejšnjega testa)
    const inv = await mkInventory(5, { name: 'rev artikel 1b' })
    const wasteId = await mkWaste(inv.id, 5)
    const r1 = await status(reverseReq(wasteId))
    expect(r1.code).toBe(200)
    const qtyAfterFirst = num((await db.inventoryItem.findUnique({ where: { id: inv.id } }))?.quantity)
    expect(qtyAfterFirst).toBe(10)
    const txsAfterFirst = await txsFor(inv.id)
    const recAfter = await db.wasteRecord.findUnique({ where: { id: wasteId } })
    expect(recAfter?.reversalStockTransactionId).toBeTruthy()
    const r2 = await status(reverseReq(wasteId))
    expect(r2.code).toBe(409)
    const qtyAfter = num((await db.inventoryItem.findUnique({ where: { id: inv.id } }))?.quantity)
    expect(qtyAfter).toBe(qtyAfterFirst)
    const txsAfter = await txsFor(inv.id)
    expect(txsAfter.length).toBe(txsAfterFirst.length)
    const recFinal = await db.wasteRecord.findUnique({ where: { id: wasteId } })
    expect(recFinal?.reversalStockTransactionId).toBe(recAfter?.reversalStockTransactionId)
  })

  it('SOČASNI reverziji istega WasteRecord (Promise.all) → natanko ena 200 + ena 409; zaloga +5 (ne +10); 1 reversal tx; 0 orphans', async () => {
    const inv = await mkInventory(5, { name: 'rev artikel 2' }) // zaloga po odpadu: 5
    const wasteId = await mkWaste(inv.id, 5)
    // obe zahtevi prebereta reversedAt=null PRED prvo transakcijo — CAS claim
    // odloči: natanko ena uspe, druga dobi 409 (rollback claim + zaloga + ledger)
    const [r1, r2] = await Promise.all([reverseReq(wasteId), reverseReq(wasteId)])
    const codes = [r1.status, r2.status].sort()
    expect(codes).toEqual([200, 409])
    const item = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(item?.quantity)).toBe(10) // 5 + natanko 5 — NE 15 (dvojno vračilo)
    const rec = await db.wasteRecord.findUnique({ where: { id: wasteId } })
    expect(rec?.reversedAt).toBeTruthy()
    const reversalTxs = await db.stockTransaction.findMany({ where: { inventoryItemId: inv.id, type: WASTE_REVERSAL_TX_TYPE } })
    expect(reversalTxs.length).toBe(1) // natanko ena povratna transakcija
    // povezava: reversalStockTransactionId kaže na (edino) reversal tx — ni orphana
    expect(rec?.reversalStockTransactionId).toBe(reversalTxs[0].id)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #52 — deductStockForOrderTx: ledger ≡ DB (fresh post-decrement read)
// ════════════════════════════════════════════════════════════════════════════
describe('#52 deductStockForOrderTx — previousQty/newQty ≡ dejansko DB stanje', () => {
  it('dve zaporedni razknjižbi istega artikla → VERIGA konsistentna (100→90, 90→80), ne dvakrat 100→90', async () => {
    const inv = await mkInventory(100, { name: 'chain artikel' })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 10 }])
    const o1 = await mkOrderWithItem(mi, 1)
    const o2 = await mkOrderWithItem(mi, 1)

    const r1 = await deductStockForOrderTx(db as unknown as Tx, o1, empId, empName)
    expect(r1.deducted).toBe(true)
    expect(r1.deductions[0]?.newQty).toBe(90)
    const r2 = await deductStockForOrderTx(db as unknown as Tx, o2, empId, empName)
    expect(r2.deducted).toBe(true)
    expect(r2.deductions[0]?.newQty).toBe(80)

    const item = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(item?.quantity)).toBe(80)
    const sales = await txsFor(inv.id)
    expect(sales.length).toBe(2)
    expect(sales[0].type).toBe('SALE')
    expect(num(sales[0].previousQty)).toBe(100)
    expect(num(sales[0].newQty)).toBe(90)
    expect(sales[1].type).toBe('SALE')
    // IZRAVNA z dejanskim stanjem: previous(2) = new(1); new(2) = DB — prej bi
    // obe transakciji zapisali zastareli par 100→90
    expect(num(sales[1].previousQty)).toBe(90)
    expect(num(sales[1].newQty)).toBe(80)
    // invarianta verige za vsak par (quantity je NEGATIVEN pri SALE: prev + qty ≡ new)
    for (const t of sales) {
      expect(num(t.previousQty) + num(t.quantity)).toBeCloseTo(num(t.newQty), 3)
    }
  })

  it('dve RAZLIČNI naročili v vzporednih transakcijah (Promise.all) → skupni odjem točen, zadnji SALE newQty ≡ DB', async () => {
    const inv = await mkInventory(100, { name: 'par artikel' })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 10 }])
    const o1 = await mkOrderWithItem(mi, 1)
    const o2 = await mkOrderWithItem(mi, 1)
    // vzporedni interaktivni transakciji (ista semantika kot sočasni računi:
    // obe sta prebrali 100 pred CAS; SQLite serializira izvedbo, fresh read
    // poskrbi, da ledger sledi DEJANSKEMU stanju, ne zastarelemu branju)
    const [a, b] = await Promise.all([
      db.$transaction((tx) => deductStockForOrderTx(tx, o1, empId, empName)),
      db.$transaction((tx) => deductStockForOrderTx(tx, o2, empId, empName)),
    ])
    const item = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(item?.quantity)).toBe(80) // natanko 2×10 odšteto
    expect(a.deducted || b.deducted).toBe(true)
    const sales = await txsFor(inv.id)
    expect(sales.length).toBe(2)
    // katerakoli transakcija je lahko stekla prva — invarianta VERIGA (po newQty
    // padajoče: starejša/prej odšeta ima VIŠJI newQty): [90, 80]
    const sorted = [...sales].sort((x, y) => num(y.newQty) - num(x.newQty))
    expect(num(sorted[0].previousQty)).toBe(100)
    expect(num(sorted[0].newQty)).toBe(90)
    expect(num(sorted[1].previousQty)).toBe(90) // veriga: prev(2) = new(1)
    expect(num(sorted[1].newQty)).toBe(80)
    expect(num(sorted[1].newQty)).toBe(num(item?.quantity)) // zadnja ≡ DB
    // invarianta vsakega para: prev + qty (negativen) ≡ new
    for (const t of sales) {
      expect(num(t.previousQty) + num(t.quantity)).toBeCloseTo(num(t.newQty), 3)
    }
  })

  it('FEFO: serija pokrije samo del odjema → opomba "Serije pokrijejo X od Y"; alokacija ≡ batch decrement', async () => {
    const inv = await mkInventory(5, { name: 'fefo delni artikel' })
    const batchId = nid()
    await db.inventoryBatch.create({
      data: {
        id: batchId, inventoryItemId: inv.id, locationId: locA1,
        lotNumber: `${PREFIX}-lot-${RUN}`, receivedAt: new Date(Date.now() - 3600_000),
        expiryDate: new Date(Date.now() + 2 * 86_400_000),
        quantityInitial: 2, quantityRemaining: 2, status: 'ACTIVE',
      },
    })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 5 }])
    const o1 = await mkOrderWithItem(mi, 1)
    const r = await deductStockForOrderTx(db as unknown as Tx, o1, empId, empName)
    expect(r.deducted).toBe(true)
    expect(num(r.deductions[0]?.newQty)).toBe(0)
    const item = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(item?.quantity)).toBe(0)
    const batch = await db.inventoryBatch.findUnique({ where: { id: batchId } })
    expect(num(batch?.quantityRemaining)).toBe(0)
    expect(batch?.status).toBe('EXHAUSTED')
    const sale = (await txsFor(inv.id)).find((t) => t.type === 'SALE')
    expect(sale?.note).toContain('Serije pokrijejo 2 kg od 5')
    const allocs = await db.stockBatchAllocation.findMany({ where: { batchId } })
    expect(allocs.length).toBe(1)
    expect(num(allocs[0].quantity)).toBe(2) // alokacija ≡ dejanski batch odjem
  })
})
