import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'

/**
 * Issue #5 (P0, komentar #4): UI/API neskladje — TAB_PERM.mnenja = reservations.manage,
 * API pa requireAuth. Backend sedaj uveljavlja isto poslovno pravico.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const rows = await db.guestFeedback.findMany({
    // Issue #4 §1: povratne informacije gostov po lokaciji (GuestFeedback.locationId)
    where: await locationScope(user),
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
