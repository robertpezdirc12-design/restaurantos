import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Recount (ponovni popis): SUBMITTED → DRAFT (CAS updateMany) + recountCount++.
 * Obstoječi vnosi OSTANEJO (ni brisanja — prijazno do vnašalca: lahko dopolni
 * manjkajoče ali popravi štetje); variansa se preračuna ob ponovni odobritvi.
 * Potrjen (APPROVED) popisa ni mogoče odpreti — inventurni popravek je že
 * v transakciji → 409. Petlja: DRAFT → SUBMITTED → DRAFT → …
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(_req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const st = await db.stocktake.findUnique({ where: { id }, select: { id: true, locationId: true, status: true, recountCount: true } })
  if (!st) return fail('Popis ne obstaja.', 404)
  const guard = await guardResource(user, st.locationId)
  if (guard) return guard

  const res = await db.stocktake.updateMany({
    where: { id, status: 'SUBMITTED' },
    data: { status: 'DRAFT', submittedAt: null, recountCount: { increment: 1 } },
  })
  if (res.count === 0) return fail('Potrjenega popisa ni mogoče ponovno odpreti.', 409)

  const __aId1 = nid()
  const __chain1 = await auditChainFields(db, { action: 'STOCKTAKE_RECOUNT', entityType: 'Stocktake', entityId: id, details: jstr({ by: user.name, recount: st.recountCount + 1 }), locationId: st.locationId, id: __aId1 })
  await db.auditLog.create({ data: { ...__chain1, id: __aId1, userId: user.sub, action: 'STOCKTAKE_RECOUNT', entityType: 'Stocktake', entityId: id, details: jstr({ by: user.name, recount: st.recountCount + 1 }), locationId: st.locationId } })
  await publishEvent('StocktakeRecount', { entityType: 'Stocktake', entityId: id, payload: { locationId: st.locationId, recount: st.recountCount + 1, by: user.name } }).catch(() => undefined)

  return ok({ id, status: 'DRAFT', recountCount: st.recountCount + 1 })
}
