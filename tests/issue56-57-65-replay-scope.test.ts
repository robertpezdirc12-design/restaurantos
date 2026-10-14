/**
 * Issues #57 + #56 + #65 (P1) — replay/idempotentnost val: vsak idempotency
 * ključ je klientov identifikator operacije, NE poverilnica — replay sme vrniti
 * SAMO zapis istega konteksta (lokacija/org), sicer 409 z generičnim sporočilom
 * brez tujih podatkov.
 *
 * #57 — createOrderCore (POS/QR/kiosk/sync/webhook skupno jedro):
 *   isti key + isti kontekst (lokacija/miza/tip/vir) → replay; druga lokacija,
 *   miza, vir ali tip → OrderError 409; P2002 twin dirka (isti in različni
 *   kontekst); POS ruta 201→200 replay → manager B 409; sync ruta: manager B
 *   isti clientOperationId → failed + eno naročilo.
 * #56 — stocktake replay: isti key + lokacija A → replay; manager B (druga
 *   lokacija) isti key → 409 BREZ vrstic popisa; central admin z eksplicitno
 *   lokacijo → replay viden; P2002 dirka → en popis.
 * #65 — eSLOG uvoz: deterministični ap-eslog- id (kanonični ključ = PK claim),
 *   duplicate isti kontekst → 200; central admin brez loc vidi duplicate
 *   (list↔replay konsistentnost z /api/expenses); manager B → 409 BREZ AP
 *   podatkov; isti dokument + drugačen znesek → 409 konflikt brez prekritja;
 *   sočasna uvoza → natanko EN AP + EN set vrstic.
 *
 * Fiksture s predpono i65- (idempotentno, cleanup v afterAll po FK vrstnem redu).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { createOrderCore, OrderError } from '../src/lib/ops'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as syncPOST } from '../src/app/api/sync/route'
import { POST as stocktakePOST } from '../src/app/api/stocktakes/route'
import { POST as eslogPOST } from '../src/app/api/ap/import-eslog/route'

const P = 'i65-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let miA = ''
let miB = ''
let t1 = ''
let t2 = ''
let supplierId = ''
let itA1 = ''
let itA2 = ''
let tokA = ''
let tokB = ''
let tokAdm = ''
const apIds: string[] = []

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

/** Minimalen eSLOG/UBL račun (parser: plain tags + removeNSPrefix tolerantno). */
function eslogXml(inv: string, opts: { sub?: number; vat?: number; total?: number; date?: string } = {}): string {
  const sub = opts.sub ?? 10.0
  const vat = opts.vat ?? 2.2
  const total = opts.total ?? 12.2
  const date = opts.date ?? '2026-10-01'
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <ID>${inv}</ID>
  <IssueDate>${date}</IssueDate>
  <DueDate>2026-10-15</DueDate>
  <AccountingSupplierParty><Party>
    <PartyName><Name>${P}Dobavitelj ${RUN}</Name></PartyName>
    <PartyLegalEntity><CompanyID>SI12345678</CompanyID></PartyLegalEntity>
  </Party></AccountingSupplierParty>
  <TaxTotal><TaxAmount>${vat.toFixed(2)}</TaxAmount></TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>${sub.toFixed(2)}</TaxExclusiveAmount>
    <PayableAmount>${total.toFixed(2)}</PayableAmount>
  </LegalMonetaryTotal>
  <InvoiceLine>
    <InvoicedQuantity>2</InvoicedQuantity>
    <Item><Name>Kava zrna</Name></Item>
    <Price><PriceAmount>5.00</PriceAmount></Price>
    <TaxCategory><Percent>22</Percent></TaxCategory>
  </InvoiceLine>
</Invoice>`
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A`, premisesId: `${P}premA-${RUN}` } })
  await db.location.create({ data: { id: locB, code: `${P}LB`, name: `${P}Lokacija B`, premisesId: `${P}premB-${RUN}` } })
  // meni + artikel na obeh lokacijah (createOrderCore: artikel → kategorija → meni → lokacija)
  const menuA = await db.menu.create({ data: { id: `${P}menuA-${RUN}`, name: `${P}Meni A`, locationId: locA } })
  const catA = await db.category.create({ data: { id: `${P}catA-${RUN}`, name: `${P}Kat A`, menuId: menuA.id } })
  const itemA = await db.menuItem.create({ data: { id: `${P}miA-${RUN}`, name: `${P}Jed A`, price: 10, categoryId: catA.id } })
  miA = itemA.id
  const menuB = await db.menu.create({ data: { id: `${P}menuB-${RUN}`, name: `${P}Meni B`, locationId: locB } })
  const catB = await db.category.create({ data: { id: `${P}catB-${RUN}`, name: `${P}Kat B`, menuId: menuB.id } })
  const itemB = await db.menuItem.create({ data: { id: `${P}miB-${RUN}`, name: `${P}Jed B`, price: 10, categoryId: catB.id } })
  miB = itemB.id
  t1 = `${P}tbl1-${RUN}`
  t2 = `${P}tbl2-${RUN}`
  await db.table.create({ data: { id: t1, number: 9301, locationId: locA, status: 'available' } })
  await db.table.create({ data: { id: t2, number: 9302, locationId: locA, status: 'available' } })
  // dobavitelj (globalen po davčni številki — kot v produkciji)
  const sup = await db.supplier.create({
    data: { id: `${P}supplier-${RUN}`, name: `${P}Dobavitelj ${RUN}`, code: `I65-${RUN}`, taxId: '12345678' },
  })
  supplierId = sup.id
  // zaloga za popis (#56) — na OBEH lokacijah (dirka teče na locB, kjer ni odprtega popisa)
  itA1 = `${P}inv1-${RUN}`
  itA2 = `${P}inv2-${RUN}`
  await db.inventoryItem.createMany({
    data: [
      { id: itA1, name: `${P}Moka`, unit: 'kg', quantity: 10, costPerUnit: 2, locationId: locA },
      { id: itA2, name: `${P}Sladkor`, unit: 'kg', quantity: 5, costPerUnit: 1, locationId: locA },
      { id: `${P}invB1-${RUN}`, name: `${P}Olje B`, unit: 'l', quantity: 3, costPerUnit: 4, locationId: locB },
      { id: `${P}invB2-${RUN}`, name: `${P}Sol B`, unit: 'kg', quantity: 2, costPerUnit: 1, locationId: locB },
    ],
  })
  await seedEmployee('mgrA', 'manager', locA, 1)
  await seedEmployee('mgrB', 'manager', locB, 2)
  await seedEmployee('adm', 'admin', null, 3)
  tokA = tok(`${P}mgrA-${RUN}`, `${P}mgrA`, 'MANAGER', locA)
  tokB = tok(`${P}mgrB-${RUN}`, `${P}mgrB`, 'MANAGER', locB)
  tokAdm = tok(`${P}adm-${RUN}`, `${P}adm`, 'ADMIN', null)
})

