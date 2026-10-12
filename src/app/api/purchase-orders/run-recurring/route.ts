import { NextRequest } from 'next/server'
import { requirePermission, isResponse, ok } from '@/lib/api'
import { runDueRecurringRules } from '@/lib/recurring-run'

/**
 * OPS-9 val 2 (v1.75.0) — evalvacija pravil ponavljajočih naročilnic.
 * OPS-11 val 3 (v1.82.0) — route is now a thin DELEGATE over the shared core
 * `runDueRecurringRules` (src/lib/recurring-run.ts), which the Vercel cron
 * (/api/cron/daily) also calls. Behavior and response shape are unchanged:
 *
 * POST /api/purchase-orders/run-recurring
 *   → naloži pravila (Integration 'recurring-po'), za vsako aktivno + zapadlo
 *     (isDue) ustvari OSNUTEK naročilnice (status 'draft', notes `Recurring #<id>`)
 *     s ceno iz SupplierItem (pricePerPack/packQty) oz. fallback costPerUnit, in
 *     pomakne schedule (lastRun=now, nextRun=computeNextRun). Ne-zapadla pravila
 *     se preskoče (idempotentno).
 *
 * Back-compat: isti odgovor shape ({ created, skipped } + busy flag) in isti
 * audit (RECURRING_PO_CREATED per ustvarjen PO). Additive: `errors` array is
 * present ONLY when a rule failed (the core keeps evaluating the rest).
 *
 * Push: NAMERNO IZPUŠČENO — PUSH_EVENT_TYPES nima 'PO_CREATED' (osnutki so šum;
 * PO_APPROVED/PO_RECEIVED ostaneta za prave prehode).
 *
 * Pravica: inventory.manage. UI kliče ta endpoint ob mountu NabavaTab (lazy
 * trigger, enkrat) + gumb "Zaženi zdaj".
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const result = await runDueRecurringRules({
    locationId: user.loc || null,
    actor: user.name || '',
    actorId: user.sub || null,
  })

  // back-compat response: exactly { created, skipped } (+ busy on the in-process
  // double-fire guard; + errors only when a rule failed).
  const payload: Record<string, unknown> = { created: result.created, skipped: result.skipped }
  if (result.busy) payload.busy = true
  if (result.errors.length > 0) payload.errors = result.errors
  return ok(payload)
}
