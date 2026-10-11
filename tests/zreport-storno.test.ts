/**
 * Task 63 — storno celovitost v Z-poročilu (POST /api/shifts action='stop').
 *
 * Ozadje (doc-truth + realna vrzel): fiskalni storno račun obstaja od Task 31-a
 * (POST /api/receipts/[id]/storno, 9 testov v receipt-storno.test.ts), a je Z-poročilo
 * storno računov NE obravnavalo:
 *   - ZReport.totalStorno (polje v shemi) ni bilo NIKOLI zapisano (vedno default 0),
 *   - totalOrders je štel tudi storno račune (storno NI naročilo),
 *   - totalGuests je podvajal goste (original + storno istega naročila),
 *   - avgOrderValue je delil s številom vseh računov (vključno s storno).
 *
 * Konvencija po Task 63 (dokumentirana v shifts/route.ts):
 *   - NETO vsote (totalSales, totalTax, načini plačila, dineIn/vedri, DDV razčlenba)
 *     VKLJUČUJEJO storno negacije — pravilno po FURS (vsak izdani račun, tudi storno,
 *     prispeva k dnevnemu prometu),
 *   - ŠTEVCI (totalOrders, totalGuests, avgOrderValue) izključujejo storno,
 *   - totalStorno = absolutna vsota storno zneskov v oknu izmene.
 *
 * Test teče skozi PRAVE rute: odpreti izmeno (shifts POST) → zasejati 2 plačani
 * naročili z originalnima računoma → PRAVI storno POST na račun 1 → zaključiti izmeno
 * (shifts POST stop) → prebrati ZReport iz baze in preveriti vsa polja.
 *
 * Fixture predpona: zst63- (TEST_PREFIXES + lastno čiščenje po code predponi v afterAll,
 * ker lokacija/uporabniki nosijo nid() id-je — Field sweep jih ne najde po id).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { nid, num } from '@/lib/map'
import { POST as shiftsPOST } from '../src/app/api/shifts/route'
import { POST as stornoPOST } from '../src/app/api/receipts/[id]/storno/route'

const PREFIX = 'zst63'
const TS = Date.now()

let locId: string
let empId: string
let shiftId: string
let receipt1Id = ''
let receipt2Id = ''
let original1Total = 45
let original2Total = 20

/** shifts POST zahteva z žetonom zaposlenega. */
async function callShifts(body: Record<string, unknown>, employeeId: string, role: string) {
  const token = createToken({ sub: employeeId, name: `${PREFIX} natakar`, role, loc: locId, sv: 0 })
  const req = new NextRequest('http://localhost/api/shifts', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return shiftsPOST(req)
}

/** storno POST zahteva z žetonom (manager — furs.issue). */
async function callStorno(receiptId: string, employeeId: string, role: string) {
  const token = createToken({ sub: employeeId, name: `${PREFIX} vodja`, role, loc: locId, sv: 0 })
  const req = new NextRequest('http://localhost/api/receipts/x/storno', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  return stornoPOST(req, { params: Promise.resolve({ id: receiptId }) })
}

/** Plačano naročilo + originalni fiskalni račun (isti oblikovalni vzorec kot /api/furs POST). */
async function seedPaidOrderWithReceipt(n: number, total: number, splitCount: number) {
  const orderId = nid()
  await db.order.create({
    data: {
      id: orderId,
      orderNumber: 900000 + TS % 100000 + n,
      status: 'paid',
      paymentStatus: 'paid',
      paymentMethod: 'cash',
      subtotal: total,
      tax: 0,
      discount: 0,
      tip: 0,
      total,
      totalWithTip: total,
      paidAt: new Date(),
      locationId: locId,
      splitCount,
    },
  })
  const receiptId = nid()
  await db.receipt.create({
    data: {
      id: receiptId,
      receiptNumber: `2026-10-${TS % 100000 + n}-BLGZST63`,
      orderId,
      businessName: `${PREFIX} lokacija`,
      businessAddress: 'Testna cesta 1',
      businessId: '12345678',
      taxId: 'SI12345678',
      registerId: 'BLG-001',
      total,
      totalVat: 0,
      subtotal: total,
      vatBreakdown: JSON.stringify({ '22.00': { base: total, vat: 0 } }),
      paymentMethod: 'cash',
      isStorno: false,
      locationId: locId,
    },
  })
  return { orderId, receiptId }
}

async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { code: { startsWith: `${PREFIX}-` } }, select: { id: true } })
  for (const { id } of locs) {
    const shiftIds = (await db.cashRegisterShift.findMany({ where: { locationId: id }, select: { id: true } })).map((s) => s.id)
    await db.zReport.deleteMany({ where: { locationId: id } })
    await db.auditLog.deleteMany({ where: { locationId: id } })
    await db.cashRegisterShift.deleteMany({ where: { id: { in: shiftIds } } })
    await db.counter.deleteMany({ where: { name: `receipt:${id}` } })
    const orders = await db.order.findMany({ where: { locationId: id }, select: { id: true } })
    for (const o of orders) {
      await db.receipt.deleteMany({ where: { orderId: o.id } })
      await db.orderItem.deleteMany({ where: { orderId: o.id } })
      await db.order.deleteMany({ where: { id: o.id } })
    }
    await db.employee.deleteMany({ where: { locationId: id } })
    await db.location.deleteMany({ where: { id } })
  }
}