afterAll(async () => {
  // eventLog: entityId = nid() (brez predpone) → po RUN-u v payloadu (locationId)
  await db.eventLog.deleteMany({ where: { payload: { contains: RUN } } }).catch(() => null)
  await db.deviceSyncOperation.deleteMany({ where: { deviceId: { startsWith: P } } }).catch(() => null)
  await db.auditLog.deleteMany({
    where: { OR: [{ entityId: { startsWith: P } }, { locationId: { in: [locA, locB] } }, ...(apIds.length ? [{ entityId: { in: apIds } }] : [])] },
  }).catch(() => null)
  await db.stockTransaction.deleteMany({ where: { inventoryItemId: { in: [itA1, itA2] } } }).catch(() => null)
  await db.stocktake.deleteMany({ where: { locationId: { in: [locA, locB] } } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { Order: { idempotencyKey: { startsWith: P } } } }).catch(() => null)
  await db.order.deleteMany({ where: { idempotencyKey: { startsWith: P } } }).catch(() => null)
  await db.table.deleteMany({ where: { id: { startsWith: `${P}tbl` } } }).catch(() => null)
  await db.accountsPayable.deleteMany({ where: { supplierId } }).catch(() => null)
  await db.supplier.deleteMany({ where: { id: supplierId } }).catch(() => null)
  await db.inventoryItem.deleteMany({ where: { id: { startsWith: `${P}inv` } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { in: [miA, miB] } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { in: [locA, locB] } } }).catch(() => null)
})

