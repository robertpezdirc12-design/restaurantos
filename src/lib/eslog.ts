/**
 * OPS-9 val 2 (v1.75.0) — eSLOG e-račun parser (čisti sloj, brez DB / fetcha).
 *
 * Accepts an XML string of a Slovenian e-invoice:
 *   - eSLOG 1.6 (UBL 2.1 Invoice, namespaced tags like <cac:...>/<cbc:...>)
 *   - eSLOG 2.0 (EN 16931 UBL Invoice; may or may not use namespace prefixes)
 *
 * Tolerance strategy: parse with fast-xml-parser (removeNSPrefix so prefixed and
 * plain tags normalize to the same keys, ignoreAttributes: false so attribute-only
 * nodes still exist as objects, parseTagValue: false so we do our own decimal
 * parsing with comma tolerance). Navigation helpers accept arrays at every level
 * because UBL repeats elements freely (InvoiceLine[], TaxSubtotal[], ...).
 *
 * Contract: parseEslog(xml) NEVER throws — it returns { invoice, error } where
 * exactly one of the two is meaningful (invoice === null when unrecognized).
 * Pure function: string in, object out — unit-testable without IO.
 */
import { XMLParser } from 'fast-xml-parser'

export interface EslogLine {
  name: string
  quantity: number
  unitPrice: number
  vatRate: number
}

export interface EslogSupplier {
  /** digits only (SI12345678 -> "12345678"); empty when absent */
  taxId: string
  name: string
  iban: string
}

export interface EslogInvoice {
  invoiceNumber: string
  /** ISO yyyy-mm-dd (as written in the XML); empty when absent */
  issueDate: string
  /** ISO yyyy-mm-dd or empty */
  dueDate: string
  supplier: EslogSupplier
  lines: EslogLine[]
  subtotal: number
  vatTotal: number
  total: number
}

export interface EslogParseResult {
  invoice: EslogInvoice | null
  /** human-readable reason when invoice === null; null when parsed OK */
  error: string | null
}

type XmlNode = Record<string, unknown>

/* ─────────── tolerant navigation helpers ─────────── */

function asArray(v: unknown): unknown[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

/**
 * Walk a dotted path where EVERY segment may expand into an array
 * (UBL repeats containers freely) — returns the first leaf value found.
 */
function pick(root: unknown, path: string[]): unknown {
  let level: unknown[] = [root]
  for (const seg of path) {
    const next: unknown[] = []
    for (const node of level) {
      if (!node || typeof node !== 'object') continue
      next.push(...asArray((node as XmlNode)[seg]))
    }
    level = next
    if (level.length === 0) return null
  }
  return level[0] ?? null
}

/** Text content of a node; tolerates attribute-carrying objects ({ '#text': ... }). */
function textOf(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return textOf(v[0])
  if (typeof v === 'object') {
    const o = v as XmlNode
    if (typeof o['#text'] === 'string') return o['#text'].trim()
  }
  return ''
}

/** Case-insensitive BFS for the first key equal to `name` (bounded depth). */
function deepFind(root: unknown, name: string, maxDepth = 8): unknown {
  const target = name.toLowerCase()
  let level: unknown[] = [root]
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: unknown[] = []
    for (const node of level) {
      if (!node || typeof node !== 'object') continue
      for (const [k, v] of Object.entries(node as XmlNode)) {
        if (k.toLowerCase() === target) {
          const hit = asArray(v)[0]
          if (hit != null) return hit
        }
        if (v && typeof v === 'object') next.push(v)
      }
    }
    level = next
  }
  return null
}

