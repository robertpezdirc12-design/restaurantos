import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as shiftsPOST } from '../src/app/api/shifts/route'
import { PATCH as inventoryPATCH } from '../src/app/api/inventory/route'
import { PATCH as orderPATCH } from '../src/app/api/orders/[id]/route'
import { POST as discountPOST } from '../src/app/api/orders/[id]/discount/route'
import { createOrderCore } from '../src/lib/ops'

/**
 * P1 (audit §14): dodatni unit testi za R-pot — race popravki iz prvotne revizije,
 * ki jih Task 32-c (R7/R9/R12 + N5), stock-deduction (R2) in furs-post (R10 + plačilni
 * CAS) NISO pokrili. DB-backed testi proti dev SQLite; fiksature s predpono `rp1-`,
 * cleanup v afterAll v obratni smeri FK.
 *
 * R1 — odpiranje izmene: transakcija + ponovna preverba → 2. klic 409, nobena dvojna izmena
 * R3 — zaključek izmene: CAS prevzem zaklepa → točno EN Z-poročilo + EN SHIFT_CLOSE revizija
 * R4 — prilagoditev zaloge: atomarne spremembe; StockTransaction + AuditLog v ISTI transakciji
 *      (evidence gibanja = dejansko stanje, tudi pri talni omejitvi na 0 in inventurnem setQty)
 * R5 — addItems na PLAČANO naročilo → 409; na odprto → postavka + recalc atomarno
 * R6 — zasedba mize: CAS `status != occupied` → drugo aktivno naročilo 409; replay istega
 *      klika (isti clientOperationId) je dovoljen in ne podvoji naročila
 * R8 — popust maxUses: preverba + CAS `currentUses < maxUses` → prekoračitev 409,
 *      števec ostane točno 1
 */

const PREFIX = 'rp1-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`
// unikatni openedAt za Z-poročilo (brez prefiksa na id → filter po openedAt; unikaten na run)
const OPEN_AT = new Date(1_700_000_000_000 + (Date.now() % 86_400_000))

let locA = ''
let waiterId = ''
let menuItemId = ''
const miA = () => menuItemId

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function tokenFor(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

async function seedEmployee(name: string, role: string, pin: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}emp-${name}-${RUN}`,
      name: `${PREFIX}${name}`,
      email: `${PREFIX}${name}-${RUN}@test.local`,
      role,
      status: 'active',
      sessionVersion: 0,
      locationId: locA,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
}

async function seedShift(employeeId: string, employeeName: string, openedAt?: Date) {
  return db.cashRegisterShift.create({
    data: {
      id: `${PREFIX}sh-${employeeName.replace(PREFIX, '')}-${RUN}`,
      employeeId,
      employeeName,
      status: 'open',
      openedAt: openedAt ?? OPEN_AT,
      startingCash: 50,
      locationId: locA,
    },
  })
}

interface SeedOrderOpts {
  paymentStatus?: string
  status?: string
}
// orderNumber je unique per lokacija (@@unique[locationId, orderNumber]); createOrderCore (R6)
// pobira max+1 — zato vsaka testna skupina dobi lastno široko bazo, da se območja ne sekata
let ordSeq = 0
async function seedOrder(suffix: string, opts: SeedOrderOpts = {}, base = 0) {
  return db.order.create({
    data: {
      id: `${PREFIX}o${suffix}-${RUN}`,
      orderNumber: base + ++ordSeq,
      locationId: locA,
      tableId: null,
      status: opts.status ?? 'open',
      paymentStatus: opts.paymentStatus ?? 'unpaid',
      subtotal: 0,
      tax: 0,
      total: 0,
    },
  })
}

async function seedItem(orderId: string, suffix: string) {
  return db.orderItem.create({
    data: {
      id: `${PREFIX}itm-${suffix}-${RUN}`,
      orderId,
      menuItemId: miA(),
      quantity: 1,
      price: 5,
      vatRate: 22,
      vatAmount: 0,
      menuItemName: `${PREFIX}Jed`,
      status: 'pending',
      voided: false,
    },
  })
}

afterAll(async () => {
  // obratna smer FK: dogodki/revizija → gibanja zaloge → postavke → naročila → popusti
  // → mize → meni → izmene → Z-poročila → zaloge → zaposleni → lokacija
  await db.eventLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.stockTransaction.deleteMany({ where: { inventoryItemId: { startsWith: PREFIX } } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { id: { startsWith: `${PREFIX}itm-` } } }).catch(() => null)
  await db.order.deleteMany({ where: { id: { startsWith: `${PREFIX}o` } } }).catch(() => null)
  await db.discount.deleteMany({ where: { id: { startsWith: `${PREFIX}disc-` } } }).catch(() => null)
  await db.table.deleteMany({ where: { id: { startsWith: `${PREFIX}tbl-` } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { startsWith: `${PREFIX}mi-` } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: `${PREFIX}cat-` } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: `${PREFIX}menu-` } } }).catch(() => null)
  await db.cashRegisterShift.deleteMany({ where: { id: { startsWith: `${PREFIX}sh-` } } }).catch(() => null)
  await db.zReport.deleteMany({ where: { openedAt: OPEN_AT } }).catch(() => null)
  await db.inventoryItem.deleteMany({ where: { id: { startsWith: `${PREFIX}inv-` } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: locA || '__x__' } }).catch(() => null)
})

async function setup() {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: {
      id: `${PREFIX}loc-${RUN}`,
      name: `${PREFIX}Lokacija`,
      code: `RP1-${RUN.toUpperCase()}`,
      premisesId: `rp1-prem-${RUN}`,
    },
  })
  locA = loc.id
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locA } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  const mi = await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Jed`, price: 10, categoryId: cat.id } })
  menuItemId = mi.id
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(1))
  const manager = await seedEmployee('manager', 'manager', pinOf(2))
  waiterId = waiter.id
  return {
    waiter: tokenFor(waiter.id, waiter.name, 'WAITER', locA),
    manager: tokenFor(manager.id, manager.name, 'MANAGER', locA),
  }
}

