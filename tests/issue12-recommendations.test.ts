/**
 * Issue #12 (P2) — priporočeni nabavni nalogi iz porabe, zaloge, dobavnih
 * rokov in pakiranj.
 *
 * Pokrito:
 *  A. ČISTI MOTOR (src/lib/reorder-recommend.ts, brez DB):
 *   1. formula: target = use × (lead + review) + safety; need = target −
 *      zaloga − prihaja; RECOMMEND + vse izpeljane vrednosti;
 *   2. pakiranja: zaokroževanje NAVZGOR na paket + minOrderPacks prag;
 *   3. brez dobavitelja: količina = need, ocena po costPerUnit;
 *   4. predvideni datum pomanjkanja (onHand / use dni od "zdaj");
 *   5. pokritost null brez zgodovine porabe (ni izmišljenega datuma);
 *   6. WATCH: pod pragom brez zgodovine (dedni PAR signal) z zastavico;
 *   7. WATCH: odprta naročila pokrijejo primanjkljaj;
 *   8. zaloga pokriva prihodnost → null (izpusti);
 *   9. združevanje po dobavitelju (skupna skupina brez, razvrščeno po vsoti);
 *  B. GET /api/purchase-orders/recommendations:
 *   1. srečna pot: povprečna dnevna poraba iz StockTransaction knjige,
 *      prihajajoča količina iz odprtega (approved) naročila, paketi, ocena;
 *   2. ?days=7: krajše okno → višja dnevna poraba (iste transakcije);
 *   3. validacija parametrov: days=0 → 400, reviewDays=0 → 400;
 *   4. 401 brez žetona;
 *   5. requireAuth: tudi staff (brez inventory.manage) lahko BERE;
 *   6. lokacijski obseg: manager A vidi SAMO svojo lokacijo (itemC locB ne),
 *      manager B vidi itemC; locationId param lokalne vloge ignorira;
 *   7. centralni admin z locationId parametrom vidi ciljno lokacijo;
 *  C. POST /api/purchase-orders/recommendations/apply:
 *   1. srečna pot: osnutek PO s količino packs × packQty, ceno iz
 *      SupplierItem (pricePerPack/packQty), DDV, žigosanimi pakiranji,
 *      centno natančnimi vsotami, revizijo PO_CREATE s source:recommendation;
 *   2. mejna: OSNUTEK NI potrjena dobava (ni v prihajajočih), po oddaji
 *      (submit) priporočilo izgine → artikel postane WATCH (pokrito);
 *   3. 401 / 403 (staff brez inventory.manage) / 404 (neznani dobavitelj);
 *   4. 400: prazne vrstice, packs=0, packs=2.5, podvojen artikel, neobstoječi
 *      artikel;
 *   5. 403: artikel tuje lokacije, lokacija naročila odstopa od uporabnikove;
 *   6. SupplierItem backfill: apply za artikel BREZ kataloga ustvari vezavo
 *      (pricePerPack = cena na paket);
 *
 * Fiksture s predpono i12-; čiščenje po vzorcu i18a (audit po locationId,
 * nabavni modeli po supplierId, nato splošni sweep).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as recsGET } from '../src/app/api/purchase-orders/recommendations/route'
import { POST as applyPOST } from '../src/app/api/purchase-orders/recommendations/apply/route'
import { PATCH as poPATCH } from '../src/app/api/purchase-orders/[id]/route'
import {
  recommendForItem, recommendAll, groupRecommendationsBySupplier, packsFor,
  type RecommendItemInput, type RecommendSupplier,
} from '../src/lib/reorder-recommend'

const P = 'i12-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let mgrA = ''
let mgrB = ''
let staffA = ''
let adminC = ''
let tokA = ''
let tokB = ''
let tokStaff = ''
let tokAdmin = ''
let supX = ''

let itemA = '' // Kava: poraba 1/dan, rok 3, safety 5, odprto naročilo 4
let itemB = '' // Brez zgodovine: pod PAR → WATCH
let itemC = '' // locB: za preizkus obsega
let itemD = '' // Brez dobaviteljskega kataloga (backfill + need brez paketov)

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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

async function mkItem(id: string, name: string, loc: string, data: {
  quantity: number; minQuantity?: number; reorderPoint?: number | null
  safetyStock?: number | null; leadTimeDays?: number | null; costPerUnit?: number
}): Promise<string> {
  await db.inventoryItem.create({
    data: {
      id, name, unit: 'kg', locationId: loc,
      quantity: data.quantity, minQuantity: data.minQuantity ?? 0,
      reorderPoint: data.reorderPoint ?? null, safetyStock: data.safetyStock ?? null,
      leadTimeDays: data.leadTimeDays ?? null, costPerUnit: data.costPerUnit ?? 1,
    },
  })
  return id
}

/** Potrošne transakcije (SALE — negativne, podpisane) porazdeljene v preteklost. */
async function mkTx(itemId: string, daysAgo: number, qty: number, type = 'SALE'): Promise<void> {
  await db.stockTransaction.create({
    data: {
      id: `${P}tx-${RUN}-${Math.random().toString(36).slice(2, 10)}`,
      inventoryItemId: itemId, type, quantity: qty,
      previousQty: 0, newQty: 0, costPerUnit: 0, totalCost: 0,
      createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    },
  })
}

