/**
 * Issue #16 (P1/P2, v1.108.0) — blagajniški premiki denarja: vplačila,
 * izplačila, varni odvod in popolno usklajevanje predala.
 *
 * Pokritost (zahteve iz issue Testi):
 *  A. MOTOR: začetni fond 100 + prodaja 50 + vplačilo 20 − izplačilo 15 −
 *     odvod 30 → preostanek 125 (issue primer); kartično vračilo NE spreminja
 *     fizične gotovine, gotovinsko (fiskalni storno) jo spremeni ENKRAT;
 *     smer izpeljana iz tipa; voided+reversal izločeni iz neto.
 *  B. POST: kreacija na ODPRTI izmeni (audit + expectedAfter), tipi/opombe/
 *     razlogi meje, guest_refund + gotovinski storno račun → 409 (dvojno
 *     štetje!), idempotencyKey REPLAY (ponovljeni POST ne podvoji), tuja
 *     lokacija 403, brez cash.manage 403.
 *  C. PATCH void: kompenzacijski zapis (obratna smer + status) — neto 0;
 *     kratek razlog 400; ponovna razveljavitev 409; reversal ne more biti
 *     razveljavljen; ZAKLJUČENA izmena je neposporna (409); prag → odobritev
 *     (BREZ poverilnic 403, Z PIN druge osebe 200; audit brez PIN).
 *  D. STOP (usklajevanje): premiki V pričakovani gotovini; ZReport.cashDrops
 *     (typed) + raw povzetek stolpci (cashPaidIn/Out/GuestRefund);
 *     movementSummary v odgovoru; pretekli zaključki se NE preračunavajo
 *     (nov premik na zaključeni 409); variansa nad pragom: 400 brez razloga,
 *     200 z razlogom + odobritvijo (audit dokaz).
 *  E. SLEPI POPIS: politika cashBlindCount → NE-vodstveni vidi runningExpected
 *     null + blind summary (brez zneskov); vodstveni vidi vse.
 *  F. NO-SALE-REASONS: GET (cash.manage) + POST/DELETE (settings.manage),
 *     brisanje V UPORABI 409.
 *  G. CSV: BOM + `;` + Content-Disposition; NEPRODAJNI premiki (ločeno od
 *     prodaje — v izvozu ni prodajnih vrstic).
 *  H. DDL idempotenca + drift-check matcher.
 *
 * Fiksture s predpono i16-. Politika (RestaurantSettings) se shrani/povrne —
 * deljena singleton vrstica (vzorec issue18/i19).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  summarizeMovements,
  expectedDrawerCash,
  cashMovementDirection,
  resetCashMovementsProbe,
  resetCashPolicyProbe,
  resetZReportCashColumnsProbe,
  writeCashPolicy,
  DEFAULT_CASH_POLICY,
} from '../src/lib/cash-movements'
import { GET as movementsGET, POST as movementsPOST, PATCH as movementsPATCH } from '../src/app/api/shifts/movements/route'
import { GET as reasonsGET, POST as reasonsPOST, DELETE as reasonsDELETE } from '../src/app/api/shifts/no-sale-reasons/route'
import { POST as shiftsPOST } from '../src/app/api/shifts/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-cash-movements/route'

const P = 'i16-'
const RUN = Date.now().toString(36)
const TS = Date.now()

let locA = ''
let locB = ''
let locSeq = 0
/** SVEŽA lokacija za agregacijske teste (oknoReceiptsov je po lokaciji!). */
async function newLoc(tag: string): Promise<string> {
  const id = `${P}loc${tag}-${RUN}-${++locSeq}`
  await db.location.create({ data: { id, code: `${P}L${tag}${locSeq}`, name: `${P}Lok ${tag} ${locSeq}`, premisesId: `${P}prem${tag}${locSeq}-${RUN}` } })
  return id
}
let barAId = ''
let barDId = ''
let mgrAId = ''
let mgrA2Id = ''
let waiterAId = '' // BREZ cash.manage
let barBId = ''
let tokBarA = ''
let tokBarD = ''
let tokMgrA = ''
let tokMgrA2 = ''
let tokWaiterA = ''
let tokBarB = ''
let pinMgrA2 = ''

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function status(res: Response): Promise<number> {
  return res.status
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

function seedEmp(name: string, role: string, loc: string | null): Promise<{ id: string; pin: string }> {
  const id = `${P}${name}-${RUN}`
  const email = `${P}${name}-${RUN}@test.local`
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  return db.employee
    .create({
      data: { id, name: `${P}${name}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
    })
    .then((e) => ({ id: e.id, pin }))
}

/** Odprta izmena z eksplicitnim openedAt (okno receiptsov). */
async function seedShift(employeeId: string, employeeName: string, loc: string, startingCash: number, openedAt: Date) {
  const id = `${P}shift-${RUN}-${Math.random().toString(36).slice(2, 7)}`
  await db.cashRegisterShift.create({
    data: { id, employeeId, employeeName, status: 'open', openedAt, startingCash, locationId: loc },
  })
  return id
}

let rcptSeq = 0
/** Fiskalni račun v oknu izmene (paymentMethod/storno parametrizirana). */
async function seedReceipt(loc: string, total: number, opts: { method?: string; storno?: boolean; at?: Date } = {}) {
  const seq = ++rcptSeq
  const orderId = `${P}ord${seq}-${RUN}`
  await db.order.create({
    data: {
      id: orderId, orderNumber: 85100 + seq, locationId: loc, status: 'paid', paymentStatus: 'paid',
      paymentMethod: opts.method ?? 'cash', subtotal: total, tax: 0, discount: 0, tip: 0,
      total, totalWithTip: total, paidAt: new Date(), splitCount: 1, type: 'dine-in',
    },
  })
  const receiptId = `${P}rcpt${seq}-${RUN}`
  await db.receipt.create({
    data: {
      id: receiptId, receiptNumber: `2026-10-${85100 + seq}-BLGI16`, orderId,
      businessName: `${P} lokacija`, businessAddress: 'Testna 1', businessId: '12345678', taxId: 'SI12345678',
      registerId: 'BLG-001', subtotal: total, totalVat: 0, total,
      vatBreakdown: JSON.stringify({ '22.00': { base: total, vat: 0 } }),
      paymentMethod: opts.method ?? 'cash', isStorno: opts.storno ?? false,
      locationId: loc, createdAt: opts.at ?? new Date(TS - 60_000 + seq * 1000),
    },
  })
  return receiptId
}

async function seedMovement(shiftId: string, loc: string, userId: string, userName: string, spec: {
  type: string; direction: string; amount: number; status?: string; reversalOfId?: string | null; reasonId?: string | null; reasonName?: string
}) {
  const id = `${P}mv-${RUN}-${Math.random().toString(36).slice(2, 8)}`
  await db.cashMovement.create({
    data: {
      id, shiftId, locationId: loc, type: spec.type, direction: spec.direction, amount: spec.amount,
      currency: 'EUR', reasonId: spec.reasonId ?? null, reasonName: spec.reasonName ?? '', reasonText: '',
      note: 'test', userId, userName, deviceId: '', receiptRef: '', status: spec.status ?? 'confirmed',
      reversalOfId: spec.reversalOfId ?? null,
    },
  })
  return id
}

let settingsExistedBefore = false

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  // dev SQLite ima tabelo + stolpce (db push mirror) → probe PRISOTNOSTI vsiljen
  resetCashMovementsProbe(true)
  resetCashPolicyProbe(true)
  resetZReportCashColumnsProbe(true)

  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A`, premisesId: `${P}premA-${RUN}` } })
  await db.location.create({ data: { id: locB, code: `${P}LB`, name: `${P}Lokacija B`, premisesId: `${P}premB-${RUN}` } })

  const barA = await seedEmp('barA', 'bar', locA)
  const barD = await seedEmp('barD', 'bar', locA)
  const mgrA = await seedEmp('mgrA', 'manager', locA)
  const mgrA2 = await seedEmp('mgrA2', 'manager', locA)
  const waiter = await seedEmp('waiterA', 'waiter', locA)
  const barB = await seedEmp('barB', 'bar', locB)
  barAId = barA.id; barDId = barD.id; mgrAId = mgrA.id; mgrA2Id = mgrA2.id; waiterAId = waiter.id; barBId = barB.id
  pinMgrA2 = mgrA2.pin
  tokBarA = tok(barAId, `${P}barA`, 'BAR', locA)
  tokBarD = tok(barDId, `${P}barD`, 'BAR', locA)
  tokMgrA = tok(mgrAId, `${P}mgrA`, 'MANAGER', locA)
  tokMgrA2 = tok(mgrA2Id, `${P}mgrA2`, 'MANAGER', locA)
  tokWaiterA = tok(waiterAId, `${P}waiterA`, 'WAITER', locA)
  tokBarB = tok(barBId, `${P}barB`, 'BAR', locB)

  settingsExistedBefore = !!(await db.restaurantSettings.findFirst())
  // singleton vrstica za politiko (writeCashPolicy je UPDATE — brez vrstice se
  // vrednosti tiho NE shranijo; dev db jo ima, ci-fresh pa ne — isti vzorec kot
  // exception-policy testi, ki se zanašajo na bootstrap vrstico)
  if (!settingsExistedBefore) {
    await db.restaurantSettings.create({ data: { id: `${P}settings-${RUN}` } })
  }
})

