/**
 * Issue #17 (P1/P2, v1.106.0) — food-cost varianca (dejanska proti teoretični porabi).
 *
 * Pokrito:
 *  A. ČISTA MATEMATIKA (src/lib/food-cost-variance.ts — brez DB):
 *     - klasifikacija transakcij (txGroupOf — 'purchase' mala črka GRN!);
 *     - enotne pretvorbe SAMO kg↔g, l↔ml (unitFactor; kos/paket → null + zastavica);
 *     - ROČNO PREVERLJIVA fikstura: popis(s) + prejem + prodaja + odpis + popravki →
 *       exact opening/closing/usage/variance/komponente/vrednote/KPI;
 *     - sidra: opening/closing iz PREŠTETE količine popisa (fizična resnica),
 *       fallback knjiga (live − Σ prihodnje) + razloga incompleteData;
 *     - STORNO_RETURN vračilo zmanjša porabo (− komponenta);
 *     - primanjkljaj razknjižbe (shortfall) se prikaže kot komponenta;
 *     - drift brez dokumenta (živo stanje ≠ knjiga) → NEPOJASNJENO (± predznak);
 *     - neznan tip transakcije → prispevek pristane v nepojasnjenem (vidno);
 *     - zgodovinska cena: period_avg (uteženo) → last_supplier_price →
 *       current_cost (označena) → unknown (vrednosti NULL, ne 0);
 *     - cenovni vpliv je LOČEN informativen podatek (varianca količinsko čista);
 *     - receptura: yield (neto/izkoristek) + podrecepture (starš+otrok oba);
 *     - prodaja brez recepture → soldWithoutRecipe + razlog;
 *     - receptura spremenjena po from → zastavica;
 *     - agregacija: vsota per artikel = skupno; kategorije.
 *  B. RUTA (GET /api/reports/food-cost — ci-fresh DB):
 *     - celoten tok z exact številkami (glede na fixture A v DB obliki);
 *     - paidAt obseg: naročilo pred oknom IZKLJUČENO iz teoretične (in obratno
 *       po oknu); voidana postavka izključena;
 *     - CSV: BOM + `;` + Content-Disposition + ISTE številke kot JSON;
 *     - pravice: waiter (brez reports.view) → 403; brez žetona → 401;
 *     - tenant izolacija: manager druge lokacije vidi SAMO svoje (prazno);
 *     - validacija: from > to → 400.
 *
 * Fiksture s predpono i17- (TEST_PREFIXES).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { nid } from '../src/lib/map'
import type { Prisma } from '@prisma/client'
import {
  buildFoodCostVariance,
  txGroupOf,
  unitFactor,
  type FcInput,
  type FcInvItem,
  type FcRecipeRow,
  type FcSoldRow,
  type FcStocktake,
  type FcTxRow,
} from '../src/lib/food-cost-variance'
import { GET as foodCostGET } from '../src/app/api/reports/food-cost/route'

const P = 'i17-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

type Tx = Prisma.TransactionClient

// ─── fiksni časi (danes = 2026-10-15 UTC, okno 2026-10-01 → 2026-10-15) ───
const D = (s: string) => new Date(s)
const FROM = D('2026-10-01T00:00:00Z')
const TO = D('2026-10-15T23:59:59Z')
const T_S1 = D('2026-09-28T10:00:00Z') // popis pred oknom (opening sidro)
const T_PRE_RECEIPT = D('2026-09-19T10:00:00Z') // prejem v PREJŠNJEM oknu (prior cena)
const T_O2 = D('2026-09-20T12:00:00Z') // naročilo PLAČANO PRED oknom (izključitev)
const T_PURCHASE = D('2026-10-03T10:00:00Z')
const T_O1 = D('2026-10-05T12:00:00Z')
const T_WASTE = D('2026-10-07T09:00:00Z')
const T_O3 = D('2026-10-09T12:00:00Z') // voidana postavka (izključitev)
const T_S2 = D('2026-10-14T16:00:00Z') // popis v oknu (closing sidro)
const T_O4 = D('2026-11-05T12:00:00Z') // naročilo PLAČANO PO oknu (izključitev)

const ORDER_NUMBER_BASE = 9021000

let locA = ''
let locB = ''
let mgrA = ''
let mgrB = ''
let waiterA = ''
let tokA = ''
let tokB = ''
let tokWaiter = ''

let invId = ''
let miId = ''
let orderO1 = 0
let stocktakeS2Id = ''
const createdTxIds: string[] = []
const createdOrderIds: string[] = []

function req(method: string, url: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

async function seedEmployee(name: string, role: string, loc: string | null, seq: number): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const pin = `${PIN_BASE}${seq}`
  const f = employeePinFields(pin, `${P}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${name}`, email: `${P}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

/** Zapis StockTransaction + sočasna sprememba žive zaloge (konzistentna veriga). */
async function tx(opts: {
  type: string; qty: number; at: Date; cost?: number; orderId?: string; supplierDoc?: string; reason?: string
}) {
  const id = nid()
  createdTxIds.push(id)
  // predhodno stanje preberemo po verigi (živo + premiki po času t) — enostavno:
  const prevRows = await db.stockTransaction.findMany({
    where: { inventoryItemId: invId, createdAt: { lte: opts.at } },
    select: { quantity: true },
  })
  const prev = prevRows.reduce((s, r) => s + Number(r.quantity), 0)
  const newQty = Math.round((prev + opts.qty) * 1000) / 1000
  await db.stockTransaction.create({
    data: {
      id,
      inventoryItemId: invId,
      type: opts.type,
      quantity: opts.qty,
      previousQty: prev,
      newQty,
      costPerUnit: opts.cost ?? 0,
      totalCost: Math.round(Math.abs(opts.qty) * (opts.cost ?? 0) * 100) / 100,
      reason: opts.reason || '',
      supplierDoc: opts.supplierDoc || '',
      orderId: opts.orderId || null,
      createdAt: opts.at,
    },
  })
  return { id, newQty }
}

