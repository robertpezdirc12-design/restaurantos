import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Preklic popisa: DRAFT|SUBMITTED → CANCELLED (CAS updateMany; odobren popis NI
 * več preklicljiv — inventurni popravek je že v transakciji → 409). Vrstice z
 * vnosi ostanejo v evidence (audit sledljivost), zaloga se NE spreminja.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(_req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const st = await db.stocktake.findUnique({ where: { id }, select: { id: true, locationId: true, status: true } })
  if (!st) return fail('Popis ne obstaja.', 404)
  const guard = await guardResource(user, st.locationId)
  if (guard) return guard

  const res = await db.stocktake.updateMany({
    where: { id, status: { in: ['DRAFT', 'SUBMITTED'] } },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  })
  if (res.count === 0) return fail('Potrjenega popisa ni mogoče preklicati (inventura je že zabeležena).', 409)

  await writeAudit(db, { userId: user.sub, action: 'STOCKTAKE_CANCEL', entityType: 'Stocktake', entityId: id, details: jstr({ by: user.name, from: st.status }), locationId: st.locationId })
  await publishEvent('StocktakeCancelled', { entityType: 'Stocktake', entityId: id, payload: { locationId: st.locationId, by: user.name }, locationId: st.locationId }).catch(() => undefined)

  return ok({ id, status: 'CANCELLED' })
}
