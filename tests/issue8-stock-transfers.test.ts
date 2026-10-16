/**
 * Issue #8 (P2, v1.116.0) — medlokacijski prenosi zalog (StockTransfer).
 *
 * Pokrito:
 *  A. ČISTI MOTOR (src/lib/stock-transfer.ts, brez DB):
 *   1. validateTransferInput: happy (normalizacija trim/r3/r2) + from=to +
 *      manjkajoči/50+ vrstic + količina ≤0/4 decimalke/prevelika + podvojen
 *      artikel + opomba 501 + idempotencyKey 7/65 znakov + cena negativna/
 *      3 decimalke + slab datum roka;
 *   2. computeReceiveOutcome: vse prejeto → RECEIVED; vrzel/poškodba → PARTIAL
 *      (varianca missing/damaged); EPS meja 0.0004 → še RECEIVED; prazne
 *      vrstice → RECEIVED 0/0;
 *   3. transferNumberFor: TRF-YYYYMMDD-0001 (ČIST (date,seq)); seq 0/negativen
 *      → TransferError;
 *   4. DTO: variance SAMO v terminalnih stanjih; missingQty = dispatched−
 *      received−damaged (clamp na 0);
 *  B. POST /api/transfers: 201 osnutek (status DRAFT, TRF- številka, snapshot
 *      itemName/unit/unitCost, audit TRANSFER_CREATED s fromLocationId);
 *      idempotentni replay 200 idempotentReplay BREZ druge vrstice; from=to
 *      400; neznana lokacija 404; cross-tenant 403 'Prenos med organizacijami
 *      ni dovoljen.'; mgrA1 z from=locA2 → 403 (lokacijski obseg); neznan
 *      artikel 404; artikel tuje lokacije 400; neznana serija 404; serija
 *      drugega artikla 400; QUARANTINE 409 'Serija je blokirana.'; waiter 403;
 *      brez žetona 401; pre-DDL 503 → reset deluje;
 *  C. dispatch: DRAFT→DISPATCHED v ENI TX — item 100→90, serija 50→40,
 *      StockTransaction TRANSFER_OUT −10 (previousQty 100, newQty 90,
 *      supplierDoc=transferNumber), StockBatchAllocation (serija+tx, qty 10),
 *      audit TRANSFER_DISPATCHED, dispatchedQty; DVOJNI dispatch → 409 + zaloga
 *      NEspremenjena + točno ENA TRANSFER_OUT vrstica (idempotenčni dokaz);
 *      premalo zaloge 409 (zaloga nespremenjena, BREZ tx, status ostane DRAFT);
 *      premalo serije 409 + CELOTEN rollback (item 100 nespremenjen);
 *      izčrpana serija → EXHAUSTED (remaining 0); prenos BREZ serije (batch
 *      null, brez alokacije); cancel DRAFT → CANCELLED + razlog + zaloga NI
 *      dotaknjena + audit TRANSFER_CANCELLED; cancel po dispatch → 409; kratek
 *      razlog → 400; ciljni manager (locA2) ne more odpreti → 403; 401;
 *  D. receive: full → RECEIVED (variance 0/0) + ciljni artikel po IMENU
 *      (itemSameName 5+10=15) + TRANSFER_IN +10 (previous 5, new 15) + utežena
 *      cena (5@3 + 10@5 → 4.33) + ciljna serija lot TRF-n-1 (10/10, ACTIVE,
 *      lokacija cilja, rok kopiran) + targetItemId + opomba vrstice; dvojni
 *      prevzem → 409 + nič sprememb; partial (6 prejeto + 2 poškodovani od 10)
 *      → PARTIAL + variance {missing 2, damaged 2} + cilj NATANČNO 6
 *      (poškodovani NE v zalogi) + serija remaining 6; samo poškodovani (0+3)
 *      → PARTIAL + cilj 0 + BREZ TRANSFER_IN + BREZ ciljne serije + missing 7;
 *      presega 400; na DRAFTU → 409; manjkajoča vrstica 400; podvojen vnos 400;
 *      neznana/negativna količina 400; izvorni manager ne more prevzeti → 403;
 *      401; AVTO-USTVARJEN ciljni artikel (ime/enota/cena/kategorija/dobavitelj
 *      posnetek vira, prev 0 → new 4);
 *  E. seznam/iskanje: OR obseg (from ALI to v uporabnikovi lokaciji — prenos
 *      V cilj je viden prejemniku), tretja lokacija istega orga NE vidna
 *      mgrA1; mgrB (tuja org) vidi NIČ + fail-closed filter; centralni OWNER
 *      vidi vse prenose svoje orga (tudi locA2→locA3); status filter +
 *      neveljaven 400; fromLocationId filter; q po številki dokumenta + po
 *      imenu artikla; dateFrom/dateTo; 401 + 503 pre-DDL; GET [id]: 404
 *      neznana / 403 tuja org / 403 obeh tujih lokacij / 200 centralni / 200
 *      prejemnik po cilju (z imeni lokacij);
 *  F. ledger/usklajenost: TRANSFER_OUT 1× na izvor + veriga previousQty→newQty
 *      ≡ končna DB količina; TRANSFER_IN 1× na cilj + enaka veriga;
 *      StockChanged dogodki v EventLog (dispatch izvor + receive cilj);
 *      revizijska veriga TRANSFER_CREATED→DISPATCHED→RECEIVED po času;
 *      txGroupOf klasifikacija (transfer_in → 'receipt', transfer_out →
 *      'waste'); alokacija serije ↔ transakcija (FK povezava + supplierDoc).
 *      OPOMBA: reports/export tipi gibanja (TRANSFER_IN/OUT v inline seznamu
 *      tipov) NISO izvoženi kot konstanta → preverjanje izpuščeno (dokumentirano
 *      v worklogu; pokrito je s txGroupOf iz F4);
 *  G. register/DDL: SCHEMA_MIGRATIONS vsebuje 'stock-transfers' (#28) +
 *      endpoint + descKey; HANDLERS v konzoli vsebuje ključ (source-check);
 *      mig.stockTransfers.desc v SL + HR; drift matcher isStockTransfersStatement
 *      + KNOWN_DRIFTS vnos; TAB_PERM.prenosi = 'inventory.manage'.
 *      trf.* i18n pusti UI agentu (soft pariteta tabs.prenosi če obstaja).
 *
 * Fiksture s predpono i8- (TEST_PREFIXES + ID_SWEEP stockTransferItem/stockTransfer
 * dodal 8-backend). StockTransfer NIMA locationId stolpca → API-ustvarjene glave
 * (nid() id) + EventLog/auditLog/detstva cilja čistimo ROČNO v cleanup() (kot
 * PayrollExport v issue22); lokacijski prehod sweep pokrije ciljne artikle/
 * serije (locationId). Org drevo ×2 (issue5 vzorec): orgA → locA1/locA2/locA3,
 * orgB → locB za cross-tenant 403.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { num } from '../src/lib/map'
import {
  validateTransferInput,
  computeReceiveOutcome,
  transferNumberFor,
  transferDto,
  transferLineDto,
  TransferError,
  TRF_STATUSES,
  TRF_TERMINAL,
  TRF_MAX_LINES,
  TRF_EPS,
  TRF_TX_IN,
  TRF_TX_OUT,
  type TrfLineRow,
  type TrfRow,
} from '../src/lib/stock-transfer'
import { __setTransferTablesCacheForTests, __resetTransferTablesCacheForTests } from '../src/lib/transfer-schema'
import { POST as transfersPOST, GET as transfersGET } from '../src/app/api/transfers/route'
import { GET as transferDetailGET } from '../src/app/api/transfers/[id]/route'
import { POST as dispatchPOST } from '../src/app/api/transfers/[id]/dispatch/route'
import { POST as receivePOST } from '../src/app/api/transfers/[id]/receive/route'
import { POST as cancelPOST } from '../src/app/api/transfers/[id]/cancel/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { TAB_PERM } from '../src/lib/tab-permissions'
import { txGroupOf } from '../src/lib/food-cost-variance'
import { sl as slDict } from '../src/lib/i18n/sl'
import { hr as hrDict } from '../src/lib/i18n/hr'

const P = 'i8-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const DAY = 86_400_000

// ── org drevo ×2 (issue5 vzorec; imena/slug PREFIKSIRANA → FIELD_SWEEP pobriše) ──
let orgA = '', brandA = '', propA = ''
let orgB = '', brandB = '', propB = ''
let locA1 = '', locA2 = '', locA3 = '', locB = ''
let mgrA1 = '', mgrA2 = '', mgrB = '', waiterA = '', ownerA = ''
let tokA1 = '', tokA2 = '', tokB = '', tokWaiter = '', tokOwner = ''

// ── artikli/serije (izvor locA1, razen itemSameName na locA2) ──
let itemA1 = ''        // `${P} Moka` — glavni tok (B1/C1/D1/F) + serija batchA
let itemA1b = ''       // `${P} Arabika` — podvojen artikel + damaged-only
let itemLow = ''       // qty 2 — premalo zaloge + DRAFT fiksture (cancel/403/503)
let itemNoBatch = ''   // dispatch brez serije
let itemSameName = ''  // locA2, ISTO ime kot itemA1 — razrešitev cilja po imenu
let itemPartial = ''   // delni prevzem + serija batchPartial
let itemRobusta = ''   // avto-ustvarjanje ciljnega artikla
let itemBatchSmall = '' // serija 3 < zahtevano 10 → 409 rollback
let itemBatchExact = '' // serija 10 = zahtevano 10 → EXHAUSTED
let itemMulti1 = ''    // 2-postavni prenos (D validacije)
let itemMulti2 = ''
let batchA = '', batchBlocked = '', batchPartial = '', batchSmall = '', batchExact = ''
let batchAExpiry = new Date()

// ── deli glavnega toka, ki jih preverjajo poznejši sklopi ──
let tMainId = '', tMainNumber = '', tMainLine = ''
let tDraftId = '' // DRAFT (iz B12 po resetu) — receive na osnutku → 409
let tMultiId = '', tMultiLine1 = '', tMultiLine2 = '' // 2-postavni DISPATCHED (D validacije)
let tPartialNumber = ''

// ── E fiksture (ustvarjene lenientno v ensureE) ──
let eReady = false
let tE: Record<string, string> = {}

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

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function seedEmployee(key: string, name: string, role: string, loc: string | null, seq: number): Promise<string> {
  const id = `${P}${key}-${RUN}`
  const pin = `${PIN_BASE}${seq}`
  const f = employeePinFields(pin, `${id}@test.local`)
  await db.employee.create({
    data: {
      id, name, email: `${id}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

async function mkItem(key: string, name: string, qty: number, cost: number, loc: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = `${P}${key}-${RUN}`
  await db.inventoryItem.create({
    data: { id, name, unit: 'kg', quantity: qty, minQuantity: 0, costPerUnit: cost, supplier: `${P} Doba`, category: 'coffee', locationId: loc, ...over },
  })
  return id
}

async function mkBatch(key: string, itemId: string, loc: string, remaining: number, status = 'ACTIVE', expiryInDays = 90): Promise<string> {
  const id = `${P}${key}-${RUN}`
  await db.inventoryBatch.create({
    data: {
      id, inventoryItemId: itemId, locationId: loc,
      lotNumber: `${P}lot${key}-${RUN}`,
      receivedAt: new Date(Date.now() - 60 * 60_000),
      expiryDate: new Date(Date.now() + expiryInDays * DAY),
      quantityInitial: remaining, quantityRemaining: remaining,
      unit: 'kg', unitCost: 5, status,
    },
  })
  return id
}

/** POST /api/transfers (201 obvezen) → id + številka + id-ji vrstic. */
async function mkTransfer(token: string, from: string, to: string, lines: unknown[], extra: Record<string, unknown> = {}): Promise<{ id: string; number: string; lineIds: string[] }> {
  const r = await transfersPOST(req('POST', '/api/transfers', token, { fromLocationId: from, toLocationId: to, lines, ...extra }))
  if (r.status !== 201) throw new Error(`mkTransfer: POST ${r.status} — ${await r.text()}`)
  const j = await body(r)
  const t = j.transfer as Record<string, unknown>
  const linesOut = (t.lines as Array<Record<string, unknown>>) ?? []
  return { id: String(t.id), number: String(t.transferNumber), lineIds: linesOut.map((l) => String(l.id)) }
}

