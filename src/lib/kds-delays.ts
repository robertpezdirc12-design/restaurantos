/**
 * OPS-9 val 3 (v1.76.0) — KDS delay reasons at bump time (Lightspeed/POSMena KDS pattern).
 *
 * When a LATE kitchen item (live prep timer > KDS_DELAY_THRESHOLD_MIN minutes) is bumped
 * to READY, the KDS asks the cook for a delay reason. The reason is stored as an AuditLog
 * row (action KDS_DELAY, details JSON) — ZERO DDL: AuditLog.details already exists.
 *
 * This module is PURE (no DB imports) so the client can share the same threshold decision
 * and the server can validate incoming reasons:
 *  - client: shouldAskDelayReason(itemAgeMin) decides whether the reason dialog opens;
 *  - server: /api/kitchen PATCH validates body.delayReason with isValidDelayReason and
 *    writes the KDS_DELAY audit entry (non-blocking, never fails the bump);
 *  - stats: kdsDelayCounts (in kds-stats.ts) aggregates the catalog reasons from AuditLog.
 *
 * OPS-11 val 1 (v1.80.0): the "late" threshold became PER STATION —
 *  - delayThresholdForTarget(target) = max(10, ceil(target × 1.25)) from PrepStation.avgPrepTime;
 *  - isLatePrep(prepMin, target?) resolves the threshold (no target → the global 10 min,
 *    identical to the historical decision, so existing callers keep their behavior);
 *  - kdsDelayDetails records the threshold AT BUMP TIME in the audit details (additive key).
 */

/** Late threshold in minutes — mirrors the KDS board escalation (> 10 min = red/late). */
export const KDS_DELAY_THRESHOLD_MIN = 10

/**
 * Issue #70 §2 (P1, v1.121.0): STALE ticket threshold — 8 ur (480 min).
 *
 * Živi demo v produkciji je pokazal listke s starostjo ~13.413 min (~9,3 dni) in
 * ~2.343 min (~1,6 dneva) na VRHU kuhinjske vrste (strežnik vrača createdAt ASC,
 * torej najstarejši prvi). Vsaka realna izmena gostinskega obrata je krajša od 8 h,
 * zato je listek, starejši od 8 h, ZAGOTovo iz prejšnje izmene ali iz demo/testnih
 * podatkov — ne iz trenutne obratovalne vrste.
 *
 * Semantika (izbor "a" iz issue #70): zastareli listki NE izginejo (vidni za revizijo)
 * in ostanejo operabilni (kuhinja jih lahko zaključi), a so:
 *  - prikazani na KONCU vrste (ne preglasijo prioritete aktivnih naročil),
 *  - vizualno ločeni (sivi/črtkani listek + oznaka ZASTARELO + starost v urah,
 *    ne v minutah — "225 h" namesto "13.496 min"),
 *  - izključeni iz aktivne vrste v smislu zaporedja/prioritete (vliv na vrstni red).
 *
 * 0 DDL: odločitev je čisto v prikazu/preslikavi; podatki naročil ostanejo nedotaknjeni
 * (issue #70: "ne popravljati produkcijskih koordinat ročno" — enako za stanja naročil).
 */
export const KDS_STALE_THRESHOLD_MIN = 480

/**
 * Issue #70 §2: je listek zastarel (> 8 h od nastanka)?
 * Ne-številčna/negativna starost → false (ni podatka → nikoli zastarelo).
 */
export function isStaleKdsTicket(ageMin: number | null | undefined): boolean {
  if (ageMin === null || ageMin === undefined || !Number.isFinite(ageMin)) return false
  return ageMin > KDS_STALE_THRESHOLD_MIN
}

/**
 * Issue #70 §2: starost zastarelega listka v CELIH urah (prikaz "225 h" namesto
 * "13.496 min"). Za ne-številčne vrednosti vrne 0 (varna privzeta vrednost).
 */