const setupP = setup()

// ─────────────────────────── R1 ───────────────────────────

describe('R1 — odpiranje izmene (transakcija + ponovna preverba)', () => {
  test('odprta izmena zaposlenega → 2. odpiranje 409, brez dvojne izmene; po zaključku → 201', async () => {
    const t = await setupP
    // issue #5 (v1.88.0): POST /api/shifts zahteva cash.manage → klicatelj je MANAGER
    // (guard 'ena odprta izmena na zaposlenega' je per-employee → izmena se seje na MANAGER)
    const emp = await db.employee.findUnique({ where: { id: `${PREFIX}emp-manager-${RUN}` } })
    expect(emp).not.toBeNull()
    const openShift = await seedShift(emp!.id, emp!.name, new Date(Date.UTC(2026, 0, 2, 8, 0, 0)))

    // 1. klic: izmena že teče → 409
    const res1 = await shiftsPOST(req('/api/shifts', t.manager, 'POST', { openingCash: 100 }))
    expect(res1.status).toBe(409)
    const openCount = await db.cashRegisterShift.count({ where: { employeeId: emp!.id, status: 'open' } })
    expect(openCount).toBe(1)

    // zaključi fiksturno izmeno → 2. klic uspešno odpre novo
    await db.cashRegisterShift.update({ where: { id: openShift.id }, data: { status: 'closed', closedAt: new Date() } })
    const res2 = await shiftsPOST(req('/api/shifts', t.manager, 'POST', { openingCash: 100 }))
    expect(res2.status).toBe(201)
    const shifts = await db.cashRegisterShift.findMany({ where: { employeeId: emp!.id } })
    expect(shifts).toHaveLength(2)
    expect(shifts.filter((s) => s.status === 'open')).toHaveLength(1)
    // SHIFT_OPEN revizija v ISTI transakciji (33-c) — vsaj za novo odprtje
    const openAudits = await db.auditLog.count({ where: { action: 'SHIFT_OPEN', userId: emp!.id } })
    expect(openAudits).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────── R3 ───────────────────────────

describe('R3 — zaključek izmene (CAS prevzem zaklepa)', () => {
  test('2 vzporedna zaključka → točno EN uspeh, EN Z-poročilo, EN SHIFT_CLOSE revizija', async () => {
    const t = await setupP
    // issue #5: stop je self-scoped + zahteva cash.manage → BAR vloga (šank)
    const emp = await seedEmployee('stopper', 'bar', pinOf(3))
    const shift = await seedShift(emp.id, emp.name) // openedAt = OPEN_AT (unikatno na run)

    const stopCall = () => shiftsPOST(req('/api/shifts', tokenFor(emp.id, emp.name, 'BAR', locA), 'POST', { action: 'stop', closingCash: 50 }))
    const [a, b] = await Promise.all([stopCall(), stopCall()])
    const statuses = [a.status, b.status]
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s !== 200)).toHaveLength(1)

    // invarianta ne glede na vmesno stanje: natanko eno Z-poročilo v oknu izmene
    const zreports = await db.zReport.findMany({ where: { openedAt: OPEN_AT } })
    expect(zreports).toHaveLength(1)
    const closeAudits = await db.auditLog.count({ where: { action: 'SHIFT_CLOSE', entityId: shift.id } })
    expect(closeAudits).toBe(1)
    const after = await db.cashRegisterShift.findUnique({ where: { id: shift.id } })
    expect(after?.status).toBe('closed')
    expect(after?.closedAt).not.toBeNull()
  })
})

// ─────────────────────────── R4 ───────────────────────────

describe('R4 — prilagoditev zaloge (transakcija; evidence = stanje)', () => {
  test('delta −3 → qty 7 + StockTransaction(ADJUST, −3); delta −50 → talna omejitev 0 + evidence −7; setQty 5 → inventurni popravek +5', async () => {
    const t = await setupP
    const item = await db.inventoryItem.create({
      data: { id: `${PREFIX}inv-${RUN}`, name: `${PREFIX}Artikel`, quantity: 10, locationId: locA },
    })

    // 1) običajen odštevek
    const res1 = await inventoryPATCH(req('/api/inventory', t.manager, 'PATCH', { id: item.id, delta: -3 }))
    expect(res1.status).toBe(200)
    const after1 = await db.inventoryItem.findUnique({ where: { id: item.id } })
    expect(Number(after1?.quantity)).toBe(7)

    // 2) odštevek čez zalogo → talna omejitev na 0 (in VEDNO evidence gibanja)
    const res2 = await inventoryPATCH(req('/api/inventory', t.manager, 'PATCH', { id: item.id, delta: -50 }))
    expect(res2.status).toBe(200)
    const after2 = await db.inventoryItem.findUnique({ where: { id: item.id } })
    expect(Number(after2?.quantity)).toBe(0)

    // 3) inventurni popravek (namenski last-writer-wins)
    const res3 = await inventoryPATCH(req('/api/inventory', t.manager, 'PATCH', { id: item.id, setQty: 5 }))
    expect(res3.status).toBe(200)
    const after3 = await db.inventoryItem.findUnique({ where: { id: item.id } })
    expect(Number(after3?.quantity)).toBe(5)

    // jedro R4: evidence gibanja (3 vnosi) vsota = končno stanje − začetno (10 → 5)
    const txs = await db.stockTransaction.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: 'asc' } })
    expect(txs).toHaveLength(3)
    expect(txs.map((x) => Number(x.quantity))).toEqual([-3, -7, 5])
    expect(Number(txs[0].previousQty)).toBe(10)
    expect(Number(txs[0].newQty)).toBe(7)
    // revizija INVENTORY_ADJUST v ISTI transakciji — 3 vnosi
    const audits = await db.auditLog.count({ where: { action: 'INVENTORY_ADJUST', entityId: item.id } })
    expect(audits).toBe(3)
  })
})

