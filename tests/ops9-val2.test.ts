/**
 * OPS-9 val 2 (v1.75.0) — pure units, NO db fixtures.
 *
 * Covers:
 *  - src/lib/eslog.ts: parseEslog — eSLOG 1.6-ish (namespaced UBL) + 2.0-ish
 *    (prefix-free UBL) fixtures, decimal comma tolerance, garbage/unrecognized
 *    XML → null invoice + error (NEVER throws).
 *  - src/lib/durs.ts: classifyDursQuery (si / eu / invalid) + normalizeViesResponse
 *    (valid / invalid / "-" name / garbage).
 *  - src/lib/recurring-po.ts: computeNextRun (weekday rollover, same-day later
 *    slot, everyWeeks=2 phase, empty weekdays → null) + isDue (past → true,
 *    future → false, inactive → false, missing nextRun → false).
 *
 * Pure data only — no DB, no auth, no fixtures (no TEST_PREFIXES entry needed).
 */
import { describe, expect, test } from 'bun:test'
import { parseEslog } from '../src/lib/eslog'
import { classifyDursQuery, normalizeViesResponse } from '../src/lib/durs'
import { computeNextRun, isDue, parseRecurringConfig } from '../src/lib/recurring-po'

/* ─────────── eSLOG fixtures ─────────── */

const ESLOG_16_XML = `<?xml version="1.0" encoding="UTF-8"?>
<inv:Invoice xmlns:inv="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
             xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
             xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:eslog:1.6</cbc:CustomizationID>
  <cbc:ID>2024-00042</cbc:ID>
  <cbc:IssueDate>2024-03-15</cbc:IssueDate>
  <cbc:DueDate>2024-04-14</cbc:DueDate>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Mercator d.o.o.</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme><cbc:CompanyID>SI59827513</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:CompanyID>59827513</cbc:CompanyID></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:PaymentMeans><cac:PayeeFinancialAccount><cbc:ID>SI56 02000 00123456</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">44.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">200.00</cbc:TaxExclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">244.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="KGM">10</cbc:InvoicedQuantity>
    <cac:Item><cbc:Name>Moka moka</cbc:Name><cac:ClassifiedTaxCategory><cbc:Percent>22.00</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">12.50</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="LTR">8</cbc:InvoicedQuantity>
    <cac:Item><cbc:Name>Soncecnovo olje</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">10,00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</inv:Invoice>`

const ESLOG_20_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:eSLOG_2_0</CustomizationID>
  <ID>ES20-1001</ID>
  <IssueDate>2025-11-02</IssueDate>
  <DueDate>2025-12-02</DueDate>
  <AccountingSupplierParty>
    <Party>
      <PartyName><Name>Tus d.d.</Name></PartyName>
      <PartyTaxScheme><CompanyID>SI80267432</CompanyID><TaxScheme><ID>VAT</ID></TaxScheme></PartyTaxScheme>
    </Party>
  </AccountingSupplierParty>
  <TaxTotal><TaxAmount currencyID="EUR">6.60</TaxAmount></TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount currencyID="EUR">30.00</TaxExclusiveAmount>
    <PayableAmount currencyID="EUR">36.60</PayableAmount>
  </LegalMonetaryTotal>
  <InvoiceLine>
    <ID>1</ID>
    <InvoicedQuantity unitCode="H87">3</InvoicedQuantity>
    <Item><Name>Skodelica espresso</Name><ClassifiedTaxCategory><Percent>22</Percent></ClassifiedTaxCategory></Item>
    <Price><PriceAmount currencyID="EUR">10.00</PriceAmount></Price>
  </InvoiceLine>
