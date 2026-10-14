import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { mapShift, nid, num, r2, jparse, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import { sendShiftDailySummary } from '@/lib/daily-email'

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
  const user = await requirePermission(req, 'cash.manage')
  if (isResponse(user)) return user
  const shifts = await db.cashRegisterShift.findMany({
    // Issue #4 §1: izmene po lokaciji (CashRegisterShift.locationId); POST ostaja lastna izmena
    where: await locationScope(user),
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

/**
 * Issue #61 (P1): legacy izmena BREZ lokacije (CashRegisterShift.locationId null)
 * ne sme biti zaključena z Z-poročilom — `locationId: null || undefined` je iz
 * Prisma where-filtra IZPUSIL lokacijski omejitveni pogoj in bi agregiral RAČUNE
 * VSEH LOKACIJ v časovnem oknu (globalni promet). Fail-closed: celotna transakcija
 * (CAS claim + totals + ZReport + audit) se ROLLBACK-a, izmena ostane odprta,
 * odgovor je 409 z navodilom za pooblaščeno razrešitev (izrecna dodelitev
 * lokacije legacy zapisu prek centralnega OPS postopka — NE samodejni prevzem
 * »prve«/naključne organizacije).
 */
class LegacyShiftLocationError extends Error {
  constructor() {
    super(
      'Izmena brez dodeljene lokacije (legacy zapis) ne more biti zaključena — ' +
        'Z-poročilo zahteva potrjeno lokacijo. Razrešitev: centralni administrativni ' +
        'poseg, ki izmeni izrecno dodeli lokacijo (brez samodejnega pripisa).',
    )
  }
}

export async function POST(req: NextRequest) {
  // Issue #5 (P0, komentar #3): odpiranje/zaključek blagajne = cash.manage
  // (enako kot GET; prej requireAuth — vsak prijavljeni je lahko pognal Z-poročilo).
  // Osebna evidenca delovnega časa ostaja LOČENA v /api/timeclock (samooskrba).
  const user = await requirePermission(req, 'cash.manage')
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

        // ── Issue #61: FAIL-CLOSED na legacy izmeno brez lokacije ──
        // NUL lokacije se NIKOLI ne pretvori v neomejen findMany (Prisma bi pri
        // `locationId: undefined` izpustil filter → globalni agregat). Velja za
        // VSE vloge (tudi centralne — centralna vloga ne more uporabiti null-loc
        // izmene kot implicitnega globalnega poročila; globalni ops postopek je
        // ločen in izrecno dokumentiran). Rollback celotne transakcije (claim
        // vključno) → izmena ostane odprta, nič ne poteče.
        const locId = claimed.locationId
        if (!locId) throw new LegacyShiftLocationError()

        // R11 (2/2): spodnja meja okna — prvo zaprtje zmaga (veriženje brez prekrivanja)
        // #61: filter ZVEZNO z (že preverjeno ne-nullo) lokacijo izmene — enako
        // obsegovanje kot računi (ne more pobrati zaključkov druge lokacije).
        const lastClosed = await tx.cashRegisterShift.findFirst({
          where: {
            locationId: locId,
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
        // #61: LOKACIJSKI FILTER JE OBVEZEN — locId je zgornj preverjen kot ne-null;
        // nikoli več `|| undefined` (izpad filtra = agregacija vseh lokacij).
        const receipts = await tx.receipt.findMany({
          where: { locationId: locId, createdAt: { gte: from, lt: to } },
          include: { Order: { select: { type: true, splitCount: true, tip: true, discount: true } } },
        })
        let cash = 0, card = 0, mobile = 0, alternate = 0, totalSales = 0, totalTax = 0
        let totalTips = 0, totalDiscounts = 0, guests = 0
        let totalNet = 0
        let dineIn = 0, takeout = 0, delivery = 0
        // Task 63 (storno celovitost): storno račun (isStorno=true, negativni zneski) se
        // NOETNO prišteje k vsem vsotam (promet/DDV/načini plačila/vedri — pravilna negacija
        // FURS prometa), NE pa k števcem naročij/gostov (storno NI novo naročilo; gost je
        // že štet pri originalu). totalStorno = absolutna vsota storno računov v oknu —
        // polje obstaja v shemi (ZReport.totalStorno), doslej pa ni bilo nikoli zapisano.
        let totalStorno = 0
        let originalOrders = 0
        const vatBuckets: Record<string, { net: number; vat: number }> = {}
        for (const rc of receipts) {
          const amount = num(rc.total)
          if (rc.isStorno) {
            totalStorno += Math.abs(amount)
          } else {
            originalOrders += 1
            guests += rc.Order?.splitCount || 0
            totalNet += num(rc.subtotal)
          }
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
            totalOrders: originalOrders, // Task 63: storno računov ne štejemo kot naročila
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
            totalStorno: r(totalStorno), // Task 63: prvič dejansko zapisano (bilo vedno 0)
            totalOrders: originalOrders, // Task 63: brez storno računov
            totalGuests: guests, // Task 63: gostje samo iz originalov (brez podvojenih)
            avgOrderValue: r(originalOrders ? totalSales / originalOrders : 0), // Task 63: neto / originali
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
        await writeAudit(tx, { userId: user.sub, action: 'SHIFT_CLOSE', entityType: 'CashRegisterShift', entityId: claimed.id, details: JSON.stringify({
              totalSales: r(totalSales), cash: r(cash), card: r(card), receipts: receipts.length,
              cashDifference: r(closingCash - expectedCash),
              windowFrom: from.toISOString(), windowTo: to.toISOString(),
            }), locationId: claimed.locationId })
        return { shift, zreport, locationId: locId, receipts: receipts.length, totalStorno: r(totalStorno), totalSales: r(totalSales), cash: r(cash), card: r(card), totalTax: r(totalTax), cashDifference: r(closingCash - expectedCash), totalNet: r(totalNet), covers: originalOrders, windowFrom: from, windowTo: to }
      })

      // OPS-8 val 2 (v1.72.0): push to management on shift close / Z-report (via
      // notification matrix; fire-and-forget)
      void pushEvent('Z_CLOSED', {
        title: 'Izmena zaključena (Z-poročilo)',
        body: `${result.totalSales.toFixed(2)} € · ${result.receipts} računov · gotovina ${result.cash.toFixed(2)} €`,
        url: '/dashboard?tab=izmene',
        tag: `z-closed-${result.zreport.id}`,
      }, { roles: ['manager', 'admin'], locationId: result.shift.locationId })

      // OPS-8 val 3 (v1.73.0): daily summary e-mail right after a successful close.
      // Fire-and-forget with its own try/catch — it must never block or fail the close.
      void (async () => {
        try {
          // #61: dodatna analitika uporablja ISTI validiran locationId iz transakcije
          // (result.locationId — zgoraj preverjen ne-null) — nikoli ne umakne filtra.
          const winReceipts = await db.receipt.findMany({
            where: { locationId: result.locationId, createdAt: { gte: result.windowFrom, lt: result.windowTo } },
            select: { orderId: true, subtotal: true, total: true, totalVat: true, isStorno: true, paymentMethod: true },
            take: 5000,
          })
          let gross = 0, net = 0, vat = 0, covers = 0
          const payTotals = new Map<string, number>()
          const orderIds = new Set<string>()
          for (const rc of winReceipts) {
            if (rc.isStorno) continue
            gross += num(rc.total)
            net += num(rc.subtotal)
            vat += num(rc.totalVat)
            covers += 1
            orderIds.add(rc.orderId)
            const m = ['cash', 'card', 'mobile'].includes(rc.paymentMethod) ? rc.paymentMethod : 'other'
            payTotals.set(m, r2((payTotals.get(m) || 0) + num(rc.total)))
          }
          const items = orderIds.size
            ? await db.orderItem.findMany({ where: { orderId: { in: [...orderIds] }, voided: false }, select: { menuItemName: true, quantity: true }, take: 5000 })
            : []
          const qtyByName = new Map<string, number>()
          for (const it of items) {
            const name = it.menuItemName || '(artikel)'
            qtyByName.set(name, (qtyByName.get(name) || 0) + (it.quantity || 0))
          }
          const topItems = [...qtyByName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, qty]) => ({ name, qty }))
          await sendShiftDailySummary({
            shiftId: result.shift.id,
            shiftDate: result.shift.openedAt,
            from: result.windowFrom,
            to: result.windowTo,
            locationId: result.shift.locationId,
            gross: r2(gross),
            net: r2(net),
            vat: r2(vat),
            covers,
            payments: [...payTotals.entries()].map(([method, amount]) => ({ method, amount })),
            topItems,
          })
        } catch {
          // never block the shift close response
        }
      })()

      return ok({
        shift: mapShift({ ...result.shift, employee: null }),
        zReport: { id: result.zreport.id, totalSales: result.totalSales, cash: result.cash, card: result.card, totalTax: result.totalTax, receipts: result.receipts, totalStorno: result.totalStorno, cashDifference: result.cashDifference },
      })
    } catch (e) {
      if (e instanceof ShiftCloseConflictError) return fail(e.message, 409)
      // #61: legacy null-loc izmena → varen 409 (izmena ostane odprta; transakcija
      // se je povsem rollback-ala — brez ZReport, brez totals, brez audita).
      if (e instanceof LegacyShiftLocationError) return fail(e.message, 409)
      throw e
    }
  }

  // Issue #5: requireUserLocation (§10 — brez findFirst() fallbacka; centralna vloga
  // podaja lokacijo eksplicitno, ostali so vezani na svojo)
  const locationId = requireUserLocation(user)
  if (isResponse(locationId)) return locationId
  // R1 popravek (P0 audit): odpiranje izmene v transakciji z ponovno preverbo —
  // dva vzporedna klika ne moreta odpreti dveh izmen (SQLite serializira; PG zoži okno).
  const opened = await db.$transaction(async (tx) => {
    const again = await tx.cashRegisterShift.findFirst({ where: { employeeId: user.sub, status: 'open' } })
    if (again) return null
    const shift = await tx.cashRegisterShift.create({
      data: {
        id: nid(),
        employeeId: user.sub,
        employeeName: user.name,
        status: 'open',
        startingCash: num(body?.openingCash),
        locationId,
      },
    })
    // 33-c (audit §6): odpiranje izmene je zdaj revidirano (SHIFT_OPEN) — v ISTI transakciji
    await writeAudit(tx, { userId: user.sub, action: 'SHIFT_OPEN', entityType: 'CashRegisterShift', entityId: shift.id, details: jstr({ startingCash: num(body?.openingCash), employeeName: user.name }), locationId: locationId })
    return shift
  })
  if (!opened) return fail('Izmena že teče (sočasno odpiranje zavrnjeno).', 409)
  return ok({ shift: mapShift({ ...opened, employee: null }) }, 201)
}
