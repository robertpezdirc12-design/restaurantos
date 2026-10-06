import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { jparse } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.integration.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  return ok({
    integrations: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      provider: r.provider,
      syncEnabled: r.syncEnabled,
      connectionStatus: r.connectionStatus,
      lastSyncAt: r.lastSyncAt,
      config: jparse(r.config, {}),
      events: jparse(r.events, []),
    })),
  })
}