async function dispatch(token: string, id: string, note?: string): Promise<Response> {
  return dispatchPOST(req('POST', `/api/transfers/${id}/dispatch`, token, note ? { note } : {}), params(id))
}

async function receive(token: string, id: string, lines: unknown[], note?: string): Promise<Response> {
  return receivePOST(req('POST', `/api/transfers/${id}/receive`, token, note ? { lines, note } : { lines }), params(id))
}

async function cancel(token: string, id: string, reason: string): Promise<Response> {
  return cancelPOST(req('POST', `/api/transfers/${id}/cancel`, token, { reason }), params(id))
}

/**
 * ROČNO čiščenje modelov, ki jih ID_SWEEP/LOCATION_CHILD_SWEEP ne pokrijeta
 * (StockTransfer nima locationId; EventLog/auditLog nista v lokacijskem prehodu;
 * StockBatchAllocation/StockTransaction imajo nid() id-je na cilju):
 *  1. vsi artikli naših lokacij (sejani + API-ustvarjeni cilji),
 *  2. alokacije → transakcije → serije → artikli (FK Restrict vrstni red),
 *  3. prenosi (from/to v naših lokacijah) — postavke kaskadirajo,
 *  4. eventLog/auditLog po locationId,
 *  5. org drevo po id predponi (FIELD_SWEEP pokrije tudi po imenu),
 *  6. sweepTestFixtures za vse ostalo (lokacije, zaposleni, ...).
 */
async function cleanup() {
  const locs = await db.location.findMany({ where: { id: { startsWith: P } }, select: { id: true } }).catch(() => [] as { id: string }[])
  const locIds = locs.map((l) => l.id)
  if (locIds.length > 0) {
    const items = await db.inventoryItem.findMany({ where: { locationId: { in: locIds } }, select: { id: true } }).catch(() => [] as { id: string }[])
    const itemIds = items.map((i) => i.id)
    const transfers = await db.stockTransfer
      .findMany({ where: { OR: [{ fromLocationId: { in: locIds } }, { toLocationId: { in: locIds } }] }, select: { id: true } })
      .catch(() => [] as { id: string }[])
    const transferIds = transfers.map((t) => t.id)
    if (itemIds.length > 0 || transferIds.length > 0) {
      await db.stockBatchAllocation.deleteMany({ where: { inventoryItemId: { in: itemIds.length ? itemIds : ['__none__'] } } }).catch(() => null)
      await db.stockTransaction.deleteMany({ where: { inventoryItemId: { in: itemIds.length ? itemIds : ['__none__'] } } }).catch(() => null)
    }
    if (itemIds.length > 0) {
      await db.inventoryBatch.deleteMany({ where: { OR: [{ inventoryItemId: { in: itemIds } }, { locationId: { in: locIds } }] } }).catch(() => null)
      await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } }).catch(() => null)
    }
    if (transferIds.length > 0) {
      await db.stockTransferItem.deleteMany({ where: { transferId: { in: transferIds } } }).catch(() => null)
      await db.stockTransfer.deleteMany({ where: { id: { in: transferIds } } }).catch(() => null)
    }
    await db.eventLog.deleteMany({ where: { locationId: { in: locIds } } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { locationId: { in: locIds } } }).catch(() => null)
  }
  await db.property.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.brand.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.organization.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()

  // org drevo ×2 (issue5 vzorec): orgA s TREMI lokacijami, orgB z eno
  orgA = `${P}orgA-${RUN}`; brandA = `${P}brandA-${RUN}`; propA = `${P}propA-${RUN}`
  orgB = `${P}orgB-${RUN}`; brandB = `${P}brandB-${RUN}`; propB = `${P}propB-${RUN}`
  locA1 = `${P}locA1-${RUN}`; locA2 = `${P}locA2-${RUN}`; locA3 = `${P}locA3-${RUN}`; locB = `${P}locB-${RUN}`
  await db.organization.create({ data: { id: orgA, name: `${P}Org A`, slug: `${P}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: `${P}Org B`, slug: `${P}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: `${P}Brand A` } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: `${P}Brand B` } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: `${P}Prop A` } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: `${P}Prop B` } })
  await db.location.create({ data: { id: locA1, name: `${P}Ljubljana`, code: `I8A1-${RUN.toUpperCase()}`, propertyId: propA } })
  await db.location.create({ data: { id: locA2, name: `${P}Maribor`, code: `I8A2-${RUN.toUpperCase()}`, propertyId: propA } })
  await db.location.create({ data: { id: locA3, name: `${P}Celje`, code: `I8A3-${RUN.toUpperCase()}`, propertyId: propA } })
  await db.location.create({ data: { id: locB, name: `${P}Zagreb`, code: `I8B-${RUN.toUpperCase()}`, propertyId: propB } })

  mgrA1 = await seedEmployee('mgrA1', `${P}Vodja Ana`, 'manager', locA1, 1)
  mgrA2 = await seedEmployee('mgrA2', `${P}Vodja Bori`, 'manager', locA2, 2)
  mgrB = await seedEmployee('mgrB', `${P}Vodja Cvetka`, 'manager', locB, 3)
  waiterA = await seedEmployee('waiterA', `${P}Natakar Timi`, 'waiter', locA1, 4)
  ownerA = await seedEmployee('ownerA', `${P}Lastnik Leopold`, 'owner', locA1, 5)
  tokA1 = createToken({ sub: mgrA1, name: `${P}Vodja Ana`, role: 'MANAGER', loc: locA1, sv: 0 })
  tokA2 = createToken({ sub: mgrA2, name: `${P}Vodja Bori`, role: 'MANAGER', loc: locA2, sv: 0 })
  tokB = createToken({ sub: mgrB, name: `${P}Vodja Cvetka`, role: 'MANAGER', loc: locB, sv: 0 })
  tokWaiter = createToken({ sub: waiterA, name: `${P}Natakar Timi`, role: 'WAITER', loc: locA1, sv: 0 })
  tokOwner = createToken({ sub: ownerA, name: `${P}Lastnik Leopold`, role: 'OWNER', loc: locA1, sv: 0 })

  // ── artikli izvora (locA1) ──
  itemA1 = await mkItem('itemA1', `${P} Moka`, 100, 5, locA1)
  itemA1b = await mkItem('itemA1b', `${P} Arabika`, 100, 5, locA1)
  itemLow = await mkItem('itemLow', `${P} Nizka`, 2, 5, locA1)
  itemNoBatch = await mkItem('itemNoBatch', `${P} Brez serije`, 100, 5, locA1)
  itemPartial = await mkItem('itemPartial', `${P} Delni`, 100, 5, locA1)
  itemRobusta = await mkItem('itemRobusta', `${P} Robusta`, 50, 5, locA1)
  itemBatchSmall = await mkItem('itemBatchSmall', `${P} Mala serija`, 100, 5, locA1)
  itemBatchExact = await mkItem('itemBatchExact', `${P} Tocna serija`, 100, 5, locA1)
  itemMulti1 = await mkItem('itemMulti1', `${P} Multi1`, 50, 5, locA1)
  itemMulti2 = await mkItem('itemMulti2', `${P} Multi2`, 50, 5, locA1)
  // ── ciljni artikel z ISTIM imenom na locA2 (razrešitev po imenu) ──
  itemSameName = await mkItem('itemSameName', `${P} Moka`, 5, 3, locA2)

  // ── serije ──
  batchA = await mkBatch('batchA', itemA1, locA1, 50)
  batchBlocked = await mkBatch('batchBlocked', itemA1, locA1, 5, 'QUARANTINE')
  batchPartial = await mkBatch('batchPartial', itemPartial, locA1, 20, 'ACTIVE', 60)
  batchSmall = await mkBatch('batchSmall', itemBatchSmall, locA1, 3)
  batchExact = await mkBatch('batchExact', itemBatchExact, locA1, 10)
  const ba = await db.inventoryBatch.findUnique({ where: { id: batchA }, select: { expiryDate: true } })
  batchAExpiry = ba?.expiryDate ?? new Date()
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ A. čisti motor (stock-transfer.ts) ═══════════════════ */