const SUP: RecommendSupplier = {
  supplierId: 'sup-1', supplierName: 'Dobavitelj 1',
  packQty: 5, packUnit: 'paket', minOrderPacks: 2, pricePerPack: 12, vatRate: 9.5,
}

function input(over: Partial<RecommendItemInput>): RecommendItemInput {
  return {
    id: 'x', name: 'X', unit: 'kg',
    quantity: 6, minQuantity: 0, reorderPoint: 10, safetyStock: 5, leadTimeDays: 3,
    avgDailyUse: 1, historyCount: 10, incoming: 4, costPerUnit: 2.5,
    supplier: SUP, ...over,
  }
}

async function cleanup() {
  await db.auditLog.deleteMany({ where: { locationId: { startsWith: P } } })
  await db.supplierItem.deleteMany({ where: { supplierId: { startsWith: P } } })
  await db.purchaseOrder.deleteMany({ where: { supplierId: { startsWith: P } } })
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()
  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, name: `${P}Restavracija A`, code: `I12A${RUN}` } })
  await db.location.create({ data: { id: locB, name: `${P}Restavracija B`, code: `I12B${RUN}` } })

  mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  mgrB = await seedEmployee('mgrB', 'manager', locB, 2)
  staffA = await seedEmployee('staffA', 'staff', locA, 3)
  adminC = await seedEmployee('adminC', 'admin', null, 4)
  tokA = createToken({ sub: mgrA, name: `${P}mgrA`, role: 'MANAGER', loc: locA, sv: 0 })
  tokB = createToken({ sub: mgrB, name: `${P}mgrB`, role: 'MANAGER', loc: locB, sv: 0 })
  tokStaff = createToken({ sub: staffA, name: `${P}staffA`, role: 'STAFF', loc: locA, sv: 0 })
  tokAdmin = createToken({ sub: adminC, name: `${P}adminC`, role: 'ADMIN', loc: null, sv: 0 })

  // dobavitelj + katalog (paket 5 kos × 12 €, DDV 9.5 %, najmanj 2 paketa)
  supX = `${P}supX-${RUN}`
  await db.supplier.create({ data: { id: supX, name: `${P}Dobavitelj X ${RUN}`, isActive: true } })

  itemA = await mkItem(`${P}itemA-${RUN}`, `${P}Kava ${RUN}`, locA, { quantity: 6, reorderPoint: 10, safetyStock: 5, leadTimeDays: 3, costPerUnit: 2.5 })
  itemB = await mkItem(`${P}itemB-${RUN}`, `${P}Sladkor ${RUN}`, locA, { quantity: 2, minQuantity: 8 })
  itemC = await mkItem(`${P}itemC-${RUN}`, `${P}Moka ${RUN}`, locB, { quantity: 1, minQuantity: 5 })
  itemD = await mkItem(`${P}itemD-${RUN}`, `${P}Olje ${RUN}`, locA, { quantity: 1, reorderPoint: 5, safetyStock: 2, leadTimeDays: 2, costPerUnit: 3 })

  await db.supplierItem.create({
    data: {
      id: `${P}sitemA-${RUN}`, supplierId: supX, inventoryItemId: itemA,
      packQty: 5, packUnit: 'paket', pricePerPack: 12, vatRate: 9.5, minOrderPacks: 2, isActive: true,
    },
  })

  // poraba: itemA −28 (14×2) v 1–4 dneh → 1.0/dan pri 28-dnevnem oknu;
  //         itemD −14 (4×3.5) → 0.5/dan
  for (let i = 0; i < 14; i++) await mkTx(itemA, 1 + (i % 4), -2)
  for (let i = 0; i < 4; i++) await mkTx(itemD, 1 + i, -3.5)

  // odprto (POTRJENO) naročilo za itemA: 4 naročeni, 0 prejetih → incoming 4
  await db.purchaseOrder.create({
    data: {
      id: `${P}poOpen-${RUN}`, poNumber: `PO-I12-${RUN}-1`, supplierId: supX,
      status: 'approved', subtotal: 4, vatAmount: 0.88, totalAmount: 4.88,
      locationId: locA,
      PurchaseOrderItem: {
        create: [{
          id: `${P}poOpenLine-${RUN}`, description: 'Kava', inventoryItemId: itemA,
          quantityOrdered: 4, quantityReceived: 0, unit: 'kg', unitPrice: 1, vatRate: 22, totalPrice: 4.88,
        }],
      },
    },
  })
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ A. ČISTI MOTOR ═══════════════════ */

