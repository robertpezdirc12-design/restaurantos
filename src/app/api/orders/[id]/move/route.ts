import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, assertResourceLocation } from '@/lib/api'
import { mapOrder, nid, jstr } from '@/lib/map'
import { orderInclude, normalizeOrder } from '@/lib/ops'
import { publishEvent } from '@/lib/events'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * P2 audit §54 — selitev naročila na drugo mizo (move).
 * POST /api/orders/[id]/move  body: { tableId }
 * Pravila:
 *  - dovoljenje `orders.create` (natakar sme; kuhinja/staff brez → 403)
 *  - naročilo mora biti odprto (status NOT IN paid/cancelled IN paymentStatus NOT paid)
 *  - ciljna miza: obstaja, ISTA lokacija kot naročilo, brez drugega odprtega naročila (409)
 *  - tableId == trenutni tableId → 400
 *  - v tx: order.tableId + status miz (nova → occupied; stara → available, če brez drugih odprtih naročil)
 *  - revizija ORDER_MOVE + dogodek OrderMoved (fire-and-forget)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const tableId = typeof body?.tableId === 'string' ? body.tableId.trim() : ''
  if (!tableId) return fail('tableId je obvezen.', 400)

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = assertResourceLocation(user, order.locationId)
  if (guard) return guard
  // selitev je mogoča samo za odprto naročilo (plačanega/storniranega ne premikamo)
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    return fail('Zaključenega (plačanega/storniranega) naročila ni mogoče premakniti.', 409)
  }
  if (order.tableId === tableId) return fail('Naročilo je že na tej mizi.', 400)

  const table = await db.table.findUnique({ where: { id: tableId } })
  if (!table) return fail('Ciljna miza ne obstaja.', 404)
  if (table.locationId !== order.locationId) {
    return fail('Ciljna miza pripada drugi lokaciji.', 400)
  }

  // ciljna miza ne sme imeti drugega odprtega naročila (isti vzorec kot R6 zasedba mize)
  const busy = await db.order.findFirst({
    where: {
      tableId,
      id: { not: id },
      status: { notIn: ['paid', 'cancelled'] },
      paymentStatus: { not: 'paid' },
    },
    select: { id: true, orderNumber: true },
  })
  if (busy) return fail('Ciljna miza je zasedena (odprto naročilo).', 409)

  const fromTableId = order.tableId
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { tableId } })
    // nova miza → zasedena (CAS vzorec iz createOrderCore — nikoli ne "spusti" zasedene mize)
    await tx.table.updateMany({ where: { id: tableId, status: { not: 'occupied' } }, data: { status: 'occupied' } })
    // stara miza → prosta, če na njej ni več odprtega naročila
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
    const __aIdM = nid()
    const __chainM = await auditChainFields(tx, { action: 'ORDER_MOVE', entityType: 'Order', entityId: id, details: jstr({ fromTableId, toTableId: tableId, tableNumber: table.number, orderNumber: order.orderNumber, by: user.name }), locationId: order.locationId, id: __aIdM })
    await tx.auditLog.create({
      data: {
        ...__chainM,
        id: __aIdM,
        userId: user.sub,
        action: 'ORDER_MOVE',
        entityType: 'Order',
        entityId: id,
        details: jstr({ fromTableId, toTableId: tableId, tableNumber: table.number, orderNumber: order.orderNumber, by: user.name }),
        locationId: order.locationId,
      },
    })
  })

  await publishEvent('OrderMoved', {
    entityType: 'Order',
    entityId: id,
    payload: { orderId: id, fromTableId, toTableId: tableId, locationId: order.locationId },
  }).catch(() => undefined)

  const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!fresh) return fail('Naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalizeOrder(fresh)) })
}
