/**
 * Issue #1 (triage ②) — nabava + prevzem: čista logika (brez DB).
 *
 * Kanonični tok (triage komentar na #1, §9):
 *   dobavitelj → nabavno naročilo → prevzem → zaloga → receptura → prodaja
 *   → avtomatsko razknjiževanje → strošek → marža/poročilo.
 *
 * Ta modul pokriva nabavni del toka:
 *  - številčenje (PO / GRN),
 *  - statusne prehode naročila (osnutek → oddaja → odobritev → dobava),
 *  - TOČNE vsote v centih (integer aritmetika — nič centov ne izgine),
 *  - primerjavo naročene in prejete količine (delna/popolna dobava, over-receipt),
 *  - uteženo povprečno nabavno ceno (vpliv prevzema na vrednost zaloge),
 *  - izgradnjo vrstic zgodovine nabavnih cen (SupplierPriceHistory).
 *
 * §18: dopolnitve brez podvajanja — obstoječi tokovi (Order/Payment/FURS) se ne
 * spreminjajo; količine so v ENOTAH ARTIKLA (InventoryItem.unit), pakiranje
 * (packQty/packUnit) je informativno in se ne pretvarja implicitno.
 */

/* ────────────────────────── številčenje ────────────────────────── */

const pad4 = (n: number) => String(n).padStart(4, '0')

/** Dobavni termin prevzema — datum v LOCAL času poslovanja (ne UTC), npr. PO-20261008-0001 */
function docNumber(prefix: string, date: Date, seq: number): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  if (!Number.isInteger(seq) || seq < 1) throw new Error('Zaporedna številka mora biti pozitivno celo število.')
  return `${prefix}-${y}${m}${d}-${pad4(seq)}`
}

export const poNumberFor = (date: Date, seq: number) => docNumber('PO', date, seq)
export const grnNumberFor = (date: Date, seq: number) => docNumber('GRN', date, seq)

/* ────────────────────── statusni prehodi PO ────────────────────── */

export const PO_STATUSES = ['draft', 'submitted', 'approved', 'partial', 'received', 'cancelled'] as const
export type PoStatus = (typeof PO_STATUSES)[number]

/**
 * Dovoljeni prehodi (triage: osnutek/oddaja/odobritev + delna/popolna dobava):
 *   draft → submitted | cancelled
 *   submitted → approved | cancelled
 *   approved → partial | received | cancelled
 *   partial → partial (naslednji delni prevzem) | received | cancelled
 *   received, cancelled → terminalna (brez prehodov)
 */
const PO_TRANSITIONS: Record<PoStatus, readonly PoStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['approved', 'cancelled'],
  approved: ['partial', 'received', 'cancelled'],
  partial: ['partial', 'received', 'cancelled'],
  received: [],
  cancelled: [],
}

export function canTransition(from: PoStatus, to: PoStatus): boolean {
  return (PO_TRANSITIONS[from] ?? []).includes(to)
}

/* ───────────────────── točne vsote v centih ───────────────────── */

/** Količina → tisočinke (integer). Zaščita pred float driftom (0.1 + 0.2). */
export function qtyToMilli(q: number): number {
  const v = Math.round(Number(q) * 1000)
  if (!Number.isFinite(v)) throw new Error('Količina mora biti število.')
  return v
}

/** Neto vrstice v centih: količina (enote artikla) × cena na enoto (centi). */
export function lineNetCents(quantity: number, unitPriceCents: number): number {
  if (unitPriceCents < 0 || !Number.isInteger(unitPriceCents)) throw new Error('Cena mora biti ne-negativni celoštevilčni znesek v centih.')
  return Math.round((qtyToMilli(quantity) * unitPriceCents) / 1000)
}

export interface PoLineInput {
  quantity: number
  unitPriceCents: number
  vatRate?: number | null // ODD% (npr. 22 ali 9.5)
}

export interface LineTotalsCents {
  netCents: number
  vatCents: number
  totalCents: number
}

/** DDV po vrstici (standard za nabavne dokumente), zaokroženo na cent. */
export function computeLineCents(line: PoLineInput): LineTotalsCents {
  const vatRate = line.vatRate == null ? 22 : Number(line.vatRate)
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 30) throw new Error('DDV stopnja mora biti med 0 in 30 %.')
  const netCents = lineNetCents(line.quantity, line.unitPriceCents)
  const vatCents = Math.round((netCents * vatRate) / 100)
  return { netCents, vatCents, totalCents: netCents + vatCents }
}

