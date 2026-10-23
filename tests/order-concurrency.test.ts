import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  claimMutableOrder, isMutableOrderState, ORDER_PAYABLE_STATUS, ORDER_MUTABLE_PAYMENT,
} from '../src/lib/ops'
import { PATCH as orderPATCH, DELETE as orderDELETE } from '../src/app/api/orders/[id]/route'
import { PATCH as kitchenPATCH } from '../src/app/api/kitchen/route'
import { POST as movePOST } from '../src/app/api/orders/[id]/move/route'
import { POST as mergePOST } from '../src/app/api/orders/[id]/merge/route'
import { POST as fursPOST } from '../src/app/api/furs/route'
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
 *  F) združevanje (#12): oba zapisa v tx + rollback premika postavk; SOČASNO
 *     plačilo vira meri NARAVNOZADETO determinističnost (natanko ena zmaga —
 *     v1.148.0 je moral plačilni CAS dobiti še status-pogoj)
 *  G) offline replay (sync) addItems na PREKLICANEM naročilu (#10) — deterministično
 *  H) pini vira: nobena od prizadetih rut nima več brezpogojnega zapisa stanja,
 *     plačilna pot (`issue.ts`) pa pogojuje tudi `status`
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
  // SIMULACIJA plačilne poti (`issueFursReceipt`) z ISTIMA pogojema zapisa kot
  // jedro (v1.148.0): `status IN ORDER_PAYABLE_STATUS` + `paymentStatus IN
  // ORDER_MUTABLE_PAYMENT`. Seznama sta UVOŽENA iz `src/lib/ops.ts`, ne
  // kopirana — sicer bi test lahko "zmagal" dirko, ki je v produkciji izgubljena.
  const paid = await db.order.updateMany({
    where: {
      id: orderId,
      status: { in: [...ORDER_PAYABLE_STATUS] },
      paymentStatus: { in: [...ORDER_MUTABLE_PAYMENT] },
    },
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
  let lockTimeouts = 0
  let checked = 0
  for (const delay of [0, 1, 2, 3, 5, 8, 12, 20, 30, 45]) {
    const tbl = await seedTable({ status: 'occupied' })
    const order = await seedOrder('sent', 'unpaid', tbl.id)
    const link = await seedLink(order.id)
    const call = kind === 'PATCH'
      ? orderPATCH(req(`/api/orders/${order.id}`, tok, 'PATCH', { status: 'CANCELLED', reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
      : orderDELETE(req(`/api/orders/${order.id}`, tok, 'DELETE', { reason: 'testni razlog preklica' }), { params: Promise.resolve({ id: order.id }) })
    await new Promise((r) => setTimeout(r, delay))
    let paidFirst: boolean
    try {
      paidFirst = await commitPayment(order.id)
    } catch (e) {
      // №29: SQLite dopušča samo ENEGA pisalca. Na počasnejšem stroju lahko
      // preklicni handler drži zaklep dlje, kot je Prisma-ov prag za odgovor baze,
      // in `updateMany` vrne P1008 (socket timeout). To je artefakt ponudnika, ne
      // izid dirke — zakasnitev prekinemo in jo ŠTEJEMO, nikoli pa ne utišamo
      // (glej zaključno trditev).
      const code = (e as { code?: string })?.code
      if (code !== 'P1008') throw e
      lockTimeouts++
      continue
    }
    const res = await call
    const row = await orderRow(order.id)
    const receipts = await db.receipt.count({ where: { orderId: order.id } })

    // VARNOSTNA INVARIANTA (finančna): nikoli preklicano naročilo z fiskaliziranim
    // računom — plačilo, ki je commitnilo PRED zapisom, mora preklic zavrniti.
    expect(row?.status === 'cancelled' && receipts > 0).toBe(false)
    checked++
    // plačilo, ki je commitnilo, vedno zmaga → naročilo ostane 'paid'
    if (paidFirst) expect(row?.status).toBe('paid')

    if (res.status === 409) {
      // Edini upravičen razlog za zavrnitev je že commitnjeno plačilo; 409 brez
      // njega pomeni, da preklic zavrne nekdo drug (npr. pokvarjen guard).
      expect(paidFirst, `409 brez commitnjenega plačila (delay ${delay} ms)`).toBe(true)
      // Zavrnjen preklic NE SME pustiti stranskih učinkov (prej: povezave
      // superseded, miza 'cleaning' in revizijski zapis preklica, ki se ni zgodil).
      expect((await db.payLink.findUnique({ where: { id: link.id } }))?.status).toBe('open')
      expect((await db.table.findUnique({ where: { id: tbl.id } }))?.status).toBe('occupied')
      expect(await countAudits(kind === 'PATCH' ? 'ORDER_STATUS_CANCELLED_OVERRIDE' : 'ORDER_CANCELLED', order.id)).toBe(0)
      expect(await db.eventLog.count({ where: { entityId: order.id, type: 'OrderCancelled' } })).toBe(0)
    }
  }
  return { lockTimeouts, checked }
}

describe('C — sočasno plačilo med preklicem (dirka čez zamike)', () => {
  /* №29 — trditve, vezane na prepletanje v realnem času, so razpolovljene. Na
   * GitLabovem deljenem stroju (pipeline #57, sha f9371d0) je `commitPayment`
   * dobil P1008 po 5174 ms in je test pustilo rdeče brez dokazanega prekrška;
   * izdaja v1.171.0 je odstranila še drugo takšno trditev. `rejections > 0` je
   * zahtevala, da plačilo na hitrejšem gostitelju v eni od desetih zamikanih dirk
   * pride pred zapisom preklica — na GitHub runnerju je padla (run 39935225480),
   * čeprav finančna invarianta ni bila kršena niti enkrat.
   * Dokaz je zdaj DVEKRAT in brez časovne odvisnosti:
   *   (1) deterministična primera, kjer vrstni red določimo z zaporedjem
   *       `await`-ov — tu je časovanje nepomembno in trditev velja vedno;
   *   (2) fuzz zanka z zamiki, ki preverja finančno invarianto za vsak dokončan
   *       poskus, zakasnitve zaklepa ŠTEJE (ne požre) in s `checked +
   *       lockTimeouts === 20` prepove tiho preskočen poskus. */
  test('deterministično A: plačilo commitnjeno PRED preklicem → preklic je 409 in brez sledi', async () => {
    for (const kind of ['PATCH', 'DELETE'] as const) {
      const tbl = await seedTable({ status: 'occupied' })
      const order = await seedOrder('sent', 'unpaid', tbl.id)
      const link = await seedLink(order.id)
      expect(await commitPayment(order.id)).toBe(true)
      const res = kind === 'PATCH'
        ? await orderPATCH(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { status: 'CANCELLED', reason: 'deterministic A' }), { params: Promise.resolve({ id: order.id }) })
        : await orderDELETE(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'DELETE', { reason: 'deterministic A' }), { params: Promise.resolve({ id: order.id }) })
      expect(res.status, kind).toBe(409)
      expect((await orderRow(order.id))?.status, kind).toBe('paid')
      expect((await db.payLink.findUnique({ where: { id: link.id } }))?.status, kind).toBe('open')
      expect((await db.table.findUnique({ where: { id: tbl.id } }))?.status, kind).toBe('occupied')
      expect(await db.eventLog.count({ where: { entityId: order.id, type: 'OrderCancelled' } }), kind).toBe(0)
    }
  })

  test('deterministično B: preklic zaključen PRED plačilom → commitPayment ne sme zapisati računa', async () => {
    const tbl = await seedTable({ status: 'occupied' })
    const order = await seedOrder('sent', 'unpaid', tbl.id)
    await seedLink(order.id)
    const res = await orderDELETE(req(`/api/orders/${order.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'DELETE', { reason: 'deterministic B' }), { params: Promise.resolve({ id: order.id }) })
    expect(res.status).toBe(200)
    expect(await commitPayment(order.id)).toBe(false) // pogojni UPDATE ne najde več plačljivega stanja
    expect(await db.receipt.count({ where: { orderId: order.id } })).toBe(0)
    expect((await orderRow(order.id))?.status).toBe('cancelled')
  })

  test("PATCH/DELETE dirka: nikoli 'cancelled' z fiskalnim računom", async () => {
    const patch = await raceSweep('PATCH')
    const del = await raceSweep('DELETE')
    // Kdo zmaga dirko, odloča hitrost stroja — zato test ne sme trditi, KDO je
    // zmagal, ampak samo, kaj mora veljati ne glede na to.
    // Prejšnja oblika `rejections > 0` je bila odvisna od gostitelja: na hosted
    // runnerju je preklic zmagal v vseh dvajsetih zamikih, finančna invarianta
    // ni bila kršena niti enkrat, test je vseeno padel na „Expected: > 0,
    // Received: 0" (run 39935225480, tests job, 23. 10. 09:55:04 UTC). Isti
    // podpis sem izmeril lokalno z začasnim posegom, ki preklic počaka PRED
    // `commitPayment`: vseh dvajset invariant je zelenih, trditev pa nič.
    // Prepletanje „plačilo pred preklicem → 409 in brez sledi" je sicer dokazano,
    // a deterministično — v primeru A zgoraj, za PATCH in DELETE.
    expect(patch.checked + patch.lockTimeouts + del.checked + del.lockTimeouts, 'dirka se mora končati v vseh 20 zamikih — tiho preskočen poskus je rdeč').toBe(20)
    // Izposoda zaklepa sme obstajati, ne sme pa postati tiha: dovoljena je ENA
    // na skupno dirko, sicer je test spet odvisen od hitrosti gostitelja.
    expect(patch.lockTimeouts + del.lockTimeouts, 'P1008 zakasnitev — preveč počasnih zaklepov').toBeLessThanOrEqual(1)
  }, 60_000)
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

  test('sočasno plačilo vira med združevanjem → natanko ENA zmaga, nikoli preklican plačan vir', async () => {
    const src = await seedOrder('sent', 'unpaid')
    const tgt = await seedOrder('sent', 'unpaid')
    await seedItem(src.id, 'preparing')
    const call = mergePOST(req(`/api/orders/${src.id}/merge`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })
    await new Promise((r) => setTimeout(r, 3))
    const paidFirst = await commitPayment(src.id)
    const res = await call
    const merged = res.status === 200
    const row = await orderRow(src.id)
    const receipts = await db.receipt.count({ where: { orderId: src.id } })
    // ZAMIK (3 ms) ne pove, katera stran je commitnila prva, zato test NE sklepa
    // iz časovnega vrstnega reda — izpita mora biti determinističen kar iz
    // izidov: obe strani pogojujeta Z ISTA dva pogoja (status IN plačljivih +
    // paymentStatus IN mutabilnih), edina možna izhoda sta torej PLAČILO ALI
    // ZDRUŽEVANJE, ne oba.
    // PREJ (v1.148.0 popravljeno): plačilna pot je pogojevala SAMO plačilno
    // stanje, združevanje pa na viru PUSTI `paymentStatus: 'unpaid'` → oba
    // "zmaga" in je bil fiskaliziran račun (ZOI/EOR) na 'cancelled' naročilu.
    expect(paidFirst && merged).toBe(false)
    expect(paidFirst || merged).toBe(true)
    // vedno veljajoča invarianta: nikoli preklicano naročilo z računom
    expect(row?.status === 'cancelled' && receipts > 0).toBe(false)
    if (paidFirst) {
      expect(res.status).toBe(409)
      expect(row?.status).toBe('paid')
      expect(receipts).toBe(1)
      // rollback: premik postavk je izničen, ciljno naročilo nespremenjeno
      expect(await db.orderItem.count({ where: { orderId: tgt.id } })).toBe(0)
      expect(await db.orderItem.count({ where: { orderId: src.id } })).toBe(1)
      expect(await countAudits('ORDER_MERGE', src.id)).toBe(0)
    } else {
      expect(row?.status).toBe('cancelled')
      expect(receipts).toBe(0)
      expect(await db.orderItem.count({ where: { orderId: tgt.id } })).toBe(1)
      expect(await countAudits('ORDER_MERGE', src.id)).toBe(1)
    }
  })

  /* DETERMINISTIČNI DOKAZ ISTE LUKNJE (v1.148.0): zgornji test meri dirko, katere
   * zmagovalna stran je odvisna od zaklopa SQLite — kontrolni pogoj zato NE sme
   * biti dirka. Spodaj je preostanek združitve ustvarjen NAMERNO in zaporedno,
   * nato pa se piše z OBEMA semantikama: staro (samo plačilni seznam) in novo
   * (plačilni + statusni seznam, kot ju zahteva `issue.ts`). */
  test('preostanek združitve (terminalen status + „unpaid") NI plačljiv — zapis je zavrnjen', async () => {
    const src = await seedOrder('sent', 'unpaid')
    const tgt = await seedOrder('sent', 'unpaid')
    await seedItem(src.id, 'preparing')
    expect((await mergePOST(req(`/api/orders/${src.id}/merge`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })).status).toBe(200)
    const row = await orderRow(src.id)
    // ZAVESTNO preostanek: `status` je terminalen, `paymentStatus` pa ostane
    // 'unpaid' (zgodovina plačil se ne izganja — merge/route.ts:110).
    expect(row?.status).toBe('cancelled')
    expect(row?.paymentStatus).toBe('unpaid')
    // (a) NOVA semantika (oba seznama, kot ju piše `issue.ts:506`) → 0 vrstic.
    const guarded = await db.order.updateMany({
      where: {
        id: src.id,
        status: { in: [...ORDER_PAYABLE_STATUS] },
        paymentStatus: { in: [...ORDER_MUTABLE_PAYMENT] },
      },
      data: { status: 'paid', paymentStatus: 'paid' },
    })
    expect(guarded.count).toBe(0)
    expect((await orderRow(src.id))?.status).toBe('cancelled')
    // (b) STARA semantika (samo plačilni seznam) → zapis bi USPEL. Če ta trditev
    //     kdaj pade, je bila luknja zaprta na drugem mestu, test F pa ni več
    //     dokaz ničesar — takrat ga je treba preoblikovati, ne samo utišati.
    const unguarded = await db.order.updateMany({
      where: { id: src.id, paymentStatus: { in: [...ORDER_MUTABLE_PAYMENT] } },
      data: { paymentMethod: 'card' },
    })
    expect(unguarded.count).toBe(1)
  })

  test('kanonična pot (POST /api/furs) na združenem viru → 409 BREZ računa', async () => {
    const src = await seedOrder('sent', 'unpaid')
    const tgt = await seedOrder('sent', 'unpaid')
    await seedItem(src.id, 'preparing')
    expect((await mergePOST(req(`/api/orders/${src.id}/merge`, tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { targetOrderId: tgt.id }), { params: Promise.resolve({ id: src.id }) })).status).toBe(200)
    const res = await fursPOST(req('/api/furs', tokenFor(waiterId, 'w', 'WAITER', locId), 'POST', { orderId: src.id, type: 'cash' }))
    expect(res.status).toBe(409)
    expect(await db.receipt.count({ where: { orderId: src.id } })).toBe(0)
    const row = await orderRow(src.id)
    expect(row?.status).toBe('cancelled')
    // plačilo ne sme pustiti nobenega sledu: plačilno stanje in čas plačila
    // ostaneta kot pred zavrnjenim klicem (razen združitvenega preklica)
    expect(row?.paymentStatus).toBe('unpaid')
    expect(row?.paidAt).toBeNull()
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

  test('plačilna pot pogojuje tudi STATUS — ne samo plačilnega stanja (v1.148.0)', () => {
    const ops = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'ops.ts'), 'utf8')
    const issue = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'furs', 'issue.ts'), 'utf8')
    // Plačljivo stanje = mutabilni trije PLUS 'paid' (ročno označen 'paid' brez
    // računa sme kanonična pot še izdati račun). 'cancelled' in 'storno' NISTA na
    // seznamu — prav ta mora veljati OB ZAPISU, sicer preklic ali združevanje, ki
    // commitneta med branjem in plačilno transakcijo, pusti fiskaliziran račun na
    // naročilu, ki ga v dejanskem delovnem toku ni več.
    expect(ops.includes("export const ORDER_PAYABLE_STATUS = [...ORDER_MUTABLE_STATUS, 'paid'] as const")).toBe(true)
    // vsi trije zapisi stanja v plačilni poti (glavni CAS, check-settle, partial)
    // morajo nositi status-pogoj; doslej je bil samo paymentStatus
    const guarded = issue.match(/status: \{ in: \[\.\.\.ORDER_PAYABLE_STATUS\] \}/g) ?? []
    expect(guarded.length).toBe(3)
    // branje plačilne poti (guard PREJ, pred transakcijo) uporablja ISTI seznam
    expect(issue.includes('ORDER_PAYABLE_STATUS as readonly string[]')).toBe(true)
    // in nima nikoli brezpogojnega zapisa naročila
    expect(issue).not.toMatch(/tx\.order\.update\(/)
    expect(issue).not.toMatch(/db\.order\.update\(/)
  })
})
