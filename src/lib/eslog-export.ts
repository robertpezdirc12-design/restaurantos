/**
 * Issue #4 (P1, v1.125.0) — generator ODHODNEGA e-računa (UBL 2.1, eSLOG 2.0
 * SI profil / HR UBL 2.1). ČISTI MODUL: string in → string out, brez DB/IO.
 *
 * PODATkovna pogodba: vrstice so NETO (B2B račun = neto osnova + DDV) — nasprotje
 * POS konvencije v1.124.0 (končna cena za gosta, src/lib/billing.ts). Izvoz
 * zato NE uporablja netFromGross — vhod že JE net.
 *
 * Zneski: r2 (2 decimalni) povsod; TaxSubtotal po stopnjah DDV usklajen z
 * glavnimi zneski (vsota subtotal ≤ ±0.01 zaokrožitvenega šuma).
 *
 * CreditNote: korenski element <CreditNote> z <CreditNoteLine> +
 * <CreditedQuantity> (negativne vrstice — dobropis ZMANJŠA osnovo).
 *
 * POZOR — profilne oznake: CustomizationID je PROFILNA OZNAKA, ki jo mora pred
 * produkcijo potrditi lastnik/uradni vir (docs/E-INVOICES-SI-HR.md §matrika):
 * vrednosti tu so dokumentiran izhodniški niz, NE potrditev skladnosti.
 *
 * XML escaping: VSE tekstovne vsebine (& < > " ') — izvoz je nezaupan vhod
 * strank (imena z & itd. morajo biti literalno varna v XML).
 */

export interface OutgoingEInvoiceLine {
  name: string
  quantity: number
  unitPriceNet: number
  vatRate: number
  /**
   * DDV znesek VRSTICE (override). IZVEDENO iz končne cene za gosta (v1.124.0 —
   * cene v OrderItem so KONČNE, DDV se IZVLEČE): r2(količina × vatFromGross(cena,
   * stopnja)). Ko je prisoten, ga TaxSubtotal/TaxTotal upoštevata NAMESTO
   * neto×stopnja (exaktna usklajenost z glavo AR: neto + DDV = končna cena).
   */
  lineVatAmount?: number
  /** koda enote (UN/ECE rec 20, npr. H87/KGM); neznana → atribut izpustimo */
  unitCode?: string
  /** referenca vrstice (cbc:ID); privzeto zaporedna številka */
  lineId?: string
  /** KPD klasifikacijska oznaka (HR: obvezna 6-mestna; SI: opcijska) — vnos lastnika/prejemnika, NE izmišljena */
  kpdCode?: string
}

export interface OutgoingEInvoiceParty {
  name: string
  taxId: string
  address?: string
  city?: string
  postCode?: string
  country: 'SI' | 'HR'
}

export interface OutgoingEInvoice {
  invoiceNumber: string
  /** ISO yyyy-mm-dd */
  issueDate: string
  /** ISO yyyy-mm-dd; izpust → element DueDate se ne zapiše */
  dueDate?: string
  currency: 'EUR'
  seller: OutgoingEInvoiceParty
  buyer: OutgoingEInvoiceParty
  lines: OutgoingEInvoiceLine[]
  documentType: 'invoice' | 'credit_note'
}

export type EInvoiceProfile = 'eslog-2.0-si' | 'ubl-2.1-hr'

/** r2 — 2 decimali (skupni imenovalec vseh zneskov izvoza). */
function r2(v: number): number {
  return Math.round((Number.isFinite(v) ? v : 0) * 100) / 100
}