const baseA = () => ({ employeeId: `${P}mgrA-${RUN}`, locationId: locA, items: [{ menuItemId: miA, qty: 1 }] })

/** Sveža prostorna miza (vsak test ima lastne — zasedba mize je trajna do zaključka). */
let tblSeq = 0
async function freshTable(): Promise<string> {
  const id = `${P}tblx${++tblSeq}-${RUN}`
  await db.table.create({ data: { id, number: 9400 + tblSeq, locationId: locA, status: 'available' } })
  return id
}

async function expectOrderError(p: Promise<unknown>): Promise<OrderError> {
  let err: unknown
  try {
    await p
    expect.unreachable('pričakovan OrderError 409')
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(OrderError)
  return err as OrderError
}

// ─────────────────────── #57 — createOrderCore replay ───────────────────────

describe('#57 — createOrderCore: replay-context varovalka', () => {
  it('isti key + isti kontekst → replayed:true, isti id, brez dvojnika', async () => {
    const K = `${P}k1-${RUN}`
    const first = await createOrderCore({ ...baseA(), clientOperationId: K })
    expect(first.replayed).toBe(false)
    const replay = await createOrderCore({ ...baseA(), clientOperationId: K })
    expect(replay.replayed).toBe(true)
    expect(replay.order.id).toBe(first.order.id)
    expect(await db.order.count({ where: { idempotencyKey: K } })).toBe(1)
  })

  it('isti key, DRUGA lokacija → 409, brez novega naročila', async () => {
    const K = `${P}k2-${RUN}`
    await createOrderCore({ ...baseA(), clientOperationId: K })
    const err = await expectOrderError(createOrderCore({
      employeeId: `${P}mgrB-${RUN}`, locationId: locB,
      items: [{ menuItemId: miB, qty: 1 }], clientOperationId: K,
    }))
    expect(err.status).toBe(409)
    expect(err.message).toContain('kontekstu')
    expect(await db.order.count({ where: { idempotencyKey: K } })).toBe(1)
    expect(await db.order.count({ where: { idempotencyKey: K, locationId: locB } })).toBe(0)
  })

  it('isti key + ista lokacija, DRUGA miza → 409', async () => {
    const K = `${P}k3-${RUN}`
    const ta = await freshTable()
    const tb = await freshTable()
    await createOrderCore({ ...baseA(), clientOperationId: K, tableId: ta })
    const err = await expectOrderError(createOrderCore({ ...baseA(), clientOperationId: K, tableId: tb }))
    expect(err.status).toBe(409)
    expect(await db.order.count({ where: { idempotencyKey: K } })).toBe(1)
  })

  it('isti key, DRUG vir (pos → qr) → 409', async () => {
    const K = `${P}k4-${RUN}`
    await createOrderCore({ ...baseA(), clientOperationId: K, orderSource: 'pos' })
    const err = await expectOrderError(createOrderCore({ ...baseA(), clientOperationId: K, orderSource: 'qr' }))
    expect(err.status).toBe(409)
  })

  it('isti key, DRUG tip (DINE_IN → TAKEAWAY) → 409', async () => {
    const K = `${P}k5-${RUN}`
    await createOrderCore({ ...baseA(), clientOperationId: K, type: 'DINE_IN' })
    const err = await expectOrderError(createOrderCore({ ...baseA(), clientOperationId: K, type: 'TAKEAWAY' }))
    expect(err.status).toBe(409)
  })

  it('P2002 dirka, isti kontekst → natanko eno naročilo, drugi replay', async () => {
    const K = `${P}k8-${RUN}`
    const [a, b] = await Promise.all([
      createOrderCore({ ...baseA(), clientOperationId: K, tableId: null }),
      createOrderCore({ ...baseA(), clientOperationId: K, tableId: null }),
    ])
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
    expect(a.order.id).toBe(b.order.id)
    expect(await db.order.count({ where: { idempotencyKey: K } })).toBe(1)
  })

  it('P2002 dirka, različni mizi → zmagovalec + 409 poraženec, eno naročilo', async () => {
    const K = `${P}k9-${RUN}`
    const ta = await freshTable()
    const tb = await freshTable()
    const results = await Promise.allSettled([
      createOrderCore({ ...baseA(), clientOperationId: K, tableId: ta }),
      createOrderCore({ ...baseA(), clientOperationId: K, tableId: tb }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0].reason as OrderError).status).toBe(409)
    const rows = await db.order.findMany({ where: { idempotencyKey: K } })
    expect(rows).toHaveLength(1)
    expect([ta, tb]).toContain(rows[0].tableId)
  })
})

describe('#57 — POS ruta /api/orders', () => {
  it('ista lokacija: 201 → 200 replayed; druga lokacija isti key → 409', async () => {
    const K = `${P}k6-${RUN}`
    const body = { items: [{ menuItemId: miA, qty: 1 }], clientOperationId: K }
    const r1 = await ordersPOST(req('POST', '/api/orders', tokA, body))
    expect(r1.status).toBe(201)
    const r2 = await ordersPOST(req('POST', '/api/orders', tokA, body))
    expect(r2.status).toBe(200)
    expect((await r2.json()).replayed).toBe(true)
    // manager B, isti key, svoja lokacija → 409 brez tujega naročila
    const r3 = await ordersPOST(req('POST', '/api/orders', tokB, { items: [{ menuItemId: miB, qty: 1 }], clientOperationId: K }))
    expect(r3.status).toBe(409)
    expect((await r3.json()).error).toContain('kontekstu')
    expect(await db.order.count({ where: { idempotencyKey: K } })).toBe(1)
  })
})

describe('#57 — offline sync /api/sync', () => {
  it('isti clientOperationId prek uporabnika druge lokacije → failed, eno naročilo', async () => {
    const K = `${P}sync7-${RUN}`
    const op = (items: { menuItemId: string; qty: number }[]) => ({
      deviceId: '', ops: [{ clientOperationId: K, kind: 'order.create', payload: { items } }],
    })
    const rA = await syncPOST(req('POST', '/api/sync', tokA, { ...op([{ menuItemId: miA, qty: 1 }]), deviceId: `${P}devA-${RUN}` }))
    expect(rA.status).toBe(200)
    const bodyA = await rA.json()
    expect(bodyA.results[0].ok).toBe(true)
    expect(bodyA.results[0].orderId).toBeTruthy()
    // manager B ista operacija (druga naprava, isto telo) → OrderError 409 → failed
    const rB = await syncPOST(req('POST', '/api/sync', tokB, { ...op([{ menuItemId: miB, qty: 1 }]), deviceId: `${P}devB-${RUN}` }))
    expect(rB.status).toBe(200)
    const bodyB = await rB.json()
    expect(bodyB.results[0].ok).toBe(false)
    expect(bodyB.results[0].error).toContain('kontekstu')
    expect(await db.order.count({ where: { idempotencyKey: K } })).toBe(1)
    expect(await db.order.count({ where: { idempotencyKey: K, locationId: locB } })).toBe(0)
  })
})

// ─────────────────────── #56 — stocktake replay scope ───────────────────────

describe('#56 — /api/stocktakes: idempotencyKey tenant-scope', () => {
  it('isti key + ista lokacija → 200 replayed isti id; druga lokacija → 409 BREZ vrstic', async () => {
    const K = `${P}st1-${RUN}`
    const r1 = await stocktakePOST(req('POST', '/api/stocktakes', tokA, { idempotencyKey: K, note: 'mesečni' }))
    expect(r1.status).toBe(201)
    const b1 = await r1.json()
    expect(b1.stocktake.status).toBe('DRAFT')
    expect(b1.stocktake.items).toHaveLength(2)
    const r2 = await stocktakePOST(req('POST', '/api/stocktakes', tokA, { idempotencyKey: K }))
    expect(r2.status).toBe(200)
    const b2 = await r2.json()
    expect(b2.replayed).toBe(true)
    expect(b2.stocktake.id).toBe(b1.stocktake.id)
    // manager B (locB) isti key → 409, BREZ stocktake/StocktakeItem podatkov
    const r3 = await stocktakePOST(req('POST', '/api/stocktakes', tokB, { idempotencyKey: K }))
    expect(r3.status).toBe(409)
    const b3 = await r3.json()
    expect(b3.stocktake).toBeUndefined()
    expect(b3.error).toContain('kontekstu')
    expect(await db.stocktake.count({ where: { idempotencyKey: K } })).toBe(1)
    // JSON telesa NE sme vsebovati vrstic popisa (varnost: količine/variance tuje lokacije)
    expect(JSON.stringify(b3)).not.toContain('varianceQty')
    expect(JSON.stringify(b3)).not.toContain('expectedQty')
  })

  it('central admin z eksplicitno dovoljeno lokacijo → replay viden (guardResource pass)', async () => {
    const K = `${P}st1-${RUN}`
    const r = await stocktakePOST(req('POST', '/api/stocktakes', tokAdm, { idempotencyKey: K, locationId: locA }))
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.replayed).toBe(true)
    expect(b.stocktake.items).toHaveLength(2)
  })

  it('P2002 dirka isti key + ista lokacija → natanko en popis (na locB — brez odprtega popisa)', async () => {
    const K = `${P}st2-${RUN}`
    const [r1, r2] = await Promise.all([
      stocktakePOST(req('POST', '/api/stocktakes', tokB, { idempotencyKey: K })),
      stocktakePOST(req('POST', '/api/stocktakes', tokB, { idempotencyKey: K })),
    ])
    const statuses = [r1.status, r2.status]
    // natanko EN zmagovalni create (201); poraženec → replay 200 (P2002/pre-lookup)
    // ali 409 'že poteka' (open-check dirka) — v vseh primerih en sam zapis spodaj
    expect(statuses).toContain(201)
    expect(statuses.every((s) => [200, 201, 409].includes(s))).toBe(true)
    const rows = await db.stocktake.findMany({ where: { idempotencyKey: K } })
    expect(rows).toHaveLength(1)
    // replay zmagovalca (200) ali 409 'že poteka' — v obeh primerih en zapis
    for (const r of [r1, r2]) {
      if (r.status === 200) {
        const b = await r.json()
        expect(b.stocktake.id).toBe(rows[0].id)
      }
    }
  })
})