async function mkOrder(orderNumber: number, paidAt: Date, items: { qty: number; voided?: boolean }[]) {
  const orderId = nid()
  createdOrderIds.push(orderId)
  await db.order.create({
    data: {
      id: orderId, orderNumber, locationId: locA, status: 'paid', paymentStatus: 'paid',
      type: 'takeaway', paidAt, createdAt: paidAt, subtotal: 80, total: 80,
    },
  })
  for (const it of items) {
    await db.orderItem.create({
      data: {
        id: nid(), orderId, menuItemId: miId, quantity: it.qty, price: 20, vatRate: 22,
        menuItemName: `${P}Test jed`, voided: it.voided ?? false,
      },
    })
  }
  return orderId
}

async function mkStocktake(id: string, approvedAt: Date, expected: number, counted: number) {
  const txRes = await tx({ type: 'STOCKTAKE', qty: counted - expected, at: approvedAt })
  await db.stocktake.create({
    data: {
      id, locationId: locA, status: 'APPROVED', approvedAt, submittedAt: approvedAt,
      createdByName: `${P}popis`, approvedByName: `${P}vodja`,
    },
  })
  await db.stocktakeItem.create({
    data: {
      id: nid(), stocktakeId: id, inventoryItemId: invId, itemName: `${P}Moka`, unit: 'kg',
      expectedQuantity: expected, countedQuantity: counted, varianceQuantity: counted - expected,
      costPerUnit: 2, stockTransactionId: txRes.id, countedAt: approvedAt, countedByName: `${P}popis`,
    },
  })
  return txRes.id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  const la = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `I17A-${RUN.toUpperCase()}` } })
  const lb = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `I17B-${RUN.toUpperCase()}` } })
  locA = la.id
  locB = lb.id
  mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  mgrB = await seedEmployee('mgrB', 'manager', locB, 2)
  waiterA = await seedEmployee('waiterA', 'waiter', locA, 3)
  tokA = createToken({ sub: mgrA, name: `${P}mgrA`, role: 'MANAGER', loc: locA, sv: 0 })
  tokB = createToken({ sub: mgrB, name: `${P}mgrB`, role: 'MANAGER', loc: locB, sv: 0 })
  tokWaiter = createToken({ sub: waiterA, name: `${P}waiterA`, role: 'WAITER', loc: locA, sv: 0 })

  const menuId = `${P}menu-${RUN}`
  const catId = `${P}cat-${RUN}`
  miId = `${P}mi-${RUN}`
  invId = `${P}inv-${RUN}`
  await db.menu.create({ data: { id: menuId, name: `${P}Meni`, locationId: locA } })
  await db.category.create({ data: { id: catId, name: `${P}Kategorija`, menuId } })
  await db.menuItem.create({ data: { id: miId, name: `${P}Test jed`, price: 20, categoryId: catId, vatRate: 22 } })
  await db.inventoryItem.create({ data: { id: invId, name: `${P}Moka`, unit: 'kg', quantity: 0, costPerUnit: 2, category: 'moka', locationId: locA } })
  await db.recipeItem.create({
    data: {
      id: nid(), menuItemId: miId, inventoryItemId: invId,
      quantityPerServing: 0.5, unit: 'kg', yieldPercent: 100,
      updatedAt: D('2026-09-01T00:00:00Z'),
    },
  })

  // ─── kronologija (ročno preverljiva) ───
  // 09-19: prejem v PREJŠNJEM oknu (osnova za cenovni vpliv: 2.0)
  await tx({ type: 'RECEIVE', qty: 10.5, at: T_PRE_RECEIPT, cost: 2 })
  // 09-20: naročilo O2 plačano PRED oknom — 1 jed → SALE −0.5 (izven teoretičnega)
  const o2 = await mkOrder(ORDER_NUMBER_BASE + 2, T_O2, [{ qty: 1 }])
  await tx({ type: 'SALE', qty: -0.5, at: T_O2, cost: 2, orderId: o2 })
  // 09-28: popis S1: pričakovano 10.0, prešeto 10.0 → STOCKTAKE 0 … živo 10.0
  // (veriga: 10.5 − 0.5 = 10.0; popis potrdi — sidro otvoritve s PREŠTETO vrednostjo)
  await mkStocktake(`${P}st1-${RUN}`, T_S1, 10, 10)
  // 10-03: GRN prejem +6 kg @ 3.0 (tip 'purchase' — mala črka!)
  await tx({ type: 'purchase', qty: 6, at: T_PURCHASE, cost: 3, supplierDoc: 'GRN-I17-1' })
  // 10-05: naročilo O1 plačano V oknu — 4 jedi → teoretično 4 × 0.5 = 2.0
  const o1 = await mkOrder(ORDER_NUMBER_BASE + 1, T_O1, [{ qty: 4 }])
  orderO1 = ORDER_NUMBER_BASE + 1
  await tx({ type: 'SALE', qty: -2, at: T_O1, cost: 3, orderId: o1 })
  // 10-07: odpis 1.0 kg
  await tx({ type: 'WASTE', qty: -1, at: T_WASTE, cost: 3, reason: 'Kvar' })
  // 10-09: naročilo O3 z VOIDANO postavko (3 jedi) — NE šteje ne teoretično ne razknjižbeno
  await mkOrder(ORDER_NUMBER_BASE + 3, T_O3, [{ qty: 3, voided: true }])
  // 10-14: popis S2: pričakovano 13.0, prešeto 12.4 → STOCKTAKE −0.6 (sidro zaključka)
  stocktakeS2Id = `${P}st2-${RUN}`
  await mkStocktake(stocktakeS2Id, T_S2, 13, 12.4)
  // 11-05: naročilo O4 plačano PO oknu (prihodnje datirano) — izključitev + test
  // rekonstrukcije zaključka (živo stanje nosi njegov odjem, okno ga NE vidi)
  const o4 = await mkOrder(ORDER_NUMBER_BASE + 4, T_O4, [{ qty: 2 }])
  await tx({ type: 'SALE', qty: -1, at: T_O4, cost: 3, orderId: o4 })

  // živo stanje: 12.4 (S2) − 1.0 (O4) = 11.4
  await db.inventoryItem.update({ where: { id: invId }, data: { quantity: 11.4 } })
})

