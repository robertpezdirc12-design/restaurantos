/**
 * Issue #11 §3 — GET /api/events: pregled dogodkov (event trace) + številki vrste.
 * POST /api/events/dispatch: ročni pregled vrste (retry pending/failed) — ops akcija.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok } from '@/lib/api'
import { dispatchPending, eventPayload } from '@/lib/events'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
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
      select: { id: true, type: true, entityType: true, entityId: true, payload: true, status: true, attempts: true, error: true, createdAt: true, processedAt: true },
    }),
    db.eventLog.count({ where: { status: 'pending' } }),
    db.eventLog.count({ where: { status: 'failed' } }),
  ])

  return ok({
    queue: { pending: pendingCount, failed: failedCount },
    events: rows.map((r) => ({ ...r, payloadParsed: eventPayload(r) })),
  })
}