describe('A. stock-transfer.ts čisti motor', () => {
  const happyBody = {
    fromLocationId: `${P}locA1`,
    toLocationId: `${P}locA2`,
    note: '  Testni prenos  ',
    idempotencyKey: 'i8-idem-happy',
    lines: [
      { inventoryItemId: ` ${P}itemA1 `, requestedQty: 10.5, batchId: `${P}batchA`, unitCost: 5.25 },
      { inventoryItemId: `${P}itemA1b`, requestedQty: 3 },
    ],
  }

  it('A1. validateTransferInput: happy — normalizacija (trim, r3, r2, null-i)', () => {
    const v = validateTransferInput(happyBody)
    expect('error' in v).toBe(false)
    if ('error' in v) return
    expect(v.value.fromLocationId).toBe(`${P}locA1`)
    expect(v.value.toLocationId).toBe(`${P}locA2`)
    expect(v.value.note).toBe('Testni prenos')
    expect(v.value.idempotencyKey).toBe('i8-idem-happy')
    expect(v.value.lines.length).toBe(2)
    expect(v.value.lines[0].inventoryItemId).toBe(`${P}itemA1`) // trim
    expect(v.value.lines[0].requestedQty).toBe(10.5)
    expect(v.value.lines[0].unitCost).toBe(5.25)
    expect(v.value.lines[1].unitCost).toBeNull()
    expect(v.value.lines[1].batchId).toBeNull()
    expect(v.value.lines[1].lotNumber).toBeNull()
    expect(v.value.lines[1].expiryDate).toBeNull()
  })

  it('A2. from=to + manjkajoči lokaciji → slovenski napaki', () => {
    const same = validateTransferInput({ ...happyBody, fromLocationId: 'X', toLocationId: 'X' })
    expect('error' in same && same.error).toContain('isto lokacijo')
    const noFrom = validateTransferInput({ ...happyBody, fromLocationId: '' })
    expect('error' in noFrom && noFrom.error).toContain('Izvorna lokacija je obvezna')
    const noTo = validateTransferInput({ ...happyBody, toLocationId: '' })
    expect('error' in noTo && noTo.error).toContain('Ciljna lokacija je obvezna')
  })

  it('A3. vrstice: manjkajo / prazne / 51 → napaka (TRF_MAX_LINES 50)', () => {
    expect(TRF_MAX_LINES).toBe(50)
    expect('error' in validateTransferInput({ ...happyBody, lines: [] })).toBe(true)
    expect('error' in validateTransferInput({ ...happyBody, lines: undefined })).toBe(true)
    const many = { ...happyBody, lines: Array.from({ length: 51 }, (_, i) => ({ inventoryItemId: `item-${i}`, requestedQty: 1 })) }
    const r = validateTransferInput(many)
    expect('error' in r && r.error).toContain('največ 50 postavk')
  })

  it('A4. količina: ≤0 / 4 decimalke / prevelika → napaka', () => {
    expect('error' in validateTransferInput({ ...happyBody, lines: [{ inventoryItemId: 'a', requestedQty: 0 }] })).toBe(true)
    expect('error' in validateTransferInput({ ...happyBody, lines: [{ inventoryItemId: 'a', requestedQty: -1 }] })).toBe(true)
    const dec4 = validateTransferInput({ ...happyBody, lines: [{ inventoryItemId: 'a', requestedQty: 1.2345 }] })
    expect('error' in dec4 && dec4.error).toContain('3 decimalke')
    const big = validateTransferInput({ ...happyBody, lines: [{ inventoryItemId: 'a', requestedQty: 2_000_000 }] })
    expect('error' in big && big.error).toContain('prevelika')
  })

  it('A5. podvojen artikel v prenosu → napaka', () => {
    const dup = validateTransferInput({
      ...happyBody,
      lines: [
        { inventoryItemId: 'same-item', requestedQty: 1 },
        { inventoryItemId: 'same-item', requestedQty: 2 },
      ],
    })
    expect('error' in dup && dup.error).toContain('podvojen')
  })

  it('A6. opomba 501 + idempotencyKey 7/65 znakov → napaki', () => {
    const longNote = validateTransferInput({ ...happyBody, note: 'x'.repeat(501) })
    expect('error' in longNote && longNote.error).toContain('500 znakov')
    expect('error' in validateTransferInput({ ...happyBody, idempotencyKey: 'short7' })).toBe(true)
    expect('error' in validateTransferInput({ ...happyBody, idempotencyKey: 'x'.repeat(65) })).toBe(true)
    // meja 8 in 64 sta VELEJAVNI
    const ok8 = validateTransferInput({ ...happyBody, idempotencyKey: 'x'.repeat(8) })
    const ok64 = validateTransferInput({ ...happyBody, idempotencyKey: 'x'.repeat(64) })
    expect('error' in ok8).toBe(false)
    expect('error' in ok64).toBe(false)
  })

  it('A7. cena negativna / 3 decimalke + slab datum roka → napake', () => {
    const neg = validateTransferInput({ ...happyBody, lines: [{ inventoryItemId: 'a', requestedQty: 1, unitCost: -0.01 }] })
    expect('error' in neg && neg.error).toContain('negativna')
    const dec3 = validateTransferInput({ ...happyBody, lines: [{ inventoryItemId: 'a', requestedQty: 1, unitCost: 1.234 }] })
    expect('error' in dec3 && dec3.error).toContain('2 decimalki')
    const badDate = validateTransferInput({ ...happyBody, lines: [{ inventoryItemId: 'a', requestedQty: 1, expiryDate: '31.02.2026' }] })
    expect('error' in badDate && badDate.error).toContain('roka uporabnosti')
    expect('error' in validateTransferInput(null)).toBe(true)
    expect('error' in validateTransferInput('str')).toBe(true)
  })

  it('A8. computeReceiveOutcome: vse prejeto → RECEIVED (varianca 0/0); prazne vrstice → RECEIVED', () => {
    expect(computeReceiveOutcome([{ dispatchedQty: 10, receivedQty: 10, damagedQty: 0 }])).toEqual({ status: 'RECEIVED', totalMissing: 0, totalDamaged: 0 })
    expect(computeReceiveOutcome([])).toEqual({ status: 'RECEIVED', totalMissing: 0, totalDamaged: 0 })
    // več vrstic, vse popolne
    expect(
      computeReceiveOutcome([
        { dispatchedQty: 5, receivedQty: 5, damagedQty: 0 },
        { dispatchedQty: 3, receivedQty: 3, damagedQty: 0 },
      ]).status,
    ).toBe('RECEIVED')
  })

  it('A9. computeReceiveOutcome: vrzel/poškodba → PARTIAL + missing/damaged; EPS 0.0004 še RECEIVED', () => {
    expect(TRF_EPS).toBe(0.0005)
    // vrzel 2 + poškodba 2 (vsota po vrsticah)
    const p = computeReceiveOutcome([{ dispatchedQty: 10, receivedQty: 6, damagedQty: 2 }])
    expect(p.status).toBe('PARTIAL')
    expect(p.totalMissing).toBe(2)
    expect(p.totalDamaged).toBe(2)
    // samo poškodovano
    const d = computeReceiveOutcome([{ dispatchedQty: 3, receivedQty: 0, damagedQty: 3 }])
    expect(d.status).toBe('PARTIAL')
    expect(d.totalMissing).toBe(0)
    expect(d.totalDamaged).toBe(3)
    // EPS meja: |dispatched − received| = 0.0004 < 0.0005 → še RECEIVED
    expect(computeReceiveOutcome([{ dispatchedQty: 10, receivedQty: 9.9996, damagedQty: 0 }]).status).toBe('RECEIVED')
    // čez EPS → PARTIAL
    expect(computeReceiveOutcome([{ dispatchedQty: 10, receivedQty: 9.999, damagedQty: 0 }]).status).toBe('PARTIAL')
    // damaged pod EPS ne pokvari RECEIVED
    expect(computeReceiveOutcome([{ dispatchedQty: 10, receivedQty: 10, damagedQty: 0.0004 }]).status).toBe('RECEIVED')
  })

  it('A10. transferNumberFor: TRF-YYYYMMDD-0001 (ČIST (date,seq)); slab seq → TransferError', () => {
    const d = new Date(2026, 10, 5) // lokalni 5. 11. 2026
    expect(transferNumberFor(d, 1)).toBe('TRF-20261105-0001')
    expect(transferNumberFor(d, 42)).toBe('TRF-20261105-0042')
    expect(transferNumberFor(new Date(2026, 0, 2), 9999)).toBe('TRF-20260102-9999')
    expect(() => transferNumberFor(d, 0)).toThrow(TransferError)
    expect(() => transferNumberFor(d, -1)).toThrow(TransferError)
    expect(() => transferNumberFor(d, 1.5)).toThrow(TransferError)
  })

  it('A11. DTO: variance SAMO terminalno; missingQty clamp; statusi/terminal/konstante', () => {
    expect([...TRF_STATUSES]).toEqual(['DRAFT', 'DISPATCHED', 'RECEIVED', 'PARTIAL', 'CANCELLED'])
    expect([...TRF_TERMINAL]).toEqual(['RECEIVED', 'PARTIAL', 'CANCELLED'])
    expect(TRF_TX_IN).toBe('TRANSFER_IN')
    expect(TRF_TX_OUT).toBe('TRANSFER_OUT')

    const mkRow = (status: string): TrfRow => ({
      id: 'i8-t', transferNumber: 'TRF-20260101-0001', fromLocationId: 'f', toLocationId: 't',
      status, note: 'n', idempotencyKey: null, createdById: null, dispatchedById: null, dispatchedAt: null,
      receivedById: null, receivedAt: null, cancelledAt: null, cancelReason: '', createdAt: new Date('2026-01-01T10:00:00Z'),
      items: [mkLineRow()],
    })
    const mkLineRow = (): TrfLineRow => ({
      id: 'i8-l', transferId: 'i8-t', inventoryItemId: 'i8-i', itemName: `${P} Moka`, unit: 'kg',
      requestedQty: 10, dispatchedQty: 10, receivedQty: 6, damagedQty: 2, unitCost: 5,
      batchId: null, lotNumber: null, expiryDate: null, targetItemId: null, note: '', createdAt: new Date(),
    })

    const draft = transferDto(mkRow('DRAFT'))
    expect(draft.variance).toBeUndefined() // osnutek še nima variance
    expect(draft.itemCount).toBe(1)
    const received = transferDto(mkRow('RECEIVED'))
    expect(received.variance).toEqual({ missingQty: 2, damagedQty: 2 })
    expect(received.lines?.[0].missingQty).toBe(2)

    // missing clamp na 0 (received + damaged > dispatched — defenzivno)
    const line = mkLineRow()
    line.receivedQty = 9
    line.damagedQty = 9
    expect(transferLineDto(line).missingQty).toBe(0)
    // unitCost null + prazen naziv artikla → padi
    const l2 = mkLineRow()
    l2.unitCost = null
    l2.itemName = ''
    const dto2 = transferLineDto(l2)
    expect(dto2.unitCost).toBeNull()
    expect(dto2.itemName).toBe('(izbrisan artikel)')
  })
})

/* ═══════════════════ B. POST /api/transfers (osnutek) ═══════════════════ */