describe('issue #12 — čisti motor priporočil (reorder-recommend)', () => {
  it('A1. formula: target = use × (lead + review) + safety; need − zaloga − prihaja', () => {
    // use 1, lead 3, review 7, safety 5 → target 15; 15 − 6 − 4 = 5
    const r = recommendForItem(input({}), { reviewDays: 7, now: new Date('2026-10-15T08:00:00') })
    expect(r).not.toBeNull()
    expect(r!.verdict).toBe('RECOMMEND')
    expect(r!.targetQty).toBe(15)
    expect(r!.needQty).toBe(5)
    expect(r!.onHand).toBe(6)
    expect(r!.incoming).toBe(4)
    expect(r!.flags.belowPar).toBe(true)
  })

  it('A2. pakiranja: zaokroževanje navzgor + minOrderPacks prag', () => {
    // need 5, paket 5 → 1 paket, ampak minOrderPacks 2 → 2 paketa = 10 kos, ocena 24
    const r = recommendForItem(input({}), { reviewDays: 7 })
    expect(r!.suggestedPacks).toBe(2)
    expect(r!.suggestedQty).toBe(10)
    expect(r!.estCost).toBe(24)
    // need 11 → ceil(11/5) = 3 paketi (nad pragom 2)
    const r2 = recommendForItem(input({ quantity: 0, incoming: 0 }), { reviewDays: 7 })
    expect(r2!.needQty).toBe(15)
    expect(r2!.suggestedPacks).toBe(3)
    expect(r2!.suggestedQty).toBe(15)
    expect(packsFor(11, 5, 2)).toBe(3)
    expect(packsFor(0, 5, 2)).toBe(0)
  })

  it('A3. brez dobavitelja: količina = need, ocena po costPerUnit', () => {
    const r = recommendForItem(input({ supplier: null, quantity: 5, incoming: 0, reorderPoint: 3 }), { reviewDays: 7 })
    // target 15 − 5 − 0 = 10 → brez paketov
    expect(r!.suggestedPacks).toBe(0)
    expect(r!.suggestedQty).toBe(10)
    expect(r!.estCost).toBe(25) // 10 × 2.5
    expect(r!.flags.noSupplier).toBe(true)
  })

  it('A4. predvideni datum pomanjkanja: zaloga / dnevna poraba', () => {
    // zaloga 6, poraba 2/dan → 3 dnevi od "zdaj"
    const now = new Date('2026-10-15T08:00:00')
    const r = recommendForItem(input({ quantity: 6, avgDailyUse: 2 }), { reviewDays: 7, now })
    expect(r!.coverageDays).toBe(3)
    expect(r!.stockoutDate).toBe('2026-10-18')
  })

  it('A5. brez zgodovine porabe: pokritost in datum sta null (ni izmišljenih podatkov)', () => {
    const r = recommendForItem(input({ avgDailyUse: 0, historyCount: 0 }), { reviewDays: 7 })
    expect(r!.coverageDays).toBeNull()
    expect(r!.stockoutDate).toBeNull()
    expect(r!.flags.noHistory).toBe(true)
    // target = 0×10 + 5 = 5; 5 − 6 − 4 < 0 → pod pragom → WATCH
    expect(r!.verdict).toBe('WATCH')
  })

  it('A6. WATCH: pod pragom brez zgodovine — dedni PAR signal ohranjen', () => {
    const r = recommendForItem(input({ avgDailyUse: 0, historyCount: 0, quantity: 10, incoming: 10, reorderPoint: 12 }), { reviewDays: 7 })
    expect(r!.verdict).toBe('WATCH')
    expect(r!.suggestedQty).toBe(0)
    expect(r!.reorderPoint).toBe(12)
  })

  it('A7. WATCH: odprta naročila pokrijejo primanjkljaj', () => {
    // target 15, zaloga 6, prihaja 20 → need −11 → pod pragom → WATCH
    const r = recommendForItem(input({ incoming: 20 }), { reviewDays: 7 })
    expect(r!.verdict).toBe('WATCH')
    expect(r!.needQty).toBe(-11)
  })

  it('A8. zaloga pokriva prihodnost → null (izpusti)', () => {
    // use 1 → target 15; zaloga 30 nad pragom 10 in nad targetom
    const r = recommendForItem(input({ quantity: 30, incoming: 10 }), { reviewDays: 7 })
    expect(r).toBeNull()
  })

  it('A9. združevanje po dobavitelju + skupna skupina brez, razvrščeno po vsoti', () => {
    const { recommendations, watch, skipped } = recommendAll([
      input({ id: 'a', quantity: 30, incoming: 10 }), // izpuščen
      input({ id: 'b' }),
      input({ id: 'c', supplier: { ...SUP, supplierId: 'sup-2', supplierName: 'D2', pricePerPack: 30 } }),
      input({ id: 'd', supplier: null, quantity: 5, incoming: 0, reorderPoint: 3 }),
    ], { reviewDays: 7 })
    expect(recommendations.map((r) => r.itemId)).toEqual(['d', 'b', 'c']) // nujnost: pokritost 5 < 6 dni
    expect(watch.length).toBe(0)
    expect(skipped).toBe(1)
    const groups = groupRecommendationsBySupplier(recommendations)
    expect(groups.length).toBe(3)
    // sup-1: 24 € · sup-2: 60 € · brez: 25 € → razvrščeno 60, 25, 24
    expect(groups.map((g) => g.supplierId)).toEqual(['sup-2', null, 'sup-1'])
    expect(groups[0].total).toBe(60)
    expect(groups.find((g) => g.supplierId === null)!.items.length).toBe(1)
  })
})