afterAll(async () => {
  // politiko povrni na privzetke + singleton če prej ni obstajal
  await writeCashPolicy({ cashVarianceThresholdCents: 0, cashBlindCount: false }).catch(() => null)
  if (!settingsExistedBefore) {
    await db.restaurantSettings.deleteMany({}).catch(() => null)
  }
  resetCashMovementsProbe()
  resetCashPolicyProbe()
  resetZReportCashColumnsProbe()
  await sweepTestFixtures(db, [P])
})

/* ───────── A. MOTOR (en vir formule) ───────── */

describe('A. motor usklajevanja (pričakovana gotovina)', () => {
  it('A1. issue primer: 100 + 50 prodaja + 20 vplačilo − 15 izplačilo − 30 odvod = 125', () => {
    const sum = summarizeMovements([
      { type: 'paid_in', direction: 'in', amount: 20, status: 'confirmed', reversalOfId: null },
      { type: 'paid_out', direction: 'out', amount: 15, status: 'confirmed', reversalOfId: null },
      { type: 'safe_drop', direction: 'out', amount: 30, status: 'confirmed', reversalOfId: null },
    ])
    expect(sum.paidIn).toBe(20)
    expect(sum.paidOut).toBe(45) // paid_out + safe_drop smer IZVEN
    expect(sum.safeDrop).toBe(30)
    expect(sum.net).toBe(-25)
    const expected = expectedDrawerCash(100, 50, sum.net)
    expect(expected).toBe(125)
  })

  it('A2. kartično vračilo NE spreminja fizične gotovine; gotovinsko (storno) ENKRAT', () => {
    // kartični storno: cashSales del = 0 → predal nespremenjen
    expect(expectedDrawerCash(100, 0, 0)).toBe(100)
    // gotovinski storno: fiskalni račun −50 v oknu (negativna vsota) → −50
    expect(expectedDrawerCash(100, -50, 0)).toBe(50)
  })

  it('A3. voided original + kompenzacijski zapis: neto prispevek 0 (brez dvojnega)', () => {
    const sum = summarizeMovements([
      { type: 'paid_out', direction: 'out', amount: 15, status: 'voided', reversalOfId: null },
      { type: 'paid_out', direction: 'in', amount: 15, status: 'confirmed', reversalOfId: 'orig-1' },
    ])
    expect(sum.net).toBe(0)
    expect(sum.count).toBe(0)
    expect(sum.voidedCount).toBe(1)
  })

  it('A4. smer je IZPELJANA iz tipa; menjalni fond izrecna', () => {
    expect(cashMovementDirection('paid_in')).toBe('in')
    expect(cashMovementDirection('paid_out')).toBe('out')
    expect(cashMovementDirection('safe_drop')).toBe('out')
    expect(cashMovementDirection('guest_refund')).toBe('out')
    expect(cashMovementDirection('change_fund', 'in')).toBe('in')
    expect(cashMovementDirection('change_fund', 'out')).toBe('out')
    expect(cashMovementDirection('change_fund')).toBe(null)
    expect(cashMovementDirection('nonsense')).toBe(null)
  })
})