describe('B. POST /api/transfers — osnutek + varovanja', () => {
  it('B1. 201 happy: DRAFT + TRF- številka + snapshot + audit TRANSFER_CREATED', async () => {
    const r = await transfersPOST(
      req('POST', '/api/transfers', tokA1, {
        fromLocationId: locA1, toLocationId: locA2, note: 'Testni prenos',
        lines: [{ inventoryItemId: itemA1, requestedQty: 10, batchId: batchA }],
      }),
    )
    expect(r.status).toBe(201)
    const j = await body(r)
    const t = j.transfer as Record<string, unknown>
    tMainId = String(t.id)
    tMainNumber = String(t.transferNumber)
    tMainLine = String((t.lines as Array<Record<string, unknown>>)[0].id)
    expect(t.status).toBe('DRAFT')
    expect(tMainNumber).toMatch(/^TRF-\d{8}-\d{4}$/)
    expect(t.fromLocationId).toBe(locA1)
    expect(t.toLocationId).toBe(locA2)
    expect(t.note).toBe('Testni prenos')
    expect(t.itemCount).toBe(1)
    expect(t.dispatchedAt).toBeNull()
    expect(t.variance).toBeUndefined()
    const line = (t.lines as Array<Record<string, unknown>>)[0]
    expect(line.itemName).toBe(`${P} Moka`) // snapshot imena
    expect(line.unit).toBe('kg') // snapshot enote
    expect(line.unitCost).toBe(5) // pad iz costPerUnit artikla (r2)
    expect(line.requestedQty).toBe(10)
    expect(line.dispatchedQty).toBe(0)
    expect(line.receivedQty).toBe(0)
    expect(line.damagedQty).toBe(0)
    expect(line.batchId).toBe(batchA)
    expect(String(line.lotNumber)).toBe(`${P}lotbatchA-${RUN}`) // snapshot serije
    expect(line.expiryDate).toBeTruthy()

    // DB stanje: osnutek NE knjiža zaloge (zaloga/serija nedotaknjeni)
    const dbItem = await db.inventoryItem.findUnique({ where: { id: itemA1 } })
    expect(num(dbItem?.quantity)).toBe(100)
    const dbBatch = await db.inventoryBatch.findUnique({ where: { id: batchA } })
    expect(num(dbBatch?.quantityRemaining)).toBe(50)
    const dbT = await db.stockTransfer.findUnique({ where: { id: tMainId }, include: { items: true } })
    expect(dbT?.status).toBe('DRAFT')
    expect(dbT?.items.length).toBe(1)
    expect(num(dbT?.items[0].dispatchedQty)).toBe(0)
    // nič gibanja zaloge ob osnutku
    const txCount = await db.stockTransaction.count({ where: { inventoryItemId: itemA1, type: TRF_TX_OUT } })
    expect(txCount).toBe(0)

    // audit TRANSFER_CREATED s fromLocationId v detaljih
    const audits = await db.auditLog.findMany({ where: { entityId: tMainId, action: 'TRANSFER_CREATED' } })
    expect(audits.length).toBe(1)
    expect(audits[0].entityType).toBe('StockTransfer')
    expect(audits[0].locationId).toBe(locA1)
    expect(audits[0].details).toContain(`"fromLocationId":"${locA1}"`)
    expect(audits[0].details).toContain(`"transferNumber":"${tMainNumber}"`)
    expect(audits[0].details).toContain('"lineCount":1')
  })

  it('B2. idempotentni replay: 200 idempotentReplay + BREZ druge vrstice', async () => {
    const key = `i8-idem-${RUN}`
    const mk = () => ({
      fromLocationId: locA1, toLocationId: locA2, idempotencyKey: key,
      lines: [{ inventoryItemId: itemA1b, requestedQty: 1 }],
    })
    const r1 = await transfersPOST(req('POST', '/api/transfers', tokA1, mk()))
    expect(r1.status).toBe(201)
    const j1 = await body(r1)
    const id1 = String((j1.transfer as Record<string, unknown>).id)

    const r2 = await transfersPOST(req('POST', '/api/transfers', tokA1, mk()))
    expect(r2.status).toBe(200) // replay — ne 201
    const j2 = await body(r2)
    expect(j2.idempotentReplay).toBe(true)
    expect(String((j2.transfer as Record<string, unknown>).id)).toBe(id1)
    // točno ENA vrstica s tem ključem
    const count = await db.stockTransfer.count({ where: { idempotencyKey: key } })
    expect(count).toBe(1)
  })

  it('B3. from=to → 400 (prenos na isto lokacijo)', async () => {
    const r = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locA1, lines: [{ inventoryItemId: itemA1, requestedQty: 1 }] }),
    )
    expect(r.status).toBe(400)
    expect(String((await body(r)).error)).toContain('isto lokacijo')
  })

  it('B4. neznana izvorna/ciljna lokacija → 404 (prijava prijazne napake)', async () => {
    const lines = [{ inventoryItemId: itemA1, requestedQty: 1 }]
    const r1 = await transfersPOST(req('POST', '/api/transfers', tokA1, { fromLocationId: `${P}ne-obstaja`, toLocationId: locA2, lines }))
    expect(r1.status).toBe(404)
    expect(String((await body(r1)).error)).toContain('Izvorna lokacija ne obstaja')
    const r2 = await transfersPOST(req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: `${P}ne-obstaja`, lines }))
    expect(r2.status).toBe(404)
    expect(String((await body(r2)).error)).toContain('Ciljna lokacija ne obstaja')
  })

  it('B5. cross-tenant (orgA → orgB) → 403 Prenos med organizacijami ni dovoljen', async () => {
    const r = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locB, lines: [{ inventoryItemId: itemA1, requestedQty: 1 }] }),
    )
    expect(r.status).toBe(403)
    expect(String((await body(r)).error)).toBe('Prenos med organizacijami ni dovoljen.')
    // noben prenos ni nastal
    const count = await db.stockTransfer.count({ where: { fromLocationId: locA1, toLocationId: locB } })
    expect(count).toBe(0)
  })

  it('B6. mgrA1 (obseg locA1) s from=locA2 → 403 (guardResource izvora)', async () => {
    const r = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA2, toLocationId: locA1, lines: [{ inventoryItemId: itemA1, requestedQty: 1 }] }),
    )
    expect(r.status).toBe(403)
  })

  it('B7. neznan artikel → 404', async () => {
    const r = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locA2, lines: [{ inventoryItemId: `${P}item-ne-obstaja`, requestedQty: 1 }] }),
    )
    expect(r.status).toBe(404)
    expect(String((await body(r)).error)).toContain('Artikel ne obstaja')
  })

  it('B8. artikel ciljne lokacije v prenosu iz locA1 → 400 Artikel ni na izvorni lokaciji', async () => {
    const r = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locA2, lines: [{ inventoryItemId: itemSameName, requestedQty: 1 }] }),
    )
    expect(r.status).toBe(400)
    expect(String((await body(r)).error)).toContain('ni na izvorni lokaciji')
  })

  it('B9. neznana serija → 404; serija drugega artikla → 400', async () => {
    const r1 = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locA2, lines: [{ inventoryItemId: itemA1, requestedQty: 1, batchId: `${P}batch-ne-obstaja` }] }),
    )
    expect(r1.status).toBe(404)
    expect(String((await body(r1)).error)).toContain('Serija ne obstaja')
    // serija itemA1 na postavki itemA1b
    const r2 = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locA2, lines: [{ inventoryItemId: itemA1b, requestedQty: 1, batchId: batchA }] }),
    )
    expect(r2.status).toBe(400)
    expect(String((await body(r2)).error)).toContain('Serija ne pripada artiklu postavke')
  })

  it('B10. serija v karanteni → 409 Serija je blokirana', async () => {
    const r = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locA2, lines: [{ inventoryItemId: itemA1, requestedQty: 1, batchId: batchBlocked }] }),
    )
    expect(r.status).toBe(409)
    expect(String((await body(r)).error)).toBe('Serija je blokirana.')
  })

  it('B11. brez žetona → 401; waiter (brez inventory.manage) → 403', async () => {
    const lines = [{ inventoryItemId: itemA1, requestedQty: 1 }]
    const r401 = await transfersPOST(req('POST', '/api/transfers', '', { fromLocationId: locA1, toLocationId: locA2, lines }))
    expect(r401.status).toBe(401)
    const r403 = await transfersPOST(req('POST', '/api/transfers', tokWaiter, { fromLocationId: locA1, toLocationId: locA2, lines }))
    expect(r403.status).toBe(403)
  })

  it('B12. pre-DDL: transferTablesReady=false → 503; reset → POST 201 (ustvari tDraft za D)', async () => {
    __setTransferTablesCacheForTests(false)
    try {
      const r = await transfersPOST(
        req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locA2, lines: [{ inventoryItemId: itemLow, requestedQty: 1 }] }),
      )
      expect(r.status).toBe(503)
      expect(String((await body(r)).error)).toContain('migracijo')
    } finally {
      __resetTransferTablesCacheForTests()
    }
    const rOk = await transfersPOST(
      req('POST', '/api/transfers', tokA1, { fromLocationId: locA1, toLocationId: locA2, lines: [{ inventoryItemId: itemLow, requestedQty: 1 }] }),
    )
    expect(rOk.status).toBe(201)
    tDraftId = String(((await body(rOk)).transfer as Record<string, unknown>).id)
  })
})

/* ═══════════════════ C. dispatch (odpremnica) ═══════════════════ */

