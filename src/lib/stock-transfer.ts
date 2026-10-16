/**
 * Issue #8 (P2, v1.116.0) — medlokacijski prenosi zalog: ČISTI MOTOR (brez DB/IO
 * uvozov — vzorec src/lib/payroll.ts / lib/waste.ts).
 *
 * Vsebuje izključno deterministične funkcije, ki jih API rute
 * (src/app/api/transfers/*) in testi klicajo neposredno:
 *  - konstante tipov StockTransaction (TRANSFER_IN/OUT) in statusov,
 *  - validacija vnosa (from≠to, idempotencyKey, vrstice 1..50, količine ≤3
 *    decimalke, cene ≤2 decimalke, BREZ podvojenih artiklov),
 *  - izračun izida prevzema (RECEIVED iff vse prejeto + 0 poškodovano, sicer
 *    PARTIAL z varianco missing/damaged),
 *  - številčenje dokumentov TRF-dan-zaporedna (zrcalo grnNumberFor),
 *  - DTO maperja (transferDto/transferLineDto + variance).
 *
 * Konvencije:
 *  - količine normalizirane na 3 decimalke (r3), denar na 2 (r2) — SQLite REAL
 *    NE sme dobiti float drifta (npr. 22.001000000000005),
 *  - statusi in tipi transakcij so PROSTI nizi (GRN/WasteRecord konvencija),
 *  - ledger ≡ DB: previousQty/newQty izračunata ruti iz svežih branj v TX.
 */
import { num, r2 } from '@/lib/map'

/** Tip StockTransaction ob odpremi (izvorna lokacija, podpisana NEGATIVNO). */
export const TRF_TX_OUT = 'TRANSFER_OUT'
/** Tip StockTransaction ob prevzemu (ciljna lokacija, pozitiven). */
export const TRF_TX_IN = 'TRANSFER_IN'

export const TRF_STATUSES = ['DRAFT', 'DISPATCHED', 'RECEIVED', 'PARTIAL', 'CANCELLED'] as const
export type TrfStatus = (typeof TRF_STATUSES)[number]

/** Terminalna stanja (varianca missing/damaged je dokončna). */
export const TRF_TERMINAL: readonly string[] = ['RECEIVED', 'PARTIAL', 'CANCELLED']

/** Maks. število vrstic na prenos (en varnostni prag proti divjim telom). */
export const TRF_MAX_LINES = 50
/** Maks. dolžina opombe (isti prag kot payroll closeNote / waste note). */
export const TRF_NOTE_MAX = 500
/** idempotencyKey: isti prag kot ops.ts clientOperationId (≥8, ≤64). */
const IDEMPOTENCY_MIN = 8
const IDEMPOTENCY_MAX = 64
/** Epsilon za primerjavo količin (r3 ± 0.0005 — isti prag kot inventory CAS). */
export const TRF_EPS = 0.0005

/** r3 normalizacija količine (waste/route.ts konvencija). */
export const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Kontekstna napaka iz transakcije — status ne 500 (vzorec OrderError). */
export class TransferError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/* ─────────────────────── 1) Validacija vnosa ─────────────────────── */

export interface TrfLineInput {
  inventoryItemId: string
  requestedQty: number
  batchId?: string | null
  lotNumber?: string | null
  expiryDate?: Date | null
  unitCost?: number | null
}

export interface TrfInput {
  fromLocationId: string
  toLocationId: string
  note: string
  idempotencyKey: string | null
  lines: TrfLineInput[]
}

/**
 * Validacija telesa POST /api/transfers. Vrne { error } (slovensko) ali
 * normaliziran vnos: količine r3, cena r2, izrezana niza.
 */