afterAll(async () => {
  for (const oid of createdOrderIds) {
    await db.orderItem.deleteMany({ where: { orderId: oid } }).catch(() => null)
    await db.stockTransaction.deleteMany({ where: { orderId: oid } }).catch(() => null)
    await db.order.deleteMany({ where: { id: oid } }).catch(() => null)
  }
  await db.stocktakeItem.deleteMany({ where: { stocktakeId: { startsWith: `${P}st` } } }).catch(() => null)
  await db.stocktake.deleteMany({ where: { id: { startsWith: `${P}st` } } }).catch(() => null)
  await db.stockTransaction.deleteMany({ where: { id: { in: createdTxIds } } }).catch(() => null)
  await db.recipeItem.deleteMany({ where: { menuItemId: miId } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: miId } }).catch(() => null)
  await db.inventoryItem.deleteMany({ where: { id: invId } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: `${P}mgr` } || undefined } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: `${P}waiter` } || undefined } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { in: [locA, locB] } } }).catch(() => null)
})

// ═════════════════════ A. ČISTA MATEMATIKA ═════════════════════

describe('issue #17 — txGroupOf (klasifikacija, case-insensitive)', () => {
  it("'purchase' (GRN, mala črka) in 'RECEIVE' sta prejem", () => {
    expect(txGroupOf('purchase')).toBe('receipt')
    expect(txGroupOf('RECEIVE')).toBe('receipt')
    expect(txGroupOf('Receive')).toBe('receipt')
  })
  it('STORNO_RETURN/BATCH_OUTPUT/BATCH_INPUT/SALE/WASTE/STOCKTAKE/ADJUST + neznano', () => {
    expect(txGroupOf('STORNO_RETURN')).toBe('return')
    expect(txGroupOf('storno_return')).toBe('return')
    expect(txGroupOf('BATCH_OUTPUT')).toBe('production')
    expect(txGroupOf('BATCH_INPUT')).toBe('prep')
    expect(txGroupOf('SALE')).toBe('sale')
    expect(txGroupOf('WASTE')).toBe('waste')
    expect(txGroupOf('STOCKTAKE')).toBe('correction')
    expect(txGroupOf('ADJUST')).toBe('correction')
    expect(txGroupOf('MYSTERY')).toBe('unknown')
    expect(txGroupOf('')).toBe('unknown')
  })
})

describe('issue #17 — unitFactor (izrecne pretvorbe ONLY)', () => {
  it('kg↔g in l↔ml ×1000/÷1000; ista/prazna enota = 1', () => {
    expect(unitFactor('kg', 'g')).toBe(1000)
    expect(unitFactor('g', 'kg')).toBe(0.001)
    expect(unitFactor('l', 'ml')).toBe(1000)
    expect(unitFactor('ML', 'L')).toBe(0.001)
    expect(unitFactor('kg', 'kg')).toBe(1)
    expect(unitFactor('', 'kg')).toBe(1)
  })
  it('kos/paket/komad se NE pretvarja (null — ni izmišljene pretvorbe)', () => {
    expect(unitFactor('kos', 'kg')).toBeNull()
    expect(unitFactor('pcs', 'kg')).toBeNull()
    expect(unitFactor('pak', 'g')).toBeNull()
    expect(unitFactor('kg', 'l')).toBeNull()
  })
})

