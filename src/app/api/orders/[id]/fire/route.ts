import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, assertResourceLocation } from '@/lib/api'
import { mapOrder, nid, jstr } from '@/lib/map'
import { orderInclude, normalizeOrder } from '@/lib/ops'
import { publishEvent } from '@/lib/events'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * P2 audit §57 — ekspliciten "fire" na kuhinjo (draft → fire korak).
 * POST /api/orders/[id]/fire  (brez body-ja)
 * Pravila:
 *  - dovoljenje `orders.create`; naročilo odprto
 *  - idempotentno: order.firedAt ??= now — če je firedAt že nastavljen, vrne 200 BREZ sprememb
 *    (izbira dokumentirana: ponoven fire obstoječega toka ni mogoč; postavke, dodane PO fire-u,
 *     pokrije naslednji klic, ker se vrste pri novih postavkah posodabljajo ločeno — v tej iteraciji
 *     pa fire = enkratna akcija celotnega odprtega naročila)
 *  - vsi OrderItem z statusom 'pending' (ne-voided) → status 'fired' + firedAt = now;
 *    že fired/preparing/ready/served ostanejo nedotaknjeni
 *  - revizija ORDER_FIRED + dogodek OrderFired (fire-and-forget)
 *  - če ni pending postavk → 200 s firedCount 0 (idempotentna prijaznost; UI gumb vseeno skrije)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = assertResourceLocation(user, order.locationId)
  if (guard) return guard
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    return fail('Zaključenega (plačanega/storniranega) naročila ni mogoče poslati na kuhinjo.', 409)
  }

  // idempotentnost: drugi klic ne sme spremeniti firedAt niti statusov postavk
  if (order.firedAt) {
    const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
    if (!fresh) return fail('Naročilo ne obstaja.', 404)
    return ok({ order: mapOrder(normalizeOrder(fresh)), firedCount: 0, alreadyFired: true })
  }

  const now = new Date()
  let firedCount = 0
  await db.$transaction(async (tx) => {
    const res = await tx.orderItem.updateMany({
      where: { orderId: id, status: 'pending', voided: false },
      data: { status: 'fired', firedAt: now },
    })
    firedCount = res.count
    await tx.order.update({ where: { id }, data: { firedAt: now } })
    const __aIdF = nid()
    const __chainF = await auditChainFields(tx, { action: 'ORDER_FIRED', entityType: 'Order', entityId: id, details: jstr({ firedItems: firedCount, orderNumber: order.orderNumber, by: user.name }), locationId: order.locationId, id: __aIdF })
    await tx.auditLog.create({
      data: {
        ...__chainF,
        id: __aIdF,
        userId: user.sub,
        action: 'ORDER_FIRED',
        entityType: 'Order',
        entityId: id,
        details: jstr({ firedItems: firedCount, orderNumber: order.orderNumber, by: user.name }),
        locationId: order.locationId,
      },
    })
  })

  await publishEvent('OrderFired', {
    entityType: 'Order',
    entityId: id,
    payload: { orderId: id, count: firedCount, locationId: order.locationId },
  }).catch(() => undefined)

  const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!fresh) return fail('Naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalizeOrder(fresh)), firedCount, alreadyFired: false })
}
