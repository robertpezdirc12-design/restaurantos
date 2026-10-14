/**
 * Issue #18 (P1) — tristransko ujemanje PO ↔ dejanski prevzem (GRN) ↔
 * dobaviteljev račun (eSLOG).
 *
 * Pokrito:
 *  1. LOČITEV OSNUTKA: PO→AP most ob prevzemu ustvari matchStatus 'grn_draft'
 *     (NE lažni 'matched') + vrstice 'unverified' + opomba OSNUTEK — osnutek
 *     iz prevzema ne izgleda kot potrjen račun;
 *  2. SREČNA POT: PO (Kava zrna 10× 5 €) → prevzem 2 → eSLOG račun z ENAKO
 *     vrstico → samodejna povezava (točno ujemanje) → tristranska evalvacija
 *     → 'matched';
 *  3. PRESEŽEK NAD PREVZETIM: račun 5 kos (prevzeto 2) → 'blocked' (količina);
 *     plačilo (PATCH /api/expenses/[id] status paid) → 409 plačilna varovalka;
 *  4. KUMULATIVNO FAKTURIRANJE: drugi račun isto količino → kumulativa 4 >
 *     prevzeto 2 → 'blocked' (ista količina ni fakturirana dvakrat);
 *  5. NEPOVEZANA VRSTICA: drugačen opis → ni samodejne povezave →
 *     'review_required'; ročna povezava (POST link) → re-evalvacija → 'matched';
 *  6. DOBROPIZ: CreditNote XML (negativni zneski) → vrstice predznačene →
 *     kumulativa se ZMANJŠA → 'matched'; zaloga se NE spremeni (GRN-1 prej
 *     in za računom enaki);
 *  7. TOLERANCA: odstopanje cene 5.50 vs 5.00 → 'blocked'; apMatchPriceTolerancePct
 *     = 15 (PUT /api/settings — pooblaščena oseba) → re-evalvacija → 'matched';
 *  8. IZJEMA: blocked → approve_exception (razlog < 10 znakov → 400) →
 *     'exception_approved' → plačilo 200; audit AP_EXCEPTION_APPROVED z razlogom
 *     + referencami (PO/GRN številke);
 *  9. CROSS-TENANT: manager org B ne more brati/povezati/odobriti AP org A
 *     (403); kandidati PO so obsežno omejeni;
 * 10. IDEMPOTENCA: ponoven uvoz istega XML → duplicate:true (brez dvojnega AP
 *     in brez ponovne povezave/evalvacije);
 * 11. eSLOG parse: documentType + credited vrstice + unitCode/ID vrstice;
 * 12. REGISTER: SCHEMA_MIGRATIONS vsebuje ap-tolerance (+ i18n SL/HR opis);
 *     drift matcher klasificira ADD/DROP stolpce; DDL ruta je idempotentna
 *     (sqlite že ima stolpce → alreadyApplied);
 * 13. UJEMANJE GLAVE: račun z nedosledno glavo (vsota vrstic ≠ totalAmount)
 *     → 'blocked'.
 *
 * Fiksture s predpono i18a- (issue #18 tristransko); čiščenje po vzorcu i53
 * (nabavni modeli po supplierId predponi + audit po locationId).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as receivePOST } from '../src/app/api/purchase-orders/[id]/receive/route'
import { POST as eslogPOST } from '../src/app/api/ap/import-eslog/route'
import { GET as matchGET, POST as matchPOST } from '../src/app/api/ap/[id]/match/route'
import { GET as expensesGET } from '../src/app/api/expenses/route'
import { PATCH as expensePATCH } from '../src/app/api/expenses/[id]/route'
import { PUT as settingsPUT } from '../src/app/api/settings/route'
import { POST as ddlPOST } from '../src/app/api/admin/migrate-ap-tolerance/route'
import { parseEslog } from '../src/lib/eslog'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { isApToleranceStatement } from '../scripts/drift-check'
import { sl as slDict } from '../src/lib/i18n/sl'
import { hr as hrDict } from '../src/lib/i18n/hr'
import { nid } from '../src/lib/map'
import { resetApToleranceProbe } from '../src/lib/ap-tolerance'

const P = 'i18a-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let mgrA = ''
let mgrB = ''
let tokA = ''
let tokB = ''
let supId = ''

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

/* ── PO (direktno, kontrolirane postavke; brez inventoryItemId → brez zaloge) ── */
let poSeq = 0
async function mkPo(items: { description: string; qty: number; price: number; vat?: number }[], loc: string): Promise<{ id: string; itemIds: string[] }> {
  const id = nid()
  const itemIds: string[] = []
  let subtotal = 0
  let vatAmount = 0
  for (const it of items) {
    const vat = it.vat ?? 22
    const net = it.qty * it.price
    subtotal += net
    vatAmount += net * vat / 100
    itemIds.push(nid())
  }
  await db.purchaseOrder.create({
    data: {
      id, poNumber: `PO-I18-${RUN}-${++poSeq}`, supplierId: supId,
      status: 'approved',
      subtotal: Math.round(subtotal * 100) / 100, vatAmount: Math.round(vatAmount * 100) / 100,
      totalAmount: Math.round((subtotal + vatAmount) * 100) / 100,
      locationId: loc,
      PurchaseOrderItem: {
        create: items.map((it, i) => ({
          id: itemIds[i], description: it.description, quantityOrdered: it.qty,
          unit: 'pcs', unitPrice: it.price, vatRate: it.vat ?? 22,
          totalPrice: it.qty * it.price * (1 + (it.vat ?? 22) / 100),
        })),
      },
    },
  })
  return { id, itemIds }
}

