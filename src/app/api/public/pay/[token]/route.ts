import { NextRequest } from 'next/server'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { ok, fail } from '@/lib/api'
import { createToken } from '@/lib/auth'
import { writeAudit } from '@/lib/audit-chain'
import { r2 } from '@/lib/map'
import { rateLimitPublic, clientIp } from '@/lib/guest'
import { GET as billGET } from '@/app/api/orders/[id]/bill/route'
import {
  isPayLinkTokenShape,
  resolvePayProvider,
  simulatedCharge,
  stripeCreateCheckout,
  stripeSessionStatus,
  finalizePayLinkPayment,
  payLinkUrl,
} from '@/lib/paylink/core'

/**
 * P0-2 TRZNA-VRZELI (v1.85.0) — JAVNA plačilna povezava (brez prijave).
 *
 * GET  /api/public/pay/<token>  → stanje + račun (kanonični computeBill prek
 *                                 GET /api/orders/[id]/bill z break-glass klicem)
 * POST /api/public/pay/<token>  → plačilo (tip € EUR) — simulator odobri
 *                                 takoj; Stripe vrne redirect na Checkout sejo.
 *                                 { verifySession } = potrditev po vrnitvi.
 *
 * Varnost (iste discipline kot Issue #3 javni tok):
 *  - token (32-hex skrivnost) JE avtorizacija; ID-ji se rešijo strežniško;
 *  - znesek/napitnina se izračunata na strežniku (computeBill), clientu ne zaupamo;
 *  - plačilo izvede kanonično FURS jedro (issueFursReceipt) — CAS na naročilu
 *    varuje konkurenco s POS plačilom; idempotenca 'plk:<token>' = isti račun;
 *  - rate limit: 60 branj/min/IP + 10 plačil/min/IP;
 *  - 404 brez razlikovanja (ne uganjaj žetone).
 */

const TIP_PRESETS = [0, 5, 10, 15]

interface LinkRow {
  id: string
  token: string
  orderId: string
  locationId: string
  status: string
  amount: { toNumber: () => number } | null
  tip: { toNumber: () => number } | null
  expiresAt: Date | null
  paidAt: Date | null
  receiptId: string | null
}

interface OrderLite {
  id: string
  orderNumber: number
  status: string
  paymentStatus: string
  tableId: string | null
  locationId: string
}

