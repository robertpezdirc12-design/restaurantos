/**
 * Test 32-c — P1 točka 4 (audit §12): Z-report DDV razčlenba (POST /api/shifts action='stop').
 *
 * RAČUN je znotraj shifts route handlerja (ni izvlečene čiste funkcije) → teste vodimo z
 * NEPOSREDNIM klicem handlerja nad DB fiksturami. OPOMBA O SOČASNIM SPREMEMBAM: med razvojem
 * tega testa je vzporedni agent (R11) zamenjal okno agregacije (prej surovi [openedAt, now],
 * zdaj CAS prevzem + veriženje oken "prvo zaprtje zmaga" = [max(openedAt, lastClosedAt), closedAt))
 * — testne fiksture so zato postavljene tako, da so računi v oknu pod OBEMA shemama, trditve
 * pa so INVARIANTE, ki držijo neodvisno od vezave okna:
 *   - vsota po stopnjah (vatStandardAmount/vatReducedAmount) = vsota DDV po računih za te stopnje;
 *   - totalNetSales = vsota neto po vedrih; totalTax = vsota receipt.totalVat;
 *   - totalSales = vsota receipt.total = totalNetSales + totalTax (centna aritmetika fikster).
 *
 * Pokritje:
 *  - razčlenba po stopnjah 22 % / 9.5 % / 0 % iz receipt.vatBreakdown (ENAK zapis, kot ga piše
 *    FURS route: ključi vatRate.toFixed(2) → '22.00', '9.50', '0.00');
 *  - normalizacija ključev: Number(rate) === 0 → '0', <= 9.5 → '9.5' (tudi '5.00' → znižana),
 *    sicer '22' — dokumentirano prek končnih agregatov;
 *  - popust: receipt.discount → totalDiscounts; total je popustljen (base+vat=total invarianta);
 *  - plačilna sredstva (cash/card), expectedCash = startingCash + cash, cashDifference;
 *  - veriženje oken (R11): druga izmena ne šteje računov prve (brez dvojnega štetja);
 *  - SOČASNI dvojni stop (Promise.all) → CAS: točno EN 200 (ali 400 "Ni odprte izmene"),
 *    drug 409 "Izmena je že zaključena." — točno ENO ZReport poročilo na izmeno;
 *  - izmena se zapre + AuditLog SHIFT_CLOSE; ponovni (zaporedni) stop brez odprte izmene → 400.
 *
 * Fixture predpona: zrepvat-; čiščenje reverse-FK v afterAll (+ pred-čiščenje v beforeAll).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { createToken } from '@/lib/auth'
import { db } from '@/lib/db'
import { nid, num } from '@/lib/map'
import { POST as shiftsPOST } from '../src/app/api/shifts/route'

const PREFIX = 'zrepvat'
const TS = Date.now()

let locId: string
let empId: string
let empName: string
let shiftId: string
let token = ''

interface ReceiptSpec {
  paymentMethod: 'cash' | 'card' | 'mobile'
  /** vedri v zapisu FURS route (ključi toFixed(2)) — base+vat = total po fikster konstrukciji */
  buckets: Record<string, { base: number; vat: number }>
  discount?: number
  splitCount?: number
  orderType?: string
}

/** Iz fiksterjev izračunaj pričakovane vedre z ISTO normalizacijo kot shifts route */
function expectedBuckets(specs: ReceiptSpec[]) {
  const buckets: Record<string, { net: number; vat: number }> = {}
  for (const s of specs) {
    for (const [rate, v] of Object.entries(s.buckets)) {
      const key = Number(rate) === 0 ? '0' : Number(rate) <= 9.5 ? '9.5' : '22'
      if (!buckets[key]) buckets[key] = { net: 0, vat: 0 }
      buckets[key].net += num(v.base)
      buckets[key].vat += num(v.vat)
    }
  }
  const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
  return {
    stdVat: r2(buckets['22']?.vat ?? 0),
    redVat: r2(buckets['9.5']?.vat ?? 0),
    totalNet: r2((buckets['22']?.net ?? 0) + (buckets['9.5']?.net ?? 0) + (buckets['0']?.net ?? 0)),
  }
}