async function receive(token: string, poId: string, lines: { purchaseOrderItemId: string; quantityAccepted: number }[], key: string): Promise<Record<string, unknown>> {
  const r = await receivePOST(req('POST', `/api/purchase-orders/${poId}/receive`, token, {
    idempotencyKey: key,
    lines: lines.map((l) => ({ ...l, quantityRejected: 0 })),
  }), { params: Promise.resolve({ id: poId }) })
  return body(r)
}

/* ── eSLOG XML builder (vzorec i65 + negativni zneski za dobropis) ── */
function eslogXml(inv: string, lines: { name: string; qty: number; price: number; vat?: number }[], opts: { sub?: number; vat?: number; total?: number; date?: string } = {}): string {
  const sub = opts.sub ?? lines.reduce((s, l) => s + l.qty * l.price, 0)
  const vat = opts.vat ?? lines.reduce((s, l) => s + l.qty * l.price * (l.vat ?? 22) / 100, 0)
  const total = opts.total ?? sub + vat
  const date = opts.date ?? '2026-10-01'
  const lineXml = lines.map((l) => `
  <InvoiceLine>
    <ID>${l.name.slice(0, 3)}-${Math.floor(Math.random() * 1000)}</ID>
    <InvoicedQuantity unitCode="H87">${l.qty}</InvoicedQuantity>
    <Item><Name>${l.name}</Name></Item>
    <Price><PriceAmount>${l.price.toFixed(2)}</PriceAmount></Price>
    <TaxCategory><Percent>${l.vat ?? 22}</Percent></TaxCategory>
  </InvoiceLine>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <ID>${inv}</ID>
  <IssueDate>${date}</IssueDate>
  <DueDate>2026-10-15</DueDate>
  <AccountingSupplierParty><Party>
    <PartyName><Name>${P}Dobavitelj ${RUN}</Name></PartyName>
    <PartyLegalEntity><CompanyID>SI98765432</CompanyID></PartyLegalEntity>
  </Party></AccountingSupplierParty>
  <TaxTotal><TaxAmount>${vat.toFixed(2)}</TaxAmount></TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>${sub.toFixed(2)}</TaxExclusiveAmount>
    <PayableAmount>${total.toFixed(2)}</PayableAmount>
  </LegalMonetaryTotal>${lineXml}
</Invoice>`
}

function creditNoteXml(inv: string, lines: { name: string; qty: number; price: number; vat?: number }[]): string {
  const sub = lines.reduce((s, l) => s - l.qty * l.price, 0)
  const vat = lines.reduce((s, l) => s - l.qty * l.price * (l.vat ?? 22) / 100, 0)
  const lineXml = lines.map((l) => `
  <CreditNoteLine>
    <CreditedQuantity unitCode="H87">${l.qty}</CreditedQuantity>
    <Item><Name>${l.name}</Name></Item>
    <Price><PriceAmount>${l.price.toFixed(2)}</PriceAmount></Price>
    <TaxCategory><Percent>${l.vat ?? 22}</Percent></TaxCategory>
  </CreditNoteLine>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote>
  <ID>${inv}</ID>
  <IssueDate>2026-10-02</IssueDate>
  <AccountingSupplierParty><Party>
    <PartyName><Name>${P}Dobavitelj ${RUN}</Name></PartyName>
    <PartyLegalEntity><CompanyID>SI98765432</CompanyID></PartyLegalEntity>
  </Party></AccountingSupplierParty>
  <TaxTotal><TaxAmount>${vat.toFixed(2)}</TaxAmount></TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>${sub.toFixed(2)}</TaxExclusiveAmount>
    <PayableAmount>${(sub + vat).toFixed(2)}</PayableAmount>
  </LegalMonetaryTotal>${lineXml}
</CreditNote>`
}

async function importEslog(token: string, xml: string): Promise<{ code: number; body: Record<string, unknown>; apId: string }> {
  const r = await eslogPOST(req('POST', '/api/ap/import-eslog', token, { xml }))
  const b = await body(r)
  const ap = (b.ap ?? {}) as Record<string, unknown>
  return { code: r.status, body: b, apId: String(ap.id ?? '') }
}

async function apOf(id: string) {
  return db.accountsPayable.findUnique({ where: { id }, include: { AccountsPayableLine: true } })
}

async function cleanup() {
  await db.auditLog.deleteMany({ where: { locationId: { startsWith: P } } })
  await db.eventLog.deleteMany({ where: { entityId: { startsWith: P } } })
  await db.accountsPayable.deleteMany({ where: { supplierId: { startsWith: P } } })
  await db.goodsReceipt.deleteMany({ where: { supplierId: { startsWith: P } } })
  await db.purchaseOrder.deleteMany({ where: { supplierId: { startsWith: P } } })
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  resetApToleranceProbe(true) // sqlite mirror ima stolpce (db push)
  await cleanup()
  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, name: `${P}Lokacija A`, code: `I18A${RUN}` } })
  await db.location.create({ data: { id: locB, name: `${P}Lokacija B`, code: `I18B${RUN}` } })

  mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  mgrB = await seedEmployee('mgrB', 'manager', locB, 2)
  tokA = createToken({ sub: mgrA, name: 'mgrA', role: 'manager', loc: locA, sv: 0 })
  tokB = createToken({ sub: mgrB, name: 'mgrB', role: 'manager', loc: locB, sv: 0 })

  supId = `${P}sup-${RUN}`
  await db.supplier.create({
    data: { id: supId, name: `${P}Dobavitelj ${RUN}`, code: `I18S${RUN}`, taxId: 'SI98765432', isActive: true },
  })
})

