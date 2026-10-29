/**
 * Issue #4 (P1, v1.125.0) — E-RAČUNI SI/HR: generator, validacija, življenjski
 * cikel, issue/send/retry rute, webhook (HMAC + dedup), list/detail/xml, uvoz
 * opozorila, registri, DDL ruta.
 *
 * 0 omrežja (SAMO mock adapter), 0 pravih poverilnic, 0 izmišljenih podatkov:
 * davčne številke GENERIRA funkcija mod11-10/OIB (checkDigitSiTaxId/
 * checkDigitHrOib), KPD kode vnese "uporabnik" testa (prejemnikova odločitev).
 * Fiksture s predpono i4- (TEST_PREFIXES).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { createHash, createHmac } from 'crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import {
  generateEslogXml, computeOutgoingTotals, xmlEscape,
  type OutgoingEInvoice, type OutgoingEInvoiceLine,
} from '../src/lib/eslog-export'
import {
  validateSiTaxId, validateHrOib, checkDigitSiTaxId, checkDigitHrOib,
  validateOutgoing, validateIncoming,
} from '../src/lib/einvoice-validate'
import { canTransition, applyTransition, resolveStatusPath, EINVOICE_STATUSES } from '../src/lib/einvoice-lifecycle'
import { parseEslog } from '../src/lib/eslog'
import { POST as issuePOST } from '../src/app/api/einvoices/issue/route'
import { POST as sendPOST } from '../src/app/api/einvoices/[id]/send/route'
import { POST as retryPOST } from '../src/app/api/einvoices/[id]/retry/route'
import { GET as listGET } from '../src/app/api/einvoices/route'
import { GET as detailGET } from '../src/app/api/einvoices/[id]/route'
import { GET as xmlGET } from '../src/app/api/einvoices/[id]/xml/route'
import { POST as webhookPOST } from '../src/app/api/einvoices/webhook/[provider]/route'
import { POST as ddlPOST } from '../src/app/api/admin/migrate-einvoice-outbox/route'
import { POST as eslogImportPOST } from '../src/app/api/ap/import-eslog/route'
import { GET as monitoringGET } from '../src/app/api/monitoring/errors/route'

const P = 'i4-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const SECRET = 'i4-test-webhook-secret'

/* ── generirane (NE realne) davčne številke ── */
const SI_TAX = '1234567' + String(checkDigitSiTaxId('1234567'))
const SI_TAX_2 = '7654321' + String(checkDigitSiTaxId('7654321'))
const HR_OIB = '1234567890' + String(checkDigitHrOib('1234567890'))
const SI_TAX_BAD = '12345670' // 7. števka pokvarjena (checksum ne ujema)
const HR_OIB_BAD = '12345678900' // kontrolna pokvarjena

let locA = ''
let locB = ''
let supplierId = ''
let integrationId = ''
let orderId = ''
let orderId2 = ''
let tokA = ''
let tokB = ''
let tokWait = ''
let tokOwner = ''
let tokAcctB = ''
const arIds: string[] = []
const outboxIds: string[] = []
const eventSeq = { n: 0 }
const ipSeq = { n: 0 }

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

/** Webhook zahteva: raw telo + podpis + UNIKATEN IP (neodvisen rate-limit bucket). */
function whReq(provider: string, raw: string, opts: { sign?: boolean; sig?: string; big?: boolean } = {}): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': `10.4.4.${++ipSeq.n}`,
  }
  if (opts.big) headers['content-length'] = String(70 * 1024)
  if (opts.sign !== false) {
    headers['x-einvoice-signature'] = opts.sig ?? 'sha256=' + createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')
  }
  return new NextRequest(`http://localhost:3000/api/einvoices/webhook/${provider}`, { method: 'POST', headers, body: raw })
}

function whBody(externalRef: string, status: string, eventId?: string): string {
  return JSON.stringify({ eventId: eventId ?? `i4-evt-${++eventSeq.n}-${RUN}`, externalRef, status, reason: `i4 razlog ${RUN}` })
}

