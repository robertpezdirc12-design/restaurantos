import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr, num, r2 } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * OPS-7 (v1.68.0) — SPLIT PO IZSTAVKIH (Check, Toast/Lightspeed vzorec).
 *
 * GET    /api/orders/[id]/checks        → izstavki + postavke + predogled
 * POST   {itemIds: string[]}            → razdeli: izbrane (še neplačane) postavke prenese
 *                                         v NOV izstavek (ob prvem klicu ustvari izstavek #1
 *                                         z vsemi preostalimi postavkami)
 * DELETE {checkId}                      → združi nazaj: postavke izstavka vrne v izstavek
 *                                         z najnižjo številko, izstavek se izbriše
 *
 * Pravila:
 *  - dovoljenje `orders.pay` (namen: plačilni dialog);
 *  - delitev dovoljena SAMO dokler ni plačan še noben izstavek (konserviranost popustov
 *    — proporcionalna razdelitev pri plačilu, zadnji izstavek absorbira ostanek);
 *  - samo ne-voided postavke tega naročila; naročilo mora biti odprto.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  const checks = await db.check.findMany({
    where: { orderId: id },
    orderBy: { checkNumber: 'asc' },
    include: { Payment: { select: { id: true, amount: true, type: true } } },
  })
  const items = order.OrderItem.filter((it) => !it.voided).map((it) => {
    const chk = it.checkId ? checks.find((c) => c.id === it.checkId) : checks[0]
    return {
      id: it.id,
      name: it.menuItemName,
      quantity: it.quantity,
      price: num(it.price),
      vatRate: num(it.vatRate, 22),
      lineTotal: r2(num(it.price) * it.quantity),
      checkId: chk?.id ?? null,
      checkNumber: chk?.checkNumber ?? null,
    }
  })
  return ok({
    checks: checks.map((c) => ({ id: c.id, checkNumber: c.checkNumber, paymentStatus: c.paymentStatus, payments: c.Payment.length })),
    items,
    checkCount: checks.length,
  })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const itemIds = Array.isArray(body?.itemIds)
    ? [...new Set((body.itemIds as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]
    : []
  if (itemIds.length === 0) return fail('itemIds (seznam postavk) je obvezen.', 400)

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    return fail('Zaključenega naročila ni mogoče razdeliti.', 409)
  }

  const checks = await db.check.findMany({ where: { orderId: id }, orderBy: { checkNumber: 'asc' } })
  if (checks.some((c) => c.paymentStatus === 'paid')) {
    return fail('Razdelitev po izstavkih je dovoljena samo dokler ni plačan še noben izstavek.', 409)
  }

  const selected = order.OrderItem.filter((it) => itemIds.includes(it.id))
  if (selected.length === 0) return fail('Nobena izbrana postavka ne pripada temu naročilu.', 400)
  if (selected.some((it) => it.voided)) return fail('Stornirane postavke ni mogoče razdeliti.', 400)
  const movable = order.OrderItem.filter((it) => !it.voided)
  if (selected.length === movable.length) {
    return fail('Vseh postavk ni mogoče premakniti — vsaj ena mora ostati v obstoječem izstavku.', 400)
  }

  const newCheck = await db.$transaction(async (tx) => {
    let baseCheck = checks[0] ?? null
    if (!baseCheck) {
      // prvi split: izstavek #1 z VSEM postavkami, izbrane gredo v #2
      baseCheck = await tx.check.create({
        data: { id: nid(), checkNumber: 1, orderId: id, paymentStatus: 'unpaid' },
      })
      await tx.orderItem.updateMany({
        where: { orderId: id, voided: false },
        data: { checkId: baseCheck.id },
      })
    }
    const nextNumber = (checks[checks.length - 1]?.checkNumber ?? baseCheck.checkNumber) + 1
    const created = await tx.check.create({
      data: { id: nid(), checkNumber: nextNumber, orderId: id, paymentStatus: 'unpaid' },
    })
    await tx.orderItem.updateMany({
      where: { id: { in: selected.map((it) => it.id) } },
      data: { checkId: created.id },
    })
    await writeAudit(tx, { userId: user.sub, action: 'ORDER_CHECK_SPLIT', entityType: 'Order', entityId: id, details: jstr({ newCheckId: created.id, checkNumber: nextNumber, items: selected.length, by: user.name }), locationId: order.locationId })
    return created
  })

  return ok({ check: { id: newCheck.id, checkNumber: newCheck.checkNumber }, movedItems: selected.length })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const checkId = typeof body?.checkId === 'string' ? body.checkId.trim() : ''
  if (!checkId) return fail('checkId je obvezen.', 400)

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  const checks = await db.check.findMany({ where: { orderId: id }, orderBy: { checkNumber: 'asc' } })
  const target = checks.find((c) => c.id === checkId)
  if (!target) return fail('Izstavek ne obstaja.', 404)
  if (checks.some((c) => c.paymentStatus === 'paid')) {
    return fail('Združevanje je dovoljeno samo dokler ni plačan še noben izstavek.', 409)
  }
  if (checks.length <= 1) return fail('Naročilo ni razdeljeno.', 400)
  const keeper = checks.find((c) => c.id !== checkId)
  if (!keeper) return fail('Ni ohranjenega izstavka.', 400)

  await db.$transaction(async (tx) => {
    await tx.orderItem.updateMany({ where: { checkId, orderId: id }, data: { checkId: keeper.id } })
    await tx.check.delete({ where: { id: checkId } })
    await writeAudit(tx, { userId: user.sub, action: 'ORDER_CHECK_MERGE', entityType: 'Order', entityId: id, details: jstr({ mergedCheckId: checkId, checkNumber: target.checkNumber, into: keeper.checkNumber, by: user.name }), locationId: order.locationId })
  })

  return ok({ merged: true })
}