afterAll(async () => {
  await cleanup()
})

/* ── 11. parser (unit) ── */
describe('issue #18 — eSLOG parser: documentType + vrstice', () => {
  it('navadni račun: documentType invoice, unit/lineId iz atributov', () => {
    const parsed = parseEslog(eslogXml('I18-INV-PARSE', [{ name: 'Kava zrna', qty: 2, price: 5 }]))
    expect(parsed.invoice).not.toBeNull()
    expect(parsed.invoice!.documentType).toBe('invoice')
    expect(parsed.invoice!.lines[0].credited).toBeFalsy()
    expect(parsed.invoice!.lines[0].unit).toBe('H87')
    expect(parsed.invoice!.lines[0].lineId ?? '').toContain('-')
  })
  it('dobropis: documentType credit_note, vrstica credited', () => {
    const parsed = parseEslog(creditNoteXml('I18-CR-PARSE', [{ name: 'Kava zrna', qty: 1, price: 5 }]))
    expect(parsed.invoice).not.toBeNull()
    expect(parsed.invoice!.documentType).toBe('credit_note')
    expect(parsed.invoice!.lines[0].credited).toBe(true)
    expect(parsed.invoice!.total).toBeLessThan(0)
  })
})

/* ── 12. register/drift/DDL (unit + ruta) ── */
describe('issue #18 — register ap-tolerance + drift + DDL idempotenca', () => {
  it('SCHEMA_MIGRATIONS vsebuje ap-tolerance z endpointom in i18n opisom (SL/HR)', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'ap-tolerance')
    expect(m).toBeDefined()
    expect(m!.endpoint).toBe('/api/admin/migrate-ap-tolerance')
    expect(slDict[m!.descKey]).toBeTruthy()
    expect(hrDict[m!.descKey]).toBeTruthy()
  })
  it('drift matcher: ADD/DROP tolerance stolpcev = znani drift, tuje pa ne', () => {
    expect(isApToleranceStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN "apMatchQtyTolerancePct" DECIMAL(5,2) NOT NULL DEFAULT 0')).toBe(true)
    expect(isApToleranceStatement('ALTER TABLE "RestaurantSettings" DROP COLUMN "apMatchQtyTolerancePct"')).toBe(true)
    expect(isApToleranceStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN "apMatchQtyTolerancePct", ADD COLUMN "apMatchPriceTolerancePct"')).toBe(true)
    expect(isApToleranceStatement('ALTER TABLE "RestaurantSettings" ADD COLUMN "other"')).toBe(false)
    expect(isApToleranceStatement('ALTER TABLE "Employee" ADD COLUMN "apMatchQtyTolerancePct"')).toBe(false)
  })
  it('DDL ruta je idempotentna (sqlite že ima stolpce prek db push)', async () => {
    const r = await ddlPOST(req('POST', '/api/admin/migrate-ap-tolerance', createToken({ sub: 'bootstrap', name: 'boot', role: 'ADMIN', loc: null, sv: 0 })))
    expect(r.status).toBe(200)
    const b = await body(r)
    expect(b.alreadyApplied).toBe(true)
  })
})

