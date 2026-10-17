/**
 * Testi fiskalnega storna računa (P1 točka 1 iz docs/RESTAURANTOS-AUDIT.md).
 *
 * DB-backed testi proti lokalni SQLite bazi (DATABASE_URL iz .env) — vse fiksture
 * z unikatnimi ID-ji s predpono `storno-test-` (izolacija od seed/E2E podatkov)
 * + popolno čiščenje v afterAll (obrnjen FK vrstni red).
 *
 * Pokrito:
 *  - happy path: storno račun z negativnimi zneski + negirana razčlenba DDV,
 *    order.paymentStatus='storno', povračilo zaloge (InventoryItem + serije
 *    vključno z EXHAUSTED→ACTIVE), preskočena manjkajoča serija (opomba),
 *    revizija RECEIPT_STORNO, Counter številčenje,
 *  - dvojni storno → 409, neplačano naročilo → 409, storno storna → 409,
 *    kopija → 409, neobstoječ račun → 404,
 *  - manjka dovoljenje receipts.storno → 403, tuja lokacija → 403.
 *
 * ISSUE #72 D1 (v1.133.0): storno varoval ključ receipts.storno (prej furs.issue)
 * — imajo ga ADMIN/OWNER/enterprise (tudi property_manager), MANAGER NE več.
 * Akter happy-path testov je zato property_manager (ne-centralen, a ima pravico —
 * cross-lokacijska varovalka ostane preizkušena).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken } from '@/lib/auth'
import { POST } from '../src/app/api/receipts/[id]/storno/route'

const P = 'storno-test-'
const nidp = (s: string) => `${P}${s}`

let locationId = ''
let locationBId = ''
let managerId = ''
let waiterId = ''
let itemIdA = ''
let itemIdB = ''
let batchA1 = ''
let batchB1 = ''

/** Zahteva POST na storno endpoint z žetonom zaposlenega. */
async function callStorno(receiptId: string, employeeId: string, role: string, loc: string | null) {
  const token = createToken({ sub: employeeId, name: 'Test Test', role, loc, sv: 0 })
  const req = new NextRequest('http://localhost/api/receipts/x/storno', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    // #19 (v1.107.0): storno zahteva razlog izjeme (politika, privzeto obvezen)
    body: JSON.stringify({ reason: 'testni storno razlog' }),
  })
  return POST(req, { params: Promise.resolve({ id: receiptId }) })
}

/** Ustvari naročilo + originalni račun (kot jih naredi /api/furs POST ob plačilu). */
async function seedPaidOrderWithReceipt(opts: {
  orderNumber: number
  receiptNumber: string
  paymentStatus: string
  isCopy?: boolean
  isStorno?: boolean
  locId?: string
}) {
  const locId = opts.locId || locationId
  const orderId = nidp(`order-${opts.orderNumber}`)
  const paymentStatus = opts.paymentStatus || 'paid'
  await db.order.create({
    data: {
      id: orderId,
      orderNumber: opts.orderNumber,
      status: 'paid',
      paymentStatus,
      paymentMethod: 'cash',
      subtotal: 45.5,
      tax: 8.2,
      discount: 0.5,
      tip: 1,
      total: 45,
      totalWithTip: 46,
      paidAt: new Date(),
      locationId: locId,
    },
  })
  const receiptId = nidp(`receipt-${opts.orderNumber}`)
  await db.receipt.create({
    data: {
      id: receiptId,
      receiptNumber: opts.receiptNumber,
      orderId,
      businessName: 'Test Lokacija d.o.o.',
      businessAddress: 'Testna cesta 1',
      businessId: '12345678',
      taxId: 'SI12345678',
      registerId: 'BLG-001',
      zoi: 'a'.repeat(32),
      eor: 'ORIG-EOR',
      fiscalVerified: true,
      fiscalStatus: 'verified',
      subtotal: 45.5,
      vatBreakdown: JSON.stringify({ '22.00': { base: 37.3, vat: 8.2 } }),
      totalVat: 8.2,
      discount: 0.5,
      total: 45,
      tip: 1,
      totalWithTip: 46,
      paymentMethod: 'cash',
      isCopy: opts.isCopy ?? false,
      isStorno: opts.isStorno ?? false,
      printedAt: new Date(),
      locationId: locId,
      cisStatus: 'none',
    },
  })
  return { orderId, receiptId }
}