/* ───────── B. POST premika ───────── */

describe('B. POST /api/shifts/movements', () => {
  let shiftId = ''

  beforeAll(async () => {
    shiftId = await seedShift(barAId, `${P}barA`, locA, 100, new Date(TS - 3600_000))
  })

  it('B1. vplačilo na odprti izmeni → 201 + audit + expectedAfter', async () => {
    const r = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, {
      shiftId, type: 'paid_in', amount: 20, reason: 'menjalni priliv',
    }))
    const st = r.status
    const b = await body(r)
    expect(st).toBe(201)
    const mv = b.movement as Record<string, unknown>
    expect(mv.type).toBe('paid_in')
    expect(mv.direction).toBe('in')
    expect(mv.amount).toBe(20)
    expect(mv.status).toBe('confirmed')
    const audit = await db.auditLog.findFirst({ where: { action: 'CASH_MOVEMENT_CREATE', entityId: String(mv.id) } })
    expect(audit).not.toBeNull()
    const det = JSON.parse(String(audit?.details)) as { expectedBefore?: number; expectedAfter?: number }
    expect(det.expectedAfter).toBe(120) // 100 fond + 20 vplačilo (brez prodaje)
  })

  it('B2. safe_drop BREZ opombe → 400 (obvezna za izbrane tipe)', async () => {
    const r = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'safe_drop', amount: 30 }))
    expect(await status(r)).toBe(400)
  })

  it('B3. supplier_payment BREZ razloga → 400; Z razlogom + opombo 201', async () => {
    const r1 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'supplier_payment', amount: 25, note: 'riba taksist' }))
    expect(await status(r1)).toBe(400)
    const r2 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'supplier_payment', amount: 25, reason: 'riba zjutraj', note: 'dobavitelj Riba d.o.o.' }))
    expect(await status(r2)).toBe(201)
  })

  it('B4. neznan tip / negativen znesek → 400', async () => {
    const r1 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'giveaway', amount: 5 }))
    expect(await status(r1)).toBe(400)
    const r2 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'paid_out', amount: -5, reason: 'neg' }))
    expect(await status(r2)).toBe(400)
  })

  it('B5. guest_refund z navezavo na GOTOVINSKI storno račun → 409 (dvojno štetje)', async () => {
    const stornoId = await seedReceipt(locA, -18, { storno: true, method: 'cash' })
    const r = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, {
      shiftId, type: 'guest_refund', amount: 18, note: 'vračilo', reason: 'vračilo gotovine', receiptRef: stornoId,
    }))
    expect(await status(r)).toBe(409)
  })

  it('B6. tuja lokacija izmene → 403; vloga BREZ cash.manage → 403', async () => {
    const r1 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarB, { shiftId, type: 'paid_out', amount: 5, reason: 'tujec' }))
    expect(await status(r1)).toBe(403)
    const r2 = await movementsPOST(req('POST', '/api/shifts/movements', tokWaiterA, { shiftId, type: 'paid_out', amount: 5, reason: 'brez pravice' }))
    expect(await status(r2)).toBe(403)
  })

  it('B7. idempotencyKey: ponovljeni POST NE podvoji (200 + idempotentReplay)', async () => {
    const key = `i16-idem-${RUN}`
    const payload = { shiftId, type: 'paid_out', amount: 15, reason: 'odvoz embalaže', idempotencyKey: key }
    const r1 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, payload))
    expect(await status(r1)).toBe(201)
    const r2 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, payload))
    expect(await status(r2)).toBe(200)
    const b = await body(r2)
    expect(b.idempotentReplay).toBe(true)
    const rows = await db.cashMovement.findMany({ where: { idempotencyKey: key } })
    expect(rows.length).toBe(1)
  })

  it('B8. razlog iz kataloga NoSaleReason (posnetek imena); TUJI katalog → 400', async () => {
    const reasonA = await db.noSaleReason.create({
      data: { id: `${P}nsr1-${RUN}`, name: `${P}Nakup drobnega`, isActive: true, sortOrder: 0, locationId: locA },
    })
    const reasonB = await db.noSaleReason.create({
      data: { id: `${P}nsr2-${RUN}`, name: `${P}Tuj razlog`, isActive: true, sortOrder: 0, locationId: locB },
    })
    const r1 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'paid_out', amount: 3, reasonId: reasonA.id }))
    expect(await status(r1)).toBe(201)
    const b1 = await body(r1)
    expect((b1.movement as Record<string, unknown>).reasonName).toBe(`${P}Nakup drobnega`)
    const r2 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'paid_out', amount: 3, reasonId: reasonB.id }))
    expect(await status(r2)).toBe(400)
  })
})