/** Skupni gradnik: čista fikstura (zgled A) kot podatkovni nizi. */
function baseItem(over: Partial<FcInvItem> = {}): FcInvItem {
  return {
    id: 'inv1', name: 'Moka', unit: 'kg', category: 'moka', costPerUnit: 2,
    quantity: 12.4, locationId: 'locA', locationName: 'Ljubljana', ...over,
  }
}
function fixtureTxs(): FcTxRow[] {
  const tx = (id: string, type: string, qty: number, at: string, cost = 0, orderId?: string, supplierDoc?: string, reason?: string): FcTxRow => ({
    id, inventoryItemId: 'inv1', type, quantity: qty, createdAt: D(at), costPerUnit: cost,
    orderId: orderId || null, supplierDoc: supplierDoc || null, reason: reason || null,
  })
  return [
    tx('t0', 'RECEIVE', 10.5, '2026-09-19T10:00:00Z', 2),
    tx('t1', 'SALE', -0.5, '2026-09-20T12:00:00Z', 2, 'o2'),
    tx('t2', 'STOCKTAKE', 0, '2026-09-28T10:00:00Z'),
    tx('t3', 'purchase', 6, '2026-10-03T10:00:00Z', 3, undefined, 'GRN-I17-1'),
    tx('t4', 'SALE', -2, '2026-10-05T12:00:00Z', 3, 'o1'),
    tx('t5', 'WASTE', -1, '2026-10-07T09:00:00Z', 3, undefined, undefined, 'Kvar'),
    tx('t6', 'STOCKTAKE', -0.6, '2026-10-14T16:00:00Z'),
    tx('t7', 'SALE', -1, '2026-11-05T12:00:00Z', 3, 'o4'),
  ]
}
function fixtureInput(over: Partial<FcInput> = {}): FcInput {
  return {
    from: FROM, to: TO,
    items: [baseItem({ quantity: 11.4 })],
    transactions: fixtureTxs(),
    recipes: [{
      id: 'r1', menuItemId: 'mi1', inventoryItemId: 'inv1', quantityPerServing: 0.5,
      yieldPercent: 100, unit: 'kg', parentRecipeItemId: null, updatedAt: D('2026-09-01T00:00:00Z'),
    }],
    sold: [{ menuItemId: 'mi1', quantity: 4, price: 20, discountAmount: 0, orderNumber: ORDER_NUMBER_BASE + 1 }],
    soldItemNames: { mi1: 'Test jed' },
    stocktakes: [
      { id: 'st1', approvedAt: T_S1, items: [{ inventoryItemId: 'inv1', countedQuantity: 10 }] },
      { id: 'st2', approvedAt: T_S2, items: [{ inventoryItemId: 'inv1', countedQuantity: 12.4 }] },
    ],
    priceHistory: {},
    orderNumbers: { o1: ORDER_NUMBER_BASE + 1, o4: ORDER_NUMBER_BASE + 4 },
    stocktakeIdByTxId: { t6: 'st2' },
    currency: 'EUR',
    ...over,
  }
}

describe('issue #17 — ROČNO PREVERLJIVA fikstura (popis+prejem+prodaja+odpis+popravek)', () => {
  const rep = buildFoodCostVariance(fixtureInput())
  const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!

  it('otvoritev: PREŠTETO st Sidra + premiki do from (10.0), zaključek 12.4', () => {
    expect(row.openingQty).toBe(10)
    expect(row.openingBasis).toBe('stocktake')
    expect(row.closingQty).toBe(12.4)
    expect(row.closingBasis).toBe('stocktake')
  })
  it('dejanska poraba = otvoritev + prejemi − zaključek = 3.6; teoretično = 4 × 0.5 = 2.0', () => {
    expect(row.receiptsQty).toBe(6)
    expect(row.actualUsageQty).toBe(3.6)
    expect(row.theoreticalQty).toBe(2)
    expect(row.varianceQty).toBe(1.6)
  })
  it('razčlenitev: odpis +1.0, popravek +0.6 (−0.6 ugotovljeno pomanjkanje), ostalo 0 → nepojasnjeno 0', () => {
    expect(row.waste.qty).toBe(1)
    expect(row.inventoryCorrection.qty).toBe(0.6) // komponenta = −correctionQty
    expect(row.prepConsumption.qty).toBe(0)
    expect(row.returns.qty).toBe(0)
    expect(row.saleShortfall.qty).toBe(0)
    expect(row.unexplained.qty).toBe(0)
  })
  it('vrednote: period_avg cena 3.0 → teor. 6.0 / dej. 10.8 / var. 4.8 / odpis 3.0', () => {
    expect(row.price).toBe(3)
    expect(row.priceBasis).toBe('period_avg')
    expect(row.theoreticalValue).toBe(6)
    expect(row.actualValue).toBe(10.8)
    expect(row.varianceValue).toBe(4.8)
    expect(row.waste.value).toBe(3)
  })
  it('cenovni vpliv (informativno): prejšnje okno prejem @2.0 → (3−2) × teor. 2.0 = +2.0, NI del vsote', () => {
    expect(row.priorPrice).toBe(2)
    expect(row.priceChangeImpact).toBe(2)
  })
  it('KPI: neto prodaja 80 → dej. FC 13.5 %, teor. FC 7.5 %, varianca 80 % nad teor., delež odpisov 27.78 %', () => {
    expect(rep.netSales).toBe(80)
    expect(rep.kpi.actualFoodCostPct).toBe(13.5)
    expect(rep.kpi.theoreticalFoodCostPct).toBe(7.5)
    expect(rep.kpi.variancePctOfTheoretical).toBe(80)
    expect(rep.kpi.wasteValue).toBe(3)
    expect(rep.kpi.wasteSharePct).toBe(27.78)
  })
  it('dokazi: št. naročila O1, prejem GRN, popis S2', () => {
    expect(row.saleOrderNumbers).toEqual([ORDER_NUMBER_BASE + 1])
    expect(row.receiptDocs).toEqual(['GRN-I17-1'])
    expect(row.stocktakeIds).toEqual(['st2'])
  })
  it('podatkovna kakovost: popisa na obeh koncih → brez razlogov nepopolnosti', () => {
    expect(rep.dataQuality.incompleteData).toBe(false)
    expect(rep.dataQuality.reasons).toEqual([])
    expect(rep.dataQuality.hasOpeningStocktake).toBe(true)
    expect(rep.dataQuality.hasClosingStocktake).toBe(true)
  })
  it('agregacija: vsota po artiklih = skupaj; kategorija zrcali', () => {
    expect(rep.totals.actualUsageQty).toBe(3.6)
    expect(rep.totals.theoreticalQty).toBe(2)
    expect(rep.totals.varianceQty).toBe(1.6)
    expect(rep.totals.wasteQty).toBe(1)
    expect(rep.byCategory[0].category).toBe('moka')
    expect(rep.byCategory[0].varianceValue).toBe(4.8)
  })
})