// ─────────────────────────── R5 ───────────────────────────

describe('R5 — addItems na plačano naročilo (CAS gate, obe poti v transakciji)', () => {
  test('plačano → 409 brez nove postavke; odprto → postavka + recalc', async () => {
    const t = await setupP
    const paid = await seedOrder('5a', { paymentStatus: 'paid', status: 'paid' }, 41000)
    const open = await seedOrder('5b', {}, 41000)

    // plačano naročilo → 409, brez nove postavke
    const res1 = await orderPATCH(req(`/api/orders/${paid.id}`, t.waiter, 'PATCH', { addItems: [{ menuItemId: miA(), qty: 1 }] }), { params: Promise.resolve({ id: paid.id }) })
    expect(res1.status).toBe(409)
    expect(await db.orderItem.count({ where: { orderId: paid.id } })).toBe(0)

    // odprto naročilo → postavka dodana + skupaj prerazporejena atomarno
    const res2 = await orderPATCH(req(`/api/orders/${open.id}`, t.waiter, 'PATCH', { addItems: [{ menuItemId: miA(), qty: 1 }] }), { params: Promise.resolve({ id: open.id }) })
    expect(res2.status).toBe(200)
    const items = await db.orderItem.findMany({ where: { orderId: open.id } })
    expect(items).toHaveLength(1)
    expect(Number(items[0].price)).toBe(10)
    const after = await db.order.findUnique({ where: { id: open.id } })
    expect(Number(after?.total)).toBeGreaterThan(0)
  })
})

