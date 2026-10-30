import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, jstr } from '@/lib/map'
import { orderInclude, normalizeOrder } from '@/lib/ops'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { canResumeOrder } from '@/lib/order-hold'

/**
 * OSS-4 (v1.204.0) — HOLD/DRAFT NAROČILA.
 * POST /api/orders/[id]/resume — nadaljuj zadržano naročilo (edina pot ven iz 'hold').
 *
 * Pravila (src/lib/order-hold.ts):
 *  - dovoljenje `orders.create` (isti vzorec kot fire/hold);
 *  - SAMO iz statusa 'hold';
 *  - CAS zapis: updateMany uspe samo, če je vrstica ob zapisu ŠE 'hold' + 'unpaid'
 *    (claimMutableOrder tukaj NE sme biti uporabljen — 'hold' ni v ORDER_MUTABLE_STATUS,
 *    kar je prav: zadržano naročilo je namerno izven mutabilne bele liste);
 *  - revizija ORDER_RESUMED (chain) + dogodek OrderResumed (fire-and-forget);
 *  - po uspehu je naročilo spet polno mutabilno (urejanje, fire, plačilo ...).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  const check = canResumeOrder({ status: order.status })
  if (!check.ok) return fail(check.error, 409)

  const resumed = await db.$transaction(async (tx) => {
    // CAS: samo še-zadržano, neplačano naročilo gre nazaj v 'open'.
    const claim = await tx.order.updateMany({
      where: { id, status: 'hold', paymentStatus: 'unpaid' },
      data: { status: 'open' },
    })
    if (claim.count === 0) return false
    await writeAudit(tx, {
      userId: user.sub,
      action: 'ORDER_RESUMED',
      entityType: 'Order',
      entityId: id,
      details: jstr({ orderNumber: order.orderNumber, total: Number(order.total), by: user.name }),
      locationId: order.locationId,
    })
    return true
  })
  if (!resumed) return fail('Naročilo se je medtem spremenilo — osvežite in poskusite znova.', 409)

  await publishEvent('OrderResumed', {
    entityType: 'Order',
    entityId: id,
    payload: { orderId: id, locationId: order.locationId },
    locationId: order.locationId,
  }).catch(() => undefined)

  const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!fresh) return fail('Naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalizeOrder(fresh)), resumed: true })
}
