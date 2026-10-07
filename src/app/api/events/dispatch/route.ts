/**
 * Issue #11 §3 — POST /api/events/dispatch: ročni pregled dogodkovne vrste
 * (retry pending + failed do MAX_ATTEMPTS). Ops akcija — settings.manage.
 */
import { NextRequest } from 'next/server'
import { requirePermission, isResponse, ok } from '@/lib/api'
import { dispatchPending } from '@/lib/events'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => ({}))
  const limitRaw = Number((body as { limit?: unknown })?.limit)
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.round(limitRaw))) : 25

  const result = await dispatchPending(limit)
  return ok({ dispatched: result })
}