describe('C. POST /api/transfers/[id]/dispatch', () => {
  it('C1. happy: DRAFT→DISPATCHED + item 100→90 + serija 50→40 + TRANSFER_OUT + alokacija + audit', async () => {
    const r = await dispatch(tokA1, tMainId, 'Odprema v redu')
    expect(r.status).toBe(200)
    const j = await body(r)
    const t = j.transfer as Record<string, unknown>
    expect(t.status).toBe('DISPATCHED')
    expect(t.dispatchedAt).toBeTruthy()
    expect(String((t.lines as Array<Record<string, unknown>>)[0].dispatchedQty)).toBe('10')

    // DB: zaloga izvora dekrementirana
    const dbItem = await db.inventoryItem.findUnique({ where: { id: itemA1 } })
    expect(num(dbItem?.quantity)).toBe(90)
    // DB: serija dekrementirana
    const dbBatch = await db.inventoryBatch.findUnique({ where: { id: batchA } })
    expect(num(dbBatch?.quantityRemaining)).toBe(40)
    expect(dbBatch?.status).toBe('ACTIVE')

    // ledger ≡ DB: TRANSFER_OUT podpisan negativno, previous/new iz svežih branj
    const txs = await db.stockTransaction.findMany({ where: { inventoryItemId: itemA1, type: TRF_TX_OUT } })
    expect(txs.length).toBe(1)
    const tx = txs[0]
    expect(num(tx.quantity)).toBe(-10)
    expect(num(tx.previousQty)).toBe(100)
    expect(num(tx.newQty)).toBe(90)
    expect(num(tx.costPerUnit)).toBe(5)
    expect(num(tx.totalCost)).toBe(50)
    expect(tx.supplierDoc).toBe(tMainNumber)
    expect(tx.reason).toContain('Medlokacijski prenos')
    expect(tx.employeeId).toBe(mgrA1)

    // alokacija serije ↔ transakcija (FK varni vrstni red: tx NAJPREJ)
    const allocs = await db.stockBatchAllocation.findMany({ where: { batchId: batchA } })
    expect(allocs.length).toBe(1)
    expect(allocs[0].stockTransactionId).toBe(tx.id)
    expect(allocs[0].inventoryItemId).toBe(itemA1)
    expect(num(allocs[0].quantity)).toBe(10)

    // vrstica: odpremljena količina + opomba pripeta
    const line = await db.stockTransferItem.findUnique({ where: { id: tMainLine } })
    expect(num(line?.dispatchedQty)).toBe(10)
    expect(String(line?.note)).toContain('Odprema v redu')

    // audit
    const audits = await db.auditLog.findMany({ where: { entityId: tMainId, action: 'TRANSFER_DISPATCHED' } })
    expect(audits.length).toBe(1)
    expect(audits[0].locationId).toBe(locA1)
    expect(audits[0].details).toContain('"totalQty":10')
  })

  it('C2. DVOJNI dispatch → 409 + zaloga/serija NEspremenjeni + točno ENA TRANSFER_OUT (idempotenca)', async () => {
    const r = await dispatch(tokA1, tMainId)
    expect(r.status).toBe(409)
    expect(String((await body(r)).error)).toBe('Prenos ni v stanju osnutka.')
    // nič se NI spremenilo (dokaz proti dvojnemu knjiženju)
    const dbItem = await db.inventoryItem.findUnique({ where: { id: itemA1 } })
    expect(num(dbItem?.quantity)).toBe(90)
    const dbBatch = await db.inventoryBatch.findUnique({ where: { id: batchA } })
    expect(num(dbBatch?.quantityRemaining)).toBe(40)
    const txCount = await db.stockTransaction.count({ where: { inventoryItemId: itemA1, type: TRF_TX_OUT } })
    expect(txCount).toBe(1) // NOBENE nove vrstice
    const allocCount = await db.stockBatchAllocation.count({ where: { batchId: batchA } })
    expect(allocCount).toBe(1)
  })

  it('C3. premalo zaloge (2 < 5) → 409 + zaloga nespremenjena + BREZ tx + status ostane DRAFT', async () => {
    const { id } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemLow, requestedQty: 5 }])
    const r = await dispatch(tokA1, id)
    expect(r.status).toBe(409)
    const err = String((await body(r)).error)
    expect(err).toContain('Premalo zaloge')
    expect(err).toContain('Nizka')
    const dbItem = await db.inventoryItem.findUnique({ where: { id: itemLow } })
    expect(num(dbItem?.quantity)).toBe(2)
    const txCount = await db.stockTransaction.count({ where: { inventoryItemId: itemLow, type: TRF_TX_OUT } })
    expect(txCount).toBe(0)
    const dbT = await db.stockTransfer.findUnique({ where: { id } })
    expect(dbT?.status).toBe('DRAFT') // CAS rollback — status se NI prestavil
  })

  it('C4. premalo serije (3 < 10) → 409 + CELOTEN rollback (item 100 nespremenjen)', async () => {
    const { id } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemBatchSmall, requestedQty: 10, batchId: batchSmall }])
    const r = await dispatch(tokA1, id)
    expect(r.status).toBe(409)
    expect(String((await body(r)).error)).toContain('ne pokrije')
    // item je bil DEKREMENTIRAN znotraj TX, a je batch fail povrnil CELOTO
    const dbItem = await db.inventoryItem.findUnique({ where: { id: itemBatchSmall } })
    expect(num(dbItem?.quantity)).toBe(100)
    const dbBatch = await db.inventoryBatch.findUnique({ where: { id: batchSmall } })
    expect(num(dbBatch?.quantityRemaining)).toBe(3)
    const txCount = await db.stockTransaction.count({ where: { inventoryItemId: itemBatchSmall, type: TRF_TX_OUT } })
    expect(txCount).toBe(0)
    const allocCount = await db.stockBatchAllocation.count({ where: { batchId: batchSmall } })
    expect(allocCount).toBe(0)
    const dbT = await db.stockTransfer.findUnique({ where: { id } })
    expect(dbT?.status).toBe('DRAFT')
  })

  it('C5. serija izčrpana točno (10=10) → status EXHAUSTED + remaining 0', async () => {
    const { id } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemBatchExact, requestedQty: 10, batchId: batchExact }])
    const r = await dispatch(tokA1, id)
    expect(r.status).toBe(200)
    const dbBatch = await db.inventoryBatch.findUnique({ where: { id: batchExact } })
    expect(num(dbBatch?.quantityRemaining)).toBe(0)
    expect(dbBatch?.status).toBe('EXHAUSTED')
    const dbItem = await db.inventoryItem.findUnique({ where: { id: itemBatchExact } })
    expect(num(dbItem?.quantity)).toBe(90)
  })

  it('C6. prenos BREZ serije: dispatch deluje, batch polja null, BREZ alokacije', async () => {
    const { id } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemNoBatch, requestedQty: 4 }])
    const r = await dispatch(tokA1, id)
    expect(r.status).toBe(200)
    const dbItem = await db.inventoryItem.findUnique({ where: { id: itemNoBatch } })
    expect(num(dbItem?.quantity)).toBe(96)
    const line = await db.stockTransferItem.findFirst({ where: { transferId: id } })
    expect(line?.batchId).toBeNull()
    expect(line?.lotNumber).toBeNull()
    expect(line?.expiryDate).toBeNull()
    const allocCount = await db.stockBatchAllocation.count({ where: { inventoryItemId: itemNoBatch } })
    expect(allocCount).toBe(0)
    // ledger VSED obstaja (serija ni pogoj za knjigo)
    const txCount = await db.stockTransaction.count({ where: { inventoryItemId: itemNoBatch, type: TRF_TX_OUT } })
    expect(txCount).toBe(1)
  })

  it('C7. cancel DRAFT → CANCELLED + razlog + zaloga NEdotaknjena + audit', async () => {
    const { id } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemLow, requestedQty: 1 }])
    const r = await cancel(tokA1, id, 'Napačen artikel naročen')
    expect(r.status).toBe(200)
    const j = await body(r)
    const t = j.transfer as Record<string, unknown>
    expect(t.status).toBe('CANCELLED')
    expect(t.cancelledAt).toBeTruthy()
    expect(t.cancelReason).toBe('Napačen artikel naročen')
    // osnutek ni knjižil ničesar → preklic ne vrača
    const dbItem = await db.inventoryItem.findUnique({ where: { id: itemLow } })
    expect(num(dbItem?.quantity)).toBe(2)
    const txCount = await db.stockTransaction.count({ where: { inventoryItemId: itemLow, type: TRF_TX_OUT } })
    expect(txCount).toBe(0)
    const audits = await db.auditLog.findMany({ where: { entityId: id, action: 'TRANSFER_CANCELLED' } })
    expect(audits.length).toBe(1)
    expect(audits[0].details).toContain('Napačen artikel naročen')
  })

  it('C8. cancel po dispatch → 409 (blago fizično potuje)', async () => {
    const { id, lineIds } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemMulti1, requestedQty: 5 }, { inventoryItemId: itemMulti2, requestedQty: 4 }])
    tMultiId = id
    tMultiLine1 = lineIds[0]
    tMultiLine2 = lineIds[1]
    const rd = await dispatch(tokA1, id)
    expect(rd.status).toBe(200)
    const rc = await cancel(tokA1, id, 'Preklic po odpremi')
    expect(rc.status).toBe(409)
    expect(String((await body(rc)).error)).toBe('Preklicati je mogoče le osnutek prenosa.')
  })

  it('C9. cancel s kratkim razlogom (2 znaka) → 400', async () => {
    const { id } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemLow, requestedQty: 1 }])
    const r = await cancel(tokA1, id, 'ab')
    expect(r.status).toBe(400)
    expect(String((await body(r)).error)).toContain('vsaj 3 znake')
    // prenos ostane DRAFT (razlog je bil zavrnjen)
    const dbT = await db.stockTransfer.findUnique({ where: { id } })
    expect(dbT?.status).toBe('DRAFT')
  })

  it('C10. ciljni manager (mgrA2, locA2) NE more odpreti izvornega prenosa → 403; brez žetona → 401', async () => {
    const { id } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemLow, requestedQty: 1 }])
    const r403 = await dispatch(tokA2, id)
    expect(r403.status).toBe(403)
    const r401 = await dispatch('', id)
    expect(r401.status).toBe(401)
    // 404 za neznani id
    const r404 = await dispatch(tokA1, `${P}ne-obstaja`)
    expect(r404.status).toBe(404)
  })
})

/* ═══════════════════ D. receive (prevzem) ═══════════════════ */

