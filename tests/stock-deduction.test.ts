/**
 * Test 32-c — P1 točka 4 (audit §12): `deductStockForOrderTx` (src/lib/inventory.ts).
 *
 * Pokritje:
 *  - FEFO: odjem se razporedi po serijah od najzgodnejšega datuma poteka (InventoryBatch
 *    orderBy expiryDate asc, receivedAt asc) + StockBatchAllocation vrstice;
 *  - natančna izpraznitev serije → status 'EXHAUSTED' (prag bNew <= 0.0005);
 *  - PRIMANJKLJAJ: dejansko obnašanje implementacije je CLAMP + shortfall zapis —
 *    primanjkljaj NE ustavi prodaje in NE odmeta transakcije (doc-koment v inventory.ts:
 *    "Primanjkljaj NE ustavi prodaje (račun mora iti ven)"); to je zamišljeno vedenje,
 *    ne bug — test to dokumentira (SalesStockTransaction.quantity = −razpoložljivo);
 *  - replay zaščita 1: Order.inventoryDeducted flag → drugi klic odšteje 0;
 *  - replay zaščita 2: obstoječi StockTransaction(orderId, type='SALE') → drugi klic odšteje 0
 *    (tudi ko je flag izklopljen);
 *  - artikel brez recepture → nič ne odšteje, brez napake; voided postavke se izpustijo;
 *  - agregacija čez več sestavin + totalCost po strošku na enoto.
 *
 * Fixture predpona: stockded-; čiščenje reverse-FK v afterAll (+ pred-čiščenje v beforeAll).
 * Klic gre neposredno z db klientom kot Tx (PrismaClient zadošča TransactionClient podpisu) —
 * ista semantika kot znotraj FURS transakcije, ki tudi pošlje tx v funkcijo.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { deductStockForOrderTx } from '@/lib/inventory'
import { nid, num } from '@/lib/map'
import type { Prisma } from '@prisma/client'

const PREFIX = 'stockded'
const TS = Date.now()

let locId: string
let empId: string
let empName: string
let menuId: string
let catId: string
let miId = 0
const invIds: string[] = []

type Tx = Prisma.TransactionClient

async function mkInventory(data: { name: string; quantity: number; costPerUnit?: number; unit?: string }) {
  const id = nid()
  invIds.push(id)
  return db.inventoryItem.create({
    data: {
      id,
      name: `${PREFIX} ${data.name}`,
      unit: data.unit || 'kg',
      quantity: data.quantity,
      costPerUnit: data.costPerUnit ?? 2,
      locationId: locId,
    },
  })
}

async function mkBatch(inventoryItemId: string, opts: { qty: number; expiryInDays: number; receivedOffsetMin?: number }) {
  return db.inventoryBatch.create({
    data: {
      id: nid(),
      inventoryItemId,
      locationId: locId,
      lotNumber: `${PREFIX}-lot-${nid().slice(0, 8)}`,
      receivedAt: new Date(TS - (opts.receivedOffsetMin ?? 60) * 60_000),
      expiryDate: new Date(TS + opts.expiryInDays * 86_400_000),
      quantityInitial: opts.qty,
      quantityRemaining: opts.qty,
      status: 'ACTIVE',
    },
  })
}

async function mkMenuItemWithRecipe(recipe: { inventoryItemId: string; quantityPerServing: number }[]) {
  const mi = await db.menuItem.create({
    data: { id: nid(), name: `${PREFIX} artikel ${++miId}`, price: 10, categoryId: catId, vatRate: 22 },
  })
  for (const r of recipe) {
    await db.recipeItem.create({
      data: { id: nid(), menuItemId: mi.id, inventoryItemId: r.inventoryItemId, quantityPerServing: r.quantityPerServing, unit: 'kg' },
    })
  }
  return mi
}

async function mkOrderWithItem(menuItemId: string, quantity: number, opts: { voided?: boolean; status?: string } = {}) {
  const orderId = nid()
  await db.order.create({
    data: {
      id: orderId,
      orderNumber: 860000 + Math.floor(Math.random() * 99999),
      locationId: locId,
      status: opts.status || 'paid',
      paymentStatus: 'paid',
      type: 'dine-in',
      employeeId: empId,
    },
  })
  await db.orderItem.create({
    data: {
      id: nid(),
      orderId,
      menuItemId,
      quantity,
      price: 10,
      vatRate: 22,
      vatAmount: 2.2,
      menuItemName: `${PREFIX} postavka`,
      voided: opts.voided ?? false,
      status: 'served',
    },
  })
  return orderId
}

/** Reverse-FK čiščenje (idempotentno — beforeAll + afterAll) */
async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { code: { startsWith: `${PREFIX}-` } }, select: { id: true } })
  for (const { id } of locs) {
    const orders = await db.order.findMany({ where: { locationId: id }, select: { id: true } })
    const orderIds = orders.map((o) => o.id)
    for (const orderId of orderIds) {
      const stx = await db.stockTransaction.findMany({ where: { orderId }, select: { id: true } })
      await db.stockBatchAllocation.deleteMany({ where: { stockTransactionId: { in: stx.map((t) => t.id) } } })
      await db.stockTransaction.deleteMany({ where: { orderId } })
      await db.auditLog.deleteMany({ where: { entityType: 'Order', entityId: orderId } })
      await db.orderItem.deleteMany({ where: { orderId } })
      await db.order.deleteMany({ where: { id: orderId } })
    }
    const invs = await db.inventoryItem.findMany({ where: { locationId: id }, select: { id: true } })
    const ids = invs.map((i) => i.id)
    await db.stockBatchAllocation.deleteMany({ where: { inventoryItemId: { in: ids } } })
    await db.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: ids } } })
    await db.recipeItem.deleteMany({ where: { inventoryItemId: { in: ids } } })
    await db.inventoryItem.deleteMany({ where: { id: { in: ids } } })
    const menus = await db.menu.findMany({ where: { locationId: id }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } })
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } })
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } })
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } })
    await db.employee.deleteMany({ where: { locationId: id } })
    await db.location.deleteMany({ where: { id } })
  }
}