async function seedEmployee(name: string, role: string, loc: string | null, seq: number): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const f = employeePinFields(`${PIN_BASE}${seq}`, `${P}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${name}`, email: `${P}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

/** Izdaja ročnega e-računa prek ownerja (issue #72 D2: einvoices.issue =
 * ADMIN/OWNER/enterprise/accounting — MANAGER/warehouse NIMATA več pravice). */
async function issueManual(overrides: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = {
    customerName: `${P}Podjetje ${RUN}`,
    customerTaxId: SI_TAX,
    customerCountry: 'SI',
    lines: [{ name: `${P}Storitev ${RUN}`, quantity: 2, unitPriceNet: 5, vatRate: 22 }],
    ...overrides,
  }
  const r = await issuePOST(req('POST', '/api/einvoices/issue', tokOwner, body))
  const json = (await r.json()) as Record<string, unknown>
  const ei = json.eInvoice as { id?: string } | undefined
  const ar = json.ar as { id?: string } | undefined
  if (ei?.id) outboxIds.push(ei.id)
  if (ar?.id) arIds.push(ar.id)
  return { status: r.status, json }
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function sendOut(id: string, token = tokA): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await sendPOST(req('POST', `/api/einvoices/${id}/send`, token, {}), params(id))
  return { status: r.status, json: (await r.json()) as Record<string, unknown> }
}

async function retryOut(id: string, token = tokA): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await retryPOST(req('POST', `/api/einvoices/${id}/retry`, token, {}), params(id))
  return { status: r.status, json: (await r.json()) as Record<string, unknown> }
}

/** Referenčni odhodni račun za generator/validacijo teste. */
function sampleInvoice(lines: OutgoingEInvoiceLine[] = [{ name: 'Kava & mleko', quantity: 2, unitPriceNet: 5, vatRate: 22 }]): OutgoingEInvoice {
  return {
    invoiceNumber: `AR-2026-000${(outboxIds.length % 9) + 1}`,
    issueDate: '2026-10-17',
    dueDate: '2026-11-16',
    currency: 'EUR',
    seller: { name: `${P}Restavracija ${RUN}`, taxId: SI_TAX_2, address: 'Ulica 1', city: 'Ljubljana', postCode: '1000', country: 'SI' },
    buyer: { name: `${P}Podjetje ${RUN}`, taxId: SI_TAX, country: 'SI' },
    lines,
    documentType: 'invoice',
  }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  locA = `${P}locA-${RUN}`
  locB = `${P}locB-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A`, premisesId: `${P}premA-${RUN}`, taxId: SI_TAX_2 } })
  await db.location.create({ data: { id: locB, code: `${P}LB`, name: `${P}Lokacija B`, premisesId: `${P}premB-${RUN}` } })

  // naročilo (izvor za izdajo iz naročila) — artikel → kategorija → meni → lokacija
  const menu = await db.menu.create({ data: { id: `${P}menu-${RUN}`, name: `${P}Meni`, locationId: locA } })
  const cat = await db.category.create({ data: { id: `${P}cat-${RUN}`, name: `${P}Kat`, menuId: menu.id } })
  const item = await db.menuItem.create({ data: { id: `${P}mi-${RUN}`, name: `${P}Jedi ${RUN}`, price: 10, categoryId: cat.id } })
  const mkOrder = async (suffix: string): Promise<string> => {
    const oid = `${P}ord${suffix}-${RUN}`
    const ord = await db.order.create({ data: { id: oid, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, type: 'dine-in', status: 'paid', paymentStatus: 'paid' } })
    await db.orderItem.create({ data: { id: `${P}oi${suffix}-${RUN}`, orderId: ord.id, menuItemId: item.id, quantity: 3, price: 10, vatRate: 22, vatAmount: 0, menuItemName: `${P}Jedi ${RUN}` } })
    return ord.id
  }
  orderId = await mkOrder('1')
  orderId2 = await mkOrder('2')

  // dobavitelj za uvozne teste (davčna GENERIRANA — ne realna)
  const sup = await db.supplier.create({ data: { id: `${P}sup-${RUN}`, name: `${P}Dobavitelj ${RUN}`, code: `I4-${RUN}`, taxId: SI_TAX } })
  supplierId = sup.id

  await seedEmployee('mgrA', 'manager', locA, 1)
  await seedEmployee('mgrB', 'manager', locB, 2)
  await seedEmployee('waitA', 'waiter', locA, 3)
  await seedEmployee('owner', 'owner', locA, 4)
  // issue #72 D2: računovodja (accounting) na lokaciji B — NI centralen, a ima
  // einvoices.issue → za cross-lokacijski scope test (404, ne 403)
  await seedEmployee('acctB', 'accounting', locB, 5)
  tokA = tok(`${P}mgrA-${RUN}`, `${P}mgrA`, 'MANAGER', locA)
  tokB = tok(`${P}mgrB-${RUN}`, `${P}mgrB`, 'MANAGER', locB)
  tokWait = tok(`${P}waitA-${RUN}`, `${P}waitA`, 'WAITER', locA)
  tokOwner = tok(`${P}owner-${RUN}`, `${P}owner`, 'OWNER', locA)
  tokAcctB = tok(`${P}acctB-${RUN}`, `${P}acctB`, 'ACCOUNTING', locB)

  // integracija: type 'einvoice', provider 'mock' (register vedno pozna mock)
  const integ = await db.integration.create({
    data: {
      id: `${P}integ-${RUN}`, name: `${P} eRačuni mock`, type: 'einvoice', provider: 'mock',
      apiSecret: SECRET, config: '{"simulate":"deliver"}', isActive: true, locationId: locA,
    },
  })
  integrationId = integ.id
})

afterAll(async () => {
  // revizija: audit dogodki teh testov (entityId = outbox/ar id + DDL audit)
  await db.auditLog.deleteMany({
    where: { OR: [...(outboxIds.length ? [{ entityId: { in: outboxIds } }] : []), ...(arIds.length ? [{ entityId: { in: arIds } }] : []), { entityId: 'einvoice_outbox_create' }, { locationId: { in: [locA, locB] } }] },
  }).catch(() => null)
  await db.integrationLog.deleteMany({ where: { integrationId } }).catch(() => null)
  await db.eInvoiceOutbox.deleteMany({ where: { id: { in: outboxIds } } }).catch(() => null)
  await db.accountsReceivable.deleteMany({ where: { id: { in: arIds } } }).catch(() => null)
  await db.accountsPayable.deleteMany({ where: { supplierId } }).catch(() => null)
  await db.integration.deleteMany({ where: { id: integrationId } }).catch(() => null)
  await db.supplier.deleteMany({ where: { id: supplierId } }).catch(() => null)
  await db.orderItem.deleteMany({ where: { orderId: { in: [orderId, orderId2] } } }).catch(() => null)
  await db.order.deleteMany({ where: { id: { in: [orderId, orderId2] } } }).catch(() => null)
  await db.menuItem.deleteMany({ where: { id: { startsWith: `${P}mi-` } } }).catch(() => null)
  await db.category.deleteMany({ where: { id: { startsWith: `${P}cat-` } } }).catch(() => null)
  await db.menu.deleteMany({ where: { id: { startsWith: `${P}menu-` } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { in: [locA, locB] } } }).catch(() => null)
})

/* ══════════════ A. generator (UBL 2.1 / eSLOG 2.0) ══════════════ */

describe('A. generator — struktura, escaping, round-trip', () => {
  const inv = sampleInvoice()
  const xml = generateEslogXml(inv)

  it('struktura XML: Invoice/ID/IssueDate/DocumentCurrencyCode/stranke/vrstice/TaxTotal/LegalMonetaryTotal', () => {
    for (const el of ['<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"', 'cbc:ID', 'cbc:IssueDate', 'cbc:DueDate', 'cbc:DocumentCurrencyCode', 'AccountingSupplierParty', 'AccountingCustomerParty', 'InvoiceLine', 'TaxTotal', 'TaxSubtotal', 'LegalMonetaryTotal', 'TaxExclusiveAmount', 'TaxInclusiveAmount', 'PayableAmount']) {
      expect(xml).toContain(el)
    }
    expect(xml).toContain('<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:slo-evnj:si:1.0.0</cbc:CustomizationID>')
  })

  it('escaping: ime z & < > se v XML escapa, parse ga povrne (nikoli raw)', () => {
    const nasty = sampleInvoice([{ name: 'Sir & <z> "sir"', quantity: 1, unitPriceNet: 2, vatRate: 22 }])
    const x = generateEslogXml(nasty)
    expect(x).not.toContain('<z>')
    expect(x).toContain('&amp;')
    expect(x).toContain('&lt;')
    const back = parseEslog(x)
    expect(back.error).toBeNull()
    expect(back.invoice!.lines[0].name).toBe('Sir & <z> "sir"')
    // xmlEscape unit: vsi 5 znaki
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })

  it('round-trip: parseEslog(generateEslogXml(x)) vrne enake ključne podatke (±0.01)', () => {
    const lines: OutgoingEInvoiceLine[] = [
      { name: 'Vrsta A', quantity: 2, unitPriceNet: 5.333, vatRate: 22, unitCode: 'H87' },
      { name: 'Vrsta B', quantity: 1, unitPriceNet: 3.5, vatRate: 9.5 },
    ]
    const src = sampleInvoice(lines)
    const totals = computeOutgoingTotals(lines)
    const back = parseEslog(generateEslogXml(src))
    expect(back.error).toBeNull()
    const i = back.invoice!
    expect(i.invoiceNumber).toBe(src.invoiceNumber)
    expect(i.issueDate).toBe(src.issueDate)
    expect(i.dueDate).toBe(src.dueDate)
    expect(i.currency).toBe('EUR')
    expect(i.supplier.taxId).toBe(SI_TAX_2)
    expect(i.lines.map((l) => l.name)).toEqual(['Vrsta A', 'Vrsta B'])
    expect(i.lines[0].quantity).toBe(2)
    expect(Math.abs(i.lines[0].unitPrice - 5.333)).toBeLessThanOrEqual(0.01)
    expect(i.lines[0].vatRate).toBe(22)
    expect(Math.abs(i.subtotal - totals.subtotal)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(i.vatTotal - totals.vatAmount)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(i.total - totals.totalAmount)).toBeLessThanOrEqual(0.01)
  })

  it('TaxSubtotal agregacija po stopnjah (2 stopnji → 2 bloka, usklajene vsote)', () => {
    const lines: OutgoingEInvoiceLine[] = [
      { name: 'A', quantity: 2, unitPriceNet: 5, vatRate: 22 },
      { name: 'B', quantity: 1, unitPriceNet: 3.5, vatRate: 9.5 },
      { name: 'C', quantity: 1, unitPriceNet: 4, vatRate: 22 },
    ]
    const x = generateEslogXml(sampleInvoice(lines))
    const sub22 = /TaxableAmount currencyID="EUR">14\.00/.test(x)
    const sub95 = /TaxableAmount currencyID="EUR">3\.50/.test(x)
    expect(sub22).toBe(true)
    expect(sub95).toBe(true)
    const blocks = x.match(/<cac:TaxSubtotal>/g) ?? []
    expect(blocks.length).toBe(2)
    const t = computeOutgoingTotals(lines)
    expect(t.taxSubtotals.find((s) => s.rate === 22)?.taxAmount).toBe(3.08)
    expect(t.taxSubtotals.find((s) => s.rate === 9.5)?.taxAmount).toBe(0.33)
  })

  it('CreditNote: root CreditNote + CreditNoteLine + negativna CreditedQuantity', () => {
    const cn = generateEslogXml({ ...sampleInvoice([{ name: 'Vrni postavko', quantity: -2, unitPriceNet: 5, vatRate: 22 }]), documentType: 'credit_note' }, { profile: 'eslog-2.0-si' })
    expect(cn).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"')
    expect(cn).toContain('<cac:CreditNoteLine>')
    expect(cn).toContain('<cbc:CreditedQuantity')
    const back = parseEslog(cn)
    expect(back.error).toBeNull()
    expect(back.invoice!.documentType).toBe('credit_note')
    expect(back.invoice!.lines[0].quantity).toBe(-2)
    expect(back.invoice!.lines[0].credited).toBe(true)
    expect(computeOutgoingTotals([{ name: 'x', quantity: -2, unitPriceNet: 5, vatRate: 22 }]).totalAmount).toBe(-12.2)
  })

  it('KPD element prisoten SAMO ko je kpdCode podan (HR)', () => {
    const withKpd = generateEslogXml(sampleInvoice([{ name: 'A', quantity: 1, unitPriceNet: 5, vatRate: 25, kpdCode: '123456' }]))
    expect(withKpd).toContain('CommodityClassification')
    expect(withKpd).toContain('<cbc:ItemClassificationCode listID="KPD">123456</cbc:ItemClassificationCode>')
    const without = generateEslogXml(sampleInvoice())
    expect(without).not.toContain('CommodityClassification')
    expect(without).not.toContain('KPD')
  })

  it('determinističnost: isti vhod → ista XML in isti sha256', () => {
    const x1 = generateEslogXml(inv)
    const x2 = generateEslogXml(inv)
    expect(x1).toBe(x2)
    const h1 = createHash('sha256').update(x1, 'utf8').digest('hex')
    const h2 = createHash('sha256').update(x2, 'utf8').digest('hex')
    expect(h1).toBe(h2)
  })

  it('profil: HR CustomizationID se razlikuje od SI', () => {
    const xHr = generateEslogXml(sampleInvoice(), { profile: 'ubl-2.1-hr' })
    expect(xHr).toContain('urn:hr-porezna:eracun')
    expect(xHr).not.toContain('urn:slo-evnj')
  })
})

/* ══════════════ B. validacija (davčne, poslovna pravila) ══════════════ */

describe('B. validacija — checksum + poslovna pravila', () => {
  it('SI davčna številka: generirana veljavna', () => {
    expect(validateSiTaxId(SI_TAX)).toBe(true)
    expect(validateSiTaxId('SI' + SI_TAX)).toBe(false) // 9 znakov ni 8
  })
  it('SI davčna številka: pokvarjen checksum', () => {
    expect(validateSiTaxId(SI_TAX_BAD)).toBe(false)
    expect(validateSiTaxId('1234567')).toBe(false)
  })
  it('HR OIB: generiran veljaven', () => {
    expect(validateHrOib(HR_OIB)).toBe(true)
  })
  it('HR OIB: pokvarjen kontrolni znak', () => {
    expect(validateHrOib(HR_OIB_BAD)).toBe(false)
    expect(validateHrOib('1234567890')).toBe(false)
  })
  it('manjkajoč naziv prejemnika → napaka s field imenom', () => {
    const v = validateOutgoing({ ...sampleInvoice(), buyer: { name: '', taxId: SI_TAX, country: 'SI' } }, 'eslog-2.0-si')
    expect(v.errors.some((e) => e.field === 'customerName')).toBe(true)
  })
  it('Σ vrstic ≠ glava → napaka (subtotal/vat/total)', () => {
    const lines = [{ name: 'A', quantity: 2, unitPriceNet: 5, vatRate: 22 }]
    const v = validateOutgoing(sampleInvoice(lines), 'eslog-2.0-si', { subtotal: 100, vatAmount: 22, totalAmount: 122 })
    expect(v.errors.some((e) => e.field === 'subtotal')).toBe(true)
  })
  it('Σ vrstic ≈ glava znotraj ±0.02 → brez napake', () => {
    const lines = [{ name: 'A', quantity: 2, unitPriceNet: 5, vatRate: 22 }]
    const t = computeOutgoingTotals(lines)
    const v = validateOutgoing(sampleInvoice(lines), 'eslog-2.0-si', { subtotal: t.subtotal + 0.01, vatAmount: t.vatAmount, totalAmount: t.totalAmount })
    expect(v.errors.filter((e) => ['subtotal', 'vatAmount', 'totalAmount'].includes(e.field))).toHaveLength(0)
  })
  it('HR brez KPD → napaka s številko vrstice', () => {
    const v = validateOutgoing(sampleInvoice(), 'ubl-2.1-hr')
    expect(v.errors.some((e) => e.field === 'lines[0].kpdCode' && e.message.includes('1'))).toBe(true)
    const ok = validateOutgoing(sampleInvoice([{ name: 'A', quantity: 1, unitPriceNet: 5, vatRate: 25, kpdCode: '123456' }]), 'ubl-2.1-hr')
    expect(ok.errors.filter((e) => e.field === 'lines[0].kpdCode')).toHaveLength(0)
  })
  it('SI brez KPD → OK (tiho opcijsko)', () => {
    const v = validateOutgoing(sampleInvoice(), 'eslog-2.0-si')
    expect(v.errors.filter((e) => e.field.includes('kpd'))).toHaveLength(0)
    expect(v.errors).toHaveLength(0)
  })
  it('dueDate < issueDate → napaka', () => {
    const v = validateOutgoing({ ...sampleInvoice(), issueDate: '2026-10-17', dueDate: '2026-10-16' }, 'eslog-2.0-si')
    expect(v.errors.some((e) => e.field === 'dueDate')).toBe(true)
  })
  it('qty ≤ 0 → napaka (negativne vrstice samo pri dobropisu)', () => {
    const v = validateOutgoing(sampleInvoice([{ name: 'A', quantity: 0, unitPriceNet: 5, vatRate: 22 }]), 'eslog-2.0-si')
    expect(v.errors.some((e) => e.field === 'lines[0].quantity')).toBe(true)
    const neg = validateOutgoing(sampleInvoice([{ name: 'A', quantity: -1, unitPriceNet: 5, vatRate: 22 }]), 'eslog-2.0-si')
    expect(neg.errors.some((e) => e.field === 'lines[0].quantity')).toBe(true)
  })
  it('valuta ≠ EUR → opozorilo (ne blokira); DDV izven 0–30 → napaka', () => {
    const v = validateOutgoing({ ...sampleInvoice(), currency: 'USD' as 'EUR' }, 'eslog-2.0-si')
    expect(v.warnings.some((w) => w.field === 'currency')).toBe(true)
    expect(v.errors).toHaveLength(0)
    const badVat = validateOutgoing(sampleInvoice([{ name: 'A', quantity: 1, unitPriceNet: 5, vatRate: 45 }]), 'eslog-2.0-si')
    expect(badVat.errors.some((e) => e.field === 'lines[0].vatRate')).toBe(true)
  })
})

/* ══════════════ C. POST /api/einvoices/issue ══════════════ */

describe('C. issue ruta — izdaja terjatve + outbox', () => {
  it('ročno: 201 z AR (open) + outbox (draft, xml, hash, idempotencyKey=id) + audit EINVOICE_ISSUED', async () => {
    const arCountBefore = await db.accountsReceivable.count()
    const { status, json } = await issueManual()
    expect(status).toBe(201)
    const ei = json.eInvoice as Record<string, unknown>
    const ar = json.ar as Record<string, unknown>
    expect(ar.status).toBe('open')
    expect(ei.status).toBe('draft')
    expect(ei.profile).toBe('eslog-2.0-si')
    expect(typeof ei.xmlHash).toBe('string')
    expect(ei.idempotencyKey).toBe(ei.id)
    const row = await db.eInvoiceOutbox.findUnique({ where: { id: ei.id as string } })
    expect(row).not.toBeNull()
    expect(row!.status).toBe('draft')
    expect(row!.xmlPayload).toContain('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"')
    expect(row!.xmlHash).toBe(ei.xmlHash)
    expect(row!.receiverTaxId).toBe(SI_TAX)
    expect(await db.accountsReceivable.count()).toBe(arCountBefore + 1)
    const audit = await db.auditLog.findFirst({ where: { action: 'EINVOICE_ISSUED', entityId: ar.id as string } })
    expect(audit).not.toBeNull()
  })

  it('iz orderId: 201, vrstice iz OrderItem — neto in DDV ZAOKROŽENA PO VRSTICI (#6)', async () => {
    const { status, json } = await issueManual({ orderId, lines: undefined })
    expect(status).toBe(201)
    const ei = json.eInvoice as Record<string, unknown>
    // 3 × 10,00 € KONČNE cene pri 22 %: neto vrstice = r2(30 / 1,22) = 24,59,
    // DDV je preostanek do bruto = 5,41. STARA napaka je zaokroževala na ENOTI
    // (8,20 × 3 = 24,60 in 1,80 × 3 = 5,40) → osnova za en cent mimo plačila.
    expect(Number(ei.subtotal)).toBeCloseTo(24.59, 2)
    expect(Number(ei.vatAmount)).toBeCloseTo(5.41, 2)
    expect(Number(ei.totalAmount)).toBeCloseTo(30, 2)
    const row = await db.eInvoiceOutbox.findUnique({ where: { id: ei.id as string } })
    expect(row!.arId).not.toBeNull()
    const arRow = await db.accountsReceivable.findUnique({ where: { id: row!.arId! } })
    expect(arRow!.orderId).toBe(orderId)
  })

  it('neveljaven davčni prejemnika → 400 {errors:[{field}]} BREZ nove AR', async () => {
    const arCount = await db.accountsReceivable.count()
    const { status, json } = await issueManual({ customerTaxId: SI_TAX_BAD })
    expect(status).toBe(400)
    const errors = json.errors as { field: string; message: string }[]
    expect(errors.some((e) => e.field === 'customerTaxId')).toBe(true)
    expect(await db.accountsReceivable.count()).toBe(arCount)
    expect(await db.eInvoiceOutbox.count({ where: { receiverTaxId: SI_TAX_BAD } })).toBe(0)
  })

  it('orderId duplikat (odprta AR že obstaja) → 409 {duplicate:true}', async () => {
    const first = await issueManual({ orderId: orderId2, lines: undefined })
    expect(first.status).toBe(201)
    const second = await issueManual({ orderId: orderId2, lines: undefined })
    expect(second.status).toBe(409)
    expect(second.json.duplicate).toBe(true)
    expect((second.json.ar as Record<string, unknown>).arNumber).toBeDefined()
  })

  it('403 brez pravice (waiter nima einvoices.issue)', async () => {
    const r = await issuePOST(req('POST', '/api/einvoices/issue', tokWait, {
      customerName: 'x', customerTaxId: SI_TAX, customerCountry: 'SI', lines: [{ name: 'a', quantity: 1, unitPriceNet: 1, vatRate: 22 }],
    }))
    expect(r.status).toBe(403)
  })

  it('cross-lokacija naročila → 404 (scope)', async () => {
    // issue #72 D2: akter ima einvoices.issue (accounting) a je LOKACIJSKO vezan —
    // sicer bi bil odgovor 403 (manjka pravica), ne 404 (scope)
    const r = await issuePOST(req('POST', '/api/einvoices/issue', tokAcctB, { orderId, customerName: 'x', customerTaxId: SI_TAX, customerCountry: 'SI' }))
    expect(r.status).toBe(404)
    const j = (await r.json()) as Record<string, unknown>
    expect(String(j.error)).toContain('obsegu')
  })

  it('currency ≠ EUR → 201 z opozorilom (warning, ne napaka)', async () => {
    const { status, json } = await issueManual({ currency: 'USD' })
    expect(status).toBe(201)
    const warnings = json.eInvoice && (json.eInvoice as Record<string, unknown>).warnings as { field: string }[] | undefined
    expect(warnings?.some((w) => w.field === 'currency')).toBe(true)
  })

  it('prazne vrstice → 400', async () => {
    const arCount = await db.accountsReceivable.count()
    const { status } = await issueManual({ lines: [] })
    expect(status).toBe(400)
    expect(await db.accountsReceivable.count()).toBe(arCount)
  })

  it('arNumber sekvenca: dve zaporedni izdaji AR-YYYY-NNNN/NNNN+1', async () => {
    const a = await issueManual()
    const b = await issueManual()
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const numA = String((a.json.ar as Record<string, unknown>).arNumber)
    const numB = String((b.json.ar as Record<string, unknown>).arNumber)
    expect(numA).toMatch(/^AR-\d{4}-\d{4}$/)
    const seqA = parseInt(numA.split('-')[2], 10)
    const seqB = parseInt(numB.split('-')[2], 10)
    expect(seqB).toBe(seqA + 1)
  })

  it('HR prejemnik: profil ubl-2.1-hr + manjkajoč KPD → 400 (blokira)', async () => {
    const arCount = await db.accountsReceivable.count()
    const { status, json } = await issueManual({ customerCountry: 'HR', customerTaxId: HR_OIB })
    expect(status).toBe(400)
    const errors = json.errors as { field: string }[]
    expect(errors.some((e) => e.field === 'lines[0].kpdCode')).toBe(true)
    expect(await db.accountsReceivable.count()).toBe(arCount)
    // z KPD → 201 s HR profilom
    const ok = await issueManual({ customerCountry: 'HR', customerTaxId: HR_OIB, lines: [{ name: 'HR postavka', quantity: 1, unitPriceNet: 10, vatRate: 25, kpdCode: '123456' }] })
    expect(ok.status).toBe(201)
    expect((ok.json.eInvoice as Record<string, unknown>).profile).toBe('ubl-2.1-hr')
    expect((ok.json.eInvoice as Record<string, unknown>).country).toBe('HR')
  })
})

/* ══════════════ D. življenjski cikel (pure) ══════════════ */

describe('D. lifecycle — prehodi', () => {
  it('legalni prehodi (forward-only + retry luči)', () => {
    expect(canTransition('draft', 'validated')).toBe(true)
    expect(canTransition('validated', 'queued')).toBe(true)
    expect(canTransition('queued', 'sent')).toBe(true)
    expect(canTransition('queued', 'failed')).toBe(true)
    expect(canTransition('sent', 'delivered')).toBe(true)
    expect(canTransition('sent', 'rejected')).toBe(true)
    expect(canTransition('sent', 'needs_review')).toBe(true)
    expect(canTransition('delivered', 'accepted')).toBe(true)
    expect(canTransition('failed', 'queued')).toBe(true)
    expect(canTransition('rejected', 'queued')).toBe(true)
    expect(canTransition('needs_review', 'queued')).toBe(true)
  })
  it('nezakoniti prehodi (nazaj/preskok)', () => {
    expect(canTransition('delivered', 'draft')).toBe(false)
    expect(canTransition('draft', 'sent')).toBe(false)
    expect(canTransition('draft', 'accepted')).toBe(false)
    expect(canTransition('sent', 'queued')).toBe(false)
    expect(canTransition('validated', 'failed')).toBe(false)
  })
  it('terminal accepted NE gre nikamor več', () => {
    expect(applyTransition('accepted', 'rejected').ok).toBe(false)
    expect(applyTransition('accepted', 'queued').ok).toBe(false)
    expect(applyTransition('accepted', 'delivered').ok).toBe(false)
    expect(applyTransition('delivered', 'draft').ok).toBe(false)
  })
  it('no-op (isti status) → ok brez spremembe', () => {
    const r = applyTransition('sent', 'sent')
    expect(r.ok).toBe(true)
    expect(r.next).toBe('sent')
    expect(canTransition('draft', 'draft')).toBe(true)
  })
  it('resolveStatusPath: večkorakovna pot + nazaj ni poti', () => {
    expect(resolveStatusPath('draft', 'sent')).toEqual(['draft', 'validated', 'queued', 'sent'])
    expect(resolveStatusPath('failed', 'sent')).toEqual(['failed', 'queued', 'sent'])
    expect(resolveStatusPath('sent', 'accepted')).toEqual(['sent', 'delivered', 'accepted'])
    expect(resolveStatusPath('accepted', 'rejected')).toBeNull()
    expect(resolveStatusPath('delivered', 'draft')).toBeNull()
    expect(EINVOICE_STATUSES).toContain('needs_review')
  })
})

/* ══════════════ E. send / retry ══════════════ */

describe('E. send/retry — mock adapter, idempotenca, blokade', () => {
  it('mock deliver → status sent + externalRef + attempts 1 + audit EINVOICE_STATUS (origin adapter)', async () => {
    const { json } = await issueManual()
    const id = (json.eInvoice as Record<string, unknown>).id as string
    const s = await sendOut(id)
    expect(s.status).toBe(200)
    expect(s.json.sent).toBe(true)
    expect(s.json.status).toBe('sent')
    const ext = String(s.json.externalRef)
    expect(ext).toMatch(/^mock-[0-9a-f]{12}$/)
    const row = await db.eInvoiceOutbox.findUnique({ where: { id } })
    expect(row!.status).toBe('sent')
    expect(row!.externalRef).toBe(ext)
    expect(row!.attempts).toBe(1)
    expect(row!.sentAt).not.toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'EINVOICE_STATUS', entityId: id } })
    expect(audit).not.toBeNull()
    expect(audit!.details).toContain('"origin":"adapter"')
    expect(audit!.details).toContain(`"externalRef":"${ext}"`)
    const log = await db.integrationLog.findFirst({ where: { integrationId, action: 'einvoice-send' } })
    expect(log).not.toBeNull()
  })

  it('drugi send → 409 alreadySent, attempts OSTANE 1 (idempotenca — brez drugega zunanjega dokumenta)', async () => {
    const { json } = await issueManual()
    const id = (json.eInvoice as Record<string, unknown>).id as string
    const first = await sendOut(id)
    expect(first.status).toBe(200)
    const second = await sendOut(id)
    expect(second.status).toBe(409)
    expect(second.json.alreadySent).toBe(true)
    expect(second.json.status).toBe('sent')
    const row = await db.eInvoiceOutbox.findUnique({ where: { id } })
    expect(row!.attempts).toBe(1)
    expect(await db.integrationLog.count({ where: { integrationId, action: 'einvoice-send', status: 'ok' } })).toBeLessThanOrEqual(2)
  })

  it('simulate timeout → failed + EINVOICE_SEND_FAILED viden v monitoring /api/errors', async () => {
    await db.integration.update({ where: { id: integrationId }, data: { config: '{"simulate":"timeout"}' } })
    try {
      const { json } = await issueManual()
      const id = (json.eInvoice as Record<string, unknown>).id as string
      const s = await sendOut(id)
      expect(s.status).toBe(502)
      expect(s.json.sent).toBe(false)
      const row = await db.eInvoiceOutbox.findUnique({ where: { id } })
      expect(row!.status).toBe('failed')
      expect(row!.attempts).toBe(1)
      expect(row!.lastReason).toContain('timeout')
      expect(row!.externalRef).toBe('')
      // monitoring: EINVOICE_SEND_FAILED akcija (GAP-7 vzorec OR action) —
      // issue #72 C1: /api/monitoring/errors zahteva settings.manage → OWNER
      const r = await monitoringGET(req('GET', '/api/monitoring/errors', tokOwner))
      expect(r.status).toBe(200)
      const j = (await r.json()) as { errors: { action: string; entityId: string | null }[] }
      expect(j.errors.some((e) => e.action === 'EINVOICE_SEND_FAILED' && e.entityId === id)).toBe(true)
    } finally {
      await db.integration.update({ where: { id: integrationId }, data: { config: '{"simulate":"deliver"}' } })
    }
  })

  it('retry iz failed → send z ISTIM idempotencyKey → sent, attempts 2', async () => {
    // failed outbox iz prejšnjega testa (externalRef prazen → brez probe)
    const failed = await db.eInvoiceOutbox.findFirst({ where: { status: 'failed' }, orderBy: { createdAt: 'desc' } })
    expect(failed).not.toBeNull()
    const r = await retryOut(failed!.id)
    expect(r.status).toBe(200)
    expect(r.json.retried).toBe(true)
    expect(r.json.status).toBe('sent')
    expect(Number(r.json.attempts)).toBe(2)
    const row = await db.eInvoiceOutbox.findUnique({ where: { id: failed!.id } })
    expect(row!.status).toBe('sent')
    expect(row!.externalRef).toMatch(/^mock-/)
  })

  it('retry po zavrnitvi (probeStatus prej) → ISTI externalRef, attempts +1', async () => {
    const { json } = await issueManual()
    const id = (json.eInvoice as Record<string, unknown>).id as string
    const s = await sendOut(id)
    const ext = String(s.json.externalRef)
    // zavrnitev prek webhooka → rejected
    const wh = await webhookPOST(whReq('mock', whBody(ext, 'rejected')), { params: Promise.resolve({ provider: 'mock' }) })
    expect(wh.status).toBe(200)
    expect((await wh.json() as Record<string, unknown>).status).toBe('rejected')
    // retry: probeStatus (externalRef obstaja) → send z ISTIM ključem → ISTI ref
    const r = await retryOut(id)
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('sent')
    expect(r.json.externalRef).toBe(ext)
    const row = await db.eInvoiceOutbox.findUnique({ where: { id } })
    expect(row!.externalRef).toBe(ext)
    expect(row!.attempts).toBe(2)
  })

  it('neregistriran ponudnik → 409 blocked (ključavnica — nikoli lažni poslano)', async () => {
    await db.integration.update({ where: { id: integrationId }, data: { provider: 'i4-neregistriran' } })
    try {
      const { json } = await issueManual()
      const id = (json.eInvoice as Record<string, unknown>).id as string
      const s = await sendOut(id)
      expect(s.status).toBe(409)
      expect(s.json.blocked).toBe(true)
      expect(String(s.json.reason)).toContain('ni registriran')
      const row = await db.eInvoiceOutbox.findUnique({ where: { id } })
      expect(row!.status).toBe('draft')
      expect(row!.externalRef).toBe('')
      expect(row!.attempts).toBe(0)
    } finally {
      await db.integration.update({ where: { id: integrationId }, data: { provider: 'mock' } })
    }
  })

  it('send izvede validacijo: pokvarjen receiverTaxId → 400 BREZ pošiljanja (status draft ostane)', async () => {
    const { json } = await issueManual()
    const id = (json.eInvoice as Record<string, unknown>).id as string
    await db.eInvoiceOutbox.update({ where: { id }, data: { receiverTaxId: SI_TAX_BAD } })
    const s = await sendOut(id)
    expect(s.status).toBe(400)
    const errors = s.json.errors as { field: string }[]
    expect(errors.some((e) => e.field === 'customerTaxId')).toBe(true)
    const row = await db.eInvoiceOutbox.findUnique({ where: { id } })
    expect(row!.status).toBe('draft')
    expect(row!.attempts).toBe(0)
    expect(row!.externalRef).toBe('')
  })

  it('send iz accepted → 409 alreadySent', async () => {
    const { json } = await issueManual()
    const id = (json.eInvoice as Record<string, unknown>).id as string
    await db.eInvoiceOutbox.update({ where: { id }, data: { status: 'accepted' } })
    const s = await sendOut(id)
    expect(s.status).toBe(409)
    expect(s.json.alreadySent).toBe(true)
    expect(s.json.status).toBe('accepted')
  })

  it('retry iz sent → 409 (samo failed/rejected/needs_review)', async () => {
    const sent = await db.eInvoiceOutbox.findFirst({ where: { status: 'sent', externalRef: { not: '' } }, orderBy: { createdAt: 'desc' } })
    expect(sent).not.toBeNull()
    const r = await retryOut(sent!.id)
    expect(r.status).toBe(409)
  })
})

/* ══════════════ F. webhook (HMAC, dedup, meje) ══════════════ */

describe('F. webhook — podpis, dedup, varnostne meje', () => {
  let whInvoiceId = ''
  let whExt = ''
  let whFirstEventId = ''

  it('veljaven HMAC → status delivered + audit origin webhook + IntegrationLog', async () => {
    const { json } = await issueManual()
    whInvoiceId = (json.eInvoice as Record<string, unknown>).id as string
    const s = await sendOut(whInvoiceId)
    whExt = String(s.json.externalRef)
    const raw = whBody(whExt, 'delivered')
    const r = await webhookPOST(whReq('mock', raw), { params: Promise.resolve({ provider: 'mock' }) })
    expect(r.status).toBe(200)
    const j = (await r.json()) as Record<string, unknown>
    expect(j.received).toBe(true)
    expect(j.status).toBe('delivered')
    const row = await db.eInvoiceOutbox.findUnique({ where: { id: whInvoiceId } })
    expect(row!.status).toBe('delivered')
    const audit = await db.auditLog.findFirst({ where: { action: 'EINVOICE_STATUS', entityType: 'EInvoiceOutbox', entityId: whInvoiceId }, orderBy: { timestamp: 'desc' } })
    expect(audit).not.toBeNull()
    expect(audit!.details).toContain('"origin":"webhook"')
    const evtId = JSON.parse(raw).eventId as string
    whFirstEventId = evtId
    expect(audit!.details).toContain(`"correlationId":"${evtId}"`)
    const log = await db.integrationLog.findFirst({ where: { integrationId, action: 'einvoice-webhook' } })
    expect(log).not.toBeNull()
  })

  it('isti eventId dvakrat → 200 {duplicate:true}, EN prehod (processedEvents)', async () => {
    const raw = whBody(whExt, 'delivered', whFirstEventId)
    const again = await webhookPOST(whReq('mock', raw), { params: Promise.resolve({ provider: 'mock' }) })
    expect(again.status).toBe(200)
    const j = (await again.json()) as Record<string, unknown>
    expect(j.duplicate).toBe(true)
    // processedEvents vsebuje eventId; status se NE premakne
    const row = await db.eInvoiceOutbox.findUnique({ where: { id: whInvoiceId } })
    expect(row!.status).toBe('delivered')
    expect(row!.processedEvents).toContain(JSON.parse(raw).eventId as string)
    const audits = await db.auditLog.count({ where: { action: 'EINVOICE_STATUS', entityId: whInvoiceId } })
    expect(audits).toBeGreaterThanOrEqual(2)
  })

  it('no-op webhook (isti status) → 200 {ignored:true}', async () => {
    const raw = whBody(whExt, 'delivered')
    const r = await webhookPOST(whReq('mock', raw), { params: Promise.resolve({ provider: 'mock' }) })
    // ta eventId je nov → ne duplicate, ampak no-op prehod (delivered→delivered)
    const j = (await r.json()) as Record<string, unknown>
    expect(j.ignored === true || j.duplicate === true).toBe(true)
  })

  it('slab podpis → 401', async () => {
    const r = await webhookPOST(whReq('mock', whBody(whExt, 'delivered'), { sig: 'sha256=' + '0'.repeat(64) }), { params: Promise.resolve({ provider: 'mock' }) })
    expect(r.status).toBe(401)
  })

  it('manjkajoč podpis → 401', async () => {
    const r = await webhookPOST(whReq('mock', whBody(whExt, 'delivered'), { sign: false }), { params: Promise.resolve({ provider: 'mock' }) })
    expect(r.status).toBe(401)
  })

  it('neznan provider → 404', async () => {
    const r = await webhookPOST(whReq('glovo', whBody(whExt, 'delivered')), { params: Promise.resolve({ provider: 'glovo' }) })
    expect(r.status).toBe(404)
  })

  it('brez secreta (sandbox brez integracije/env) → 503', async () => {
    const r = await webhookPOST(whReq('sandbox', whBody(whExt, 'delivered')), { params: Promise.resolve({ provider: 'sandbox' }) })
    expect(r.status).toBe(503)
  })

  it('oversize telo (content-length > 64 KB) → 413', async () => {
    const r = await webhookPOST(whReq('mock', '{}', { big: true }), { params: Promise.resolve({ provider: 'mock' }) })
    expect(r.status).toBe(413)
  })

  it('neznan externalRef → 404 brez razkritja', async () => {
    const r = await webhookPOST(whReq('mock', whBody('mock-neznana-ref', 'delivered')), { params: Promise.resolve({ provider: 'mock' }) })
    expect(r.status).toBe(404)
    const j = (await r.json()) as Record<string, unknown>
    expect(String(j.error)).not.toContain(whExt)
  })

  it('terminal accepted + webhook rejected → ignored (brez regresije)', async () => {
    // podvoji znan dokument v novo vrstico (terminal accepted)
    const { json } = await issueManual()
    const id = (json.eInvoice as Record<string, unknown>).id as string
    const s = await sendOut(id)
    const ext = String(s.json.externalRef)
    await webhookPOST(whReq('mock', whBody(ext, 'delivered')), { params: Promise.resolve({ provider: 'mock' }) })
    await webhookPOST(whReq('mock', whBody(ext, 'accepted')), { params: Promise.resolve({ provider: 'mock' }) })
    const row = await db.eInvoiceOutbox.findUnique({ where: { id } })
    expect(row!.status).toBe('accepted')
    const rej = await webhookPOST(whReq('mock', whBody(ext, 'rejected')), { params: Promise.resolve({ provider: 'mock' }) })
    expect(rej.status).toBe(200)
    const j = (await rej.json()) as Record<string, unknown>
    expect(j.ignored).toBe(true)
    const after = await db.eInvoiceOutbox.findUnique({ where: { id } })
    expect(after!.status).toBe('accepted') // BREZ regresije
  })

  it('neveljavna statusna vrednost → 400', async () => {
    const r = await webhookPOST(whReq('mock', whBody(whExt, 'shipped')), { params: Promise.resolve({ provider: 'mock' }) })
    expect(r.status).toBe(400)
  })

  it('rate limit: 31. zahteva z istim IP → 429', async () => {
    const ip = `10.9.9.${++ipSeq.n}`
    const mk = () => new NextRequest('http://localhost:3000/api/einvoices/webhook/mock', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-einvoice-signature': 'x' },
      body: '{}',
    })
    let last = 200
    for (let i = 0; i < 31; i++) {
      const r = await webhookPOST(mk(), { params: Promise.resolve({ provider: 'mock' }) })
      last = r.status
    }
    expect(last).toBe(429)
  })
})

/* ══════════════ G. list / detail / xml ══════════════ */

describe('G. list/detail/xml — filtri, scope, dokaz XML', () => {
  it('filtri status/country/q', async () => {
    const si = await issueManual()
    const hr = await issueManual({ customerCountry: 'HR', customerTaxId: HR_OIB, lines: [{ name: `${P}HR vrstica`, quantity: 1, unitPriceNet: 10, vatRate: 25, kpdCode: '123456' }] })
    expect(si.status).toBe(201)
    expect(hr.status).toBe(201)

    const all = await listGET(req('GET', '/api/einvoices?status=draft', tokA))
    expect(all.status).toBe(200)
    const jAll = (await all.json()) as { eInvoices: { country: string; status: string }[]; total: number }
    expect(jAll.eInvoices.every((e) => e.status === 'draft')).toBe(true)

    const onlyHr = await listGET(req('GET', '/api/einvoices?country=HR', tokA))
    const jHr = (await onlyHr.json()) as { eInvoices: { country: string }[] }
    expect(jHr.eInvoices.length).toBeGreaterThan(0)
    expect(jHr.eInvoices.every((e) => e.country === 'HR')).toBe(true)

    const q = encodeURIComponent('Podjetje')
    const byQ = await listGET(req('GET', `/api/einvoices?q=${q}`, tokA))
    const jQ = (await byQ.json()) as { eInvoices: { receiverName: string }[] }
    expect(jQ.eInvoices.length).toBeGreaterThan(0)
    expect(jQ.eInvoices.every((e) => e.receiverName.includes('Podjetje'))).toBe(true)
  })

  it('scope: manager B NE vidi e-računov lokacije A', async () => {
    const mine = await listGET(req('GET', '/api/einvoices', tokA))
    const jA = (await mine.json()) as { eInvoices: { id: string; locationId: string | null }[] }
    expect(jA.eInvoices.length).toBeGreaterThan(0)
    const theirs = await listGET(req('GET', '/api/einvoices', tokB))
    const jB = (await theirs.json()) as { eInvoices: { id: string }[] }
    const bIds = new Set(jB.eInvoices.map((e) => e.id))
    for (const row of jA.eInvoices) {
      if (row.locationId === locA) expect(bIds.has(row.id)).toBe(false)
    }
    // detail/xml prav tako tuji → 404
    const idA = jA.eInvoices.find((e) => e.locationId === locA)?.id
    if (idA) {
      const d = await detailGET(req('GET', `/api/einvoices/${idA}`, tokB), params(idA))
      expect(d.status).toBe(404)
    }
  })

  it('detail: events časovnica (≥2 dogodka po send + webhook)', async () => {
    const { json } = await issueManual()
    const id = (json.eInvoice as Record<string, unknown>).id as string
    const s = await sendOut(id)
    const ext = String(s.json.externalRef)
    await webhookPOST(whReq('mock', whBody(ext, 'delivered')), { params: Promise.resolve({ provider: 'mock' }) })
    const d = await detailGET(req('GET', `/api/einvoices/${id}`, tokA), params(id))
    expect(d.status).toBe(200)
    const j = (await d.json()) as { eInvoice: { status: string }; events: { action: string }[]; processedEventIds: string[] }
    expect(j.eInvoice.status).toBe('delivered')
    expect(j.events.filter((e) => e.action === 'EINVOICE_STATUS').length).toBeGreaterThanOrEqual(2)
    expect(j.processedEventIds.length).toBeGreaterThanOrEqual(1)
  })

  it('xml: content-type application/xml + X-EInvoice-Hash === xmlHash', async () => {
    const { json } = await issueManual()
    const ei = json.eInvoice as Record<string, unknown>
    const id = ei.id as string
    const r = await xmlGET(req('GET', `/api/einvoices/${id}/xml`, tokA), params(id))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/xml')
    expect(r.headers.get('x-einvoice-hash')).toBe(ei.xmlHash)
    const body = await r.text()
    expect(body).toContain('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"')
    expect(createHash('sha256').update(body, 'utf8').digest('hex')).toBe(ei.xmlHash)
  })

  it('list NE vrača xmlPayload (težko polje izključeno iz selekta)', async () => {
    const r = await listGET(req('GET', '/api/einvoices?limit=100', tokA))
    const j = (await r.json()) as { eInvoices: Record<string, unknown>[] }
    expect(j.eInvoices.length).toBeGreaterThan(0)
    for (const row of j.eInvoices) {
      expect(row.xmlPayload).toBeUndefined()
      expect(row.id).toBeDefined()
    }
  })

  it('detail s tujim uporabnikom → 404; xml prav tako', async () => {
    const mine = await listGET(req('GET', '/api/einvoices', tokA))
    const jA = (await mine.json()) as { eInvoices: { id: string; locationId: string | null }[] }
    const idA = jA.eInvoices.find((e) => e.locationId === locA)?.id
    expect(idA).toBeDefined()
    const x = await xmlGET(req('GET', `/api/einvoices/${idA}/xml`, tokB), params(idA!))
    expect(x.status).toBe(404)
  })
})

/* ══════════════ H. uvoz: opozorila + XXE ══════════════ */

describe('H. prejeti eSLOG — opozorila (aditivno) + XXE varnost', () => {
  function eslogXml(opts: { sub?: number; vat?: number; total?: number; cur?: string; kpd?: string; linesQty?: number } = {}): string {
    const sub = opts.sub ?? 10.0
    const vat = opts.vat ?? 2.2
    const total = opts.total ?? 12.2
    const qty = opts.linesQty ?? 2
    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <ID>i4-${RUN}-${Math.floor(Math.random() * 100000)}</ID>
  <IssueDate>2026-10-01</IssueDate>
  <DueDate>2026-10-15</DueDate>
  ${opts.cur ? `<DocumentCurrencyCode>${opts.cur}</DocumentCurrencyCode>` : ''}
  <AccountingSupplierParty><Party>
    <PartyName><Name>${P}Dobavitelj ${RUN}</Name></PartyName>
    <PartyTaxScheme><CompanyID>SI${SI_TAX}</CompanyID></PartyTaxScheme>
  </Party></AccountingSupplierParty>
  <TaxTotal><TaxAmount>${vat.toFixed(2)}</TaxAmount></TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>${sub.toFixed(2)}</TaxExclusiveAmount>
    <PayableAmount>${total.toFixed(2)}</PayableAmount>
  </LegalMonetaryTotal>
  <InvoiceLine>
    <InvoicedQuantity>${qty}</InvoicedQuantity>
    <Item><Name>Kava zrna</Name>${opts.kpd ? `<CommodityClassification><ItemClassificationCode listID="KPD">${opts.kpd}</ItemClassificationCode></CommodityClassification>` : ''}</Item>
    <Price><PriceAmount>5.00</PriceAmount></Price>
    <TaxCategory><Percent>22</Percent></TaxCategory>
  </InvoiceLine>
</Invoice>`
  }

  it('parser izlušči DocumentCurrencyCode (aditivno polje currency)', () => {
    const r = parseEslog(eslogXml({ cur: 'HRK' }))
    expect(r.error).toBeNull()
    expect(r.invoice!.currency).toBe('HRK')
    const none = parseEslog(eslogXml())
    expect(none.invoice!.currency).toBeUndefined()
  })

  it('parser izlušči KPD oznako postavke (CommodityClassification)', () => {
    const r = parseEslog(eslogXml({ kpd: '123456' }))
    expect(r.error).toBeNull()
    expect(r.invoice!.lines[0].kpdCode).toBe('123456')
  })

  it('uvoz z neusklajenimi zneski → 201 + warnings (neblokirajoča opozorila)', async () => {
    const apBefore = await db.accountsPayable.count({ where: { supplierId } })
    const r = await eslogImportPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: eslogXml({ sub: 100, vat: 22, total: 122 }) }))
    expect(r.status).toBe(201)
    const j = (await r.json()) as { warnings: { field: string; message: string }[] }
    expect(j.warnings.some((w) => w.field === 'subtotal' || w.field === 'total')).toBe(true)
    expect(await db.accountsPayable.count({ where: { supplierId } })).toBe(apBefore + 1)
  })

  it('uvoz brez valute → warning; XXE (DOCTYPE zunanja entiteta) → zavrnjen, uvoz NE pade, brez razkritja', async () => {
    // brez DocumentCurrencyCode → opozorilo o valuti
    const r = await eslogImportPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: eslogXml() }))
    expect(r.status).toBe(201)
    const j = (await r.json()) as { warnings: { field: string }[] }
    expect(j.warnings.some((w) => w.field === 'currency')).toBe(true)

    // XXE poskus: DOCTYPE z EXTERNAL entiteto — parser odkloni (fail-closed), uvoz
    // vrne 422 (NE vrže), datotečna vsebina NI razrešena niti izpisana
    const xxe = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Invoice [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<Invoice>
  <ID>i4-xxe-${RUN}</ID>
  <IssueDate>2026-10-01</IssueDate>
  <AccountingSupplierParty><Party>
    <PartyName><Name>&xxe;</Name></PartyName>
    <PartyTaxScheme><CompanyID>SI${SI_TAX}</CompanyID></PartyTaxScheme>
  </Party></AccountingSupplierParty>
  <TaxTotal><TaxAmount>2.20</TaxAmount></TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>10.00</TaxExclusiveAmount>
    <PayableAmount>12.20</PayableAmount>
  </LegalMonetaryTotal>
  <InvoiceLine>
    <InvoicedQuantity>2</InvoicedQuantity>
    <Item><Name>&xxe;</Name></Item>
    <Price><PriceAmount>5.00</PriceAmount></Price>
    <TaxCategory><Percent>22</Percent></TaxCategory>
  </InvoiceLine>
</Invoice>`
    const apCount = await db.accountsPayable.count({ where: { supplierId } })
    const rx = await eslogImportPOST(req('POST', '/api/ap/import-eslog', tokA, { xml: xxe }))
    expect(rx.status).toBe(422)
    const jx = (await rx.json()) as Record<string, unknown>
    const msg = String(jx.error ?? '')
    expect(msg).not.toContain('root:')
    expect(await db.accountsPayable.count({ where: { supplierId } })).toBe(apCount)
    // parseEslog sam NE vrže (fail-closed odgovor)
    const direct = parseEslog(xxe)
    expect(direct.invoice).toBeNull()
    expect(direct.error).toContain('External entities')
  })
})

/* ══════════════ I. registri ══════════════ */

describe('I. registri — verzija, DDL register, predpone, i18n, 0 DDL na obstoječih', () => {
  it('APP_VERSION === 1.134.0', () => {
    expect(APP_VERSION).toBe('1.195.0')
  })
  it('SCHEMA_MIGRATIONS.length === 32 (+order-item-seats #20 v1.193.0)', () => {
    expect(SCHEMA_MIGRATIONS.length).toBe(32) // v1.193.0: +order-item-seats (sedeži #20)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'einvoice-outbox')
    expect(m).toBeDefined()
    expect(m!.descKey).toBe('mig.einvoiceOutbox.desc')
    expect(m!.endpoint).toBe('/api/admin/migrate-einvoice-outbox')
    expect(typeof m!.probe).toBe('function')
  })
  it("'i4-' je v TEST_PREFIXES (fixture sweep)", () => {
    expect(TEST_PREFIXES).toContain('i4-')
  })
  it('i18n: ei.* ključi obstajajo v SL in HR (5 vzorčnih + mig opis)', () => {
    for (const k of ['ei.card', 'ei.status.needs_review', 'ei.err.blocked', 'ei.kpd.required', 'ei.dated', 'mig.einvoiceOutbox.desc']) {
      expect(typeof (sl as Record<string, unknown>)[k]).toBe('string')
      expect(typeof (hr as Record<string, unknown>)[k]).toBe('string')
    }
    expect(sl['ei.status.needs_review']).toContain('razrešitev')
    expect(hr['ei.kpd.required']).toContain('obavezna')
  })
  it('0 DDL na obstoječih tabelah — DDL ruta vsebuje SAMO stavke EInvoiceOutbox', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'app', 'api', 'admin', 'migrate-einvoice-outbox', 'route.ts'), 'utf8')
    const stmts = [...src.matchAll(/`((?:CREATE|ALTER) [^`]+)`/g)].map((m) => m[1])
    // 6 SQLITE (inline FK — SQLite ne podpira ALTER ADD CONSTRAINT) + 8 PG (prisma diff izhod)
    expect(stmts.length).toBe(14)
    for (const s of stmts) {
      expect(s).toContain('"EInvoiceOutbox"')
    }
    // noben ALTER na obstoječi tabeli (AR/Location dobita SAMO prisma back-relacijo)
    for (const s of stmts) {
      if (/^ALTER TABLE/i.test(s)) expect(s).toContain('CONSTRAINT "EInvoiceOutbox_')
    }
  })
})