export function staleTicketHours(ageMin: number | null | undefined): number {
  if (ageMin === null || ageMin === undefined || !Number.isFinite(ageMin) || ageMin <= 0) return 0
  return Math.floor(ageMin / 60)
}

/** Fixed reason catalog (i18n keys live under `kds.delay.<reason>` in sl.ts/hr.ts). */
export const KDS_DELAY_REASONS = ['out_of_stock', 'busy', 'equipment', 'redo', 'other'] as const

export type KdsDelayReason = (typeof KDS_DELAY_REASONS)[number]

/** AuditLog action used for delay-reason entries. */
export const KDS_DELAY_ACTION = 'KDS_DELAY'

/**
 * OPS-11 val 1 (v1.80.0) — per-station delay threshold.
 *
 * Maps a station's prep target (PrepStation.avgPrepTime, minutes) onto the delay
 * threshold: max(10, ceil(target × 1.25)) — a slow station gets proportionally more
 * slack before the item counts as LATE, but never less than the global 10 minutes.
 * Missing / invalid target (< 1 min, NaN) → the global KDS_DELAY_THRESHOLD_MIN (10).
 */
export function delayThresholdForTarget(targetMin?: number | null): number {
  const t = Number(targetMin)
  if (!Number.isFinite(t) || t < 1) return KDS_DELAY_THRESHOLD_MIN
  return Math.max(KDS_DELAY_THRESHOLD_MIN, Math.ceil(t * 1.25))
}

/**
 * Late check for the live timer / bump decision against an OPTIONAL per-station
 * target. Strictly greater than the resolved threshold (boundary = not late,
 * same as the board).
 *  - isLatePrep(prepMin)          → prepMin > 10   (back-compat: the historical
 *    global threshold, identical to the old shouldAskDelayReason decision)
 *  - isLatePrep(prepMin, target)  → prepMin > delayThresholdForTarget(target)
 * Non-finite / null prepMin → false (no data → never late).
 */
export function isLatePrep(prepMin: number, targetMin?: number | null): boolean {
  if (!Number.isFinite(prepMin)) return false
  return prepMin > delayThresholdForTarget(targetMin)
}

/**
 * Threshold decision: does bumping an item with this prep time need the reason dialog?
 * Strictly greater than the threshold (10.0 min exactly = not late, same as the board).
 * Non-finite / null input → false (no data → no dialog).
 * Back-compat delegate of isLatePrep without a station target (global 10 min).
 */
export function shouldAskDelayReason(prepMin: number | null | undefined): boolean {
  return isLatePrep(prepMin as number)
}

/** Membership check for the fixed catalog (server-side validation of the PATCH body). */
export function isValidDelayReason(v: unknown): v is KdsDelayReason {
  return typeof v === 'string' && (KDS_DELAY_REASONS as readonly string[]).includes(v)
}

/**
 * Live prep minutes for an item: (now − firedAt) / 60000. Null when the item was never
 * fired (no firedAt — e.g. direct-serve items) so callers fall back to another clock.
 */
export function computePrepMin(firedAt: Date | null | undefined, now: Date): number | null {
  if (!firedAt) return null
  const ms = now.getTime() - firedAt.getTime()
  if (!Number.isFinite(ms) || ms < 0) return null // clock skew → no measurement
  return ms / 60000
}

/** Canonical AuditLog.details payload for a KDS_DELAY entry. */
export function kdsDelayDetails(input: {
  orderItemId: string
  menuItemName: string
  reason: KdsDelayReason
  /** prep minutes rounded to 1 decimal (display value, aligned with kds-stats r1). */
  prepMin: number
  orderId: string
  /** OPS-11 val 1: per-station threshold AT BUMP TIME (additive key; omitted when unknown). */
  threshold?: number
}): Record<string, unknown> {
  return {
    orderItemId: input.orderItemId,
    menuItemName: input.menuItemName,
    reason: input.reason,
    prepMin: Math.round(input.prepMin * 10) / 10,
    orderId: input.orderId,
    // additive — callers that don't resolve a station keep the exact legacy shape
    ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
  }
}