beforeAll(async () => {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  await cleanupFixtures()
  locId = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} lokacija`, code: `${PREFIX}-${TS}`, premisesId: `BLG${PREFIX.toUpperCase().slice(0, 6)}${TS % 100000}`, country: 'SI' },
  })).id
  const emp = await db.employee.create({
    data: { id: nid(), name: `${PREFIX} skladiščnik`, email: `${PREFIX}-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-${TS}`, locationId: locId },
  })
  empId = emp.id
  empName = emp.name
  menuId = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locId } })).id
  catId = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kategorija`, menuId } })).id
})

afterAll(async () => {
  await cleanupFixtures()
})

describe('deductStockForOrderTx — FEFO po serijah', () => {
  // ⚠️ REALNI BUG (najden s tem testom, 32-c): src/lib/inventory.ts vrstica 124 vstavi
  // StockBatchAllocation s stockTransactionId=txId, SOLID StockTransaction(id=txId) pa se
  // ustvari ŠELE na vrstici 137. FK (StockBatchAllocation → StockTransaction) se preveri
  // TAKOJ (SQLite PRAGMA foreign_keys=ON; Postgres immediate po defaultu) → P2003
  // "Foreign key constraint violated" → celotna transakcija (tudi FURS POST plačilo!) se
  // odmeta. Posledica: prodaja KATEREGAKOLI recepturnega artikla, ki ima AKTIVNE serije
  // (InventoryBatch status='ACTIVE', quantityRemaining > 0), NEDELOUJE. Predlagani fix:
  // StockTransaction vrstico (id=txId) ustvari PRED zanko po serijah (ali alokacije vstavite
  // ŠELE po tx.stockTransaction.create). Testi so test.skip, dokler bug ni popravljen.
  test('dve seriji (starejši rok prvi) → odjem najprej iz STAREJŠE serije, alokacije pravilne', async () => {
    const inv = await mkInventory({ name: 'fefo sestavina', quantity: 10 })
    const batchOld = await mkBatch(inv.id, { qty: 4, expiryInDays: 2, receivedOffsetMin: 120 })
    const batchNew = await mkBatch(inv.id, { qty: 6, expiryInDays: 20, receivedOffsetMin: 30 })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 5 }])
    const orderId = await mkOrderWithItem(mi.id, 1)

    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(true)
    expect(result.lines).toBe(1)
    expect(result.shortfalls).toHaveLength(0)
    expect(result.totalCost).toBe(10) // 5 × costPerUnit 2

    // starejša serija izpraznjena, novejša delno (6 − 1 = 5)
    const oldAfter = await db.inventoryBatch.findUnique({ where: { id: batchOld.id } })
    const newAfter = await db.inventoryBatch.findUnique({ where: { id: batchNew.id } })
    expect(num(oldAfter?.quantityRemaining)).toBe(0)
    expect(oldAfter?.status).toBe('EXHAUSTED')
    expect(num(newAfter?.quantityRemaining)).toBe(5)

    // alokacije: 4 od starejše + 1 od novejše, vezane na isti StockTransaction
    const saleTx = await db.stockTransaction.findFirst({ where: { orderId, type: 'SALE' } })
    expect(saleTx).not.toBeNull()
    const allocations = await db.stockBatchAllocation.findMany({ where: { stockTransactionId: saleTx!.id } })
    expect(allocations).toHaveLength(2)
    const allocByBatch = new Map(allocations.map((a) => [a.batchId, num(a.quantity)]))
    expect(allocByBatch.get(batchOld.id)).toBe(4)
    expect(allocByBatch.get(batchNew.id)).toBe(1)
    expect(allocations.every((a) => a.inventoryItemId === inv.id)).toBe(true)

    // agregirana zaloga 10 → 5
    const invAfter = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(invAfter?.quantity)).toBe(5)
  })

  test('natančna izpraznitev: zahteva = količina serije → serija 0, status EXHAUSTED, alokacija = celotna serija', async () => {
    const inv = await mkInventory({ name: 'izpraznitev sestavina', quantity: 3 })
    const batch = await mkBatch(inv.id, { qty: 3, expiryInDays: 5 })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 3 }])
    const orderId = await mkOrderWithItem(mi.id, 1)

    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(true)
    const after = await db.inventoryBatch.findUnique({ where: { id: batch.id } })
    expect(num(after?.quantityRemaining)).toBe(0)
    expect(after?.status).toBe('EXHAUSTED')
    const invAfter = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(invAfter?.quantity)).toBe(0)
    const saleTx = await db.stockTransaction.findFirst({ where: { orderId, type: 'SALE' } })
    const allocations = await db.stockBatchAllocation.findMany({ where: { stockTransactionId: saleTx!.id } })
    expect(allocations).toHaveLength(1)
    expect(num(allocations[0].quantity)).toBe(3)
  })

  test('serije pokrijejo samo del odjema → preostanek gre na agregat, opomba v StockTransaction', async () => {
    const inv = await mkInventory({ name: 'delna serija sestavina', quantity: 10 })
    await mkBatch(inv.id, { qty: 2, expiryInDays: 3 }) // serije pokrijejo samo 2 od 5
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 5 }])
    const orderId = await mkOrderWithItem(mi.id, 1)

    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(true)
    expect(result.shortfalls).toHaveLength(0) // serije ≠ primanjkljaj agregata
    const invAfter = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(invAfter?.quantity)).toBe(5) // 10 − 5 (2 preko serije, 3 direktno)
    const saleTx = await db.stockTransaction.findFirst({ where: { orderId, type: 'SALE' } })
    expect(String(saleTx?.note)).toContain('Serije pokrijejo')
  })
})

