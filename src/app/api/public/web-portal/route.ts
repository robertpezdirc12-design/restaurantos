import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import {
  createOrderCore,
  OrderError,
} from '@/lib/ops'
import {
  GuestError,
  resolveGuestItems,
  rateLimitPublic,
  clientIp,
  GUEST_VISIBLE_ORDER_STATUS,
  loadPublicMenu,
} from '@/lib/guest'
import {
  resolvePortalToken,
  openStateNow,
  portalPolicyOf,
  trackKeyOf,
} from '@/lib/web-portal'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import { num } from '@/lib/map'

/**
 * P1 #8 (v1.190.0) — LASTNI SPLETNI PORTAL ZA NAROČILA (/s/<token>).
 *
 * GET  ?token= → meni + politika portala (odprto/zaprto, načini, pristojbine)
 * POST { token, fulfillment: 'pickup'|'delivery', items[], customerName,
 *        customerPhone, address?…, clientOperationId } → naročilo v POS
 *
 * Naročilo gre skozi ISTI kanonični Order pipeline kot POS/QR/kiosk/dostava
 * (createOrderCore → Order → OrderItem → KDS → Payment → Receipt/FURS), z
 * novim virom 'web' (peti vir poleg pos/qr/kiosk/delivery).
 *
 * Varnost (isti vzorec kot /api/public/orders):
 *  - locationId se VEDNO reši server-side iz tokena — client ID-ji niso zaupani.
 *  - Cene/opcije se rešijo iz DB (resolveGuestItems) — client cena ni zaupan.
 *  - Dostavna pristojbina + minimalni znesek sta politika LOKACIJE (row) —
 *    client jih ne more nastaviti (deliveryFee iz row, ne iz body).
 *  - Idempotencija: clientOperationId → unique Order.idempotencyKey
 *    (refresh/double-tap = replay, brez dvojnika; kontekst vira 'web').
 *  - Rate limit: 10 naročil/min na IP+token (GET 60/min na IP).
 *  - Urnik: zaprto → 409 (pošteno — ne sprejemamo naročil, ki jih nihče ne vidi);
 *    nekonfiguriran urnik NE blokira (openState 'unknown').
 *  - Javno sledenje: orderNumber je uganljiv števec → trackKey =
 *    HMAC-SHA256(trackSecret, orderNumber); brez njega status ruta vrne 404.
 *  - PII: samo lastni vnos gosta (ime/telefon/naslov); odgovor NE izdaja
 *    podatkov drugih (status = whitelist, audit brez telefona/naslova).
 */
export async function GET(req: NextRequest) {
  if (!(await rateLimitPublic(`webportal:${clientIp(req)}`, 60))) {
    return fail('Preveč zahtevkov. Poskusi čez minuto.', 429)
  }
  const token = req.nextUrl.searchParams.get('token') || ''
  const resolved = await resolvePortalToken(token)
  if (!resolved) return fail('Spletna povezava ni veljavna ali je portal izklopljen.', 404)
  const { portal, restaurantName } = resolved
  const policy = portalPolicyOf(portal)
  const state = await openStateNow(portal.locationId, resolved.timezone)
  const menu = await loadPublicMenu(portal.locationId)
  return ok({
    restaurant: restaurantName,
    note: policy.note,
    open: state !== 'closed',
    closedKnown: state === 'closed', // false tudi za 'unknown' (urnik nekonfiguriran)
    pickupEnabled: policy.pickupEnabled,
    deliveryEnabled: policy.deliveryEnabled,
    deliveryFee: policy.deliveryFee,
    minOrder: policy.minOrder,
    etaMinutes: policy.prepMinutes,
    ...menu,
  })
}

/** Sistemski zaposleni pod katerim gre naročilo (FK zahteva obstoj) — isti
 * vzorec kot delivery-webhook.systemEmployeeId (nestabilni sistemski vir,
 * zato employeeId NI del replay konteksta). */