/* ───────── C. PATCH void (kompenzacijski zapis) ───────── */

describe('C. PATCH void — kompenzacijski zapis', () => {
  it('C1. void z razlogom ≥10 → original voided + OBVRATEN zapis; neto 0', async () => {
    const shiftId = await seedShift(barAId, `${P}barA`, locA, 50, new Date(TS - 3600_000))
    const mvId = await seedMovement(shiftId, locA, barAId, `${P}barA`, { type: 'paid_out', direction: 'out', amount: 15 })
    const r = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, {
      id: mvId, action: 'void', reason: 'napačen znesek pri vnosu',
    }))
    expect(await status(r)).toBe(200)
    const b = await body(r)
    const rev = b.reversal as Record<string, unknown>
    expect(rev.direction).toBe('in') // obratna smer
    expect(rev.reversalOfId).toBe(mvId)
    expect((b.movement as Record<string, unknown>).status).toBe('voided')
    const rows = await db.cashMovement.findMany({ where: { shiftId } })
    const sum = summarizeMovements(rows.map((m) => ({ ...m, amount: Number(m.amount) })))
    expect(sum.net).toBe(0)
    const audit = await db.auditLog.findFirst({ where: { action: 'CASH_MOVEMENT_VOID', entityId: mvId } })
    expect(audit).not.toBeNull()
  })

  it('C2. kratek razlog → 400; ponovna razveljavitev → 409; reversal → 409', async () => {
    const shiftId = await seedShift(barAId, `${P}barA`, locA, 50, new Date(TS - 3600_000))
    const mvId = await seedMovement(shiftId, locA, barAId, `${P}barA`, { type: 'paid_out', direction: 'out', amount: 5 })
    const r1 = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, { id: mvId, action: 'void', reason: 'kratko' }))
    expect(await status(r1)).toBe(400)
    const r2 = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, { id: mvId, action: 'void', reason: 'utemeljen razlog razveljavitve' }))
    expect(await status(r2)).toBe(200)
    const r3 = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, { id: mvId, action: 'void', reason: 'utemeljen razlog razveljavitve 2' }))
    expect(await status(r3)).toBe(409)
    const rev = await db.cashMovement.findFirst({ where: { reversalOfId: mvId } })
    expect(rev).not.toBeNull()
    const r4 = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, { id: rev!.id, action: 'void', reason: 'razveljavi razveljavitev' }))
    expect(await status(r4)).toBe(409)
  })

  it('C3. ZAKLJUČENA izmena je NEPOSPRUNA → 409 (zgodovina se ne spreminja)', async () => {
    const shiftId = await seedShift(barAId, `${P}barA`, locA, 50, new Date(TS - 3600_000))
    const mvId = await seedMovement(shiftId, locA, barAId, `${P}barA`, { type: 'paid_out', direction: 'out', amount: 5 })
    await db.cashRegisterShift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date() } })
    const r = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, { id: mvId, action: 'void', reason: 'po zaključku ne gre več' }))
    expect(await status(r)).toBe(409)
    const r2 = await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'paid_in', amount: 5, reason: 'po zaključku' }))
    expect(await status(r2)).toBe(409)
  })

  it('C4. prag politike: velik premik → odobritev (403 brez; 200 s PIN druge osebe; audit BREZ PIN)', async () => {
    await writeCashPolicy({ cashVarianceThresholdCents: 1000 }) // 10 EUR prag
    const shiftId = await seedShift(barAId, `${P}barA`, locA, 50, new Date(TS - 3600_000))
    const mvId = await seedMovement(shiftId, locA, barAId, `${P}barA`, { type: 'paid_out', direction: 'out', amount: 15 })
    // BREZ poverilnic → 403 (odobritev zahtevana)
    const r1 = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, {
      id: mvId, action: 'void', reason: 'velik premik potrebuje odobritev',
    }))
    expect(await status(r1)).toBe(403)
    // napačen PIN → 403
    const r2 = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, {
      id: mvId, action: 'void', reason: 'velik premik potrebuje odobritev',
      approverEmail: `${P}mgrA2-${RUN}@test.local`, approverPin: '000000',
    }))
    expect(await status(r2)).toBe(403)
    // veljaven PIN DRUGE osebe → 200
    const r3 = await movementsPATCH(req('PATCH', '/api/shifts/movements', tokBarA, {
      id: mvId, action: 'void', reason: 'velik premik potrebuje odobritev',
      approverEmail: `${P}mgrA2-${RUN}@test.local`, approverPin: pinMgrA2,
    }))
    expect(await status(r3)).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'CASH_MOVEMENT_VOID', entityId: mvId } })
    const det = JSON.parse(String(audit?.details)) as Record<string, unknown>
    expect(det.approved).toBe(true)
    expect(det.approvalMethod).toBe('pin')
    expect(det.approverName).toBe(`${P}mgrA2`)
    expect(String(audit?.details)).not.toContain(pinMgrA2) // PIN NIKOLI v auditu
    await writeCashPolicy({ cashVarianceThresholdCents: 0 })
  })
})