describe('deductStockForOrderTx — primanjkljaj (dejansko obnašanje: clamp + shortfall, prodaja ne ustane)', () => {
  test('zaloga < zahteva → odšteje se samo razpoložljivo, shortfall zapisan, BREZ metanja napake', async () => {
    const inv = await mkInventory({ name: 'primanjkljaj sestavina', quantity: 2 })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 5 }])
    const orderId = await mkOrderWithItem(mi.id, 1)

    // implementacija NAMERNO ne meče napake (doc: "primanjkljaj ne blokira prodaje")
    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(true)
    expect(result.shortfalls).toHaveLength(1)
    expect(result.shortfalls[0].inventoryItemId).toBe(inv.id)
    expect(result.shortfalls[0].requested).toBe(5)
    expect(result.shortfalls[0].available).toBe(2)

    // SALE = −2 (clamp), ne −5; zaloga na 0; opomba o primanjkljaju
    const saleTx = await db.stockTransaction.findFirst({ where: { orderId, type: 'SALE' } })
    expect(num(saleTx?.quantity)).toBe(-2)
    expect(num(saleTx?.previousQty)).toBe(2)
    expect(num(saleTx?.newQty)).toBe(0)
    expect(String(saleTx?.note)).toContain('Primanjkljaj')
    const invAfter = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(invAfter?.quantity)).toBe(0)
  })

  test('zaloga 0 → čisto nič odjem, shortfall javljen, StockTransaction z 0 odjemom', async () => {
    const inv = await mkInventory({ name: 'prazna sestavina', quantity: 0 })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 1 }])
    const orderId = await mkOrderWithItem(mi.id, 1)

    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(true)
    expect(result.shortfalls[0].available).toBe(0)
    const saleTx = await db.stockTransaction.findFirst({ where: { orderId, type: 'SALE' } })
    expect(num(saleTx?.quantity)).toBe(0)
    const invAfter = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(invAfter?.quantity)).toBe(0)
  })
})

