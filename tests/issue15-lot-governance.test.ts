/**
 * Issue #15 (P1, v1.105.0) — lot governance + sledljivost serij.
 *
 * Pokrito:
 *  A. ČISTA MATEMATIKA (lot-governance): klasifikacija batchBucket (recall >
 *     karantena > poteklo > odstranitev > izčrpano > brez roka > opozorilo > ok),
 *     validacija datuma (alert ≤ removal ≤ expiry), FEFO vrstni red
 *     (removalDate ?? expiryDate, nulls ZADNJI — dialekt-deterministično);
 *  B. FEFO VAROVALKE (deductStockForOrderTx): karantena/odpoklic/poteklo so
 *     IZKLJUČENI iz nove razknjižbe (količina blokirane serije se NE spremeni);
 *     legacy 'active' (male črke, receive pot ≤ v1.104) JE vključen;
 *     vrzel je VIDLJIVA v note (blokirane/potekle serije izrecno navedene);
 *     pre-DDL degradacija (cache=false → legacy where/select) NE podre prodaje;
 *  C. KARANTENA/ODPOKIC/SPROSTITEV (rute): hold z razlogom ≥10 → QUARANTINE +
 *     audit + hold sled; kratek razlog → 400; hold na RECALLED → 409;
 *     recall → RECALLED (terminalen) + supplierNotified; drugi recall → 409;
 *     release iz karantene z razlogom → ACTIVE + audit; release RECALLED → 409;
 *     release ACTIVE → 409; waiter (brez inventory.manage) → 403;
 *     manager druge lokacije → 403 (tenant izolacija);
 *  D. DATUMI (PATCH /batches): veljavni alert/removal → 200 + LOT_DATES_SET
 *     dogodek; napačen vrstni red → 400; waiter → 403;
 *  E. SEZNAMI (GET /batches?filter=): expired/quarantine/recalled/unknown/
 *     expiring klasifikacija + uporabne (brez blokiranih);
 *  F. SLEDTĽIVOST (GET /batches/[id]/trace): dokazane SALE alokacije →
 *     exposedOrders z jedmi; summary (prejeto = zaloga + dodeljeno − vračila);
 *     priprava = posredna (indirect); CSV izvoz (Content-Disposition + BOM);
 *     tuja lokacija → 403;
 *  G. LOT ALERT (cron pure): prvi opomnik, brez ponovitve istega dne, re-arm
 *     ob premiku alertDate v prihodnost;
 *  H. REGISTER: SCHEMA_MIGRATIONS vsebuje lot-governance (18 vnosov) +
 *     i18n SL/HR opis; DDL ruta idempotentna (sqlite že ima stolpce →
 *     alreadyApplied) + manager (ni centralna vloga) → 403.
 *
 * Fiksture s predpono i15- (TEST_PREFIXES); naročila ročno zbrana.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { nid, num } from '../src/lib/map'
import type { Prisma } from '@prisma/client'
import {
  batchBucket,
  validateLotDates,
  sortUsableFefo,
  isBlockedStatus,
  __setLotGovernanceCacheForTests,
  __resetLotGovernanceCacheForTests,
} from '../src/lib/lot-governance'
import { shouldSendLotAlert, lotAlertBody } from '../src/lib/lot-alert'
import { deductStockForOrderTx } from '../src/lib/inventory'
import { GET as batchesGET, PATCH as batchesPATCH } from '../src/app/api/inventory/batches/route'
import { POST as holdPOST } from '../src/app/api/inventory/batches/[id]/hold/route'
import { POST as recallPOST } from '../src/app/api/inventory/batches/[id]/recall/route'
import { POST as releasePOST } from '../src/app/api/inventory/batches/[id]/release/route'
import { GET as traceGET } from '../src/app/api/inventory/batches/[id]/trace/route'
import { POST as ddlPOST } from '../src/app/api/admin/migrate-lot-governance/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { sl as slDict } from '../src/lib/i18n/sl'
import { hr as hrDict } from '../src/lib/i18n/hr'

const P = 'i15-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TS = Date.now()

type Tx = Prisma.TransactionClient

let locA = ''
let locB = ''
let mgrA = ''
let mgrB = ''
let waiterA = ''
let ownerA = ''
let tokA = ''
let tokB = ''
let tokWaiter = ''
let tokOwner = ''

let menuId = ''
let catId = ''
let miId = ''
let invItem = ''

const createdOrders: string[] = []
const createdBatches: string[] = []

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

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

interface MkBatchOpts {
  qty: number
  expiryInDays?: number | null
  alertInDays?: number | null
  removalInDays?: number | null
  status?: string
  receivedOffsetMin?: number
  lot?: string
}

async function mkBatch(opts: MkBatchOpts) {
  const id = nid()
  createdBatches.push(id)
  return db.inventoryBatch.create({
    data: {
      id,
      inventoryItemId: invItem,
      locationId: locA,
      lotNumber: opts.lot || `${P}lot-${id.slice(0, 8)}`,
      receivedAt: new Date(TS - (opts.receivedOffsetMin ?? 60) * 60_000),
      expiryDate: opts.expiryInDays === null || opts.expiryInDays === undefined ? null : new Date(TS + opts.expiryInDays * 86_400_000),
      alertDate: opts.alertInDays === null || opts.alertInDays === undefined ? null : new Date(TS + opts.alertInDays * 86_400_000),
      removalDate: opts.removalInDays === null || opts.removalInDays === undefined ? null : new Date(TS + opts.removalInDays * 86_400_000),
      quantityInitial: opts.qty,
      quantityRemaining: opts.qty,
      unit: 'kg',
      status: opts.status || 'ACTIVE',
    },
  })
}

/** skrajšana pot: naročilo z 1 postavko (receptura invItem × qty) + razknjižba */
async function sellAndDeduct(qty: number): Promise<{ orderId: string; res: Awaited<ReturnType<typeof deductStockForOrderTx>> }> {
  const orderId = nid()
  createdOrders.push(orderId)
  await db.order.create({
    data: { id: orderId, orderNumber: 860000 + Math.floor(Math.random() * 99999), locationId: locA, status: 'paid', paymentStatus: 'paid', type: 'takeaway' },
  })
  await db.orderItem.create({ data: { id: nid(), orderId, menuItemId: miId, quantity: Math.max(1, qty), price: 10, vatRate: 22, menuItemName: `${P}test jed` } })
  const res = await deductStockForOrderTx(db as unknown as Tx, orderId, null, 'test')
  return { orderId, res }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  const la = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `I15A-${RUN.toUpperCase()}` } })
  const lb = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `I15B-${RUN.toUpperCase()}` } })
  locA = la.id
  locB = lb.id
  mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  mgrB = await seedEmployee('mgrB', 'manager', locB, 2)
  waiterA = await seedEmployee('waiterA', 'waiter', locA, 3)
  ownerA = await seedEmployee('ownerA', 'owner', locA, 4)
  tokA = createToken({ sub: mgrA, name: `${P}mgrA`, role: 'MANAGER', loc: locA, sv: 0 })
  tokB = createToken({ sub: mgrB, name: `${P}mgrB`, role: 'MANAGER', loc: locB, sv: 0 })
  tokWaiter = createToken({ sub: waiterA, name: `${P}waiterA`, role: 'WAITER', loc: locA, sv: 0 })
  tokOwner = createToken({ sub: ownerA, name: `${P}ownerA`, role: 'OWNER', loc: locA, sv: 0 })

  menuId = `${P}menu-${RUN}`
  catId = `${P}cat-${RUN}`
  miId = `${P}mi-${RUN}`
  invItem = `${P}inv-${RUN}`
  await db.menu.create({ data: { id: menuId, name: `${P}Meni`, locationId: locA } })
  await db.category.create({ data: { id: catId, name: `${P}Kategorija`, menuId } })
  await db.menuItem.create({ data: { id: miId, name: `${P}Test jed`, price: 10, categoryId: catId, vatRate: 22 } })
  await db.inventoryItem.create({ data: { id: invItem, name: `${P}Sestavina`, unit: 'kg', quantity: 0, costPerUnit: 2, locationId: locA } })
  await db.recipeItem.create({ data: { id: nid(), menuItemId: miId, inventoryItemId: invItem, quantityPerServing: 1, unit: 'kg', yieldPercent: 100 } })
})

