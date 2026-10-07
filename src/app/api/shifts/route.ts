import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, locationScope } from '@/lib/api'
import { mapShift, nid, num, r2, jparse } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const shifts = await db.cashRegisterShift.findMany({
    // Issue #4 §1: izmene po lokaciji (CashRegisterShift.locationId); POST ostaja lastna izmena
    where: locationScope(user),
    include: { Employee: { select: { name: true, role: true } } },
    orderBy: { openedAt: 'desc' },
    take: 30,
  })
  return ok({ shifts: shifts.map((s) => mapShift({ ...s, employee: s.Employee ?? null })) })
}

/**
 * Zaključek izmene (issue #1: end-to-end prodaja → poročilo/audit).
 * Izračun iz Receipts (fiskalni dokumenti) v oknu izmene:
 *  - promet po načinih plačila, DDV razčlenba (22/9.5/0), št. računov, napitnine
 *  - posodobi CashRegisterShift totals + ustvari ZReport + AuditLog SHIFT_CLOSE
 */
export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)

  if (body?.action === 'stop') {
    const open = await db.cashRegisterShift.findFirst({
      where: { employeeId: user.sub, status: 'open' },
      orderBy: { openedAt: 'desc' },
    })
    if (!open) return fail('Ni odprte izmene.')
    const closingCash = num(body.closingCash)
    const from = open.openedAt
    const to = new Date()

    // izračun iz fiskalnih računov v oknu izmene
    const receipts = await db.receipt.findMany({
      where: { locationId: open.locationId || undefined, createdAt: { gte: from, lte: to } },
      include: { Order: { select: { type: true, splitCount: true, tip: true, discount: true } } },
    })
    let cash = 0, card = 0, mobile = 0, alternate = 0, totalSales = 0, totalTax = 0
    let totalTips = 0, totalDiscounts = 0, guests = 0
    let dineIn = 0, takeout = 0, delivery = 0
    const vatBuckets: Record<string, { net: number; vat: number }> = {}
    for (const rc of receipts) {
      const amount = num(rc.total)
      totalSales += amount
      totalTax += num(rc.totalVat)
      totalTips += num(rc.tip)
      totalDiscounts += num(rc.discount)
      switch (rc.paymentMethod) {
        case 'cash': cash += amount; break
        case 'card': card += amount; break
        case 'mobile': mobile += amount; break
        default: alternate += amount
      }
      const orderType = rc.Order?.type
      if (orderType === 'takeaway') takeout += amount
      else if (orderType === 'delivery') delivery += amount
      else dineIn += amount
      guests += rc.Order?.splitCount || 0
      // DDV razčlenba iz vatBreakdown (neto konvencija — ključi so stopnje)
      const vb = jparse<Record<string, { base: number; vat: number }>>(rc.vatBreakdown, {})
      for (const [rate, v] of Object.entries(vb)) {
        const key = Number(rate) === 0 ? '0' : Number(rate) <= 9.5 ? '9.5' : '22'
        if (!vatBuckets[key]) vatBuckets[key] = { net: 0, vat: 0 }
        vatBuckets[key].net += num(v.base)
        vatBuckets[key].vat += num(v.vat)
      }
    }
    const expectedCash = num(open.startingCash) + cash
    const r = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
    const std = vatBuckets['22'] || { net: 0, vat: 0 }
    const red = vatBuckets['9.5'] || { net: 0, vat: 0 }
    const zero = vatBuckets['0'] || { net: 0, vat: 0 }

    const [shift, zreport] = await db.$transaction([
      db.cashRegisterShift.update({
        where: { id: open.id },
        data: {
          status: 'closed',
          closedAt: to,
          closingCash,
          expectedCash: r(expectedCash),
          cashSales: r(cash),
          cardSales: r(card),
          mobileSales: r(mobile),
          alternateSales: r(alternate),
          totalSales: r(totalSales),
          totalOrders: receipts.length,
          totalDiscounts: r(totalDiscounts),
          totalTips: r(totalTips),
          cashDifference: r(closingCash - expectedCash),
        },
      }),
      db.zReport.create({
        data: {
          id: nid(),
          reportDate: from,
          openedAt: from,
          closedAt: to,
          totalSales: r(totalSales),
          totalNetSales: r(std.net + red.net + zero.net),
          totalTax: r(totalTax),
          cashSales: r(cash),
          cardSales: r(card),
          mobileSales: r(mobile),
          alternateSales: r(alternate),
          dineInSales: r(dineIn),
          takeoutSales: r(takeout),
          deliverySales: r(delivery),
          vatStandard: 22,
          vatStandardAmount: r(std.vat),
          vatReduced: 9.5,
          vatReducedAmount: r(red.vat),
          vatZero: 0,
          totalOrders: receipts.length,
          totalGuests: guests,
          avgOrderValue: r(receipts.length ? totalSales / receipts.length : 0),
          totalDiscounts: r(totalDiscounts),
          totalTips: r(totalTips),
          startingCash: num(open.startingCash),
          expectedCash: r(expectedCash),
          actualCash: closingCash,
          cashDifference: r(closingCash - expectedCash),
          notes: `Zaključek: ${user.name}`,
          locationId: open.locationId,
        },
      }),
      db.auditLog.create({
        data: {
          id: nid(),
          userId: user.sub,
          action: 'SHIFT_CLOSE',
          entityType: 'CashRegisterShift',
          entityId: open.id,
          details: JSON.stringify({
            totalSales: r(totalSales), cash: r(cash), card: r(card), receipts: receipts.length,
            cashDifference: r(closingCash - expectedCash),
          }),
          locationId: open.locationId,
        },
      }),
    ])
    return ok({ shift: mapShift({ ...shift, employee: null }), zReport: { id: zreport.id, totalSales: r(totalSales), cash: r(cash), card: r(card), totalTax: r(totalTax), receipts: receipts.length, cashDifference: r(closingCash - expectedCash) } })
  }

  const open = await db.cashRegisterShift.findFirst({ where: { employeeId: user.sub, status: 'open' } })
  if (open) return fail('Izmena že teče.')
  const locationId = user.loc || (await db.location.findFirst())?.id || null
  const shift = await db.cashRegisterShift.create({
    data: {
      id: nid(),
      employeeId: user.sub,
      employeeName: user.name,
      status: 'open',
      startingCash: num(body?.openingCash),
      locationId,
    },
  })
  return ok({ shift: mapShift({ ...shift, employee: null }) }, 201)
}