export interface PoTotalsCents {
  subtotalCents: number
  vatCents: number
  totalCents: number
}

/** Vsota po vrsticah — vsota je TOČNO vsota vrstic (brez ponovnega zaokrožanja skupka). */
export function computeTotalsCents(lines: PoLineInput[]): PoTotalsCents {
  let subtotalCents = 0
  let vatCents = 0
  for (const l of lines) {
    const t = computeLineCents(l)
    subtotalCents += t.netCents
    vatCents += t.vatCents
  }
  return { subtotalCents, vatCents, totalCents: subtotalCents + vatCents }
}

/* ─────────────── prevzem: primerjava naročeno/prejeto ─────────────── */

export interface PoItemState {
  id: string
  description: string
  /** naročena količina (enote artikla) */
  quantityOrdered: number
  /** doslej prejeto (sprejeto) — iz DB quantityReceived */
  quantityReceivedSoFar: number
}

export interface ReceiveLineInput {
  purchaseOrderItemId: string
  quantityAccepted: number
  quantityRejected: number
  rejectReason?: string
}

export interface ReceiveValidation {
  errors: string[]
  warnings: string[]
  /** izravnane vrstice za prevzem: količine v tisočinkah za natančno primerjavo */
  lines: { input: ReceiveLineInput; index: number; orderedMilli: number; receivedSoFarMilli: number; overReceipt: boolean }[]
  hasAccepted: boolean
  overReceipt: boolean
}

/**
 * Validacija prevzemne vrstice glede na naročne postavke (triage: primerjava
 * naročene in prejete količine). Pravila:
 *  - neznana postavka / negativne količine / vse vrstice prazne → NAPAKA
 *  - zavrnjena količina BREZ razloga → NAPAKA (evidenca vedno z razlogom)
 *  - prejem nad naročeno količino (over-receipt) → OPOZORILO (dovoljen, označen v auditu)
 */
export function validateReceiveLines(items: PoItemState[], lines: ReceiveLineInput[]): ReceiveValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const byId = new Map(items.map((i) => [i.id, i]))
  const out: ReceiveValidation['lines'] = []
  let hasAccepted = false

  if (!Array.isArray(lines) || lines.length === 0) errors.push('Prevzem brez vrstic ni mogoč.')

  const seen = new Set<string>()
  lines?.forEach((l, index) => {
    const item = byId.get(l.purchaseOrderItemId)
    if (!item) {
      errors.push(`Vrstica ${index + 1}: neznana postavka naročila (${l.purchaseOrderItemId}).`)
      return
    }
    if (seen.has(l.purchaseOrderItemId)) errors.push(`Vrstica ${index + 1}: postavka "${item.description}" je navedena dvakrat.`)
    seen.add(l.purchaseOrderItemId)

    const acc = Number(l.quantityAccepted) || 0
    const rej = Number(l.quantityRejected) || 0
    if (acc < 0 || rej < 0) {
      errors.push(`Vrstica ${index + 1}: količini ne smeta biti negativni.`)
      return
    }
    if (!Number.isFinite(acc) || !Number.isFinite(rej)) {
      errors.push(`Vrstica ${index + 1}: količini morata biti števili.`)
      return
    }
    if (rej > 0 && !String(l.rejectReason || '').trim()) {
      errors.push(`Vrstica ${index + 1}: za zavrnjeno količino je razlog obvezen.`)
      return
    }
    if (acc > 0) hasAccepted = true

    const orderedMilli = qtyToMilli(item.quantityOrdered)
    const receivedSoFarMilli = qtyToMilli(item.quantityReceivedSoFar)
    const over = qtyToMilli(acc) + receivedSoFarMilli > orderedMilli
    if (over) warnings.push(`Vrstica ${index + 1}: prejeta količina nad naročeno (${item.quantityReceivedSoFar + acc} / ${item.quantityOrdered} ${'—'} prekomerni prevzem bo označen v auditu).`)

    out.push({ input: { ...l, quantityAccepted: acc, quantityRejected: rej }, index, orderedMilli, receivedSoFarMilli, overReceipt: over })
  })

  if (!errors.length && !hasAccepted) errors.push('Vsaj ena vrstica mora imeti sprejeto količino (samo zavrnitve brez sprejema niso prevzem).')

  return { errors, warnings, lines: out, hasAccepted, overReceipt: warnings.length > 0 }
}