/** SALE StockTransaction + alokacije serij (kot jih zapiše deductStockForOrderTx). */
async function seedSaleTx(opts: {
  orderId: string
  inventoryItemId: string
  prevQty: number
  deducted: number
  costPerUnit: number
  batchAllocs: { batchId: string; qty: number }[]
}) {
  const txId = nidp(`sale-${opts.inventoryItemId}-${opts.deducted}`)
  await db.stockTransaction.create({
    data: {
      id: txId,
      inventoryItemId: opts.inventoryItemId,
      type: 'SALE',
      quantity: -opts.deducted,
      previousQty: opts.prevQty,
      newQty: Math.round((opts.prevQty - opts.deducted) * 1000) / 1000,
      costPerUnit: opts.costPerUnit,
      totalCost: Math.round(opts.costPerUnit * opts.deducted * 100) / 100,
      reason: 'Razknjiževanje po recepturi (izdaja računa)',
      employeeName: 'Test Test',
      employeeId: managerId,
      orderId: opts.orderId,
    },
  })
  for (const a of opts.batchAllocs) {
    await db.stockBatchAllocation.create({
      data: {
        id: nidp(`alloc-${a.batchId}-${Math.random().toString(36).slice(2, 8)}`),
        batchId: a.batchId,
        stockTransactionId: txId,
        inventoryItemId: opts.inventoryItemId,
        quantity: a.qty,
      },
    })
  }
  return txId
}

beforeAll(async () => {
  // čiščenje morebitnih ostankov prejšnjega zasedenega teka (isti predponi)
  await cleanup()

  const loc = await db.location.create({
    data: {
      id: nidp('loc'),
      name: 'Test Lokacija',
      code: nidp('LQ'),
      premisesId: nidp('PRM'),
      country: 'SI',
      fursEnvironment: 'simulation',
      taxId: 'SI12345678',
    },
  })
  locationId = loc.id
  const locB = await db.location.create({
    data: {
      id: nidp('loc-b'),
      name: 'Tuja Lokacija',
      code: nidp('LB'),
      premisesId: nidp('PRM-B'),
      country: 'SI',
      fursEnvironment: 'simulation',
    },
  })
  locationBId = locB.id

  const mgr = await db.employee.create({
    data: {
      id: nidp('mgr'),
      name: 'Test Vodja',
      email: nidp('mgr') + '@example.com',
      role: 'property_manager',
      status: 'active',
      sessionVersion: 0,
      locationId,
      pin: nidp('pin-mgr'),
    },
  })
  managerId = mgr.id
  const wtr = await db.employee.create({
    data: {
      id: nidp('wtr'),
      name: 'Test Natakar',
      email: nidp('wtr') + '@example.com',
      role: 'waiter',
      status: 'active',
      sessionVersion: 0,
      locationId,
      pin: nidp('pin-wtr'),
    },
  })
  waiterId = wtr.id

  // Artikel A: 10 → SALE −0.2 → 9.8; serija A1 (5 → 4.8, še ACTIVE)
  const itemA = await db.inventoryItem.create({
    data: { id: nidp('item-a'), name: 'Moka', unit: 'kg', quantity: 9.8, costPerUnit: 2 },
  })
  itemIdA = itemA.id
  const bA1 = await db.inventoryBatch.create({
    data: {
      id: nidp('batch-a1'),
      inventoryItemId: itemIdA,
      lotNumber: 'A1',
      quantityInitial: 5,
      quantityRemaining: 4.8,
      unitCost: 2,
      status: 'ACTIVE',
    },
  })
  batchA1 = bA1.id

  // Artikel B: 5 → SALE −1.0 → 4.0; serija B1 izprodana (1 → 0, EXHAUSTED)
  const itemB = await db.inventoryItem.create({
    data: { id: nidp('item-b'), name: 'Sladkor', unit: 'kg', quantity: 4, costPerUnit: 1.1 },
  })
  itemIdB = itemB.id
  const bB1 = await db.inventoryBatch.create({
    data: {
      id: nidp('batch-b1'),
      inventoryItemId: itemIdB,
      lotNumber: 'B1',
      quantityInitial: 1,
      quantityRemaining: 0,
      unitCost: 1.1,
      status: 'EXHAUSTED',
    },
  })
  batchB1 = bB1.id
})