export function validateTransferInput(body: unknown): { value: TrfInput } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Neveljavno telo zahtevka.' }
  const b = body as Record<string, unknown>

  const fromLocationId = typeof b.fromLocationId === 'string' ? b.fromLocationId.trim() : ''
  const toLocationId = typeof b.toLocationId === 'string' ? b.toLocationId.trim() : ''
  if (!fromLocationId) return { error: 'Izvorna lokacija je obvezna.' }
  if (!toLocationId) return { error: 'Ciljna lokacija je obvezna.' }
  if (fromLocationId === toLocationId) {
    return { error: 'Izvorna in ciljna lokacija sta enaki — prenos na isto lokacijo nima smisla.' }
  }

  const note = typeof b.note === 'string' ? b.note.trim().slice(0, TRF_NOTE_MAX) : ''
  if (typeof b.note === 'string' && b.note.trim().length > TRF_NOTE_MAX) {
    return { error: `Opomba je lahko največ ${TRF_NOTE_MAX} znakov.` }
  }

  let idempotencyKey: string | null = null
  if (b.idempotencyKey !== undefined && b.idempotencyKey !== null && b.idempotencyKey !== '') {
    const k = String(b.idempotencyKey).trim()
    if (k.length < IDEMPOTENCY_MIN || k.length > IDEMPOTENCY_MAX) {
      return { error: `IdempotencyKey mora imeti ${IDEMPOTENCY_MIN}–${IDEMPOTENCY_MAX} znakov.` }
    }
    idempotencyKey = k
  }

  if (!Array.isArray(b.lines) || b.lines.length === 0) {
    return { error: 'Prenos potrebuje vsaj eno postavko.' }
  }
  if (b.lines.length > TRF_MAX_LINES) {
    return { error: `Prenos lahko vsebuje največ ${TRF_MAX_LINES} postavk.` }
  }

  const seen = new Set<string>()
  const lines: TrfLineInput[] = []
  for (const raw of b.lines) {
    if (!raw || typeof raw !== 'object') return { error: 'Neveljavna postavka prenosa.' }
    const l = raw as Record<string, unknown>

    const inventoryItemId = typeof l.inventoryItemId === 'string' ? l.inventoryItemId.trim() : ''
    if (!inventoryItemId) return { error: 'Artikel je obvezen pri vsaki postavki.' }
    if (seen.has(inventoryItemId)) return { error: 'Artikel je podvojen v prenosu.' }
    seen.add(inventoryItemId)

    const qty = num(l.requestedQty, NaN)
    if (!Number.isFinite(qty) || qty <= 0) {
      return { error: 'Količina mora biti pozitivno število.' }
    }
    if (qty > 1_000_000) return { error: 'Količina je prevelika.' }
    if (r3(qty) !== qty) return { error: 'Količina lahko ima največ 3 decimalke.' }

    let unitCost: number | null = null
    if (l.unitCost !== undefined && l.unitCost !== null && l.unitCost !== '') {
      const c = num(l.unitCost, NaN)
      if (!Number.isFinite(c) || c < 0) return { error: 'Cena na enoto ne sme biti negativna.' }
      if (r2(c) !== c) return { error: 'Cena na enoto lahko ima največ 2 decimalki.' }
      unitCost = r2(c)
    }

    let expiryDate: Date | null = null
    if (l.expiryDate !== undefined && l.expiryDate !== null && l.expiryDate !== '') {
      const d = new Date(String(l.expiryDate))
      if (isNaN(d.getTime())) return { error: 'Neveljaven datum roka uporabnosti.' }
      expiryDate = d
    }

    const batchId = typeof l.batchId === 'string' && l.batchId.trim() ? l.batchId.trim() : null
    const lotNumber = typeof l.lotNumber === 'string' && l.lotNumber.trim() ? l.lotNumber.trim().slice(0, 120) : null

    lines.push({ inventoryItemId, requestedQty: r3(qty), batchId, lotNumber, expiryDate, unitCost })
  }

  return { value: { fromLocationId, toLocationId, note, idempotencyKey, lines } }
}

/* ─────────────────── 2) Izid prevzema (RECEIVED | PARTIAL) ─────────────────── */

export interface TrfReceiveOutcomeLine {
  dispatchedQty: number
  receivedQty: number
  damagedQty: number
}

export interface TrfReceiveOutcome {
  status: 'RECEIVED' | 'PARTIAL'
  totalMissing: number
  totalDamaged: number
}

/**
 * RECEIVED iff je vsaka postavka prejeta v celoti (received == dispatched) in
 * poškodovano = 0 (z EPS toleranco); sicer PARTIAL. Manjkajoče (missing) in
 * poškodovane količine so zapisane (varianca) — NE knjižene na zalogo.
 */
export function computeReceiveOutcome(lines: TrfReceiveOutcomeLine[]): TrfReceiveOutcome {
  let totalMissing = 0
  let totalDamaged = 0
  let complete = true
  for (const l of lines) {
    const dispatched = r3(num(l.dispatchedQty))
    const received = r3(num(l.receivedQty))
    const damaged = r3(num(l.damagedQty))
    const missing = r3(Math.max(0, dispatched - received - damaged))
    totalMissing = r3(totalMissing + missing)
    totalDamaged = r3(totalDamaged + damaged)
    if (Math.abs(dispatched - received) > TRF_EPS || damaged > TRF_EPS) complete = false
  }
  return { status: complete ? 'RECEIVED' : 'PARTIAL', totalMissing, totalDamaged }
}

/* ─────────────────── 3) Številčenje dokumentov ─────────────────── */

const pad4 = (n: number) => String(n).padStart(4, '0')

/**
 * TRF-YYYYMMDD-0001 — natančno zrcalo grnNumberFor (procurement.ts:35):
 * ČISTI funkciji podamo (datum, zaporedna); štetje istodnevnih prenosov je
 * odgovornost klicatelja (ruta prek db.stockTransfer.count, kot GRN ruta).
 */
export const transferNumberFor = (date: Date, seq: number): string => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  if (!Number.isInteger(seq) || seq < 1) {
    throw new TransferError('Zaporedna številka mora biti pozitivno celo število.')
  }
  return `TRF-${y}${m}${d}-${pad4(seq)}`
}

