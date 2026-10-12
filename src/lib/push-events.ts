/**
 * OPS-11 val 2 (v1.81.0) — push event type registry (CLIENT-SAFE, zero imports).
 *
 * Extracted from src/lib/push.ts so the Nastavitve → "Obvestila (push)" matrix
 * card ('use client') can render its rows dynamically from the SAME constant the
 * server dispatch uses — without dragging web-push/@/lib/db into the client
 * bundle (same lesson as APP_VERSION → @/lib/version, tests/client-bundle-hygiene).
 * push.ts re-exports both symbols, so every existing '@/lib/push' import keeps
 * working unchanged (back-compat).
 *
 * AP_NEW: a new supplier invoice (AccountsPayable) was recorded — eSLOG e-invoice
 * import or the manual expense create. Fires next to the PO_* procurement events.
 *
 * AP_OVERDUE (OPS-11 val 3, v1.82.0): an open AccountsPayable is PAST ITS DUE
 * DATE — fired ONLY from the daily cron (/api/cron/daily, 1×/day, max 20) so
 * it can never become spam. Like AP_NEW it targets accounting/manager.
 */
export const PUSH_EVENT_TYPES = [
  'ORDER_NEW',
  'ORDER_READY',
  'ORDER_FIRE',
  'DELIVERY_NEW',
  'DRIVER_ASSIGNED',
  'RESERVATION_NEW',
  'LOW_STOCK',
  'PO_APPROVED',
  'PO_RECEIVED',
  'AP_NEW',
  'AP_OVERDUE',
  'TIME_OFF_STATUS',
  'RECEIPT_FAILED',
  'Z_CLOSED',
] as const

export type PushEventType = (typeof PUSH_EVENT_TYPES)[number]
