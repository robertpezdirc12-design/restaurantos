/**
 * Odpad hrane (GitLab issue #1, triage ④) — čista logika (brez DB/IO).
 *
 * Kanonični tok: evidentiranje odpada (artikel + količina + razlog) →
 * StockTransaction type='WASTE' (odtok zaloge) → WasteRecord (ledžer odpada) →
 * reverzija pomote → povratek količine na zalogo (StockTransaction type='ADJUST',
 * pozitiven) + reversalStockTransactionId + reversedAt.
 *
 * Invarianta: WasteRecord.totalCost = quantity × costPerUnit (centno natančno)
 * in enako velja za povezani StockTransaction('WASTE').totalCost — vsota
 * odpada po obdobju je torej seštevljiva brez float drifta.
 *
 * Idempotencija BREZ shematskih sprememb (§18): WasteRecord ima
 * @@unique([locationId, idempotencyKey]) — ponovljen klic z istim
 * (locationId, idempotencyKey) pade na unique omejitev → replay vrne
 * obstoječi zapis (200, replayed=true), zaloga se ne odšteje dvakrat.
 *
 * Pravila:
 * - Odpad > razpoložljive zaloge je ZAVRJEN (zaloga ne sme postati negativna;
 *   razlike med realnim in evidentiranim stanjem popravlja inventura/Popravek
 *   v Zalogah, ne odpad).
 * - Reverzija je dovoljena samo zapisu brez reversedAt in v celoti vrača
 *   originalno količino (enkratna, zaradi unique reversalStockTransactionId).
 * - Razlogi so zaprt kanonični seznam (poročanje po razlogih).
 */

/** Tip StockTransaction pri evidentiranju odpada (konvencija reports/export) */
export const WASTE_TX_TYPE = 'WASTE'

/** Tip povratnega StockTransaction ob reverziji (popravek, pozitiven predznak) */
export const WASTE_REVERSAL_TX_TYPE = 'ADJUST'

/** Kanonični razlogi odpada (zaprt seznam za poročanje) */
export const WASTE_REASONS = [
  'pokvarjeno',
  'preteklo',
  'priprava',
  'razlitje',
  'hlajenje',
  'reklamacija',
  'drugo',
] as const
export type WasteReason = (typeof WASTE_REASONS)[number]

export const WASTE_REASON_LABELS: Record<WasteReason, string> = {
  pokvarjeno: 'Pokvarjeno',
  preteklo: 'Pretekel rok',
  priprava: 'Napaka pri pripravi',
  razlitje: 'Razlitje / padec',
  hlajenje: 'Okvara hladilne verige',
  reklamacija: 'Vrnjena postavka (reklamacija)',
  drugo: 'Drugo',
}

/** Oznaka razloga (neznani razlog → prikaži surovi vnos; prazen → Drugo) */
export function wasteReasonLabel(reason: string): string {
  const key = String(reason || '')
  return WASTE_REASON_LABELS[key as WasteReason] ?? (key || WASTE_REASON_LABELS.drugo)
}

export function isWasteReason(reason: unknown): reason is WasteReason {
  return typeof reason === 'string' && (WASTE_REASONS as readonly string[]).includes(reason)
}

// ── Centna aritmetika (brez float drifta) ────────────────────────────────────

/**
 * Skupni strošek odpada v centih — celoštevilčna aritmetika:
 * količina na 3 decimalki (qMilli) × cena na cent (cCents) / 1000.
 * Primer: 0,333 kg × 6,84 €/kg → 333 × 684 = 227.772 → 228 ct = 2,28 €.
 */
export function wasteTotalCents(quantity: number, costPerUnit: number): number {
  const qMilli = Math.round(quantity * 1000)
  const cCents = Math.round(costPerUnit * 100)
  if (!Number.isFinite(qMilli) || !Number.isFinite(cCents) || qMilli <= 0 || cCents <= 0) return 0
  return Math.round((qMilli * cCents) / 1000)
}

