/**
 * Webhook za dostavne platforme (issue #2 — obnova manjkajoče integracije).
 * Pokriva originalni produkcijski poti: /api/delivery/webhook/glovo in /api/delivery/webhook/wolt
 * (dokaz: build log zadnjega originalnega Vercel deploymenta). Izviren payload contract je
 * NOT_RECOVERABLE — preslikava je tolerantna (src/lib/delivery.ts).
 *
 * Varnost: HMAC-SHA256 podpis (timingSafeEqual) PRED zapisom, rate limiting,
 * idempotencija prek Order.idempotencyKey (`glovo:<id>`/`wolt:<id>` — podvojeni
 * webhook ne ustvari dvojnega naročila), IntegrationLog (napake vidne v Dnevniku
 * napak) + AuditLog, telefon maskiran v logih.
 */
import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { nid, jstr, num } from '@/lib/map'
import { createOrderCore, OrderError } from '@/lib/ops'
import {
  rateLimit, verifyWebhookSignature, getPlatformSecret, maskPhone,
  mapGlovoPayload, mapWoltPayload, validateMapped, webhookIdempotencyKey,
} from '@/lib/delivery'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PROVIDERS = new Set(['glovo', 'wolt'])

/** Zaposleni, pod katerim gre platformsko naročilo (sistemski vir, FK zahteva obstoj). */
async function systemEmployeeId(): Promise<string | null> {
  const mgr = await db.employee.findFirst({
    where: { role: { in: ['admin', 'manager'] }, status: 'active' },
    select: { id: true },
  })
  if (mgr) return mgr.id
  const any = await db.employee.findFirst({ select: { id: true } })
  return any?.id ?? null
}

async function logIntegration(
  provider: string, integrationId: string | null, action: string, status: string,
  statusCode: number, errorMessage: string, durationMs: number, requestData: unknown,
) {
  if (!integrationId) return
  await db.integrationLog.create({
    data: {
      id: nid(),
      integrationId,
      action,
      direction: 'inbound',
      status,
      statusCode,
      errorMessage: errorMessage.slice(0, 500),
      durationMs,
      requestData: jstr(requestData).slice(0, 2000),
      responseData: '{}',
    },
  }).catch(() => null)
}

