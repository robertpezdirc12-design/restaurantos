import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { jparse } from '@/lib/map'

/**
 * Revizijski dnevnik (issue #1: granularne pravice + audit).
 * Zahteva reports.view; vrne zadnjih 100 vnosov z jq filtriranjem po akciji.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user
  const action = req.nextUrl.searchParams.get('action')
  const entries = await db.auditLog.findMany({
    // Issue #4 §1: audit je location-scoped — staff ne vidi dogodkov tujih lokacij
    where: { ...(action ? { action: { contains: action } } : {}), ...(await locationScope(user)) },
    orderBy: { timestamp: 'desc' },
    take: 100,
  })
  return ok({
    entries: entries.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      userId: e.userId,
      details: jparse<Record<string, unknown>>(e.details, {}),
    })),
  })
}