/* ══════════════ J. DDL ruta (migrate-einvoice-outbox) ══════════════ */

describe('J. DDL ruta — avtorizacija, idempotenca, izvedba', () => {
  it('manager (ne-centralna vloga) → 403', async () => {
    const r = await ddlPOST(req('POST', '/api/admin/migrate-einvoice-outbox', tokA))
    expect(r.status).toBe(403)
  })

  it('idempotentno: tabela obstaja (dev db push) → alreadyApplied brez DDL', async () => {
    const r = await ddlPOST(req('POST', '/api/admin/migrate-einvoice-outbox', tokOwner))
    expect(r.status).toBe(200)
    const j = (await r.json()) as { alreadyApplied: boolean; applied: unknown[] }
    expect(j.alreadyApplied).toBe(true)
    expect(j.applied).toEqual([])
  })

  it('DROP TABLE → POST → DDL izvedba (dialekt: 6 sqlite / 8 pg stavkov) + audit + tabela rekreirana', async () => {
    // mig65 PrintJob vzorec: realna izvedba delegirane rute nad spuščeno tabelo
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS "EInvoiceOutbox"')
    const r = await ddlPOST(req('POST', '/api/admin/migrate-einvoice-outbox', tokOwner))
    expect(r.status).toBe(200)
    const j = (await r.json()) as { alreadyApplied: boolean; applied: { ddl: string }[]; outboxCountAfter: number }
    expect(j.alreadyApplied).toBe(false)
    const expectN = (process.env.DATABASE_URL ?? '').startsWith('file:') ? 6 : 8 // sqlite: inline FK (brez ALTER ADD CONSTRAINT), pg: prisma diff
    expect(j.applied).toHaveLength(expectN)
    expect(j.outboxCountAfter).toBe(0)
    // tabela spet deluje s tipiziranim klientom
    expect(await db.eInvoiceOutbox.count()).toBe(0)
    const audit = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_EINVOICE_OUTBOX' }, orderBy: { timestamp: 'desc' } })
    expect(audit).not.toBeNull()
    expect(audit!.details).toContain(`"statements":${expectN}`)
  })
})
