import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { writeAudit } from '@/lib/audit-chain'
import { jstr } from '@/lib/map'
import { sanitizeAllergenWarning } from '@/lib/allergen-profile'

/**
 * Issue #7 (P1, v1.104.0) — izrecno alergensko opozorilo na postavki naročila.
 *
 * PATCH /api/orders/[id]/allergen-warning
 *   { itemId, warning }      — warning ≤ 200 znakov ('' = počisti)
 *
 *  - gost ob naročilu prijavi alergijo ALI osebje doda opombo → opozorilo je
 *    VESNO na postavki (preživi premik mize, osvežitev, spremembo statusa)
 *    in se prikaže na KDS/bar postaji + kuhinjskem listu (tisk)
 *  - dovoljenje: orders.create (isti sloj kot ostale mutacije naročila) +
 *    guardResource (lokacija naročila)
 *  - NAROČILO SME BITI aktivno (open/sent/prepared) — na plačanem/preklicanem
 *    zgodovinska opozorila ostanejo nespremenjena
 *  - spreminjanje/odstranjevanje → RBAC + audit ORDER_ITEM_ALLERGEN_WARNING_SET
 *    (staro→novo, postavka izven posnetka — posnetek ob nastanku ostane)
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail('Neveljavno telo zahteve.', 400)
  }
  const itemId = String(body?.itemId || '')
  if (!itemId) return fail('itemId je obvezen.', 400)
  const warning = sanitizeAllergenWarning(body?.warning)

  const { id } = await params
  const order = await db.order.findUnique({
    where: { id },
    select: { id: true, orderNumber: true, locationId: true, status: true, paymentStatus: true },
  })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  if (['paid', 'cancelled'].includes(order.status)) {
    return fail('Naročilo je zaključeno — alergensko opozorilo je del zgodovine.', 409)
  }

  const item = await db.orderItem.findFirst({
    where: { id: itemId, orderId: id },
    select: { id: true, menuItemName: true, allergenWarning: true, voided: true },
  })
  if (!item) return fail('Postavka ne pripada naročilu.', 404)
  if (item.voided) return fail('Preklicana postavka ne spreminja alergenskega opozorila.', 409)

  if ((item.allergenWarning || '') === warning) {
    return ok({ orderId: id, itemId, warning, unchanged: true })
  }

  await db.$transaction(async (tx) => {
    await tx.orderItem.update({
      where: { id: itemId },
      data: { allergenWarning: warning },
    })
    await writeAudit(tx, {
      userId: user.sub,
      action: 'ORDER_ITEM_ALLERGEN_WARNING_SET',
      entityType: 'OrderItem',
      entityId: itemId,
      details: jstr({
        orderId: id,
        orderNumber: order.orderNumber,
        item: item.menuItemName,
        old: item.allergenWarning || '',
        new: warning,
        cleared: warning === '',
      }),
      locationId: order.locationId,
    })
  })

  return ok({ orderId: id, itemId, warning, cleared: warning === '' })
}
