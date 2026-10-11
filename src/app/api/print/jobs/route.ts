/**
 * Issue #10 P2-3 — GET /api/print/jobs
 * Pregled zadnjih tiskalnih poskusov (status/kind filter, najnovejši prej).
 * Uporaba: diagnostika tiska ("zakaj račun ni natisnjen?"), ponovni tisk
 * pomeni nov poskus — vsak poskus je ena vrstica (attempts označuje poskus klicalca).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, locationScope } from '@/lib/api'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const status = url.searchParams.get('status') || undefined
  const kind = url.searchParams.get('kind') || undefined
  const takeRaw = Number(url.searchParams.get('take'))
  const take = Number.isFinite(takeRaw) ? Math.min(200, Math.max(1, Math.round(takeRaw))) : 50

  const scope = await locationScope(user)
  const rows = await db.printJob.findMany({
    where: {
      ...(scope.locationId ? { locationId: scope.locationId } : {}),
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true, userId: true, locationId: true, kind: true, refId: true,
      target: true, status: true, error: true, attempts: true, device: true, createdAt: true,
    },
  })

  return ok({ printJobs: rows })
}
