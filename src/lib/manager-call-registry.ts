/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje iz POS-a: REGISTAR (CLIENT-SAFE, nič importov).
 *
 * Enaka disciplina kot push-events.ts: konstante + čiste funkcije, ki jih potrebujejo
 * TAKO strežnik (rute/servis) kot 'use client' komponente (dialog/kartica) — brez
 * vlečenja @/lib/db v client bundle (lekcija client-bundle-hygiene).
 *
 * Življenjski cikel zahteve (issue #21 §2):
 *   OPEN ──(timeout, brez potrditve)──► ESCALATED ──(timeout)──► ESCALATED (krog 2, 3) …
 *   OPEN/ESCALATED ──(vodja prevzame)──► ACKNOWLEDGED ──► IN_PROGRESS ──► RESOLVED
 *   OPEN/ESCALATED/ACKNOWLEDGED/IN_PROGRESS ──(prekliče prosilec ali vodja)──► CANCELLED
 *
 * Financna odobritev (issue #21 §3) je NAMENOMA IZVEN tega cikla — klic vodje tipe
 * APPROVAL samo ZAHTLEVA pomoč; odobritev poteka prek obstoječega zaščitenega
 * toka (exception-approval/POS popusti). Ta modul ne spreminja finančnega stanja.
 */

/* ─────────────── vrste zahtev ─────────────── */

/** Vrste zahtev (issue #21 §1: jasno razločljive, nastavljive prek settings). */
export const MANAGER_CALL_TYPES = [
  'APPROVAL', // potrebuje odobritev (finančna izjema — odobritev ostane LOČENA)
  'UNHAPPY_GUEST', // pomoč pri nezadovoljnem gostu
  'TABLE_ISSUE', // težava z mizo/naročilom
  'DEVICE', // napaka naprave
  'OTHER', // drugo nujno operativno vprašanje
] as const
export type ManagerCallType = (typeof MANAGER_CALL_TYPES)[number]

export function isManagerCallType(v: unknown): v is ManagerCallType {
  return typeof v === 'string' && (MANAGER_CALL_TYPES as readonly string[]).includes(v)
}

/* ─────────────── statusi ─────────────── */

export const MANAGER_CALL_STATUSES = [
  'OPEN', // ustvarjena, nihče je ni prevzel
  'ESCALATED', // zapadla brez potrditve — eskalirana (krogi, max 3)
  'ACKNOWLEDGED', // vodja prevzel odgovornost
  'IN_PROGRESS', // v obdelavi
  'RESOLVED', // rešena (terminal)
  'CANCELLED', // preklicana (terminal)
] as const
export type ManagerCallStatus = (typeof MANAGER_CALL_STATUSES)[number]

/** Aktivni (neprevzeti/v obdelavi) statusi — pogled "odprti klici". */
export const MANAGER_CALL_ACTIVE_STATUSES: readonly ManagerCallStatus[] = ['OPEN', 'ESCALATED', 'ACKNOWLEDGED', 'IN_PROGRESS']
/** Terminalni statusi — ničenh prehodov več. */
export const MANAGER_CALL_TERMINAL_STATUSES: readonly ManagerCallStatus[] = ['RESOLVED', 'CANCELLED']

/* ─────────────── akcije (PATCH) ─────────────── */

export const MANAGER_CALL_ACTIONS = ['ack', 'progress', 'resolve', 'cancel'] as const
export type ManagerCallAction = (typeof MANAGER_CALL_ACTIONS)[number]

export function isManagerCallAction(v: unknown): v is ManagerCallAction {
  return typeof v === 'string' && (MANAGER_CALL_ACTIONS as readonly string[]).includes(v)
}

/** Veljavni prehodi po akciji (en vir resnice za ruto in teste). */
const TRANSITIONS: Record<ManagerCallAction, readonly ManagerCallStatus[]> = {
  ack: ['OPEN', 'ESCALATED'],
  progress: ['ACKNOWLEDGED'],
  resolve: ['OPEN', 'ESCALATED', 'ACKNOWLEDGED', 'IN_PROGRESS'],
  cancel: ['OPEN', 'ESCALATED', 'ACKNOWLEDGED', 'IN_PROGRESS'],
}

/** Ali je prehod (akcija, iz statusa) veljaven glede na zgornjo tabelo. */
export function canTransition(action: ManagerCallAction, from: string): boolean {
  const allowed = TRANSITIONS[action]
  return !!allowed && (allowed as readonly string[]).includes(from)
}

/* ─────────────── nastavitve ─────────────── */

export interface ManagerCallSettings {
  /** minute brez potrditve pred eskalacijo (1–60) */
  ackTimeoutMinutes: number
  /** dovoljene vrste zahtev v UI (neprazen pod nabor MANAGER_CALL_TYPES) */
  allowedTypes: ManagerCallType[]
}

export const DEFAULT_ACK_TIMEOUT_MINUTES = 5
export const MAX_ACK_TIMEOUT_MINUTES = 60
export const MIN_ACK_TIMEOUT_MINUTES = 1
/** Zgornja meja eskalacijsnih krogov — "ne pošiljaj neomejene množine push obvestil" (issue §2). */
export const MANAGER_CALL_MAX_ESCALATION_ROUNDS = 3
/** Okno deduplikacije podvojenega klika (ms). */
export const MANAGER_CALL_DEDUP_WINDOW_MS = 60_000
/** Max dolžina opombe prosilca / zapisa razrešitve. */
export const MANAGER_CALL_NOTE_MAX = 300

/**
 * Normalizacija shranjenih/poslanih nastavitev — VEDNO vrne veljaven objekt
 * (fail-safe privzetki; issue: nastavljivost prek obstoječih vzorcev, ne hardcode).
 */
export function parseManagerCallSettings(raw: unknown): ManagerCallSettings {
  const src = (raw ?? {}) as { ackTimeoutMinutes?: unknown; allowedTypes?: unknown }
  const t = Number(src.ackTimeoutMinutes)
  const ackTimeoutMinutes =
    Number.isFinite(t) && t >= MIN_ACK_TIMEOUT_MINUTES && t <= MAX_ACK_TIMEOUT_MINUTES
      ? Math.floor(t)
      : DEFAULT_ACK_TIMEOUT_MINUTES
  const types = Array.isArray(src.allowedTypes) ? src.allowedTypes.filter(isManagerCallType) : []
  const allowedTypes = types.length > 0 ? types : [...MANAGER_CALL_TYPES]
  return { ackTimeoutMinutes, allowedTypes }
}

/* ─────────────── čista eskalacijska logika ─────────────── */

export interface EscalationCandidate {
  status: string
  acknowledgedAt: Date | null
  escalatedCount: number
  lastEscalatedAt: Date | null
  createdAt: Date
}

/**
 * Ali kandidat ZDAJ potrebuje eskalacijski krog (čista funkcija — testabilna):
 *  - samo NEPREVzeti klici (OPEN/ESCALATED, acknowledgedAt null);
 *  - starost ≥ ackTimeoutMinutes od ustvarjanja (prvi krog);
 *  - ponovni krog šele ackTimeoutMinutes po zadnji eskalaciji;
 *  - največ MANAGER_CALL_MAX_ESCALATION_ROUNDS krogov (omejena množica pushov).
 */
export function needsEscalation(c: EscalationCandidate, now: Date, ackTimeoutMinutes: number): boolean {
  if (c.acknowledgedAt !== null) return false
  if (c.status !== 'OPEN' && c.status !== 'ESCALATED') return false
  if (c.escalatedCount >= MANAGER_CALL_MAX_ESCALATION_ROUNDS) return false
  const timeoutMs = Math.max(1, ackTimeoutMinutes) * 60_000
  if (now.getTime() - c.createdAt.getTime() < timeoutMs) return false
  const since = c.lastEscalatedAt ?? c.createdAt
  return now.getTime() - since.getTime() >= timeoutMs
}

/**
 * Ali je obstoječi ODPRti klic prosilca iste vrste na isti lokaciji "svež"
 * (≤ dedup okno) → POST vrne obstoječega z replayed:true namesto dvojnika.
 * Ne zavrne tiho: odgovor nosi obstoječi klic + zastavico (issue §2).
 */
export function isReplayCandidate(
  call: { requestorId: string; type: string; locationId: string; status: string; acknowledgedAt: Date | null; createdAt: Date },
  candidate: { requestorId: string; type: string; locationId: string },
  now: Date,
): boolean {
  if (call.requestorId !== candidate.requestorId) return false
  if (call.type !== candidate.type) return false
  if (call.locationId !== candidate.locationId) return false
  if (call.status !== 'OPEN' && call.status !== 'ESCALATED') return false
  if (call.acknowledgedAt !== null) return false
  return now.getTime() - call.createdAt.getTime() <= MANAGER_CALL_DEDUP_WINDOW_MS
}

/** Slovenski oznaki vrste za push predogled (ista konvencija kot ostali pushi — SL). */
export const MANAGER_CALL_TYPE_LABELS_SL: Record<ManagerCallType, string> = {
  APPROVAL: 'Prošnja za odobritev',
  UNHAPPY_GUEST: 'Nezadovoljen gost',
  TABLE_ISSUE: 'Težava z mizo/naročilom',
  DEVICE: 'Napaka naprave',
  OTHER: 'Nujna pomoč',
}
