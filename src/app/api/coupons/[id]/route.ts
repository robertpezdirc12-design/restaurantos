import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { crmAudit } from '@/lib/crm'

/**
 * P2-10b (v1.187.0) — preklic kupona (PATCH = void).
 *
 * Samo status 'issued' je preklicljiv (redeemed je porabljen — zgodovina;
 * 'void' je končno stanje). Preklic ne briše vrstice — koda ostane sledljiva
 * v reviziji. Preklican kupon ob odkupu zavrnjen (409).
 *
 * RBAC: settings.manage + guardResource (lokacijska meja).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null) as { note?: string } | null

  const coupon = await db.coupon.findUnique({ where: { id }, select: { id: true, code: true, status: true, guestId: true, locationId: true } })
  if (!coupon) return fail('Kupon ne obstaja.', 404)
  const guard = await guardResource(user, coupon.locationId)
  if (guard) return guard
  if (coupon.status === 'redeemed') return fail('Kupon je že odkupljen — preklic ni več mogoč.', 409)
  if (coupon.status === 'void') return fail('Kupon je že preklican.', 409)

  const noteSuffix = body?.note ? String(body.note).trim().slice(0, 300) : ''
  const updated = await db.coupon.update({
    where: { id: coupon.id },
    data: { status: 'void', note: noteSuffix ? `${coupon.code}: ${noteSuffix}`.slice(0, 300) : undefined },
  })
  await crmAudit(
    'COUPON_VOIDED',
    'Coupon',
    coupon.id,
    { code: coupon.code, guestId: coupon.guestId, note: noteSuffix, by: user.name },
    { userId: user.sub, locationId: coupon.locationId },
  )
  return ok({ coupon: { id: updated.id, code: updated.code, status: updated.status } })
}

/** GET /api/coupons/[id] — podrobnosti (za UI urejevalnik, v obsegu). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const coupon = await db.coupon.findUnique({
    where: { id },
    select: {
      id: true, code: true, guestId: true, reason: true, year: true, percent: true, fixedAmount: true,
      status: true, issuedAt: true, expiresAt: true, redeemedAt: true, orderId: true, note: true,
      notifiedAt: true, notifyStatus: true, locationId: true, createdAt: true,
      Guest: { select: { firstName: true, lastName: true, email: true } },
    },
  })
  if (!coupon) return fail('Kupon ne obstaja.', 404)
  const guard = await guardResource(user, coupon.locationId)
  if (guard) return guard
  return ok({ coupon })
}