describe('D. POST /api/transfers/[id]/receive', () => {
  it('D1. happy full: RECEIVED + razrešitev cilja po imenu (5+10=15) + TRANSFER_IN + utežena cena + ciljna serija', async () => {
    const r = await receive(tokA2, tMainId, [{ transferItemId: tMainLine, receivedQty: 10, note: 'Prevzem v redu' }])
    expect(r.status).toBe(200)
    const j = await body(r)
    const t = j.transfer as Record<string, unknown>
    expect(t.status).toBe('RECEIVED')
    expect(t.receivedAt).toBeTruthy()
    expect(t.variance).toEqual({ missingQty: 0, damagedQty: 0 })
    const line = (t.lines as Array<Record<string, unknown>>)[0]
    expect(line.receivedQty).toBe(10)
    expect(line.targetItemId).toBe(itemSameName)

    // ciljni artikel: ISTO ime na locA2 → količina 5+10=15
    const dbTarget = await db.inventoryItem.findUnique({ where: { id: itemSameName } })
    expect(num(dbTarget?.quantity)).toBe(15)
    // utežena povprečna cena: 5 kg @ 3 € + 10 kg @ 5 € → (15+50)/15 = 4.33
    expect(num(dbTarget?.costPerUnit)).toBe(4.33)

    // TRANSFER_IN: pozitiven, previous 5 → new 15, supplierDoc = številka
    const txs = await db.stockTransaction.findMany({ where: { inventoryItemId: itemSameName, type: TRF_TX_IN } })
    expect(txs.length).toBe(1)
    expect(num(txs[0].quantity)).toBe(10)
    expect(num(txs[0].previousQty)).toBe(5)
    expect(num(txs[0].newQty)).toBe(15)
    expect(txs[0].supplierDoc).toBe(tMainNumber)
    expect(txs[0].note).toContain('Prevzem v redu')

    // ciljna serija: lot TRF-n-1, dobrih 10, ACTIVE, lokacija cilja, rok kopiran
    const tb = await db.inventoryBatch.findFirst({ where: { lotNumber: `${tMainNumber}-1` } })
    expect(tb).toBeTruthy()
    expect(tb?.inventoryItemId).toBe(itemSameName)
    expect(tb?.locationId).toBe(locA2)
    expect(num(tb?.quantityInitial)).toBe(10)
    expect(num(tb?.quantityRemaining)).toBe(10)
    expect(num(tb?.unitCost)).toBe(5)
    expect(tb?.status).toBe('ACTIVE')
    expect(tb?.expiryDate?.toISOString()).toBe(batchAExpiry.toISOString())

    // vrstica: receivedQty + targetItemId + opomba
    const dbLine = await db.stockTransferItem.findUnique({ where: { id: tMainLine } })
    expect(num(dbLine?.receivedQty)).toBe(10)
    expect(num(dbLine?.damagedQty)).toBe(0)
    expect(dbLine?.targetItemId).toBe(itemSameName)
    expect(String(dbLine?.note)).toContain('Prevzem v redu')

    // izvor JE odbit (tranzit: cilj dobi, izvor izgubi — skupna zaloga ohranjena)
    const dbSrc = await db.inventoryItem.findUnique({ where: { id: itemA1 } })
    expect(num(dbSrc?.quantity)).toBe(90)

    // audit TRANSFER_RECEIVED
    const audits = await db.auditLog.findMany({ where: { entityId: tMainId, action: 'TRANSFER_RECEIVED' } })
    expect(audits.length).toBe(1)
    expect(audits[0].locationId).toBe(locA2)
    expect(audits[0].details).toContain('"status":"RECEIVED"')
  })

  it('D2. DVOJNI prevzem → 409 + cilj NEspremenjen + točno ENA TRANSFER_IN (idempotenca)', async () => {
    const r = await receive(tokA2, tMainId, [{ transferItemId: tMainLine, receivedQty: 10 }])
    expect(r.status).toBe(409)
    expect(String((await body(r)).error)).toBe('Prenos je že prevzet.')
    const dbTarget = await db.inventoryItem.findUnique({ where: { id: itemSameName } })
    expect(num(dbTarget?.quantity)).toBe(15)
    const txCount = await db.stockTransaction.count({ where: { inventoryItemId: itemSameName, type: TRF_TX_IN } })
    expect(txCount).toBe(1)
    const batchCount = await db.inventoryBatch.count({ where: { lotNumber: `${tMainNumber}-1` } })
    expect(batchCount).toBe(1)
  })

  it('D3. delni prevzem (6 + 2 poškodovani od 10) → PARTIAL + cilj NATANČNO 6 + serija 6', async () => {
    const { id, lineIds, number } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemPartial, requestedQty: 10, batchId: batchPartial }])
    tPartialNumber = number
    const rd = await dispatch(tokA1, id)
    expect(rd.status).toBe(200)
    const r = await receive(tokA2, id, [{ transferItemId: lineIds[0], receivedQty: 6, damagedQty: 2 }])
    expect(r.status).toBe(200)
    const j = await body(r)
    const t = j.transfer as Record<string, unknown>
    expect(t.status).toBe('PARTIAL')
    expect(t.variance).toEqual({ missingQty: 2, damagedQty: 2 })
    const line = (t.lines as Array<Record<string, unknown>>)[0]
    expect(line.receivedQty).toBe(6)
    expect(line.damagedQty).toBe(2)
    expect(line.missingQty).toBe(2)

    // ciljni artikel (avto-ustvarjen): NATANČNO 6 — poškodovani NE v zalogi
    const target = await db.inventoryItem.findFirst({ where: { name: `${P} Delni`, locationId: locA2 } })
    expect(target).toBeTruthy()
    expect(num(target?.quantity)).toBe(6)
    expect(target?.targetItemId === undefined).toBe(true) // (polje ni na InventoryItem)
    // TRANSFER_IN samo za dobre 6 (brez vrstice za poškodovane)
    const txs = await db.stockTransaction.findMany({ where: { inventoryItemId: target!.id, type: TRF_TX_IN } })
    expect(txs.length).toBe(1)
    expect(num(txs[0].quantity)).toBe(6)
    expect(num(txs[0].previousQty)).toBe(0)
    expect(num(txs[0].newQty)).toBe(6)
    // ciljna serija: remaining 6 (poškodovani izključeni)
    const tb = await db.inventoryBatch.findFirst({ where: { lotNumber: `${number}-1` } })
    expect(num(tb?.quantityRemaining)).toBe(6)
    // vrstica
    const dbLine = await db.stockTransferItem.findUnique({ where: { id: lineIds[0] } })
    expect(num(dbLine?.damagedQty)).toBe(2)
    expect(dbLine?.targetItemId).toBe(target?.id)
  })

  it('D4. samo poškodovani (0 prejeto + 3 poškodovani) → PARTIAL, cilj 0, BREZ tx/serije, missing 7', async () => {
    const { id, lineIds } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemA1b, requestedQty: 10 }])
    const rd = await dispatch(tokA1, id)
    expect(rd.status).toBe(200)
    const r = await receive(tokA2, id, [{ transferItemId: lineIds[0], receivedQty: 0, damagedQty: 3 }])
    expect(r.status).toBe(200)
    const j = await body(r)
    const t = j.transfer as Record<string, unknown>
    expect(t.status).toBe('PARTIAL')
    expect(t.variance).toEqual({ missingQty: 7, damagedQty: 3 })
    // ciljni artikel je ustvarjen s 0 (razrešitev teče), a NIČ ni knjiženo
    const target = await db.inventoryItem.findFirst({ where: { name: `${P} Arabika`, locationId: locA2 } })
    expect(target).toBeTruthy()
    expect(num(target?.quantity)).toBe(0)
    const txCount = await db.stockTransaction.count({ where: { inventoryItemId: target!.id, type: TRF_TX_IN } })
    expect(txCount).toBe(0)
    const batchCount = await db.inventoryBatch.count({ where: { inventoryItemId: target!.id } })
    expect(batchCount).toBe(0)
  })

  it('D5. presega odpremljenega (6 > 5) → 400', async () => {
    const r = await receive(tokA2, tMultiId, [{ transferItemId: tMultiLine1, receivedQty: 6 }])
    expect(r.status).toBe(400)
    expect(String((await body(r)).error)).toContain('presega odpremljeno')
  })

  it('D6. prevzem na DRAFTU → 409 Prenos še ni odpremljen', async () => {
    const r = await receive(tokA2, tDraftId, [{ transferItemId: 'vrstica-ni-pomembna', receivedQty: 1 }])
    expect(r.status).toBe(409)
    expect(String((await body(r)).error)).toBe('Prenos še ni odpremljen.')
  })

  it('D7. manjkajoča vrstica prevzema (2-postavni prenos, 1 vnos) → 400', async () => {
    const r = await receive(tokA2, tMultiId, [{ transferItemId: tMultiLine1, receivedQty: 1 }])
    expect(r.status).toBe(400)
    expect(String((await body(r)).error)).toContain('Manjka prevzem')
  })

  it('D8. podvojen vnos za isto postavko → 400', async () => {
    const r = await receive(tokA2, tMultiId, [
      { transferItemId: tMultiLine1, receivedQty: 1 },
      { transferItemId: tMultiLine1, receivedQty: 2 },
    ])
    expect(r.status).toBe(400)
    expect(String((await body(r)).error)).toContain('Podvojen prevzem')
  })

  it('D9. neznana postavka + negativna količina → 400', async () => {
    const r1 = await receive(tokA2, tMultiId, [{ transferItemId: `${P}ne-obstaja`, receivedQty: 1 }])
    expect(r1.status).toBe(400)
    expect(String((await body(r1)).error)).toContain('Neznana postavka')
    const r2 = await receive(tokA2, tMultiId, [{ transferItemId: tMultiLine1, receivedQty: -1 }])
    expect(r2.status).toBe(400)
    expect(String((await body(r2)).error)).toContain('negativna')
    // tMulti ostane DISPATCHED (validacijske napake ne knjižijo)
    const dbT = await db.stockTransfer.findUnique({ where: { id: tMultiId } })
    expect(dbT?.status).toBe('DISPATCHED')
  })

  it('D10. izvorni manager (mgrA1, locA1) NE more prevzeti → 403; brez žetona → 401', async () => {
    const r403 = await receive(tokA1, tMultiId, [{ transferItemId: tMultiLine1, receivedQty: 1 }])
    expect(r403.status).toBe(403)
    const r401 = await receive('', tMultiId, [{ transferItemId: tMultiLine1, receivedQty: 1 }])
    expect(r401.status).toBe(401)
    const r404 = await receive(tokA2, `${P}ne-obstaja`, [{ transferItemId: 'x', receivedQty: 1 }])
    expect(r404.status).toBe(404)
  })

  it('D11. AVTO-USTVARJEN ciljni artikel: ime/enota/cena/kategorija/dobavitelj posnetek vira', async () => {
    const { id, lineIds } = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: itemRobusta, requestedQty: 4 }])
    const rd = await dispatch(tokA1, id)
    expect(rd.status).toBe(200)
    // pred prevzemom cilj NE obstaja (tranzit)
    const before = await db.inventoryItem.findFirst({ where: { name: `${P} Robusta`, locationId: locA2 } })
    expect(before).toBeNull()
    const r = await receive(tokA2, id, [{ transferItemId: lineIds[0], receivedQty: 4 }])
    expect(r.status).toBe(200)
    const target = await db.inventoryItem.findFirst({ where: { name: `${P} Robusta`, locationId: locA2 } })
    expect(target).toBeTruthy()
    expect(target?.unit).toBe('kg')
    expect(num(target?.quantity)).toBe(4)
    expect(num(target?.costPerUnit)).toBe(5)
    expect(target?.category).toBe('coffee') // posnetek kategorije vira
    expect(target?.supplier).toBe(`${P} Doba`) // posnetek dobavitelja vira
    const txs = await db.stockTransaction.findMany({ where: { inventoryItemId: target!.id, type: TRF_TX_IN } })
    expect(txs.length).toBe(1)
    expect(num(txs[0].previousQty)).toBe(0)
    expect(num(txs[0].newQty)).toBe(4)
    const dbLine = await db.stockTransferItem.findUnique({ where: { id: lineIds[0] } })
    expect(dbLine?.targetItemId).toBe(target?.id)
  })
})

