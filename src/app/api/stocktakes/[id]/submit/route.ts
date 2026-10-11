import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Oddaja popisa: DRAFT → SUBMITTED (CAS updateMany — R3 vzorec; dvojni klik ali
 * vzporedna zahteva: drugi poskus šteje 0 vrstic → 409). Po oddaji vnos artiklov
 * je ZAKLENJEN (vnosi več niso mogoči — PATCH vrača 409), pot prek cancel ali
 * recount. Org meja: guardResource (Task 52 točkovni vzorec — lokacija + org).
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
    where: { id, status: 'DRAFT' },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
  })
  if (res.count === 0) return fail('Popis ni več v osnutku (že oddan, potrjen ali preklican).', 409)

  const __aId1 = nid()
  const __chain1 = await auditChainFields(db, { action: 'STOCKTAKE_SUBMIT', entityType: 'Stocktake', entityId: id, details: jstr({ by: user.name }), locationId: st.locationId, id: __aId1 })
  await db.auditLog.create({ data: { ...__chain1, id: __aId1, userId: user.sub, action: 'STOCKTAKE_SUBMIT', entityType: 'Stocktake', entityId: id, details: jstr({ by: user.name }), locationId: st.locationId } })
  await publishEvent('StocktakeSubmitted', { entityType: 'Stocktake', entityId: id, payload: { locationId: st.locationId, by: user.name } }).catch(() => undefined)

  return ok({ id, status: 'SUBMITTED' })
}
