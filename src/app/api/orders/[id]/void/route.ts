import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, jstr } from '@/lib/map'
import { recalcOrderTotals } from '@/lib/ops'
import { writeAudit } from '@/lib/audit-chain'
import { publishEvent } from '@/lib/events'
import { pushToLocationRoles } from '@/lib/push'

/**
 * Issue #5 (komentar #3 — P0 funkcionalna vrzel): PREKLIC POSAMEZNE POSTAVKE.
 *
 * `orders.void` dovoljenje + `OrderItem.voided`/`voidReasonId` + `VoidReason`
 * katalog obstajajo v shemi od N3/OPS-4, a BREZ poti (dovoljenje nikoli
 * uveljavljeno, VoidReason nikoli sejdan). Toast vzorec: preklic zahteva
 * pooblastilo + RAZLOG.
 *
 * Pravila:
 *  - dovoljenje orders.void (vodstvo; natakar ne more — gumb vidi samo
 *    pooblaščeni);
 *  - razlog OBVEZEN: reasonId (katalog VoidReason: aktiven, ista lokacija/org)
 *    ALI reason besedilo (3–200 znakov — shranjeno v audit sledi);
 *  - CAS: updateMany({ where: { id, voided: false } }) — dvojni klik ne
 *    naredi dveh dogodkov (count 0 → 409);
 *  - PLAČANO/stornirano naročilo → 409 (fiskalni storno/vračilo je LOČENA
 *    kanonična pot /api/receipts/[id]/storno — izdanih računov ne spreminjamo);
 *  - zaloga: razknjižba teče ob FURS izstavitvi SAMO za izstavljene postavke
 *    (deductStockForOrderTx onlyItemIds + billing voided filter) — preklic pred
 *    plačilom pomeni, da se postavka nikoli ne razknjiži (brez popravkov);
 *  - KDS: kuhinjski GET filtrira voided: false + aktivne statuse → preklicana
 *    postavka IZGINE iz vrste; osebje obvestimo prek dogodka + pusha.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.void')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : ''
  if (!itemId) return fail('itemId je obvezen.', 400)
  const reasonId = typeof body?.reasonId === 'string' ? body.reasonId.trim() : ''
  const reasonText = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
  if (!reasonId && reasonText.length < 3) {
    return fail('Razlog preklica je obvezen (izberi iz seznama ali vpiši vsaj 3 znake).', 400)
  }

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const locGuard = await guardResource(user, order.locationId)
  if (locGuard) return locGuard
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'storno' || order.status === 'cancelled') {
    return fail('Plačanega/storniranega naročila ni mogoče preklicati po postavkah — fiskalni storno je ločena pot.', 409)
  }
  const item = order.OrderItem.find((i) => i.id === itemId)
  if (!item) return fail('Postavka ne pripada temu naročilu.', 404)
  if (item.voided) return fail('Postavka je že preklicana.', 409)

  // katalog razlogov: aktiven + LOKACIJA/org guard (tuji katalog zavrnjen)
  let reason: { id: string; name: string } | null = null
  if (reasonId) {
    const row = await db.voidReason.findUnique({ where: { id: reasonId } })
    if (!row || !row.isActive) return fail('Razlog preklica ne obstaja ali ni aktiven.', 400)
    const rGuard = await guardResource(user, row.locationId)
    if (rGuard) return rGuard
    reason = { id: row.id, name: row.name }
  }

  // CAS prevzem: samo prvi poskus prekliče (podvojen klik → 0 vrstic → 409)
  const claim = await db.orderItem.updateMany({
    where: { id: itemId, voided: false },
    data: { voided: true, ...(reason ? { voidReasonId: reason.id } : {}) },
  })
  if (claim.count === 0) return fail('Postavka je že preklicana.', 409)

  // vrnjena vrednost postavke (quantity × price − popust) — izračun iz vrstice
  const refund = Number(item.quantity) * Number(item.price) - Number(item.discountAmount || 0)

  // osveži zneske naročila (recalc upošteva SAMO ne-preklicane postavke) — isti
  // vzorec kot addItems pot: izračun SE ZAPIŠE v vrstico naročila
  const totals = await recalcOrderTotals(id)
  await db.order.update({ where: { id }, data: totals })

  // audit sled: kdo, kaj, razlog, vrnjeni znesek
  await writeAudit(db, {
    userId: user.sub,
    action: 'ORDER_ITEM_VOID',
    entityType: 'OrderItem',
    entityId: itemId,
    details: jstr({
      orderId: id,
      orderNumber: order.orderNumber,
      item: item.menuItemName,
      quantity: Number(item.quantity),
      refund: Math.round(refund * 100) / 100,
      reasonId: reason?.id || null,
      reasonName: reason?.name || null,
      reasonText: reasonText || null,
      by: user.name,
    }),
    locationId: order.locationId,
  })

  // KDS osvežitev: dogodek + direkten push kuhinjskim/vodstvenim vlogam lokacije
  await publishEvent('OrderItemVoided', {
    entityType: 'Order',
    entityId: id,
    payload: { itemId, orderNumber: order.orderNumber, by: user.name },
  }).catch(() => undefined)
  pushToLocationRoles(order.locationId, ['chef', 'kitchen', 'bar', 'manager'], {
    tag: 'ORDER_ITEM_VOID',
    title: `Preklic postavke · naročilo ${order.orderNumber}`,
    body: `${item.menuItemName} (${Number(item.quantity)}×) preklicana${reason ? ` · ${reason.name}` : ''}`,
  })

  const fresh = await db.order.findUnique({
    where: { id },
    include: {
      OrderItem: { include: { MenuItem: { include: { PrepStation: true } } } },
      Table: true,
      Employee_Order_employeeIdToEmployee: { select: { id: true, name: true, role: true } },
    },
  })
  return ok({
    voided: {
      itemId,
      refund: Math.round(refund * 100) / 100,
      reason: reason?.name || reasonText || null,
    },
    order: fresh
      ? mapOrder({
          ...fresh,
          items: fresh.OrderItem,
          table: fresh.Table,
          employee: fresh.Employee_Order_employeeIdToEmployee,
        } as Parameters<typeof mapOrder>[0])
      : null,
  })
}
