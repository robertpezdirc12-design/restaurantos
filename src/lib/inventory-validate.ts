/**
 * Issue #58 (P1) — skupna STREŽNIŠKA validacija količin/cen inventarja.
 * POST in PATCH /api/inventory uporabljata ISTE funkcije, da ni mogoče
 * ustvariti vrednosti po eni poti in jih drugače interpretirati po drugi.
 *
 * Dokumentirana pravila (izhajajo iz shemskih meja Prisma Decimal):
 *  - količine (qty/minQty/setQty/delta): Decimal(12,3) → normalizacija na
 *    3 decimalki (r3 — enako kot ledger StockTransaction povsod);
 *  - cene (cost): Decimal(12,2) → normalizacija na 2 decimalki (r2);
 *  - neveljaven vhod (NaN / ±Infinity / neštevilski niz / boolean / objekt)
 *    → ZAVRNJEN — NIKOLI se ne pretvori tiho v 0;
 *  - negativne vrednosti → ZAVRJENE (količina/minQty/cena; delta je izjema —
 *    negativen delta je dovoljen odjem zaloge);
 *  - zgornja meja |vrednosti|: 99.999 (konzervativna pos-meja, skladna z
 *    waste MAX_QUANTITY) — zavrne "pretirano velike" vnose (1e12 …);
 *  - vhodna oblika: number ali niz z ENO decimalno vejico ali piko ("1,5").
 *
 * Politika začetnega stanja (opening balance) — glej POST /api/inventory:
 * qty > 0 ob ustvarjanju se evidentira kot EKSPliciten StockTransaction
 * (type='RECEIVE', reason "Začetno stanje (ročni vnos)") — NI predstavljen
 * kot GoodsReceipt/dobaviteljev prevzem in nima serijske sledljivosti
 * (brez InventoryBatch — za serije uporabi nabavo/GRN tok).
 */

const MAX_QTY = 99_999
const MAX_COST = 99_999

const r3 = (n: number) => Math.round(n * 1000) / 1000
const r2 = (n: number) => Math.round(n * 100) / 100

export interface ParsedNum {
  /** absent = polje ni podano (undefined/null/prazen niz) → POST privzame 0 */
  state: 'absent' | 'invalid' | 'value'
  value: number
}

/** Preberi številski vhod: number ali niz ("1,5"→1.5); ostalo je neveljavno. */
export function parseNumInput(raw: unknown): ParsedNum {
  if (raw === undefined || raw === null) return { state: 'absent', value: 0 }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return { state: 'absent', value: 0 }
    // več ločil ("1.5.5") ali "abc" → NaN; "Infinity"/"1e309" → ±Infinity → neveljavno
    const n = Number(s.replace(',', '.'))
    if (!Number.isFinite(n)) return { state: 'invalid', value: 0 }
    return { state: 'value', value: n }
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { state: 'invalid', value: 0 }
    return { state: 'value', value: raw }
  }
  // boolean / objekt / array — ne številsko
  return { state: 'invalid', value: 0 }
}

export interface FieldOpts {
  /** delta sme biti negativna (odjem); ostala polja ne */
  allowNegative?: boolean
  /** cena: 2 decimalki + MAX_COST; sicer 3 decimalki + MAX_QTY */
  isCost?: boolean
}

/**
 * Validacija enega številskega polja.
 * Vrne { ok, value: null } kadar polje ni podano (POST gaprivzame na 0,
 * PATCH ga preskoči), { ok, value } z normalizirano vrednostijo ali napako.
 */
export function parseInventoryField(
  raw: unknown,
  label: string,
  opts: FieldOpts = {}
): { ok: true; value: number | null } | { ok: false; error: string } {
  const p = parseNumInput(raw)
  if (p.state === 'absent') return { ok: true, value: null }
  if (p.state === 'invalid') {
    return { ok: false, error: `${label} ni veljavno število (dovoljena oblika: 1,5 ali 1.5).` }
  }
  const v = p.value
  if (!opts.allowNegative && v < 0) {
    return { ok: false, error: `${label} ne sme biti negativna.` }
  }
  const limit = opts.isCost ? MAX_COST : MAX_QTY
  if (Math.abs(v) > limit) {
    return { ok: false, error: `${label} presega dovoljeno mejo (${limit}).` }
  }
  const norm = opts.isCost ? r2(v) : r3(v)
  if (opts.allowNegative && norm === 0 && v !== 0) {
    return { ok: false, error: `${label} je premajhna vrednost (pod natančnostjo 0,001).` }
  }
  return { ok: true, value: norm }
}

/** Normalizacija merske enote: trim, max 16 znakov, privzeto 'pcs'. */
export function sanitizeUnit(raw: unknown): string {
  const s = String(raw ?? '').trim()
  return s ? s.slice(0, 16) : 'pcs'
}

/** r3/r2 izvoza za rute (konzistentna natančnost z ledgerjem). */
export const roundQty3 = r3
export const roundCost2 = r2