/* ═══════════════════ E. seznam / iskanje / obseg ═══════════════════ */

/** E fiksture: 5 statusov + locA2→locA1 (viden prejemniku) + locA2→locA3 (neviden). */
async function ensureE() {
  if (eReady) return
  const e1 = await mkItem('itemE1', `${P}E1-Caj`, 100, 5, locA1)
  const e2 = await mkItem('itemE2', `${P}E2-Kava`, 100, 5, locA1)
  const e3 = await mkItem('itemE3', `${P}E3Moka`, 100, 5, locA1)
  const e4 = await mkItem('itemE4', `${P}E4-Sol`, 100, 5, locA1)
  const e5 = await mkItem('itemE5', `${P}E5-Poper`, 100, 5, locA1)
  const e6 = await mkItem('itemE6', `${P}E6-Cokolada`, 100, 5, locA2)
  const e7 = await mkItem('itemE7', `${P}E7-Vanilija`, 100, 5, locA2)

  const tE1 = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: e1, requestedQty: 2 }]) // DRAFT
  const tE2 = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: e2, requestedQty: 2 }]) // DISPATCHED
  await dispatch(tokA1, tE2.id)
  const tE3 = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: e3, requestedQty: 2 }]) // RECEIVED
  await dispatch(tokA1, tE3.id)
  await receive(tokA2, tE3.id, [{ transferItemId: tE3.lineIds[0], receivedQty: 2 }])
  const tE4 = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: e4, requestedQty: 2 }]) // CANCELLED
  await cancel(tokA1, tE4.id, 'Preklic za test')
  const tE5 = await mkTransfer(tokA1, locA1, locA2, [{ inventoryItemId: e5, requestedQty: 2 }]) // PARTIAL
  await dispatch(tokA1, tE5.id)
  await receive(tokA2, tE5.id, [{ transferItemId: tE5.lineIds[0], receivedQty: 1, damagedQty: 1 }])
  const tE6 = await mkTransfer(tokA2, locA2, locA1, [{ inventoryItemId: e6, requestedQty: 2 }]) // locA2→locA1
  const tE7 = await mkTransfer(tokA2, locA2, locA3, [{ inventoryItemId: e7, requestedQty: 2 }]) // locA2→locA3
  tE = {
    tE1: tE1.id, tE2: tE2.id, tE3: tE3.id, tE4: tE4.id, tE5: tE5.id,
    tE6: tE6.id, tE7: tE7.id, nE4: tE4.number,
  }
  eReady = true
}

describe('E. GET /api/transfers — seznam, obseg, filtri', () => {
  it('E1. obseg OR: mgrA1 vidi from ALI to = locA1 (tudi prenos V cilju locA1); locA2→locA3 NE', async () => {
    await ensureE()
    const r = await transfersGET(req('GET', '/api/transfers?take=100', tokA1))
    expect(r.status).toBe(200)
    const j = await body(r)
    const list = j.transfers as Array<Record<string, unknown>>
    expect(list.length).toBeGreaterThan(0)
    const ids = list.map((t) => String(t.id))
    // vsi statusi iz E fikstur so prisotni
    for (const k of ['tE1', 'tE2', 'tE3', 'tE4', 'tE5', 'tE6']) expect(ids).toContain(tE[k])
    // tE6 (locA2→locA1) je viden prek CILJA — dokaz OR obsega
    // tE7 (locA2→locA3) NI viden mgrA1
    expect(ids).not.toContain(tE.tE7)
    // vsaka vrstica ima from ALI to v uporabnikovi lokaciji (lokacijska izolacija)
    for (const t of list) {
      expect(t.fromLocationId === locA1 || t.toLocationId === locA1).toBe(true)
    }
    // status filtri na DTO + urejenost createdAt desc
    const statuses = new Set(list.map((t) => String(t.status)))
    for (const s of ['DRAFT', 'DISPATCHED', 'RECEIVED', 'PARTIAL', 'CANCELLED']) expect(statuses.has(s)).toBe(true)
    for (let i = 1; i < list.length; i++) {
      expect(new Date(String(list[i - 1].createdAt)).getTime()).toBeGreaterThanOrEqual(new Date(String(list[i].createdAt)).getTime())
    }
  })

  it('E2. mgrB (tuja org) vidi NIČ + fail-closed filter (fromLocationId tujega = prazno, ne 403)', async () => {
    const r = await transfersGET(req('GET', '/api/transfers', tokB))
    expect(r.status).toBe(200)
    const j = await body(r)
    const list = j.transfers as Array<Record<string, unknown>>
    expect(list.length).toBe(0)
    const rF = await transfersGET(req('GET', `/api/transfers?fromLocationId=${locA1}`, tokB))
    expect(rF.status).toBe(200)
    expect(((await body(rF)).transfers as unknown[]).length).toBe(0)
  })

  it('E3. centralni OWNER (orgA) vidi VSE prenose orga — tudi locA2→locA3', async () => {
    const r = await transfersGET(req('GET', '/api/transfers?take=100', tokOwner))
    expect(r.status).toBe(200)
    const ids = ((await body(r)).transfers as Array<Record<string, unknown>>).map((t) => String(t.id))
    for (const k of Object.keys(tE)) {
      if (k.startsWith('tE')) expect(ids).toContain(tE[k]) // tE7 vključno
    }
    expect(ids).toContain(tMainId)
  })

  it('E4. status filter deluje; neveljaven status → 400', async () => {
    const rC = await transfersGET(req('GET', '/api/transfers?status=CANCELLED', tokA1))
    expect(rC.status).toBe(200)
    const listC = (await body(rC)).transfers as Array<Record<string, unknown>>
    expect(listC.length).toBeGreaterThan(0)
    expect(listC.every((t) => t.status === 'CANCELLED')).toBe(true)
    expect(listC.map((t) => String(t.id))).toContain(tE.tE4)
    const rD = await transfersGET(req('GET', '/api/transfers?status=DRAFT', tokA1))
    const listD = (await body(rD)).transfers as Array<Record<string, unknown>>
    expect(listD.map((t) => String(t.id))).toContain(tE.tE1)
    expect(listD.every((t) => t.status === 'DRAFT')).toBe(true)
    const rBad = await transfersGET(req('GET', '/api/transfers?status=ODPREMLJEN', tokA1))
    expect(rBad.status).toBe(400)
    expect(String((await body(rBad)).error)).toContain('Neznan status')
  })

  it('E5. fromLocationId filter: mgrA1 vidi locA2→locA1 (tE6), NE pa locA2→locA3 (tE7)', async () => {
    const r = await transfersGET(req('GET', `/api/transfers?fromLocationId=${locA2}`, tokA1))
    expect(r.status).toBe(200)
    const list = (await body(r)).transfers as Array<Record<string, unknown>>
    const ids = list.map((t) => String(t.id))
    expect(ids).toContain(tE.tE6)
    expect(ids).not.toContain(tE.tE7)
    expect(list.every((t) => t.fromLocationId === locA2)).toBe(true)
  })

  it('E6. q iskanje: po številki dokumenta + po imenu artikla (substring)', async () => {
    const rN = await transfersGET(req('GET', `/api/transfers?q=${encodeURIComponent(tE.nE4)}`, tokA1))
    expect(rN.status).toBe(200)
    const listN = (await body(rN)).transfers as Array<Record<string, unknown>>
    expect(listN.length).toBe(1)
    expect(String(listN[0].id)).toBe(tE.tE4)
    // po imenu postavke (snapshot itemName) — 'E3Moka' je edinstveno
    const rI = await transfersGET(req('GET', `/api/transfers?q=${encodeURIComponent('E3Moka')}`, tokA1))
    expect(rI.status).toBe(200)
    const listI = (await body(rI)).transfers as Array<Record<string, unknown>>
    expect(listI.map((t) => String(t.id))).toContain(tE.tE3)
    expect(listI.map((t) => String(t.id))).not.toContain(tE.tE4)
  })

  it('E7. dateFrom/dateTo okno: prihodnost → prazno; preteklost → vse; dateTo preteklost → prazno', async () => {
    const rFut = await transfersGET(req('GET', '/api/transfers?dateFrom=2030-01-01', tokA1))
    expect(((await body(rFut)).transfers as unknown[]).length).toBe(0)
    const rPast = await transfersGET(req('GET', '/api/transfers?dateFrom=2000-01-01', tokA1))
    const listPast = (await body(rPast)).transfers as Array<Record<string, unknown>>
    expect(listPast.map((t) => String(t.id))).toContain(tE.tE1)
    const rTo = await transfersGET(req('GET', '/api/transfers?dateTo=2000-01-01', tokA1))
    expect(((await body(rTo)).transfers as unknown[]).length).toBe(0)
  })

  it('E8. brez žetona → 401; pre-DDL → 503 → reset 200', async () => {
    const r401 = await transfersGET(req('GET', '/api/transfers', ''))
    expect(r401.status).toBe(401)
    __setTransferTablesCacheForTests(false)
    try {
      const r = await transfersGET(req('GET', '/api/transfers', tokA1))
      expect(r.status).toBe(503)
      expect(String((await body(r)).error)).toContain('migracijo')
    } finally {
      __resetTransferTablesCacheForTests()
    }
    const rOk = await transfersGET(req('GET', '/api/transfers', tokA1))
    expect(rOk.status).toBe(200)
  })

  it('E9. GET [id]: 404 neznana / 403 mgrB / 403 obeh tujih lokacij / 200 owner / 200 prejemnik po cilju', async () => {
    const r404 = await transferDetailGET(req('GET', `/api/transfers/${P}ne-obstaja`, tokA1), params(`${P}ne-obstaja`))
    expect(r404.status).toBe(404)
    expect(String((await body(r404)).error)).toBe('Prenos ne obstaja.')
    // tuja organizacija → 403 (od guardResource na OBEH straneh)
    const rB = await transferDetailGET(req('GET', `/api/transfers/${tE.tE3}`, tokB), params(tE.tE3))
    expect(rB.status).toBe(403)
    // mgrA1 na locA2→locA3: NOBENA od lokacij ni njegova → 403
    const rA = await transferDetailGET(req('GET', `/api/transfers/${tE.tE7}`, tokA1), params(tE.tE7))
    expect(rA.status).toBe(403)
    // centralni owner vidi znotraj svoje orge
    const rO = await transferDetailGET(req('GET', `/api/transfers/${tE.tE7}`, tokOwner), params(tE.tE7))
    expect(rO.status).toBe(200)
    // prejemnik vidi prenos po CILJU (tE6: locA2→locA1, mgrA1 = prejemnik) + imena lokacij
    const rR = await transferDetailGET(req('GET', `/api/transfers/${tE.tE6}`, tokA1), params(tE.tE6))
    expect(rR.status).toBe(200)
    const t = (await body(rR)).transfer as Record<string, unknown>
    expect(t.fromLocationName).toBe(`${P}Maribor`)
    expect(t.toLocationName).toBe(`${P}Ljubljana`)
    expect(Array.isArray(t.lines)).toBe(true)
  })
})

