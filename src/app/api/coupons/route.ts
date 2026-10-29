import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, locationScope, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { COUPON_REASONS, COUPON_STATUSES } from '@/lib/coupons'
import { createManualCoupon } from '@/lib/coupons-run'

/**
 * P2-10b (v1.187.0) — kuponi: seznam (v obsegu uporabnika) + ročna izdaja.
 *
 * GET  /api/coupons?status=&guestId=&reason=&take=  — seznam z osnovnimi filtri.
 * POST /api/coupons { guestId, percent | fixedAmount, expiresAt?, note? }
 *      — ročna izdaja (reason 'manual'). Politika: točno EN vir
 *      vrednosti (odstotek 1–100 ALI fiksni znesek > 0), poteče v prihodnosti.
 *
 * RBAC: settings.manage (denarna politika — izdaja popusta je finančna odločitev;
 * uporaba kupona na POS pa gre prek apply_discounts v discount ruti).
 * Ruta ni namenjena rojstnodnevnim kuponom (te izdaja dnevni cron idempotentno).
 */

const MAX_TAKE = 200

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const scope = await locationScope(user)
  const url = new URL(req.url)
  const status = url.searchParams.get('status') ?? ''
  const guestId = url.searchParams.get('guestId') ?? ''
  const reason = url.searchParams.get('reason') ?? ''
  const take = Math.max(1, Math.min(Number(url.searchParams.get('take')) || 50, MAX_TAKE))
  const coupons = await db.coupon.findMany({
    where: {
      ...scope,
      ...(status && (COUPON_STATUSES as readonly string[]).includes(status) ? { status } : {}),
      ...(reason && (COUPON_REASONS as readonly string[]).includes(reason) ? { reason } : {}),
      ...(guestId ? { guestId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true, code: true, guestId: true, reason: true, year: true, percent: true, fixedAmount: true,
      status: true, issuedAt: true, expiresAt: true, redeemedAt: true, orderId: true, note: true,
      notifiedAt: true, notifyStatus: true, locationId: true, createdAt: true,
      Guest: { select: { firstName: true, lastName: true, email: true } },
    },
  })
  return ok({ coupons })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as {
    guestId?: string; percent?: number | string; fixedAmount?: number | string;
    expiresAt?: string; daysValid?: number | string; note?: string; locationId?: string
  } | null
  if (!body) return fail('Neveljavno telo zahteve.', 400)

  const guestId = String(body.guestId ?? '').trim()
  if (!guestId) return fail('Gost je obvezen.', 400)
  const guest = await db.guest.findUnique({ where: { id: guestId }, select: { id: true, firstName: true, lastName: true, locationId: true } })
  if (!guest) return fail('Gost ne obstaja.', 404)

  // Lokacijska meja: izdajatelj sme izdajati v svojem obsegu (gostova lokacija).
  const loc = requireUserLocation(user, guest.locationId ?? body.locationId)
  if (typeof loc !== 'string') return loc
  const org = await assertOrgScope(user, loc)
  if (org) return org

  const hasPercent = body.percent !== undefined && body.percent !== null && body.percent !== ''
  const hasFixed = body.fixedAmount !== undefined && body.fixedAmount !== null && body.fixedAmount !== ''
  if (hasPercent && hasFixed) return fail('Izberite odstotek ALI fiksni znesek — ne obojega.', 400)
  if (!hasPercent && !hasFixed) return fail('Manjka vrednost kupona (odstotek ali fiksni znesek).', 400)

  let percent: number | null = null
  let fixedAmount: number | null = null
  if (hasPercent) {
    const p = Number(body.percent)
    if (!Number.isInteger(p) || p < 1 || p > 100) return fail('Odstotek mora biti celo število 1–100.', 400)
    percent = p
  } else {
    const f = Number(body.fixedAmount)
    if (!Number.isFinite(f) || f <= 0) return fail('Fiksni znesek mora biti večji od 0.', 400)
    if (f > 10000) return fail('Fiksni znesek presega dovoljeno mejo (10.000 €).', 400)
    fixedAmount = Math.round(f * 100) / 100
  }

  const now = new Date()
  let expiresAt: Date
  if (body.expiresAt) {
    expiresAt = new Date(String(body.expiresAt))
    if (Number.isNaN(expiresAt.getTime())) return fail('Neveljaven datum poteke (ISO).', 400)
  } else {
    const days = Math.max(1, Math.min(Number(body.daysValid) || 30, 365))
    expiresAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59, 59, 0)
  }
  if (expiresAt.getTime() <= now.getTime()) return fail('Poteče mora biti v prihodnosti.', 400)

  const created = await createManualCoupon({
    guestId: guest.id,
    percent,
    fixedAmount,
    expiresAt,
    note: String(body.note ?? '').trim(),
    issuedBy: user.sub,
  })
  if (!created.ok) return fail(created.error, 500)
  return ok({ coupon: { id: created.couponId, code: created.code, guestId: guest.id, guestName: `${guest.firstName} ${guest.lastName}`.trim(), percent, fixedAmount, status: 'issued', expiresAt } }, 201)
}
