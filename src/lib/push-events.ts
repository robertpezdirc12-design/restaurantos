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
 *
 * LOT_BLOCKED (issue #15, v1.105.0): serija je bila blokirana (karantena ali
 * odpoklic) — takojšen push vodstvu/skladiščniku. LOT_ALERT (issue #15):
 * opozorilni datum serije je pretekel (samo IZRECNO določen alertDate —
 * dnevni cron, 1×/dan, ne izpeljuje se iz privzetih dni).
 *
 * CASH_MOVEMENT (issue #16, v1.108.0): ODLIV gotovine iz predala (paid_out /
 * supplier_payment / safe_drop / guest_refund) — takojšen push vodstvu
 * (kraja/trenje signal; prilivi niso dogodek).
 *
 * HACCP_OVERDUE (issue #20, v1.109.0): načrtovana kontrola je ZAPADLA brez
 * zapisa izvedbe — dnevni cron (/api/cron/daily korak haccpOverdue), en
 * opomnik na termin (state marker preprečuje ponavljanje).
 * HACCP_DEVIATION (issue #20): meritev je IZVEN meje (warning/critical) —
 * takojšen push ob vnosu (vodstvo; opozorilna odstopanja niso dogodek —
 * samo critical, da opozorila ne postanejo šum).
 *
 * MANAGER_CALL (issue #21, v1.111.0): zaposleni iz POS-a zahteva pomoč
 * vodje (en klik — tip zahteve + miza/naročilo). Takojšen push vodstvu na
 * lokaciji; matrika lahko prejemnike omeji/izklopi.
 * MANAGER_CALL_ESCALATED (issue #21): klic je ZAPADEL brez potrditve —
 * eskalacijski krog (max 3) leno ob GET poll-u; širši bazni cilj
 * (vodstvo/admin/lastnik).
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
  'LOT_BLOCKED',
  'LOT_ALERT',
  'CASH_MOVEMENT',
  'HACCP_OVERDUE',
  'HACCP_DEVIATION',
  'MANAGER_CALL',
  'MANAGER_CALL_ESCALATED',
] as const

export type PushEventType = (typeof PUSH_EVENT_TYPES)[number]