/** XML escape tekstovne vrednosti (& < > " '). */
export function xmlEscape(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Znesek kot "10.00" (2 decimali, pika — UBL decimal ločilo). */
function amount(v: number): string {
  return r2(v).toFixed(2)
}

/** DDV stopnja kot "22.00". */
function percent(v: number): string {
  return (Number.isFinite(v) ? Math.max(0, v) : 0).toFixed(2)
}

/** Količina: največ 4 decimalke, brez odvečnih ničel. */
function qty(v: number): string {
  const r = Math.round((Number.isFinite(v) ? v : 0) * 10000) / 10000
  return String(r)
}

/**
 * Profilna oznaka (CustomizationID). IZHODIŠČNI nizi — lastnikova potrditev
 * pred produkcijo (docs/E-INVOICES-SI-HR.md §3 matrika, uradni viri z datumi).
 */
const CUSTOMIZATION: Record<EInvoiceProfile, string> = {
  // eSLOG 2.0 SI — EN 16931 core + SI specifikacija (ZIERDED, obvezna izmenjava od 1. 1. 2028)
  'eslog-2.0-si': 'urn:cen.eu:en16931:2017#compliant#urn:slo-evnj:si:1.0.0',
  // HR eRačun — EN 16931 core + UBL 2.1 (Porezna uprava, objava 15. 4. 2026)
  'ubl-2.1-hr': 'urn:cen.eu:en16931:2017#compliant#urn:hr-porezna:eracun:1.0.0',
}

const INVOICE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
const CREDITNOTE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2'
const CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'
const CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'

function taxSchemeXml(): string {
  return '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>'
}

/** Pošiljatelj/prejemnik (AccountingSupplierParty/AccountingCustomerParty). */
function partyXml(p: OutgoingEInvoiceParty, role: 'Supplier' | 'Customer'): string {
  const lines: string[] = []
  lines.push(`<cac:Accounting${role}Party>`)
  lines.push('  <cac:Party>')
  lines.push(`    <cac:PartyName><cbc:Name>${xmlEscape(p.name)}</cbc:Name></cac:PartyName>`)
  if (p.address || p.city || p.postCode) {
    lines.push('    <cac:PostalAddress>')
    if (p.address) lines.push(`      <cbc:StreetName>${xmlEscape(p.address)}</cbc:StreetName>`)
    if (p.city) lines.push(`      <cbc:CityName>${xmlEscape(p.city)}</cbc:CityName>`)
    if (p.postCode) lines.push(`      <cbc:PostalZone>${xmlEscape(p.postCode)}</cbc:PostalZone>`)
    lines.push(`      <cac:Country><cbc:IdentificationCode>${xmlEscape(p.country)}</cbc:IdentificationCode></cac:Country>`)
    lines.push('    </cac:PostalAddress>')
  }
  // davčna številka BREZ državne predpone (SI12345678 → 12345678) — digits only
  const taxDigits = String(p.taxId ?? '').replace(/\D/g, '')
  lines.push(`    <cac:PartyTaxScheme><cbc:CompanyID>${xmlEscape(taxDigits)}</cbc:CompanyID>${taxSchemeXml()}</cac:PartyTaxScheme>`)
  lines.push(`    <cac:PartyLegalEntity><cbc:CompanyID>${xmlEscape(taxDigits)}</cbc:CompanyID></cac:PartyLegalEntity>`)
  lines.push('  </cac:Party>')
  lines.push(`</cac:Accounting${role}Party>`)
  return lines.map((l) => l.replace(/^\s+/, '')).join('\n')
}

export interface EslogExportTotals {
  subtotal: number
  vatAmount: number
  totalAmount: number
  /** agregacija po stopnjah DDV (za TaxSubtotal) */
  taxSubtotals: { rate: number; taxableAmount: number; taxAmount: number }[]
}

/** Zneski računa iz vrstic (r2 povsod, subtotale usklajene z glavo). */
export function computeOutgoingTotals(lines: OutgoingEInvoiceLine[]): EslogExportTotals {
  let subtotal = 0
  const byRate = new Map<number, { taxableAmount: number; taxAmount: number }>()
  for (const l of lines) {
    const net = r2((Number.isFinite(l.quantity) ? l.quantity : 0) * (Number.isFinite(l.unitPriceNet) ? l.unitPriceNet : 0))
    const rate = Number.isFinite(l.vatRate) ? l.vatRate : 0
    // lineVatAmount (izpeljano iz končne cene, v1.124.0) ima prednost pred neto×stopnja
    const vat = Number.isFinite(l.lineVatAmount) ? r2(l.lineVatAmount ?? 0) : r2(net * (rate / 100))
    subtotal = r2(subtotal + net)
    const cur = byRate.get(rate) || { taxableAmount: 0, taxAmount: 0 }
    cur.taxableAmount = r2(cur.taxableAmount + net)
    cur.taxAmount = r2(cur.taxAmount + vat)
    byRate.set(rate, cur)
  }
  const taxSubtotals = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate, v]) => ({ rate, taxableAmount: v.taxableAmount, taxAmount: v.taxAmount }))
  const vatAmount = r2(taxSubtotals.reduce((a, s) => a + s.taxAmount, 0))
  return { subtotal, vatAmount, totalAmount: r2(subtotal + vatAmount), taxSubtotals }
}

/**
 * Zgenerira UBL 2.1 XML (eSLOG 2.0 SI profil ali HR UBL 2.1).
 * Deterministična (brez časovnih žigov — isti vhod → isti izhod).
 */
