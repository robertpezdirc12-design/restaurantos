import { NextRequest } from 'next/server'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { writeAudit } from '@/lib/audit-chain'
import { nid, ORDER_ACTIVE_DB } from '@/lib/map'
import { sendSms, smsConfigForLocation } from '@/lib/reminders'
import { newPayLinkToken, payLinkUrl } from '@/lib/paylink/core'

/**
 * P0-2 TRZNA-VRZELI (v1.85.0) — plačilna povezava za naročilo (osebje).
 *
 * POST   → ustvari (ali vrni obstoječo) javno povezavo /pay/<token> + QR + SMS (fail-soft)
 * DELETE → prekliče (revokacija — gost vidi 'preklicano', plačilo ni možno)
 *
 * Pravica: orders.pay (ista kot GET /api/orders/[id]/bill in POST /api/furs —
 * plačilni dialog). Povezava se izda SAMO za aktivna naročila v stanju 'unpaid'
 * (deljena izstavka OPS-7 'partial' je izven P0 obsega — link bi plačal celoto).
 *
 * SMS: adapter iz reminders.ts (Twilio/webhook prek Integration type='sms');
 * fail-soft — napaka pošiljanja NE blokira ustvarjanja; rezultat gre v odgovor
 * + PayLink.smsDetail. Ponovna izdaja obstoječe povezave lahko SMS ponovno
 * pošlje (ista skrivnost — ROTACIJA je eksplicitna z rotate:true).
 */

function cleanPhone(raw: unknown): string {
  return String(raw || '').replace(/[^\d+]/g, '').slice(0, 20)
}

async function sendLinkSms(
  order: { orderNumber: number; locationId: string; Location?: { name: string } | null },
  phone: string,
  url: string,
  send: boolean,
): Promise<{ sent: boolean; detail: string } | null> {
  if (!phone || !send) return null
  const cfg = await smsConfigForLocation(order.locationId)
  if (!cfg) return { sent: false, detail: 'SMS ni konfiguriran (Integrations type=sms).' }
  const r = await sendSms(cfg, phone, `${order.Location?.name || 'RestaurantOS'} — plačilo računa #${order.orderNumber}: ${url}`)
  return { sent: r.ok, detail: r.detail }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  const body = (await req.json().catch(() => null)) as {
    phone?: unknown
    expiresInHours?: unknown
    rotate?: unknown
    send?: unknown
  } | null

  const order = await db.order.findUnique({ where: { id }, include: { Location: { select: { name: true } } } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: povezava za tuje naročilo ni dovoljena (ista varovalka kot plačilo)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  if (!ORDER_ACTIVE_DB.includes(order.status)) {
    return fail('Naročilo ni več aktivno — povezave ni mogoče izdati.', 409)
  }
  if (order.paymentStatus !== 'unpaid') {
    return fail('Naročilo ni v plačljivem stanju (deljeno/plačano/stornirano).', 409)
  }

  const phone = cleanPhone(body?.phone)
  const send = body?.send !== false
  const hoursRaw = Number(body?.expiresInHours)
  const expiresInHours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(Math.max(hoursRaw, 0.25), 168) : 24

  // ── obstoječa odprta povezava: idempotentna izdaja (rotate = nova skrivnost) ──
  const existing = await db.payLink.findUnique({ where: { orderId: order.id } })
  if (existing && existing.status === 'open' && body?.rotate !== true) {
    const url = payLinkUrl(req, existing.token)
    const sms = await sendLinkSms(order, phone, url, send)
    if (sms) {
      await db.payLink
        .update({ where: { id: existing.id }, data: { smsDetail: sms.sent ? 'poslano' : sms.detail.slice(0, 120) } })
        .catch(() => {})
    }
    return ok({
      link: {
        id: existing.id,
        token: existing.token,
        url,
        status: existing.status,
        expiresAt: existing.expiresAt,
        qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 240 }),
        sms,
        existing: true,
      },
    })
  }

  // ── upsert: orderId @unique → ena vrstica na naročilo; reissue = rotacija tokena ──
  const token = newPayLinkToken()
  const url = payLinkUrl(req, token)
  const data = {
    token,
    status: 'open',
    phone,
    smsDetail: '',
    amount: null as null,
    tip: null as null,
    expiresAt: new Date(Date.now() + expiresInHours * 3600_000),
    paidAt: null as null,
    receiptId: null as null,
    createdBy: user.sub,
  }
  const link = existing
    ? await db.payLink.update({ where: { id: existing.id }, data })
    : await db.payLink.create({
        data: { id: nid(), orderId: order.id, locationId: order.locationId, ...data },
      })

  // SMS pošlji ZDAJ (z novim tokenom — stari URL ob rotaciji ne sme priti do gosta)
  const sms = await sendLinkSms(order, phone, url, send)
  if (sms) {
    await db.payLink
      .update({ where: { id: link.id }, data: { smsDetail: sms.sent ? 'poslano' : sms.detail.slice(0, 120) } })
      .catch(() => {})
  }

  await writeAudit(db, {
    userId: user.sub,
    action: 'PAY_LINK_CREATED',
    entityType: 'PayLink',
    entityId: link.id,
    details: `order=#${order.orderNumber} token=${token.slice(0, 8)}… expires=${expiresInHours}h sms=${sms ? (sms.sent ? 'sent' : 'failed') : 'off'}${existing ? ' reissue' : ''}`,
    ipAddress: req.headers.get('x-forwarded-for') || undefined,
    locationId: order.locationId,
  }).catch(() => {})

  return ok(
    {
      link: {
        id: link.id,
        token,
        url,
        status: link.status,
        expiresAt: link.expiresAt,
        qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 240 }),
        sms,
        existing: false,
      },
      order: { id: order.id, orderNumber: order.orderNumber },
    },
    201,
  )
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  const link = await db.payLink.findUnique({ where: { orderId: order.id } })
  if (!link) return fail('Plačilna povezava ne obstaja.', 404)
  if (link.status !== 'open') return fail(`Povezava je že v stanju '${link.status}'.`, 409)

  await db.payLink.update({ where: { id: link.id }, data: { status: 'revoked' } })
  await writeAudit(db, {
    userId: user.sub,
    action: 'PAY_LINK_REVOKED',
    entityType: 'PayLink',
    entityId: link.id,
    details: `order=#${order.orderNumber} token=${link.token.slice(0, 8)}…`,
    ipAddress: req.headers.get('x-forwarded-for') || undefined,
    locationId: order.locationId,
  }).catch(() => {})

  return ok({ link: { id: link.id, status: 'revoked' } })
}