describe('issue #17 — knjigovodska osnova brez popisa (strukturirana zaprtost)', () => {
  it('brez inventur: osnova = knjiga, razloga no_opening/no_closing, nepojasnjeno 0 (identiteta se zapre)', () => {
    const rep = buildFoodCostVariance(fixtureInput({ stocktakes: [] }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.openingBasis).toBe('ledger')
    expect(row.closingBasis).toBe('ledger')
    // opening = live 11.4 − Σ(>from) = 11.4 + 1.0 = 12.4 − prejemi v oknu…
    // live − (purchase 6 − sale 2 − waste 1 − STOCKTAKE −0.6 − O4 −1) = 11.4 − 1.4 = 10.0
    expect(row.openingQty).toBe(10)
    expect(row.closingQty).toBe(12.4)
    expect(row.actualUsageQty).toBe(3.6)
    expect(row.unexplained.qty).toBe(0)
    expect(rep.dataQuality.incompleteData).toBe(true)
    expect(rep.dataQuality.reasons).toContain('no_opening_stocktake')
    expect(rep.dataQuality.reasons).toContain('no_closing_stocktake')
  })
})

describe('issue #17 — vračila, primanjkljaj, drift, neznani tipi', () => {
  it('STORNO_RETURN: vračilo zmanjša dejansko porabo (komponenta −2)', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      stocktakes: [],
      transactions: [
        ...fixtureTxs(),
        { id: 't8', inventoryItemId: 'inv1', type: 'STORNO_RETURN', quantity: 2, createdAt: D('2026-10-10T12:00:00Z'), costPerUnit: 3 },
      ],
      items: [baseItem({ quantity: 13.4 })], // +2 vračeno
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.returns.qty).toBe(-2)
    // poraba = 3.6 − 2.0 = 1.6; varianca = −0.4; pojasni: odpis 1.0 + popravek 0.6 − vračilo 2.0
    expect(row.actualUsageQty).toBe(1.6)
    expect(row.varianceQty).toBe(-0.4)
    expect(row.unexplained.qty).toBe(0)
  })

  it('primanjkljaj: SALE odšteje manj kot teoretično → komponenta −shortfall', () => {
    // zaloga ob prodaji samo 1.0 od 2.0 → SALE −1.0; živo 12.4 −1 = 11.4; brez popisov
    const rep = buildFoodCostVariance(fixtureInput({
      stocktakes: [],
      transactions: [
        { id: 'p0', inventoryItemId: 'inv1', type: 'RECEIVE', quantity: 13, createdAt: D('2026-09-19T10:00:00Z'), costPerUnit: 2 },
        { id: 'p1', inventoryItemId: 'inv1', type: 'purchase', quantity: 6, createdAt: D('2026-10-03T10:00:00Z'), costPerUnit: 3 },
        { id: 'p2', inventoryItemId: 'inv1', type: 'SALE', quantity: -1, createdAt: D('2026-10-05T12:00:00Z'), costPerUnit: 3, orderId: 'o1' },
        { id: 'p3', inventoryItemId: 'inv1', type: 'WASTE', quantity: -1, createdAt: D('2026-10-07T09:00:00Z'), costPerUnit: 3 },
      ],
      items: [baseItem({ quantity: 17 })], // 13 + 6 − 1 − 1
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    // opening = live − Σ(>from) = 17 − (6 − 1 − 1) = 13; closing = 17
    // poraba = 13 + 6 − 17 = 2.0 (razknjižba 1 + odpis 1); teoretično 2.0
    expect(row.ledgerSaleQty).toBe(1)
    expect(row.actualUsageQty).toBe(2)
    expect(row.varianceQty).toBe(0)
    expect(row.saleShortfall.qty).toBe(-1) // teoretično 2 − razknjižba 1
    expect(row.unexplained.qty).toBe(0)
  })

  it('drift brez dokumenta (živo ≠ knjiga) → NEPOJASNJENO s pravilnim predznakom', () => {
    // OTVORITVENO SIDRO (popis 13) + knjižovodski zaključek: drift v oknu je viden,
    // ker otvoritev ostane fizična, zaključek pa nosi napako.
    const base = [
      { id: 'd0', inventoryItemId: 'inv1', type: 'RECEIVE', quantity: 13, createdAt: D('2026-09-19T10:00:00Z'), costPerUnit: 2, orderId: null, supplierDoc: null, reason: null },
      { id: 'd1', inventoryItemId: 'inv1', type: 'purchase', quantity: 6, createdAt: D('2026-10-03T10:00:00Z'), costPerUnit: 3, orderId: null, supplierDoc: null, reason: null },
      { id: 'd2', inventoryItemId: 'inv1', type: 'SALE', quantity: -2, createdAt: D('2026-10-05T12:00:00Z'), costPerUnit: 3, orderId: 'o1', supplierDoc: null, reason: null },
      { id: 'd3', inventoryItemId: 'inv1', type: 'WASTE', quantity: -1, createdAt: D('2026-10-07T09:00:00Z'), costPerUnit: 3, orderId: null, supplierDoc: null, reason: null },
    ] as FcTxRow[]
    // +0.5 nedokumentiranega presežka (knjiga 16, živo 16.5)
    const rep = buildFoodCostVariance(fixtureInput({
      stocktakes: [{ id: 'stD', approvedAt: T_S1, items: [{ inventoryItemId: 'inv1', countedQuantity: 13 }] }],
      transactions: base,
      items: [baseItem({ quantity: 16.5 })],
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    // otvoritev = PREŠTETO 13; zaključek = živo 16.5 → poraba = 13 + 6 − 16.5 = 2.5
    // pojasnjeno: odpis 1.0 → NEPOJASNJENO −0.5 (presežek brez dokumenta)
    expect(row.openingQty).toBe(13)
    expect(row.actualUsageQty).toBe(2.5)
    expect(row.unexplained.qty).toBe(-0.5)
    expect(row.unexplained.value).toBe(-1.5)

    // −0.5 nedokumentiranega odjema (knjiga 16, živo 15.5) → NEPOJASNJENO +0.5
    const rep2 = buildFoodCostVariance(fixtureInput({
      stocktakes: [{ id: 'stD', approvedAt: T_S1, items: [{ inventoryItemId: 'inv1', countedQuantity: 13 }] }],
      transactions: base,
      items: [baseItem({ quantity: 15.5 })],
    }))
    const row2 = rep2.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row2.actualUsageQty).toBe(3.5)
    expect(row2.unexplained.qty).toBe(0.5)
    expect(row2.unexplained.value).toBe(1.5)
  })

  it('neznan tip transakcije v oknu → prispevek VIDI v nepojasnjenem', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      stocktakes: [],
      transactions: [
        { id: 'u0', inventoryItemId: 'inv1', type: 'RECEIVE', quantity: 13, createdAt: D('2026-09-19T10:00:00Z'), costPerUnit: 2 },
        { id: 'u1', inventoryItemId: 'inv1', type: 'purchase', quantity: 6, createdAt: D('2026-10-03T10:00:00Z'), costPerUnit: 3 },
        { id: 'u2', inventoryItemId: 'inv1', type: 'SALE', quantity: -2, createdAt: D('2026-10-05T12:00:00Z'), costPerUnit: 3, orderId: 'o1' },
        { id: 'u3', inventoryItemId: 'inv1', type: 'MYSTERY', quantity: -0.7, createdAt: D('2026-10-08T09:00:00Z'), costPerUnit: 3 },
      ],
      items: [baseItem({ quantity: 16.3 })], // 13 + 6 − 2 − 0.7
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    // opening = 16.3 − (6 − 2 − 0.7) = 13; closing = 16.3; poraba = 13 + 6 − 16.3 = 2.7
    // teoretično 2.0, ni odpisa/popravka → nepojasnjeno = 0.7 (skriti odjem)
    expect(row.actualUsageQty).toBe(2.7)
    expect(row.unexplained.qty).toBe(0.7)
    expect(row.unexplained.value).toBe(2.1)
  })
})

describe('issue #17 — enote in recepture', () => {
  it('kg proti g: receptura 0.2 kg na zalogi v g → teoretično × 1000', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      items: [baseItem({ unit: 'g', quantity: 12400 })],
      recipes: [{
        id: 'r1', menuItemId: 'mi1', inventoryItemId: 'inv1', quantityPerServing: 0.2,
        yieldPercent: 100, unit: 'kg', parentRecipeItemId: null, updatedAt: D('2026-09-01T00:00:00Z'),
      }],
      stocktakes: [
        { id: 'st1', approvedAt: T_S1, items: [{ inventoryItemId: 'inv1', countedQuantity: 10000 }] },
        { id: 'st2', approvedAt: T_S2, items: [{ inventoryItemId: 'inv1', countedQuantity: 12400 }] },
      ],
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.theoreticalQty).toBe(800) // 4 × 0.2 kg = 0.8 kg = 800 g
    expect(row.unitMismatch).toBe(false)
  })

  it('kos proti kg: NEPOZNANA pretvorba → zastavica unitMismatch + razlog, količina nespremenjena', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      items: [baseItem({ unit: 'kg' })],
      recipes: [{
        id: 'r1', menuItemId: 'mi1', inventoryItemId: 'inv1', quantityPerServing: 2,
        yieldPercent: 100, unit: 'kos', parentRecipeItemId: null, updatedAt: D('2026-09-01T00:00:00Z'),
      }],
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.unitMismatch).toBe(true)
    expect(row.theoreticalQty).toBe(8) // 4 × 2 (BREZ pretvorbe — ni izmišljene)
    expect(rep.dataQuality.itemsWithUnitMismatch).toBe(1)
    expect(rep.dataQuality.reasons).toContain('unit_mismatch')
  })

  it('yield 80 %: neto 0.5 → teoretično 0.5 / 0.8 = 0.625 na porcijo', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      recipes: [{
        id: 'r1', menuItemId: 'mi1', inventoryItemId: 'inv1', quantityPerServing: 0.5,
        yieldPercent: 80, unit: 'kg', parentRecipeItemId: null, updatedAt: D('2026-09-01T00:00:00Z'),
      }],
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.theoreticalQty).toBe(2.5) // 4 × 0.625
  })

  it('podreceptura: starš (0.2) + otrok (0.3) se OBRA odštejeta (0.5 na porcijo)', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      recipes: [
        { id: 'rp', menuItemId: 'mi1', inventoryItemId: 'invParent', quantityPerServing: 0.2, yieldPercent: 100, unit: 'kg', parentRecipeItemId: null, updatedAt: D('2026-09-01T00:00:00Z') },
        { id: 'rc', menuItemId: 'mi1', inventoryItemId: 'inv1', quantityPerServing: 0.3, yieldPercent: 100, unit: 'kg', parentRecipeItemId: 'rp', updatedAt: D('2026-09-01T00:00:00Z') },
      ],
      items: [baseItem()],
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.theoreticalQty).toBe(1.2) // 4 × 0.3 (otrok)
  })

  it('prodaja brez recepture: vidna vrzel + razlog', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      recipes: [],
      sold: [
        { menuItemId: 'mi1', quantity: 4, price: 20, discountAmount: 0, orderNumber: 1 },
        { menuItemId: 'mi2', quantity: 2, price: 15, discountAmount: 0, orderNumber: 2 },
      ],
      soldItemNames: { mi1: 'Test jed', mi2: 'Jed brez recepture' },
    }))
    expect(rep.soldWithoutRecipe.length).toBe(2)
    expect(rep.soldWithoutRecipe.find((s) => s.menuItemId === 'mi2')?.name).toBe('Jed brez recepture')
    expect(rep.dataQuality.soldMenuItemsWithoutRecipe).toBe(2)
    expect(rep.dataQuality.reasons).toContain('sold_menu_items_without_recipe')
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.theoreticalQty).toBe(0)
  })

  it('receptura spremenjena po from → zastavica + razlog', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      recipes: [{
        id: 'r1', menuItemId: 'mi1', inventoryItemId: 'inv1', quantityPerServing: 0.5,
        yieldPercent: 100, unit: 'kg', parentRecipeItemId: null, updatedAt: D('2026-10-10T00:00:00Z'),
      }],
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.recipeChangedSinceFrom).toBe(true)
    expect(rep.dataQuality.recipesPossiblyChanged).toBe(1)
    expect(rep.dataQuality.reasons).toContain('recipes_possibly_changed')
  })
})