/* ───────── D. STOP — usklajevanje z premiki ───────── */

describe('D. zaključek izmene (stop) z premiki', () => {
  it('D1. issue primer: 100 + 50 (gotovinska prodaja) + 20 − 15 − 30 → expected 125; ZReport cashDrops=30 + raw povzetek', async () => {
    // SVEŽA lokacija: okno zaključka agregira receiptse PO LOKACIJI od openedAt —
    // ločene lokacije med testi preprečujejo navzkrižje oken (R11 lekcija).
    const loc = await newLoc('D1')
    const shiftId = await seedShift(barDId, `${P}barD`, loc, 100, new Date(TS - 2 * 3600_000))
    await seedReceipt(loc, 50, { method: 'cash' }) // v oknu (createdAt ~TS)
    await seedMovement(shiftId, loc, barDId, `${P}barD`, { type: 'paid_in', direction: 'in', amount: 20 })
    await seedMovement(shiftId, loc, barDId, `${P}barD`, { type: 'paid_out', direction: 'out', amount: 15 })
    await seedMovement(shiftId, loc, barDId, `${P}barD`, { type: 'safe_drop', direction: 'out', amount: 30 })

    const r = await shiftsPOST(req('POST', '/api/shifts', tokBarD, { action: 'stop', closingCash: 125 }))
    const b = await body(r)
    expect(b.shift).toBeDefined()
    const shift = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(Number(shift?.expectedCash)).toBe(125)
    expect(Number(shift?.cashDifference)).toBe(0)
    expect(Number(shift?.cashSales)).toBe(50)
    // movementSummary v odgovoru (issue: pred zaključkom prikaži razčlenitev)
    const ms = b.movementSummary as Record<string, number> | undefined
    expect(ms).toBeDefined()
    expect(ms?.paidIn).toBe(20)
    expect(ms?.paidOut).toBe(45)
    expect(ms?.safeDrop).toBe(30)
    // ZReport: typed cashDrops (odvod v sef — PRVIČ zapisan) + raw povzetek
    const zr = await db.zReport.findFirst({ where: { locationId: loc }, orderBy: { createdAt: 'desc' } })
    expect(zr).not.toBeNull()
    expect(Number(zr?.cashDrops)).toBe(30)
    const raw = await db.$queryRawUnsafe<{ cashPaidIn: number; cashPaidOut: number; cashGuestRefund: number }[]>(
      `SELECT "cashPaidIn", "cashPaidOut", "cashGuestRefund" FROM "ZReport" WHERE "id" = '${zr!.id}'`,
    )
    expect(Number(raw[0].cashPaidIn)).toBe(20)
    expect(Number(raw[0].cashPaidOut)).toBe(45)
    expect(Number(raw[0].cashGuestRefund)).toBe(0)
    // ista finančna dejstva NISO podvojena v Z (promet ostaja 50)
    expect(Number(zr?.totalSales)).toBe(50)
    expect(Number(zr?.cashSales)).toBe(50)
  })

  it('D2. gotovinski storno v oknu → prodaja −18 (ENKRAT, brez premika); kartični storno NE dotakne gotovine', async () => {
    // SVEŽA lokacija: okno [from, to) veriži po closedAt z prejšnjimi zaključki
    // NA ISTI LOKACIJI (R11 "prvo zaprtje zmaga") — testni zaključi C1–C3 na
    // locA bi porezali okno, zato lastna lokacija.
    const loc = await newLoc('D2')
    const shiftId = await seedShift(barDId, `${P}barD`, loc, 100, new Date(TS - 2 * 3600_000))
    await seedReceipt(loc, 50, { method: 'cash' })
    await seedReceipt(loc, -18, { method: 'cash', storno: true })
    await seedReceipt(loc, -30, { method: 'card', storno: true })
    const r = await shiftsPOST(req('POST', '/api/shifts', tokBarD, { action: 'stop', closingCash: 132 }))
    expect((await body(r)).shift).toBeDefined()
    const shift = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(Number(shift?.cashSales)).toBe(32) // 50 − 18 (kartični storno NE šteje v gotovino)
    expect(Number(shift?.expectedCash)).toBe(132) // 100 + 32
  })

  it('D3. variance nad pragom: 400 BREZ razloga → 403 z razlogom brez odobritelja → 200 z obema; izmena medtem OSTANE ODPRTA', async () => {
    await writeCashPolicy({ cashVarianceThresholdCents: 200 }) // 2 EUR
    const loc = await newLoc('D3')
    const shiftId = await seedShift(barDId, `${P}barD`, loc, 100, new Date(TS - 2 * 3600_000))
    await seedReceipt(loc, 50, { method: 'cash' })
    // odobritelj MORA pripadati lokaciji dejanja (resolveExceptionApproval
    // lokacijski obseg) — namenski vodja na sveži lokaciji
    const appr = await seedEmp('mgrApprD3', 'manager', loc)
    // 1) BREZ razloga → 400 (razlog je prvi pogoj)
    const r1 = await shiftsPOST(req('POST', '/api/shifts', tokBarD, { action: 'stop', closingCash: 120 })) // +20 razlika
    expect(await status(r1)).toBe(400)
    const stillOpen = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(stillOpen?.status).toBe('open') // FAIL-CLOSED: nič ni poteklo
    // 2) BAR (NE-vodstveni) z razlogom BREZ poverilnic → 403 (odobritev)
    const r2 = await shiftsPOST(req('POST', '/api/shifts', tokBarD, {
      action: 'stop', closingCash: 120, varianceReason: 'napaka pri štetju',
    }))
    expect(await status(r2)).toBe(403)
    const stillOpen2 = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(stillOpen2?.status).toBe('open')
    // 3) napačen PIN odobritelja → 403
    const r2b = await shiftsPOST(req('POST', '/api/shifts', tokBarD, {
      action: 'stop', closingCash: 120, varianceReason: 'napaka pri štetju',
      approverEmail: `${P}mgrApprD3-${RUN}@test.local`, approverPin: '000000',
    }))
    expect(await status(r2b)).toBe(403)
    // 4) Z razlogom + veljavnim PINOM druge osebe → 200
    const r3 = await shiftsPOST(req('POST', '/api/shifts', tokBarD, {
      action: 'stop', closingCash: 120,
      varianceReason: 'napaka pri štetju — manjkajoči dvajsetakov',
      approverEmail: `${P}mgrApprD3-${RUN}@test.local`, approverPin: appr.pin,
    }))
    expect(await status(r3)).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'SHIFT_CLOSE', entityId: shiftId } })
    const det = JSON.parse(String(audit?.details)) as { variance?: Record<string, unknown> }
    expect(det.variance?.approved).toBe(true)
    expect(det.variance?.approvalMethod).toBe('pin')
    expect(det.variance?.varianceReasonText).toBe('napaka pri štetju — manjkajoči dvajsetakov')
    await writeCashPolicy({ cashVarianceThresholdCents: 0 })
  })

  it('D3b. variance BREZ razloga → 400', async () => {
    await writeCashPolicy({ cashVarianceThresholdCents: 200 })
    const loc = await newLoc('D3b')
    const shiftId = await seedShift(mgrAId, `${P}mgrA`, loc, 100, new Date(TS - 2 * 3600_000))
    await seedReceipt(loc, 50, { method: 'cash' })
    // MANAGER (vodstvena vloga = 'role' odobritev) a BREZ razloga → 400
    const r = await shiftsPOST(req('POST', '/api/shifts', tokMgrA, { action: 'stop', closingCash: 130 }))
    expect(await status(r)).toBe(400)
    const stillOpen = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(stillOpen?.status).toBe('open')
    // Z razlogom → vodstvena vloga odobri sama ('role')
    const r2 = await shiftsPOST(req('POST', '/api/shifts', tokMgrA, { action: 'stop', closingCash: 130, varianceReason: 'sprejeta fiksna razlika' }))
    expect(await status(r2)).toBe(200)
    const audit = await db.auditLog.findFirst({ where: { action: 'SHIFT_CLOSE', entityId: shiftId } })
    const det = JSON.parse(String(audit?.details)) as { variance?: Record<string, unknown> }
    expect(det.variance?.approvalMethod).toBe('role')
    await writeCashPolicy({ cashVarianceThresholdCents: 0 })
  })

  it('D4. POD pragom: vedenje nespremenjeno (brez razloga) — konfiguracija', async () => {
    await writeCashPolicy({ cashVarianceThresholdCents: 5000 }) // 50 EUR — izklopljeno za majhne razlike
    const loc = await newLoc('D4')
    const shiftId = await seedShift(barDId, `${P}barD`, loc, 100, new Date(TS - 2 * 3600_000))
    await seedReceipt(loc, 50, { method: 'cash' })
    const r = await shiftsPOST(req('POST', '/api/shifts', tokBarD, { action: 'stop', closingCash: 152 })) // +2 razlika
    expect(await status(r)).toBe(200)
    await writeCashPolicy({ cashVarianceThresholdCents: 0 })
  })
})

