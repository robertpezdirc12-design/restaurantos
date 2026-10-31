import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { mapShift, nid, num, r2, jparse, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import { sendShiftDailySummary } from '@/lib/daily-email'
import { aggregateSalesByVariant } from '@/lib/item-variants'
import {
  cashMovementsAvailable,
  cashPolicy,
  summarizeMovements,
  expectedDrawerCash,
  zReportCashColumnsAvailable,
  CASH_MOVEMENT_MAX,
} from '@/lib/cash-movements'
import { resolveExceptionApproval } from '@/lib/exception-approval'

/**
 * N5 (revizija §4): seznam izmen (z začetnim/končnim stanjem blagajne) — UI prikaže
 * zavihek Izmene samo z 'orders.pay' (TAB_PERM.izmene; blagajna/izmena), zato backend
 * uveljavlja isto kanonično dovoljenje (prej: requireAuth). Odstopanje od predloga
 * 'reports.sales' je namerno: izmene niso zgolj poročila — zavihek uporablja tudi
 * blagajna (natakar ima 'orders.pay' po privzetih pravicah), zato bi 'reports.sales'
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
 *  - promet po načinih plačila, DDV razčlenitev (22/9.5/0), št. računov, napitnine
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

/** Issue #16: variance nad pragom BREZ razloga → 400 (PRE-TX return fail).
 *  Uporabljen tudi ZNOTRAJ TX kot fail-closed točna preverba (rasa). */
class VarianceReasonError extends Error {
  constructor() {
    super('Razlika gotovine presega prag — vpišite razlog (vsaj 3 znake).')
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

type DrawerCash = { ok: true; eur: number } | { ok: false; error: string }

/**
 * Issue #22 (v1.148.0): stanje gotovine v izmeni je bilo doslej zapisano
 * NEPREVERJENO. `num()` iz vrednosti, ki ni število, naredi 0, negativen in
 * poljubno velik znesek pa gresta naprej. Posledica: izmena je lahko prikazala
 * poljubno razliko, ne da bi za njo obstajal reviziran CashMovement — meje
 * CASH_MOVEMENT_MIN/MAX (src/lib/cash-movements.ts:57-58) so veljale samo za
 * ročne premike, ne pa za samo števanje predala. Zgornja meja je zato ISTA kot
 * pri premikih: več kot 100.000 EUR ni vsebina blagajne, je pa lahko napaka
 * vnosa; resničen večji znesek se revizira kot safe_drop.
 * Prazan vnos (izpuščen, null, prazen niz) ostane 0 — trenutni UI obrazec
 * pošlje prazno polje, ko fond ni bil nastavljen. Drugače funkcija NE popravlja
 * in NE zaokrožuje: drugačen tip (objekt, polje, boolean) vrne napako namesto da bi
 * neopazno zdrsnil na 0, sicer bi «izmišljena» prazna blagajna izgledala kot
 * števanje.
 */
function parseDrawerCash(raw: unknown, label: string): DrawerCash {
  const bounds = (n: number): DrawerCash => {
    if (!Number.isFinite(n)) return { ok: false, error: `${label}: vnesite veljavno število.` }
    if (n < 0) return { ok: false, error: `${label}: gotovina ne more biti negativna.` }
    if (n > CASH_MOVEMENT_MAX) return { ok: false, error: `${label}: znesek presega mejo (${CASH_MOVEMENT_MAX} EUR).` }
    return { ok: true, eur: n }
  }
  if (raw === undefined || raw === null) return { ok: true, eur: 0 }
  if (typeof raw === 'number') return bounds(raw)
  if (typeof raw !== 'string') return { ok: false, error: `${label}: vnesite veljavno število.` }
  const s = raw.trim()
  if (s === '') return { ok: true, eur: 0 }
  return bounds(Number(s.replace(',', '.')))
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
    // Issue #22 (v1.148.0): končno stanje predala je ZAVEZA štejača, ne poljubna vrednost
    const closing = parseDrawerCash(body.closingCash, 'Končno gotovinsko stanje')
    if (!closing.ok) return fail(closing.error, 400)
    const closingCash = closing.eur

    /* ── Issue #16 PRE-TX: politika + PREVIEW variance (razlog/odobritev) ──
     * resolveExceptionApproval in probe pomočniki uporabljajo skupno db
     * povezavo — ZNOTRAJ interaktivne TX bi si prisvajala izključno povezavo
     * (SQLite deadlock). Zato: odločitev o odobritvi izven TX (ista okenska
     * logika, read-only preview); ZNOTRAJ TX se točna razlika izračuna na novo
     * in če je nad pragom BREZ dokaza → fail-closed VarianceReasonError
     * (izmena ostane odprta, uporabnik vpiše razlog + odobritev in ponovi). */
    const movementsReady = await cashMovementsAvailable()
    const policy = await cashPolicy()
    // ZReport povzetek stolpci (probe PREV-TX — isti vzorec povezave)
    const zrColsReady = movementsReady ? await zReportCashColumnsAvailable() : false
    let varianceEvidence: Record<string, unknown> | null = null
    if (movementsReady && policy.varianceThresholdCents > 0 && open.locationId) {
      const lastClosedPrev = await db.cashRegisterShift.findFirst({
        where: { locationId: open.locationId, status: 'closed', closedAt: { not: null }, id: { not: open.id } },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true },
      })
      const fromPrev =
        lastClosedPrev?.closedAt && lastClosedPrev.closedAt > open.openedAt ? lastClosedPrev.closedAt : open.openedAt
      const receiptsPrev = await db.receipt.findMany({
        where: { locationId: open.locationId, createdAt: { gte: fromPrev, lt: new Date() }, paymentMethod: 'cash' },
        select: { total: true },
        take: 5000,
      })
      let cashPrev = 0
      for (const rc of receiptsPrev) cashPrev += num(rc.total) // storno neto (negativni)
      const mvPrev = await db.cashMovement.findMany({
        where: { shiftId: open.id },
        select: { type: true, direction: true, amount: true, status: true, reversalOfId: true },
        take: 1000,
      })
      const mPrevSummary = summarizeMovements(mvPrev.map((m) => ({ ...m, amount: num(m.amount) })))
      const expectedPrev = expectedDrawerCash(num(open.startingCash), cashPrev, mPrevSummary.net)
      const diffPrev = Math.round((closingCash - expectedPrev + Number.EPSILON) * 100)
      if (Math.abs(diffPrev) > policy.varianceThresholdCents) {
        const vReasonId = typeof body?.varianceReasonId === 'string' ? body.varianceReasonId.trim() : ''
        const vReasonText = typeof body?.varianceReason === 'string' ? body.varianceReason.trim().slice(0, 200) : ''
        let reasonName: string | null = null
        let reasonId: string | null = null
        let reasonText: string | null = null
        if (vReasonId) {
          const nr = await db.noSaleReason.findUnique({ where: { id: vReasonId } })
          if (!nr || !nr.isActive || nr.locationId !== open.locationId) {
            return fail('Razlog variance ni veljaven za to lokacijo.', 400)
          }
          reasonId = nr.id
          reasonName = nr.name
        } else if (vReasonText.length >= 3) {
          reasonText = vReasonText
        } else {
          return fail('Razlika gotovine presega prag — vpišite razlog (vsaj 3 znake).', 400)
        }
        const approval = await resolveExceptionApproval(user, open.locationId, {
          approverEmail: body?.approverEmail,
          approverPin: body?.approverPin,
        })
        if (!approval.ok) return fail(approval.message, approval.status)
        varianceEvidence = {
          varianceOverThreshold: true,
          varianceThresholdCents: policy.varianceThresholdCents,
          varianceReasonId: reasonId,
          varianceReasonName: reasonName,
          varianceReasonText: reasonText,
          approved: true,
          approvalMethod: approval.approval.method,
          approverId: approval.approval.approverId,
          approverName: approval.approval.approverName,
        }
      }
    }
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
          // DDV razčlenitev iz vatBreakdown (neto konvencija — ključi so stopnje)
          const vb = jparse<Record<string, { base: number; vat: number }>>(rc.vatBreakdown, {})
          for (const [rate, v] of Object.entries(vb)) {
            const key = Number(rate) === 0 ? '0' : Number(rate) <= 9.5 ? '9.5' : '22'
            if (!vatBuckets[key]) vatBuckets[key] = { net: 0, vat: 0 }
            vatBuckets[key].net += num(v.base)
            vatBuckets[key].vat += num(v.vat)
          }
        }
        const expectedCashRaw = num(claimed.startingCash) + cash

        /* ── Issue #16: blagajniški premiki v pričakovani gotovini ──
         * pričakovano = začetni fond + gotovinska prodaja (okno, storno neto)
         *              + Σ potrjeni vhodni premiki − Σ potrjeni izhodni premiki
         * EN vir formule (expectedDrawerCash) — isti motor kot živi pregled
         * premikov. Premiki so vezani na izmeno (kreacija SAMO na odprti) →
         * zaključeni Z-poročili se KASNEJE ne preračunavajo (issue).
         * movementsReady/policy sta PREVETA PREV-TX (probe uporablja skupno
         * povezavo — znotraj TX bi prisvajala izključno povezavo). */
        const movementRows = movementsReady
          ? await tx.cashMovement.findMany({
              where: { shiftId: claimed.id },
              select: { type: true, direction: true, amount: true, status: true, reversalOfId: true },
              take: 1000,
            })
          : []
        const mSummary = summarizeMovements(
          movementRows.map((m) => ({ ...m, amount: num(m.amount) }))
        )
        const expectedCash = movementsReady
          ? expectedDrawerCash(num(claimed.startingCash), cash, mSummary.net)
          : expectedCashRaw
        const r = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

        /* ── Issue #16: TOČNA preverba variance ZNOTRAJ TX (fail-closed) ──
         * Odločitev o razlogu/odobritvi je bila sprejeta PREV-TX (preview,
         * enaka okenska logika). Tukaj izračunamo TOČNO razliko: če je nad
         * pragom BREZ dokaza (rasa: račun je prisel med preview in TX) →
         * rollback + 400 (izmena ostane odprta; uporabnik ponovi s razlogom).
         * Dokaz (varianceEvidence) se zapiše v audit SHIFT_CLOSE. */
        const diffEur = r(closingCash - expectedCash)
        const exactOverThreshold =
          policy.varianceThresholdCents > 0 &&
          Math.abs(Math.round(diffEur * 100)) > policy.varianceThresholdCents
        if (exactOverThreshold && !varianceEvidence) {
          throw new VarianceReasonError()
        }
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
            // Issue #16: odvod v sef — obstoječe typed polje, doslej vedno 0;
            // ujema se s Square definicijo "cash drop" (denar odveden med izmeno)
            cashDrops: r(mSummary.safeDrop),
            notes: `Zaključek: ${user.name}`,
            locationId: claimed.locationId,
          },
        })
        await writeAudit(tx, { userId: user.sub, action: 'SHIFT_CLOSE', entityType: 'CashRegisterShift', entityId: claimed.id, details: JSON.stringify({
              totalSales: r(totalSales), cash: r(cash), card: r(card), receipts: receipts.length,
              cashDifference: r(closingCash - expectedCash),
              windowFrom: from.toISOString(), windowTo: to.toISOString(),
              // Issue #16: razčlenitev premikov + dokaz variance (odobritev/razlog)
              movements: mSummary.count > 0 || mSummary.voidedCount > 0 ? {
                paidIn: mSummary.paidIn, paidOut: mSummary.paidOut, safeDrop: mSummary.safeDrop,
                guestRefund: mSummary.guestRefund, net: mSummary.net, count: mSummary.count,
                voidedCount: mSummary.voidedCount,
              } : undefined,
              variance: varianceEvidence ?? undefined,
            }), locationId: claimed.locationId })
        return { shift, zreport, locationId: locId, receipts: receipts.length, totalStorno: r(totalStorno), totalSales: r(totalSales), cash: r(cash), card: r(card), totalTax: r(totalTax), cashDifference: r(closingCash - expectedCash), totalNet: r(totalNet), covers: originalOrders, windowFrom: from, windowTo: to, movementSummary: mSummary }
      })
      // Issue #16: povzetek NEPRODAJNIH premikov (mirror-only do DDL — raw
      // UPDATE IZVEN transakcije: Prisma raw poizvedba si lahko prisvaja
      // LOČENO povezavo → znotraj TX bi čakala na lastni write-lock (P2028,
      // 5 s timeout — odkrito v polnem CI teku). Fail-soft: brez stolpcev
      // Z-poročilo ostane popolnoma veljavno (povzetek živ prek CashMovement).
      if (movementsReady && zrColsReady && result.movementSummary.count > 0) {
        await db
          .$executeRawUnsafe(
            `UPDATE "ZReport" SET "cashPaidIn" = ${result.movementSummary.paidIn}, "cashPaidOut" = ${result.movementSummary.paidOut}, "cashGuestRefund" = ${result.movementSummary.guestRefund} WHERE "id" = '${result.zreport.id}'`,
          )
          .catch(() => null)
      }

      /* ── Issue #22 (v1.148.0): PREDAJA PREDALA MED IZMENAMA ──
       * `startingCash` doslej ni bila primerjana z ničemer: izmena se je lahko
       * odprla s poljubnim zneskom, razlika pa ni imela nobene sledi. Ob
       * zaključku zdaj zapišemo revizijski zapis, če se začetno stanje te
       * izmene nad pragom politike ne ujema s KONČNIM stanjem predhodne izmene
       * na isti lokaciji (fizična predaja). Knjigovodski pričakovani znesek
       * (expectedCash) se zapiše kot drugo merilo, da je razloček viden: če je
       * že predhodna izmena napačno preštela, se razlika pokaže na obeh merilih;
       * če je bila gotovina med izmenama dodana ali odvzeta brez reviziranega
       * CashMovement, se razlika pojavi samo na fizičnem merilu.
       * Ni nove tabele in ni DDL — samo AuditLog (isti mehanizem kot
       * SHIFT_CLOSE). Fail-soft: zapis ne sme nikoli prekiniti že uspešnega
       * zaključka (vzorec e-pošte in ZReport mirror-a zgoraj). */
      if (movementsReady && result.shift.locationId) {
        try {
          const prev = await db.cashRegisterShift.findFirst({
            where: {
              locationId: result.shift.locationId,
              status: 'closed',
              closedAt: { not: null },
              id: { not: result.shift.id },
            },
            orderBy: { closedAt: 'desc' },
            select: { id: true, closingCash: true, expectedCash: true, closedAt: true },
          })
          if (prev) {
            const openingEur = num(result.shift.startingCash)
            const prevClosingEur = num(prev.closingCash)
            const prevExpectedEur = num(prev.expectedCash)
            const closingGapCents = Math.round((openingEur - prevClosingEur + Number.EPSILON) * 100)
            if (Math.abs(closingGapCents) > policy.varianceThresholdCents) {
              await writeAudit(db, {
                userId: user.sub,
                action: 'CASH_HANDOVER_UNAUDITED',
                entityType: 'CashRegisterShift',
                entityId: result.shift.id,
                details: jstr({
                  previousShiftId: prev.id,
                  previousClosedAt: prev.closedAt ? new Date(prev.closedAt).toISOString() : null,
                  openingCash: openingEur,
                  previousClosingCash: prevClosingEur,
                  previousExpectedCash: prevExpectedEur,
                  closingGapEur: r2(openingEur - prevClosingEur),
                  expectedGapEur: r2(openingEur - prevExpectedEur),
                  thresholdCents: policy.varianceThresholdCents,
                }),
                locationId: result.shift.locationId,
              })
            }
          }
        } catch {
          // never block the shift close response
        }
      }

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
          // v1.212.0 (OSS-10 C-del): top 3 v povzetku izmene SE ZDAJ RAZCEPLJAJO
          // po varianti (isti kontrakt kot dnevni digest in dashboard topItems).
          const items = orderIds.size
            ? await db.orderItem.findMany({
                where: { orderId: { in: [...orderIds] }, voided: false },
                select: {
                  menuItemName: true,
                  quantity: true,
                  OrderItemModifier: {
                    select: { name: true, ModifierGroup: { select: { required: true, maxSelect: true } } },
                  },
                },
                take: 5000,
              })
            : []
          const topItems = aggregateSalesByVariant(items.map((it) => ({
            name: it.menuItemName,
            qty: it.quantity,
            modifiers: it.OrderItemModifier.map((m) => ({
              name: m.name,
              groupRequired: m.ModifierGroup?.required,
              groupMaxSelect: m.ModifierGroup?.maxSelect,
            })),
          }))).slice(0, 3)
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
        // Issue #16: razčlenitev NEPRODAJNIH premikov za Z-poročilo dialog
        movementSummary: result.movementSummary,
      })
    } catch (e) {
      if (e instanceof ShiftCloseConflictError) return fail(e.message, 409)
      // #61: legacy null-loc izmena → varen 409 (izmena ostane odprta; transakcija
      // se je povsem rollback-ala — brez ZReport, brez totals, brez audita).
      if (e instanceof LegacyShiftLocationError) return fail(e.message, 409)
      // Issue #16: variance nad pragom — 400 (razlog); PRE-TX odobritev je
      // že vrnila 403; transakcija se rollback-a, izmena OSTANE ODPRTA.
      if (e instanceof VarianceReasonError) return fail(e.message, 400)
      throw e
    }
  }

  // Issue #5: requireUserLocation (§10 — brez findFirst() fallbacka; centralna vloga
  // podaja lokacijo eksplicitno, ostali so vezani na svojo)
  const locationId = requireUserLocation(user)
  if (isResponse(locationId)) return locationId
  // Issue #22 (v1.148.0): začetno stanje predala je ista zaveza kot končno —
  // oba konca izmene morata ostati v istem okviru kot revizirani premiki,
  // sicer se razlika lahko pojavi na vhodu in nima nobene sledi.
  const opening = parseDrawerCash(body?.openingCash, 'Začetno gotovinsko stanje')
  if (!opening.ok) return fail(opening.error, 400)
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
        startingCash: opening.eur,
        locationId,
      },
    })
    // 33-c (audit §6): odpiranje izmene je zdaj revidirano (SHIFT_OPEN) — v ISTI transakciji
    await writeAudit(tx, { userId: user.sub, action: 'SHIFT_OPEN', entityType: 'CashRegisterShift', entityId: shift.id, details: jstr({ startingCash: opening.eur, employeeName: user.name }), locationId: locationId })
    return shift
  })
  if (!opened) return fail('Izmena že teče (sočasno odpiranje zavrnjeno).', 409)
  return ok({ shift: mapShift({ ...opened, employee: null }) }, 201)
}
