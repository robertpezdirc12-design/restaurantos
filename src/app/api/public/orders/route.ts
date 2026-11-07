import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'

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
import { slCount } from '@/lib/fmt'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import { fireOrderCore } from '@/lib/order-fire'

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
        // Issue #7 (P1): izrecno alergensko opozorilo gosta → postavka + KDS + tisk
        allergenWarning: i.allergenWarning,
        modifiers: i.modifiers,
      })),
      note: [notePrefix, customerName ? `Gost: ${customerName}` : ''].filter(Boolean).join(' · '),
      clientOperationId,
    })

    if (!replayed) {
      // 33-c: chain polja (tamper-evidentna veriga)
      await writeAudit(db, { userId: null, action: 'GUEST_ORDER_CREATED', entityType: 'Order', entityId: order.id, details: `vir=${orderSource} naročilo=#${order.orderNumber} postavke=${items.length}`, ipAddress: ip, locationId: locationId })
      // v1.241.0 (§16 E točka 3): ORDER_NEW push osebju — isti vzorec kot POS
      // POST /api/orders (OPS-7) in javni portal (fail-soft matrica; brez pravil
      // = base tarče bar/kitchen/chef). Do zdaj je QR/kiosk naročilo TIHO
      // pristalo — osebje je izvedelo šele iz polling vrste KDS.
      void pushEvent('ORDER_NEW', {
        title: 'Novo naročilo',
        body: `${notePrefix}${order.orderNumber ? ` · #${order.orderNumber}` : ''} · ${slCount(items.length, 'postavka')}`,
        url: '/dashboard?tab=kuhinja',
        tag: `order-${order.id}`,
      }, { roles: ['bar', 'kitchen', 'chef'], locationId })
    }

    // v1.241.0 (§16 E točka 3): AVTO-POŽIG gostovega naročila. Gost pri QR mizi
    // s pošiljanjem KOŠARICE že izrazi „daj v pripravo“ — čakanje na natakarjev
    // ročni fire pomeni: postajne deske naročila NIKOLI ne vidijo (StationTask
    // nastane šele ob požigu), firedAt ostane null (ETA/starost laže) in tablica
    // naročila visijo v pending. Toast/Square: self-order kanal gre naravnost v
    // kuhinjo. NEGLEJ replaya (helper je idempotenten — pokrije tudi retry po
    // fail-soft odpovedi iz prejšnjega klica); FAIL-SOFT: naročilo OBSTOJA in je
    // pending varno stanje (KDS ga pokaže prek SSE/polling) — napaka požiga ne
    // sme porušiti gostovega odgovora.
    let fired = false
    try {
      const fireRes = await fireOrderCore(order.id, {
        userId: null,
        by: orderSource,
        auditAction: 'GUEST_ORDER_FIRED',
        auditExtra: { source: orderSource, autoFire: true },
      })
      fired = fireRes.firedCount > 0
    } catch (fireErr) {
      console.error('public order auto-fire error', fireErr)
    }

    // Javni odgovor — brez občutljivih podatkov zaposlenih (status: DB 'open' → gostujoča beseda)
    return ok({
      replayed,
      orderNumber: order.orderNumber,
      status: GUEST_VISIBLE_ORDER_STATUS[String(order.status).toLowerCase()] || order.status,
      total: order.total,
      createdAt: order.createdAt,
      fired,
    })
  } catch (e) {
    if (e instanceof GuestError) return fail(e.message, e.status)
    // Issue #57: replay-context konflikt nosi svoj status (409), ne generični 400
    if (e instanceof OrderError) return fail(e.message, e.status || 400)
    console.error('public order error', e)
    return fail('Naročila ni bilo mogoče varno oddati. Poskusi znova.', 500)
  }
}
