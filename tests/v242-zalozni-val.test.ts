/**
 * v1.242.0 (PRIMERJAVA-VMESNIKOV-2026 §16 I) — ZALOŽNI VAL: zaloga ima eno resnico.
 *
 * Pet vrzeli zaprtih v tem valu:
 *  A. EAN UNIKAT PER LOKACIJA (inventory route): ista koda dobavitelja na dveh
 *     lokacijah je DOVOLJENA (isti fizični artikel); duplikat znotraj lokacije 409.
 *  B. RECEPTURA LOKACIJSKA VAROVALA (recipes POST): sestavina z DRUGE lokacije →
 *     409 z imenom; legacy brez lokacije (null) dovoljena; GET locationMismatch.
 *  C. SERIJE PRI ODPADU (waste + batch-allocate): FEFO čez uporabne lot-e;
 *     izrecna serija (cela količina iz ene ali jasna napaka); reverzija vrača
 *     ISTIM serijam; EXHAUSTED→ACTIVE ob povratku; blokirana serija 409; tuja 404;
 *     untracked ostanek izrecen v note; GET nosi alokacije z lot številkami.
 *  D. INVENTURA (stocktakes): variansa proti NETO GIBANJEM (ne stale snapshotu —
 *     gibanja med štetjem niso manjk); rebalanca serij ob approve (manjko FEFO ven,
 *     presežek brez fantomskih lot-ov, blokirani nedotaknjeni); [id] varianceVsSnapshot
 *     + serijski kontekst vrstic.
 *  E. POUR COST POKRITOST (food-cost engine): recipeCoveragePct/covered/uncovered;
 *     brez prodaje null; polna pokritost 100.
 *  Ž. REGISTRI: APP_VERSION 1.242.0; 'v242-' v TEST_PREFIXES; PRIMERJAVA §16 I;
 *     lib batch-allocate.ts na disku; 0 DDL; i18n 3860 (0 novih).
 *
 * Fiksture s predpono v242- (TEST_PREFIXES že dodan); kaskadni izbris v afterAll
 * + sweepTestFixtures([PREFIX]) varovalka — 0 ostankov.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { employeePinFields, createToken } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import { readFileSync } from 'node:fs'
import { POST as invPOST, PATCH as invPATCH } from '../src/app/api/inventory/route'
import { GET as recipesGET, POST as recipesPOST } from '../src/app/api/recipes/route'
import { GET as wasteGET, POST as wastePOST } from '../src/app/api/waste/route'
import { POST as wasteReversePOST } from '../src/app/api/waste/[id]/reverse/route'
import { POST as stOpenPOST } from '../src/app/api/stocktakes/route'
import { GET as stDetailGET, PATCH as stItemsPATCH } from '../src/app/api/stocktakes/[id]/route'
import { POST as stSubmitPOST } from '../src/app/api/stocktakes/[id]/submit/route'
import { POST as stApprovePOST } from '../src/app/api/stocktakes/[id]/approve/route'
import { buildFoodCostVariance } from '../src/lib/food-cost-variance'

const PREFIX = 'v242-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locA = ''
let locB = ''
let mgrA = ''
let mgrB = ''
let tokA = ''
let tokB = ''

// Artikli
let itA1 = '' // locA, brez serij
let itA2 = '' // locA, brez serij (za patch EAN)
let itB1 = '' // locB (tuja lokacija za recepturo)
let itNo = '' // brez lokacije (legacy)
let itC = '' // locA, z serijami (odpad)
let itD = '' // locA, z serijo (inventura gibanja)
let itE = '' // locA, z 2 serijama (inventura rebalanca)
let itF = '' // locA, s karantensko serijo (inventura blokirana)

// Serije
let bOld = '' // itC: rok +10d, 12 kg
let bNew = '' // itC: rok +30d, 8 kg
let bQuar = '' // itC: QUARANTINE, 3 kg
let bOther = '' // itA1: tuja serija (404 primer)
let bD1 = '' // itD: 10 kg
let bE1 = '' // itE: rok +5d, 6 kg (FEFO prvi)
let bE2 = '' // itE: rok +15d, 4 kg
let bFq = '' // itF: QUARANTINE, 1 kg

// Meni (receptura)
let menuItemA = ''

const day = (n: number) => new Date(Date.now() + n * 86400_000)

function tokenFor(sub: string, name: string, role: string, l: string | null): string {
  return createToken({ sub, name, role, loc: l, sv: 0 })
}

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function seedEmployee(name: string, role: string, l: string | null, i: number): Promise<{ id: string; name: string }> {
  const id = `${PREFIX}${name}-${RUN}`
  const f = employeePinFields(pinOf(i), `${id}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${name}`, email: `${id}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: l,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return { id, name: `${PREFIX}${name}` }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  locA = `${PREFIX}locA-${RUN}`
  locB = `${PREFIX}locB-${RUN}`
  await db.location.create({ data: { id: locA, code: `${PREFIX}LA`, name: `${PREFIX}Lokacija A`, premisesId: `${PREFIX}prem-${RUN}` } })
  await db.location.create({ data: { id: locB, code: `${PREFIX}LB`, name: `${PREFIX}Lokacija B` } })

  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locA } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Jedi`, menuId: menu.id } })
  menuItemA = `${PREFIX}mi-a-${RUN}`
  await db.menuItem.create({ data: { id: menuItemA, name: `${PREFIX}Juha`, price: 10, categoryId: cat.id, isAvailable: true } })

  itA1 = `${PREFIX}itA1-${RUN}`
  itA2 = `${PREFIX}itA2-${RUN}`
  itB1 = `${PREFIX}itB1-${RUN}`
  itNo = `${PREFIX}itNo-${RUN}`
  itC = `${PREFIX}itC-${RUN}`
  itD = `${PREFIX}itD-${RUN}`
  itE = `${PREFIX}itE-${RUN}`
  itF = `${PREFIX}itF-${RUN}`
  await db.inventoryItem.createMany({
    data: [
      { id: itA1, name: `${PREFIX}Moka`, unit: 'kg', quantity: 10, costPerUnit: 2, locationId: locA },
      { id: itA2, name: `${PREFIX}Sladkor`, unit: 'kg', quantity: 5, costPerUnit: 1, locationId: locA },
      { id: itB1, name: `${PREFIX}Mariborski sir`, unit: 'kg', quantity: 8, costPerUnit: 4, locationId: locB },
      { id: itNo, name: `${PREFIX}Legacy brez lokacije`, unit: 'kg', quantity: 3, costPerUnit: 1, locationId: null },
      { id: itC, name: `${PREFIX}Sir za odpad`, unit: 'kg', quantity: 20, costPerUnit: 3, locationId: locA },
      { id: itD, name: `${PREFIX}Meso inventura`, unit: 'kg', quantity: 10, costPerUnit: 2, locationId: locA },
      { id: itE, name: `${PREFIX}Testenine rebalanca`, unit: 'kg', quantity: 10, costPerUnit: 2, locationId: locA },
      { id: itF, name: `${PREFIX}Karantena inventura`, unit: 'kg', quantity: 2, costPerUnit: 5, locationId: locA },
    ],
  })

  bOld = `${PREFIX}bOld-${RUN}`
  bNew = `${PREFIX}bNew-${RUN}`
  bQuar = `${PREFIX}bQuar-${RUN}`
  bOther = `${PREFIX}bOther-${RUN}`
  bD1 = `${PREFIX}bD1-${RUN}`
  bE1 = `${PREFIX}bE1-${RUN}`
  bE2 = `${PREFIX}bE2-${RUN}`
  bFq = `${PREFIX}bFq-${RUN}`
  await db.inventoryBatch.createMany({
    data: [
      { id: bOld, inventoryItemId: itC, locationId: locA, lotNumber: 'LOT-OLD', quantityInitial: 12, quantityRemaining: 12, unit: 'kg', status: 'ACTIVE', expiryDate: day(10), receivedAt: day(-5) },
      { id: bNew, inventoryItemId: itC, locationId: locA, lotNumber: 'LOT-NEW', quantityInitial: 8, quantityRemaining: 8, unit: 'kg', status: 'ACTIVE', expiryDate: day(30), receivedAt: day(-2) },
      { id: bQuar, inventoryItemId: itC, locationId: locA, lotNumber: 'LOT-QUAR', quantityInitial: 3, quantityRemaining: 3, unit: 'kg', status: 'QUARANTINE', expiryDate: day(20), receivedAt: day(-3), holdReason: 'sumljiv vonj' },
      { id: bOther, inventoryItemId: itA1, locationId: locA, lotNumber: 'LOT-OTHER', quantityInitial: 6, quantityRemaining: 6, unit: 'kg', status: 'ACTIVE', expiryDate: day(15), receivedAt: day(-4) },
      { id: bD1, inventoryItemId: itD, locationId: locA, lotNumber: 'LOT-D1', quantityInitial: 10, quantityRemaining: 10, unit: 'kg', status: 'ACTIVE', expiryDate: day(20), receivedAt: day(-6) },
      { id: bE1, inventoryItemId: itE, locationId: locA, lotNumber: 'LOT-E1', quantityInitial: 6, quantityRemaining: 6, unit: 'kg', status: 'ACTIVE', expiryDate: day(5), receivedAt: day(-8) },
      { id: bE2, inventoryItemId: itE, locationId: locA, lotNumber: 'LOT-E2', quantityInitial: 4, quantityRemaining: 4, unit: 'kg', status: 'ACTIVE', expiryDate: day(15), receivedAt: day(-4) },
      { id: bFq, inventoryItemId: itF, locationId: locA, lotNumber: 'LOT-FQ', quantityInitial: 1, quantityRemaining: 1, unit: 'kg', status: 'QUARANTINE', expiryDate: day(25), receivedAt: day(-7), holdReason: 'pregled' },
    ],
  })

  const a = await seedEmployee('mgrA', 'MANAGER', locA, 1)
  const b = await seedEmployee('mgrB', 'MANAGER', locB, 2)
  mgrA = a.id
  mgrB = b.id
  tokA = tokenFor(a.id, a.name, 'MANAGER', locA)
  tokB = tokenFor(b.id, b.name, 'MANAGER', locB)
})

afterAll(async () => {
  // kaskadni izbris po TESTNIH lokacijah + predponah (vse poti so vezane locA/locB)
  await db.stockBatchAllocation.deleteMany({ where: { inventoryItemId: { in: [itA1, itA2, itB1, itNo, itC, itD, itE, itF] } } }).catch(() => null)
  await db.stockTransaction.deleteMany({ where: { inventoryItemId: { in: [itA1, itA2, itB1, itNo, itC, itD, itE, itF] } } }).catch(() => null)
  await db.wasteRecord.deleteMany({ where: { locationId: { in: [locA, locB] } } }).catch(() => null)
  await db.stocktake.deleteMany({ where: { locationId: { in: [locA, locB] } } }).catch(() => null)
  await db.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: [itA1, itA2, itB1, itNo, itC, itD, itE, itF] } } }).catch(() => null)
  await db.inventoryItem.deleteMany({ where: { id: { in: [itA1, itA2, itB1, itNo, itC, itD, itE, itF] } } }).catch(() => null)
  await db.recipeItem.deleteMany({ where: { menuItemId: menuItemA } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: menuItemA } }).catch(() => null)
  await db.category.deleteMany({ where: { id: `${PREFIX}cat-${RUN}` } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: `${PREFIX}menu-${RUN}` } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { locationId: { in: [locA, locB] } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { in: [mgrA, mgrB] } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { in: [locA, locB] } } }).catch(() => null)
  const sweep = await sweepTestFixtures(db, [PREFIX])
  expect(sweep.remainingLocations).toBe(0)
})

// ─────────────────────── A · EAN unikat per lokacija ───────────────────────

describe('v242 A · EAN unikat PER LOKACIJA', () => {
  it('A1: POST ista koda isto lokacijo → 409 z nazivom artikla', async () => {
    const first = await invPOST(req('POST', '/api/inventory', tokA, { name: `${PREFIX}Paradižnik`, qty: 5, unit: 'kg', cost: 2, ean: 'V242EAN001' }))
    expect(first.status).toBe(201)
    const dup = await invPOST(req('POST', '/api/inventory', tokA, { name: `${PREFIX}Paradižnik dvojnik`, qty: 1, unit: 'kg', cost: 2, ean: 'V242EAN001' }))
    expect(dup.status).toBe(409)
    const b = await dup.json()
    expect(b.error).toContain('na tej lokaciji')
    expect(b.error).toContain('Paradižnik')
  })

  it('A2: ista koda DRUGA lokacija → 201 (isti artikel dobavitelja)', async () => {
    const r = await invPOST(req('POST', '/api/inventory', tokB, { name: `${PREFIX}Paradižnik MB`, qty: 3, unit: 'kg', cost: 2.2, ean: 'V242EAN001' }))
    expect(r.status).toBe(201)
  })

  it('A3: PATCH na kodo, ki jo ima drug artikel ISTE lokacije → 409; tuje lokacije → uspeh', async () => {
    // itA2 (locA) poskusi prevzeti kodo V242EAN001, ki jo ima v242 Paradižnik (locA)
    const same = await invPATCH(req('PATCH', '/api/inventory', tokA, { id: itA2, ean: 'V242EAN001' }))
    expect(same.status).toBe(409)
    // koda, ki obstaja SAMO na locA → artikel na locB jo sme nositi
    const onlyA = await invPOST(req('POST', '/api/inventory', tokA, { name: `${PREFIX}Kava`, qty: 2, unit: 'kg', cost: 12, ean: 'V242EAN009' }))
    expect(onlyA.status).toBe(201)
    const other = await invPATCH(req('PATCH', '/api/inventory', tokB, { id: itB1, ean: 'V242EAN009' }))
    expect(other.status).toBe(200)
    const fresh = await db.inventoryItem.findUnique({ where: { id: itB1 }, select: { ean: true } })
    expect(fresh?.ean).toBe('V242EAN009')
  })
})

// ─────────────────────── B · Receptura lokacijska varovala ───────────────────────

describe('v242 B · Receptura lokacijska varovala', () => {
  it('B1: sestavina z DRUGE lokacije → 409 z imenom', async () => {
    const r = await recipesPOST(req('POST', '/api/recipes', tokA, {
      menuItemId: menuItemA,
      items: [{ inventoryItemId: itA1, qty: 0.2 }, { inventoryItemId: itB1, qty: 0.1 }],
    }))
    expect(r.status).toBe(409)
    const b = await r.json()
    expect(b.error).toContain('druge lokacije')
    expect(b.error).toContain('Mariborski sir')
    // NIČ ni zapisano (atomarno zavračanje pred transakcijo)
    const rows = await db.recipeItem.count({ where: { menuItemId: menuItemA } })
    expect(rows).toBe(0)
  })

  it('B2: sestavine ISTE lokacije → 201', async () => {
    const r = await recipesPOST(req('POST', '/api/recipes', tokA, {
      menuItemId: menuItemA,
      items: [{ inventoryItemId: itA1, qty: 0.2 }, { inventoryItemId: itA2, qty: 0.05 }],
    }))
    expect(r.status).toBe(201)
    const b = await r.json()
    expect(b.saved).toBe(2)
  })

  it('B3: legacy artikel BREZ lokacije je dovoljen (null ≠ tuja)', async () => {
    const r = await recipesPOST(req('POST', '/api/recipes', tokA, {
      menuItemId: menuItemA,
      items: [{ inventoryItemId: itNo, qty: 0.1 }],
    }))
    expect(r.status).toBe(201)
  })

  it('B4: GET zazna legacy cross-lokacijsko vrstico (locationMismatch) — direkten vnos', async () => {
    // higienska zastavica: vrstica, vpisana PRED varovalom (direktno v DB)
    await db.recipeItem.create({
      data: { id: `${PREFIX}ri-foreign-${RUN}`, menuItemId: menuItemA, inventoryItemId: itB1, quantityPerServing: 0.1, unit: 'kg', yieldPercent: 100 },
    })
    const r = await recipesGET(req('GET', '/api/recipes', tokA))
    expect(r.status).toBe(200)
    const b = await r.json()
    const rec = (b.recipes as { id: string; items: { inventoryItemId: string; locationMismatch: boolean }[] }[]).find((x) => x.id === menuItemA)
    expect(rec).toBeTruthy()
    const foreign = rec!.items.find((i) => i.inventoryItemId === itB1)
    expect(foreign?.locationMismatch).toBe(true)
    const local = rec!.items.find((i) => i.inventoryItemId === itNo)
    expect(local?.locationMismatch).toBe(false)
  })
})

// ─────────────────────── C · Serije pri odpadu ───────────────────────

describe('v242 C · Odpad razporedi serije (FEFO/izrecno/reverzija)', () => {
  it('C1: FEFO — odpad 5 izpade IZ najstarejše serije; alokacije + note', async () => {
    const r = await wastePOST(req('POST', '/api/waste', tokA, { itemId: itC, quantity: 5, reason: 'pokvarjeno', idempotencyKey: 'v242-c1' }))
    expect(r.status).toBe(201)
    const b = await r.json()
    expect(b.record.allocations.length).toBe(1)
    expect(b.record.allocations[0].batchId).toBe(bOld)
    expect(b.record.allocations[0].lotNumber).toBe('LOT-OLD')
    expect(b.record.allocations[0].quantity).toBe(5)
    expect(b.record.untracked).toBe(0)
    const oldB = await db.inventoryBatch.findUnique({ where: { id: bOld }, select: { quantityRemaining: true, status: true } })
    expect(Number(oldB?.quantityRemaining)).toBe(7)
    expect(oldB?.status).toBe('ACTIVE')
    const agg = await db.inventoryItem.findUnique({ where: { id: itC }, select: { quantity: true } })
    expect(Number(agg?.quantity)).toBe(15)
    const tx = await db.stockTransaction.findFirst({ where: { inventoryItemId: itC, type: 'WASTE' }, orderBy: { createdAt: 'desc' } })
    expect(tx?.note).toContain('Serije: 5 kg')
    const allocs = await db.stockBatchAllocation.findMany({ where: { stockTransactionId: tx?.id } })
    expect(allocs.length).toBe(1)
    expect(Number(allocs[0].quantity)).toBe(5)
  })

  it('C2: FEFO čez dve seriji — izčrpa staro (EXHAUSTED) in zajame novo', async () => {
    const r = await wastePOST(req('POST', '/api/waste', tokA, { itemId: itC, quantity: 10, reason: 'preteklo', idempotencyKey: 'v242-c2' }))
    expect(r.status).toBe(201)
    const b = await r.json()
    expect(b.record.allocations.length).toBe(2)
    expect(b.record.untracked).toBe(0)
    const oldB = await db.inventoryBatch.findUnique({ where: { id: bOld }, select: { quantityRemaining: true, status: true } })
    expect(Number(oldB?.quantityRemaining)).toBe(0)
    expect(oldB?.status).toBe('EXHAUSTED')
    const newB = await db.inventoryBatch.findUnique({ where: { id: bNew }, select: { quantityRemaining: true } })
    expect(Number(newB?.quantityRemaining)).toBe(5)
    const agg = await db.inventoryItem.findUnique({ where: { id: itC }, select: { quantity: true } })
    expect(Number(agg?.quantity)).toBe(5)
  })

  it('C3: izrecna serija — cela količina IZ IZBRANEGA lot-a', async () => {
    const r = await wastePOST(req('POST', '/api/waste', tokA, { itemId: itC, quantity: 4, reason: 'razlitje', idempotencyKey: 'v242-c3', batchId: bNew }))
    expect(r.status).toBe(201)
    const b = await r.json()
    expect(b.record.allocations.length).toBe(1)
    expect(b.record.allocations[0].batchId).toBe(bNew)
    expect(b.record.allocations[0].quantity).toBe(4)
    const newB = await db.inventoryBatch.findUnique({ where: { id: bNew }, select: { quantityRemaining: true } })
    expect(Number(newB?.quantityRemaining)).toBe(1)
    const agg = await db.inventoryItem.findUnique({ where: { id: itC }, select: { quantity: true } })
    expect(Number(agg?.quantity)).toBe(1)
  })

  it('C4: izrecna serija premalo količine → 409 (količina na lot-u v sporočilu)', async () => {
    // agregat dvignemo direktno (+5 brez-serijske zaloge) — da agregatna MEJA NE
    // sproži prej kot serija: 6 na zalogi, a na LOT-NEW samo 1
    await db.inventoryItem.update({ where: { id: itC }, data: { quantity: 6 } })
    const r = await wastePOST(req('POST', '/api/waste', tokA, { itemId: itC, quantity: 2, reason: 'razlitje', idempotencyKey: 'v242-c4', batchId: bNew }))
    expect(r.status).toBe(409)
    const b = await r.json()
    expect(b.error).toContain('LOT-NEW')
    expect(b.error).toContain('1')
    // nič se ni spremenilo (niti agregat niti serija)
    const agg = await db.inventoryItem.findUnique({ where: { id: itC }, select: { quantity: true } })
    expect(Number(agg?.quantity)).toBe(6)
    const newB = await db.inventoryBatch.findUnique({ where: { id: bNew }, select: { quantityRemaining: true } })
    expect(Number(newB?.quantityRemaining)).toBe(1)
  })

  it('C5: karantenska serija → 409; tuja serija (drugi artikel) → 404', async () => {
    const q = await wastePOST(req('POST', '/api/waste', tokA, { itemId: itC, quantity: 1, reason: 'pokvarjeno', idempotencyKey: 'v242-c5q', batchId: bQuar }))
    expect(q.status).toBe(409)
    expect((await q.json()).error).toContain('blokirana')
    const foreign = await wastePOST(req('POST', '/api/waste', tokA, { itemId: itC, quantity: 1, reason: 'pokvarjeno', idempotencyKey: 'v242-c5f', batchId: bOther }))
    expect(foreign.status).toBe(404)
  })

  it('C6: reverzija C2 vrne ISTIM serijam — EXHAUSTED lot spet zaživi (ACTIVE)', async () => {
    const rec2 = await db.wasteRecord.findUnique({ where: { locationId_idempotencyKey: { locationId: locA, idempotencyKey: 'v242-c2' } } })
    expect(rec2).toBeTruthy()
    const r = await wasteReversePOST(req('POST', `/api/waste/${rec2!.id}/reverse`, tokA), { params: Promise.resolve({ id: rec2!.id }) })
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.record.restoredBatches).toBe(2)
    // stara serija: 0 → 7 in spet ACTIVE
    const oldB = await db.inventoryBatch.findUnique({ where: { id: bOld }, select: { quantityRemaining: true, status: true } })
    expect(Number(oldB?.quantityRemaining)).toBe(7)
    expect(oldB?.status).toBe('ACTIVE')
    // nova serija: 1 → 4
    const newB = await db.inventoryBatch.findUnique({ where: { id: bNew }, select: { quantityRemaining: true } })
    expect(Number(newB?.quantityRemaining)).toBe(4)
    // agregat: 6 → 16 (povračilo celotnega odpada 10)
    const agg = await db.inventoryItem.findUnique({ where: { id: itC }, select: { quantity: true } })
    expect(Number(agg?.quantity)).toBe(16)
  })

  it('C7: artikel BREZ serij — untracked odjem, izrecna note, vse prejšnje vedenje', async () => {
    const r = await wastePOST(req('POST', '/api/waste', tokA, { itemId: itA2, quantity: 2, reason: 'priprava', idempotencyKey: 'v242-c7' }))
    expect(r.status).toBe(201)
    const b = await r.json()
    expect(b.record.allocations).toEqual([])
    expect(b.record.untracked).toBe(2)
    const tx = await db.stockTransaction.findFirst({ where: { inventoryItemId: itA2, type: 'WASTE' }, orderBy: { createdAt: 'desc' } })
    expect(tx?.note).toContain('Brez serije')
    const agg = await db.inventoryItem.findUnique({ where: { id: itA2 }, select: { quantity: true } })
    expect(Number(agg?.quantity)).toBe(3)
  })

  it('C8: GET odpada nosi alokacije z lot številkami', async () => {
    const r = await wasteGET(req('GET', '/api/waste?days=1', tokA))
    expect(r.status).toBe(200)
    const b = await r.json()
    const rec = (b.records as { id: string; allocations: { lotNumber: string; quantity: number }[] }[]).find((x) => x.allocations.some((a) => a.lotNumber === 'LOT-OLD'))
    expect(rec).toBeTruthy()
    expect(rec!.allocations.length).toBeGreaterThan(0)
  })
})

// ─────────────────────── D · Inventura: varianca + rebalanca ───────────────────────

describe('v242 D · Inventura — variansa proti neto gibanjem + rebalanca serij', () => {
  let st1 = ''
  let lineD = ''

  it('D1: odpri popis — snapshot itD = 10', async () => {
    const r = await stOpenPOST(req('POST', '/api/stocktakes', tokA, { note: 'v242 gibanja' }))
    expect(r.status).toBe(201)
    const b = await r.json()
    st1 = b.stocktake.id
    const d = b.stocktake.items.find((i: { inventoryItemId: string }) => i.inventoryItemId === itD)
    lineD = d.id
    expect(d.expectedQty).toBe(10)
  })

  it('D2: gibanje MED štetjem (odpad 2) + prešteje 8 → variansa 0 (ne −2!)', async () => {
    // dokumentirano gibanje: odpad 2 kg itD (FEFO iz bD1: 10 → 8)
    const w = await wastePOST(req('POST', '/api/waste', tokA, { itemId: itD, quantity: 2, reason: 'pokvarjeno', idempotencyKey: 'v242-d2' }))
    expect(w.status).toBe(201)
    const p = await stItemsPATCH(req('PATCH', `/api/stocktakes/${st1}`, tokA, { items: [{ id: lineD, countedQuantity: 8 }] }), { params: Promise.resolve({ id: st1 }) })
    expect(p.status).toBe(200)
    const s = await stSubmitPOST(req('POST', `/api/stocktakes/${st1}/submit`, tokA), { params: Promise.resolve({ id: st1 }) })
    expect(s.status).toBe(200)
    const a = await stApprovePOST(req('POST', `/api/stocktakes/${st1}/approve`, tokA), { params: Promise.resolve({ id: st1 }) })
    expect(a.status).toBe(200)
    const b = await a.json()
    expect(b.varianceBasis).toBe('theoretical')
    const proof = (b.lines as { inventoryItemId: string; expectedQty: number; netMovements: number; theoreticalQty: number; countedQty: number; varianceQty: number }[]).find((l) => l.inventoryItemId === itD)
    expect(proof).toBeTruthy()
    expect(proof!.expectedQty).toBe(10)
    expect(proof!.netMovements).toBe(-2)
    expect(proof!.theoreticalQty).toBe(8)
    expect(proof!.countedQty).toBe(8)
    expect(proof!.varianceQty).toBe(0) // gibanje NI manjk — stara semantika bi rekla −2
    // shranjena variansa na vrstici
    const line = await db.stocktakeItem.findFirst({ where: { stocktakeId: st1, inventoryItemId: itD } })
    expect(Number(line?.varianceQuantity)).toBe(0)
    // zaloga se NI spreminjala (counted == previousQty 8 — brez popravka)
    const agg = await db.inventoryItem.findUnique({ where: { id: itD }, select: { quantity: true } })
    expect(Number(agg?.quantity)).toBe(8)
  })

  it('D3: [id] GET — varianceVsSnapshotQty −2 + serijski kontekst vrstice', async () => {
    const r = await stDetailGET(req('GET', `/api/stocktakes/${st1}`, tokA), { params: Promise.resolve({ id: st1 }) })
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.stocktake.varianceBasis).toBe('theoretical')
    const d = (b.stocktake.items as { inventoryItemId: string; varianceQty: number; varianceVsSnapshotQty: number; batches: { lotNumber: string; quantityRemaining: number }[] }[]).find((i) => i.inventoryItemId === itD)
    expect(d).toBeTruthy()
    expect(d!.varianceQty).toBe(0)
    expect(d!.varianceVsSnapshotQty).toBe(-2)
    expect(d!.batches.some((x) => x.lotNumber === 'LOT-D1' && x.quantityRemaining === 8)).toBe(true)
  })

  it('D4: rebalanca — prešteto 7 (manjko 3) odstrani FEFO iz najstarejše serije', async () => {
    const o = await stOpenPOST(req('POST', '/api/stocktakes', tokA, { note: 'v242 rebalanca' }))
    expect(o.status).toBe(201)
    const ob = await o.json()
    const st2 = ob.stocktake.id
    const items = ob.stocktake.items as { id: string; inventoryItemId: string; expectedQty: number }[]
    const lineE = items.find((i) => i.inventoryItemId === itE)
    const lineF = items.find((i) => i.inventoryItemId === itF)
    expect(lineE).toBeTruthy()
    expect(lineE!.expectedQty).toBe(10)
    expect(lineF).toBeTruthy()

    // prešteto: itE 7 (manjko 3 — FEFO iz LOT-E1), itF 0 (manjko 2 — KARANTENSKA serija ostane)
    const p = await stItemsPATCH(req('PATCH', `/api/stocktakes/${st2}`, tokA, { items: [
      { id: lineE!.id, countedQuantity: 7 },
      { id: lineF!.id, countedQuantity: 0 },
    ] }), { params: Promise.resolve({ id: st2 }) })
    expect(p.status).toBe(200)
    await stSubmitPOST(req('POST', `/api/stocktakes/${st2}/submit`, tokA), { params: Promise.resolve({ id: st2 }) })
    const a = await stApprovePOST(req('POST', `/api/stocktakes/${st2}/approve`, tokA), { params: Promise.resolve({ id: st2 }) })
    expect(a.status).toBe(200)
    const b = await a.json()
    expect(b.adjusted).toBe(2)

    // itE: agregat 10 → 7; LOT-E1 6 → 3 (FEFO prvi, rok +5d), LOT-E2 nedotaknjen 4
    const aggE = await db.inventoryItem.findUnique({ where: { id: itE }, select: { quantity: true } })
    expect(Number(aggE?.quantity)).toBe(7)
    const e1 = await db.inventoryBatch.findUnique({ where: { id: bE1 }, select: { quantityRemaining: true, status: true } })
    expect(Number(e1?.quantityRemaining)).toBe(3)
    expect(e1?.status).toBe('ACTIVE')
    const e2 = await db.inventoryBatch.findUnique({ where: { id: bE2 }, select: { quantityRemaining: true } })
    expect(Number(e2?.quantityRemaining)).toBe(4)
    // alokacija rebalance je vezana na STOCKTAKE transakcijo
    const stTx = await db.stockTransaction.findFirst({ where: { inventoryItemId: itE, type: 'STOCKTAKE' } })
    expect(stTx).toBeTruthy()
    const alloc = await db.stockBatchAllocation.findMany({ where: { stockTransactionId: stTx!.id } })
    expect(alloc.length).toBe(1)
    expect(alloc[0].batchId).toBe(bE1)
    expect(Number(alloc[0].quantity)).toBe(3)

    // itF: agregat 2 → 0; KARANTENSKA serija NEDOTAKNJENA (1) — njena usoda je izrecna
    const aggF = await db.inventoryItem.findUnique({ where: { id: itF }, select: { quantity: true } })
    expect(Number(aggF?.quantity)).toBe(0)
    const fq = await db.inventoryBatch.findUnique({ where: { id: bFq }, select: { quantityRemaining: true, status: true } })
    expect(Number(fq?.quantityRemaining)).toBe(1)
    expect(fq?.status).toBe('QUARANTINE')

    // variansi: itE −3 (ni gibanj), itF −2
    const lineE2 = await db.stocktakeItem.findFirst({ where: { stocktakeId: st2, inventoryItemId: itE } })
    expect(Number(lineE2?.varianceQuantity)).toBe(-3)
    const lineF2 = await db.stocktakeItem.findFirst({ where: { stocktakeId: st2, inventoryItemId: itF } })
    expect(Number(lineF2?.varianceQuantity)).toBe(-2)
  })

  it('D5: presežek NE ustvari fantomskih serij (itA1 +5 brez lot-a)', async () => {
    const o = await stOpenPOST(req('POST', '/api/stocktakes', tokA, { note: 'v242 presežek' }))
    expect(o.status).toBe(201)
    const body = await o.json()
    const st3 = body.stocktake.id
    const lineA1 = (body.stocktake.items as { id: string; inventoryItemId: string }[]).find((i) => i.inventoryItemId === itA1)
    const p = await stItemsPATCH(req('PATCH', `/api/stocktakes/${st3}`, tokA, { items: [{ id: lineA1!.id, countedQuantity: 15 }] }), { params: Promise.resolve({ id: st3 }) })
    expect(p.status).toBe(200)
    await stSubmitPOST(req('POST', `/api/stocktakes/${st3}/submit`, tokA), { params: Promise.resolve({ id: st3 }) })
    const a = await stApprovePOST(req('POST', `/api/stocktakes/${st3}/approve`, tokA), { params: Promise.resolve({ id: st3 }) })
    expect(a.status).toBe(200)
    const agg = await db.inventoryItem.findUnique({ where: { id: itA1 }, select: { quantity: true } })
    expect(Number(agg?.quantity)).toBe(15)
    // LOT-OTHER na itA1 ostane 6 — priliv je BREZ serije (naslednji prejem ustvari lot)
    const other = await db.inventoryBatch.findUnique({ where: { id: bOther }, select: { quantityRemaining: true } })
    expect(Number(other?.quantityRemaining)).toBe(6)
  })
})

// ─────────────────────── E · Pour cost pokritost (čisti motor) ───────────────────────

describe('v242 E · Food-cost — pokritost receptur', () => {
  const baseInput = {
    from: new Date(Date.now() - 7 * 86400_000),
    to: new Date(),
    items: [
      { id: 'e-inv1', name: 'Moka E', unit: 'kg', category: 'c', costPerUnit: 2, quantity: 10, locationId: 'l1', locationName: 'L1' },
    ],
    transactions: [],
    recipes: [
      { id: 'e-r1', menuItemId: 'e-m1', inventoryItemId: 'e-inv1', quantityPerServing: 0.1, yieldPercent: 100, unit: 'kg', parentRecipeItemId: null, updatedAt: new Date() },
    ],
    soldItemNames: { 'e-m1': 'Jed s recepturo', 'e-m2': 'Jed brez' },
    stocktakes: [],
    priceHistory: {},
    orderNumbers: {},
    stocktakeIdByTxId: {},
    currency: 'EUR',
  }

  it('E1: mešana prodaja — pokritost 66,67 % (100 od 150)', () => {
    const report = buildFoodCostVariance({
      ...baseInput,
      sold: [
        { menuItemId: 'e-m1', quantity: 10, price: 10, discountAmount: 0, orderNumber: 1 },
        { menuItemId: 'e-m2', quantity: 5, price: 10, discountAmount: 0, orderNumber: 2 },
      ],
    } as Parameters<typeof buildFoodCostVariance>[0])
    expect(report.netSales).toBe(150)
    expect(report.kpi.recipeCoveragePct).toBeCloseTo(66.67, 1)
    expect(report.kpi.coveredSalesValue).toBe(100)
    expect(report.kpi.uncoveredSalesValue).toBe(50)
    expect(report.dataQuality.soldWithoutRecipeRevenue).toBe(50)
    expect(report.soldWithoutRecipe.length).toBe(1)
    expect(report.soldWithoutRecipe[0].menuItemId).toBe('e-m2')
  })

  it('E2: brez prodaje → null (neznano, ne 0 %)', () => {
    const report = buildFoodCostVariance({ ...baseInput, sold: [] } as Parameters<typeof buildFoodCostVariance>[0])
    expect(report.kpi.recipeCoveragePct).toBeNull()
    expect(report.kpi.coveredSalesValue).toBeNull()
    expect(report.kpi.uncoveredSalesValue).toBeNull()
  })

  it('E3: vsa prodaja z recepturo → 100 %', () => {
    const report = buildFoodCostVariance({
      ...baseInput,
      sold: [{ menuItemId: 'e-m1', quantity: 3, price: 10, discountAmount: 0, orderNumber: 1 }],
    } as Parameters<typeof buildFoodCostVariance>[0])
    expect(report.kpi.recipeCoveragePct).toBe(100)
    expect(report.kpi.coveredSalesValue).toBe(30)
    expect(report.kpi.uncoveredSalesValue).toBe(0)
    expect(report.dataQuality.soldWithoutRecipeRevenue).toBe(0)
  })
})

// ─────────────────────── Ž · Registri ───────────────────────

describe('v242 Ž · Registri in verzija', () => {
  it('Ž1: APP_VERSION je 1.243.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.261.0')
    const versionFile = readFileSync('src/lib/version.ts', 'utf8')
    expect(versionFile).toContain("'1.261.0'")
    const compose = readFileSync('deploy/docker-compose.yml', 'utf8')
    expect(compose).toContain('restaurantos:1.261.0')
  })

  it('Ž2: TEST_PREFIXES vsebuje v242-; lib batch-allocate na disku', () => {
    expect((TEST_PREFIXES as readonly string[]).includes('v242-')).toBe(true)
    const lib = readFileSync('src/lib/batch-allocate.ts', 'utf8')
    expect(lib).toContain('allocateBatchesTx')
    expect(lib).toContain('restoreBatchAllocations')
  })

  it('Ž3: PRIMERJAVA §16 I + worklog vrhnji vnos', () => {
    const doc = readFileSync('docs/PRIMERJAVA-VMESNIKOV-2026.md', 'utf8')
    expect(doc).toContain('ZALOŽNI VAL v1.242.0')
    const wl = readFileSync('worklog.md', 'utf8')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.261.0-finalna-verifikacija')
  })
})