describe('issue #17 — vrednotenje (zgodovinska cena, nikoli izmišljena)', () => {
  /** fiksturne transakcije z BREZCENIM prejemom (padec na naslednji vir cene) */
  const txsNoPricedReceipt = (): FcTxRow[] =>
    fixtureTxs().map((t) => (t.id === 't3' ? { ...t, costPerUnit: 0 } : t))

  it('brez OCENJENIH prejemov v oknu → zadnja dobaviteljska cena (last_supplier_price)', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      transactions: txsNoPricedReceipt(),
      priceHistory: { inv1: { unitPrice: 2.5, observedAt: D('2026-10-10T00:00:00Z') } },
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.price).toBe(2.5)
    expect(row.priceBasis).toBe('last_supplier_price')
    expect(row.theoreticalValue).toBe(5)
  })
  it('brez vira cene → unknown: vrednosti NULL (ne 0!) + razlog', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      transactions: txsNoPricedReceipt(),
      items: [baseItem({ costPerUnit: 0 })],
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.price).toBeNull()
    expect(row.priceBasis).toBe('unknown')
    expect(row.theoreticalValue).toBeNull()
    expect(row.actualValue).toBeNull()
    expect(row.varianceValue).toBeNull()
    expect(rep.kpi.actualFoodCostValue).toBeNull()
    expect(rep.kpi.actualFoodCostPct).toBeNull()
    expect(rep.dataQuality.itemsWithUnknownPrice).toBe(1)
    expect(rep.dataQuality.reasons).toContain('items_with_unknown_price')
  })
  it('uteženo povprečje prejemov v oknu: (3×6 + 4×4) / 10 = 3.4', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      transactions: [
        ...fixtureTxs(),
        { id: 'w1', inventoryItemId: 'inv1', type: 'purchase', quantity: 4, createdAt: D('2026-10-10T10:00:00Z'), costPerUnit: 4, supplierDoc: 'GRN-2' },
      ],
      items: [baseItem({ quantity: 15.4 })], // +4
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.price).toBe(3.4)
    expect(row.priceBasis).toBe('period_avg')
  })
  it('trenutna cena SAMO z izrecno oznako current_cost', () => {
    const rep = buildFoodCostVariance(fixtureInput({
      transactions: [], // noben prejem nikoli
      items: [baseItem({ costPerUnit: 2.2, quantity: 12.4 })],
    }))
    const row = rep.items.find((r) => r.inventoryItemId === 'inv1')!
    expect(row.price).toBe(2.2)
    expect(row.priceBasis).toBe('current_cost')
  })
})

