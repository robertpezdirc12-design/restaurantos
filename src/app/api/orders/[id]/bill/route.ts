import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num, r2 } from '@/lib/map'
import { computeBill, splitVat, BillItem } from '@/lib/billing'

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
  // Naloga #6: cena na postavki je KONČNA (z DDV), zato je subtotal NETO osnova
  // (line − izvlečeni DDV). grossTotal = subtotal + tax = vsota prikazanih cen.
  const split = splitVat(items, (it) => it.unitPrice * it.quantity, (it) => it.vatAmount)
  const subtotal = split.net
  const tax = split.vat

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

  // ── OPS-7 (v1.68.0) — predogled PER IZSTAVEK (?checkId=) ──
  // Proporcionalni popust (zadnji neplačani izstavek absorbira ostanek — enako kot /api/furs).
  const checkIdParam = req.nextUrl.searchParams.get('checkId')
  let checkBill: ReturnType<typeof computeBill> | null = null
  let checkInfo: { id: string; checkNumber: number; paymentStatus: string; isLastUnpaid: boolean } | null = null
  if (checkIdParam) {
    const checks = await db.check.findMany({ where: { orderId: order.id }, orderBy: { checkNumber: 'asc' } })
    const target = checks.find((c) => c.id === checkIdParam)
    if (!target) return fail('Izstavek ne obstaja za to naročilo.', 404)
    const itemChecks = new Map(order.OrderItem.filter((it) => !it.voided).map((it) => [it.id, it.checkId ?? null]))
    const scopeItems = items.filter((it) => (itemChecks.get(it.id) ?? null) === target.id)
    if (scopeItems.length === 0) return fail('Izstavek ne vsebuje plačljivih postavk.', 400)
    const sSplit = splitVat(scopeItems, (it) => it.unitPrice * it.quantity, (it) => it.vatAmount)
    const sSub = sSplit.net
    const sTax = sSplit.vat
    const sGross = sSplit.gross
    const unpaidOthers = checks.filter((c) => c.id !== target.id && c.paymentStatus !== 'paid').length
    let sDiscount: number
    if (unpaidOthers === 0) {
      sDiscount = r2(Math.max(0, bill.discountTotal))
    } else {
      // razmerje na bruto osnovi — popust je odštet od končnih cen
      sDiscount = r2(Math.min(r2(bill.discountTotal * (sGross / Math.max(0.01, bill.grossTotal))), sGross))
    }
    checkBill = computeBill({
      items: scopeItems,
      subtotal: sSub,
      tax: sTax,
      manualDiscount: 0,
      autoCandidates: [],
      now,
      loyaltyEnabled: false,
      pointsPerEuro: 0,
      pointsValue: num(location.loyaltyPointsValue, 0.01),
    })
    // prepusti izračun na osnovi obsega (popust vstavi ročno — konserviranost z računom celote)
    checkBill = {
      ...checkBill,
      discountTotal: sDiscount,
      totalDue: r2(Math.max(0, sGross - sDiscount)),
      loyalty: {
        enabled: location.loyaltyEnabled,
        pointsPerEuro: Math.max(0, Math.floor(location.loyaltyPointsPerEuro || 0)),
        pointsValue: num(location.loyaltyPointsValue, 0.01),
        maxRedeemablePoints: location.loyaltyEnabled
          ? Math.floor(r2(Math.max(0, sGross - sDiscount)) / Math.max(0.01, num(location.loyaltyPointsValue, 0.01)))
          : 0,
      },
    }
    checkInfo = { id: target.id, checkNumber: target.checkNumber, paymentStatus: target.paymentStatus, isLastUnpaid: unpaidOthers === 0 }
  }

  return ok({ bill, ...(checkBill && checkInfo ? { checkBill, check: checkInfo } : {}), order: { id: order.id, orderNumber: order.orderNumber, tableId: order.tableId, status: order.status } })
}
