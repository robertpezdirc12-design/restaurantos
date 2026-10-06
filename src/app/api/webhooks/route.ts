import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { jparse } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.webhook.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
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