afterAll(async () => {
  for (const oid of createdOrders) {
    await db.orderItem.deleteMany({ where: { orderId: oid } }).catch(() => null)
    await db.order.deleteMany({ where: { id: oid } }).catch(() => null)
  }
  // alokacije čez i15 serije (FK na StockTransaction — zbriši prek TX)
  for (const bid of createdBatches) {
    const allocs = await db.stockBatchAllocation.findMany({ where: { batchId: bid }, select: { stockTransactionId: true } })
    const txIds = [...new Set(allocs.map((a) => a.stockTransactionId))]
    if (txIds.length > 0) {
      await db.stockTransaction.deleteMany({ where: { id: { in: txIds } } }).catch(() => null)
    }
    await db.stockBatchAllocation.deleteMany({ where: { batchId: bid } }).catch(() => null)
  }
  await sweepTestFixtures(db, [P])
})

/* ═══════════ A. čista matematika ═══════════ */

describe('A. lot-governance čista matematika', () => {
  it('batchBucket: recall premaga karanteno, karantena poteklost, poteklost odstranitev', () => {
    const now = new Date()
    const base = { quantityRemaining: 5 }
    expect(batchBucket({ ...base, status: 'RECALLED', expiryDate: null }, now)).toBe('recalled')
    expect(batchBucket({ ...base, status: 'QUARANTINE', expiryDate: null }, now)).toBe('quarantined')
    // karantena + poteklo → karantena (blokada je hujša od roka za odločanje)
    expect(batchBucket({ ...base, status: 'QUARANTINE', expiryDate: new Date(now.getTime() - 86_400_000) }, now)).toBe('quarantined')
    expect(batchBucket({ ...base, status: 'ACTIVE', expiryDate: new Date(now.getTime() - 86_400_000) }, now)).toBe('expired')
    expect(batchBucket({ ...base, status: 'ACTIVE', expiryDate: new Date(now.getTime() + 5 * 86_400_000), removalDate: new Date(now.getTime() - 1) }, now)).toBe('removal_due')
    expect(batchBucket({ ...base, status: 'ACTIVE', expiryDate: null }, now)).toBe('unknown_expiry')
    expect(batchBucket({ ...base, status: 'ACTIVE', expiryDate: new Date(now.getTime() + 5 * 86_400_000) }, now)).toBe('alert')
    expect(batchBucket({ ...base, status: 'ACTIVE', expiryDate: new Date(now.getTime() + 30 * 86_400_000) }, now)).toBe('ok')
    expect(batchBucket({ ...base, status: 'ACTIVE', expiryDate: new Date(now.getTime() + 30 * 86_400_000), alertDate: new Date(now.getTime() + 3 * 86_400_000) }, now)).toBe('ok')
    expect(batchBucket({ quantityRemaining: 0, status: 'ACTIVE', expiryDate: new Date(now.getTime() + 5 * 86_400_000) }, now)).toBe('exhausted')
  })

  it('isBlockedStatus: QUARANTINE/RECALLED (tudi male črke) blokirata; ACTIVE ne', () => {
    expect(isBlockedStatus('QUARANTINE')).toBe(true)
    expect(isBlockedStatus('RECALLED')).toBe(true)
    expect(isBlockedStatus('quarantine')).toBe(true)
    expect(isBlockedStatus('ACTIVE')).toBe(false)
    expect(isBlockedStatus(null)).toBe(false)
  })

  it('validateLotDates: alert ≤ removal ≤ expiry (vsaj dve izpolnjeni)', () => {
    const d = (days: number) => new Date(TS + days * 86_400_000)
    expect(validateLotDates({ alertDate: d(1), removalDate: d(2), expiryDate: d(3) }).ok).toBe(true)
    expect(validateLotDates({ alertDate: d(3), removalDate: d(2) }).ok).toBe(false)
    expect(validateLotDates({ alertDate: d(5), expiryDate: d(3) }).ok).toBe(false)
    expect(validateLotDates({ removalDate: d(5), expiryDate: d(3) }).ok).toBe(false)
    expect(validateLotDates({ alertDate: null, removalDate: null, expiryDate: null }).ok).toBe(true)
    expect(validateLotDates({ alertDate: d(2), removalDate: d(2), expiryDate: d(2) }).ok).toBe(true)
  })

  it('sortUsableFefo: removalDate ?? expiryDate; NULL rok zadnji; receivedAt odloča izenačena', () => {
    const mk = (id: string, exp: number | null, rem: number | null, recMin: number) => ({
      id,
      expiryDate: exp === null ? null : new Date(TS + exp * 86_400_000),
      removalDate: rem === null ? null : new Date(TS + rem * 86_400_000),
      receivedAt: new Date(TS - recMin * 60_000),
    })
    const sorted = sortUsableFefo([
      mk('null', null, null, 30),
      mk('late', 10, null, 30),
      mk('removal-first', 10, 2, 30),
      mk('early', 3, null, 30),
      mk('early-old', 3, null, 90), // isti rok, starejši sprejem → prej
    ])
    expect(sorted.map((s) => s.id)).toEqual(['removal-first', 'early-old', 'early', 'late', 'null'])
  })
})