</Invoice>`

describe('OPS-9/2 parseEslog — eSLOG 1.6 (namespaced UBL)', () => {
  const r = parseEslog(ESLOG_16_XML)
  test('parses without error and returns an invoice', () => {
    expect(r.error).toBeNull()
    expect(r.invoice).not.toBeNull()
  })
  test('header fields (number, dates, money)', () => {
    const inv = r.invoice!
    expect(inv.invoiceNumber).toBe('2024-00042')
    expect(inv.issueDate).toBe('2024-03-15')
    expect(inv.dueDate).toBe('2024-04-14')
    expect(inv.subtotal).toBe(200)
    expect(inv.vatTotal).toBe(44)
    expect(inv.total).toBe(244)
  })
  test('supplier (digits-only taxId, name, IBAN without spaces)', () => {
    const inv = r.invoice!
    expect(inv.supplier.taxId).toBe('59827513')
    expect(inv.supplier.name).toBe('Mercator d.o.o.')
    expect(inv.supplier.iban).toBe('SI560200000123456')
  })
  test('lines (quantity, decimal-comma price, vat rate)', () => {
    const inv = r.invoice!
    expect(inv.lines).toHaveLength(2)
    expect(inv.lines[0]).toEqual({ name: 'Moka moka', quantity: 10, unitPrice: 12.5, vatRate: 22 })
    expect(inv.lines[1].name).toBe('Soncecnovo olje')
    expect(inv.lines[1].quantity).toBe(8)
    expect(inv.lines[1].unitPrice).toBe(10) // "10,00" decimal comma
    expect(inv.lines[1].vatRate).toBe(0) // no tax category on the line
  })
})

describe('OPS-9/2 parseEslog — eSLOG 2.0 (prefix-free UBL)', () => {
  test('parses fields without namespace prefixes', () => {
    const r = parseEslog(ESLOG_20_XML)
    expect(r.error).toBeNull()
    const inv = r.invoice!
    expect(inv.invoiceNumber).toBe('ES20-1001')
    expect(inv.issueDate).toBe('2025-11-02')
    expect(inv.dueDate).toBe('2025-12-02')
    expect(inv.supplier.taxId).toBe('80267432') // from PartyTaxScheme (no PartyLegalEntity)
    expect(inv.supplier.name).toBe('Tus d.d.')
    expect(inv.supplier.iban).toBe('') // no PaymentMeans
    expect(inv.lines).toHaveLength(1)
    expect(inv.lines[0].vatRate).toBe(22)
    expect(inv.total).toBe(36.6)
    expect(inv.vatTotal).toBe(6.6)
    expect(inv.subtotal).toBe(30)
  })
})

describe('OPS-9/2 parseEslog — garbage is never a throw', () => {
  test('empty / plain text / non-invoice XML → invoice null + error', () => {
    expect(parseEslog('').invoice).toBeNull()
    expect(parseEslog('not xml at all').invoice).toBeNull()
    expect(parseEslog('<foo><bar>1</bar></foo>').error).toContain('Nepoznana struktura')
    expect(parseEslog('<root><Invoice><IssueDate>2025-01-01</IssueDate></Invoice></root>').error).toContain('številke')
    expect(parseEslog('<Invoice><ID>X1</ID><InvoiceLine><Item><Name>Test</Name></Item></InvoiceLine></Invoice>').invoice?.lines[0]?.name).toBe('Test') // tolerant minimal invoice
  })
})

/* ─────────── classifyDursQuery ─────────── */

describe('OPS-9/2 classifyDursQuery', () => {
  test('SI (domestic) → si', () => {
    expect(classifyDursQuery('59827513')).toBe('si')
    expect(classifyDursQuery('SI59827513')).toBe('si')
    expect(classifyDursQuery('si 5982 7513')).toBe('si')
  })
  test('foreign EU prefixes → eu', () => {
    expect(classifyDursQuery('HR12345678')).toBe('eu')
    expect(classifyDursQuery('DE123456789')).toBe('eu')
    expect(classifyDursQuery('de123456789')).toBe('eu')
    expect(classifyDursQuery('XI123456782')).toBe('eu')
  })
  test('short / names / garbage → invalid', () => {
    expect(classifyDursQuery('598')).toBe('invalid')
    expect(classifyDursQuery('SI1')).toBe('invalid')
    expect(classifyDursQuery('Mercator')).toBe('invalid')
    expect(classifyDursQuery('')).toBe('invalid')
  })
})

/* ─────────── normalizeViesResponse ─────────── */

describe('OPS-9/2 normalizeViesResponse', () => {
  test('valid foreign trader → DursEntry shape + source vies', () => {
    const e = normalizeViesResponse({ isValid: true, countryCode: 'DE', vatNumber: '123456789', name: 'Muster GmbH', address: 'Weg 1' })
    expect(e).toEqual({ taxNumber: '123456789', vatId: 'DE123456789', name: 'Muster GmbH', vatPayer: true, ibans: [], source: 'vies' })
  })
  test('invalid number → vatPayer false (still an entry)', () => {
    const e = normalizeViesResponse({ isValid: false, countryCode: 'HR', vatNumber: '12345678901' })
    expect(e?.vatPayer).toBe(false)
    expect(e?.vatId).toBe('HR12345678901')
    expect(e?.source).toBe('vies')
  })
  test('missing trader name ("-" placeholder) → empty name', () => {
    const e = normalizeViesResponse({ isValid: true, countryCode: 'FR', vatNumber: '12', name: '-' })
    expect(e?.name).toBe('')
  })
  test('garbage → null', () => {
    expect(normalizeViesResponse(null)).toBeNull()
    expect(normalizeViesResponse('x')).toBeNull()
    expect(normalizeViesResponse({ isValid: 'yes' })).toBeNull()
  })
})

/* ─────────── computeNextRun ─────────── */

describe('OPS-9/2 computeNextRun', () => {
  test('weekday rollover: Mon 10:00, Friday 8:00 rule → Fri 8:00 same week', () => {
    const from = new Date(2025, 0, 6, 10, 0) // Monday
    const next = computeNextRun({ weekdays: [5], hour: 8, everyWeeks: 1 }, from)
    expect(next).toEqual(new Date(2025, 0, 10, 8, 0)) // Friday
  })
  test('same-day later slot fires (run just happened at 8, rule also at 14)', () => {
    const from = new Date(2025, 0, 6, 8, 0) // Monday 8:00
    const next = computeNextRun({ weekdays: [1], hour: 14, everyWeeks: 1 }, from)
    expect(next).toEqual(new Date(2025, 0, 6, 14, 0)) // same Monday 14:00
  })
  test('everyWeeks=2: after a run the next allowed week is +2 (phase preserved)', () => {
    const from = new Date(2025, 0, 8, 9, 0) // Wednesday, just after the 8:00 run
    const next = computeNextRun({ weekdays: [3], hour: 8, everyWeeks: 2 }, from)
    expect(next).toEqual(new Date(2025, 0, 22, 8, 0)) // Wednesday +2 weeks
  })
  test('no valid weekdays → null (unschedulable)', () => {
    expect(computeNextRun({ weekdays: [], hour: 8, everyWeeks: 1 }, new Date())).toBeNull()
  })
})

/* ─────────── isDue ─────────── */

describe('OPS-9/2 isDue', () => {
  const now = new Date(2025, 5, 15, 12, 0)
  test('past nextRun + active → true', () => {
    expect(isDue({ active: true, nextRun: new Date(2025, 5, 15, 11, 0).toISOString() }, now)).toBe(true)
  })
  test('future nextRun → false', () => {
    expect(isDue({ active: true, nextRun: new Date(2025, 5, 15, 13, 0).toISOString() }, now)).toBe(false)
  })
  test('inactive rule never fires (even when overdue)', () => {
    expect(isDue({ active: false, nextRun: new Date(2020, 0, 1).toISOString() }, now)).toBe(false)
  })
  test('missing / broken nextRun → false (idempotent default)', () => {
    expect(isDue({ active: true, nextRun: null }, now)).toBe(false)
    expect(isDue({ active: true, nextRun: 'not-a-date' }, now)).toBe(false)
  })
})

/* ─────────── parseRecurringConfig ─────────── */

describe('OPS-9/2 parseRecurringConfig', () => {
  test('tolerant config parsing (object, JSON string, garbage)', () => {
    const rule = { id: 'r1', supplierId: 's1', items: [{ inventoryItemId: 'i1', qty: 2 }], weekdays: [1], hour: 8, everyWeeks: 1, active: true, lastRun: null, nextRun: null }
    expect(parseRecurringConfig({ rules: [rule] })).toHaveLength(1)
    expect(parseRecurringConfig(JSON.stringify({ rules: [rule] }))).toHaveLength(1)
    expect(parseRecurringConfig(null)).toEqual([])
    expect(parseRecurringConfig('{broken')).toEqual([])
    expect(parseRecurringConfig({ rules: 'nope' })).toEqual([])
  })
})