/* ═══════════════════ B. GET /api/purchase-orders/recommendations ═══════════════════ */

describe('issue #12 — GET priporočil (integracija)', () => {
  it('B1. srečna pot: poraba iz knjige, prihaja iz odprtih naročil, paketi, ocena', async () => {
    const r = await recsGET(req('GET', '/api/purchase-orders/recommendations', tokA))
    expect(r.status).toBe(200)
    const b = await body(r)
    const recs = (b.recommendations ?? []) as Array<Record<string, unknown>>
    const a = recs.find((x) => x.itemId === itemA)
    expect(a).toBeDefined()
    expect(a!.avgDailyUse).toBe(1) // −28 / 28 dni
    expect(a!.incoming).toBe(4)
    expect(a!.needQty).toBe(5) // 15 − 6 − 4
    expect(a!.suggestedPacks).toBe(2)
    expect(a!.suggestedQty).toBe(10)
    expect(a!.estCost).toBe(24)
    expect(a!.supplierId).toBe(supX)
    expect(a!.verdict).toBe('RECOMMEND')
    const watch = (b.watch ?? []) as Array<Record<string, unknown>>
    const wb = watch.find((x) => x.itemId === itemB)
    expect(wb).toBeDefined()
    expect((wb!.flags as Record<string, unknown>).noHistory).toBe(true)
    const summary = (b.summary ?? {}) as Record<string, unknown>
    expect(summary.windowDays).toBe(28)
    expect(summary.reviewDays).toBe(7)
    const groups = (b.groupedBySupplier ?? []) as Array<Record<string, unknown>>
    expect(groups.length).toBeGreaterThan(0)
    const g = groups.find((x) => x.supplierId === supX)
    expect(g).toBeDefined()
    expect(g!.total).toBe(24)
  })

  it('B2. ?days=7: krajše okno → višja dnevna poraba', async () => {
    const r = await recsGET(req('GET', '/api/purchase-orders/recommendations?days=7', tokA))
    expect(r.status).toBe(200)
    const b = await body(r)
    const a = ((b.recommendations ?? []) as Array<Record<string, unknown>>).find((x) => x.itemId === itemA)
    expect(a).toBeDefined()
    expect(a!.avgDailyUse).toBe(4) // −28 / 7 dni
    // target 45 − 6 − 4 = 35 → ceil(35/5) = 7 paketov = 35 kg, ocena 84
    expect(a!.needQty).toBe(35)
    expect(a!.suggestedPacks).toBe(7)
    expect(a!.suggestedQty).toBe(35)
    expect(a!.estCost).toBe(84)
  })

  it('B3. validacija parametrov: days=0 in reviewDays=0 → 400', async () => {
    const r1 = await recsGET(req('GET', '/api/purchase-orders/recommendations?days=0', tokA))
    expect(r1.status).toBe(400)
    const r2 = await recsGET(req('GET', '/api/purchase-orders/recommendations?reviewDays=0', tokA))
    expect(r2.status).toBe(400)
  })

  it('B4. brez žetona → 401', async () => {
    const r = await recsGET(req('GET', '/api/purchase-orders/recommendations', ''))
    expect(r.status).toBe(401)
  })

  it('B5. requireAuth: staff (brez inventory.manage) lahko bere', async () => {
    const r = await recsGET(req('GET', '/api/purchase-orders/recommendations', tokStaff))
    expect(r.status).toBe(200)
    const b = await body(r)
    const ids = [
      ...((b.recommendations ?? []) as Array<Record<string, unknown>>),
      ...((b.watch ?? []) as Array<Record<string, unknown>>),
    ].map((x) => x.itemId)
    expect(ids).toContain(itemA)
  })

  it('B6. lokacijski obseg: manager A ne vidi locB; manager B vidi; param se ignorira', async () => {
    const rA = await recsGET(req('GET', '/api/purchase-orders/recommendations?locationId=' + locB, tokA))
    expect(rA.status).toBe(200)
    const bA = await body(rA)
    const idsA = [
      ...((bA.recommendations ?? []) as Array<Record<string, unknown>>),
      ...((bA.watch ?? []) as Array<Record<string, unknown>>),
    ].map((x) => x.itemId)
    expect(idsA).not.toContain(itemC) // fail-closed: lokalna vloga ignorira param
    expect(idsA).toContain(itemA)

    const rB = await recsGET(req('GET', '/api/purchase-orders/recommendations', tokB))
    const bB = await body(rB)
    const idsB = [
      ...((bB.recommendations ?? []) as Array<Record<string, unknown>>),
      ...((bB.watch ?? []) as Array<Record<string, unknown>>),
    ].map((x) => x.itemId)
    expect(idsB).toContain(itemC)
    expect(idsB).not.toContain(itemA)
  })

  it('B7. centralni admin z locationId parametrom vidi ciljno lokacijo', async () => {
    const r = await recsGET(req('GET', '/api/purchase-orders/recommendations?locationId=' + locA, tokAdmin))
    expect(r.status).toBe(200)
    const b = await body(r)
    const ids = [
      ...((b.recommendations ?? []) as Array<Record<string, unknown>>),
      ...((b.watch ?? []) as Array<Record<string, unknown>>),
    ].map((x) => x.itemId)
    expect(ids).toContain(itemA)
    expect(ids).not.toContain(itemC)
  })
})