// ─────────────────────────── R6 ───────────────────────────

describe('R6 — zasedba mize (CAS `status != occupied`)', () => {
  test('prosta miza → occupied; 2. aktivno naročilo na isti mizi → 409; replay istega klika → dovoljen', async () => {
    const t = await setupP
    const table = await db.table.create({ data: { id: `${PREFIX}tbl-${RUN}`, number: 9100 + (Date.now() % 500), locationId: locA, status: 'available' } })
    const base = {
      employeeId: waiterId,
      locationId: locA,
      items: [{ menuItemId: miA(), qty: 1 }],
      tableId: table.id,
    }

    // 1) prosta miza → uspeh + miza occupied
    const first = await createOrderCore({ ...base, clientOperationId: `rp1-r6-first-${RUN}` })
    expect(first.replayed).toBe(false)
    const tbl1 = await db.table.findUnique({ where: { id: table.id } })
    expect(tbl1?.status).toBe('occupied')

    // 2) drugo AKTIVNO naročilo na isti mizi → 409 (miza je že zasedena)
    let err: unknown
    try {
      await createOrderCore({ ...base, clientOperationId: `rp1-r6-second-${RUN}` })
      expect.unreachable()
    } catch (e) {
      err = e
    }
    expect((err as { status?: number }).status).toBe(409)
    expect((err as Error).message).toContain('zasedena')

    // 3) replay ISTEGA klika → obstoječe naročilo, brez dvojnika
    const replay = await createOrderCore({ ...base, clientOperationId: `rp1-r6-first-${RUN}` })
    expect(replay.replayed).toBe(true)
    expect(replay.order.id).toBe(first.order.id)
    const activeOnTable = await db.order.count({
      where: { tableId: table.id, paymentStatus: { not: 'paid' }, status: { not: 'cancelled' } },
    })
    expect(activeOnTable).toBe(1)
  })
})

// ─────────────────────────── R8 ───────────────────────────

describe('R8 — popust maxUses (preverba + CAS `currentUses < maxUses`)', () => {
  test('1. uporaba 200 (števec 1); 2. uporaba 409, števec ostane 1, naročilo brez popusta', async () => {
    const t = await setupP
    const disc = await db.discount.create({
      data: {
        id: `${PREFIX}disc-${RUN}`,
        name: `${PREFIX}Popust`,
        type: 'percent',
        amount: 10,
        isActive: true,
        locationId: locA,
        triggerType: 'manual',
        maxUses: 1,
        currentUses: 0,
      },
    })
    const orderA = await seedOrder('8a', {}, 43000)
    const orderB = await seedOrder('8b', {}, 43000)
    await seedItem(orderA.id, '8a')
    await seedItem(orderB.id, '8b')

    // 1. uporaba → 200, order.discount 0.5 (10 % od 5), števec 1
    const res1 = await discountPOST(req(`/api/orders/${orderA.id}/discount`, t.manager, 'POST', { discountId: disc.id }), { params: Promise.resolve({ id: orderA.id }) })
    expect(res1.status).toBe(200)
    const afterA = await db.order.findUnique({ where: { id: orderA.id } })
    expect(Number(afterA?.discount)).toBe(0.5)
    const disc1 = await db.discount.findUnique({ where: { id: disc.id } })
    expect(disc1?.currentUses).toBe(1)

    // 2. uporaba na drugem naročilu → 409, števec ostane 1, orderB.discount 0
    const res2 = await discountPOST(req(`/api/orders/${orderB.id}/discount`, t.manager, 'POST', { discountId: disc.id }), { params: Promise.resolve({ id: orderB.id }) })
    expect(res2.status).toBe(409)
    const disc2 = await db.discount.findUnique({ where: { id: disc.id } })
    expect(disc2?.currentUses).toBe(1)
    const afterB = await db.order.findUnique({ where: { id: orderB.id } })
    expect(Number(afterB?.discount)).toBe(0)
    const audits = await db.auditLog.count({ where: { action: 'DISCOUNT_APPLIED', entityId: { in: [orderA.id, orderB.id] } } })
    expect(audits).toBe(1)
  })
})