/* ═══════════════════ F. ledger / usklajenost ═══════════════════ */

describe('F. ledger ≡ DB + dogodki + revizija + klasifikacija', () => {
  it('F1. TRANSFER_OUT 1× na izvoru in TRANSFER_IN 1× na cilju; verigi ≡ končni DB količini', async () => {
    const outTxs = await db.stockTransaction.findMany({ where: { inventoryItemId: itemA1, type: TRF_TX_OUT } })
    expect(outTxs.length).toBe(1)
    const inTxs = await db.stockTransaction.findMany({ where: { inventoryItemId: itemSameName, type: TRF_TX_IN } })
    expect(inTxs.length).toBe(1)
    // izvor: previous 100 → new 90 ≡ trenutna DB količina
    const src = await db.inventoryItem.findUnique({ where: { id: itemA1 } })
    expect(num(outTxs[0].previousQty)).toBe(100)
    expect(num(outTxs[0].newQty)).toBe(90)
    expect(num(src?.quantity)).toBe(num(outTxs[0].newQty))
    // cilj: previous 5 → new 15 ≡ trenutna DB količina
    const dst = await db.inventoryItem.findUnique({ where: { id: itemSameName } })
    expect(num(inTxs[0].previousQty)).toBe(5)
    expect(num(inTxs[0].newQty)).toBe(15)
    expect(num(dst?.quantity)).toBe(num(inTxs[0].newQty))
    // podpisi: OUT negativen, IN pozitiven, isti supplierDoc
    expect(num(outTxs[0].quantity)).toBe(-10)
    expect(num(inTxs[0].quantity)).toBe(10)
    expect(outTxs[0].supplierDoc).toBe(tMainNumber)
    expect(inTxs[0].supplierDoc).toBe(tMainNumber)
  })

  it('F2. EventLog: 2× StockChanged za prenos (dispatch izvor + receive cilj)', async () => {
    // publishEvent zapiše EventLog vrstico (INSERT pending + detached dispatch)
    const evts = await db.eventLog.findMany({ where: { type: 'StockChanged', entityId: tMainId } })
    expect(evts.length).toBe(2)
    const locIds = evts.map((e) => e.locationId)
    expect(locIds).toContain(locA1) // dispatch dogodek na IZVORNI lokaciji
    expect(locIds).toContain(locA2) // receive dogodek na CILJNI lokaciji
    expect(evts.every((e) => e.entityType === 'StockTransfer')).toBe(true)
  })

  it('F3. revizijska veriga: TRANSFER_CREATED → TRANSFER_DISPATCHED → TRANSFER_RECEIVED po času', async () => {
    const audits = await db.auditLog.findMany({ where: { entityId: tMainId, entityType: 'StockTransfer' }, orderBy: { timestamp: 'asc' } })
    expect(audits.map((a) => a.action)).toEqual(['TRANSFER_CREATED', 'TRANSFER_DISPATCHED', 'TRANSFER_RECEIVED'])
    // monotona časovna linija (istega ms ne more biti — trije ločeni API klici)
    for (let i = 1; i < audits.length; i++) {
      expect(audits[i].timestamp.getTime()).toBeGreaterThan(audits[i - 1].timestamp.getTime())
    }
    expect(audits[0].details).toContain('"lineCount":1')
    expect(audits[1].details).toContain('"totalQty":10')
    expect(audits[2].details).toContain('"totalReceived":10')
  })

  it('F4. txGroupOf: TRANSFER_IN → receipt (priliv), TRANSFER_OUT → waste (dokumentiran odliv)', async () => {
    expect(txGroupOf('TRANSFER_IN')).toBe('receipt')
    expect(txGroupOf('TRANSFER_OUT')).toBe('waste')
    // case-insensitive (GRN konvencija — GRN piše 'purchase' z malo)
    expect(txGroupOf('transfer_in')).toBe('receipt')
    expect(txGroupOf('transfer_out')).toBe('waste')
    // prejeto razvrščanje se NI spremenilo (regresija)
    expect(txGroupOf('purchase')).toBe('receipt')
    expect(txGroupOf('WASTE')).toBe('waste')
    expect(txGroupOf('SALE')).toBe('sale')
  })

  it('F5. alokacije serij: FK povezava batch↔tx + nič sirot za naše artikle', async () => {
    // alokacija glavnega toka povezuje serijo izvora s TRANSFER_OUT vrstico
    const alloc = await db.stockBatchAllocation.findFirst({ where: { batchId: batchA } })
    expect(alloc).toBeTruthy()
    const tx = await db.stockTransaction.findUnique({ where: { id: alloc!.stockTransactionId } })
    expect(tx?.type).toBe(TRF_TX_OUT)
    expect(tx?.supplierDoc).toBe(tMainNumber)
    expect(num(alloc?.quantity)).toBe(10)
    // vse naše alokacije kažejo na (še) žive transakcije — nobena sirota
    const items = await db.inventoryItem.findMany({ where: { locationId: { in: [locA1, locA2, locA3] } }, select: { id: true } })
    const ids = items.map((i) => i.id)
    const allocs = ids.length ? await db.stockBatchAllocation.findMany({ where: { inventoryItemId: { in: ids } } }) : []
    for (const a of allocs) {
      const t = await db.stockTransaction.findUnique({ where: { id: a.stockTransactionId }, select: { id: true } })
      expect(t).toBeTruthy()
      expect(ids).toContain(a.inventoryItemId)
    }
    expect(allocs.length).toBeGreaterThanOrEqual(1)
  })
})

/* ═══════════════════ G. register / drift / i18n ═══════════════════ */

describe('G. DDL register + drift + i18n', () => {
  it('G1. SCHEMA_MIGRATIONS vsebuje stock-transfers (#28) + endpoint + descKey + probe', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'stock-transfers')
    expect(m).toBeTruthy()
    expect(m!.endpoint).toBe('/api/admin/migrate-stock-transfers')
    expect(m!.descKey).toBe('mig.stockTransfers.desc')
    expect(typeof m!.probe).toBe('function')
    // vrstna številka #28 (števce pokriva migrations-console — tu samo pozicija)
    expect(SCHEMA_MIGRATIONS.indexOf(m!)).toBe(27) // 0-based → 28. vnos
  })

  it('G2. konzola HANDLERS vsebuje ključ stock-transfers (source-check — ni izvožen)', () => {
    // HANDLERS ni izvožen iz route modula → preverimo vir (delegacijska integriteta)
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'app', 'api', 'admin', 'migrations', 'route.ts'), 'utf8')
    expect(src).toContain("from '../migrate-stock-transfers/route'")
    expect(src).toContain("'stock-transfers': stockTransfersPOST")
  })

  it('G3. mig.stockTransfers.desc obstaja v SL + HR slovarjih', () => {
    expect(slDict['mig.stockTransfers.desc']).toBeTruthy()
    expect(hrDict['mig.stockTransfers.desc']).toBeTruthy()
    expect(String(slDict['mig.stockTransfers.desc'])).toContain('prenosi')
    expect(String(hrDict['mig.stockTransfers.desc'])).toContain('prijenosi')
  })

  it('G4. drift matcher isStockTransfersStatement: CREATE/INDEX/ALTER znani; DROP/DELETE ne; KNOWN_DRIFTS vnos', async () => {
    const { isStockTransfersStatement, KNOWN_DRIFTS } = await import('../scripts/drift-check')
    expect(isStockTransfersStatement('CREATE TABLE IF NOT EXISTS "StockTransfer" ("id" TEXT NOT NULL)')).toBe(true)
    expect(isStockTransfersStatement('CREATE TABLE IF NOT EXISTS "StockTransferItem" ("id" TEXT NOT NULL)')).toBe(true)
    expect(isStockTransfersStatement('CREATE UNIQUE INDEX IF NOT EXISTS "StockTransfer_transferNumber_key" ON "StockTransfer"("transferNumber")')).toBe(true)
    expect(isStockTransfersStatement('CREATE INDEX IF NOT EXISTS "StockTransferItem_transferId_idx" ON "StockTransferItem"("transferId")')).toBe(true)
    expect(isStockTransfersStatement('ALTER TABLE "StockTransfer" ADD COLUMN "x" TEXT')).toBe(true)
    expect(isStockTransfersStatement('DROP TABLE "StockTransfer"')).toBe(false)
    expect(isStockTransfersStatement('DELETE FROM "StockTransferItem"')).toBe(false)
    expect(isStockTransfersStatement('CREATE TABLE "X" ("id" TEXT)')).toBe(false)
    // vnos v register znanih driftov (konzola prikaže razlog pred DDL korakom)
    const drift = (KNOWN_DRIFTS as Array<{ id: string; reason: string }>).find((d) => d.id === 'stock-transfers')
    expect(drift).toBeTruthy()
    expect(drift!.reason).toContain('Medlokacijski prenosi') // as-built besedilo razloga
    expect(drift!.reason).toContain('v1.116.0')
  })

  it('G5. TAB_PERM.prenosi = inventory.manage; tabs.prenosi pariteta SL/HR (soft — UI agent dodaja)', () => {
    expect(TAB_PERM['prenosi']).toBe('inventory.manage')
    // trf.* in tabs.prenosi i18n doda UI agent — preverimo SAMO pariteto, če že obstaja
    // (namerno ne-fail na manjkajočih UI ključih — pokritje i18n je v UI testih)
    if (slDict['tabs.prenosi'] !== undefined || hrDict['tabs.prenosi'] !== undefined) {
      expect(slDict['tabs.prenosi']).toBeTruthy()
      expect(hrDict['tabs.prenosi']).toBeTruthy()
    }
  })
})
