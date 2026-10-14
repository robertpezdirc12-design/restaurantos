/**
 * Issue #11 §3 — GET /api/events: pregled dogodkov (event trace) + številki vrste.
 * POST /api/events/dispatch: ročni pregled vrste (retry pending/failed) — ops akcija.
 *
 * Issue #5 (P0): centralna vloga + MINIMALNI DTO (brez payload/error).
 *
 * Issue #38 (P1) — TENANT OBSEG dogodkovne vrste (nadomesti prej globalni pregled):
 *  - EventLog ima kanonični `locationId` (stolpec, strežniško izpeljan ob
 *    publishEvent iz PREVERJENE entitete — nikoli iz klientovega payload-a);
 *  - seznam in števci (pending/failed) uporabljajo ENAK tenant where-pogoj:
 *    org-bound centralna vloga vidi SAMO dogodke svoje organizacije;
 *  - dogodki z locationId NULL (legacy zgodovina / sistemski / globalne
 *    integracije) so vidni SAMO bootstrap platformnemu operaterju —
 *    fail-closed za običajni owner/admin račun (zahteva issue #38);
 *  - centralna vloga z NEZNANO organizacijo → fail-closed: prazen seznam
 *    in števci 0 (ne more pomočiti tuje organizacije);
 *  - filter deluje nad DB stolpcem → lažen `payload.locationId` ne more
 *    preskočiti obsega.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok } from '@/lib/api'
import { eventTenantScope, eventScopeWhere } from '@/lib/events'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  // #38: tenant obseg — strežniško izpeljan (org drevo uporabnikove lokacije)
  const scope = await eventTenantScope(user)
  const scopeWhere = eventScopeWhere(scope)

  const url = new URL(req.url)
  const type = url.searchParams.get('type') || undefined
  const status = url.searchParams.get('status') || undefined
  // #38 popravek: Number(null) === 0 → prej je odsoten 'take' pomenil take=1
  // (latentna napaka: privzeti pregled je vrnil SAMO najnovejši dogodek)
  const takeParam = url.searchParams.get('take')
  const takeRaw = takeParam === null ? NaN : Number(takeParam)
  const take = Number.isFinite(takeRaw) ? Math.min(200, Math.max(1, Math.round(takeRaw))) : 50

  const where: Record<string, unknown> = { ...scopeWhere }
  if (type) where.type = type
  if (status) where.status = status

  const [rows, pendingCount, failedCount] = await Promise.all([
    db.eventLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, type: true, entityType: true, entityId: true, status: true, attempts: true, locationId: true, createdAt: true, processedAt: true },
    }),
    db.eventLog.count({ where: { ...scopeWhere, status: 'pending' } }),
    db.eventLog.count({ where: { ...scopeWhere, status: 'failed' } }),
  ])

  return ok({
    queue: { pending: pendingCount, failed: failedCount },
    events: rows,
  })
}