// ═════════════════════ B. RUTA (ci-fresh DB) ═════════════════════

describe('issue #17 — GET /api/reports/food-cost (ruta, pravice, CSV)', () => {
  it('brez žetona → 401', async () => {
    const res = await foodCostGET(req('GET', '/api/reports/food-cost'))
    expect(res.status).toBe(401)
  })

  it('waiter (brez reports.view) → 403', async () => {
    const res = await foodCostGET(req('GET', '/api/reports/food-cost', tokWaiter))
    expect(res.status).toBe(403)
  })

  it('from > to → 400', async () => {
    const res = await foodCostGET(req('GET', '/api/reports/food-cost?from=2026-10-15&to=2026-10-01', tokA))
    expect(res.status).toBe(400)
  })

  it('preobdobje (> 366 dni) → 400', async () => {
    const res = await foodCostGET(req('GET', '/api/reports/food-cost?from=2025-01-01&to=2026-12-31', tokA))
    expect(res.status).toBe(400)
  })

  it('celoten tok: exact številke fiksture (popis sidra, paidAt obseg, void izključitev)', async () => {
    const res = await foodCostGET(req('GET', '/api/reports/food-cost?from=2026-10-01&to=2026-10-15', tokA))
    expect(res.status).toBe(200)
    const data = await body(res)
    const items = data.items as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    const row = items[0]
    // otvoritev/zaključek iz PREŠTETIH popisov (fizična resnica — O4 po oknu ne vidi)
    expect(row.openingQty).toBe(10)
    expect(row.openingBasis).toBe('stocktake')
    expect(row.closingQty).toBe(12.4)
    expect(row.closingBasis).toBe('stocktake')
    expect(row.receiptsQty).toBe(6)
    // teoretično: SAMO O1 (O2 pred oknom, O3 voidan, O4 po oknu)
    expect(row.theoreticalQty).toBe(2)
    expect(row.actualUsageQty).toBe(3.6)
    expect(row.varianceQty).toBe(1.6)
    expect((row.waste as Record<string, unknown>).qty).toBe(1)
    expect((row.inventoryCorrection as Record<string, unknown>).qty).toBe(0.6)
    expect((row.unexplained as Record<string, unknown>).qty).toBe(0)
    expect(row.price).toBe(3)
    expect(row.priceBasis).toBe('period_avg')
    expect(row.theoreticalValue).toBe(6)
    expect(row.actualValue).toBe(10.8)
    expect(row.varianceValue).toBe(4.8)
    // dokazi
    expect(row.saleOrderNumbers).toEqual([orderO1])
    expect(row.receiptDocs).toEqual(['GRN-I17-1'])
    expect(row.stocktakeIds).toEqual([stocktakeS2Id])
    // KPI
    const kpi = data.kpi as Record<string, unknown>
    expect(data.netSales).toBe(80)
    expect(kpi.actualFoodCostPct).toBe(13.5)
    expect(kpi.theoreticalFoodCostPct).toBe(7.5)
    expect(kpi.variancePctOfTheoretical).toBe(80)
    expect(kpi.wasteSharePct).toBe(27.78)
    // kakovost: popisa + receptura (updatedAt 2026-09-01) → popolna
    const dq = data.dataQuality as Record<string, unknown>
    expect(dq.incompleteData).toBe(false)
    expect(dq.reasons).toEqual([])
  })

  it('CSV: BOM + `;` + Content-Disposition + ISTE številke kot JSON', async () => {
    const res = await foodCostGET(req('GET', '/api/reports/food-cost?from=2026-10-01&to=2026-10-15&format=csv', tokA))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('food-cost-varianca-')
    const text = await res.text()
    expect(text.startsWith('\uFEFF')).toBe(true)
    expect(text).toContain('Artikel')
    expect(text).toContain('GRN-I17-1')
    expect(text).toContain('period_avg')
    // iste številke kot JSON (vrstica artikla)
    expect(text).toContain('3.6')
    expect(text).toContain('1.6')
    expect(text).toContain('12.4')
    expect(text.split('\r\n').length).toBeGreaterThanOrEqual(12) // glava + KPI + stolpci + vrstica
  })

  it('tenant izolacija: manager lokacije B vidi SAMO svoje artikle (prazno + razlog)', async () => {
    const res = await foodCostGET(req('GET', '/api/reports/food-cost?from=2026-10-01&to=2026-10-15', tokB))
    expect(res.status).toBe(200)
    const data = await body(res)
    expect((data.items as unknown[]).length).toBe(0)
    const dq = data.dataQuality as Record<string, unknown>
    expect(dq.incompleteData).toBe(true)
    expect((dq.reasons as string[])).toContain('no_items_in_scope')
    // stroški lokacije A se NE razkrijejo
    const text = JSON.stringify(data)
    expect(text).not.toContain('GRN-I17-1')
    expect(text).not.toContain('Moka')
  })
})