/** Skupni predogled računa: break-glass klic kanonične bill rute (0 duplikata izračuna). */
async function loadBill(orderId: string): Promise<{ totalDue: number; bill: Record<string, unknown> } | null> {
  const token = createToken({ sub: 'bootstrap', name: 'Plačilna povezava', role: 'ADMIN', loc: null, sv: 0 }, 2 / 60)
  const req = new NextRequest(`http://127.0.0.1:3000/api/orders/${orderId}/bill`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const res = await billGET(req, { params: Promise.resolve({ id: orderId }) })
  if (!res.ok) return null
  const data = (await res.json().catch(() => null)) as { bill?: { totalDue?: number } } | null
  if (!data?.bill || typeof data.bill.totalDue !== 'number') return null
  return { totalDue: r2(data.bill.totalDue), bill: data.bill as Record<string, unknown> }
}

/** Odgovor za plačano povezavo (iz Receipt vrstice — št. računa, EOR/JIR, znesek). */
async function paidPayload(link: LinkRow) {
  const receipt = link.receiptId
    ? await db.receipt.findUnique({
        where: { id: link.receiptId },
        select: {
          receiptNumber: true,
          eor: true,
          zoi: true,
          cisJir: true,
          cisZki: true,
          total: true,
          tip: true,
          totalWithTip: true,
          paymentMethod: true,
          fiscalStatus: true,
        },
      })
    : null
  const loc = await db.location.findUnique({ where: { id: link.locationId }, select: { name: true } }).catch(() => null)
  return {
    status: 'paid' as const,
    paidAt: link.paidAt,
    location: { name: loc?.name || '' },
    receipt: receipt
      ? {
          receiptNumber: receipt.receiptNumber,
          eor: receipt.eor || null,
          zoi: receipt.zoi || null,
          jir: receipt.cisJir || null,
          zki: receipt.cisZki || null,
          total: r2(Number(receipt.total)),
          tip: r2(Number(receipt.tip)),
          totalWithTip: r2(Number(receipt.totalWithTip)),
          paymentMethod: receipt.paymentMethod,
          fiscalStatus: receipt.fiscalStatus,
        }
      : null,
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const ip = clientIp(req)
  if (!rateLimitPublic(`payview:${ip}:${token}`, 60)) return fail('Preveč zahtev. Počakajte trenutek.', 429)
  if (!isPayLinkTokenShape(token)) return fail('Povezava ne obstaja.', 404)

  const link = (await db.payLink.findUnique({ where: { token } })) as LinkRow | null
  if (!link) return fail('Povezava ne obstaja.', 404)
  const order = (await db.order.findUnique({
    where: { id: link.orderId },
    select: { id: true, orderNumber: true, status: true, paymentStatus: true, tableId: true, locationId: true },
  })) as OrderLite | null
  if (!order) return fail('Povezava ne obstaja.', 404)

  // plačano prek povezave
  if (link.status === 'paid') return ok(await paidPayload(link))
  if (link.status === 'revoked') return ok({ status: 'revoked' })
  // terminalna naročila (storno/preklic) → povezava mrtva
  if (order.paymentStatus === 'storno' || order.paymentStatus === 'cancelled' || order.status === 'cancelled') {
    if (link.status === 'open') await db.payLink.update({ where: { id: link.id }, data: { status: 'revoked' } }).catch(() => {})
    return ok({ status: 'revoked' })
  }
  // plačano drugje (POS) → superseded (leni prehod)
  if (order.paymentStatus !== 'unpaid') {
    if (link.status === 'open') await db.payLink.update({ where: { id: link.id }, data: { status: 'superseded' } }).catch(() => {})
    return ok({ status: 'superseded' })
  }
  if (link.status === 'superseded') return ok({ status: 'superseded' })
  // poteklo
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return ok({ status: 'expired' })

  // ── odprto: kanonični račun + kontekst za gosta (brez PII) ──
  const billData = await loadBill(order.id)
  if (!billData) return fail('Računa ni mogoče izračunati.', 409)
  const [table, location] = await Promise.all([
    order.tableId ? db.table.findUnique({ where: { id: order.tableId }, select: { number: true } }) : null,
    db.location.findUnique({ where: { id: order.locationId }, select: { name: true } }),
  ])
  const provider = await resolvePayProvider(order.locationId)
  return ok({
    status: 'open',
    provider: provider.kind,
    expiresAt: link.expiresAt,
    order: { orderNumber: order.orderNumber, table: table ? `Miza ${table.number}` : null },
    location: { name: location?.name || '' },
    bill: {
      subtotal: billData.bill['subtotal'],
      tax: billData.bill['tax'],
      discountTotal: billData.bill['discountTotal'],
      totalDue: billData.totalDue,
    },
    tipPresets: TIP_PRESETS,
  })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const ip = clientIp(req)
  if (!rateLimitPublic(`paypost:${ip}:${token}`, 10)) return fail('Preveč poskusov plačila. Počakajte trenutek.', 429)
  if (!isPayLinkTokenShape(token)) return fail('Povezava ne obstaja.', 404)
  const body = (await req.json().catch(() => null)) as { tip?: unknown; verifySession?: unknown } | null

  const link = (await db.payLink.findUnique({ where: { token } })) as LinkRow | null
  if (!link) return fail('Povezava ne obstaja.', 404)
  const order = (await db.order.findUnique({
    where: { id: link.orderId },
    select: { id: true, orderNumber: true, status: true, paymentStatus: true, tableId: true, locationId: true },
  })) as OrderLite | null
  if (!order) return fail('Povezava ne obstaja.', 404)

  if (link.status === 'paid') return fail('Račun je že plačan.', 409)
  if (link.status === 'revoked' || order.paymentStatus === 'storno' || order.paymentStatus === 'cancelled') {
    return fail('Povezava je preklicana.', 409)
  }
  if (order.paymentStatus !== 'unpaid' || link.status === 'superseded') {
    if (link.status === 'open') await db.payLink.update({ where: { id: link.id }, data: { status: 'superseded' } }).catch(() => {})
    return fail('Naročilo je že plačano drugje.', 409)
  }
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return fail('Povezava je potekla. Prosimo, zaprosite osebje za novo.', 409)
  }

  const provider = await resolvePayProvider(order.locationId)

  // ── Stripe potrditev po vrnitvi ({ verifySession }) ──
  const verifySession = String(body?.verifySession || '').trim()
  if (verifySession) {
    if (provider.kind !== 'stripe' || !provider.secretKey) return fail('Potrditev seje ni na voljo.', 400)
    if (link.amount == null || link.tip == null) return fail('Seja ni bila ustvarjena.', 409)
    const status = await stripeSessionStatus(provider.secretKey, verifySession)
    if (!status.paid) return fail('Plačilo še ni potrjeno.', 409)
    // neposrednost: znesek seje se mora ujemati z zaklenjenim zneskom povezave
    const expected = Math.round(Number(link.amount) * 100)
    if (status.amountTotalCents != null && status.amountTotalCents !== expected) {
      return fail('Znesek seje se ne ujema s povezavo.', 409)
    }
    const approvalCode = (status.paymentIntent || `stripe-${verifySession.slice(0, 20)}`).slice(0, 40)
    return finalize(order, link, Number(link.tip), approvalCode, ip, token)
  }

  // ── plačilo: najprej kanonični račun (napitnina ≤ skupaj) ──
  const tipRaw = Number(body?.tip)
  const billData = await loadBill(order.id)
  if (!billData) return fail('Računa ni mogoče izračunati.', 409)
  const tip = Number.isFinite(tipRaw) ? r2(tipRaw) : 0
  if (tip < 0 || tip > billData.totalDue) return fail('Napitnina je izven dovoljenega obsega (0 do zneska računa).', 400)

  if (provider.kind === 'stripe' && provider.secretKey) {
    const origin = payLinkUrl(req, token).slice(0, -(token.length + 1)) // .../pay
    const session = await stripeCreateCheckout({
      secretKey: provider.secretKey,
      amountCents: Math.round((billData.totalDue + tip) * 100),
      currency: 'eur',
      description: `Račun #${order.orderNumber}`,
      successUrl: `${origin}/${token}?s={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/${token}`,
    })
    await db.payLink.update({
      where: { id: link.id },
      data: { amount: r2(billData.totalDue + tip), tip },
    })
    return ok({ redirect: session.url, sessionId: session.sessionId, amount: r2(billData.totalDue + tip) }, 201)
  }

  // ── simulator: odobritev + kanonični FURS zaključek ──
  const charge = await simulatedCharge(billData.totalDue + tip)
  return finalize(order, link, tip, charge.approvalCode, ip, token)
}

/** Skupni zaključek: FURS jedro (idempotenčno) + PayLink stanje + audit. */
async function finalize(
  order: OrderLite,
  link: LinkRow,
  tip: number,
  approvalCode: string,
  ip: string,
  token: string,
) {
  const result = await finalizePayLinkPayment({ payLinkToken: token, orderId: order.id, tip, approvalCode, ip })
  if (!result.ok) {
    // CAS spor (POS je medtem plačal) → superseded, gost vidi prijazno stanje
    if (result.status === 409) {
      await db.payLink.update({ where: { id: link.id }, data: { status: 'superseded' } }).catch(() => {})
      return fail('Naročilo je že plačano drugje.', 409)
    }
    return fail(result.error, result.status)
  }
  const receiptId = String((result.invoice as Record<string, unknown>)['id'] || '') || null
  await db.payLink.update({
    where: { id: link.id },
    data: { status: 'paid', paidAt: new Date(), receiptId },
  })
  if (!result.replayed) {
    await writeAudit(db, {
      userId: null,
      action: 'PAY_LINK_PAID',
      entityType: 'PayLink',
      entityId: link.id,
      details: `order=#${order.orderNumber} token=${token.slice(0, 8)}… tip=${r2(tip).toFixed(2)} approval=${approvalCode.slice(0, 20)}`,
      ipAddress: ip,
      locationId: order.locationId,
    }).catch(() => {})
  }
  const refreshed = (await db.payLink.findUnique({ where: { id: link.id } })) as LinkRow | null
  return ok({ ...(refreshed ? await paidPayload(refreshed) : { status: 'paid' }), replayed: result.replayed })
}
