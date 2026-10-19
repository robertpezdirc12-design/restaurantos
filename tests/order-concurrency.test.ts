import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { claimMutableOrder, isMutableOrderState } from '../src/lib/ops'
import { PATCH as orderPATCH, DELETE as orderDELETE } from '../src/app/api/orders/[id]/route'
import { PATCH as kitchenPATCH } from '../src/app/api/kitchen/route'
import { POST as movePOST } from '../src/app/api/orders/[id]/move/route'
import { POST as mergePOST } from '../src/app/api/orders/[id]/merge/route'
import { POST as syncPOST } from '../src/app/api/sync/route'

/**
 * v1.145.0 — revizija 2026-10, najdba #10 / #11 / #12 (SOČASNOST naročil in miz).
 *
 * SKUPNI IMEVALNI ZAPIS: `claimMutableOrder` (src/lib/ops.ts) — zapis v stanje
 * naročila uspeje samo, če je vrstica OB ZAPISU še mutabilna (ista bela lista kot
 * addItems CAS iz issue #48) in, kadar je podan `read`, še vistem stanju.
 *
 * Pokrito:
 *  A) enota: claim helper (mutabilno/terminalno/pinirano branje/neobstoječa vrstica)
 *  B) kuhinjski rollup ne sme ODPRITI zaključenega naročila (#10) — deterministično
 *  C) PATCH CANCELLED in DELETE proti SOČASNEMU PLAČILU (#10/#11) — varnostna
 *     invarianta čez zamikano dirko (nikoli 'cancelled' z fiskaliziranim računom;
 *     zavrnjen preklic NE PUSTI stranskih učinkov)
 *  D) dvakratni DELETE istega naročila (#11) — deterministično (samo ENA revizija)
 *  E) selitev mize (#12): ignoriran CAS rezultat, dvojna sočasna selitev, happy path
 *  F) združevanje (#12): oba zapisa v tx + rollback premika postavk
 *  G) offline replay (sync) addItems na PREKLICANEM naročilu (#10) — deterministično
 *  H) pini vira: nobena od prizadetih rut nima več brezpogojnega zapisa stanja
 *
 * Fiksature s predpono `ocon-`; cleanup = sweepTestFixtures (obrnjen FK vrstni red).
 */