/* ═══════════ B. FEFO varovalke ═══════════ */

describe('B. FEFO varovalke (deductStockForOrderTx)', () => {
  it('karantena: blokirana serija IZKLJUČENA iz razknjižbe — količina nespremenjena, vrzel vidna v note', async () => {
    __setLotGovernanceCacheForTests(true)
    const blocked = await mkBatch({ qty: 10, expiryInDays: 30, status: 'QUARANTINE' })
    const usable = await mkBatch({ qty: 1, expiryInDays: 5 })
    await db.inventoryItem.update({ where: { id: invItem }, data: { quantity: 11 } })
    const { res } = await sellAndDeduct(5)
    expect(res.deducted).toBe(true)
    // količina agregata pada (11 → 6)...
    const inv = await db.inventoryItem.findUnique({ where: { id: invItem }, select: { quantity: true } })
    expect(num(inv?.quantity)).toBe(6)
    // ...BLOKIRANA serija se NI spremenila
    const b = await db.inventoryBatch.findUnique({ where: { id: blocked.id }, select: { quantityRemaining: true, status: true } })
    expect(num(b?.quantityRemaining)).toBe(10)
    expect(b?.status).toBe('QUARANTINE')
    // uporabna serija je pokrila 1 kg od 5 (izčrpala se je)
    const u = await db.inventoryBatch.findUnique({ where: { id: usable.id }, select: { quantityRemaining: true, status: true } })
    expect(num(u?.quantityRemaining)).toBe(0)
    expect(u?.status).toBe('EXHAUSTED')
    // vrzel vidna v note SALE transakcije
    const sale = await db.stockTransaction.findFirst({ where: { orderId: createdOrders.at(-1), type: 'SALE' }, select: { note: true } })
    expect(sale?.note || '').toContain('blokirane serije')
    expect(sale?.note || '').toContain('10 kg')
  })

  it('odpoklic (RECALLED): izključen enako kot karantena', async () => {
    const recalled = await mkBatch({ qty: 4, expiryInDays: 30, status: 'RECALLED' })
    await db.inventoryItem.update({ where: { id: invItem }, data: { quantity: 4 } })
    const { res } = await sellAndDeduct(1)
    expect(res.deducted).toBe(true)
    const b = await db.inventoryBatch.findUnique({ where: { id: recalled.id }, select: { quantityRemaining: true } })
    expect(num(b?.quantityRemaining)).toBe(4)
    // BREZ uporabne serije: odjem je "brez serije" — vrzel je v note
    const sale = await db.stockTransaction.findFirst({ where: { orderId: createdOrders.at(-1), type: 'SALE' }, select: { note: true } })
    expect(sale?.note || '').toContain('blokirane serije')
    const allocs = await db.stockBatchAllocation.findMany({ where: { batchId: recalled.id } })
    expect(allocs.length).toBe(0)
  })

  it('potekla serija: izključena iz FEFO (ne "najprej"!) — uporabna serija pokrije, vrzel vidna', async () => {
    const expired = await mkBatch({ qty: 8, expiryInDays: -2 })
    const usable = await mkBatch({ qty: 2, expiryInDays: 9 })
    await db.inventoryItem.update({ where: { id: invItem }, data: { quantity: 10 } })
    await sellAndDeduct(4)
    const e = await db.inventoryBatch.findUnique({ where: { id: expired.id }, select: { quantityRemaining: true } })
    const u = await db.inventoryBatch.findUnique({ where: { id: usable.id }, select: { quantityRemaining: true } })
    expect(num(e?.quantityRemaining)).toBe(8)
    expect(num(u?.quantityRemaining)).toBe(0)
    const sale = await db.stockTransaction.findFirst({ where: { orderId: createdOrders.at(-1), type: 'SALE' }, select: { note: true } })
    expect(sale?.note || '').toContain('potekle serije')
    expect(sale?.note || '').toContain('8 kg')
  })

  it('removalDate pretekel: serija ni več razpoložljiva (odstranitev pred rokom)', async () => {
    const removed = await mkBatch({ qty: 6, expiryInDays: 30, removalInDays: -1 })
    await db.inventoryItem.update({ where: { id: invItem }, data: { quantity: 6 } })
    await sellAndDeduct(1)
    const b = await db.inventoryBatch.findUnique({ where: { id: removed.id }, select: { quantityRemaining: true } })
    expect(num(b?.quantityRemaining)).toBe(6)
  })

  it("legacy 'active' (male črke, receive pot ≤ v1.104): JE vključen v FEFO", async () => {
    const legacy = await mkBatch({ qty: 5, expiryInDays: 20, status: 'active' })
    await db.inventoryItem.update({ where: { id: invItem }, data: { quantity: 5 } })
    await sellAndDeduct(1)
    const b = await db.inventoryBatch.findUnique({ where: { id: legacy.id }, select: { quantityRemaining: true } })
    expect(num(b?.quantityRemaining)).toBe(4)
    const allocs = await db.stockBatchAllocation.findMany({ where: { batchId: legacy.id } })
    expect(allocs.length).toBe(1)
    expect(num(allocs[0].quantity)).toBe(1)
  })

  it('brez roka (null): uporabna, a FEFO ZADNJA (za datiranimi serijami)', async () => {
    const noDate = await mkBatch({ qty: 3, expiryInDays: null, receivedOffsetMin: 30 })
    const dated = await mkBatch({ qty: 9, expiryInDays: 15, receivedOffsetMin: 90 })
    await db.inventoryItem.update({ where: { id: invItem }, data: { quantity: 12 } })
    await sellAndDeduct(2)
    const n = await db.inventoryBatch.findUnique({ where: { id: noDate.id }, select: { quantityRemaining: true } })
    const d = await db.inventoryBatch.findUnique({ where: { id: dated.id }, select: { quantityRemaining: true } })
    expect(num(n?.quantityRemaining)).toBe(3) // nedotaknjena — datirana je šla prva
    expect(num(d?.quantityRemaining)).toBe(7)
  })

  it('pre-DDL degradacija (cache=false → legacy where/select): prodaja NE pade na šemo', async () => {
    __setLotGovernanceCacheForTests(false)
    try {
      const usable = await mkBatch({ qty: 3, expiryInDays: 12 })
      await db.inventoryItem.update({ where: { id: invItem }, data: { quantity: 3 } })
      const { res } = await sellAndDeduct(1)
      expect(res.deducted).toBe(true)
      const b = await db.inventoryBatch.findUnique({ where: { id: usable.id }, select: { quantityRemaining: true } })
      expect(num(b?.quantityRemaining)).toBe(2)
      const allocs = await db.stockBatchAllocation.findMany({ where: { batchId: usable.id } })
      expect(allocs.length).toBe(1)
    } finally {
      __resetLotGovernanceCacheForTests()
    }
  })
})

