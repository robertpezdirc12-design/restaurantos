import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { num } from '@/lib/map'
import { resolveQrToken, rateLimitPublic, clientIp, GUEST_VISIBLE_ORDER_STATUS } from '@/lib/guest'

/**
 * Issue #3 — javno sledenje statusa naročila za gosta.
 * GET /api/public/orders/status?qr=<token>&orderNumber=<n>
 * Vrne SAMO whitelist polja (brez zaposlenih/internih podatkov).
 */
export async function GET(req: NextRequest) {
  if (!rateLimitPublic(`status:${clientIp(req)}`, 60)) return fail('Preveč zahtevkov.', 429)
  const qrToken = req.nextUrl.searchParams.get('qr') || ''
  const orderNumber = Math.round(Number(req.nextUrl.searchParams.get('orderNumber')) || 0)
  if (!qrToken || !orderNumber) return fail('Manjkata qr in orderNumber.', 400)

  const table = await resolveQrToken(qrToken)
  if (!table) return fail('QR koda ni veljavna.', 404)

  const order = await db.order.findFirst({
    where: { tableId: table.id, orderNumber, locationId: table.locationId },
    include: { OrderItem: { select: { menuItemName: true, quantity: true, status: true } } },
  })
  if (!order) return fail('Naročilo s to številko ne obstaja na tej mizi.', 404)

  return ok({
    orderNumber: order.orderNumber,
    status: GUEST_VISIBLE_ORDER_STATUS[order.status] || order.status,
    paymentStatus: order.paymentStatus,
    total: num(order.total),
    createdAt: order.createdAt,
    items: order.OrderItem.map((it) => ({
      name: it.menuItemName,
      qty: it.quantity,
      status: GUEST_VISIBLE_ORDER_STATUS[it.status] || it.status,
    })),
  })
}
