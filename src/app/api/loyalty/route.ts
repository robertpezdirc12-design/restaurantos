import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.loyaltyAccount.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  return ok({
    accounts: rows.map((r) => ({
      id: r.id,
      guestName: r.customerName,
      phone: r.customerPhone || null,
      points: r.pointsBalance,
      visits: r.lifetimePoints,
      tier: r.tier,
      lastVisit: null,
      createdAt: r.createdAt,
    })),
  })
}