afterAll(async () => {
  // počakaj kratko, da detached publishEvent (StockChanged) zapiše/predela
  await new Promise((r) => setTimeout(r, 300))
  await cleanup()
})

async function cleanup() {
  // Task 58: počisti tudi ostanke crashanih tekov (širše kot predponski cleanup zgoraj)
  await sweepTestFixtures(db, [P])
  // Vse vrstice testov imajo predpono `storno-test-` (ali lokacijski scope) —
  // čiščenje je PREDPONSKO (ne izvedeno iz FK povezav), da prenese tudi ostanke
  // prejšnjega prekinjenega teka (npr. storno računi routе z naključnim id).
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: P } }, { locationId: { startsWith: P } }] } })
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: P } }, { id: { startsWith: P } }] } })
  await db.stockBatchAllocation.deleteMany({ where: { id: { startsWith: P } } })
  // SALE transakcije imajo predpono id; reversal transakcije routе naključen id + prefixed orderId
  await db.stockTransaction.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { orderId: { startsWith: P } }] } })
  await db.receipt.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { stornoOf: { startsWith: P } }] } })
  await db.order.deleteMany({ where: { id: { startsWith: P } } })
  await db.counter.deleteMany({ where: { name: { startsWith: `receipt:${P}` } } })
  await db.inventoryBatch.deleteMany({ where: { id: { startsWith: P } } })
  await db.inventoryItem.deleteMany({ where: { id: { startsWith: P } } })
  await db.employee.deleteMany({ where: { id: { startsWith: P } } })
  await db.location.deleteMany({ where: { id: { startsWith: P } } })
}

