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
 */

/** Late threshold in minutes — mirrors the KDS board escalation (> 10 min = red/late). */
export const KDS_DELAY_THRESHOLD_MIN = 10

/** Fixed reason catalog (i18n keys live under `kds.delay.<reason>` in sl.ts/hr.ts). */
export const KDS_DELAY_REASONS = ['out_of_stock', 'busy', 'equipment', 'redo', 'other'] as const

export type KdsDelayReason = (typeof KDS_DELAY_REASONS)[number]

/** AuditLog action used for delay-reason entries. */
export const KDS_DELAY_ACTION = 'KDS_DELAY'

/**
 * Threshold decision: does bumping an item with this prep time need the reason dialog?
 * Strictly greater than the threshold (10.0 min exactly = not late, same as the board).
 * Non-finite / null input → false (no data → no dialog).
 */
export function shouldAskDelayReason(prepMin: number | null | undefined): boolean {
  if (prepMin === null || prepMin === undefined || !Number.isFinite(prepMin)) return false
  return prepMin > KDS_DELAY_THRESHOLD_MIN
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
}): Record<string, unknown> {
  return {
    orderItemId: input.orderItemId,
    menuItemName: input.menuItemName,
    reason: input.reason,
    prepMin: Math.round(input.prepMin * 10) / 10,
    orderId: input.orderId,
  }
}