/* ═══════════ C. karantena / odpoklic / sprostitev ═══════════ */

describe('C. hold / recall / release rute', () => {
  it('hold: veljaven razlog → QUARANTINE + audit + hold sled', async () => {
    const b = await mkBatch({ qty: 7, expiryInDays: 40 })
    const r = await holdPOST(req('POST', `/api/inventory/batches/${b.id}/hold`, tokA, { reason: 'Sum na kontaminacijo salonele' }), params(b.id))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.status).toBe('QUARANTINE')
    const after = await db.inventoryBatch.findUnique({ where: { id: b.id } })
    expect(after?.status).toBe('QUARANTINE')
    expect(after?.holdReason).toContain('kontaminacijo')
    expect(after?.holdAt).toBeTruthy()
    expect(after?.holdById).toBe(mgrA)
    const audit = await db.auditLog.findFirst({ where: { action: 'BATCH_QUARANTINED', entityId: b.id } })
    expect(audit).toBeTruthy()
    const ev = await db.eventLog.findFirst({ where: { type: 'LOT_BLOCKED', entityId: b.id } })
    expect(ev).toBeTruthy()
  })

  it('hold: kratek razlog → 400; neavtoriziran (waiter) → 403', async () => {
    const b = await mkBatch({ qty: 2, expiryInDays: 40 })
    const r1 = await holdPOST(req('POST', `/api/inventory/batches/${b.id}/hold`, tokA, { reason: 'kratko' }), params(b.id))
    expect(r1.status).toBe(400)
    const r2 = await holdPOST(req('POST', `/api/inventory/batches/${b.id}/hold`, tokWaiter, { reason: 'Zadosti dolg razlog za test' }), params(b.id))
    expect(r2.status).toBe(403)
  })

  it('hold: tuja lokacija → 403; hold na RECALLED → 409', async () => {
    const b = await mkBatch({ qty: 2, expiryInDays: 40 })
    const r1 = await holdPOST(req('POST', `/api/inventory/batches/${b.id}/hold`, tokB, { reason: 'Tuji upravljalec poskuša blokado' }), params(b.id))
    expect(r1.status).toBe(403)
    const rc = await mkBatch({ qty: 2, expiryInDays: 40, status: 'RECALLED' })
    const r2 = await holdPOST(req('POST', `/api/inventory/batches/${rc.id}/hold`, tokA, { reason: 'Karantena po odpoklicu ni mogoča' }), params(rc.id))
    expect(r2.status).toBe(409)
  })

  it('recall: veljaven → RECALLED (terminalen) + audit + supplierNotified', async () => {
    const b = await mkBatch({ qty: 5, expiryInDays: 40 })
    const r = await recallPOST(req('POST', `/api/inventory/batches/${b.id}/recall`, tokA, { reason: 'Obvestilo dobavitelja o salmoneli', supplierNotified: true, ref: 'ODP-2026-001' }), params(b.id))
    expect(r.status).toBe(200)
    const after = await db.inventoryBatch.findUnique({ where: { id: b.id } })
    expect(after?.status).toBe('RECALLED')
    expect(after?.holdReason).toContain('ODPOKlic')
    expect(after?.holdRef).toBe('ODP-2026-001')
    const audit = await db.auditLog.findFirst({ where: { action: 'BATCH_RECALLED', entityId: b.id } })
    expect(audit).toBeTruthy()
    expect(String(audit?.details)).toContain('"supplierNotified":true')
    // drugi recall → 409 (terminalen)
    const r2 = await recallPOST(req('POST', `/api/inventory/batches/${b.id}/recall`, tokA, { reason: 'Ponoven poskus odpoklica iste serije' }), params(b.id))
    expect(r2.status).toBe(409)
  })

  it('release: QUARANTINE → ACTIVE z razlogom + audit; kratek → 400; RECALLED → 409; ACTIVE → 409', async () => {
    const q = await mkBatch({ qty: 5, expiryInDays: 40 })
    await holdPOST(req('POST', `/api/inventory/batches/${q.id}/hold`, tokA, { reason: 'Začasna blokada za pregled vzorca' }), params(q.id))
    const r = await releasePOST(req('POST', `/api/inventory/batches/${q.id}/release`, tokA, { note: 'Laboratorijska analiza negativna, sprostitev' }), params(q.id))
    expect(r.status).toBe(200)
    const after = await db.inventoryBatch.findUnique({ where: { id: q.id } })
    expect(after?.status).toBe('ACTIVE')
    expect(after?.releaseNote).toContain('negativna')
    expect(after?.releaseById).toBe(mgrA)
    const audit = await db.auditLog.findFirst({ where: { action: 'BATCH_RELEASED', entityId: q.id } })
    expect(audit).toBeTruthy()

    // kratek note → 400
    const q2 = await mkBatch({ qty: 1, expiryInDays: 40 })
    await holdPOST(req('POST', `/api/inventory/batches/${q2.id}/hold`, tokA, { reason: 'Druga začasna blokada serije' }), params(q2.id))
    const rShort = await releasePOST(req('POST', `/api/inventory/batches/${q2.id}/release`, tokA, { note: 'kratko' }), params(q2.id))
    expect(rShort.status).toBe(400)

    // release RECALLED → 409 (terminalen)
    const rc = await mkBatch({ qty: 1, expiryInDays: 40, status: 'RECALLED' })
    const rRec = await releasePOST(req('POST', `/api/inventory/batches/${rc.id}/release`, tokA, { note: 'Poskus sprostitve odpoklicane serije' }), params(rc.id))
    expect(rRec.status).toBe(409)

    // release ACTIVE (brez karantene) → 409
    const ok = await mkBatch({ qty: 1, expiryInDays: 40 })
    const rActive = await releasePOST(req('POST', `/api/inventory/batches/${ok.id}/release`, tokA, { note: 'Ni karantene za sprostiti' }), params(ok.id))
    expect(rActive.status).toBe(409)

    // waiter → 403
    const q3 = await mkBatch({ qty: 1, expiryInDays: 40 })
    await holdPOST(req('POST', `/api/inventory/batches/${q3.id}/hold`, tokA, { reason: 'Tretja blokada za test pravic' }), params(q3.id))
    const rWaiter = await releasePOST(req('POST', `/api/inventory/batches/${q3.id}/release`, tokWaiter, { note: 'Natakar poskuša sprostiti serijo' }), params(q3.id))
    expect(rWaiter.status).toBe(403)
  })
})