describe('fiskalni storno računa — happy path (P1 točka 1)', () => {
  let orderId = ''
  let receiptId = ''

  beforeAll(async () => {
    const seeded = await seedPaidOrderWithReceipt({ orderNumber: 9901, receiptNumber: '2026-1-9901-TEST' })
    orderId = seeded.orderId
    receiptId = seeded.receiptId
    await seedSaleTx({
      orderId,
      inventoryItemId: itemIdA,
      prevQty: 10,
      deducted: 0.2,
      costPerUnit: 2,
      batchAllocs: [{ batchId: batchA1, qty: 0.2 }],
    })
    await seedSaleTx({
      orderId,
      inventoryItemId: itemIdB,
      prevQty: 5,
      deducted: 1,
      costPerUnit: 1.1,
      batchAllocs: [{ batchId: batchB1, qty: 1 }],
    })
  })

  test('201: storno račun z negativnimi zneski + povračilo zaloge + revizija', async () => {
    const res = await callStorno(receiptId, managerId, 'PROPERTY_MANAGER', locationId)
    expect(res.status).toBe(201)
    const body = await res.json()

    // odgovor: negacija originala + povzetek
    expect(body.invoice.isStorno).toBe(true)
    expect(body.invoice.stornoOf).toBe(receiptId)
    expect(body.invoice.total).toBe(-45)
    expect(body.storno.originalReceiptNumber).toBe('2026-1-9901-TEST')
    expect(body.storno.restoredStockItems).toBe(2)
    expect(body.storno.simulation).toBe(true)
    expect(body.order.paymentStatus).toBe('storno')

    // DB: storno račun — exactna negacija + kopirani poslovni podatki
    const storno = await db.receipt.findUnique({ where: { id: body.invoice.id } })
    expect(storno).not.toBeNull()
    expect(storno!.isStorno).toBe(true)
    expect(storno!.stornoOf).toBe(receiptId)
    expect(storno!.orderId).toBe(orderId)
    expect(storno!.locationId).toBe(locationId)
    expect(storno!.paymentMethod).toBe('cash')
    expect(storno!.businessName).toBe('Test Lokacija d.o.o.')
    expect(storno!.businessAddress).toBe('Testna cesta 1')
    expect(storno!.taxId).toBe('SI12345678')
    expect(Number(storno!.subtotal)).toBe(-45.5)
    expect(Number(storno!.totalVat)).toBe(-8.2)
    expect(Number(storno!.discount)).toBe(-0.5)
    expect(Number(storno!.total)).toBe(-45)
    expect(Number(storno!.tip)).toBe(-1)
    expect(Number(storno!.totalWithTip)).toBe(-46)
    const vb = JSON.parse(String(storno!.vatBreakdown)) as Record<string, { base: number; vat: number }>
    expect(vb['22.00'].base).toBe(-37.3)
    expect(vb['22.00'].vat).toBe(-8.2)
    // fiskalna polja = replikacija /api/furs v simulaciji (NI izmišljene produkcije)
    expect(storno!.fiscalStatus).toBe('verified')
    expect(storno!.fiscalVerified).toBe(true)
    expect(storno!.zoi).toMatch(/^[0-9a-f]{32}$/)
    expect(storno!.eor).not.toBe('')
    expect(storno!.cisStatus).toBe('none')
    expect(storno!.receiptNumber).not.toBe('2026-1-9901-TEST')

    // DB: naročilo → paymentStatus 'storno' (CAS)
    const order = await db.order.findUnique({ where: { id: orderId } })
    expect(order!.paymentStatus).toBe('storno')

    // DB: zaloga povrnjena na stanje PRED razknjižbo
    const a = await db.inventoryItem.findUnique({ where: { id: itemIdA } })
    expect(Number(a!.quantity)).toBe(10) // 9.8 + 0.2
    const b = await db.inventoryItem.findUnique({ where: { id: itemIdB } })
    expect(Number(b!.quantity)).toBe(5) // 3.5 + 1.5

    // DB: serije povrnjene; izprodana (EXHAUSTED) spet ACTIVE; manjkajoča preskočena
    const ba = await db.inventoryBatch.findUnique({ where: { id: batchA1 } })
    expect(Number(ba!.quantityRemaining)).toBe(5) // 4.8 + 0.2
    expect(ba!.status).toBe('ACTIVE')
    const bb = await db.inventoryBatch.findUnique({ where: { id: batchB1 } })
    expect(Number(bb!.quantityRemaining)).toBe(1) // 0 + 1
    expect(bb!.status).toBe('ACTIVE')

    // DB: reversal transakcije — STORNO_RETURN, pozitivne, resničen par prev/new
    const revs = await db.stockTransaction.findMany({ where: { orderId, type: 'STORNO_RETURN' } })
    expect(revs.length).toBe(2)
    for (const r of revs) {
      expect(Number(r.quantity)).toBeGreaterThan(0)
      expect(r.reason).toContain('Storno računa')
      const delta = Math.round((Number(r.newQty) - Number(r.previousQty)) * 1000) / 1000
      expect(delta).toBe(Number(r.quantity))
    }
    const revB = revs.find((r) => r.inventoryItemId === itemIdB)
    expect(revB).toBeDefined()

    // DB: revizija RECEIPT_STORNO z lokacijo in detajli
    const audits = await db.auditLog.findMany({ where: { action: 'RECEIPT_STORNO', locationId } })
    expect(audits.length).toBe(1)
    const det = JSON.parse(audits[0].details || '{}') as Record<string, unknown>
    expect(det.originalReceiptId).toBe(receiptId)
    expect(det.stornoReceiptId).toBe(body.invoice.id)
    expect(det.orderId).toBe(orderId)
    expect(det.total).toBe(-45)
    expect(det.stockReversalCount).toBe(2)

    // DB: številčenje prek Counter (isti vzorec kot /api/furs)
    const counter = await db.counter.findUnique({ where: { name: `receipt:${locationId}` } })
    expect(counter).not.toBeNull()
    expect(counter!.value).toBeGreaterThanOrEqual(1)
  })

  test('dvojni storno → 409', async () => {
    const res = await callStorno(receiptId, managerId, 'PROPERTY_MANAGER', locationId)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(String(body.error)).toContain('storniran')
  })

  test('storno storna (isStorno) → 409', async () => {
    // storno račun iz happy patha poskusimo stornirati
    const stornoReceipt = await db.receipt.findFirst({ where: { stornoOf: receiptId } })
    expect(stornoReceipt).not.toBeNull()
    const res = await callStorno(stornoReceipt!.id, managerId, 'PROPERTY_MANAGER', locationId)
    expect(res.status).toBe(409)
  })
})