async function cleanupFixtures() {
  const locs = await db.location.findMany({ where: { code: { startsWith: `${PREFIX}-` } }, select: { id: true } })
  for (const { id } of locs) {
    const shiftIds = (await db.cashRegisterShift.findMany({ where: { locationId: id }, select: { id: true } })).map((s) => s.id)
    await db.zReport.deleteMany({ where: { locationId: id } })
    await db.auditLog.deleteMany({ where: { entityType: 'CashRegisterShift', entityId: { in: shiftIds } } })
    await db.cashRegisterShift.deleteMany({ where: { id: { in: shiftIds } } })
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
  await cleanupFixtures()
  locId = (await db.location.create({
    data: { id: nid(), name: `${PREFIX} lokacija`, code: `${PREFIX}-${TS}`, premisesId: `BLGZRV${TS % 1000000}`, country: 'SI' },
  })).id
  const emp = await db.employee.create({
    data: { id: nid(), name: `${PREFIX} blagajnik`, email: `${PREFIX}-${TS}@test.local`, role: 'waiter', pin: `${PREFIX}-pin-${TS}`, locationId: locId },
  })
  empId = emp.id
  empName = emp.name
  token = createToken({ sub: empId, name: empName, role: 'WAITER', loc: locId, sv: 0 })
  shiftId = (await db.cashRegisterShift.create({
    data: { id: nid(), employeeId: empId, employeeName: empName, status: 'open', openedAt: new Date(TS - 2 * 3600_000), startingCash: 100, locationId: locId },
  })).id
})

afterAll(async () => {
  await cleanupFixtures()
})

/** Ustvari naročilo + fiskalni račun z vatBreakdown v zapisu FURS route */
async function mkReceipt(spec: ReceiptSpec, seq: number, createdAt?: Date) {
  const orderId = nid()
  const order = await db.order.create({
    data: {
      id: orderId,
      orderNumber: 840000 + seq,
      locationId: locId,
      status: 'paid',
      paymentStatus: 'paid',
      type: spec.orderType || 'dine-in',
      splitCount: spec.splitCount ?? 1,
      discount: spec.discount ?? 0,
      employeeId: empId,
    },
  })
  const subtotal = Object.values(spec.buckets).reduce((s, b) => s + b.base, 0)
  const vat = Object.values(spec.buckets).reduce((s, b) => s + b.vat, 0)
  const total = Math.round((subtotal + vat + Number.EPSILON) * 100) / 100
  const at = createdAt || new Date(TS - 90 * 60_000 + seq * 60_000) // varno znotraj okna 1. izmene
  await db.receipt.create({
    data: {
      id: nid(),
      receiptNumber: `${PREFIX}-R${seq}`,
      orderId,
      businessName: `${PREFIX} test`,
      businessAddress: '',
      businessId: '',
      taxId: 'SI12345678',
      subtotal,
      totalVat: vat,
      total,
      discount: spec.discount ?? 0,
      paymentMethod: spec.paymentMethod,
      vatBreakdown: JSON.stringify(spec.buckets), // ENAK zapis kot jstr(vatMap) v FURS route
      printedAt: at,
      createdAt: at, // eksplicitno — zajamčeno znotraj učinkovitega okna izmene
      locationId: locId,
    },
  })
  return { orderId, total, vat }
}

function stopReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/shifts', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/shifts (stop) — Z-report DDV razčlenba', () => {
  test('dve stopnji (22 % in 9.5 %) po več računih → vedri se seštejejo TOČNO po stopnjah (centna aritmetika)', async () => {
    // 5 računov: 22 % (cash), 9.5 % (cash), 22 % (card), 0 % + 9.5 % mešanica (card), 5 % → znižana vedro (cash)
    const specs: ReceiptSpec[] = [
      { paymentMethod: 'cash', buckets: { '22.00': { base: 100, vat: 22 } }, splitCount: 2 },
      { paymentMethod: 'cash', buckets: { '9.50': { base: 50, vat: 4.75 } } },
      { paymentMethod: 'card', buckets: { '22.00': { base: 10, vat: 2.2 } } },
      { paymentMethod: 'card', buckets: { '0.00': { base: 5, vat: 0 }, '9.50': { base: 8.4, vat: 0.79 } } },
      { paymentMethod: 'cash', buckets: { '5.00': { base: 2, vat: 0.1 } } }, // <= 9.5 → znižana
    ]
    for (const [i, s] of specs.entries()) await mkReceipt(s, i + 1)

    const res = await shiftsPOST(stopReq({ action: 'stop', closingCash: 278.85 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.zReport.id).toBeDefined()

    const zr = await db.zReport.findUnique({ where: { id: body.zReport.id } })
    expect(zr).not.toBeNull()

    // ── INVARIANTA (drži pod katerokoli vezavo okna): vsota po stopnjah = vsota DDV po računih ──
    const exp = expectedBuckets(specs)
    expect(num(zr?.vatStandardAmount)).toBe(exp.stdVat) // 22 + 2.2 = 24.2
    expect(num(zr?.vatStandardAmount)).toBe(24.2)
    expect(num(zr?.vatReducedAmount)).toBe(exp.redVat) // 4.75 + 0.79 + 0.1 = 5.64
    expect(num(zr?.vatReducedAmount)).toBe(5.64)
    expect(num(zr?.totalNetSales)).toBe(exp.totalNet) // 110 + 58.4 + 5 + 2 = 175.4
    expect(num(zr?.totalNetSales)).toBe(175.4)

    // totalTax = vsota receipt.totalVat; totalSales = vsota receipt.total = net + vat
    const receipts = await db.receipt.findMany({ where: { locationId: locId } })
    const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
    const sumVat = r2(receipts.reduce((s, r) => s + num(r.totalVat), 0))
    const sumTotal = r2(receipts.reduce((s, r) => s + num(r.total), 0))
    expect(num(zr?.totalTax)).toBe(sumVat)
    expect(sumVat).toBe(29.84)
    expect(num(zr?.totalSales)).toBe(sumTotal)
    expect(sumTotal).toBe(205.24)
    // centna invarianta: net + vat = promet
    expect(num(zr?.totalNetSales) + num(zr?.totalTax)).toBeCloseTo(num(zr?.totalSales), 2)

    // ničelna stopnja ima ločeno vedro (net gre v totalNetSales, vatZero je konstanta 0 v shemi)
    expect(num(zr?.vatZero)).toBe(0)

    // plačilna sredstva in blagajna: cash = 122 + 54.75 + 2.1 = 178.85; card = 12.2 + 14.19 = 26.39
    expect(num(zr?.cashSales)).toBe(178.85)
    expect(num(zr?.cardSales)).toBe(26.39)
    expect(num(zr?.startingCash)).toBe(100)
    expect(num(zr?.expectedCash)).toBe(278.85) // 100 + 178.85
    expect(num(zr?.actualCash)).toBe(278.85)
    expect(num(zr?.cashDifference)).toBe(0)

    // štetje: 5 računov, 6 gostov (splitCount 2 + 4×1)
    expect(zr?.totalOrders).toBe(5)
    expect(zr?.totalGuests).toBe(6)

    // odgovor handlerja: konsistenten z ZReport vrstico
    expect(body.zReport.totalSales).toBe(205.24)
    expect(body.zReport.totalTax).toBe(29.84)
    expect(body.zReport.receipts).toBe(5)
    expect(body.zReport.cashDifference).toBe(0)
  })

  test('veriženje oken (R11): druga izmena NE šteje računov prve — popust gre v totalDiscounts 2. poročila', async () => {
    const shift1ClosedAt = (await db.cashRegisterShift.findUnique({ where: { id: shiftId }, select: { closedAt: true } }))?.closedAt
    expect(shift1ClosedAt).not.toBeNull()

    // 2. izmena: račun z ročnim popustom, createdAt TIK PRED stop (notranjost okna pod obema shemama)
    const shift2 = await db.cashRegisterShift.create({
      data: { id: nid(), employeeId: empId, employeeName: empName, status: 'open', openedAt: new Date(Date.now() - 1000), startingCash: 50, locationId: locId },
    })
    const spec: ReceiptSpec = { paymentMethod: 'cash', buckets: { '22.00': { base: 80, vat: 17.6 } }, discount: 10 }
    // deterministično znotraj veriženega okna [shift1.closedAt, stop): createdAt
    // = closedAt + 10 ms; + kratek čakalni zamik pred stop, da je dejanski čas
    // zaklepa VEDNO za createdAt fiksture (okno [T1+10, stop) je potem odprt)
    const rcAt = new Date(shift1ClosedAt.getTime() + 10)
    await mkReceipt(spec, 11, rcAt) // total = 97.6, discount = 10
    await new Promise((r) => setTimeout(r, 120))

    const res = await shiftsPOST(stopReq({ action: 'stop', closingCash: 147.6 }))
    expect(res.status).toBe(200)
    const body2 = await res.json()
    const zr2 = await db.zReport.findUnique({ where: { id: body2.zReport.id } })
    expect(zr2).not.toBeNull()
    // popust viden v totalDiscounts; total = 97.6 (popustljen), net+vat invarianta ostane
    expect(num(zr2?.totalDiscounts)).toBe(10)
    expect(num(zr2?.totalSales)).toBe(97.6)
    expect(num(zr2?.totalNetSales) + num(zr2?.totalTax)).toBeCloseTo(num(zr2?.totalSales), 2)
    expect(num(zr2?.vatStandardAmount)).toBe(17.6)
    expect(zr2?.totalOrders).toBe(1)
    // 1. izmena ostaja nedotaknjena (brez dvojnega štetja prek veriženja/CAS prevzema)
    const zr1 = await db.zReport.findFirst({ where: { locationId: locId, id: { not: body2.zReport.id } } })
    expect(zr1).not.toBeNull()
    expect(num(zr1?.totalSales)).toBe(205.24)

    // izmena zaprta + revizija SHIFT_CLOSE
    const sh2 = await db.cashRegisterShift.findUnique({ where: { id: shift2.id } })
    expect(sh2?.status).toBe('closed')
    expect(sh2?.closedAt).not.toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'SHIFT_CLOSE', entityType: 'CashRegisterShift', entityId: shift2.id } })
    expect(audit).not.toBeNull()
    expect(audit?.locationId).toBe(locId)
  })

  test('SOČASNI dvojni stop (Promise.all) → CAS: točno ENO Z-poročilo, točno EN zaključek (R11)', async () => {
    const shift3 = await db.cashRegisterShift.create({
      data: { id: nid(), employeeId: empId, employeeName: empName, status: 'open', openedAt: new Date(Date.now() - 1000), startingCash: 0, locationId: locId },
    })
    const [ra, rb] = await Promise.allSettled([
      shiftsPOST(stopReq({ action: 'stop', closingCash: 0 })),
      shiftsPOST(stopReq({ action: 'stop', closingCash: 0 })),
    ])
    expect(ra.status).toBe('fulfilled')
    expect(rb.status).toBe('fulfilled')
    const resA = (ra as PromiseFulfilledResult<Response>).value
    const resB = (rb as PromiseFulfilledResult<Response>).value
    const statuses = [resA.status, resB.status]
    // točno en uspešen zaključek; drugi klic je 409 (CAS prevzem) ali 400 (izmena že zaprta)
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    for (const s of statuses) expect([200, 400, 409]).toContain(s)
    if (statuses.includes(409)) {
      const loser = statuses[0] === 409 ? await resA.json() : await resB.json()
      expect(String(loser.error)).toContain('že zaključena')
    }
    // invarianta: natanko ENO Z-poročilo za to izmeno, izmena je zaprta, en audit zapis
    expect(await db.zReport.count({ where: { locationId: locId, openedAt: shift3.openedAt } })).toBe(1)
    const sh3 = await db.cashRegisterShift.findUnique({ where: { id: shift3.id } })
    expect(sh3?.status).toBe('closed')
    expect(await db.auditLog.count({ where: { action: 'SHIFT_CLOSE', entityType: 'CashRegisterShift', entityId: shift3.id } })).toBe(1)
  })

  test('zaporedni stop brez odprte izmene → 400 "Ni odprte izmene."', async () => {
    const res = await shiftsPOST(stopReq({ action: 'stop', closingCash: 0 }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(String(body.error)).toContain('Ni odprte izmene')
  })

  test('ZReport ima openedAt iz izmene, locationId lokacije in zapisek zaključka', async () => {
    const zr = await db.zReport.findFirst({ where: { locationId: locId }, orderBy: { createdAt: 'desc' } })
    expect(zr).not.toBeNull()
    expect(zr?.locationId).toBe(locId)
    expect(zr?.openedAt).not.toBeNull()
    expect(zr?.closedAt).not.toBeNull()
    expect(zr?.status).toBe('draft')
    expect(String(zr?.notes)).toContain(empName)
  })
})