/* ═══════════ D. datumi (PATCH) ═══════════ */

describe('D. PATCH /api/inventory/batches (datumi)', () => {
  it('veljavni alert/removal → 200 + LOT_DATES_SET dogodek', async () => {
    const b = await mkBatch({ qty: 3, expiryInDays: 30 })
    const alert = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const removal = new Date(Date.now() + 10 * 86_400_000).toISOString()
    const r = await batchesPATCH(req('PATCH', '/api/inventory/batches', tokA, { id: b.id, alertDate: alert, removalDate: removal }))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.alertDate).toBeTruthy()
    const after = await db.inventoryBatch.findUnique({ where: { id: b.id } })
    expect(after?.alertDate).toBeTruthy()
    expect(after?.removalDate).toBeTruthy()
    const ev = await db.eventLog.findFirst({ where: { type: 'LOT_DATES_SET', entityId: b.id } })
    expect(ev).toBeTruthy()
  })

  it('napačen vrstni red (alert > expiry) → 400; waiter → 403', async () => {
    const b = await mkBatch({ qty: 3, expiryInDays: 5 })
    const bad = new Date(Date.now() + 20 * 86_400_000).toISOString()
    const r = await batchesPATCH(req('PATCH', '/api/inventory/batches', tokA, { id: b.id, alertDate: bad }))
    expect(r.status).toBe(400)
    const r2 = await batchesPATCH(req('PATCH', '/api/inventory/batches', tokWaiter, { id: b.id }))
    expect(r2.status).toBe(403)
  })
})