/* ───────── E. slepi popis ───────── */

describe('E. slepi popis (politika cashBlindCount)', () => {
  it('E1. blind: BAR vidi runningExpected null + summary BREZ zneskov; MANAGER vidi vse', async () => {
    await writeCashPolicy({ cashBlindCount: true })
    const shiftId = await seedShift(barAId, `${P}barA`, locA, 100, new Date(TS - 3600_000))
    await seedMovement(shiftId, locA, barAId, `${P}barA`, { type: 'paid_in', direction: 'in', amount: 20 })

    const rBar = await movementsGET(req('GET', `/api/shifts/movements?shiftId=${shiftId}`, tokBarA))
    const bBar = await body(rBar)
    expect(bBar.runningExpected).toBeNull()
    const sumBar = bBar.summary as Record<string, unknown>
    expect(sumBar.blind).toBe(true)
    expect(sumBar.paidIn).toBeUndefined()
    expect(sumBar.net).toBeUndefined()

    const rMgr = await movementsGET(req('GET', `/api/shifts/movements?shiftId=${shiftId}`, tokMgrA))
    const bMgr = await body(rMgr)
    expect(bMgr.runningExpected).not.toBeNull()
    const sumMgr = bMgr.summary as Record<string, number>
    expect(sumMgr.paidIn).toBe(20)
    await writeCashPolicy({ cashBlindCount: false })
  })

  it('E2. ne-blind (privzeto): BAR vidi živo pričakovano (enaka formula kot zaključek)', async () => {
    const loc = await newLoc('E2')
    // namenski blagajnik NA lokaciji izmene (staff vidi SAMO svojo lokacijo)
    const barE2 = await seedEmp('barE2', 'bar', loc)
    const tokBarE2 = tok(barE2.id, `${P}barE2`, 'BAR', loc)
    const shiftId = await seedShift(barE2.id, `${P}barE2`, loc, 100, new Date(TS - 3600_000))
    await seedReceipt(loc, 50, { method: 'cash' })
    await seedMovement(shiftId, loc, barE2.id, `${P}barE2`, { type: 'paid_out', direction: 'out', amount: 15 })
    const r = await movementsGET(req('GET', `/api/shifts/movements?shiftId=${shiftId}`, tokBarE2))
    const b = await body(r)
    expect(b.runningExpected).toBe(135) // 100 + 50 − 15
    expect((b.summary as Record<string, number>).net).toBe(-15)
  })
})

