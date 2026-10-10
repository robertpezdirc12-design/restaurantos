import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { mapShift, nid, num, r2, jparse } from '@/lib/map'

/**
 * N5 (revizija §4): seznam izmen (z začetnim/končnim stanjem blagajne) — UI prikaže
 * zavihek Izmene samo z 'orders.pay' (TAB_PERM.izmene; blagajna/izmena), zato backend
 * uveljavlja isto kanonično dovoljenje (prej: requireAuth). Odstopanje od predloga
 * 'reports.view' je namerno: izmene niso zgolj poročila — zavihek uporablja tudi
 * blagajna (natakar ima 'orders.pay' po privzetih pravicah), zato bi 'reports.view'
 * prekinil zakonit tok (otvoritev/zaključek izmene + pregled svojih izmen).
 * Finančna povzetka (dnešni/mesečni promet) v tem zavihku prihajata iz
 * /api/reports/financial in imata svoj gating (izven obsega tega popravka).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'orders.pay')
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
 *
 * R11 (revizija §6): okno agregacije ni več surovi createdAt-range izven transakcije
 * (dve prekrivajoči se izmeni sta šteli isti račun v dveh Z-poročilih). Schema nima
 * shiftId na Order/Receipt (novo vezavo NI mogoče dodati — prepovedana sprememba sheme),
 * zato veljata dve pravili, oba znotraj ENI interaktivni transakciji kot CAS prevzem zaklepa:
 *  1. CAS prevzem: updateMany({ where: { id, status: 'open' } }) — samo ENA zahteva
 *     zaključi izmeno (dvojni klik / vzporedna zahteva → count 0 → 409, brez 2. Z-poročila).
 *  2. Veriženje oken (prvo zaprtje zmaga): spodnja meja okna je max(openedAt te izmene,
 *     zadnji closedAt že zaključene izmene na isti lokaciji). Okna se s tem verižijo
 *     brez prekrivanja (polodprt interval [spodnja, zgornja)), vsak račun pripada
 *     točno enemu Z-poročilu — dvojno štetje med prekrivajočimi izmenami je izključeno.
 * Rezidualna opomba (dokumentirano, brez spremembe sheme): pri zaključku izven vrstnega
 * reda (izmena, odprta KASNEJE, zaključi PRVA) pravilo "prvo zaprtje zmaga" pripise
 * račune prekrivanja prej zaključeni izmeni; računi iz dobe prej odprte izmene pred
 * openedAt kasnejše ostanejo nepripisani Z-poročilu (niso izgubljeni — Receipt ostane).
 * Popolna pripisitev (attribution) zahteva shiftId vezavo na Order/Receipt (prihodnja shemska naloga).
 */

/** Notranja napaka: izmena je bila že zaključena (CAS prevzem ni uspel) → 409 */
class ShiftCloseConflictError extends Error {
  constructor() {
    super('Izmena je že zaključena.')
  }
}

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

    try {
      const result = await db.$transaction(async (tx) => {
        // R11 (1/2): CAS prevzem zaklepa — samo prva zahteva preide iz 'open' v 'closed'
        const claim = await tx.cashRegisterShift.updateMany({
          where: { id: open.id, status: 'open' },
          data: { status: 'closed', closedAt: new Date() },
        })
        if (claim.count === 0) throw new ShiftCloseConflictError()
        const claimed = await tx.cashRegisterShift.findUnique({ where: { id: open.id } })
        if (!claimed || claimed.status !== 'closed' || !claimed.closedAt) throw new ShiftCloseConflictError()
        const to = claimed.closedAt

        // R11 (2/2): spodnja meja okna — prvo zaprtje zmaga (veriženje brez prekrivanja)
        const lastClosed = await tx.cashRegisterShift.findFirst({
          where: {
            locationId: claimed.locationId ?? undefined,
            status: 'closed',
            closedAt: { not: null },
            id: { not: claimed.id },
          },
          orderBy: { closedAt: 'desc' },
          select: { closedAt: true },
        })
        const from =
          lastClosed?.closedAt && lastClosed.closedAt > claimed.openedAt ? lastClosed.closedAt : claimed.openedAt

        // izračun iz fiskalnih računov v oknu izmene — prebrano ZNOTRAJ iste transakcije
        // (polodprt interval: [from, to) — račun natanko ob meji pripada NASLEDNJEMU poročilu)
        const receipts = await tx.receipt.findMany({
          where: { locationId: claimed.locationId || undefined, createdAt: { gte: from, lt: to } },
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
        const expectedCash = num(claimed.startingCash) + cash
        const r = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
        const std = vatBuckets['22'] || { net: 0, vat: 0 }
        const red = vatBuckets['9.5'] || { net: 0, vat: 0 }
        const zero = vatBuckets['0'] || { net: 0, vat: 0 }

        // totals na izmeni (prevzem je naš — varno po id)
        const shift = await tx.cashRegisterShift.update({
          where: { id: claimed.id },
          data: {
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
        })
        const zreport = await tx.zReport.create({
          data: {
            id: nid(),
            reportDate: claimed.openedAt,
            openedAt: claimed.openedAt,
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
            startingCash: num(claimed.startingCash),
            expectedCash: r(expectedCash),
            actualCash: closingCash,
            cashDifference: r(closingCash - expectedCash),
            notes: `Zaključek: ${user.name}`,
            locationId: claimed.locationId,
          },
        })
        await tx.auditLog.create({
          data: {
            id: nid(),
            userId: user.sub,
            action: 'SHIFT_CLOSE',
            entityType: 'CashRegisterShift',
            entityId: claimed.id,
            details: JSON.stringify({
              totalSales: r(totalSales), cash: r(cash), card: r(card), receipts: receipts.length,
              cashDifference: r(closingCash - expectedCash),
              windowFrom: from.toISOString(), windowTo: to.toISOString(),
            }),
            locationId: claimed.locationId,
          },
        })
        return { shift, zreport, receipts: receipts.length, totalSales: r(totalSales), cash: r(cash), card: r(card), totalTax: r(totalTax), cashDifference: r(closingCash - expectedCash) }
      })

      return ok({
        shift: mapShift({ ...result.shift, employee: null }),
        zReport: { id: result.zreport.id, totalSales: result.totalSales, cash: result.cash, card: result.card, totalTax: result.totalTax, receipts: result.receipts, cashDifference: result.cashDifference },
      })
    } catch (e) {
      if (e instanceof ShiftCloseConflictError) return fail(e.message, 409)
      throw e
    }
  }

  const locationId = user.loc || (await db.location.findFirst())?.id || null
  // R1 popravek (P0 audit): odpiranje izmene v transakciji z ponovno preverbo —
  // dva vzporedna klika ne moreta odpreti dveh izmen (SQLite serializira; PG zoži okno).
  const opened = await db.$transaction(async (tx) => {
    const again = await tx.cashRegisterShift.findFirst({ where: { employeeId: user.sub, status: 'open' } })
    if (again) return null
    return tx.cashRegisterShift.create({
      data: {
        id: nid(),
        employeeId: user.sub,
        employeeName: user.name,
        status: 'open',
        startingCash: num(body?.openingCash),
        locationId,
      },
    })
  })
  if (!opened) return fail('Izmena že teče (sočasno odpiranje zavrnjeno).', 409)
  return ok({ shift: mapShift({ ...opened, employee: null }) }, 201)
}