/* ═══════════ E. seznami (GET filter) ═══════════ */

describe('E. GET /api/inventory/batches?filter=', () => {
  it('filter=expired pokaze preteclo; quarantine/recalled/unknown/expiring klasificirajo', async () => {
    const expired = await mkBatch({ qty: 2, expiryInDays: -3, lot: `${P}F-EXPIRED-${RUN}` })
    const quar = await mkBatch({ qty: 2, expiryInDays: 40, status: 'QUARANTINE', lot: `${P}F-QUAR-${RUN}` })
    const rec = await mkBatch({ qty: 2, expiryInDays: 40, status: 'RECALLED', lot: `${P}F-REC-${RUN}` })
    const unknown = await mkBatch({ qty: 2, expiryInDays: null, lot: `${P}F-UNK-${RUN}` })
    const soon = await mkBatch({ qty: 2, expiryInDays: 4, lot: `${P}F-SOON-${RUN}` })

    const g = async (f: string) => {
      const r = await batchesGET(req('GET', `/api/inventory/batches?filter=${f}&take=200`, tokA))
      const j = await body(r)
      return (j.batches as { id: string }[]).map((b) => b.id)
    }
    const expiredList = await g('expired')
    expect(expiredList).toContain(expired.id)
    expect(expiredList).not.toContain(soon.id)
    expect((await g('quarantine'))).toContain(quar.id)
    expect((await g('recalled'))).toContain(rec.id)
    expect((await g('unknown'))).toContain(unknown.id)
    const expiring = await g('expiring')
    expect(expiring).toContain(soon.id)
    // uporabne (default): brez blokiranih in pretečenih
    const usable = await g('usable')
    expect(usable).not.toContain(expired.id)
    expect(usable).not.toContain(quar.id)
    expect(usable).not.toContain(rec.id)
    expect(usable).toContain(soon.id)
    expect(usable).toContain(unknown.id)
  })

  it('manager druge lokacije ne vidi serij lokacije A', async () => {
    const b = await mkBatch({ qty: 2, expiryInDays: 10 })
    const r = await batchesGET(req('GET', `/api/inventory/batches?filter=all&take=200`, tokB))
    const j = await body(r)
    const ids = (j.batches as { id: string }[]).map((x) => x.id)
    expect(ids).not.toContain(b.id)
  })
})