export function generateEslogXml(inv: OutgoingEInvoice, opts?: { profile?: EInvoiceProfile }): string {
  const profile: EInvoiceProfile = opts?.profile ?? 'eslog-2.0-si'
  const isCreditNote = inv.documentType === 'credit_note'
  const root = isCreditNote ? 'CreditNote' : 'Invoice'
  const rootNs = isCreditNote ? CREDITNOTE_NS : INVOICE_NS
  const lineTag = isCreditNote ? 'CreditNoteLine' : 'InvoiceLine'
  const quantityTag = isCreditNote ? 'CreditedQuantity' : 'InvoicedQuantity'
  const currency = inv.currency || 'EUR'

  const totals = computeOutgoingTotals(inv.lines)

  const L: string[] = []
  L.push('<?xml version="1.0" encoding="UTF-8"?>')
  L.push(`<${root} xmlns="${rootNs}" xmlns:cac="${CAC_NS}" xmlns:cbc="${CBC_NS}">`)
  L.push(`  <cbc:CustomizationID>${xmlEscape(CUSTOMIZATION[profile])}</cbc:CustomizationID>`)
  L.push(`  <cbc:ID>${xmlEscape(inv.invoiceNumber)}</cbc:ID>`)
  L.push(`  <cbc:IssueDate>${xmlEscape(inv.issueDate)}</cbc:IssueDate>`)
  if (inv.dueDate) L.push(`  <cbc:DueDate>${xmlEscape(inv.dueDate)}</cbc:DueDate>`)
  L.push(`  <cbc:DocumentCurrencyCode>${xmlEscape(currency)}</cbc:DocumentCurrencyCode>`)

  L.push(partyXml(inv.seller, 'Supplier'))
  L.push(partyXml(inv.buyer, 'Customer'))

  // TaxTotal: skupni DDV + TaxSubtotal po stopnjah
  L.push('  <cac:TaxTotal>')
  L.push(`    <cbc:TaxAmount currencyID="${currency}">${amount(totals.vatAmount)}</cbc:TaxAmount>`)
  for (const s of totals.taxSubtotals) {
    L.push('    <cac:TaxSubtotal>')
    L.push(`      <cbc:TaxableAmount currencyID="${currency}">${amount(s.taxableAmount)}</cbc:TaxableAmount>`)
    L.push(`      <cbc:TaxAmount currencyID="${currency}">${amount(s.taxAmount)}</cbc:TaxAmount>`)
    L.push(`      <cac:TaxCategory><cbc:Percent>${percent(s.rate)}</cbc:Percent>${taxSchemeXml()}</cac:TaxCategory>`)
    L.push('    </cac:TaxSubtotal>')
  }
  L.push('  </cac:TaxTotal>')

  L.push('  <cac:LegalMonetaryTotal>')
  L.push(`    <cbc:TaxExclusiveAmount currencyID="${currency}">${amount(totals.subtotal)}</cbc:TaxExclusiveAmount>`)
  L.push(`    <cbc:TaxInclusiveAmount currencyID="${currency}">${amount(totals.totalAmount)}</cbc:TaxInclusiveAmount>`)
  L.push(`    <cbc:PayableAmount currencyID="${currency}">${amount(totals.totalAmount)}</cbc:PayableAmount>`)
  L.push('  </cac:LegalMonetaryTotal>')

  inv.lines.forEach((l, i) => {
    const lineId = l.lineId && String(l.lineId).trim() ? String(l.lineId).trim() : String(i + 1)
    const unitAttr = l.unitCode && String(l.unitCode).trim() ? ` unitCode="${xmlEscape(l.unitCode)}"` : ''
    const net = r2(l.quantity * l.unitPriceNet)
    L.push(`  <cac:${lineTag}>`)
    L.push(`    <cbc:ID>${xmlEscape(lineId)}</cbc:ID>`)
    L.push(`    <cbc:${quantityTag}${unitAttr}>${qty(l.quantity)}</cbc:${quantityTag}>`)
    L.push(`    <cbc:LineExtensionAmount currencyID="${currency}">${amount(net)}</cbc:LineExtensionAmount>`)
    L.push('    <cac:Item>')
    L.push(`      <cbc:Name>${xmlEscape(l.name)}</cbc:Name>`)
    // KPD klasifikacija — SAMO ko jo lastnik/prejemnik vnese (izvoz NE izmišljuje kod)
    if (l.kpdCode && String(l.kpdCode).trim()) {
      L.push(`      <cac:CommodityClassification><cbc:ItemClassificationCode listID="KPD">${xmlEscape(String(l.kpdCode).trim())}</cbc:ItemClassificationCode></cac:CommodityClassification>`)
    }
    L.push(`      <cac:ClassifiedTaxCategory><cbc:Percent>${percent(l.vatRate)}</cbc:Percent>${taxSchemeXml()}</cac:ClassifiedTaxCategory>`)
    L.push('    </cac:Item>')
    L.push(`    <cac:Price><cbc:PriceAmount currencyID="${currency}">${amount(l.unitPriceNet)}</cbc:PriceAmount></cac:Price>`)
    L.push(`  </cac:${lineTag}>`)
  })

  L.push(`</${root}>`)
  return L.join('\n') + '\n'
}
