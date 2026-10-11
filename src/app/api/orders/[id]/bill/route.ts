import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num, r2 } from '@/lib/map'
import { computeBill, BillItem } from '@/lib/billing'

/**
 * Issue #1 §6 — kanonični predogled računa pred plačilom (isti izračun kot FURS zaključek):
 * postavke, ročni popust, avtomatski popusti (Happy Hour), zvestoba (max unovčljive točke).
 * Uporablja requirePermission('orders.pay') — namenjen plačilnemu dialogu.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params

  const order = await db.order.findUnique({
    where: { id },
    include: { OrderItem: { include: { MenuItem: { select: { categoryId: true } } } } },
  })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: predogled računa tujega naročila ni dovoljen
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  if (order.paymentStatus === 'paid') return fail('Naročilo je že plačano.', 409)

  const location = await db.location.findUnique({
    where: { id: order.locationId },
    select: { loyaltyEnabled: true, loyaltyPointsPerEuro: true, loyaltyPointsValue: true },
  })
  if (!location) return fail('Lokacija naročila ne obstaja.', 404)

  const now = new Date()
  const autoCandidates = await db.discount.findMany({
    where: {
      locationId: order.locationId,
      isActive: true,
      triggerType: 'auto',
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      AND: [{ OR: [{ validTo: null }, { validTo: { gte: now } }] }],
    },
    select: { id: true, name: true, type: true, amount: true, happyDays: true, happyFromHour: true, happyToHour: true, targetCategoryIds: true },
  })

  const items: BillItem[] = order.OrderItem
    .filter((it) => !it.voided)
    .map((it) => ({
      id: it.id,
      menuItemId: it.menuItemId,
      name: it.menuItemName,
      quantity: it.quantity,
      unitPrice: num(it.price),
      vatRate: num(it.vatRate, 22),
      vatAmount: num(it.vatAmount),
      categoryId: it.MenuItem?.categoryId || null,
      voided: it.voided,
    }))
  const subtotal = r2(items.reduce((s, it) => s + it.unitPrice * it.quantity, 0))
  const tax = r2(items.reduce((s, it) => s + it.vatAmount, 0))

  const bill = computeBill({
    items,
    subtotal,
    tax,
    manualDiscount: num(order.discount),
    autoCandidates,
    now,
    loyaltyEnabled: location.loyaltyEnabled,
    pointsPerEuro: location.loyaltyPointsPerEuro,
    pointsValue: num(location.loyaltyPointsValue, 0.01),
  })

  return ok({ bill, order: { id: order.id, orderNumber: order.orderNumber, tableId: order.tableId, status: order.status } })
}