// ─────────────────────── #65 — eSLOG uvoz idempotenca ───────────────────────

describe('#65 — /api/ap/import-eslog: kanonični ključ + tenant-scope', () => {
  it('prvi uvoz → 201 z determinističnim ap-eslog- id; ponovni isti XML → 200 duplicate isti id', async () => {
    const XML = eslogXml(`INV-${RUN}-001`)
    const r1 = await eslogPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: XML }))
    expect(r1.status).toBe(201)
    const b1 = await r1.json()
    expect(b1.ap.id.startsWith('ap-eslog-')).toBe(true)
    expect(b1.ap.invoiceNumber).toBe(`INV-${RUN}-001`)
    apIds.push(b1.ap.id)
    const ap = await db.accountsPayable.findUnique({ where: { id: b1.ap.id }, include: { AccountsPayableLine: true } })
    expect(ap?.locationId).toBe(locA)
    expect(ap?.AccountsPayableLine).toHaveLength(1)
    const r2 = await eslogPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: XML }))
    expect(r2.status).toBe(200)
    const b2 = await r2.json()
    expect(b2.duplicate).toBe(true)
    expect(b2.ap.id).toBe(b1.ap.id)
    expect(await db.accountsPayable.count({ where: { supplierId, invoiceNumber: `INV-${RUN}-001` } })).toBe(1)
    expect(await db.accountsPayableLine.count({ where: { accountsPayableId: b1.ap.id } })).toBe(1)
  })

  it('central admin brez lokacije → duplicate viden (list↔replay usklajen z /api/expenses)', async () => {
    const r = await eslogPOST(req('POST', '/api/ap/import-eslog', tokAdm, { xml: eslogXml(`INV-${RUN}-001`) }))
    expect(r.status).toBe(200)
    const b = await r.json()
    expect(b.duplicate).toBe(true)
    expect(b.ap.invoiceNumber).toBe(`INV-${RUN}-001`)
  })

  it('uporabnik lokacije B isti račun → 409 BREZ ap/apNumber/zneska; AP nedotaknjen', async () => {
    const r = await eslogPOST(req('POST', '/api/ap/import-eslog', tokB, { xml: eslogXml(`INV-${RUN}-001`) }))
    expect(r.status).toBe(409)
    const b = await r.json()
    expect(b.ap).toBeUndefined()
    expect(b.apNumber).toBeUndefined()
    expect(b.error).toContain('kontekstu')
    // noben drug AP, lokacija/znesek obstoječega nespremenjena
    expect(await db.accountsPayable.count({ where: { supplierId, invoiceNumber: `INV-${RUN}-001` } })).toBe(1)
    const ap = await db.accountsPayable.findFirst({ where: { supplierId, invoiceNumber: `INV-${RUN}-001` } })
    expect(ap?.locationId).toBe(locA)
    expect(Number(ap?.subtotal)).toBe(10)
    // revizija zavrnitve zabeležena (brez tujih zneskov)
    const audits = await db.auditLog.count({ where: { action: 'ESLOG_IMPORT_BLOCKED', entityId: ap?.id } })
    expect(audits).toBe(1)
  })

  it('isti dokument, DRUGAČEN znesek → 409 konflikt, obstoječi AP NI prekrit', async () => {
    const r = await eslogPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: eslogXml(`INV-${RUN}-001`, { sub: 20, vat: 4.4, total: 24.4 }) }))
    expect(r.status).toBe(409)
    const b = await r.json()
    expect(b.conflict).toBe(true)
    expect(b.error).toContain('drugačne podatke')
    expect(await db.accountsPayable.count({ where: { supplierId, invoiceNumber: `INV-${RUN}-001` } })).toBe(1)
    const ap = await db.accountsPayable.findFirst({ where: { supplierId, invoiceNumber: `INV-${RUN}-001` } })
    expect(Number(ap?.subtotal)).toBe(10)
    expect(Number(ap?.totalAmount)).toBe(12.2)
  })

  it('sočasna uvoza istega XML → natanko EN AP + EN set vrstic (PK claim)', async () => {
    const XML = eslogXml(`INV-${RUN}-002`)
    const [r1, r2] = await Promise.all([
      eslogPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: XML })),
      eslogPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: XML })),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 201])
    const [b1, b2] = await Promise.all([r1.json(), r2.json()])
    expect(b1.ap.id).toBe(b2.ap.id)
    expect(b1.ap.id.startsWith('ap-eslog-')).toBe(true)
    apIds.push(b1.ap.id)
    expect(await db.accountsPayable.count({ where: { supplierId, invoiceNumber: `INV-${RUN}-002` } })).toBe(1)
    expect(await db.accountsPayableLine.count({ where: { accountsPayableId: b1.ap.id } })).toBe(1)
  })

  it('isti znesek, drugačen datum računa → 409 konflikt (datum je del dokumenta)', async () => {
    const r = await eslogPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: eslogXml(`INV-${RUN}-001`, { date: '2026-09-01' }) }))
    expect(r.status).toBe(409)
    const b = await r.json()
    expect(b.conflict).toBe(true)
    expect(b.error).toContain('datum')
    expect(await db.accountsPayable.count({ where: { supplierId, invoiceNumber: `INV-${RUN}-001` } })).toBe(1)
  })
})
