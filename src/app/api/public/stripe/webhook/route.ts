import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail } from '@/lib/api'
import {
  parseStripeEvent,
  resolveStripeWebhookSecret,
  stripeEventLocationHint,
  STRIPE_PAYMENT_EVENTS,
  verifyStripeSignature,
} from '@/lib/paylink/stripe-webhook'
import { auditStripeReview, settleStripeSession, type LinkRow, type OrderLite } from '@/lib/paylink/settle'

/**
 * v1.157.0 — POST /api/public/stripe/webhook
 *
 * Stripe pošlje dogodek ob plačilu; to je edina pot, ki poravna povezavo, ko se
 * gost NE vrne na stran (zaprt zavihek). Vrstni red:
 *   1. telo + podpis Stripe-Signature (brez podpisa ni branja podatkov);
 *   2. dogodek se sprejme le za checkout.session.completed /
 *      checkout.session.async_payment_succeeded in payment_status=paid;
 *   3. povezava se poišče po KANONIČNI seji (sessionId) — tuja seja se nikoli
 *      ne poravna, le zabeleži v revizijo (morebitno vračilo);
 *   4. poravnava gre skozi isto jedro kot javni POST (CAS + kanonični FURS).
 *
 * 200 = dogodek obdelan ali varno ignoriran (Stripe ne ponavlja);
 * 5xx = prehodna napaka (Stripe ponovi); 4xx = neveljaven podpis/oblika.
 * Skrivnost: STRIPE_WEBHOOK_SECRET ali Integration(type='payments').webhookSecret.
 */

const MAX_BODY_BYTES = 512 * 1024

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => null)
  if (raw == null) return fail('Neveljavna zahteva.', 400)
  if (raw.length > MAX_BODY_BYTES) return fail('Zahteva je prevelika.', 413)
  const signature = req.headers.get('stripe-signature')

  let secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim()
  if (!secret) secret = await resolveStripeWebhookSecret(stripeEventLocationHint(raw))
  if (!secret) return fail('Stripe webhook ni konfiguriran.', 503)
  if (!verifyStripeSignature(raw, signature, secret)) return fail('Neveljaven podpis.', 400)

  const event = parseStripeEvent(raw)
  if (!event) return fail('Neveljaven dogodek.', 400)
  if (!event.type || !(STRIPE_PAYMENT_EVENTS as readonly string[]).includes(event.type) || !event.session) {
    return ok({ received: true, ignored: 'event_type' })
  }
  const session = event.session
  if (!session.id) return ok({ received: true, ignored: 'invalid_session' })
  if (!session.paid) return ok({ received: true, ignored: 'not_paid' })

  const link = (await db.payLink.findFirst({ where: { sessionId: session.id } })) as LinkRow | null
  if (!link) {
    // Zajeto plačilo, ki NI kanonična seja te povezave (CAS izgubljenik,
    // zamenjana seja) — denar je pri Stripe, povezava pa se ne sme poravnati
    // sama; osebje dobi revizijsko sled za morebitno vračilo.
    const hintedId = session.metadata?.payLinkId
    if (hintedId) {
      const known = (await db.payLink.findUnique({ where: { id: hintedId } })) as LinkRow | null
      if (known) {
        const knownOrder = (await db.order.findUnique({
          where: { id: known.orderId },
          select: { id: true, orderNumber: true, status: true, paymentStatus: true, tableId: true, locationId: true },
        })) as OrderLite | null
        if (knownOrder) await auditStripeReview({ order: knownOrder, link: known, session, reason: 'unknown_session', source: 'stripe-webhook' })
      }
    }
    return ok({ received: true, settled: false, ignored: 'unknown_session' })
  }

  const order = (await db.order.findUnique({
    where: { id: link.orderId },
    select: { id: true, orderNumber: true, status: true, paymentStatus: true, tableId: true, locationId: true },
  })) as OrderLite | null
  if (!order) return ok({ received: true, settled: false, ignored: 'unknown_order' })

  const result = await settleStripeSession({
    order,
    link,
    session,
    verifySessionId: session.id,
    ip: 'stripe-webhook',
    allowExpired: true,
  })
  if (result.kind === 'settled') {
    return ok({ received: true, settled: true, replayed: result.replayed === true })
  }
  if (result.kind === 'conflict') {
    return ok({ received: true, settled: false, ignored: 'conflict', detail: result.error })
  }
  await auditStripeReview({ order, link, session, reason: result.reason, detail: result.detail, source: 'stripe-webhook' })
  return ok({ received: true, settled: false, ignored: result.reason })
}