describe('fiskalni storno — varovalke (fail-closed)', () => {
  test('neplačano naročilo → 409', async () => {
    const { receiptId } = await seedPaidOrderWithReceipt({ orderNumber: 9902, receiptNumber: '2026-1-9902-TEST', paymentStatus: 'unpaid' })
    const res = await callStorno(receiptId, managerId, 'PROPERTY_MANAGER', locationId)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(String(body.error)).toContain('plačano')
  })

  test('kopija računa (isCopy) → 409', async () => {
    const { receiptId } = await seedPaidOrderWithReceipt({ orderNumber: 9903, receiptNumber: '2026-1-9903-TEST', paymentStatus: 'paid', isCopy: true })
    const res = await callStorno(receiptId, managerId, 'PROPERTY_MANAGER', locationId)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(String(body.error)).toContain('Kopije')
  })

  test('neobstoječ račun → 404', async () => {
    const res = await callStorno(nidp('ne-obstaja'), managerId, 'PROPERTY_MANAGER', locationId)
    expect(res.status).toBe(404)
  })

  test('manjka dovoljenje receipts.storno (waiter) → 403', async () => {
    const { receiptId } = await seedPaidOrderWithReceipt({ orderNumber: 9904, receiptNumber: '2026-1-9904-TEST', paymentStatus: 'paid' })
    const res = await callStorno(receiptId, waiterId, 'WAITER', locationId)
    expect(res.status).toBe(403)
    const body = await res.json()
    // issue #72 D1: ključ se imenuje receipts.storno (furs.issue odstranjen)
    expect(String(body.error)).toContain('receipts.storno')
    // stanje nespremenjeno (fail-closed)
    const order = await db.order.findUnique({ where: { id: orderIdOf(receiptId) } })
    expect(order!.paymentStatus).toBe('paid')
  })

  test('tuja lokacija (pm na lokaciji A, račun na lokaciji B) → 403', async () => {
    const { receiptId } = await seedPaidOrderWithReceipt({ orderNumber: 9905, receiptNumber: '2026-1-9905-TEST', paymentStatus: 'paid', locId: locationBId })
    const res = await callStorno(receiptId, managerId, 'PROPERTY_MANAGER', locationId)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(String(body.error).length).toBeGreaterThan(0)
  })

  test('storno že storniranega originala skozi drugo pot: obstoječ stornoOf → 409 (tudi brez "paid" preverbe)', async () => {
    // original + že obstoječ stornoOf zapis, naročilo še 'paid' (npr. ročno ponastavljeno)
    const { orderId, receiptId } = await seedPaidOrderWithReceipt({ orderNumber: 9906, receiptNumber: '2026-1-9906-TEST', paymentStatus: 'paid' })
    await db.receipt.create({
      data: {
        id: nidp('receipt-dup'),
        receiptNumber: '2026-1-9906-STORNO',
        orderId,
        businessName: 'Test Lokacija d.o.o.',
        businessAddress: 'Testna cesta 1',
        businessId: '12345678',
        taxId: 'SI12345678',
        subtotal: -45.5,
        totalVat: -8.2,
        total: -45,
        paymentMethod: 'cash',
        isStorno: true,
        stornoOf: receiptId,
        locationId,
      },
    })
    const res = await callStorno(receiptId, managerId, 'PROPERTY_MANAGER', locationId)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(String(body.error)).toContain('storniran')
  })
})

/** Poišči orderId za dani testni račun (pomožnik za asercije stanja). */
function orderIdOf(receiptId: string): string {
  return receiptId.replace('receipt-', 'order-')
}
