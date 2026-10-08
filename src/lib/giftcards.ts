/**
 * Darilne kartice (GitLab issue #1, triage ③) — čista logika (brez DB/IO).
 *
 * Kanonični tok: izdaja (initialBalance) → polnjenje (topup) → unovčenje ob plačilu
 * (Payment.type='giftcard', CAS odbitje stanja) → razpoložljivi saldo.
 *
 * Ledžer invarianta: vsota (podpisanih) zneskov GiftCardTransaction = trenutni saldo.
 * Podpisna konvencija: issue/topup/refund/adjust pozitivno, redeem negativno.
 * Tipi transakcij: issue | topup | redeem | refund | adjust.
 *
 * Idempotencija BREZ shematskih sprememb (§18): determinističen id transakcije
 * `gctx-<hash(giftCardId|clientOperationId)>` → ponovljen klic z istim clientOperationId
 * pade na unique primary key → replay vrne obstoječi zapis (200, replayed).
 * Izdaja kartice: determinističen id kartice `gc-<sha256(clientOperationId)[:24]>`.
 */
import { createHash } from 'crypto'

/** Determinističen id NOVE kartice pri izdaji (idempotenca izdaje prek clientOperationId) */
export function giftCardIssueId(clientOperationId: string): string {
  const h = createHash('sha256')
    .update(`giftcard-issue|${clientOperationId}`)
    .digest('hex')
    .slice(0, 24)
  return `gc-${h}`
}

/** Veljavni tipi transakcij po darilni kartici (podpisani zneski: + priliv, − odtok) */
export const GC_TX_TYPES = ['issue', 'topup', 'redeem', 'refund', 'adjust'] as const
export type GcTxType = (typeof GC_TX_TYPES)[number]

/** Predznak zneska po tipu (ledžer invarianta vsote = saldo) */
export function gcTxSign(type: GcTxType): 1 | -1 {
  return type === 'redeem' ? -1 : 1
}

/** Stanja kartice: active (aktivna), inactive (deaktivirana ročno), exhausted (saldo 0), expired (rok potekel) */
export type GcStatus = 'active' | 'inactive' | 'exhausted' | 'expired'

/**
 * Efektivno stanje kartice: ročna deaktivacija ima prednost, nato rok,
 * nato izčrpan saldo — drugače aktivna. (DB status 'active'/'inactive' je samo ročna zastavica.)
 */
export function effectiveCardStatus(
  dbStatus: string,
  balanceCents: number,
  expiresAt: Date | string | null,
  now: Date = new Date(),
): GcStatus {
  if (String(dbStatus).toLowerCase() === 'inactive') return 'inactive'
  if (expiresAt && new Date(expiresAt).getTime() < now.getTime()) return 'expired'
  if (balanceCents <= 0) return 'exhausted'
  return 'active'
}

export interface GcCardShape {
  cardNumber: string
  status: string
  balanceCents: number
  expiresAt: Date | string | null
}

/** Ali je mogoče z kartico plačati znesek (v centih)? Vrne razlog zavračitve ali null. */
export function canRedeem(
  card: GcCardShape | null,
  amountCents: number,
  now: Date = new Date(),
): { ok: boolean; reason?: string; status?: GcStatus } {
  if (!card) return { ok: false, reason: 'Darilna kartica ne obstaja.', status: undefined }
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, reason: 'Znesek unovčenja mora biti večji od 0.', status: undefined }
  }
  const st = effectiveCardStatus(card.status, card.balanceCents, card.expiresAt, now)
  if (st === 'inactive') return { ok: false, reason: 'Kartica je deaktivirana.', status: st }
  if (st === 'expired') return { ok: false, reason: 'Kartica je pretekla.', status: st }
  if (st === 'exhausted') return { ok: false, reason: 'Kartica nima več preostalega salda.', status: st }
  if (amountCents > card.balanceCents) {
    return {
      ok: false,
      reason: `Na kartici je samo ${(card.balanceCents / 100).toFixed(2)} € — manjka ${((amountCents - card.balanceCents) / 100).toFixed(2)} €.`,
      status: st,
    }
  }
  return { ok: true, status: st }
}

/** Številka kartice: GC-YYYYMMDD-XXXXXX (zaporedna, dnevno okno, retry-varna) */
export function cardNumberFor(seq: number, now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const s = String(Math.max(1, Math.floor(seq))).padStart(6, '0')
  return `GC-${y}${m}${d}-${s}`
}

/** Maskiranje številke za prikaz/audit: GC-20260101-000123 → GC-…0123 */
export function maskCardNumber(cardNumber: string): string {
  const cn = String(cardNumber || '')
  if (cn.length <= 4) return `…${cn}`
  return `GC-…${cn.slice(-4)}`
}

/** Validacija polnjenja (centi): > 0 in ≤ 5.000 € zgornja varovalka */
export const GC_TOPUP_MAX_CENTS = 500_000

export function validateTopUpCents(amountCents: number): string | null {
  if (!Number.isFinite(amountCents) || Math.round(amountCents) !== amountCents) return 'Znesek polnjenja mora biti celo število centov.'
  if (amountCents <= 0) return 'Znesek polnjenja mora biti večji od 0.'
  if (amountCents > GC_TOPUP_MAX_CENTS) return `Največje polnjenje je ${(GC_TOPUP_MAX_CENTS / 100).toFixed(2)} €.`
  return null
}

/** Validacija izdaje: začetni saldo ≥ 0 (0 = kartica brez vrednosti, polni se kasneje), rok v prihodnosti */
export function validateIssueCents(initialCents: number, expiresAt: Date | string | null, now: Date = new Date()): string | null {
  if (!Number.isFinite(initialCents) || Math.round(initialCents) !== initialCents) return 'Začetni saldo mora biti celo število centov.'
  if (initialCents < 0) return 'Začetni saldo ne sme biti negativen.'
  if (initialCents > GC_TOPUP_MAX_CENTS) return `Največji začetni saldo je ${(GC_TOPUP_MAX_CENTS / 100).toFixed(2)} €.`
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return 'Datum veljavnosti mora biti v prihodnosti.'
  return null
}

/**
 * Determinističen id transakcije za idempotenco (brez shematskih sprememb).
 * Ista (kartica, clientOperationId) vedno isti id → unique PK ujame replay.
 */
export function giftCardTxId(giftCardId: string, clientOperationId: string): string {
  // preprost FNV-1a 32-bit + dolžina — dovolj za kolizijo na domeni ene kartice
  const input = `${giftCardId}|${clientOperationId}`
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `gctx-${h.toString(16).padStart(8, '0')}-${input.length.toString(36)}`
}

/** Saldo v centih po transakciji — zaščita pred negativnim stanjem na ledžerju */
export function balanceAfterCents(currentCents: number, type: GcTxType, amountCents: number): number {
  return gcTxSign(type) === 1 ? currentCents + amountCents : currentCents - amountCents
}

/** Normalizacija opombe (ledžer): obreži na 200 znakov */
export function gcNote(note: unknown, fallback = ''): string {
  const s = String(note ?? '').trim()
  return (s || fallback).slice(0, 200)
}