/* ═══════════════════ C. POST /api/purchase-orders/recommendations/apply ═══════════════════ */

describe('issue #12 — POST apply (osnutek PO iz priporočil)', () => {
  it('C1. srečna pot: paketi × packQty, cena iz SupplierItem, centne vsote, revizija', async () => {
    const r = await applyPOST(req('POST', '/api/purchase-orders/recommendations/apply', tokA, {
      supplierId: supX,
      notes: 'test-note',
      lines: [{ inventoryItemId: itemA, packs: 3 }],
    }))
    expect(r.status).toBe(201)
    const b = await body(r)
    const order = (b.order ?? {}) as Record<string, unknown>
    expect(order.status).toBe('draft')
    expect(String(order.poNumber)).toMatch(/^PO-\d{8}-\d{4}$/)
    const items = (order.items ?? []) as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    const l = items[0]
    expect(l.inventoryItemId).toBe(itemA)
    expect(l.quantityOrdered).toBe(15) // 3 paketi × 5
    expect(l.unitPrice).toBe(2.4) // 12 € / paket ÷ 5
    expect(l.vatRate).toBe(9.5)
    expect(l.packQty).toBe(5)
    expect(l.packUnit).toBe('paket')
    // 15 × 2.4 = 36.00 neto; DDV 9.5 % = 3.42; skupaj 39.42 (centno natančno)
    expect(order.subtotal).toBe(36)
    expect(order.vatAmount).toBe(3.42)
    expect(order.totalAmount).toBe(39.42)
    // revizija: PO_CREATE s source:recommendation + lokacijo (za čiščenje)
    const audit = await db.auditLog.findFirst({
      where: { entityType: 'PurchaseOrder', entityId: String(order.id), action: 'PO_CREATE' },
    })
    expect(audit).not.toBeNull()
    const details = JSON.parse(String(audit!.details)) as Record<string, unknown>
    expect(details.source).toBe('recommendation')
    expect(audit!.locationId).toBe(locA)
  })

  it('C2. OSNUTEK ni potrjena dobava; po oddaji priporočilo izgine (→ WATCH)', async () => {
    // osnutek iz C1: itemA še vedno priporočen (draft se NE šteje v prihajajoče)
    const before = await body(await recsGET(req('GET', '/api/purchase-orders/recommendations', tokA)))
    const stillRec = ((before.recommendations ?? []) as Array<Record<string, unknown>>).find((x) => x.itemId === itemA)
    expect(stillRec).toBeDefined()
    expect(stillRec!.incoming).toBe(4)

    // oddaj osnutek → postane POTRJENA dobava v teku
    const poId = await db.purchaseOrder.findFirst({
      where: { locationId: locA, requestedById: mgrA, notes: 'test-note' },
      select: { id: true },
    })
    expect(poId).not.toBeNull()
    const submit = await poPATCH(
      req('PATCH', `/api/purchase-orders/${poId!.id}`, tokA, { action: 'submit' }),
      { params: Promise.resolve({ id: poId!.id }) },
    )
    expect(submit.status).toBe(200)

    const after = await body(await recsGET(req('GET', '/api/purchase-orders/recommendations', tokA)))
    const rec = ((after.recommendations ?? []) as Array<Record<string, unknown>>).find((x) => x.itemId === itemA)
    expect(rec).toBeUndefined() // 15 − 6 − 19 < 0 → pokrito
    const watch = ((after.watch ?? []) as Array<Record<string, unknown>>).find((x) => x.itemId === itemA)
    expect(watch).toBeDefined() // pod pragom (6 ≤ 10) → WATCH
  })

  it('C3. avtorizacija: 401 brez žetona, 403 staff, 404 neznani dobavitelj', async () => {
    const r1 = await applyPOST(req('POST', '/api/purchase-orders/recommendations/apply', '', { supplierId: supX, lines: [{ inventoryItemId: itemA, packs: 1 }] }))
    expect(r1.status).toBe(401)
    const r2 = await applyPOST(req('POST', '/api/purchase-orders/recommendations/apply', tokStaff, { supplierId: supX, lines: [{ inventoryItemId: itemA, packs: 1 }] }))
    expect(r2.status).toBe(403)
    const r3 = await applyPOST(req('POST', '/api/purchase-orders/recommendations/apply', tokA, { supplierId: `${P}ne-obstaja-${RUN}`, lines: [{ inventoryItemId: itemA, packs: 1 }] }))
    expect(r3.status).toBe(404)
  })

  it('C4. validacije: prazne vrstice, packs 0 / 2.5, podvojen artikel, neobstoječi artikel → 400', async () => {
    const cases: Array<Record<string, unknown>> = [
      { supplierId: supX, lines: [] },
      { supplierId: supX, lines: [{ inventoryItemId: itemA, packs: 0 }] },
      { supplierId: supX, lines: [{ inventoryItemId: itemA, packs: 2.5 }] },
      { supplierId: supX, lines: [{ inventoryItemId: itemA, packs: 1 }, { inventoryItemId: itemA, packs: 1 }] },
      { supplierId: supX, lines: [{ inventoryItemId: `${P}ne-obstaja-${RUN}`, packs: 1 }] },
      { supplierId: supX, lines: [{ packs: 1 }] },
    ]
    for (const c of cases) {
      const r = await applyPOST(req('POST', '/api/purchase-orders/recommendations/apply', tokA, c))
      expect(r.status).toBe(400)
    }
  })

  it('C5. obseg: artikel tuje lokacije → 403; lokacija naročila odstopa → 403', async () => {
    const r1 = await applyPOST(req('POST', '/api/purchase-orders/recommendations/apply', tokA, {
      supplierId: supX, lines: [{ inventoryItemId: itemC, packs: 1 }],
    }))
    expect(r1.status).toBe(403)
    const r2 = await applyPOST(req('POST', '/api/purchase-orders/recommendations/apply', tokA, {
      supplierId: supX, locationId: locB, lines: [{ inventoryItemId: itemA, packs: 1 }],
    }))
    expect(r2.status).toBe(403)
  })

  it('C6. SupplierItem backfill: artikel brez kataloga dobi vezavo s ceno na paket', async () => {
    const existing = await db.supplierItem.findUnique({
      where: { supplierId_inventoryItemId: { supplierId: supX, inventoryItemId: itemD } },
    })
    expect(existing).toBeNull()
    const r = await applyPOST(req('POST', '/api/purchase-orders/recommendations/apply', tokA, {
      supplierId: supX,
      lines: [{ inventoryItemId: itemD, packs: 2 }],
    }))
    expect(r.status).toBe(201)
    const b = await body(r)
    const l = ((b.order ?? {}) as Record<string, unknown>).items as Array<Record<string, unknown>>
    // brez kataloga: packQty 1, cena = costPerUnit 3, DDV 22
    expect(l[0].quantityOrdered).toBe(2)
    expect(l[0].unitPrice).toBe(3)
    expect(l[0].vatRate).toBe(22)
    const backfilled = await db.supplierItem.findUnique({
      where: { supplierId_inventoryItemId: { supplierId: supX, inventoryItemId: itemD } },
    })
    expect(backfilled).not.toBeNull()
    expect(Number(backfilled!.packQty)).toBe(1)
    expect(Number(backfilled!.pricePerPack)).toBe(3) // 3 €/enota × 1 paket
  })
})
