import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, locationScope } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.guestFeedback.findMany({
    // Issue #4 §1: povratne informacije gostov po lokaciji (GuestFeedback.locationId)
    where: locationScope(user),
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({
    feedback: rows.map((r) => ({
      id: r.id,
      rating: r.overallRating,
      comment: r.comment || null,
      tableId: r.tableId,
      locationId: r.locationId,
      createdAt: r.createdAt,
    })),
  })
}