/* ─────────────────── 4) DTO maperji ─────────────────── */

/** Vrstna oblika, kot jo vrnejo include: { items } poizvedbe. */
export interface TrfRow {
  id: string
  transferNumber: string
  fromLocationId: string
  toLocationId: string
  status: string
  note: string
  idempotencyKey: string | null
  createdById: string | null
  dispatchedById: string | null
  dispatchedAt: Date | null
  receivedById: string | null
  receivedAt: Date | null
  cancelledAt: Date | null
  cancelReason: string
  createdAt: Date
  items?: TrfLineRow[]
  _count?: { items?: number } | Record<string, number>
}

export interface TrfLineRow {
  id: string
  transferId: string
  inventoryItemId: string
  itemName: string
  unit: string
  requestedQty: Date | number | string | { toNumber(): number }
  dispatchedQty: Date | number | string | { toNumber(): number }
  receivedQty: Date | number | string | { toNumber(): number }
  damagedQty: Date | number | string | { toNumber(): number }
  unitCost: Date | number | string | { toNumber(): number } | null
  batchId: string | null
  lotNumber: string | null
  expiryDate: Date | null
  targetItemId: string | null
  note: string
  createdAt: Date
}

export interface TrfLineDto {
  id: string
  inventoryItemId: string
  itemName: string
  unit: string
  requestedQty: number
  dispatchedQty: number
  receivedQty: number
  damagedQty: number
  missingQty: number
  unitCost: number | null
  batchId: string | null
  lotNumber: string | null
  expiryDate: string | null
  targetItemId: string | null
  note: string
}

/** Postavka prenosa → DTO (količine r3, cena r2, missing = dispatched−received−damaged). */
export function transferLineDto(l: TrfLineRow): TrfLineDto {
  const dispatched = r3(num(l.dispatchedQty))
  const received = r3(num(l.receivedQty))
  const damaged = r3(num(l.damagedQty))
  return {
    id: l.id,
    inventoryItemId: l.inventoryItemId,
    itemName: l.itemName || '(izbrisan artikel)',
    unit: l.unit || '',
    requestedQty: r3(num(l.requestedQty)),
    dispatchedQty: dispatched,
    receivedQty: received,
    damagedQty: damaged,
    missingQty: r3(Math.max(0, dispatched - received - damaged)),
    unitCost: l.unitCost == null ? null : r2(num(l.unitCost)),
    batchId: l.batchId,
    lotNumber: l.lotNumber,
    expiryDate: l.expiryDate ? l.expiryDate.toISOString() : null,
    targetItemId: l.targetItemId,
    note: l.note || '',
  }
}

export interface TrfTransferDto {
  id: string
  transferNumber: string
  status: string
  fromLocationId: string
  fromLocationName: string | null
  toLocationId: string
  toLocationName: string | null
  note: string
  createdAt: string
  dispatchedAt: string | null
  receivedAt: string | null
  cancelledAt: string | null
  cancelReason: string
  itemCount: number
  lines?: TrfLineDto[]
  variance?: { missingQty: number; damagedQty: number }
}

/**
 * Prenos → DTO. `names` preslika lokacijska imena (skalarne vezave — ime
 * razreši klicatelj iz Location); `variance` je prisotna SAMO v terminalnih
 * stanjih (RECEIVED/PARTIAL — prejem/poškodba sta dokončna).
 */
export function transferDto(t: TrfRow, names?: { from?: string | null; to?: string | null }): TrfTransferDto {
  const lines = Array.isArray(t.items) ? t.items.map((l) => transferLineDto(l)) : undefined
  const itemCount = lines
    ? lines.length
    : t._count && typeof t._count === 'object' && 'items' in t._count
      ? Number((t._count as { items?: number }).items ?? 0)
      : 0

  const out: TrfTransferDto = {
    id: t.id,
    transferNumber: t.transferNumber,
    status: t.status,
    fromLocationId: t.fromLocationId,
    fromLocationName: names?.from ?? null,
    toLocationId: t.toLocationId,
    toLocationName: names?.to ?? null,
    note: t.note || '',
    createdAt: t.createdAt.toISOString(),
    dispatchedAt: t.dispatchedAt ? t.dispatchedAt.toISOString() : null,
    receivedAt: t.receivedAt ? t.receivedAt.toISOString() : null,
    cancelledAt: t.cancelledAt ? t.cancelledAt.toISOString() : null,
    cancelReason: t.cancelReason || '',
    itemCount,
  }
  if (lines) out.lines = lines
  if (TRF_TERMINAL.includes(t.status) && lines) {
    const outcome = computeReceiveOutcome(
      lines.map((l) => ({ dispatchedQty: l.dispatchedQty, receivedQty: l.receivedQty, damagedQty: l.damagedQty })),
    )
    out.variance = { missingQty: outcome.totalMissing, damagedQty: outcome.totalDamaged }
  }
  return out
}