/* ═══════════ F. sledljivost (trace) ═══════════ */

describe('F. GET /api/inventory/batches/[id]/trace', () => {
  it('dokazane SALE alokacije → exposedOrders + summary matematika + CSV', async () => {
    // NAJRANEJŠI rok od vseh serij artikla (ostanki prejšnjih testov imajo 5–20 dni)
    // → FEFO vzame NAJPREJ to serijo, da je poročilo deterministično
    const b = await mkBatch({ qty: 10, expiryInDays: 1 })
    await db.inventoryItem.update({ where: { id: invItem }, data: { quantity: 10 } })
    const { orderId } = await sellAndDeduct(1)
    // drugo naročilo porabi še 1
    await sellAndDeduct(1)

    const r = await traceGET(req('GET', `/api/inventory/batches/${b.id}/trace`, tokA), params(b.id))
    expect(r.status).toBe(200)
    const j = await body(r)
    const summary = j.summary as Record<string, number>
    expect(summary.received).toBe(10)
    expect(summary.onStock).toBe(8)
    expect(summary.allocatedOut).toBe(2)
    expect(summary.crossCheckOk).toBe(true)
    const allocs = j.allocations as { type: string; quantity: number; indirect: boolean; orderId: string | null }[]
    expect(allocs.length).toBe(2)
    expect(allocs[0].type).toBe('SALE')
    expect(allocs.every((a) => !a.indirect)).toBe(true)
    const exposed = j.exposedOrders as { orderId: string; quantityFromLot: number; items: { name: string }[] }[]
    expect(exposed.length).toBeGreaterThanOrEqual(1)
    expect(exposed.some((e) => e.orderId === orderId)).toBe(true)
    expect(exposed[0].items.length).toBeGreaterThan(0)
    // negotovost je izrecna
    const unc = j.uncertainty as Record<string, string>
    expect(unc.prepIndirect).toBeTruthy()
    expect(unc.noLotClaim).toBeTruthy()

    // CSV izvoz
    const rc = await traceGET(req('GET', `/api/inventory/batches/${b.id}/trace?format=csv`, tokA), params(b.id))
    expect(rc.status).toBe(200)
    expect(rc.headers.get('content-type')).toContain('text/csv')
    expect(rc.headers.get('content-disposition') || '').toContain('.csv')
    const text = await rc.text()
    expect(text.startsWith('﻿')).toBe(true) // BOM
    expect(text).toContain('RestaurantOS sledljivostno poročilo')
    expect(text).toContain('SALE')
  })

  it('serija brez alokacij: prazna lista + VRZEL razložena; tuja lokacija → 403; waiter → 403', async () => {
    const b = await mkBatch({ qty: 1, expiryInDays: 50 })
    const r = await traceGET(req('GET', `/api/inventory/batches/${b.id}/trace`, tokA), params(b.id))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect((j.allocations as unknown[]).length).toBe(0)
    expect((j.summary as Record<string, unknown>).untrackedExplanation).toBeTruthy()

    const rB = await traceGET(req('GET', `/api/inventory/batches/${b.id}/trace`, tokB), params(b.id))
    expect(rB.status).toBe(403)
    const rW = await traceGET(req('GET', `/api/inventory/batches/${b.id}/trace`, tokWaiter), params(b.id))
    expect(rW.status).toBe(403)
  })
})

/* ═══════════ G. lot alert (cron pure) ═══════════ */

