import { NextRequest } from 'next/server'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { writeAudit } from '@/lib/audit-chain'
import { nid, r2, ORDER_ACTIVE_DB } from '@/lib/map'
import { sendSms, smsConfigForLocation } from '@/lib/reminders'
import { newPayLinkToken, payLinkUrl, payLinkReady, loadOrderBill } from '@/lib/paylink/core'

/**
 * P0-2 TRZNA-VRZELI (v1.85.0) + P1-6 SPLIT PO GOSTIH (v1.87.0) — plačilne
 * povezave za naročilo (osebje).
 *
 * POST   → ustvari (ali vrni obstoječe) javne povezave /pay/<token> + QR + SMS:
 *          - { splitCount: N }  → N povezav, enakomeren split (centno natančen)
 *          - { amounts: [..] }  → neenakomeren split (vsota MORA biti = preostanek)
 *          - brez obojega       → klasična ENA povezava (delež = dinamičen
 *                                 preostanek ob plačilu — nazaj-kompatibilno)
 *          - { sms: [{linkId, phone}] } → SAMO ponovno pošiljanje SMS na
 *            obstoječih odprtih povezavah (brez rotacije tokenov)
 * DELETE → prekliče VSE odprte povezave naročila (plačanih se ne dotika —
 *          denar je že pobran; gosti vidijo 'preklicano').
 *
 * P1-6 pravila:
 *  - izdaja je dovoljena tudi na 'partial' naročilu, KADAR je parcialnost
 *    posledica plačanih deležev povezav (izdaja nad PREOSTANEK = total − pobrano);
 *  - nova split izdaja obstoječe odprte povezave SUPERSEDE-a (deleži se vedno
 *    izdajajo nad trenutni preostanek — konserviranost vsote);
 *  - največ 10 deležev, vsak ≥ 0,01 €;
 *  - znesek izračuna STREŽNIK (kanonični computeBill prek loadOrderBill).
 *
 * Pravica: orders.pay (ista kot GET /api/orders/[id]/bill in POST /api/furs —
 * plačilni dialog). Povezava se izda SAMO za aktivna naročila.
 *
 * SMS: adapter iz reminders.ts (Twilio/webhook prek Integration type='sms');
 * fail-soft — napaka pošiljanja NE blokira ustvarjanja; rezultat gre v odgovor
 * + PayLink.smsDetail.
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

interface LinkOut {
  id: string
  token: string
  url: string
  status: string
  amount: number | null
  splitIndex: number
  splitCount: number
  expiresAt: Date | null
  qrDataUrl: string
  sms: { sent: boolean; detail: string } | null
}

async function linkOut(req: NextRequest, link: { id: string; token: string; status: string; amount: unknown; splitIndex: number; splitCount: number; expiresAt: Date | null }): Promise<LinkOut> {
  return {
    id: link.id,
    token: link.token,
    url: payLinkUrl(req, link.token),
    status: link.status,
    amount: link.amount == null ? null : r2(Number(link.amount)),
    splitIndex: link.splitIndex,
    splitCount: link.splitCount,
    expiresAt: link.expiresAt,
    qrDataUrl: await QRCode.toDataURL(payLinkUrl(req, link.token), { margin: 1, width: 240 }),
    sms: null,
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  if (!(await payLinkReady())) {
    return fail('Plačilne povezave čakajo na shemsko migracijo (Enterprise → Shema migracije → paylink).', 503)
  }
  const body = (await req.json().catch(() => null)) as {
    phone?: unknown
    phones?: unknown
    sms?: unknown
    splitCount?: unknown
    amounts?: unknown
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

  // P1-6: pobrani deleži (vmesna plačila brez končnega računa)
  const paidLinks = await db.payLink.findMany({
    where: { orderId: order.id, status: 'paid', receiptId: null, amount: { not: null } },
    select: { amount: true },
  })
  const paidSum = paidLinks.length ? r2(paidLinks.reduce((s, l) => s + Number(l.amount), 0)) : 0
  if (order.paymentStatus !== 'unpaid') {
    // P1-6: partial iz povezav = izdaja nad preostanek; vse ostalo (checks
    // split, plačano, storno) ostaja zaprto — enako sporočilo kot prej.
    if (!(order.paymentStatus === 'partial' && paidLinks.length > 0)) {
      return fail('Naročilo ni v plačljivem stanju (deljeno/plačano/stornirano).', 409)
    }
  }

  const phone = cleanPhone(body?.phone)
  const phones = Array.isArray(body?.phones) ? body!.phones.map((p) => cleanPhone(p)) : []
  const send = body?.send !== false
  const hoursRaw = Number(body?.expiresInHours)
  const expiresInHours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(Math.max(hoursRaw, 0.25), 168) : 24
  const expiresAt = new Date(Date.now() + expiresInHours * 3600_000)

  const splitCountRaw = Number(body?.splitCount)
  const hasAmounts = Array.isArray(body?.amounts) && (body!.amounts as unknown[]).length > 0
  const splitIntent = (Number.isFinite(splitCountRaw) && splitCountRaw > 1) || hasAmounts

  const existingOpen = await db.payLink.findMany({
    where: { orderId: order.id, status: 'open' },
    orderBy: { createdAt: 'asc' },
  })

  // ── P1-6: SAMO ponovno pošiljanje SMS na obstoječih odprtih povezavah ──
  if (Array.isArray(body?.sms) && (body!.sms as unknown[]).length > 0 && !splitIntent && body?.rotate !== true) {
    const entries = (body!.sms as Record<string, unknown>[])
      .slice(0, 10)
      .map((e) => ({ linkId: String(e?.linkId || ''), phone: cleanPhone(e?.phone) }))
      .filter((e) => e.linkId && e.phone)
    const smsResults: { linkId: string; sms: { sent: boolean; detail: string } }[] = []
    for (const e of entries) {
      const link = existingOpen.find((l) => l.id === e.linkId)
      if (!link) continue
      const url = payLinkUrl(req, link.token)
      const s = await sendLinkSms(order, e.phone, url, true)
      if (s) {
        await db.payLink
          .update({ where: { id: link.id }, data: { phone: e.phone, smsDetail: s.sent ? 'poslano' : s.detail.slice(0, 120) } })
          .catch(() => {})
        smsResults.push({ linkId: link.id, sms: s })
      }
    }
    const links = await Promise.all(existingOpen.map((l) => linkOut(req, l)))
    for (const l of links) {
      const hit = smsResults.find((r) => r.linkId === l.id)
      if (hit) l.sms = hit.sms
    }
    return ok({ links, smsResults, order: { id: order.id, orderNumber: order.orderNumber }, existing: true })
  }

  // ── idempotentna izdaja: obstoječe odprte povezave, BREZ split namena, brez rotacije ──
  if (existingOpen.length > 0 && !splitIntent && body?.rotate !== true) {
    const links = await Promise.all(existingOpen.map((l) => linkOut(req, l)))
    // SMS: klasični phone (prva povezava) ali phones[] po poziciji (split niz)
    for (let i = 0; i < links.length; i++) {
      const target = links.length === 1 && phone ? phone : phones[i] || ''
      if (target) {
        const s = await sendLinkSms(order, target, links[i].url, send)
        if (s) {
          links[i].sms = s
          await db.payLink
            .update({ where: { id: links[i].id }, data: { smsDetail: s.sent ? 'poslano' : s.detail.slice(0, 120) } })
            .catch(() => {})
        }
      }
    }
    return ok({
      link: { ...links[0], existing: true },
      links,
      order: { id: order.id, orderNumber: order.orderNumber },
      existing: true,
    })
  }

  // ── split: deleži se izdajajo nad PREOSTANEK (total − pobrani deleži) ──
  let amounts: number[] | null = null
  if (splitIntent) {
    const billData = await loadOrderBill(order.id)
    if (!billData) return fail('Računa ni mogoče izračunati.', 409)
    const remaining = r2(billData.totalDue - paidSum)
    if (remaining < 0.01) return fail('Nič ni več za plačilo prek povezav.', 409)
    if (hasAmounts) {
      const arr = (body!.amounts as unknown[]).map((a) => r2(Number(a)))
      if (arr.length > 10) return fail('Največ 10 deležev.', 400)
      if (arr.some((a) => !Number.isFinite(a) || a < 0.01)) return fail('Vsak delež mora biti vsaj 0,01 €.', 400)
      const sum = r2(arr.reduce((s, a) => s + a, 0))
      if (Math.abs(sum - remaining) > 0.004) {
        return fail(`Vsota deležev (${sum.toFixed(2)} €) mora biti enaka preostanku za plačilo (${remaining.toFixed(2)} €).`, 400)
      }
      amounts = arr
    } else {
      if (splitCountRaw > 10) return fail('Največ 10 deležev.', 400)
      const n = Math.min(Math.max(Math.round(splitCountRaw) || 2, 2), 10)
      const cents = Math.round(remaining * 100)
      const base = Math.floor(cents / n)
      const rem = cents - base * n
      amounts = Array.from({ length: n }, (_, i) => r2((base + (i < rem ? 1 : 0)) / 100))
    }
  }

  // nova izdaja: obstoječe odprte povezave umrejo (superseded — deleži grejo čez nov preostanek)
  if (existingOpen.length > 0) {
    await db.payLink.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'superseded' } })
  }

  const n = amounts ? amounts.length : 1
  const created: { id: string; token: string; status: string; amount: unknown; splitIndex: number; splitCount: number; expiresAt: Date | null }[] = []
  for (let i = 0; i < n; i++) {
    const token = newPayLinkToken()
    const link = await db.payLink.create({
      data: {
        id: nid(),
        orderId: order.id,
        locationId: order.locationId,
        token,
        status: 'open',
        phone: amounts ? (phones[i] || '') : phone,
        smsDetail: '',
        amount: amounts ? amounts[i] : null,
        tip: null,
        splitIndex: i + 1,
        splitCount: n,
        approvalCode: '',
        expiresAt,
        paidAt: null,
        receiptId: null,
        createdBy: user.sub,
      },
    })
    created.push(link)
  }

  // SMS ZDAJ (z novimi žetoni — stari URL ob rotaciji ne sme priti do gosta)
  const links = await Promise.all(created.map((l) => linkOut(req, l)))
  for (let i = 0; i < links.length; i++) {
    const target = links.length === 1 && phone ? phone : phones[i] || ''
    if (target) {
      const s = await sendLinkSms(order, target, links[i].url, send)
      if (s) {
        links[i].sms = s
        await db.payLink
          .update({ where: { id: links[i].id }, data: { smsDetail: s.sent ? 'poslano' : s.detail.slice(0, 120) } })
          .catch(() => {})
      }
    }
  }

  await writeAudit(db, {
    userId: user.sub,
    action: amounts ? 'PAY_LINK_SPLIT_CREATED' : 'PAY_LINK_CREATED',
    entityType: 'PayLink',
    entityId: created[0].id,
    details: `order=#${order.orderNumber} shares=${n}${amounts ? ` amounts=${amounts.map((a) => a.toFixed(2)).join('|')}` : ''} tokens=${created.map((c) => c.token.slice(0, 6)).join(',')}… expires=${expiresInHours}h sms=${links.some((l) => l.sms?.sent) ? 'sent' : links.some((l) => l.sms) ? 'failed' : 'off'}${existingOpen.length ? ' supersede-open' : ''}`,
    ipAddress: req.headers.get('x-forwarded-for') || undefined,
    locationId: order.locationId,
  }).catch(() => {})

  return ok(
    {
      link: links[0],
      links,
      order: { id: order.id, orderNumber: order.orderNumber, paidViaLinks: paidSum },
      existing: false,
    },
    201,
  )
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  if (!(await payLinkReady())) {
    return fail('Plačilne povezave čakajo na shemsko migracijo (Enterprise → Shema migracije → paylink).', 503)
  }

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  // P1-6: prekliče VSE odprte povezave (plačanih NE — denar je pobran)
  const openIds = await db.payLink.findMany({ where: { orderId: order.id, status: 'open' }, select: { id: true }, orderBy: { createdAt: 'asc' } })
  if (openIds.length === 0) return fail('Odprta plačilna povezava ne obstaja.', 404)
  const res = await db.payLink.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'revoked' } })

  await writeAudit(db, {
    userId: user.sub,
    action: 'PAY_LINK_REVOKED',
    entityType: 'PayLink',
    entityId: openIds[0].id,
    details: `order=#${order.orderNumber} revoked=${res.count} tokens=${openIds.length}`,
    ipAddress: req.headers.get('x-forwarded-for') || undefined,
    locationId: order.locationId,
  }).catch(() => {})

  return ok({ revokedCount: res.count, status: 'revoked' })
}
