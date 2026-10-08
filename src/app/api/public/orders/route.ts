import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { nid } from '@/lib/map'
import { createOrderCore, OrderError } from '@/lib/ops'
import {
  GuestError,
  resolveGuestItems,
  resolveQrToken,
  rateLimitPublic,
  clientIp,
  deviceFromToken,
  deviceAlive,
  GUEST_VISIBLE_ORDER_STATUS,
} from '@/lib/guest'

/**
 * Issue #3 — JAVNO oddajanje naročila (QR self-order + kiosk).
 * ISTI kanonični Order pipeline kot POS: createOrderCore → Order → OrderItem → KDS → Payment → Receipt/FURS.
 * Varnost:
 *  - locationId/tableId se VEDNO rešita server-side (iz qrToken ali kiosk naprave) — client ID-ji niso zaupani.
 *  - Cene/opcije se rešijo iz DB (resolveGuestItems) — client price ni zaupan.
 *  - Idempotencija: clientOperationId → unique Order.idempotencyKey (refresh/double-tap = replay, brez dvojnika).
 *  - Rate limit: 10 naročil/min na IP+token.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return fail('Neveljavno telo zahteve.', 400)

  const qrToken = String(body.qrToken || '')
  const deviceToken = req.headers.get('x-device-token')
  const ip = clientIp(req)
  const rlKey = `order:${ip}:${qrToken || deviceToken || 'x'}`
  if (!rateLimitPublic(rlKey, 10)) return fail('Preveč naročil naenkrat. Počakaj trenutek.', 429)

  let locationId: string | null = null
  let tableId: string | null = null
  let orderSource = 'qr'
  let notePrefix = ''

  if (qrToken) {
    const table = await resolveQrToken(qrToken)
    if (!table) return fail('QR koda ni veljavna ali je naročanje po QR izklopljeno.', 404)
    locationId = table.locationId
    tableId = table.id
    orderSource = 'qr'
    notePrefix = `QR miza ${table.number}`
  } else if (deviceToken) {
    const device = await deviceFromToken(deviceToken)
    if (!deviceAlive(device, ['kiosk'])) return fail('Kiosk naprava ni registrirana.', 401)
    await db.deviceRegistry.update({
      where: { id: device.id },
      data: { status: 'online', lastSeenAt: new Date() },
    })
    locationId = device.locationId
    if (!locationId) return fail('Kiosk ni povezan z lokacijo.', 400)
    orderSource = 'kiosk'
    // Kiosk: izbira mize NE zaupamo clientu brez validacije — če je podana, mora obstajati na lokaciji
    if (body.tableNumber) {
      const t = await db.table.findFirst({
        where: { locationId, number: Math.round(Number(body.tableNumber) || 0) },
      })
      if (!t) return fail('Miza s to številko ne obstaja na lokaciji.', 400)
      tableId = t.id
    }
    notePrefix = `Kiosk ${device.name}`
  } else {
    return fail('Manjka QR token ali identiteta naprave.', 401)
  }

  try {
    const items = await resolveGuestItems(Array.isArray(body.items) ? body.items : [], { locationId })
    const clientOperationId = String(body.clientOperationId || '').trim()
    if (clientOperationId.length < 8) return fail('Manjka idempotency ključ (clientOperationId).', 400)

    const type = orderSource === 'qr' ? 'DINE_IN' : body.tableNumber ? 'DINE_IN' : 'TAKEAWAY'
    const customerName = String(body.customerName || '').slice(0, 80)

    const { order, replayed } = await createOrderCore({
      employeeId: null, // gost ni zaposleni
      locationId,
      tableId,
      type,
      orderSource,
      items: items.map((i) => ({
        menuItemId: i.menuItemId,
        qty: i.qty,
        note: i.note,
        modifiers: i.modifiers,
      })),
      note: [notePrefix, customerName ? `Gost: ${customerName}` : ''].filter(Boolean).join(' · '),
      clientOperationId,
    })

    if (!replayed) {
      await db.auditLog.create({
        data: {
          id: nid(),
          userId: null,
          action: 'GUEST_ORDER_CREATED',
          entityType: 'Order',
          entityId: order.id,
          details: `vir=${orderSource} naročilo=#${order.orderNumber} postavke=${items.length}`,
          ipAddress: ip,
          locationId,
        },
      })
    }

    // Javni odgovor — brez občutljivih podatkov zaposlenih (status: DB 'open' → gostujoča beseda)
    return ok({
      replayed,
      orderNumber: order.orderNumber,
      status: GUEST_VISIBLE_ORDER_STATUS[String(order.status).toLowerCase()] || order.status,
      total: order.total,
      createdAt: order.createdAt,
    })
  } catch (e) {
    if (e instanceof GuestError) return fail(e.message, e.status)
    if (e instanceof OrderError) return fail(e.message, 400)
    console.error('public order error', e)
    return fail('Naročila ni bilo mogoče varno oddati. Poskusi znova.', 500)
  }
}
