/**
 * Issue #11 §3 — POST /api/events/dispatch: ročni pregled dogodkovne vrste
 * (retry pending + failed do MAX_ATTEMPTS). Ops akcija.
 *
 * Issue #38 (P1): requireCentralRole + TENANT OBSEG (prej zgolj
 * settings.manage — MANAGER z dovoljenjem je lahko sprožil GLOBALNI
 * retry/obdelavo dogodkov TUJIH organizacij):
 *  - MANAGER (settings.manage) → 403 (ni centralna vloga);
 *  - org-bound ADMIN/OWNER → dispatch SAMO dogodkov svoje organizacije
 *    (tuji in NULL-location dogodki ostanejo nedotaknjeni);
 *  - centralna vloga z NEZNANO organizacijo → 403 (fail-closed — dispatch
 *    je izrecna operacija platformnega operaterja);
 *  - bootstrap admin → globalni dispatch (izrecni break-glass).
 * Odgovor vsebuje SAMO števke {processed, failed, scanned} — nobenega
 * payload-a, entityId-ja ali error besedila tujih dogodkov.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { dispatchPending, eventTenantScope } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { jstr } from '@/lib/map'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  // #38: tenant obseg — neznan tenant ne sme sprožiti globalne obdelave
  const scope = await eventTenantScope(user)
  if (scope.kind === 'none') {
    return fail('Tenant obseg ni zanesljivo izpeljan — dispatch je izrecna operacija platformnega operaterja.', 403)
  }

  const body = await req.json().catch(() => ({}))
  const limitRaw = Number((body as { limit?: unknown })?.limit)
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.round(limitRaw))) : 25

  const result = await dispatchPending(limit, scope.kind === 'org' ? { locationIdIn: scope.locationIds } : undefined)

  // audit: akter + obseg + števke (brez vsebine dogodkov)
  await writeAudit(db, {
    userId: user.sub,
    action: 'EVENTS_DISPATCH',
    entityType: 'EventLog',
    entityId: 'dispatch',
    details: jstr({ limit, scope: scope.kind, processed: result.processed, failed: result.failed, scanned: result.scanned }),
    locationId: user.loc || null,
  }).catch(() => undefined)

  return ok({ dispatched: result })
}
