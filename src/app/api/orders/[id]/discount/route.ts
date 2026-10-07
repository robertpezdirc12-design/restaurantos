import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num, r2, jstr } from '@/lib/map'
import { discountAmountOf } from '@/lib/billing'

/**
 * Issue #1 §6 — ročni popust na naročilo (check-level).
 * - POST: { discountId } (iz registra popustov) ALI { name, type, amount } (ad-hoc, vedno audit)
 * - DELETE: odstrani ročni popust
 * Zahteva apply_discounts. Znesek se shrani na Order.discount (kanonično polje); končni
 * izračun (vključno s Happy Hour) se vedno izvede ob plačilu prek billing.ts.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'apply_discounts')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: { where: { voided: false } } } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  if (order.paymentStatus === 'paid') return fail('Naročilo je že plačano.', 409)

  const now = new Date()
  let discountName = ''
  let amount = 0
  let discountId: string | null = null

  if (body?.discountId) {
    const d = await db.discount.findUnique({ where: { id: String(body.discountId) } })
    if (!d || !d.isActive) return fail('Popust ne obstaja ali ni aktiven.', 404)
    if (d.locationId !== order.locationId) return fail('Popust ni za to lokacijo.', 400)
    if (d.triggerType === 'auto') return fail('Avtomatski popust (Happy Hour) se uporabi samodejno ob plačilu.', 400)
    // veljavnost
    if (d.validFrom && d.validFrom > now) return fail('Popust še ni veljaven.', 400)
    if (d.validTo && d.validTo < now) return fail('Popust je pretekel.', 400)
    if (d.maxUses != null && d.currentUses >= d.maxUses) return fail('Popust je dosegel omejitev uporabe.', 409)
    const subtotal = r2(order.OrderItem.reduce((s, it) => s + num(it.price) * it.quantity, 0))
    amount = discountAmountOf(d, subtotal)
    discountName = d.name
    discountId = d.id
    await db.discount.update({ where: { id: d.id }, data: { currentUses: { increment: 1 } } })
  } else {
    const type = String(body?.type || '').toLowerCase()
    const val = num(body?.amount)
    if (!['percent', 'fixed'].includes(type)) return fail('Vrsta mora biti percent ali fixed.', 400)
    if (!(val > 0)) return fail('Znesek/odstotek mora biti večji od 0.', 400)
    if (type === 'percent' && val > 100) return fail('Odstotek ne sme presegati 100.', 400)
    const subtotal = r2(order.OrderItem.reduce((s, it) => s + num(it.price) * it.quantity, 0))
    amount = type === 'percent' ? r2(Math.min((subtotal * val) / 100, subtotal)) : r2(Math.min(val, subtotal))
    discountName = String(body?.name || 'Ročni popust').trim().slice(0, 120)
  }

  if (amount <= 0) return fail('Popust ima ničelen znesek na tem računu.', 400)

  const updated = await db.order.update({
    where: { id },
    data: { discount: amount },
  })
  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'DISCOUNT_APPLIED',
      entityType: 'Order',
      entityId: id,
      details: jstr({ discountId, name: discountName, amount, orderNumber: order.orderNumber, previousDiscount: num(order.discount) }),
      locationId: order.locationId,
    },
  })
  return ok({ discount: num(updated.discount), discountId, name: discountName })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'apply_discounts')
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  if (order.paymentStatus === 'paid') return fail('Naročilo je že plačano.', 409)
  const previous = num(order.discount)
  await db.order.update({ where: { id }, data: { discount: 0 } })
  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'DISCOUNT_REMOVED',
      entityType: 'Order',
      entityId: id,
      details: jstr({ removedAmount: previous, orderNumber: order.orderNumber }),
      locationId: order.locationId,
    },
  })
  return ok({ removed: true, previous })
}
