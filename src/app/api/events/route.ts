/**
 * Issue #11 §3 — GET /api/events: pregled dogodkov (event trace) + številki vrste.
 * POST /api/events/dispatch: ročni pregled vrste (retry pending/failed) — ops akcija.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, requirePermission, isResponse, ok } from '@/lib/api'
import { dispatchPending, eventPayload } from '@/lib/events'

export const dynamic = 'force-dynamic'

/**
 * Issue #5 (P0, kommentar #1): prej requireAuth + BREZ filtra — vsak prijavljeni je
 * videl celoten event tok vseh organizacij (payload z št. računov/zneski, error
 * besedila, identifikatorje). EventLog še NIMA locationId stolpca (P1: DDL sledi),
 * zato P0 rešitev: centralna vloga (admin/owner — diagnostični trace) + MINIMALNI
 * DTO (brez payload/error — samo status/type/entityId/attempti/časi).
 */
export async function GET(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const type = url.searchParams.get('type') || undefined
  const status = url.searchParams.get('status') || undefined
  const takeRaw = Number(url.searchParams.get('take'))
  const take = Number.isFinite(takeRaw) ? Math.min(200, Math.max(1, Math.round(takeRaw))) : 50

  const where: Record<string, unknown> = {}
  if (type) where.type = type
  if (status) where.status = status

  const [rows, pendingCount, failedCount] = await Promise.all([
    db.eventLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, type: true, entityType: true, entityId: true, status: true, attempts: true, createdAt: true, processedAt: true },
    }),
    db.eventLog.count({ where: { status: 'pending' } }),
    db.eventLog.count({ where: { status: 'failed' } }),
  ])

  return ok({
    queue: { pending: pendingCount, failed: failedCount },
    events: rows,
  })
}