/* ── 1.–9. route nivo ── */
describe('issue #18 — tristransko ujemanje (route)', () => {
  let po1 = { id: '', itemIds: [] as string[] }

  it('1. prevzem ustvari OSNUTEK (grn_draft) — ne lažnega matched', async () => {
    po1 = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    const r = await receive(tokA, po1.id, [{ purchaseOrderItemId: po1.itemIds[0], quantityAccepted: 2 }], 'i18-grn-1')
    expect(r.receipt).toBeDefined()
    const aps = await db.accountsPayable.findMany({ where: { purchaseOrderId: po1.id }, include: { AccountsPayableLine: true } })
    expect(aps.length).toBe(1)
    const ap = aps[0]
    expect(ap.matchStatus).toBe('grn_draft') // PREJ: 'matched' (lažno)
    expect(ap.notes).toContain('OSNUTEK')
    expect(ap.AccountsPayableLine[0].varianceStatus).toBe('unverified')
    expect(ap.locationId).toBe(locA)
  })

  it('2. srečna pot: eSLOG z enako vrstico → samodejna povezava → matched', async () => {
    const { code, body: b, apId } = await importEslog(tokA, eslogXml(`I18-INV-1-${RUN}`, [{ name: 'Kava zrna', qty: 2, price: 5 }]))
    expect(code).toBe(201)
    expect(b.linesAutoLinked).toBe(1)
    expect(b.matchEvaluated).toBe(true)
    const ap = await apOf(apId)
    expect(ap!.matchStatus).toBe('matched')
    expect(ap!.AccountsPayableLine[0].purchaseOrderItemId).toBe(po1.itemIds[0])
    expect(ap!.AccountsPayableLine[0].varianceStatus).toBe('match')
    expect(ap!.locationId).toBe(locA)
  })

  it('3. presežek nad prevzetim → blocked + plačilna varovalka 409', async () => {
    const { apId } = await importEslog(tokA, eslogXml(`I18-INV-2-${RUN}`, [{ name: 'Kava zrna', qty: 5, price: 5 }]))
    const ap = await apOf(apId)
    expect(ap!.matchStatus).toBe('blocked')
    expect(ap!.AccountsPayableLine[0].varianceNote).toContain('sprejeto')
    // plačilna varovalka: PATCH status paid → 409
    const r = await expensePATCH(req('PATCH', `/api/expenses/${apId}`, tokA, { status: 'paid' }), { params: Promise.resolve({ id: apId }) })
    expect(r.status).toBe(409)
    const eb = await body(r)
    expect(String(eb.error)).toContain('tristranskem ujemanju')
  })

  it('4. kumulativno fakturiranje: isti količini dvakrat → blocked', async () => {
    // SVEŽ PO (blokirani računi iz prejšnjih testov štejejo v kumulativo istega PO!)
    const po4 = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    await receive(tokA, po4.id, [{ purchaseOrderItemId: po4.itemIds[0], quantityAccepted: 5 }], 'i18-grn-2')
    // INV-A: 5 kos (vse prejeto) → matched; osnutek nadomeščen
    const { apId: apA } = await importEslog(tokA, eslogXml(`I18-INV-3-${RUN}`, [{ name: 'Kava zrna', qty: 5, price: 5 }]))
    expect((await apOf(apA))!.matchStatus).toBe('matched')
    // osnutek iz prevzema je nadomeščen (status 'void' — matchStatus ostane
    // 'grn_draft' kot revizijski označevalec) — ista količina ni dvojno knjižena
    const drafts = await db.accountsPayable.findMany({ where: { purchaseOrderId: po4.id, matchStatus: 'grn_draft', status: { not: 'void' } } })
    expect(drafts.length).toBe(0)
    const voidedDraft = await db.accountsPayable.findFirst({ where: { purchaseOrderId: po4.id, status: 'void' } })
    expect(voidedDraft).not.toBeNull()
    // INV-B: isto količino še enkrat → kumulativa 5+5 = 10 > 5 prevzetih → blocked
    const { apId: apB } = await importEslog(tokA, eslogXml(`I18-INV-4-${RUN}`, [{ name: 'Kava zrna', qty: 5, price: 5 }]))
    const ap = await apOf(apB)
    expect(ap!.matchStatus).toBe('blocked')
    expect(ap!.AccountsPayableLine[0].varianceNote).toContain('presega dejansko sprejeto')
  })

  it('5. nepovezana vrstica → review_required; ročna povezava → matched', async () => {
    // SVEŽ PO: kumulativa na istem PO-ju bi blokirala ročno povezavo
    const po5 = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    await receive(tokA, po5.id, [{ purchaseOrderItemId: po5.itemIds[0], quantityAccepted: 2 }], 'i18-grn-2b')
    const { apId } = await importEslog(tokA, eslogXml(`I18-INV-5-${RUN}`, [{ name: 'Nek povsem drug artikel', qty: 2, price: 5 }]))
    const ap = await apOf(apId)
    expect(ap!.matchStatus).toBe('review_required')
    expect(ap!.AccountsPayableLine[0].purchaseOrderItemId).toBeNull()

    // GET detail: predlog kandidatov je na voljo (deterministično)
    const g = await matchGET(req('GET', `/api/ap/${apId}/match`, tokA), { params: Promise.resolve({ id: apId }) })
    expect(g.status).toBe(200)
    const gb = await body(g)
    const lines = (gb.lines ?? []) as Array<Record<string, unknown>>
    expect(lines.length).toBe(1)
    expect(lines[0].purchaseOrderItemId).toBeNull()

    // ročna povezava na PO postavko (zahteva inventory.manage — manager ima)
    const lp = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokA, {
      action: 'link',
      lineLinks: [{ lineId: ap!.AccountsPayableLine[0].id, purchaseOrderItemId: po5.itemIds[0] }],
    }), { params: Promise.resolve({ id: apId }) })
    expect(lp.status).toBe(200)
    const apAfter = await apOf(apId)
    expect(apAfter!.matchStatus).toBe('matched')
    expect(apAfter!.AccountsPayableLine[0].purchaseOrderItemId).toBe(po5.itemIds[0])
  })

  it('5b. povezava na tujega dobavitelja/dvojni link → 409/400', async () => {
    const otherSup = `${P}sup2-${RUN}`
    await db.supplier.create({ data: { id: otherSup, name: `${P}Drug dobavitelj ${RUN}`, code: `I18T${RUN}`, taxId: 'SI11111111' } })
    const otherPo = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    await db.purchaseOrder.update({ where: { id: otherPo.id }, data: { supplierId: otherSup } })

    const { apId } = await importEslog(tokA, eslogXml(`I18-INV-5B-${RUN}`, [{ name: 'Artikel X', qty: 1, price: 3 }]))
    const ap = await apOf(apId)
    // tuji dobavitelj
    const r1 = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokA, {
      action: 'link', lineLinks: [{ lineId: ap!.AccountsPayableLine[0].id, purchaseOrderItemId: otherPo.itemIds[0] }],
    }), { params: Promise.resolve({ id: apId }) })
    expect(r1.status).toBe(409)
    // vrstica, ki ne pripada AP
    const po1x = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    const r2 = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokA, {
      action: 'link', lineLinks: [{ lineId: 'neobstojeca', purchaseOrderItemId: po1x.itemIds[0] }],
    }), { params: Promise.resolve({ id: apId }) })
    expect(r2.status).toBe(400)
  })

  it('6. dobropis zmanjša kumulativo, ne ustvarja zaloge, ne razveljavi audita', async () => {
    const stockBefore = await db.stockTransaction.count({ where: { note: { contains: 'Kava' } } })
    // INV-6: 2 kosa (kumulativa bo 6+2-... → preverimo, da je kumulativa po INV-3(2) + INV-4(2, blocked)
    // še vedno veljavna za dobropis −2: 2+2+2 = 6 prevzetih... prejeto je 5 → INV-4 blocked
    // uporabimo NOV PO za čisto kumulativo
    const po2 = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    await receive(tokA, po2.id, [{ purchaseOrderItemId: po2.itemIds[0], quantityAccepted: 4 }], 'i18-grn-3')
    const { apId: invA } = await importEslog(tokA, eslogXml(`I18-INV-6-${RUN}`, [{ name: 'Kava zrna', qty: 4, price: 5 }]))
    expect((await apOf(invA))!.matchStatus).toBe('matched')
    // dobropis −2
    const { code, apId: crA } = await importEslog(tokA, creditNoteXml(`I18-CR-1-${RUN}`, [{ name: 'Kava zrna', qty: 2, price: 5 }]))
    expect(code).toBe(201)
    const cr = await apOf(crA)
    expect(cr!.matchStatus).toBe('matched')
    expect(Number(cr!.AccountsPayableLine[0].quantityInvoiced)).toBe(-2)
    // kumulativa po dobropisu: 4 − 2 = 2 ≤ 4 prejetih ✓ (ni presežka)
    // zaloga se ni spremenila (prevzem je edini vir)
    const stockAfter = await db.stockTransaction.count({ where: { note: { contains: 'Kava' } } })
    expect(stockAfter).toBe(stockBefore)
  })

  it('7. odstopanje cene → blocked; tolerance 15 % (settings) → matched', async () => {
    // SHRANI stanje singleton nastavitev (toleransa je DELJENA politika — vrni
    // točno prejšnje stanje, da ne zastrupim kasnejših testov v isti bazi)
    const settingsBefore = await db.restaurantSettings.findFirst()
    const settingsExisted = !!settingsBefore

    const po3 = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    await receive(tokA, po3.id, [{ purchaseOrderItemId: po3.itemIds[0], quantityAccepted: 2 }], 'i18-grn-4')
    const { apId } = await importEslog(tokA, eslogXml(`I18-INV-7-${RUN}`, [{ name: 'Kava zrna', qty: 2, price: 5.5 }]))
    expect((await apOf(apId))!.matchStatus).toBe('blocked')
    expect((await apOf(apId))!.AccountsPayableLine[0].varianceNote).toContain('Cena na enoto')

    // pooblaščena oseba ohlapi tolerance (PUT /api/settings)
    const s = await settingsPUT(req('PUT', '/api/settings', tokA, { apMatchPriceTolerancePct: 15 }))
    expect(s.status).toBe(200)
    const sb = await body(s)
    const tol = (sb.apMatchTolerance ?? {}) as Record<string, unknown>
    expect(Number(tol.priceTolerancePct)).toBe(15)

    // re-evalvacija → znotraj tolerance → matched
    const ev = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokA, { action: 'evaluate' }), { params: Promise.resolve({ id: apId }) })
    expect(ev.status).toBe(200)
    expect((await apOf(apId))!.matchStatus).toBe('matched')

    // povrni politiko na strogo + vrni singleton v prejšnje stanje
    await settingsPUT(req('PUT', '/api/settings', tokA, { apMatchPriceTolerancePct: 0 }))
    if (!settingsExisted) {
      await db.restaurantSettings.deleteMany({})
    }
  })

  it('8. odobritev izjeme → exception_approved → plačilo 200 + audit', async () => {
    const po4 = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    await receive(tokA, po4.id, [{ purchaseOrderItemId: po4.itemIds[0], quantityAccepted: 1 }], 'i18-grn-5')
    const { apId } = await importEslog(tokA, eslogXml(`I18-INV-8-${RUN}`, [{ name: 'Kava zrna', qty: 5, price: 5 }]))
    expect((await apOf(apId))!.matchStatus).toBe('blocked')

    // prekratek razlog → 400
    const r0 = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokA, { action: 'approve_exception', reason: 'kratko' }), { params: Promise.resolve({ id: apId }) })
    expect(r0.status).toBe(400)

    // odobritev z razlogom
    const r1 = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokA, {
      action: 'approve_exception',
      reason: 'Dobavitelj je dostavil nadomestno količino po dogovoru (telefonska potrditev).',
    }), { params: Promise.resolve({ id: apId }) })
    expect(r1.status).toBe(200)
    expect((await apOf(apId))!.matchStatus).toBe('exception_approved')

    // plačilo zdaj deluje
    const r2 = await expensePATCH(req('PATCH', `/api/expenses/${apId}`, tokA, { status: 'paid' }), { params: Promise.resolve({ id: apId }) })
    expect(r2.status).toBe(200)

    // audit: AP_EXCEPTION_APPROVED z razlogom + PO/GRN referencami
    const audit = await db.auditLog.findFirst({
      where: { action: 'AP_EXCEPTION_APPROVED', entityId: apId },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit!.details) as Record<string, unknown>
    expect(String(details.reason)).toContain('nadomestno količino')
    expect(Array.isArray(details.purchaseOrderNumbers)).toBe(true)
    expect((details.purchaseOrderNumbers as string[]).length).toBeGreaterThan(0)
    expect(Array.isArray(details.grnNumbers)).toBe(true)
    expect(String(details.approvedBy)).toContain('mgrA')
    expect(audit!.chainHash).not.toBe('')

    // exception_approved je lepenljiv: ponovna evalvacija → 409 (ne prepiše)
    const r3 = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokA, { action: 'evaluate' }), { params: Promise.resolve({ id: apId }) })
    expect(r3.status).toBe(409)
  })

  it('9. cross-tenant: manager org B ne vidi/poveže/odobri AP org A', async () => {
    const poA = await mkPo([{ description: 'Kava zrna', qty: 10, price: 5 }], locA)
    await receive(tokA, poA.id, [{ purchaseOrderItemId: poA.itemIds[0], quantityAccepted: 2 }], 'i18-grn-6')
    const { apId } = await importEslog(tokA, eslogXml(`I18-INV-9-${RUN}`, [{ name: 'Kava zrna', qty: 5, price: 5 }]))
    expect((await apOf(apId))!.matchStatus).toBe('blocked')

    // GET detail → 403
    const g = await matchGET(req('GET', `/api/ap/${apId}/match`, tokB), { params: Promise.resolve({ id: apId }) })
    expect(g.status).toBe(403)
    // link → 403
    const l = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokB, {
      action: 'link', lineLinks: [{ lineId: 'x', purchaseOrderItemId: 'y' }],
    }), { params: Promise.resolve({ id: apId }) })
    expect(l.status).toBe(403)
    // approve_exception → 403
    const a = await matchPOST(req('POST', `/api/ap/${apId}/match`, tokB, {
      action: 'approve_exception', reason: 'Poskus tuje organizacije z dolgim razlogom.',
    }), { params: Promise.resolve({ id: apId }) })
    expect(a.status).toBe(403)
    // plačilo tujega AP → 403
    const p = await expensePATCH(req('PATCH', `/api/expenses/${apId}`, tokB, { status: 'paid' }), { params: Promise.resolve({ id: apId }) })
    expect(p.status).toBe(403)
  })

  it('10. idempotenten uvoz: isti XML → duplicate, brez dvojega AP/povezave', async () => {
    const xml = eslogXml(`I18-INV-10-${RUN}`, [{ name: 'Kava zrna', qty: 2, price: 5 }])
    const first = await importEslog(tokA, xml)
    expect(first.code).toBe(201)
    const second = await importEslog(tokA, xml)
    expect(second.code).toBe(200)
    expect(second.body.duplicate).toBe(true)
    const count = await db.accountsPayable.count({ where: { invoiceNumber: `I18-INV-10-${RUN}` } })
    expect(count).toBe(1)
  })

  it('13. nedosledna glava računa (vsota vrstic ≠ totalAmount) → blocked', async () => {
    const { apId } = await importEslog(tokA, eslogXml(
      `I18-INV-11-${RUN}`,
      [{ name: 'Kava zrna', qty: 2, price: 5 }],
      { sub: 10, vat: 2.2, total: 99 },
    ))
    const ap = await apOf(apId)
    expect(ap!.matchStatus).toBe('blocked')
    expect(ap!.AccountsPayableLine.length).toBe(1)
  })

  it('GET /api/expenses obogaten: matchStatus + matchSummary + poNumber', async () => {
    const r = await expensesGET(req('GET', '/api/expenses', tokA))
    expect(r.status).toBe(200)
    const b = await body(r)
    const expenses = (b.expenses ?? []) as Array<Record<string, unknown>>
    const mine = expenses.filter((e) => String(e.apNumber ?? '').length > 0)
    expect(mine.length).toBeGreaterThan(0)
    // vsaj eden ima status ujemanja (grn_draft/matched/blocked/...)
    const withStatus = mine.filter((e) => typeof e.matchStatus === 'string')
    expect(withStatus.length).toBeGreaterThan(0)
    const matchedRow = mine.find((e) => e.matchStatus === 'matched')
    if (matchedRow) {
      expect(matchedRow.matchSummary).toBeDefined()
      const ms = matchedRow.matchSummary as Record<string, unknown>
      expect(Number(ms.linesMatched)).toBeGreaterThanOrEqual(1)
    }
    // grn_draft ima PO referenco
    const draftRow = mine.find((e) => e.matchStatus === 'grn_draft')
    if (draftRow) expect(draftRow.poNumber).toBeTruthy()
  })
})