async function systemEmployeeId(): Promise<string | null> {
  const mgr = await db.employee.findFirst({
    where: { role: { in: ['admin', 'manager'] }, status: 'active' },
    select: { id: true },
  })
  if (mgr) return mgr.id
  const any = await db.employee.findFirst({ select: { id: true } })
  return any?.id ?? null
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return fail('Neveljavno telo zahteve.', 400)

  const token = String(body.token || '')
  const ip = clientIp(req)
  const rlKey = `weborder:${ip}:${token}`
  if (!(await rateLimitPublic(rlKey, 10))) {
    return fail('Preveč naročil naenkrat. Počakaj trenutek.', 429)
  }

  const resolved = await resolvePortalToken(token)
  if (!resolved) return fail('Spletna povezava ni veljavna ali je portal izklopljen.', 404)
  const { portal, timezone } = resolved
  const policy = portalPolicyOf(portal)

  // ── način prevzema (politika lokacije odloča, ne client) ──
  const fulfillment = String(body.fulfillment || 'pickup')
  if (fulfillment !== 'pickup' && fulfillment !== 'delivery') {
    return fail('Neznan način prevzema (pickup ali delivery).', 400)
  }
  if (fulfillment === 'pickup' && !policy.pickupEnabled) {
    return fail('Prevzem osebno trenutno ni na voljo.', 400)
  }
  if (fulfillment === 'delivery' && !policy.deliveryEnabled) {
    return fail('Dostava trenutno ni na voljo.', 400)
  }

  // ── urnik: zaprto → pošteno zavrnjemo (nikoli lažnega "sprejeto") ──
  const state = await openStateNow(portal.locationId, timezone)
  if (state === 'closed') {
    return fail('Restavracija je trenutno zaprta — spletna naročila sprejemamo med odprtim.', 409)
  }

  // ── idempotenca (isti ključ kot POS/QR) ──
  const clientOperationId = String(body.clientOperationId || '').trim()
  if (clientOperationId.length < 8) return fail('Manjka idempotency ključ (clientOperationId).', 400)

  // ── kontakt gosta (PII — samo lastni vnos, omejena dolžina) ──
  const customerName = String(body.customerName || '').trim().slice(0, 80)
  const customerPhone = String(body.customerPhone || '').trim().slice(0, 30)
  if (!customerName) return fail('Manjka ime za prevzem.', 400)
  if (!customerPhone) return fail('Manjka telefonska številka.', 400)

  // ── dostava: naslov je OBVEZEN, pristojbina prihaja iz politike lokacije ──
  let address = ''
  let city = ''
  let postCode = ''
  let instructions = ''
  if (fulfillment === 'delivery') {
    address = String(body.address || '').trim().slice(0, 200)
    if (!address) return fail('Manjka naslov za dostavo.', 400)
    city = String(body.city || '').trim().slice(0, 80)
    postCode = String(body.postCode || '').trim().slice(0, 16)
    instructions = String(body.instructions || '').trim().slice(0, 300)
  }

  try {
    const items = await resolveGuestItems(Array.isArray(body.items) ? body.items : [], { locationId: portal.locationId })

    // minimalni znesek (politika lokacije) — proti VSOTI artiklov (brez pristojbin);
    // sporočilo je STATIČNO (znesek pokaže stran — karta ima minOrder iz GET), da
    // ga guestApiErrorKey lahko preslika v jezik gosta
    if (policy.minOrder > 0) {
      const subtotal = items.reduce((s, i) => s + (i.price + i.modifiers.reduce((m, x) => m + x.price, 0)) * i.qty, 0)
      if (subtotal + 1e-9 < policy.minOrder) {
        return fail('Košarica je pod minimalnim zneskom spletnega naročila.', 400)
      }
    }

    const isDelivery = fulfillment === 'delivery'
    const etaMinutes = policy.prepMinutes + (isDelivery ? 15 : 0)

    const { order, replayed } = await createOrderCore({
      employeeId: await systemEmployeeId(), // gost ni zaposleni; FK potrebuje sistemski vir
      locationId: portal.locationId,
      type: isDelivery ? undefined : 'TAKEAWAY', // delivery tip reši createOrderCore iz delivery bloka
      orderSource: 'web',
      customerName,
      customerPhone,
      items: items.map((i) => ({
        menuItemId: i.menuItemId,
        qty: i.qty,
        note: i.note,
        allergenWarning: i.allergenWarning,
        modifiers: i.modifiers,
      })),
      note: `Spletni portal · ${isDelivery ? 'Dostava' : 'Prevzem'}${customerName ? ` · ${customerName}` : ''}`,
      clientOperationId,
      ...(isDelivery
        ? {
            delivery: {
              address,
              city,
              postCode,
              recipientName: customerName,
              recipientPhone: customerPhone,
              deliveryInstructions: instructions,
              // denarna politika iz ROW — client deliveryFee se IGNORIRA
              deliveryFee: policy.deliveryFee,
              packagingFee: 0,
              status: 'pending',
            },
          }
        : {}),
    })

    if (!replayed) {
      // 33-c: chain polja (tamper-evidentna veriga); PII (telefon/naslov) NE gre v revizijo
      await writeAudit(db, {
        userId: null,
        action: 'GUEST_ORDER_CREATED',
        entityType: 'Order',
        entityId: order.id,
        details: `vir=web naročilo=#${order.orderNumber} način=${isDelivery ? 'dostava' : 'prevzem'} postavke=${items.length}`,
        ipAddress: ip,
        locationId: portal.locationId,
      })
      // push osebju (fail-soft — ORDER_NEW obstoječi tip v matrici obveščanja)
      void pushEvent('ORDER_NEW', {
        title: 'Novo spletno naročilo',
        body: `${isDelivery ? 'Dostava' : 'Prevzem'} · #${order.orderNumber} · ${items.length} postavk · ${num(order.total)} €`,
        url: '/dashboard?tab=narocila',
        tag: `weborder-${order.id}`,
      }, { roles: ['waiter', 'staff', 'manager'], locationId: portal.locationId })
    }

    // Javni odgovor — whitelist polj + trackKey za javno sledenje (HMAC skrivnosti)
    const trackKey = trackKeyOf(portal.trackSecret, order.orderNumber)
    return ok({
      replayed,
      orderNumber: order.orderNumber,
      status: GUEST_VISIBLE_ORDER_STATUS[String(order.status).toLowerCase()] || order.status,
      total: order.total,
      createdAt: order.createdAt,
      etaMinutes,
      track: { n: order.orderNumber, k: trackKey },
    })
  } catch (e) {
    if (e instanceof GuestError) return fail(e.message, e.status)
    if (e instanceof OrderError) return fail(e.message, e.status || 400)
    console.error('web portal order error', e)
    return fail('Naročila ni bilo mogoče varno oddati. Poskusi znova.', 500)
  }
}
