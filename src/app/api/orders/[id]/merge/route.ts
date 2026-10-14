import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, jstr, num, r2 } from '@/lib/map'
import { orderInclude, normalizeOrder } from '@/lib/ops'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'

/**
 * P2 audit §54 — združevanje naročil (merge).
 * POST /api/orders/[id]/merge  body: { targetOrderId }
 * Vir (= [id]) prenese svoje aktivne postavke na cilj in se prekliče:
 *  - dovoljenje `orders.create`; oba naročila odprta, ISTA lokacija, različna ID-ja
 *  - postavke vira, ki so že na računu (checkId) → 409 (plačanih/delno plačanih ne premikamo);
 *    preklicane/voided postavke ostanejo pri viru (ne vplivajo na totalle cilja)
 *  - v tx: premik postavk, preklic vira (status cancelled + cancelReason), recalcTotals cilja,
 *    sprostitev mize vira (če brez drugih odprtih naročil), revizija ORDER_MERGE, dogodek OrderMerged
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const targetOrderId = typeof body?.targetOrderId === 'string' ? body.targetOrderId.trim() : ''
  if (!targetOrderId) return fail('targetOrderId je obvezen.', 400)
  if (targetOrderId === id) return fail('Naročila ni mogoče združiti samo s seboj.', 400)

  const source = await db.order.findUnique({ where: { id } })
  if (!source) return fail('Naročilo (vir) ne obstaja.', 404)
  const guard = await guardResource(user, source.locationId)
  if (guard) return guard
  if (source.status === 'paid' || source.status === 'cancelled' || source.paymentStatus === 'paid') {
    return fail('Zaključenega (plačanega/storniranega) naročila ni mogoče združiti.', 409)
  }

  const target = await db.order.findUnique({ where: { id: targetOrderId } })
  if (!target) return fail('Ciljno naročilo ne obstaja.', 404)
  if (target.locationId !== source.locationId) {
    return fail('Naročila pripadajo različnim lokacijam — združevanje ni mogoče.', 400)
  }
  if (target.status === 'paid' || target.status === 'cancelled' || target.paymentStatus === 'paid') {
    return fail('Ciljno naročilo ni več odprto.', 409)
  }

  // postavke na računu (Check) so že bremenjene — vir mora ostati celosten (dokumentirano: 409)
  const billed = await db.orderItem.count({ where: { orderId: id, checkId: { not: null } } })
  if (billed > 0) {
    return fail('Naročilo vsebuje postavke, ki so že na računu — združevanje ni mogoče.', 409)
  }

  const fromTableId = source.tableId
  const merged = await db.$transaction(async (tx) => {
    // premik aktivnih postavk (pending/fired/preparing/ready/served) iz vira na cilj;
    // cancelled/voided ostanejo pri viru — ne smejo spreminjati totalov cilja
    const moved = await tx.orderItem.updateMany({
      where: { orderId: id, checkId: null, status: { notIn: ['cancelled', 'voided'] } },
      data: { orderId: targetOrderId },
    })
    // preklic vira (paymentStatus ostane nespremenjen — zgodovina plačil se ne izgubi)
    await tx.order.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: user.name,
        cancelledById: user.sub,
        cancelReason: `merged into ${target.orderNumber}`,
      },
    })
    // miza vira → prosta, če na njej ni več odprtega naročila (isti vzorec kot move)
    if (fromTableId) {
      const stillOpen = await tx.order.findFirst({
        where: {
          tableId: fromTableId,
          id: { not: id },
          status: { notIn: ['paid', 'cancelled'] },
          paymentStatus: { not: 'paid' },
        },
        select: { id: true },
      })
      if (!stillOpen) {
        await tx.table.updateMany({ where: { id: fromTableId, status: 'occupied' }, data: { status: 'available' } })
      }
    }
    // totali cilja iz NE-voided postavk (isti izračun kot orders/[id] recalcTotals)
    const items = await tx.orderItem.findMany({ where: { orderId: targetOrderId, voided: false } })
    let subtotal = 0
    let tax = 0
    for (const it of items) {
      subtotal += num(it.price) * (it.quantity || 0)
      tax += num(it.vatAmount)
    }
    const totals = { subtotal: r2(subtotal), tax: r2(tax), total: r2(subtotal + tax) }
    await tx.order.update({ where: { id: targetOrderId }, data: totals })
    await writeAudit(tx, { userId: user.sub, action: 'ORDER_MERGE', entityType: 'Order', entityId: id, details: jstr({
          sourceOrderId: id,
          targetOrderId,
          movedItems: moved.count,
          sourceTableId: fromTableId,
          targetTableId: target.tableId,
          orderNumber: source.orderNumber,
          by: user.name,
        }), locationId: source.locationId })
    return moved.count
  })

  await publishEvent('OrderMerged', {
    entityType: 'Order',
    entityId: targetOrderId,
    payload: { sourceOrderId: id, targetOrderId, movedItems: merged, locationId: source.locationId },
    locationId: source.locationId,
  }).catch(() => undefined)

  const fresh = await db.order.findUnique({ where: { id: targetOrderId }, include: orderInclude })
  if (!fresh) return fail('Ciljno naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalizeOrder(fresh)), mergedItems: merged, sourceCancelled: true })
}