/** Decimal parser tolerant to SI/HR formats: "1234.56", "1.234,56", "1234,56". */
function numFrom(s: string): number {
  let t = String(s ?? '').trim().replace(/\s/g, '')
  if (!t) return NaN
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.')
  else if (t.includes(',')) t = t.replace(',', '.')
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

function digitsOnly(v: string): string {
  return String(v ?? '').replace(/\D/g, '')
}

function firstNonEmpty(...vals: string[]): string {
  for (const v of vals) if (v) return v
  return ''
}

/* ─────────── extraction ─────────── */

/**
 * Locate the invoice root object inside the parsed document tree.
 * UBL documents parse to { Invoice: {...} } (declaration becomes '?xml');
 * credit notes ({ CreditNote }) are accepted with the same extraction rules.
 */
function invoiceRoot(doc: XmlNode): { root: XmlNode | null; found: boolean } {
  for (const key of ['Invoice', 'CreditNote', 'InvoiceDocument']) {
    const hit = doc[key]
    if (hit && typeof hit === 'object' && !Array.isArray(hit)) return { root: hit as XmlNode, found: true }
    if (Array.isArray(hit) && hit.length > 0 && typeof hit[0] === 'object') {
      return { root: hit[0] as XmlNode, found: true }
    }
  }
  // last resort: any top-level object whose key contains "invoice" (e.g. "UBLInvoice"),
  // then a bounded deep search for a wrapped <Invoice> node (e.g. <root><Invoice>...)
  for (const [k, v] of Object.entries(doc)) {
    if (/invoice/i.test(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      return { root: v as XmlNode, found: true }
    }
  }
  const deep = deepFind(doc, 'Invoice', 3)
  if (deep && typeof deep === 'object' && !Array.isArray(deep)) {
    return { root: deep as XmlNode, found: true }
  }
  return { root: null, found: false }
}

function supplierOf(inv: XmlNode): EslogSupplier {
  const party = pick(inv, ['AccountingSupplierParty', 'Party'])
    ?? pick(inv, ['SellerSupplierParty', 'Party'])
    ?? deepFind(inv, 'AccountingSupplierParty', 4)

  const partyObj = party && typeof party === 'object' ? (party as XmlNode) : {}

  const name = firstNonEmpty(
    textOf(pick(partyObj, ['PartyName', 'Name'])),
    textOf(pick(partyObj, ['PartyLegalEntity', 'RegistrationName'])),
  )

  // tax id: PartyLegalEntity/CompanyID, then PartyTaxScheme/CompanyID (VAT), then PartyIdentification/ID
  const taxIdRaw = firstNonEmpty(
    textOf(pick(partyObj, ['PartyLegalEntity', 'CompanyID'])),
    textOf(pick(partyObj, ['PartyTaxScheme', 'CompanyID'])),
    textOf(pick(partyObj, ['PartyIdentification', 'ID'])),
  )

  // IBAN: invoice-level PaymentMeans/PayeeFinancialAccount/ID, then party-level fallback
  const ibanRaw = firstNonEmpty(
    textOf(pick(inv, ['PaymentMeans', 'PayeeFinancialAccount', 'ID'])),
    textOf(pick(partyObj, ['PaymentMeans', 'PayeeFinancialAccount', 'ID'])),
  )

  return {
    taxId: digitsOnly(taxIdRaw),
    name,
    iban: ibanRaw.replace(/\s+/g, ''),
  }
}

function linesOf(inv: XmlNode): EslogLine[] {
  // UBL Invoice uses InvoiceLine; CreditNote may use CreditNoteLine — accept both
  const rawLines = [...asArray(inv['InvoiceLine']), ...asArray(inv['CreditNoteLine'])]
  const out: EslogLine[] = []
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object') continue
    const line = raw as XmlNode
    const name = textOf(pick(line, ['Item', 'Name'])) || textOf(deepFind(line, 'Name', 3))
    const qty = numFrom(
      textOf(line['InvoicedQuantity']) || textOf(line['CreditedQuantity']) || textOf(line['Quantity']),
    )
    const unitPrice = numFrom(textOf(pick(line, ['Price', 'PriceAmount'])))
    const vatRate =
      numFrom(textOf(pick(line, ['TaxCategory', 'Percent']))) ||
      numFrom(textOf(pick(line, ['Item', 'ClassifiedTaxCategory', 'Percent']))) ||
      0
    if (!name && !Number.isFinite(qty)) continue
    out.push({
      name,
      quantity: Number.isFinite(qty) ? qty : 0,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      vatRate: Number.isFinite(vatRate) ? vatRate : 0,
    })
  }
  return out
}

function totalsOf(inv: XmlNode): { subtotal: number; vatTotal: number; total: number } {
  const subtotal = numFrom(textOf(pick(inv, ['LegalMonetaryTotal', 'TaxExclusiveAmount'])))
  const totalAlt = numFrom(textOf(pick(inv, ['LegalMonetaryTotal', 'PayableAmount'])))
  const totalAlt2 = numFrom(textOf(pick(inv, ['LegalMonetaryTotal', 'TaxInclusiveAmount'])))
  const total = Number.isFinite(totalAlt) ? totalAlt : totalAlt2

  // vat: root TaxTotal/TaxAmount (first), else sum of TaxSubtotal/TaxAmount
  let vatTotal = numFrom(textOf(pick(inv, ['TaxTotal', 'TaxAmount'])))
  if (!Number.isFinite(vatTotal)) {
    const subtotals = asArray(inv['TaxTotal'])
      .flatMap((tt) => asArray((tt as XmlNode | null)?.['TaxSubtotal']))
    let sum = 0
    let any = false
    for (const st of subtotals) {
      const amt = numFrom(textOf(pick(st, ['TaxAmount'])))
      if (Number.isFinite(amt)) { sum += amt; any = true }
    }
    if (any) vatTotal = sum
  }

  return {
    subtotal: Number.isFinite(subtotal) ? subtotal : NaN,
    vatTotal: Number.isFinite(vatTotal) ? vatTotal : NaN,
    total,
  }
}

/* ─────────── public API ─────────── */

const parserOptions = {
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
} as const

/**
 * Parse an eSLOG 1.6 / 2.0 e-invoice XML string.
 * NEVER throws — malformed XML yields { invoice: null, error }.
 */
export function parseEslog(xml: string): EslogParseResult {
  const raw = String(xml ?? '')
  if (!raw.trim()) return { invoice: null, error: 'Manjka vsebina XML.' }

  let doc: unknown
  try {
    doc = new XMLParser(parserOptions).parse(raw)
  } catch (e) {
    return { invoice: null, error: `XML ni veljaven: ${String((e as Error).message || e).slice(0, 160)}` }
  }
  if (!doc || typeof doc !== 'object') {
    return { invoice: null, error: 'XML ni veljaven (prazen dokument).' }
  }

  const { root, found } = invoiceRoot(doc as XmlNode)
  if (!root) {
    return { invoice: null, error: 'Nepoznana struktura e-računa (pričakovan eSLOG/UBL Invoice).' }
  }

  // invoice number: direct child ID of the invoice root; tolerant fallbacks for wrappers
  const invoiceNumber = firstNonEmpty(
    textOf(root['ID']),
    textOf(pick(root, ['DocumentHeader', 'ID'])),
    textOf(deepFind(root, 'InvoiceNumber', 4)),
  )

  const issueDate = textOf(root['IssueDate'])
  const dueDate = textOf(root['DueDate'])

  const supplier = supplierOf(root)
  const lines = linesOf(root)
  const { subtotal, vatTotal, total } = totalsOf(root)

  if (!invoiceNumber) {
    return { invoice: null, error: 'E-račun nima številke računa (cbc:ID).' }
  }
  const hasMoney = Number.isFinite(total) || Number.isFinite(subtotal) || Number.isFinite(vatTotal) || lines.length > 0
  if (!hasMoney) {
    return { invoice: null, error: 'E-račun nima zneskov niti vrstic.' }
  }

  return {
    invoice: {
      invoiceNumber,
      issueDate,
      dueDate,
      supplier,
      lines,
      subtotal: Number.isFinite(subtotal) ? subtotal : NaN,
      vatTotal: Number.isFinite(vatTotal) ? vatTotal : NaN,
      total: Number.isFinite(total) ? total : NaN,
    },
    error: null,
  }
}
