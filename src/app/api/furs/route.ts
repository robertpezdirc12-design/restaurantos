import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, assertResourceLocation } from '@/lib/api'
import { mapReceipt, nid, num, r2, jstr, PAYMENT_TYPES_DB, ORDER_ACTIVE_DB } from '@/lib/map'
import { nextSequence } from '@/lib/sequences'
import { publishEvent } from '@/lib/events'
import { OrderError } from '@/lib/ops'
import { computeBill, earnPointsFor, tierForPoints, BillItem } from '@/lib/billing'
import { deductStockForOrderTx } from '@/lib/inventory'
import { canRedeem, maskCardNumber } from '@/lib/giftcards'
import { fiscalAdapterFor } from '@/lib/fiscal'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Seznam izdanih računov (FURS). Najnovejši prvi, zadnjih 100.
 * Vključi povezavo na naročilo/mizo za prikaz v UI (zavihek Računi).
 *
 * N5 (revizija §4): finančni seznam izdanih računov — UI prikaže zavihek Računi
 * samo z 'reports.view' (TAB_PERM.racuni), zato backend uveljavlja isto kanonično
 * dovoljenje (prej: requireAuth — natakar je prek API-ja videl vse račune).
 * Izbira 'reports.view' (in ne 'furs.issue'): zavihek je ZA VPOGLED v izdane račune
 * (seznam + CSV izvoz), ne za izdajo — izdaja gre skozi POST z lastnim gatingom;
 * 'furs.issue' bi po nepotrebnem zaprl seznam tudi financial/accounting rolam,
 * ki izdajajo ne, a poročila smejo videti. Podrobnost računa (tisk po plačilu,
 * GET /api/furs/[id]) ostaja dostopna blagajni — ni del tega popravka.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const receipts = await db.receipt.findMany({
    // Issue #4 §10: izdani računi so location-scoped (prej: vse lokacije)
    where: locationScope(user),
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { Order: { include: { Table: true } } },
  })
  return ok({
    receipts: receipts.map((r) => ({
      ...mapReceipt(r),
      tableName: r.Order?.Table ? `Miza ${r.Order.Table.number ?? (r.Order.Table as unknown as { name?: string }).name ?? ''}` : null,
      orderNumber: r.Order?.orderNumber ?? null,
      // storno označba (P1 audit točka 1): UI skrije storno akcijo za že stornirane
      isStorno: r.isStorno === true,
      stornoOf: r.stornoOf || null,
    })),
  })
}

/**
 * Plačilo + FURS račun — ATOMARNO (issue #1: stabilnost/idempotencija).
 * - $transaction: CAS zaščita (order.paymentStatus != paid) + Check + Receipt + Payment + miza
 *   → dvojni račun/plačilo za isti naročilo NI več mogoč (tudi ob dvojnem kliku/retry)
 * - Idempotencija: body.clientOperationId → Payment.idempotencyKey (unique); replay vrne
 *   ISTI račun (200, replayed) namesto novega
 * - Terminski POS: body.terminal.approvalCode → Payment.authorizationCode
 * - Issue #1 §6 deljeno plačilo: body.parts = [{ type, amount, terminal? }] — več delov
 *   z različnimi načini; vsota delov + vrednost unovčenih točk MORA biti = za plačanje
 *   (preprečitev preplačila/dvojnega plačila — validirano strežniško)
 * - Issue #1 §6 zvestoba: body.loyaltyAccountId + loyaltyPointsUsed → CAS odbitje točk +
 *   LoyaltyTransaction (redeem) + Payment(type='loyalty'); zaslužek po plačilu (earn)
 * - Issue #1 §6 popusti: ročni (Order.discount) + avtomatski (Happy Hour) izračunana
 *   kanonično prek billing.ts — Check/Receipt nosita discount razčlenbo
 * - Issue #1 triage ③ darilne kartice: del plačila type='giftcard' + giftCardId →
 *   pre-validacija (obstaja/aktivna/rok/saldo) + CAS odbitje v transakciji +
 *   GiftCardTransaction 'redeem' (podpisan −) + Payment.giftCardId; preplačilo kartice 409
 * - FURS: simulacija → ZOI=MD5, EOR=UUID, status 'verified'; produkcija → EOR='',
 *   status 'pending' (čaka pravo SOAP integracijo s certifikatom) + AuditLog INVOICE_ISSUE
 */