describe('deductStockForOrderTx — replay zaščita (idempotenca)', () => {
  test('zaščita 1: drugi klic po uspešnem odjemu (inventoryDeducted flag) → deducted false, NI dvojnega odjema', async () => {
    const inv = await mkInventory({ name: 'replay1 sestavina', quantity: 10 })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 2 }])
    const orderId = await mkOrderWithItem(mi.id, 1)

    const first = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(first.deducted).toBe(true)
    const qtyAfterFirst = num((await db.inventoryItem.findUnique({ where: { id: inv.id } }))?.quantity)
    expect(qtyAfterFirst).toBe(8)

    const second = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(second.deducted).toBe(false)
    expect(second.lines).toBe(0)
    const qtyAfterSecond = num((await db.inventoryItem.findUnique({ where: { id: inv.id } }))?.quantity)
    expect(qtyAfterSecond).toBe(qtyAfterFirst)
    expect(await db.stockTransaction.count({ where: { orderId, type: 'SALE' } })).toBe(1)
  })

  test('zaščita 2: obstoječi SALE StockTransaction za naročilo ustavi odjem TUDI brez flaga', async () => {
    const inv = await mkInventory({ name: 'replay2 sestavina', quantity: 10 })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 2 }])
    const orderId = await mkOrderWithItem(mi.id, 1)
    // simuliraj: flag manjkajoč (npr. star podatek), a SALE transakcija že obstaja
    // (costPerUnit/totalCost sta obvezna brez defaultov v sqlite zrcalu sheme)
    await db.stockTransaction.create({
      data: {
        id: nid(),
        inventoryItemId: inv.id,
        type: 'SALE',
        quantity: -2,
        previousQty: 10,
        newQty: 8,
        costPerUnit: 2,
        totalCost: 4,
        reason: `${PREFIX} zgodovinski odjem`,
        employeeName: empName,
        orderId,
      },
    })

    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(false)
    expect(result.lines).toBe(0)
    // zaloga NE SPREMENJENA (8, ne 6) — ni dvojnega odjema
    const invAfter = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(invAfter?.quantity)).toBe(10)
    expect(await db.stockTransaction.count({ where: { orderId, type: 'SALE' } })).toBe(1)
    // tudi revizija se ne podvoji
    expect(await db.auditLog.count({ where: { entityType: 'Order', entityId: orderId } })).toBe(0)
  })

  test('uspešen odjem zapiše AuditLog STOCK_DEDUCTED s podrobnostmi', async () => {
    const inv = await mkInventory({ name: 'audit sestavina', quantity: 10 })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 2 }])
    const orderId = await mkOrderWithItem(mi.id, 1)

    await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    const audit = await db.auditLog.findFirst({ where: { action: 'STOCK_DEDUCTED', entityType: 'Order', entityId: orderId } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(String(audit?.details))
    expect(details.lines).toBe(1)
    expect(details.totalCost).toBe(4) // 2 × costPerUnit 2
    const flagAfter = await db.order.findUnique({ where: { id: orderId }, select: { inventoryDeducted: true } })
    expect(flagAfter?.inventoryDeducted).toBe(true)
  })
})