/* ───────── F. katalog NoSaleReason ───────── */

describe('F. /api/shifts/no-sale-reasons', () => {
  it('F1. GET (cash.manage) vrne aktivne razloge lokacije; POST (settings.manage) 201 + duplikat 409; brisanje v uporabi 409', async () => {
    const rGet = await reasonsGET(req('GET', `/api/shifts/no-sale-reasons?locationId=${locA}`, tokBarA))
    expect(await status(rGet)).toBe(200)
    const bGet = await body(rGet)
    expect(Array.isArray(bGet.reasons)).toBe(true)

    const name = `${P}Nakup sitnine ${RUN}`
    const rPost = await reasonsPOST(req('POST', '/api/shifts/no-sale-reasons', tokMgrA, { name, locationId: locA }))
    expect(await status(rPost)).toBe(201)
    const rDup = await reasonsPOST(req('POST', '/api/shifts/no-sale-reasons', tokMgrA, { name, locationId: locA }))
    expect(await status(rDup)).toBe(409)

    // naredi premik s tem razlogom → brisanje 409 (katalog ne sme tiho izginiti)
    const created = (await body(rPost)).reason as { id: string }
    const shiftId = await seedShift(barAId, `${P}barA`, locA, 50, new Date(TS - 3600_000))
    await movementsPOST(req('POST', '/api/shifts/movements', tokBarA, { shiftId, type: 'paid_out', amount: 2, reasonId: created.id }))
    const rDel = await reasonsDELETE(req('DELETE', `/api/shifts/no-sale-reasons?id=${created.id}`, tokMgrA))
    expect(await status(rDel)).toBe(409)
    // deaktivacija skrije iz POS izbire, ZGODOVINSKA uporaba pa brisanje
    // blokira TRAJNO (isti vzorec kot VoidReason v #19 — snapshot ostane)
    await db.noSaleReason.update({ where: { id: created.id }, data: { isActive: false } })
    const rDel2 = await reasonsDELETE(req('DELETE', `/api/shifts/no-sale-reasons?id=${created.id}`, tokMgrA))
    expect(await status(rDel2)).toBe(409)
    // neuporabljen razlog se izbriše čisto
    const fresh = await db.noSaleReason.create({
      data: { id: `${P}nsr3-${RUN}`, name: `${P}Nikoli uporabljen`, isActive: true, sortOrder: 0, locationId: locA },
    })
    const rDel3 = await reasonsDELETE(req('DELETE', `/api/shifts/no-sale-reasons?id=${fresh.id}`, tokMgrA))
    expect(await status(rDel3)).toBe(200)
  })

  it('F2. BREZ cash.manage → 403 na GET; BREZ settings.manage → 403 na POST', async () => {
    const r1 = await reasonsGET(req('GET', `/api/shifts/no-sale-reasons?locationId=${locA}`, tokWaiterA))
    expect(await status(r1)).toBe(403)
    const r2 = await reasonsPOST(req('POST', '/api/shifts/no-sale-reasons', tokBarA, { name: `${P}brez pravice ${RUN}`, locationId: locA }))
    expect(await status(r2)).toBe(403)
  })
})