interface PaymentPart {
  type: string
  amount: number
  terminalApproval: string
  // Issue #1 (triage ③): del plačila z darilno kartico — zahteva giftCardId
  giftCardId?: string
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.orderId) return fail('orderId je obvezen.')

  const idempotencyKey =
    typeof body.clientOperationId === 'string' && body.clientOperationId.trim().length >= 8
      ? body.clientOperationId.trim().slice(0, 64)
      : typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim().length >= 8
        ? body.idempotencyKey.trim().slice(0, 64)
        : null

  // Predhodna preverjanja (definitivni odgovori, ne transakcijski)
  const orderPre = await db.order.findUnique({
    where: { id: body.orderId },
    include: { OrderItem: { include: { MenuItem: { select: { categoryId: true } } } }, Table: true },
  })
  if (!orderPre) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: plačilo tujega naročila je ZAVRJENO (prej: staff loc A je mogel plačati naročilo loc B
  // in izdati račun pod tujim taxId/premisesId)
  const payGuard = assertResourceLocation(user, orderPre.locationId)
  if (payGuard) return payGuard
  if (!ORDER_ACTIVE_DB.includes(orderPre.status) && orderPre.status !== 'paid') {
    return fail('Naročilo ni v plačljivem stanju.', 409)
  }

  // Idempotentni replay — plačilo za ta clientOperationId že obstaja?
  if (idempotencyKey) {
    const existing = await findReceiptByIdempotencyKey(idempotencyKey)
    if (existing) return ok({ invoice: existing, replayed: true, order: { id: orderPre.id, status: 'PAID' } }, 200)
  }

  const location = await db.location.findUnique({ where: { id: orderPre.locationId } })
  if (!location) return fail('Lokacija ne obstaja.', 400)

  const fursEnv = process.env.FURS_ENVIRONMENT || location.fursEnvironment || 'simulation'
  const simulation =
    process.env.FURS_ALLOW_SIMULATION === 'true' || ['simulation', 'test'].includes(fursEnv.toLowerCase())

  // ── Kanonični izračun računa (ročni + avtomatski/Happy Hour popusti) — billing.ts ──
  const now = new Date()
  const autoCandidates = await db.discount.findMany({
    where: {
      locationId: orderPre.locationId,
      isActive: true,
      triggerType: 'auto',
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      AND: [{ OR: [{ validTo: null }, { validTo: { gte: now } }] }],
    },
    select: { id: true, name: true, type: true, amount: true, happyDays: true, happyFromHour: true, happyToHour: true, targetCategoryIds: true },
  })
  const billItems: BillItem[] = orderPre.OrderItem
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
  const bill = computeBill({
    items: billItems,
    subtotal: r2(billItems.reduce((s, it) => s + it.unitPrice * it.quantity, 0)),
    tax: r2(billItems.reduce((s, it) => s + it.vatAmount, 0)),
    manualDiscount: num(orderPre.discount),
    autoCandidates,
    now,
    loyaltyEnabled: location.loyaltyEnabled,
    pointsPerEuro: location.loyaltyPointsPerEuro,
    pointsValue: num(location.loyaltyPointsValue, 0.01),
  })
  const subtotal = bill.subtotal
  const totalVat = bill.tax
  const total = bill.totalDue // znesek ZA PLAČANJE (po popustih)
  // Issue #1 (triage ①): napitnina lahko pride direktno s plačilom (body.tip, iz POS dialoga)
  // ali je bila že nastavljena na naročilu (orderPre.tip) — aditivno, nazaj-kompatibilno.
  const tip =
    body?.tip !== undefined && body?.tip !== null && String(body.tip).trim() !== ''
      ? Math.max(0, num(body.tip))
      : num(orderPre.tip)

  // ── Zvestoba: unovčenje točk (validacija PRED transakcijo) ──
  const redeemPoints = Math.max(0, Math.round(Number(body?.loyaltyPointsUsed) || 0))
  const loyaltyAccountId = typeof body?.loyaltyAccountId === 'string' && body.loyaltyAccountId.trim() ? body.loyaltyAccountId.trim() : null
  let redeemValue = 0
  let loyaltyAccount: { id: string; customerName: string; pointsBalance: number; lifetimePoints: number } | null = null
  if (redeemPoints > 0 || loyaltyAccountId) {
    if (!loyaltyAccountId) return fail('Unovčenje točk zahteva loyaltyAccountId.', 400)
    if (!location.loyaltyEnabled) return fail('Program zvestobe ni omogočen za to lokacijo.', 400)
    if (redeemPoints > bill.loyalty.maxRedeemablePoints) {
      return fail(`Največ ${bill.loyalty.maxRedeemablePoints} točk je mogoče unovčiti na tem računu.`, 400)
    }
    const acc = await db.loyaltyAccount.findUnique({ where: { id: loyaltyAccountId } })
    if (!acc || !acc.isActive) return fail('Račun zvestobe ne obstaja ali ni aktiven.', 404)
    // Issue #4 §1: unovčenje točk tujega gosta je ZAVRJENO (račun mora pripadati lokaciji naročila)
    if (acc.locationId && acc.locationId !== orderPre.locationId) {
      return fail('Račun zvestobe ne pripada tej lokaciji.', 403)
    }
    if (redeemPoints > acc.pointsBalance) return fail('Gost nima dovolj točk za unovčenje.', 409)
    loyaltyAccount = { id: acc.id, customerName: acc.customerName, pointsBalance: acc.pointsBalance, lifetimePoints: acc.lifetimePoints }
    redeemValue = r2(redeemPoints * bill.loyalty.pointsValue)
  }

  // ── Deli plačila (deljeno plačilo) ──
  // Issue #1 (triage ③): del z darilno kartico — zahteva giftCardId; kartica se
  // validira PRED transakcijo (definitivne napake) in odbije z CAS V transakciji.
  interface GiftCardPreload { id: string; cardNumber: string; balanceCents: number }
  const giftCards: Map<string, GiftCardPreload> = new Map()
  async function preloadGiftCard(id: unknown, amount: number): Promise<string | null> {
    const cid = typeof id === 'string' && id.trim() ? id.trim() : ''
    if (!cid) return 'Del plačila z darilno kartico zahteva giftCardId.'
    if (!giftCards.has(cid)) {
      const card = await db.giftCard.findUnique({ where: { id: cid } })
      if (!card) return 'Darilna kartica ne obstaja.'
      const check = canRedeem(
        { cardNumber: card.cardNumber, status: card.status, balanceCents: Math.round(num(card.balance) * 100), expiresAt: card.expiresAt },
        Math.round(amount * 100),
      )
      if (!check.ok) return check.reason || 'Darilna kartica ni veljavna za unovčenje.'
      giftCards.set(cid, { id: cid, cardNumber: card.cardNumber, balanceCents: Math.round(num(card.balance) * 100) })
    }
    return null
  }
  const parts: PaymentPart[] = []
  if (Array.isArray(body?.parts) && body.parts.length > 0) {
    if (body.parts.length > 10) return fail('Največ 10 delov plačila.', 400)
    for (const p of body.parts as Record<string, unknown>[]) {
      const type = String(p?.type || '').toLowerCase()
      if (!PAYMENT_TYPES_DB.includes(type) || type === 'loyalty') {
        return fail(`Neveljaven način plačila dela: ${type || '(prazno)'}.`, 400)
      }
      const amount = r2(num(p?.amount))
      if (amount <= 0) return fail('Znesek dela plačila mora biti večji od 0.', 400)
      const ta = p?.terminal && typeof (p.terminal as { approvalCode?: unknown }).approvalCode === 'string'
        ? String((p.terminal as { approvalCode: string }).approvalCode).trim().slice(0, 40)
        : ''
      if (['card', 'mobile'].includes(type) && !ta) {
        return fail('Kartični/mobilni del plačila zahteva odobritev terminala (approvalCode).', 402)
      }
      let giftCardId: string | undefined
      if (type === 'giftcard') {
        const gcErr = await preloadGiftCard(p?.giftCardId, amount)
        if (gcErr) return fail(gcErr, 409)
        giftCardId = String(p?.giftCardId).trim()
      }
      parts.push({ type, amount, terminalApproval: ta, ...(giftCardId ? { giftCardId } : {}) })
    }
  } else {
    // klasična pot — eno plačilo preostanka (po odbitku unovčenih točk)
    const legacyType = PAYMENT_TYPES_DB.includes(String(body.type || '').toLowerCase())
      ? String(body.type).toLowerCase()
      : 'cash'
    if (legacyType === 'loyalty') return fail('Plačilo s točkami: uporabi loyaltyPointsUsed.', 400)
    const ta = body?.terminal && typeof body.terminal.approvalCode === 'string'
      ? body.terminal.approvalCode.trim().slice(0, 40)
      : ''
    if (['card', 'mobile'].includes(legacyType) && !ta) {
      return fail('Kartično plačilo zahteva odobritev terminala (approvalCode).', 402)
    }
    const legacyAmount = r2(total - redeemValue)
    if (legacyAmount > 0) {
      let legacyGc: string | undefined
      if (legacyType === 'giftcard') {
        const gcErr = await preloadGiftCard(body?.giftCardId, legacyAmount)
        if (gcErr) return fail(gcErr, 409)
        legacyGc = String(body?.giftCardId).trim()
      }
      parts.push({ type: legacyType, amount: legacyAmount, terminalApproval: ta, ...(legacyGc ? { giftCardId: legacyGc } : {}) })
    }
  }

  // ── Usklajenost zneskov: deli + unovčene točke = za plačanje (preprečitev preplačila) ──
  const partsSum = r2(parts.reduce((s, p) => s + p.amount, 0))
  const expected = r2(redeemValue + partsSum)
  if (Math.abs(expected - total) > 0.004) {
    return fail(
      `Vsota delov plačila (${partsSum.toFixed(2)} €)${redeemValue ? ` + točke (${redeemValue.toFixed(2)} €)` : ''} mora biti enaka znesku za plačanje (${total.toFixed(2)} €).`,
      400,
    )
  }

  const paymentMethod = parts.length === 0 ? 'loyalty' : parts.length === 1 ? parts[0].type : 'mixed'
  const idemBase = idempotencyKey || ''

  // razčlenba DDV po stopnjah
  const vatMap: Record<string, { base: number; vat: number }> = {}
  for (const it of billItems) {
    const rate = it.vatRate.toFixed(2)
    const base = it.unitPrice * it.quantity
    const vat = it.vatAmount
    if (!vatMap[rate]) vatMap[rate] = { base: 0, vat: 0 }
    vatMap[rate].base += base
    vatMap[rate].vat += vat
  }

  // zaslužene točke (kanonično pravilo) — samo identified gost + omogočen program
  const earnedPoints = loyaltyAccount && location.loyaltyEnabled
    ? earnPointsFor(total, location.loyaltyPointsPerEuro)
    : 0

  try {
    const receipt = await db.$transaction(async (tx) => {
      // CAS zaščita: posodobi naročilo SAMO če še ni plačano → dvojni klic izgubi dirko
      const cas = await tx.order.updateMany({
        where: { id: orderPre.id, paymentStatus: { not: 'paid' } },
        data: { status: 'paid', paymentStatus: 'paid', paidAt: now, paymentMethod },
      })
      if (cas.count === 0) {
        // drug klic je že plačal → vrni njegov račun (idempotentno)
        const twin = await tx.receipt.findFirst({
          where: { orderId: orderPre.id },
          orderBy: { createdAt: 'desc' },
        })
        if (twin) return { twin, duplicate: true as const }
        // plačano mimo plačilnega poteka (npr. ročni PAID) — brez računa
        throw new OrderError('Naročilo je že plačano (brez računa).', 409)
      }

      const seqFloor = await tx.receipt.count({ where: { locationId: location.id } })
      const seq = await nextSequence(tx, `receipt:${location.id}`, seqFloor + 1)
      const y = now.getFullYear()
      const m = now.getMonth() + 1
      const receiptNumber = `${y}-${m}-${seq}-${location.premisesId || 'BLG001'}`

      // Fiskalni adapter po državi lokacije (triage SI/HR fiskalizacija):
      //  SI → ZOI/EOR (FURS simulacija / produkcija pending) — pot MORA ostati byte-identična (§18),
      //  HR → ZKI/JIR (Fiskalizacija 2.0, NN 89/2025 + Pravilnik NN 153/2025; QR = porezna.gov.hr/rn).
      // Vektor byte-identičnosti SI ZOI: tests/fiscal.test.ts.
      const fiscal = fiscalAdapterFor(location.country)
      const isHrFiscal = fiscal.country === 'HR'
      const codes = fiscal.computeCodes({
        taxId: location.taxId || '',
        issuedAt: now,
        receiptNumber,
        premisesId: location.premisesId || 'BLG001',
        total,
        simulation,
      })
      const zoi = isHrFiscal ? '' : codes.protective
      const eor = isHrFiscal ? '' : codes.verification

      const check = await tx.check.create({
        data: {
          id: nid(),
          checkNumber: 1,
          orderId: orderPre.id,
          subtotal,
          tax: totalVat,
          discount: bill.discountTotal,
          appliedDiscountId: bill.autoDiscounts[0]?.discountId || null,
          total,
          tip,
          totalWithTip: total + tip,
          paymentStatus: 'paid',
          paymentMethod,
        },
      })

      const created = await tx.receipt.create({
        data: {
          id: nid(),
          receiptNumber,
          orderId: orderPre.id,
          businessName: location.name,
          businessAddress: location.address || '',
          businessId: location.businessId || '',
          taxId: location.taxId || '',
          registerId: location.registerNumber || 'BLG-001',
          zoi,
          eor,
          fiscalVerified: simulation,
          fiscalStatus: simulation ? 'verified' : 'pending',
          verificationDate: simulation ? now : null,
          subtotal,
          vatBreakdown: jstr(vatMap),
          totalVat,
          discount: bill.discountTotal,
          total,
          tip,
          totalWithTip: total + tip,
          paymentMethod,
          printedAt: now,
          locationId: location.id,
          cisStatus: isHrFiscal ? (simulation ? 'verified' : 'pending') : 'none',
          cisZki: isHrFiscal ? codes.protective : '',
          cisJir: isHrFiscal ? codes.verification : '',
        },
      })

      // ── Payment vrstice: ena za vsak del + ena za unovčene točke ──
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        if (p.type === 'giftcard' && p.giftCardId) {
          // CAS odbitje z darilne kartice: uspe SAMO če je še vedno dovolj sredstev
          // (zaščita pred sočasnim/dvojnim unovčenjem — enaka politika kot pri točkah).
          // Centno-natančna aritmetika (SQLite REAL drift) + enakostni CAS (race-safe).
          const fresh = await tx.giftCard.findUnique({ where: { id: p.giftCardId }, select: { balance: true } })
          const currentCents = Math.round(num(fresh?.balance) * 100)
          const amountCents = Math.round(p.amount * 100)
          if (!fresh || currentCents < amountCents) {
            throw new OrderError('Darilna kartica nima več dovolj sredstev (sočasno unovčenje).', 409)
          }
          const newBalance = (currentCents - amountCents) / 100
          const cas = await tx.giftCard.updateMany({
            where: { id: p.giftCardId, balance: fresh.balance },
            data: { balance: newBalance },
          })
          if (cas.count === 0) {
            throw new OrderError('Darilna kartica je bila sočasno spremenjena (unovčenje).', 409)
          }
          await tx.giftCardTransaction.create({
            data: {
              id: nid(),
              giftCardId: p.giftCardId,
              type: 'redeem',
              amount: -p.amount,
              balanceAfter: newBalance,
              orderId: orderPre.id,
              checkId: check.id,
              note: `Unovčenje ob plačilu računa ${receiptNumber}`,
            },
          })
        }
        await tx.payment.create({
          data: {
            id: nid(),
            checkId: check.id,
            amount: p.amount,
            tipAmount: i === 0 ? tip : 0,
            type: p.type as 'cash' | 'card' | 'mobile' | 'voucher' | 'giftcard' | 'alternate',
            status: 'completed',
            employeeId: user.sub,
            idempotencyKey: idemBase ? `${idemBase}#p${i}` : null,
            authorizationCode: p.terminalApproval,
            ...(p.type === 'giftcard' && p.giftCardId ? { giftCardId: p.giftCardId } : {}),
          },
        })
      }
      if (redeemValue > 0 && loyaltyAccount) {
        // CAS odbitje točk: uspe SAMO če ima gost še vedno dovolj (zaščita pred dvojnim unovčenjem)
        const dec = await tx.loyaltyAccount.updateMany({
          where: { id: loyaltyAccount.id, pointsBalance: { gte: redeemPoints } },
          data: { pointsBalance: { decrement: redeemPoints } },
        })
        if (dec.count === 0) throw new OrderError('Gost nima več dovolj točk (sočasno unovčenje).', 409)
        await tx.payment.create({
          data: {
            id: nid(),
            checkId: check.id,
            amount: redeemValue,
            type: 'loyalty',
            status: 'completed',
            employeeId: user.sub,
            loyaltyAccountId: loyaltyAccount.id,
            loyaltyPointsUsed: redeemPoints,
            idempotencyKey: idemBase ? `${idemBase}#loyalty` : null,
          },
        })
        await tx.loyaltyTransaction.create({
          data: {
            id: nid(),
            loyaltyAccountId: loyaltyAccount.id,
            type: 'redeem',
            points: -redeemPoints,
            reason: 'Unovčenje točk ob plačilu računa',
            orderId: orderPre.id,
            checkId: check.id,
            monetaryValue: redeemValue,
          },
        })
      }
      if (earnedPoints > 0 && loyaltyAccount) {
        const newLifetime = loyaltyAccount.lifetimePoints + earnedPoints
        await tx.loyaltyAccount.update({
          where: { id: loyaltyAccount.id },
          data: { lifetimePoints: { increment: earnedPoints }, pointsBalance: { increment: earnedPoints }, tier: tierForPoints(newLifetime) },
        })
        await tx.loyaltyTransaction.create({
          data: {
            id: nid(),
            loyaltyAccountId: loyaltyAccount.id,
            type: 'earn',
            points: earnedPoints,
            reason: `Zaslužek ob plačilu (${location.loyaltyPointsPerEuro}/€)`,
            orderId: orderPre.id,
            checkId: check.id,
            monetaryValue: total,
          },
        })
      }

      if (orderPre.tableId) {
        await tx.table.update({ where: { id: orderPre.tableId }, data: { status: 'cleaning' } })
      }

      // Razknjiževanje zalog po recepturah (idempotentno, v ISTI transakciji kot račun
      // — če se račun zavrne, se razknjiževanje tudi; primanjkljaj ne blokira prodaje)
      const stock = await deductStockForOrderTx(tx, orderPre.id, user.sub, user.name)

      // Revizijski dnevnik kritične operacije (issue #1: audit)
      const __aId2 = nid(); const __chain2 = await auditChainFields(tx, { action: 'INVOICE_ISSUE', entityType: 'Receipt', entityId: created.id, details: jstr({ receiptNumber, orderId: orderPre.id, total, grossTotal: bill.grossTotal, discountTotal: bill.discountTotal, manualDiscount: bill.manualDiscount, autoDiscounts: bill.autoDiscounts, paymentMethod, parts: parts.map((p) => ({ type: p.type, amount: p.amount, giftCard: p.giftCardId && giftCards.get(p.giftCardId) ? maskCardNumber(giftCards.get(p.giftCardId)!.cardNumber) : undefined, })), loyalty: loyaltyAccount ? { accountId: loyaltyAccount.id, redeemedPoints: redeemPoints, redeemedValue: redeemValue, earnedPoints } : null, simulation, terminalApproval: parts.map((p) => p.terminalApproval).filter(Boolean).join(',') || null, stockDeduction: stock.deducted ? { lines: stock.lines, totalCost: stock.totalCost, shortfalls: stock.shortfalls.length } : null, }), locationId: location.id, id: __aId2 })
      await tx.auditLog.create({
        data: { ...__chain2,
          id: __aId2,
          userId: user.sub,
          action: 'INVOICE_ISSUE',
          entityType: 'Receipt',
          entityId: created.id,
          details: jstr({
            receiptNumber,
            orderId: orderPre.id,
            total,
            grossTotal: bill.grossTotal,
            discountTotal: bill.discountTotal,
            manualDiscount: bill.manualDiscount,
            autoDiscounts: bill.autoDiscounts,
            paymentMethod,
            parts: parts.map((p) => ({
              type: p.type,
              amount: p.amount,
              // Issue #1 (triage ③): maskirana št. darilne kartice v reviziji
              giftCard: p.giftCardId && giftCards.get(p.giftCardId)
                ? maskCardNumber(giftCards.get(p.giftCardId)!.cardNumber)
                : undefined,
            })),
            loyalty: loyaltyAccount ? { accountId: loyaltyAccount.id, redeemedPoints: redeemPoints, redeemedValue: redeemValue, earnedPoints } : null,
            simulation,
            terminalApproval: parts.map((p) => p.terminalApproval).filter(Boolean).join(',') || null,
            stockDeduction: stock.deducted
              ? { lines: stock.lines, totalCost: stock.totalCost, shortfalls: stock.shortfalls.length }
              : null,
          }),
          locationId: location.id,
        },
      })

      return { twin: created, duplicate: false as const }
    })

    if (receipt.duplicate) {
      return ok({
        invoice: mapReceipt(receipt.twin),
        replayed: true,
        order: { id: orderPre.id, status: 'PAID' },
      }, 200)
    }
    // Issue #11 §3 — dogodek izdaje računa (evidenca, fire-and-forget)
    await publishEvent('InvoiceCreated', {
      entityType: 'Receipt',
      entityId: receipt.twin.id,
      // 33-c: locationId v payloadu (lokacijsko vidni dogodki — audit §6)
      payload: { receiptNumber: receipt.twin.receiptNumber, orderId: orderPre.id, total, simulation, locationId: orderPre.locationId },
    }).catch(() => undefined)
    // Adapter je čista fabrika — po transakciji ga znova pridobimo in QR gradimo iz
    // DB polj računa (resnica o shranjenem, ne o spremenljivkah iz tx obsega).
    const fiscalOuter = fiscalAdapterFor(location.country)
    const fiscalQr = fiscalOuter.qrContent({
      verification: receipt.twin.cisJir || receipt.twin.eor,
      protective: receipt.twin.cisZki || receipt.twin.zoi,
      issuedAt: now,
      total,
    })
    return ok({
      invoice: {
        ...mapReceipt(receipt.twin),
        country: fiscalOuter.country,
        zki: receipt.twin.cisZki || undefined,
        jir: receipt.twin.cisJir || undefined,
        qr: fiscalQr || undefined,
      },
      // Issue #4 §8: simulator se NIKOLI ne predstavlja kot prava fiskalizacija
      fursEnvironment: simulation ? 'simulation' : 'production_pending',
      fiscalVerified: receipt.twin.fiscalVerified,
      fiscalStatus: receipt.twin.fiscalStatus,
      // Triage SI/HR: fiskalna oznaka po državi (ZOI/EOR vs ZKI/JIR + QR)
      fiscal: {
        country: fiscalOuter.country,
        codeLabel: fiscalOuter.codeLabel,
        verifyLabel: fiscalOuter.verifyLabel,
        simulated: simulation,
        qr: fiscalQr,
      },
      order: { ...orderPre, status: 'PAID', fursEor: receipt.twin.eor },
      bill: { discountTotal: bill.discountTotal, autoDiscounts: bill.autoDiscounts, totalDue: total },
      loyalty: loyaltyAccount ? { redeemedPoints: redeemPoints, redeemedValue: redeemValue, earnedPoints } : null,
    }, 201)
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status)
    // P2002 na Payment.idempotencyKey → vzporedni dvojnik je zmagal
    if ((e as { code?: string })?.code === 'P2002' && idempotencyKey) {
      const existing = await findReceiptByIdempotencyKey(idempotencyKey)
      if (existing) {
        return ok({ invoice: existing, replayed: true, order: { id: orderPre.id, status: 'PAID' } }, 200)
      }
    }
    console.error('[furs POST] transakcija ni uspela:', e)
    return fail('Plačila ni bilo mogoče zaključiti. Stanje je nespremenjeno — poskusite znova.', 500)
  }
}

/** Poišči račun po idempotency ključu plačila (replay podpora).
 *  Pokriva tudi deljeno plačilo/zvestobo, kjer so ključi priponjeni: `key#p0`, `key#loyalty`. */
async function findReceiptByIdempotencyKey(key: string) {
  const payment = await db.payment.findFirst({
    where: { OR: [{ idempotencyKey: key }, { idempotencyKey: { startsWith: `${key}#` } }] },
    include: { Check: true },
    orderBy: { createdAt: 'asc' as const },
  })
  if (!payment) return null
  const receipt = await db.receipt.findFirst({
    where: { orderId: payment.Check.orderId },
    orderBy: { createdAt: 'desc' },
  })
  return receipt ? mapReceipt(receipt) : null
}