describe('G. lot alert — čista pravila', () => {
  it('prvi opomnik; brez ponovitve; re-arm ob premiku alertDate', () => {
    const now = new Date()
    const past = new Date(now.getTime() - 86_400_000)
    const future = new Date(now.getTime() + 5 * 86_400_000)
    // pretekel alertDate + brez prejšnjega → pošlji
    expect(shouldSendLotAlert(past, now, undefined)).toBe(true)
    // že opomnjen (po alertDate) → NE ponovi
    const lastAfter = new Date(past.getTime() + 3600_000).toISOString()
    expect(shouldSendLotAlert(past, now, lastAfter)).toBe(false)
    // re-arm: opomnik poslan pred 3 dnevi (T1); alertDate prestavljen na T1+2d,
    // ki je DANES (now) že pretekel → nova izrecna odločitev zasluži nov opomnik
    const alertMoved = new Date(now.getTime() - 1 * 86_400_000)
    const alertedThreeDaysAgo = new Date(now.getTime() - 3 * 86_400_000).toISOString()
    expect(shouldSendLotAlert(alertMoved, now, alertedThreeDaysAgo)).toBe(true)
    void future
    // bodoči alertDate → NE
    expect(shouldSendLotAlert(future, now, undefined)).toBe(false)
  })

  it('lotAlertBody: max 5 +števec', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
      id: `x${i}`, lotNumber: `L${i}`, itemName: `Artikel ${i}`, unit: 'kg',
      alertDate: new Date(), expiryDate: null, quantityRemaining: 1, locationId: null, supplierName: '',
    }))
    expect(lotAlertBody(rows)).toContain('+2')
    expect(lotAlertBody(rows.slice(0, 3))).not.toContain('+')
  })

  it('runDailyLotAlerts: pretekel alertDate → push + state; brez alertDate → 0', async () => {
    // očisti state marker za čist test
    await db.integration.deleteMany({ where: { name: 'lot-alert-state', type: 'other' } }).catch(() => null)
    const b1 = await mkBatch({ qty: 2, expiryInDays: 40, alertInDays: -1 })
    const b2 = await mkBatch({ qty: 2, expiryInDays: 40, alertInDays: 10 }) // bodoči — NE
    const b3 = await mkBatch({ qty: 2, expiryInDays: 40 }) // brez alertDate — NE
    const n = await (await import('../src/lib/lot-alert')).runDailyLotAlerts(new Date())
    expect(n).toBe(1)
    // state zapisan → drugi klic isti dan ne ponovi
    const n2 = await (await import('../src/lib/lot-alert')).runDailyLotAlerts(new Date())
    expect(n2).toBe(0)
    const state = await db.integration.findFirst({ where: { name: 'lot-alert-state', type: 'other' } })
    expect(state).toBeTruthy()
    const cfg = JSON.parse(state?.config || '{}') as Record<string, string>
    expect(cfg[b1.id]).toBeTruthy()
    expect(cfg[b2.id]).toBeUndefined()
    expect(cfg[b3.id]).toBeUndefined()
  })
})

/* ═══════════ H. register + DDL ═══════════ */

describe('H. register + DDL idempotentnost', () => {
  it('SCHEMA_MIGRATIONS vsebuje lot-governance (18 vnosov) + i18n SL/HR opis', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'lot-governance')
    expect(m).toBeTruthy()
    expect(m!.endpoint).toBe('/api/admin/migrate-lot-governance')
    expect(SCHEMA_MIGRATIONS.length).toBe(21) // v1.108.0: +cash-movements (#16)
    expect(slDict['mig.lotGovernance.desc']).toBeTruthy()
    expect(hrDict['mig.lotGovernance.desc']).toBeTruthy()
  })

  it('DDL ruta: manager (ni centralna vloga) → 403; owner → alreadyApplied (sqlite ima stolpce)', async () => {
    const r = await ddlPOST(req('POST', '/api/admin/migrate-lot-governance', tokA))
    expect(r.status).toBe(403)
    const r2 = await ddlPOST(req('POST', '/api/admin/migrate-lot-governance', tokOwner))
    expect(r2.status).toBe(200)
    const j = await body(r2)
    expect(j.alreadyApplied).toBe(true)
  })

  it('drift-check matcher: lot-governance ADD/DROP stolpci so znani drift', async () => {
    const { isLotGovernanceStatement } = await import('../scripts/drift-check')
    expect(isLotGovernanceStatement('ALTER TABLE "InventoryBatch" ADD COLUMN "alertDate" DATETIME')).toBe(true)
    expect(isLotGovernanceStatement('ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "holdReason" TEXT NOT NULL DEFAULT \'\'')).toBe(true)
    expect(isLotGovernanceStatement('ALTER TABLE "InventoryBatch" DROP COLUMN "releaseNote"')).toBe(true)
    expect(isLotGovernanceStatement('ALTER TABLE "InventoryItem" ADD COLUMN "alertDate" DATETIME')).toBe(false)
    expect(isLotGovernanceStatement('ALTER TABLE "InventoryBatch" ADD COLUMN "note" TEXT')).toBe(false)
  })
})
