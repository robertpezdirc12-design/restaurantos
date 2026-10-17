/**
 * Issue #4 (P1, v1.125.0) — življenjski cikel odhodnga B2B e-računa (EInvoiceOutbox).
 *
 * ČISTI MODUL (brez DB): definira kanonične statuse izmenjave in prehode.
 * Status `sent` NE pomeni `delivered`/`accepted`/`paid` (issue §P1-A) — vsak
 * prehod ima svoj revizijski dogodek (AuditLog veriga, zapis v rutah).
 *
 * Pravila:
 *  - forward-only: dokument NIKOLI ne gre nazaj po verigi, razen izrecnih
 *    retry prehodov (failed/rejected/needs_review → queued), ki so vedno
 *    IZRECNA uporabniška/adapter odločitev (retry sme biti samo varen —
 *    vrnitev v queued pomeni ponovno pošiljanje Z ISTIM idempotencyKey);
 *  - terminala (accepted/rejected) NE greta nikamor več — so končna stanja
 *    izmenjave (plačilo/status AR vodimo ločeno);
 *  - isti status = idempotenten no-op (applyTransition vrne ok:true, next=enak);
 *  - applyTransition je PURE — brez IO; klicatelj (rute) zapiše audit dogodek.
 */

export const EINVOICE_STATUSES = [
  'draft',
  'validated',
  'queued',
  'sent',
  'delivered',
  'accepted',
  'rejected',
  'failed',
  'needs_review',
] as const

export type EInvoiceStatus = (typeof EINVOICE_STATUSES)[number]

/** Končni statusi izmenjave — nazaj NI več poti (issue §P1-A). */
export const EINVOICE_TERMINAL: readonly EInvoiceStatus[] = ['accepted', 'rejected']

/** Statusi, iz katerih je (varen) retry nazaj v queued dovoljen. */
export const EINVOICE_RETRYABLE: readonly EInvoiceStatus[] = ['failed', 'rejected', 'needs_review']

/**
 * Legalni prehodi (forward-only + retry nazaj v queued):
 *  draft → validated
 *  validated → queued
 *  queued → sent | failed
 *  sent → delivered | rejected | failed | needs_review
 *  delivered → accepted | rejected | needs_review
 *  failed → queued (retry — ISTI idempotencyKey, adapter odloči o varnosti)
 *  rejected → queued (retry — izrecna odločitev; adapter preveri pri ponudniku)
 *  needs_review → queued (ročna razrešitev po pregledu)
 */
const TRANSITIONS: Record<EInvoiceStatus, readonly EInvoiceStatus[]> = {
  draft: ['validated'],
  validated: ['queued'],
  queued: ['sent', 'failed'],
  sent: ['delivered', 'rejected', 'failed', 'needs_review'],
  delivered: ['accepted', 'rejected', 'needs_review'],
  accepted: [],
  rejected: ['queued'],
  failed: ['queued'],
  needs_review: ['queued'],
}

/** Je prehod from→to dovoljen? (ista vrednost = idempotenten no-op → true) */
export function canTransition(from: string, to: string): boolean {
  if (from === to) return true
  const legal = TRANSITIONS[from as EInvoiceStatus]
  if (!legal) return false
  return legal.includes(to as EInvoiceStatus)
}

export interface TransitionResult {
  ok: boolean
  next: string
}

/**
 * Pure apliciranje prehoda: terminala NIKOLI ne nazaj; neznan status → zavrnjen;
 * no-op (from === to) → ok:true, next = from (klicatelj ga mirno ignorira).
 *
 * 'accepted' je TRDNO terminal (ni izhodnih poteh). 'rejected' je terminal ZA
 * WEBHOOK (webhook rute ga ločeno blokirajo prek EINVOICE_TERMINAL — statusni
 * dogodki prejemnika NE requeue-ajo), IZRECNA uporabniška retry pot
 * (rejected → queued, EINVOICE_RETRYABLE) pa je legalen enkorakov prehod —
 * vanjo se izvede SAMO send/retry ruta s predhodno preverbo pri ponudniku.
 */
export function applyTransition(current: string, desired: string): TransitionResult {
  if (!EINVOICE_STATUSES.includes(desired as EInvoiceStatus)) {
    return { ok: false, next: current }
  }
  if (current === desired) {
    return { ok: true, next: current }
  }
  if (current === 'accepted') {
    // trdni terminal NE gre nikamor več (niti v drug terminal)
    return { ok: false, next: current }
  }
  if (canTransition(current, desired)) {
    return { ok: true, next: desired }
  }
  return { ok: false, next: current }
}

/** Ali je status dovoljen za (ponovno) pošiljanje? (send izvestvena vrata) */
export function isSendableStatus(status: string): boolean {
  return ['draft', 'validated', 'failed', 'rejected', 'needs_review'].includes(status)
}

/**
 * Naprej-only POT od `from` do `to` (BFS po legalnih prehodih) — za večkorakov
 * prehode v enem dejanju (npr. send: draft→validated→queued→sent; webhook
 * accepted ob sent: sent→delivered→accepted). Terminala so brez izhodnih
 * povezav → null (nikoli nazaj). Vrne seznam vključno s from/to, ali null,
 * če pot ne obstaja.
 */
export function resolveStatusPath(from: string, to: string): string[] | null {
  if (from === to) return [from]
  if (!EINVOICE_STATUSES.includes(from as EInvoiceStatus)) return null
  if (!EINVOICE_STATUSES.includes(to as EInvoiceStatus)) return null
  // BFS — graf je acikličen razen retry luči nazaj v queued (forward-only iskanje
  // ne sledi retry povezavam nazaj, zato cikli niso problematični)
  const queue: string[][] = [[from]]
  const seen = new Set<string>([from])
  while (queue.length > 0) {
    const path = queue.shift()!
    const last = path[path.length - 1]
    if (last === to) return path
    for (const next of TRANSITIONS[last as EInvoiceStatus] ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push([...path, next])
    }
  }
  return null
}