async function writeAudit(
  userId: string, action: string, entityType: string, entityId: string | null, details: unknown,
) {
  await db.auditLog.create({
    data: { id: nid(), userId, action, entityType, entityId, details: jstr(details).slice(0, 2000) },
  }).catch(() => null)
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const t0 = Date.now()
  const { provider } = await params
  const p = provider?.toLowerCase() ?? ''
  if (!PROVIDERS.has(p)) return fail('Neznana dostavna platforma.', 404)

  // Rate limiting (javni endpoint)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimit(`${p}:${ip}`)) {
    return fail('Preveč zahtev — rate limit.', 429)
  }

  // Secret: Integration.apiSecret (DB) ali env; brez njega endpoint NE deluje (pravilo #2: secret ni v source)
  const secret = await getPlatformSecret(p)
  const integration = await db.integration.findFirst({ where: { provider: p }, select: { id: true } })
  const integrationId = integration?.id ?? null

  // Podpis preverjen PRED čim koli drugim (raw body!)
  const raw = await req.text()
  const sigHeader = req.headers.get('x-glovo-signature') || req.headers.get('x-wolt-signature')
    || req.headers.get('x-signature') || req.headers.get('x-hub-signature-256')
  if (!secret) {
    await logIntegration(p, integrationId, 'webhook', 'skipped', 503,
      'Webhook secret ni nastavljen (Integration.apiSecret ali env).', Date.now() - t0, null)
    return fail('Dostavna integracija ni konfigurirana.', 503)
  }
  if (!verifyWebhookSignature(raw, sigHeader, secret)) {
    await logIntegration(p, integrationId, 'webhook', 'error', 401,
      'Neveljaven/manjkajoč podpis.', Date.now() - t0, null)
    await writeAudit('system', 'DELIVERY_WEBHOOK_REJECTED', 'Integration', integrationId, {
      provider: p, reason: 'invalid_signature', ip,
    })
    return fail('Neveljaven podpis.', 401)
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    await logIntegration(p, integrationId, 'webhook', 'error', 400, 'Payload ni veljaven JSON.', Date.now() - t0, null)
    return fail('Payload ni veljaven JSON.', 400)
  }

  try {
    // Preslikava payloada (tolerantna, rekonstruirana)
    const mapped = p === 'glovo' ? await mapGlovoPayload(body) : await mapWoltPayload(body)

    // Platformski status dogodki (npr. preklic s strani platforme)
    const evtStatus = String(
      body.status
      ?? (body.order as Record<string, unknown> | undefined)?.status
      ?? body.event ?? '',
    ).toLowerCase()

    if (evtStatus.includes('cancel')) {
      const idem = webhookIdempotencyKey(p as 'glovo' | 'wolt', mapped.platformOrderId)
      const existing = await db.order.findUnique({ where: { idempotencyKey: idem }, select: { id: true, status: true } })
      if (existing && existing.status !== 'paid') {
        await db.order.update({ where: { id: existing.id }, data: { status: 'cancelled', cancelReason: `Preklic prek ${p} webhooka` } })
        await db.deliveryInfo.updateMany({ where: { Order: { id: existing.id } }, data: { status: 'cancelled' } })
        await writeAudit('system', 'DELIVERY_ORDER_CANCELLED', 'Order', existing.id, { provider: p })
        await logIntegration(p, integrationId, 'order.cancelled', 'success', 200, '', Date.now() - t0, { platformOrderId: mapped.platformOrderId })
        return ok({ received: true, cancelled: true })
      }
      await logIntegration(p, integrationId, 'webhook', 'success', 200, '', Date.now() - t0, { note: 'cancel brez obstoječega naročila' })
      return ok({ received: true, ignored: true })
    }

    const invalid = validateMapped(mapped)
    if (invalid) {
      await logIntegration(p, integrationId, 'order.create', 'error', 422, invalid, Date.now() - t0, body)
      await writeAudit('system', 'DELIVERY_WEBHOOK_ERROR', 'Integration', integrationId, {
        provider: p, reason: 'mapping', detail: invalid,
      })
      return fail(invalid, 422)
    }

    const employeeId = await systemEmployeeId()
    if (!employeeId) {
      await logIntegration(p, integrationId, 'order.create', 'error', 503, 'Ni zaposlenega za sistemski vir.', Date.now() - t0, null)
      return fail('Sistem ni pripravljen (ni zaposlenih).', 503)
    }

    const { order, replayed } = await createOrderCore({
      employeeId,
      locationId: null,
      items: mapped.items,
      type: 'DELIVERY',
      note: mapped.note,
      clientOperationId: webhookIdempotencyKey(p as 'glovo' | 'wolt', mapped.platformOrderId),
      delivery: {
        address: mapped.address,
        city: mapped.city,
        postCode: mapped.postCode,
        recipientName: mapped.recipientName,
        recipientPhone: mapped.recipientPhone,
        deliveryInstructions: mapped.instructions,
        deliveryFee: num(mapped.deliveryFee),
        packagingFee: num(mapped.packagingFee),
        status: 'confirmed',
      },
    })

    if (replayed) {
      // Idempotenten replay — podvojeni webhook NE ustvari dvojnega naročila
      await logIntegration(p, integrationId, 'order.create', 'success', 200, '', Date.now() - t0, { replayed: true, platformOrderId: mapped.platformOrderId })
      return ok({ received: true, replayed: true, orderNumber: order.orderNumber })
    }

    await writeAudit('system', 'DELIVERY_ORDER_RECEIVED', 'Order', order.id, {
      provider: p, platformOrderId: mapped.platformOrderId, orderNumber: order.orderNumber,
      total: order.total, phone: maskPhone(mapped.recipientPhone), items: mapped.items.length,
    })
    await logIntegration(p, integrationId, 'order.create', 'success', 200, '', Date.now() - t0, { platformOrderId: mapped.platformOrderId })
    return ok({ received: true, orderNumber: order.orderNumber, orderId: order.id })
  } catch (e) {
    const status = e instanceof OrderError ? 422 : 500
    const msg = e instanceof Error ? e.message : 'Neznana napaka.'
    await logIntegration(p, integrationId, 'order.create', 'error', status, msg, Date.now() - t0, body)
    await writeAudit('system', 'DELIVERY_WEBHOOK_ERROR', 'Integration', integrationId, { provider: p, error: msg })
    return fail(msg, status)
  }
}

/** Health/verify hook za platforme (ne spremeni ničesar). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  if (!PROVIDERS.has(provider?.toLowerCase() ?? '')) return fail('Neznana dostavna platforma.', 404)
  return ok({ ok: true, provider: provider.toLowerCase(), webhook: 'ready' })
}