const PREFIX = 'ocon-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locId = ''
let managerId = ''
let waiterId = ''
let miId = ''

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
      id: `${PREFIX}emp-${name}-${RUN}`, name: `${PREFIX}${name}`, email: `${PREFIX}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: locId,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
}

let seq = 0
/** naročilo z mizo po želji (status/paymentStatus sta DB vrednosti) */
async function seedOrder(status = 'open', paymentStatus = 'unpaid', tableId?: string) {
  seq++
  return db.order.create({
    data: {
      id: `${PREFIX}ord-${seq}-${RUN}`, locationId: locId, orderNumber: 7000 + seq,
      status, paymentStatus, total: 10, subtotal: 8.2, tax: 1.8,
      ...(tableId ? { tableId } : {}),
    },
  })
}

async function seedItem(orderId: string, status = 'preparing') {
  seq++
  return db.orderItem.create({
    data: { id: `${PREFIX}it-${seq}-${RUN}`, orderId, menuItemId: miId, quantity: 1, price: 10, vatRate: 22, vatAmount: 1.8, menuItemName: 'Ocon testni artikel', status },
  })
}

async function seedTable(overrides: Record<string, unknown> = {}) {
  seq++
  return db.table.create({
    data: { id: `${PREFIX}tbl-${seq}-${RUN}`, locationId: locId, number: seq, status: 'available', ...overrides },
  })
}

async function seedLink(orderId: string) {
  return db.payLink.create({
    data: { id: `${PREFIX}pl-${orderId}`, orderId, locationId: locId, token: `${PREFIX}tok-${orderId}`, status: 'open', amount: 10 },
  })
}

/**
 * SOČASNO KANONIČNO PLAČILO (modelira issueFursReceipt / paylink settle): CAS na
 * plačilno stanje in račun z EOR-jem SAMO, če je naročilo še neplačano.
 * @returns true = plačilo je commitnilo
 */
async function commitPayment(orderId: string): Promise<boolean> {
  const paid = await db.order.updateMany({
    where: { id: orderId, paymentStatus: { in: ['unpaid', 'partial'] } },
    data: { status: 'paid', paymentStatus: 'paid', paidAt: new Date() },
  })
  if (paid.count === 0) return false
  await db.receipt.create({
    data: {
      id: `${PREFIX}rec-${orderId}`, receiptNumber: `OCON-${orderId}`, orderId, locationId: locId,
      businessName: 'Ocon Test', businessAddress: 'Testna 1', businessId: 'SI00000000', taxId: 'SI12345678',
      subtotal: 8.2, totalVat: 1.8, total: 10, paymentMethod: 'cash',
      zoi: `${PREFIX}zoi-${orderId}`, eor: `${PREFIX}eor-${orderId}`, fiscalStatus: 'verified', fiscalVerified: true,
    },
  })
  return true
}

const countAudits = (action: string, entityId: string) => db.auditLog.count({ where: { action, entityId } })
const orderRow = (id: string) => db.order.findUnique({ where: { id } })

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `OCON-${RUN.toUpperCase()}`, premisesId: `ocon-prem-${RUN}`, taxId: 'SI12345678' },
  })
  locId = loc.id
  managerId = (await seedEmployee('manager', 'manager', pinOf(1))).id
  waiterId = (await seedEmployee('waiter', 'waiter', pinOf(2))).id
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: 'Ocon meni', locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: 'Ocon kategorija', menuId: menu.id } })
  miId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: 'Ocon testni artikel', price: 10, categoryId: cat.id } })).id
})

afterAll(async () => {
  const res = await sweepTestFixtures(db, [PREFIX])
  expect(res.errors).toEqual([])
  expect(res.remainingLocations).toBe(0)
})

/* ─────────────── A) skupni CAS evaluator ─────────────── */

describe('A — claimMutableOrder (skupni write-time gate)', () => {
  test('mutabilno stanje dovoli zapis in vrne tableId', async () => {
    const tbl = await seedTable({ status: 'occupied' })
    const order = await seedOrder('sent', 'unpaid', tbl.id)
    const res = await claimMutableOrder(db, order.id, { status: 'prepared' })
    expect(res.ok).toBe(true)
    expect(res.tableId).toBe(tbl.id)
    expect((await orderRow(order.id))?.status).toBe('prepared')
  })

  test('terminalna stanja (status in paymentStatus) zavržejo zapis brez sledu', async () => {
    const cases: [string, string][] = [
      ['paid', 'paid'], ['sent', 'paid'], ['cancelled', 'cancelled'], ['sent', 'storno'], ['open', 'cancelled'],
    ]
    for (const [status, paymentStatus] of cases) {
      const order = await seedOrder(status, paymentStatus)
      const res = await claimMutableOrder(db, order.id, { status: 'prepared' })
      expect(res.ok, `${status}/${paymentStatus}`).toBe(false)
      const row = await orderRow(order.id)
      expect(row?.status).toBe(status)
      expect(row?.paymentStatus).toBe(paymentStatus)
    }
    expect(isMutableOrderState({ status: 'sent', paymentStatus: 'partial' })).toBe(true)
  })

  test('pinirano branje zavrne zapis, če se je stanje med branjem in zapisom spremenilo', async () => {
    const order = await seedOrder('sent', 'unpaid')
    // natakar je prebral 'sent', kuhinja je medtem šla na 'prepared'
    await db.order.update({ where: { id: order.id }, data: { status: 'prepared' } })
    const res = await claimMutableOrder(db, order.id, { notes: 'zastarel podatek' }, { status: order.status, paymentStatus: order.paymentStatus, tableId: null })
    expect(res.ok).toBe(false)
    expect((await orderRow(order.id))?.notes).toBe('')
  })

  test('neobstoječe naročilo → ok:false (brez izjeme)', async () => {
    const res = await claimMutableOrder(db, `${PREFIX}ne-obstaja`, { status: 'prepared' })
    expect(res.ok).toBe(false)
  })
})

/* ───────── B) kuhinjski rollup (#10) ───────── */

describe('B — KDS rollup ne odpre zaključenega naročila', () => {
  test("preklicano naročilo z zadnjo 'preparing' postavko ostane 'cancelled'", async () => {
    const order = await seedOrder('cancelled', 'cancelled')
    const item = await seedItem(order.id, 'preparing')
    const res = await kitchenPATCH(req('/api/kitchen', tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { itemId: item.id, status: 'READY' }))
    expect(res.status).toBe(200)
    const row = await orderRow(order.id)
    // PREJ: rollup je z brezpogojnim updateom vrnil naročilo v 'prepared'
    // (odprto za addItems, premik mize in DRUGO izdajo računa)
    expect(row?.status).toBe('cancelled')
    expect(row?.paymentStatus).toBe('cancelled')
  })

  test("plačano naročilo ostane 'paid' (zakasneli KDS klik)", async () => {
    const order = await seedOrder('paid', 'paid')
    const item = await seedItem(order.id, 'preparing')
    await kitchenPATCH(req('/api/kitchen', tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { itemId: item.id, status: 'READY' }))
    expect((await orderRow(order.id))?.status).toBe('paid')
  })

  test("happy path ostane: odprto naročilo z zadnjim artiklom → 'prepared'", async () => {
    const order = await seedOrder('sent', 'unpaid')
    const item = await seedItem(order.id, 'preparing')
    await kitchenPATCH(req('/api/kitchen', tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { itemId: item.id, status: 'READY' }))
    expect((await orderRow(order.id))?.status).toBe('prepared')
  })
})

/* ───────── C) dirka s plačilom: PATCH CANCELLED in DELETE (#10/#11) ───────── */

async function raceSweep(kind: 'PATCH' | 'DELETE') {
  const tok = tokenFor(managerId, 'm', 'MANAGER', locId)
  let rejections = 0
  for (const delay of [0, 1, 2, 3, 5, 8, 12, 20, 30, 45]) {
    const tbl = await seedTable({ status: 'occupied' })
    const order = await seedOrder('sent', 'unpaid', tbl.id)
    const link = await seedLink(order.id)
    const call = kind === 'PATCH'
      ? orderPATCH(req(`/api/orders/${order.id}`, tok, 'PATCH', { status: 'CANCELLED', reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
      : orderDELETE(req(`/api/orders/${order.id}`, tok, 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    await new Promise((r) => setTimeout(r, delay))
    const paidFirst = await commitPayment(order.id)
    const res = await call
    const row = await orderRow(order.id)
    const receipts = await db.receipt.count({ where: { orderId: order.id } })

    // VARNOSTNA INVARIANTA (finančna): nikoli preklicano naročilo z fiskaliziranim
    // računom — plačilo, ki je commitnilo PRED zapisom, mora preklic zavrniti.
    expect(row?.status === 'cancelled' && receipts > 0).toBe(false)
    // plačilo, ki je commitnilo, vedno zmaga → naročilo ostane 'paid'
    if (paidFirst) expect(row?.status).toBe('paid')

    if (res.status === 409) {
      rejections++
      // Zavrnjen preklic NE SME pustiti stranskih učinkov (prej: povezave
      // superseded, miza 'cleaning' in revizijski zapis preklica, ki se ni zgodil).
      expect((await db.payLink.findUnique({ where: { id: link.id } }))?.status).toBe('open')
      expect((await db.table.findUnique({ where: { id: tbl.id } }))?.status).toBe('occupied')
      expect(await countAudits(kind === 'PATCH' ? 'ORDER_STATUS_CANCELLED_OVERRIDE' : 'ORDER_CANCELLED', order.id)).toBe(0)
      expect(await db.eventLog.count({ where: { entityId: order.id, type: 'OrderCancelled' } })).toBe(0)
    }
  }
  return { rejections }
}

describe('C — sočasno plačilo med preklicem (dirka čez zamike)', () => {
  test("PATCH status CANCELLED: nikoli 'cancelled' z računom; zavrnjen preklic brez sledu", async () => {
    const hits = await raceSweep('PATCH')
    expect(hits.rejections).toBeGreaterThan(0) // dirka je bila vsaj enkrat zadeta
  })

  test("DELETE (preklic): nikoli 'cancelled' z računom; zavrnjen preklic brez sledu", async () => {
    const hits = await raceSweep('DELETE')
    expect(hits.rejections).toBeGreaterThan(0)
  })
})

/* ───────── D) dvakratni preklic istega naročila (#11) ───────── */

describe('D — preklic uspe samo enkrat (dvojna revizija nemogoča)', () => {
  test('drugi DELETE na že preklicanem (partial) naročilu → 409, ENA revizija, miza miruje', async () => {
    const tbl = await seedTable({ status: 'occupied' })
    const order = await seedOrder('sent', 'partial', tbl.id)
    const tok = tokenFor(managerId, 'm', 'MANAGER', locId)
    const first = await orderDELETE(req(`/api/orders/${order.id}`, tok, 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    expect(first.status).toBe(200)
    expect(await countAudits('ORDER_CANCELLED', order.id)).toBe(1)

    // PREJ je drugi klic uspel (guard je gledal SAMO paymentStatus paid/storno):
    // druga ORDER_CANCELLED revizija z drugim časom + miza je šla nazaj v
    // 'cleaning', če jo je medtem zasedlo drugo naročilo.
    await db.table.update({ where: { id: tbl.id }, data: { status: 'reserved' } })
    const second = await orderDELETE(req(`/api/orders/${order.id}`, tok, 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    expect(second.status).toBe(409)
    expect(await countAudits('ORDER_CANCELLED', order.id)).toBe(1)
    expect((await db.table.findUnique({ where: { id: tbl.id } }))?.status).toBe('reserved')
    const row = await orderRow(order.id)
    expect(row?.status).toBe('cancelled')
    expect(row?.paymentStatus).toBe('partial') // delna plačila ostanejo v Payment vrsticah
  })
})

/* ───────── E) selitev naročila (#12) ───────── */

describe('E — move: zasedba mize je preverjena in atomska', () => {
  test('zasedena miza brez odprtega naročila → 409 in NESPREMENJENO naročilo', async () => {
    const tbl = await seedTable({ status: 'occupied' })
    const order = await seedOrder('open', 'unpaid')
    const res = await movePOST(req(`/api/orders/${order.id}/move`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { tableId: tbl.id }), { params: Promise.resolve({ id: order.id }) })
    // PREJ: CAS rezultat (status != occupied) je bil IGNORIRAN → 200, naročilo na
    // tujem zasedenem mizi, tabela miz pa nespremenjena (tloris laže)
    expect(res.status).toBe(409)
    expect((await orderRow(order.id))?.tableId).toBeNull()
    expect((await db.table.findUnique({ where: { id: tbl.id } }))?.status).toBe('occupied')
    expect(await countAudits('ORDER_MOVE', order.id)).toBe(0)
  })

  test('dve sočasni selitvi na ISTO prosto mizo → natanko ena uspe', async () => {
    const tbl = await seedTable()
    const a = await seedOrder('open', 'unpaid')
    const b = await seedOrder('open', 'unpaid')
    const tok = tokenFor(waiterId, 'w', 'WAITER', locId)
    const [ra, rb] = await Promise.all([
      movePOST(req(`/api/orders/${a.id}/move`, tok, 'POST', { tableId: tbl.id }), { params: Promise.resolve({ id: a.id }) }),
      movePOST(req(`/api/orders/${b.id}/move`, tok, 'POST', { tableId: tbl.id }), { params: Promise.resolve({ id: b.id }) }),
    ])
    const oks = [ra.status, rb.status].filter((s) => s === 200)
    expect(oks.length).toBe(1)
    expect([409, 400]).toContain(ra.status === 200 ? rb.status : ra.status)
    // miza ima natanko eno odprto naročilo
    const holders = await db.order.count({ where: { tableId: tbl.id, status: { notIn: ['paid', 'cancelled'] } } })
    expect(holders).toBe(1)
    expect((await db.table.findUnique({ where: { id: tbl.id } }))?.status).toBe('occupied')
  })

  test('happy path: selitev na prosto mizo + izpustitev stare', async () => {
    const old = await seedTable({ status: 'occupied' })
    const next = await seedTable()
    const order = await seedOrder('open', 'unpaid', old.id)
    const res = await movePOST(req(`/api/orders/${order.id}/move`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { tableId: next.id }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(200)
    const row = await orderRow(order.id)
    expect(row?.tableId).toBe(next.id)
    expect((await db.table.findUnique({ where: { id: next.id } }))?.status).toBe('occupied')
    expect((await db.table.findUnique({ where: { id: old.id } }))?.status).toBe('available')
    expect(await countAudits('ORDER_MOVE', order.id)).toBe(1)
  })

  test('selitev plačanega naročila → 409 (brano ob prihodu in ob zapisu)', async () => {
    const next = await seedTable()
    const order = await seedOrder('paid', 'paid')
    const res = await movePOST(req(`/api/orders/${order.id}/move`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { tableId: next.id }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(409)
    expect((await db.table.findUnique({ where: { id: next.id } }))?.status).toBe('available')
  })
})

/* ───────── F) združevanje naročil (#12) ───────── */

describe('F — merge: oba zapisa v transakciji, premik postavk se povrne', () => {
  test('happy path: postavke na cilj, vir preklican, totali cilja preračunani', async () => {
    const src = await seedOrder('sent', 'unpaid')
    const tgt = await seedOrder('sent', 'unpaid')
    await seedItem(src.id, 'preparing')
    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    expect(res.status).toBe(200)
    expect(await db.orderItem.count({ where: { orderId: tgt.id } })).toBe(1)
    expect((await orderRow(src.id))?.status).toBe('cancelled')
    expect(Number((await orderRow(tgt.id))?.total)).toBe(10)
    expect(await countAudits('ORDER_MERGE', src.id)).toBe(1)
  })

  test("terminalna kombinacija (vir 'sent' + paymentStatus 'cancelled') → 409 BREZ premika postavk", async () => {
    const src = await seedOrder('sent', 'cancelled')
    const tgt = await seedOrder('sent', 'unpaid')
    await seedItem(src.id, 'preparing')
    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    // PREJ: zunanji guard je gledal samo status/plačano → postavke so bile
    // premaknjene in totali cilja prepisani, vir pa je ostal v 'sent'
    expect(res.status).toBe(409)
    expect(await db.orderItem.count({ where: { orderId: tgt.id } })).toBe(0)
    expect(await db.orderItem.count({ where: { orderId: src.id } })).toBe(1)
    expect(Number((await orderRow(tgt.id))?.total)).toBe(10)
    expect(await countAudits('ORDER_MERGE', src.id)).toBe(0)
  })

  test("terminalen cilj ('sent' + paymentStatus 'storno') → 409, vir nedotaknjen", async () => {
    const src = await seedOrder('sent', 'unpaid')
    const tgt = await seedOrder('sent', 'storno')
    await seedItem(src.id, 'preparing')
    const res = await mergePOST(req(`/api/orders/${src.id}/merge`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    expect(res.status).toBe(409)
    expect(await db.orderItem.count({ where: { orderId: tgt.id } })).toBe(0)
    const srcRow = await orderRow(src.id)
    expect(srcRow?.status).toBe('sent')
    expect(srcRow?.cancelReason).toBe('')
  })

  test('sočasno plačilo vira med združevanjem → nikoli preklican plačan vir', async () => {
    const src = await seedOrder('sent', 'unpaid')
    const tgt = await seedOrder('sent', 'unpaid')
    await seedItem(src.id, 'preparing')
    const call = mergePOST(req(`/api/orders/${src.id}/merge`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    await new Promise((r) => setTimeout(r, 3))
    const paidFirst = await commitPayment(src.id)
    const res = await call
    const row = await orderRow(src.id)
    const receipts = await db.receipt.count({ where: { orderId: src.id } })
    expect(row?.status === 'cancelled' && receipts > 0).toBe(false)
    if (paidFirst) {
      expect(res.status).toBe(409)
      expect(row?.status).toBe('paid')
      // rollback: premik postavk je izničen, ciljno naročilo nespremenjeno
      expect(await db.orderItem.count({ where: { orderId: tgt.id } })).toBe(0)
      expect(await countAudits('ORDER_MERGE', src.id)).toBe(0)
    }
  })
})

/* ───────── G) offline replay (sync) ───────── */

describe('G — sync order.addItems na zaključenem naročilu (bela lista kot online pot)', () => {
  test("preklicano naročilo (paymentStatus 'cancelled') zavrne replay brez postavk", async () => {
    const order = await seedOrder('cancelled', 'cancelled')
    const res = await syncPOST(req('/api/sync', tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', {
      deviceId: `${PREFIX}dev-${RUN}`,
      ops: [{ kind: 'order.addItems', clientOperationId: `${PREFIX}coid-${RUN}`, payload: { orderId: order.id, addItems: [{ menuItemId: miId, qty: 1 }] } }],
    }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results?: { ok?: boolean; error?: string }[] }
    // PREJ: CAS je bil samo `paymentStatus !== 'paid'` → postavke so pristale v
    // preklicanem naročilu in totali so bili prepisani
    expect(json.results?.[0]?.ok).toBe(false)
    expect(await db.orderItem.count({ where: { orderId: order.id } })).toBe(0)
    expect(Number((await orderRow(order.id))?.total)).toBe(10)
  })
})

/* ───────── H) pini vira (razred napake, ne instanca) ───────── */

describe('H — nobena pot ne piše več stanja naročila brezpogojno', () => {
  const read = (rel: string) => {
    const p = join(import.meta.dir, '..', 'src', 'app', rel)
    expect(existsSync(p), rel).toBe(true)
    return readFileSync(p, 'utf8')
  }

  test('orders/[id], merge, move, kitchen in sync uporabljajo skupni CAS evaluator', () => {
    for (const rel of ['api/orders/[id]/route.ts', 'api/orders/[id]/merge/route.ts', 'api/orders/[id]/move/route.ts', 'api/kitchen/route.ts', 'api/sync/route.ts']) {
      const src = read(rel)
      expect(src.includes('claimMutableOrder') || src.includes('isMutableOrderState') || src.includes('ORDER_MUTABLE_'), rel).toBe(true)
    }
  })

  test('merge in move nimata več brezpogojnega order.update', () => {
    for (const rel of ['api/orders/[id]/merge/route.ts', 'api/orders/[id]/move/route.ts']) {
      const src = read(rel)
      expect(src.includes('tx.order.update('), rel).toBe(false)
    }
  })

  test('skupni seznam mutabilnih stanj je en sam vir (addItems in claim se ujemata)', () => {
    const ops = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'ops.ts'), 'utf8')
    expect(ops.includes("export const ORDER_MUTABLE_STATUS = ['open', 'sent', 'prepared'] as const")).toBe(true)
    expect(ops.includes("export const ORDER_MUTABLE_PAYMENT = ['unpaid', 'partial'] as const")).toBe(true)
    // addItems CAS v orders/[id] sme uporabljati ISTI belini (brez tretje kopije)
    const route = read('api/orders/[id]/route.ts')
    expect(route.includes("status: { in: ['open', 'sent', 'prepared'] }")).toBe(true)
  })

  test("'ocon-' je registriran v TEST_PREFIXES (samoceljivost fiksur)", () => {
    expect(TEST_PREFIXES).toContain(PREFIX)
  })
})