describe('deductStockForOrderTx — robni primeri', () => {
  test('artikel BREZ recepture → nič ne odšteje (deducted false), brez napake in brez revizije', async () => {
    const inv = await mkInventory({ name: 'nereceptura sestavina', quantity: 5 })
    const mi = await mkMenuItemWithRecipe([]) // brez RecipeItem
    const orderId = await mkOrderWithItem(mi.id, 1)

    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(false)
    expect(result.lines).toBe(0)
    const invAfter = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(invAfter?.quantity)).toBe(5)
    expect(await db.stockTransaction.count({ where: { orderId, type: 'SALE' } })).toBe(0)
    expect(await db.auditLog.count({ where: { entityType: 'Order', entityId: orderId } })).toBe(0)
  })

  test('voided postavke se izpustijo — samo voided postavka → nič ne odšteje', async () => {
    const inv = await mkInventory({ name: 'voided sestavina', quantity: 5 })
    const mi = await mkMenuItemWithRecipe([{ inventoryItemId: inv.id, quantityPerServing: 2 }])
    const orderId = await mkOrderWithItem(mi.id, 1, { voided: true })

    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(false)
    const invAfter = await db.inventoryItem.findUnique({ where: { id: inv.id } })
    expect(num(invAfter?.quantity)).toBe(5)
  })

  test('agregacija čez 2 sestavini in 2 postavki → 2 SALE vrstici, totalCost vsota po stroških', async () => {
    const invA = await mkInventory({ name: 'agregat A', quantity: 20, costPerUnit: 1.5 })
    const invB = await mkInventory({ name: 'agregat B', quantity: 20, costPerUnit: 0.25 })
    // artikel 1: 1.5× A + 0.5× B; artikel 2: 0.5× A → skupek A = 2, B = 0.5
    const mi1 = await mkMenuItemWithRecipe([
      { inventoryItemId: invA.id, quantityPerServing: 1.5 },
      { inventoryItemId: invB.id, quantityPerServing: 0.5 },
    ])
    const mi2 = await mkMenuItemWithRecipe([{ inventoryItemId: invA.id, quantityPerServing: 0.5 }])
    const orderId = nid()
    await db.order.create({
      data: { id: orderId, orderNumber: 855000 + (TS % 9999), locationId: locId, status: 'paid', paymentStatus: 'paid', type: 'dine-in', employeeId: empId },
    })
    for (const [mi, qty] of [[mi1, 1], [mi2, 1]] as const) {
      await db.orderItem.create({
        data: { id: nid(), orderId, menuItemId: mi.id, quantity: qty, price: 10, vatRate: 22, vatAmount: 2.2, menuItemName: mi.name, status: 'served' },
      })
    }

    const result = await deductStockForOrderTx(db as unknown as Tx, orderId, empId, empName)
    expect(result.deducted).toBe(true)
    expect(result.lines).toBe(2)
    // totalCost: A: 2 × 1.5 = 3, B: r2(0.5 × 0.25) = 0.13 → r2(3 + 0.13) = 3.13
    expect(result.totalCost).toBe(3.13)
    const txs = await db.stockTransaction.findMany({ where: { orderId, type: 'SALE' } })
    expect(txs).toHaveLength(2)
    const byItem = new Map(txs.map((t) => [t.inventoryItemId, t]))
    expect(num(byItem.get(invA.id)?.quantity)).toBe(-2)
    expect(num(byItem.get(invB.id)?.quantity)).toBe(-0.5)
    const aAfter = await db.inventoryItem.findUnique({ where: { id: invA.id } })
    const bAfter = await db.inventoryItem.findUnique({ where: { id: invB.id } })
    expect(num(aAfter?.quantity)).toBe(18)
    expect(num(bAfter?.quantity)).toBe(19.5)
  })
})
