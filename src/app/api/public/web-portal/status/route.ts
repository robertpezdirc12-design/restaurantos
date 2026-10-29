import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { num } from '@/lib/map'
import { rateLimitPublic, clientIp, GUEST_VISIBLE_ORDER_STATUS } from '@/lib/guest'
import { resolvePortalToken, verifyTrackKey } from '@/lib/web-portal'

/**
 * P1 #8 (v1.190.0) — javno sledenje statusa spletnega naročila.
 * GET /api/public/web-portal/status?token=<portal>&n=<orderNumber>&k=<trackKey>
 *
 * Varnost:
 *  - orderNumber je majhen števec (uganjljiv) — zato trackKey = HMAC-SHA256(
 *    trackSecret, orderNumber), ki ga gost dobi IZKLJUČNO v odgovoru ob oddaji.
 *  - napačen/manjkajoč k → 409 z ISTIM sporočilom kot neznano naročilo
 *    (ne razkriva obstoja naročila); izklopljen/neveljaven portal → 404.
 *  - obseg: SAMO naročila vira 'web' na lokaciji portala — gost portala ne
 *    more slediti notranjim miznim naročilom (ta gredo prek miznega QR).
 *  - whitelist polj (brez zaposlenih/internih podatkov), rate limit 60/min/IP.
 */
export async function GET(req: NextRequest) {
  if (!(await rateLimitPublic(`webstatus:${clientIp(req)}`, 60))) return fail('Preveč zahtevkov.', 429)

  const token = req.nextUrl.searchParams.get('token') || ''
  const n = Math.round(Number(req.nextUrl.searchParams.get('n')) || 0)
  const k = String(req.nextUrl.searchParams.get('k') || '')
  if (!token || !n || !k) return fail('Manjkajo parametri token, n in k.', 400)

  const resolved = await resolvePortalToken(token)
  if (!resolved) return fail('Spletna povezava ni veljavna ali je portal izklopljen.', 404)

  // HMAC preverba PRED iskanjem — brez skrivnosti ne razkrijemo niti obstoja naročila
  if (!verifyTrackKey(resolved.portal.trackSecret, n, k)) {
    return fail('Naročilo s temi podatki ni najdeno.', 404)
  }

  const order = await db.order.findFirst({
    where: { orderSource: 'web', orderNumber: n, locationId: resolved.portal.locationId },
    include: { OrderItem: { select: { menuItemName: true, quantity: true, status: true } } },
  })
  if (!order) return fail('Naročilo s temi podatki ni najdeno.', 404)

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