// ── Validacija vnosa ─────────────────────────────────────────────────────────

export interface WasteInput {
  quantity: number
  reason: string
  note?: string
}

export interface ValidatedWasteInput {
  /** količina, zaokrožena na 3 decimalki, > 0 */
  quantity: number
  reason: WasteReason
  /** opranih največ 500 znakov */
  note: string
}

const MAX_QUANTITY = 99999
const MAX_NOTE = 500

/** Zaokroži na 3 decimalki (količine v shemi so Decimal(12,3)) */
const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Validacija vnosa odpada — napake v slovenščini; ok → normalizirana vrednost.
 */
export function validateWasteInput(
  input: unknown,
): { ok: true; value: ValidatedWasteInput } | { ok: false; error: string } {
  const b = (input ?? {}) as Record<string, unknown>
  const rawQ = b.quantity
  const q = typeof rawQ === 'string' ? Number(rawQ.replace(',', '.')) : Number(rawQ)
  if (rawQ === undefined || rawQ === null || rawQ === '' || !Number.isFinite(q)) {
    return { ok: false, error: 'Količina odpada je obvezna.' }
  }
  if (q <= 0) return { ok: false, error: 'Količina odpada mora biti večja od 0.' }
  const qty = r3(q)
  if (qty <= 0) return { ok: false, error: 'Količina odpada mora biti večja od 0.' }
  if (qty > MAX_QUANTITY) return { ok: false, error: `Količina odpada presega dovoljeno mejo (${MAX_QUANTITY}).` }

  const reason = String(b.reason ?? '').trim()
  if (!isWasteReason(reason)) return { ok: false, error: 'Izberi veljaven razlog odpada.' }

  const note = String(b.note ?? '').trim().slice(0, MAX_NOTE)
  return { ok: true, value: { quantity: qty, reason, note } }
}

// ── Reverzija ────────────────────────────────────────────────────────────────

/** Ali je reverzija zapisa dovoljena? (samo še ne-povrnjen zapis) */
export function canReverseWaste(record: {
  reversedAt: Date | string | null
}): { ok: boolean; reason?: string } {
  if (record.reversedAt) return { ok: false, reason: 'Odpad je že povrnjen.' }
  return { ok: true }
}

/** Razlog povratnega StockTransaction ob reverziji */
export function wasteReversalReason(recordId: string): string {
  return `Reverzija odpada (${String(recordId || '').slice(0, 12)})`
}

// ── Statistika (za tab + API) ────────────────────────────────────────────────

export interface WasteStatsRow {
  reason: string
  /** skupni strošek v EUR (iz DB Decimal) */
  totalCost: number
}

export interface WasteReasonStat {
  reason: string
  label: string
  count: number
  totalCents: number
}

export interface WasteStats {
  count: number
  totalCents: number
  byReason: WasteReasonStat[]
  /** razlog z največjim stroškom (ali null, če ni zapisov) */
  topReason: string | null
}

/** Agregacija zapisov odpada: skupaj + razpad po razlogih (padajoče po strošku) */
export function wasteStats(rows: WasteStatsRow[]): WasteStats {
  const acc = new Map<string, { count: number; totalCents: number }>()
  let totalCents = 0
  for (const r of rows ?? []) {
    const key = String(r.reason || 'drugo')
    const cents = Math.round((Number(r.totalCost) || 0) * 100)
    const cur = acc.get(key) ?? { count: 0, totalCents: 0 }
    cur.count += 1
    cur.totalCents += cents
    acc.set(key, cur)
    totalCents += cents
  }
  const byReason: WasteReasonStat[] = [...acc.entries()]
    .map(([reason, v]) => ({ reason, label: wasteReasonLabel(reason), count: v.count, totalCents: v.totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents || b.count - a.count)
  return { count: rows?.length ?? 0, totalCents, byReason, topReason: byReason[0]?.reason ?? null }
}