/** Status postavke po prevzemu: obravnavana količina = sprejeto + zavrnjeno. */
export function itemStatusAfter(quantityOrdered: number, receivedSoFar: number, accepted: number, rejected: number): 'pending' | 'partial' | 'received' {
  const handledMilli = qtyToMilli(receivedSoFar) + qtyToMilli(accepted) + qtyToMilli(rejected)
  if (handledMilli <= 0) return 'pending'
  return handledMilli >= qtyToMilli(quantityOrdered) ? 'received' : 'partial'
}

/** Status naročila po prevzemu na podlagi statusov postavk. */
export function poStatusAfter(itemStatuses: ('pending' | 'partial' | 'received')[]): Extract<PoStatus, 'partial' | 'received'> {
  if (itemStatuses.length > 0 && itemStatuses.every((s) => s === 'received')) return 'received'
  return 'partial'
}

/* ─────────────────── vpliv prevzema na zalogo ─────────────────── */

/**
 * Uteženo povprečna nabavna cena (centi): obstoječa vrednost + vrednost prevzema,
 * deljeno s skupno količino. Na prazno zalogo se uporabi cena prevzema.
 */
export function weightedAvgCostCents(oldQty: number, oldCostCents: number, addQty: number, addCostCents: number): number {
  const oldM = qtyToMilli(oldQty)
  const addM = qtyToMilli(addQty)
  if (addM <= 0) return Math.round(oldCostCents)
  if (oldM <= 0) return Math.round(addCostCents)
  const totalValue = oldM * oldCostCents + addM * addCostCents
  return Math.round(totalValue / (oldM + addM))
}

/* ────────────────── zgodovina nabavnih cen ────────────────── */

export interface PriceHistoryRow {
  supplierId: string
  inventoryItemId: string
  unitPrice: number
  vatRate: number | null
  unit: string
  source: 'goods_receipt'
  purchaseOrderId: string
  locationId: string | null
  observedAt: Date
}

/**
 * Vrstice za SupplierPriceHistory iz prevzemnih vrstic (triage: zgodovina
 * nabavnih cen). Samo sprejete količine na artiklih z inventarno povezavo —
 * brez podvajanja (ena cena na sprejeto postavko na prevzem).
 */
export function priceHistoryRows(args: {
  supplierId: string
  purchaseOrderId: string
  locationId: string | null
  observedAt: Date
  lines: { inventoryItemId?: string | null; quantityAccepted: number; unitPrice: number; unit?: string; vatRate?: number | null }[]
}): PriceHistoryRow[] {
  const rows: PriceHistoryRow[] = []
  for (const l of args.lines) {
    if (!l.inventoryItemId) continue
    if (qtyToMilli(l.quantityAccepted) <= 0) continue
    rows.push({
      supplierId: args.supplierId,
      inventoryItemId: l.inventoryItemId,
      unitPrice: l.unitPrice,
      vatRate: l.vatRate ?? null,
      unit: l.unit || 'pcs',
      source: 'goods_receipt',
      purchaseOrderId: args.purchaseOrderId,
      locationId: args.locationId,
      observedAt: args.observedAt,
    })
  }
  return rows
}

/* ─────────── OPS-8 val 2 (v1.72.0) — PO→AccountsPayable bridge helpers ─────────── */

/**
 * Parse supplier payment terms ("30 dni", "14 days", "net 45") → days as integer.
 * First integer found wins; invalid / missing → default 30 (market standard).
 */
export function parsePaymentTermsDays(terms: unknown, fallback = 30): number {
  const s = String(terms ?? '').trim()
  if (!s) return fallback
  const m = s.match(/\d+/)
  if (!m) return fallback
  const days = parseInt(m[0], 10)
  return Number.isFinite(days) && days > 0 && days <= 365 ? days : fallback
}

/** AP number: AP-<year>-<NNNN> (count-based sequence, unique retry at call site). */
export function apNumberFor(year: number, seq: number): string {
  return `AP-${year}-${String(Math.max(1, seq)).padStart(4, '0')}`
}

/** Gross line total (net + VAT), 2 decimals — AP lines sum to totalAmount. */
export function apLineTotalGross(quantity: number, unitPrice: number, vatRate: number): number {
  return Math.round(quantity * unitPrice * (1 + (Number.isFinite(vatRate) ? vatRate : 0) / 100) * 100) / 100
}