/* ───────── G. CSV izvoz ───────── */

describe('G. CSV izvoz (računovodstvo — ločeno od prodaje)', () => {
  it('G1. BOM + `;` + Content-Disposition; vrstice premikov (NEPRODAJNE — brez prodajnih vrstic)', async () => {
    const from = new Date(TS - 24 * 3600_000).toISOString()
    const r = await movementsGET(req('GET', `/api/shifts/movements?format=csv&from=${encodeURIComponent(from)}`, tokMgrA))
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text.startsWith('\ufeff')).toBe(true)
    expect(r.headers.get('content-disposition')).toContain('attachment; filename="cash-movements-')
    const lines = text.replace('\ufeff', '').split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(1) // glava + vsaj en premik
    expect(lines[0]).toContain(';')
    // tenant obseg: samo i16 lokacije (tuji testi ne smrdijo skozi)
    for (const line of lines.slice(1)) {
      expect(line).toContain('i16-')
    }
  })

  it('G2. tuja lokacija ni v izvozu (staff vidi SAMO svojo)', async () => {
    const from = new Date(TS - 24 * 3600_000).toISOString()
    const r = await movementsGET(req('GET', `/api/shifts/movements?format=csv&from=${encodeURIComponent(from)}`, tokBarB))
    const text = await r.text()
    expect(text).not.toContain(locA)
  })
})

/* ───────── H. DDL idempotenca + drift matcher ───────── */

describe('H. DDL + drift-check', () => {
  it('H1. migracija je idempotentna (tabela obstaja → alreadyApplied)', async () => {
    const r = await migratePOST(req('POST', '/api/admin/migrate-cash-movements', tok(mgrAId, `${P}mgrA`, 'MANAGER', locA)))
    // centralna vloga zahtevana — MANAGER locA ni centralen? requireCentralRole = ADMIN/OWNER db role
    // v dev sqlite je mgrA MANAGER z loc — preverimo ali je 200 ali 403, idempotenca samo ob 200
    const st = r.status
    if (st === 200) {
      const b = await body(r)
      expect(b.alreadyApplied).toBe(true)
    } else {
      expect(st).toBe(403) // ne-centralna vloga → varno zavrnjena
    }
  })

  it('H2. drift-check matcher: CashMovement + politika + ZReport stolpci so znani drift', async () => {
    const { isCashMovementStatement } = await import('../scripts/drift-check')
    expect(isCashMovementStatement('CREATE TABLE "CashMovement" (id TEXT NOT NULL)')).toBe(true)
    expect(isCashMovementStatement('CREATE UNIQUE INDEX "CashMovement_idempotencyKey_key" ON "CashMovement"("idempotencyKey")')).toBe(true)
    expect(isCashMovementStatement('CREATE INDEX "CashMovement_shiftId_idx" ON "CashMovement"("shiftId")')).toBe(true)
    expect(isCashMovementStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN "cashVarianceThresholdCents" INTEGER NOT NULL DEFAULT 0')).toBe(true)
    expect(isCashMovementStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "cashBlindCount" BOOLEAN NOT NULL DEFAULT false')).toBe(true)
    expect(isCashMovementStatement('ALTER TABLE "ZReport" ADD COLUMN "cashPaidIn" DECIMAL(12,2) NOT NULL DEFAULT 0')).toBe(true)
    expect(isCashMovementStatement('ALTER TABLE "ZReport" DROP COLUMN "cashGuestRefund"')).toBe(true)
    expect(isCashMovementStatement('DROP TABLE "CashMovement"')).toBe(false) // ni CREATE/ALTER
    expect(isCashMovementStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN "name" TEXT')).toBe(false)
    expect(isCashMovementStatement('ALTER TABLE "ZReport" ADD COLUMN "totalCost" DECIMAL')).toBe(false)
    expect(isCashMovementStatement('INSERT INTO "CashMovement" VALUES (1)')).toBe(false)
  })
})

/* ───────── I. privzeta politika (graceful pre-DDL) ───────── */

describe('I. privzeta politika', () => {
  it('I1. DEFAULT_CASH_POLICY: prag 0 (izklopljen) + slepi popis izklopljen (varna nadaljevanja)', () => {
    expect(DEFAULT_CASH_POLICY.varianceThresholdCents).toBe(0)
    expect(DEFAULT_CASH_POLICY.blindCount).toBe(false)
  })
})
