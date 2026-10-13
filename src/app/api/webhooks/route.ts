import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, locationScope, isResponse, ok } from '@/lib/api'
import { jparse } from '@/lib/map'

/**
 * Issue #5 (P0, kommentar #4): prej requireAuth BREZ filtra — vsak prijavljeni je
 * videl webhook konfiguracijo vseh organizacij (URL-ji lahko vsebujejo žetone v
 * query stringu). Zdaj settings.manage (integracije-tab) + locationScope filter
 * (Webhook LOKACIJSKI stolpec obstaja — Webhook.locationId).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const scope = await locationScope(user)
  const rows = await db.webhook.findMany({
    where: { ...(scope.locationId ? { locationId: scope.locationId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({
    webhookEndpoints: rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      events: jparse(r.events, []),
      isActive: r.isActive,
      lastTriggered: r.lastTriggered,
      failureCount: r.failureCount,
    })),
  })
}