beforeAll(async () => {
  // Task 58 disciplina: pre-čiščenje ostankov crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  await cleanupFixtures()
  locId = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} lokacija`, code: `${PREFIX}-${TS}`, premisesId: `BLGZST${TS % 1000000}`, country: 'SI' },
  })).id
  empId = (await db.employee.create({
    data: { id: nid(), name: `${PREFIX} natakar`, email: `${PREFIX}-${TS}@test.local`, role: 'manager', pin: `${PREFIX}-pin-${TS}`, locationId: locId },
  })).id
})

afterAll(async () => {
  await cleanupFixtures()
  await sweepTestFixtures(db, [PREFIX])
})

describe('Task 63: storno v Z-poročilu (totalStorno + čisti števci)', () => {
  test('storno račun: neto vsote vključujejo negacijo, števci izključujejo storno', async () => {
    // 1. Odpremo izmeno (prava ruta)
    const openRes = await callShifts({ openingCash: 100 }, empId, 'MANAGER')
    expect(openRes.status).toBe(201)
    const openBody = await openRes.json()
    shiftId = openBody.shift.id

    // 2. Dva plačana originala (gostje: 2 + 3 = 5)
    const seeded1 = await seedPaidOrderWithReceipt(1, original1Total, 2)
    const seeded2 = await seedPaidOrderWithReceipt(2, original2Total, 3)
    receipt1Id = seeded1.receiptId
    receipt2Id = seeded2.receiptId

    // 3. PRAVI storno prvega računa (prava ruta) — ustvari negacijo v istem oknu
    const stRes = await callStorno(receipt1Id, empId, 'MANAGER')
    expect(stRes.status).toBe(201)
    const stBody = await stRes.json()
    expect(stBody.storno.originalReceiptId).toBe(receipt1Id)
    const stornoNumber = Math.abs(num(stBody.invoice.total))
    expect(stornoNumber).toBe(original1Total)

    // 4. Zaključek izmene (prava ruta)
    const stopRes = await callShifts({ action: 'stop', closingCash: 100 }, empId, 'MANAGER')
    expect(stopRes.status).toBe(200)
    const stopBody = await stopRes.json()

    // 5. Odgovor: totalStorno v zReport objektu; receipts = doslovno število računov
    expect(stopBody.zReport.totalStorno).toBe(original1Total)
    expect(stopBody.zReport.receipts).toBe(3) // 2 originala + 1 storno (doslovno število računov)

    // 6. ZReport v bazi — vsa Task 63 pravila
    const zr = await db.zReport.findUnique({ where: { id: stopBody.zReport.id } })
    expect(zr).toBeTruthy()
    // NETO vsote: 45 + 20 - 45 = 20 (storno negacija vključena)
    expect(num(zr!.totalSales)).toBe(20)
    // ŠTEVCI: samo originali (storno NI naročilo)
    expect(zr!.totalOrders).toBe(2)
    expect(zr!.totalGuests).toBe(5) // 2 + 3, brez podvojitve prek storna
    expect(num(zr!.avgOrderValue)).toBe(10) // 20 / 2
    // totalStorno: prvič dejansko zapisan (absolutna vsota)
    expect(num(zr!.totalStorno)).toBe(original1Total)
    // Gotovina NETO: 100 + (45 + 20 - 45) = 120 pričakovano
    expect(num(zr!.cashSales)).toBe(20)
    expect(num(zr!.expectedCash)).toBe(120)
    // Izmena nosi čist števec naročil
    const shift = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(shift!.totalOrders).toBe(2)
    expect(num(shift!.totalSales)).toBe(20)
  })

  test('Z-poročilo brez storno: totalStorno = 0 (invarianta default vedenja)', async () => {
    // Nova izmena istega zaposlenega, brez storno računov v oknu
    const openRes = await callShifts({ openingCash: 0 }, empId, 'MANAGER')
    expect(openRes.status).toBe(201)
    const seeded = await seedPaidOrderWithReceipt(3, 30, 1)
    receipt2Id = seeded.receiptId // za čiščenje

    const stopRes = await callShifts({ action: 'stop', closingCash: 30 }, empId, 'MANAGER')
    expect(stopRes.status).toBe(200)
    const stopBody = await stopRes.json()
    expect(stopBody.zReport.totalStorno).toBe(0)

    const zr = await db.zReport.findUnique({ where: { id: stopBody.zReport.id } })
    expect(num(zr!.totalStorno)).toBe(0)
    expect(zr!.totalOrders).toBe(1)
    expect(num(zr!.totalSales)).toBe(30)
  })

  test('revizija RECEIPT_STORNO vsebuje storno kontekst (veriga audit)', async () => {
    const audits = await db.auditLog.findMany({ where: { action: 'RECEIPT_STORNO', locationId: locId } })
    expect(audits.length).toBe(1)
    const details = JSON.parse(audits[0]!.details || '{}')
    expect(details.originalReceiptId).toBe(receipt1Id)
    expect(details.stornoReceiptNumber).toBeTruthy()
    expect(details.total).toBe(-original1Total)
    // chainHash veriga mora biti prisotna (tamper-evident)
    expect(audits[0]!.chainHash).toBeTruthy()
  })
})
