/**
 * AUDIT-FIX val 2 (v1.82.2) — jedro POST /api/furs izločeno iz route handlerja.
 * Pure move: telo funkcije je dobesedno preneseno (brez sprememb vedenja);
 * route (src/app/api/furs/route.ts) je tanki delegat — vsi obstoječi testi
 * (tests/furs-post.test.ts uvozi POST iz route) pokrivajo delegat → jedro.
 *
 * Vsebuje: plačilo + FURS/CIS račun ATOMARNO ($transaction), OPS-7 split po
 * izstavkih (Check), zvestoba (unovčenje/zaslužek točk), darilne kartice (CAS),
 * deljeno plačilo (parts), idempotenčni replay (clientOperationId), ZOI/EOR (SI)
 * + ZKI/JIR (HR) fiskalizacija po certifikatih izven/znova po transakciji.
 *
 * Pravica: orders.pay (enako kot prej — avtentikacija ostaja v jedru, ker
 * requirePermission zahteva NextRequest; vzorec enak src/lib/recurring-run.ts).
 */

import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapReceipt, nid, num, r2, jstr, PAYMENT_TYPES_DB, ORDER_ACTIVE_DB } from '@/lib/map'
import { isMissingSchemaError } from '@/lib/prisma-missing'
import { nextSequence } from '@/lib/sequences'
import { publishEvent } from '@/lib/events'
import { pushEvent } from '@/lib/push'
import { OrderError } from '@/lib/ops'
import { computeBill, earnPointsFor, tierForPoints, BillItem } from '@/lib/billing'
import { deductStockForOrderTx, type StockDeductionResult } from '@/lib/inventory'
import { maybeNotifyLowStock } from '@/lib/low-stock'
import { canRedeem, maskCardNumber } from '@/lib/giftcards'
import { fiscalAdapterFor } from '@/lib/fiscal'
import { certFromEnv, signZoi, fursInvoice } from '@/lib/furs/client'
import { cisCertFromEnv, signZki, cisInvoice, hrNacinPlac } from '@/lib/cis/client'
import { auditChainFields } from '@/lib/audit-chain'
import { approvalAttestationProfile, paymentPolicyError, type PaymentAttestationProfile } from '@/lib/payments-policy'

interface PaymentPart {
  type: string
  amount: number
  terminalApproval: string
  // Issue #1 (triage ③): del plačila z darilno kartico — zahteva giftCardId
  giftCardId?: string
  // Issue #49: profil dokazovanja kartičnega/mobilnega dela — določi STREŽNIK
  // (samo za KLIENTU poslane dele; PayLink dele overi vrstica povezave status='paid')
  attestation?: PaymentAttestationProfile
}

export async function issueFursReceipt(req: NextRequest) {
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
  const payGuard = await guardResource(user, orderPre.locationId)
  if (payGuard) return payGuard
  if (!ORDER_ACTIVE_DB.includes(orderPre.status) && orderPre.status !== 'paid') {
    return fail('Naročilo ni v plačljivem stanju.', 409)
  }
  // Naloga 37: terminalna stanja so KONČNA — plačilo/fakturacija ni več mogoča.
  // Storno = popolna negacija prodaje (fiskalni storno račun izdan, zaloga povrnjena);
  // ponovni PRE /api/furs bi izdal NOV račun nad že negirano prodajo. Gate je PRED
  // idempotenčnim replayem (terminalno stanje mora biti vidno, ne zamaskirano kot 'replayed').
  if (orderPre.paymentStatus === 'storno') {
    return fail('Naročilo je stornirano — ponovno plačilo ni mogoče. Ustvarite novo naročilo.', 409)
  }
  if (orderPre.paymentStatus === 'cancelled') {
    return fail('Naročilo je preklicano — plačilo ni mogoče.', 409)
  }

  // Idempotentni replay — plačilo za ta clientOperationId + ISTO naročilo že obstaja?
  // Issue #50: ključ je podan od klienta (NI poverilnica in ne dovoljenje) —
  // velja SAMO za isto naročilo. Ključ, vezan na drugo naročilo (tudi tujega
  // tenanta), NE vrne tujega računa in ne poroča naročila kot plačanega → 409.
  if (idempotencyKey) {
    const existing = await findReceiptByIdempotencyKey(idempotencyKey, orderPre.id)
    if (existing && existing.kind === 'foreign') {
      return fail('Idempotenčni ključ je že vezan na drugo naročilo — uporabite nov ključ.', 409)
    }
    if (existing && existing.kind === 'receipt') {
      return ok({ invoice: existing.receipt, replayed: true, order: { id: orderPre.id, status: 'PAID' } }, 200)
    }
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

  // ── OPS-7 (v1.68.0) — SPLIT PO IZSTAVKIH (Check): plačilo PODMNOŽICE postavk ──
  // Toast/Lightspeed vzorec: Check = neodvisen plačilni enota (checkNumber per order,
  // OrderItem.checkId, Payment.checkId — shema že od v1.x). Pravila:
  //  - checkId v body-ju → plačujemo SAMO postavke tega izstavka;
  //  - delitev postavk med izstavke je dovoljena SAMO dokler NIČ ni plačano
  //    (konserviranost zneskov: proporcionalni popust + zadnji plačani izstavek
  //     absorbira ostanek popusta → Σ izstavkov = račun celote);
  //  - račun (Receipt) nastane PER IZSTAVEK (fiskalno pravilen, DDV iz postavk izstavka),
  //    zaloga se odšteje samo za postavke izstavka (deductStockForOrderTx onlyItemIds);
  //  - miza/poraba naročila se zaključita šele ko so plačani VSI izstavki.
  // preslikava postavka → izstavek (OrderItem.checkId; null = privzeti/edini izstavek)
  const checkItemIdsCache = new Map<string, string | null>(
    orderPre.OrderItem.filter((it) => !it.voided).map((it) => [it.id, it.checkId ?? null]),
  )

  const checksAll = await db.check.findMany({
    where: { orderId: orderPre.id },
    orderBy: { checkNumber: 'asc' },
    select: { id: true, checkNumber: true, paymentStatus: true, discount: true },
  })
  const reqCheckId = typeof body?.checkId === 'string' && body.checkId.trim() ? body.checkId.trim() : null
  interface CheckScope {
    check: { id: string; checkNumber: number }
    itemIds: string[]
    items: BillItem[]
    subtotal: number
    tax: number
    discount: number
    total: number
    paidOthers: number
    unpaidOthers: number
  }
  let checkScope: CheckScope | null = null
  if (reqCheckId) {
    const target = checksAll.find((c) => c.id === reqCheckId)
    if (!target) return fail('Izstavek (Check) ne obstaja za to naročilo.', 404)
    if (target.paymentStatus === 'paid') return fail('Ta izstavek je že plačan.', 409)
    const paidOthers = checksAll.filter((c) => c.id !== target.id && c.paymentStatus === 'paid').length
    const unpaidOthers = checksAll.filter((c) => c.id !== target.id && c.paymentStatus !== 'paid').length
    // OPOMBA: plačilo preostalih izstavkov po že plačanem izstavku je DOVOLJENO in zaželeno
    // (toast/Lightspeed tok: izstavek 1 plačan → izstavek 2/3 sledijo). Omejitev "samo dokler
    // nič ni plačano" velja izključno za DELETE postavk med izstavki (/api/orders/[id]/checks
    // POST/DELETE) — tam je konserviranost zneskov vedno ohranjena (proporcija + ostankovni izstavek).
    // postavke izstavka (ne-voided); če izstavek še nima postavk (prazen) → napaka
    const scopeItems = billItems.filter((it) => (checkItemIdsCache.get(it.id) ?? null) === target.id)
    if (scopeItems.length === 0) return fail('Izstavek ne vsebuje plačljivih postavk.', 400)
    const scopeSubtotal = r2(scopeItems.reduce((s, it) => s + it.unitPrice * it.quantity, 0))
    const scopeTax = r2(scopeItems.reduce((s, it) => s + it.vatAmount, 0))
    const scopeGross = r2(scopeSubtotal + scopeTax)
    // proporcionalni popust; zadnji (edini še neplačani) izstavek absorbira ostanek
    let scopeDiscount: number
    if (unpaidOthers === 0) {
      scopeDiscount = r2(Math.max(0, bill.discountTotal))
    } else {
      scopeDiscount = r2(bill.discountTotal * (scopeSubtotal / Math.max(0.01, bill.subtotal)))
      scopeDiscount = r2(Math.min(scopeDiscount, scopeGross))
    }
    const scopeTotal = r2(Math.max(0, scopeGross - scopeDiscount))
    checkScope = {
      check: { id: target.id, checkNumber: target.checkNumber },
      itemIds: scopeItems.map((it) => it.id),
      items: scopeItems,
      subtotal: scopeSubtotal,
      tax: scopeTax,
      discount: scopeDiscount,
      total: scopeTotal,
      paidOthers,
      unpaidOthers,
    }
  }

  const subtotal = checkScope ? checkScope.subtotal : bill.subtotal
  const totalVat = checkScope ? checkScope.tax : bill.tax
  const total = checkScope ? checkScope.total : bill.totalDue // znesek ZA PLAČANJE (po popustih)
  // Issue #1 (triage ①): napitnina lahko pride direktno s plačilom (body.tip, iz POS dialoga)
  // ali je bila že nastavljena na naročilu (orderPre.tip) — aditivno, nazaj-kompatibilno.
  let tip =
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
    // OPS-7 split po izstavkih: limit unovčenja se računa na ZNESEK OBSEGA (izstavek ali cel račun)
    const maxRedeemable = checkScope
      ? Math.floor(checkScope.total / Math.max(0.01, num(location.loyaltyPointsValue, 0.01)))
      : bill.loyalty.maxRedeemablePoints
    if (redeemPoints > maxRedeemable) {
      return fail(`Največ ${maxRedeemable} točk je mogoče unovčiti na tem računu.`, 400)
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
  // ── P1-6 (v1.87.0) — DELEŽI, PLAČANI PREK PLAČILNIH POVEZAV (split po gostih) ──
  // Vmesna plačila deležev (PayLink status='paid', receiptId še null, amount fiksna)
  // so ŽE POBRAŠEN denar (odobritev terminala je na vrstici povezave) — jedro jih
  // samodejno prišteje med dele plačila (en vir resnice):
  //  - zadnji gost splita pokliče s parts: [] → račun pokrijejo SAMO povezave;
  //  - POS zaključek: KLASIČNA pot (type + brez parts) samodejno plača SAMO
  //    PREOSTANEK (total − točke − pobrani deleži — Toast-style "plačaj odprti
  //    balance"); eksplicitni parts morajo vsoto dopolniti do celote;
  //  - naročila BREZ povezav: 0 vrstic → obnašanje bit-identično prej (0 vpliva).
  // Napitnine povezav se prištejejo k body tip (račun ima eno napitnino).
  // POZOR: klasična (N=1) povezava se OZNAČI plačana ŠELE PO tem klicu — ob klicu
  // je še 'open' → ni vključena (brez dvojnega štetja).
  // POZOR (produkcija): med migrate-paylink-split DDL stolpci morda še manjkajo —
  // shemska napaka (P2010/42703) NI plačilna napaka: izdaja/deleži takrat niso
  // možni (payLinkReady 503) → mirno prazna lista (POS plačila delujejo).
  const paidLinks = checkScope
    ? [] // checkScope način: povezave pokrivajo CELOTO naročila — mešanje z izstavki ni smiselno (vsota bi razneslo)
    : await db.payLink
        .findMany({
          where: { orderId: orderPre.id, status: 'paid', receiptId: null, amount: { not: null } },
          orderBy: [{ splitIndex: 'asc' }, { createdAt: 'asc' }],
          select: { amount: true, tip: true, approvalCode: true },
        })
        .catch((e: unknown) => {
          if (isMissingSchemaError(e)) return []
          throw e
        })
  let linkPaidTotal = 0
  for (const l of paidLinks) {
    const la = r2(num(l.amount))
    if (la <= 0) continue
    linkPaidTotal = r2(linkPaidTotal + la)
  }
  const linkTipTotal = paidLinks.length ? r2(paidLinks.reduce((s, l) => s + Math.max(0, num(l.tip)), 0)) : 0
  if (linkTipTotal > 0) tip = r2(tip + linkTipTotal)

  const parts: PaymentPart[] = []
  // P1-6: Array.isArray tudi za PRAZNO polje — caller (zadnji gost split plačilnih
  // povezav) s praznim nizom pove »ročnih delov ni, znesek mora prinesti links«.
  if (Array.isArray(body?.parts)) {
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
      // Issue #49: STREŽNIŠKA politika dokazovanja kartičnega/mobilnega dela.
      // Profil odobritvene kode klasificira STREŽNIK (SIM- predpona = simulator,
      // vse drugo = ročna zabeležba zaposlenega, dokler ni prave ponudniške
      // integracije). Klientov način terminala (localStorage) NE more spremeniti
      // politike; simulator velja SAMO v strežniško določenem simulacijskem okolju.
      let attestation: PaymentAttestationProfile | undefined
      if (['card', 'mobile'].includes(type) && ta) {
        attestation = approvalAttestationProfile(ta)
        const policyErr = paymentPolicyError(attestation, simulation)
        if (policyErr) return fail(policyErr, 402)
      }
      let giftCardId: string | undefined
      if (type === 'giftcard') {
        const gcErr = await preloadGiftCard(p?.giftCardId, amount)
        if (gcErr) return fail(gcErr, 409)
        giftCardId = String(p?.giftCardId).trim()
      }
      parts.push({ type, amount, terminalApproval: ta, ...(giftCardId ? { giftCardId } : {}), ...(attestation ? { attestation } : {}) })
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
    // Issue #49: enaka strežniška politika dokazovanja za klasično (posamezno) pot
    let legacyAttestation: PaymentAttestationProfile | undefined
    if (['card', 'mobile'].includes(legacyType) && ta) {
      legacyAttestation = approvalAttestationProfile(ta)
      const policyErr = paymentPolicyError(legacyAttestation, simulation)
      if (policyErr) return fail(policyErr, 402)
    }
    // P1-6: klasična pot plača SAMO PREOSTANEK — pobrani deleži povezav se
    // prištejejo med dele spodaj (vsota = celota; Toast-style odprti balance)
    const legacyAmount = r2(total - redeemValue - linkPaidTotal)
    if (legacyAmount > 0) {
      let legacyGc: string | undefined
      if (legacyType === 'giftcard') {
        const gcErr = await preloadGiftCard(body?.giftCardId, legacyAmount)
        if (gcErr) return fail(gcErr, 409)
        legacyGc = String(body?.giftCardId).trim()
      }
      parts.push({ type: legacyType, amount: legacyAmount, terminalApproval: ta, ...(legacyGc ? { giftCardId: legacyGc } : {}), ...(legacyAttestation ? { attestation: legacyAttestation } : {}) })
    }
  }

  // P1-6: deleži povezav kot PLAČILNI DELI (tip 'card', odobritev iz vrstice —
  // sledljivost kot terminalske SIM-/pi- kode)
  for (const l of paidLinks) {
    const la = r2(num(l.amount))
    if (la <= 0) continue
    parts.push({ type: 'card', amount: la, terminalApproval: (l.approvalCode || '').trim().slice(0, 40) })
  }

  // ── Usklajenost zneskov: deli + unovčene točke = za plačanje (preprečitev preplačila) ──
  const partsSum = r2(parts.reduce((s, p) => s + p.amount, 0))
  const expected = r2(redeemValue + partsSum)
  if (Math.abs(expected - total) > 0.004) {
    return fail(
      `Vsota delov plačila (${partsSum.toFixed(2)} €)${redeemValue ? ` + točke (${redeemValue.toFixed(2)} €)` : ''} mora biti enaka znesku za plačanje (${total.toFixed(2)} €)${linkPaidTotal > 0 ? ` — prek plačilnih povezav je že bilo pobranih ${linkPaidTotal.toFixed(2)} € (plačajte le preostanek)` : ''}.`,
      400,
    )
  }

  const paymentMethod = parts.length === 0 ? 'loyalty' : parts.length === 1 ? parts[0].type : 'mixed'
  const idemBase = idempotencyKey || ''

  // razčlenba DDV po stopnjah
  const vatMap: Record<string, { base: number; vat: number }> = {}
  // OPS-7: v split načinu DDV razčlenba SAMO iz postavk izstavka (fiskalna resnica računa)
  const vatSourceItems = checkScope ? checkScope.items : billItems
  for (const it of vatSourceItems) {
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

  // Naloga 36: vezava FURS certifikata IZVEN transakcije (P12 parsing enkrat na zahtevek;
  // referenca potrebna tako znotraj tx — ZOI — kot po tx — EOR SOAP klic).
  // Naloga 38: vezava HR CIS certifikata na istem mestu (ZKI v tx, JIR po tx).
  const isHrFiscal = fiscalAdapterFor(location.country).country === 'HR'
  const fursProd = !simulation && !isHrFiscal ? certFromEnv() : null
  const hrProd = !simulation && isHrFiscal ? cisCertFromEnv() : null

  try {
    const receipt = await db.$transaction(async (tx) => {
      // ── OPS-7 split po izstavkih: v check načinu CAS gre na CHECK (ne na naročilo) ──
      if (checkScope) {
        const casCheck = await tx.check.updateMany({
          where: { id: checkScope.check.id, paymentStatus: { in: ['unpaid', 'partial'] } },
          data: { paymentStatus: 'paid', paymentMethod },
        })
        if (casCheck.count === 0) {
          // drug klic je že plačal ta izstavek → vrni njegov račun (idempotentno):
          // plačilo izstavka prepoznamo po idempotencyKey prvega dela plačila
          const twinPayment = idemBase
            ? await tx.payment.findFirst({
                where: { checkId: checkScope.check.id, idempotencyKey: { startsWith: idemBase } },
                orderBy: { createdAt: 'asc' },
              })
            : null
          const twin = twinPayment
            ? await tx.receipt.findFirst({
                where: { orderId: orderPre.id, isStorno: false, createdAt: { gte: twinPayment.createdAt } },
                orderBy: { createdAt: 'asc' },
              })
            : null
          if (twin) return { twin, duplicate: true as const }
          throw new OrderError('Izstavek je že plačan (brez računa).', 409)
        }
      } else {
        // CAS zaščita (Naloga 37: eksplicitna bela lista plačljivih stanj — fail-closed
        // tudi ob prihodnjih novih terminalnih vrednostih enuma) → dvojni klic izgubi dirko
        const cas = await tx.order.updateMany({
          where: { id: orderPre.id, paymentStatus: { in: ['unpaid', 'partial'] } },
          data: { status: 'paid', paymentStatus: 'paid', paidAt: now, paymentMethod },
        })
        if (cas.count === 0) {
          // drug klic je že plačal → vrni njegov račun (idempotentno)
          // Naloga 37: SAMO original (isStorno=false) — storno negacija ni "plačilni" račun
          const twin = await tx.receipt.findFirst({
            where: { orderId: orderPre.id, isStorno: false },
            orderBy: { createdAt: 'desc' },
          })
          if (twin) return { twin, duplicate: true as const }
          // plačano mimo plačilnega poteka (npr. ročni PAID) — brez računa
          throw new OrderError('Naročilo je že plačano (brez računa).', 409)
        }
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
      const codes = fiscal.computeCodes({
        taxId: location.taxId || '',
        issuedAt: now,
        receiptNumber,
        premisesId: location.premisesId || 'BLG001',
        total,
        simulation,
      })
      let zoi = isHrFiscal ? '' : codes.protective
      const eor = isHrFiscal ? '' : codes.verification

      // Naloga 36: produkcija s certifikatom → PRAVI ZOI (RSA-SHA256 podpis,
      // lokalna kripto — varno v transakciji). Brez certifikata ostane dozdajšnje
      // vedenje (prazne kode → 'pending').
      if (fursProd) {
        zoi = signZoi(
          { taxId: location.taxId || '', issuedAt: now, receiptNumber, premisesId: location.premisesId || 'BLG001', total },
          fursProd.cert.keyPem
        )
      }

      // Naloga 38: produkcija HR s certifikatom → PRAVI ZKI (MD5hex(RSA-SHA256(podpis))
      // po spec Porezne uprave v2.7 pogl. 12). Brez certifikata ostane simulacijska/prazna
      // koda (obstoječe vedenje). JIR sledi po tx (cisInvoice SOAP klic).
      let cisZkiVal = isHrFiscal ? codes.protective : ''
      if (hrProd) {
        cisZkiVal = signZki(
          {
            oib: (location.taxId || '').replace(/\D/g, ''),
            issuedAt: now,
            invoiceNumber: String(seq),
            premisesId: location.premisesId || 'BLG001',
            deviceId: location.registerNumber || '1',
            total,
          },
          hrProd.cert.keyPem
        )
      }

      // OPS-7 split: v check načinu POSODOBIMO obstoječi izstavek (že ustvarjen ob delitvi),
      // v celotnem načinu ustvarimo izstavek #1 (nazaj-kompatibilno obnašanje).
      const check = checkScope
        ? await tx.check.update({
            where: { id: checkScope.check.id },
            data: {
              subtotal: checkScope.subtotal,
              tax: checkScope.tax,
              discount: checkScope.discount,
              appliedDiscountId: bill.autoDiscounts[0]?.discountId || null,
              total: checkScope.total,
              tip,
              totalWithTip: checkScope.total + tip,
              paymentMethod,
            },
          })
        : await tx.check.create({
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
          cisZki: cisZkiVal,
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

      // ── OPS-7 split po izstavkih: zaključek naročila/mize ŠELE ko so plačani VSI izstavki ──
      if (checkScope) {
        const unpaidLeft = await tx.check.count({ where: { orderId: orderPre.id, paymentStatus: { not: 'paid' } } })
        if (unpaidLeft === 0) {
          await tx.order.update({
            where: { id: orderPre.id },
            data: { status: 'paid', paymentStatus: 'paid', paidAt: now, paymentMethod },
          })
          if (orderPre.tableId) {
            await tx.table.update({ where: { id: orderPre.tableId }, data: { status: 'cleaning' } })
          }
        } else {
          // ostali izstavki še odprti → naročilo 'partial' (ne 'paid'), miza ostane zasedena
          await tx.order.update({
            where: { id: orderPre.id },
            data: { paymentStatus: 'partial' },
          })
        }
      } else {
        if (orderPre.tableId) {
          await tx.table.update({ where: { id: orderPre.tableId }, data: { status: 'cleaning' } })
        }
      }

      // Razknjiževanje zalog po recepturah (idempotentno, v ISTI transakciji kot račun
      // — če se račun zavrne, se razknjiževanje tudi; primanjkljaj ne blokira prodaje).
      // OPS-7 split: v check načinu odštejemo SAMO postavke plačanega izstavka.
      const stock = await deductStockForOrderTx(tx, orderPre.id, user.sub, user.name, checkScope ? checkScope.itemIds : undefined)

      // Revizijski dnevnik kritične operacije (issue #1: audit)
      const __aId2 = nid(); const __chain2 = await auditChainFields(tx, { action: 'INVOICE_ISSUE', entityType: 'Receipt', entityId: created.id, details: jstr({ receiptNumber, orderId: orderPre.id, total, grossTotal: bill.grossTotal, discountTotal: bill.discountTotal, manualDiscount: bill.manualDiscount, autoDiscounts: bill.autoDiscounts, paymentMethod, parts: parts.map((p) => ({ type: p.type, amount: p.amount, giftCard: p.giftCardId && giftCards.get(p.giftCardId) ? maskCardNumber(giftCards.get(p.giftCardId)!.cardNumber) : undefined, })), loyalty: loyaltyAccount ? { accountId: loyaltyAccount.id, redeemedPoints: redeemPoints, redeemedValue: redeemValue, earnedPoints } : null, simulation, terminalApproval: parts.map((p) => p.terminalApproval).filter(Boolean).join(',') || null, // Issue #49: profil dokazovanja kartičnih delov v reviziji (akter = userId
            // vrstice audita; ročna zabeležba NIKOLI ni predstavljena kot preverjena
            // pri ponudniku; PayLink dele izpusti — njihov dokaz je vrstica povezave)
            attestation: parts.filter((p) => p.attestation).map((p) => ({ type: p.type, profile: p.attestation })), stockDeduction: stock.deducted ? { lines: stock.lines, totalCost: stock.totalCost, shortfalls: stock.shortfalls.length } : null, }), locationId: location.id, id: __aId2 })
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
            // Issue #49: profil dokazovanja kartičnih delov (ročna zabeležba ni
            // ponudniško preverjena — glej src/lib/payments-policy.ts)
            attestation: parts.filter((p) => p.attestation).map((p) => ({ type: p.type, profile: p.attestation })),
            stockDeduction: stock.deducted
              ? { lines: stock.lines, totalCost: stock.totalCost, shortfalls: stock.shortfalls.length }
              : null,
          }),
          locationId: location.id,
        },
      })

      return { twin: created, duplicate: false as const, stock }
    })

    if (receipt.duplicate) {
      return ok({
        invoice: mapReceipt(receipt.twin),
        replayed: true,
        order: { id: orderPre.id, status: 'PAID' },
      }, 200)
    }

    // OPS-8 val 2 (v1.72.0): low-stock alert AFTER the tx commit (fire-and-forget,
    // try/catch inside the helper — NEVER affects the fiscal flow)
    if (receipt.stock.deducted && receipt.stock.deductions.length > 0) {
      void maybeNotifyLowStock(receipt.stock.deductions)
    }

    // Naloga 36: EOR — FURS SOAP klic PO transakciji (omrežje ne sme držati DB tx).
    // Fail-safe: ob napaki račun ostane 'pending' (plačilo je že urejeno; poznejša
    // fiskalizacija gre prek SubsequentSubmit — runbook korak 5). Uspeh → verified.
    if (fursProd) {
      try {
        const taxNum = parseInt((location.taxId || '').replace(/\D/g, ''), 10)
        const resp = await fursInvoice(fursProd.env, fursProd.cert, {
          taxNumber: taxNum,
          issueDateTime: now.toISOString().slice(0, 19),
          invoiceNumber: String(Number(receipt.twin.receiptNumber.split('-')[2]) || 0),
          businessPremiseId: location.premisesId || 'BLG001',
          electronicDeviceId: location.registerNumber || 'BLG-001',
          invoiceAmount: total,
          paymentAmount: total,
          taxesPerSeller: Object.entries(vatMap).map(([rate, v]) => ({
            vatRate: Number(rate), basis: v.base, taxAmount: v.vat,
          })),
          operatorTaxNumber: taxNum, // rezidual: ločen OperatorTaxNumber (Location) pride z validacijo testnega okolja
          protectedID: receipt.twin.zoi,
          subsequentSubmit: false,
        })
        receipt.twin = await db.receipt.update({
          where: { id: receipt.twin.id },
          data: { eor: resp.eor, fiscalStatus: 'verified', fiscalVerified: true, verificationDate: new Date() },
        })
      } catch (e) {
        console.warn('[furs] produkcija EOR ni uspel — račun ostane pending:', (e as Error).message)
        // OPS-8 val 2 (v1.72.0): RECEIPT_FAILED push to management (matrix; fire-and-forget) —
        // receipt stays pending, later fiscalization goes via SubsequentSubmit
        void pushEvent('RECEIPT_FAILED', {
          title: 'FURS fiskalizacija ni uspela',
          body: `${receipt.twin.receiptNumber} — ${String((e as Error).message || 'napaka').slice(0, 120)}`,
          url: '/dashboard?tab=racuni',
          tag: `receipt-failed-${receipt.twin.id}`,
        }, { roles: ['manager', 'admin'], locationId: orderPre.locationId })
      }
    }
    // Naloga 38: JIR — CIS SOAP klic PO transakciji (zrcalno FURS EOR; omrežje ne sme
    // držati DB tx). Fail-safe: ob napaki račun ostane 'pending' (SubsequentSubmit
    // pozneje — runbook). Uspeh → cisStatus verified + cisJir + fiscalStatus verified.
    if (hrProd) {
      try {
        const oibDigits = (location.taxId || '').replace(/\D/g, '')
        const resp = await cisInvoice(hrProd.env, hrProd.cert, {
          oib: oibDigits,
          inVatSystem: Boolean(location.taxId),
          issuedAt: now,
          invoiceNumber: String(Number(receipt.twin.receiptNumber.split('-')[2]) || 0),
          premisesId: location.premisesId || 'BLG001',
          deviceId: location.registerNumber || '1',
          vatRates: Object.entries(vatMap).map(([rate, v]) => ({
            rate: Number(rate), base: v.base, amount: v.vat,
          })),
          total,
          paymentMethod: hrNacinPlac(paymentMethod),
          operatorOib: oibDigits, // rezidual: OIB operaterja (Employee) pride z validacijo testnega okolja
          zki: receipt.twin.cisZki,
          subsequentSubmit: false,
        })
        receipt.twin = await db.receipt.update({
          where: { id: receipt.twin.id },
          data: { cisJir: resp.jir, cisStatus: 'verified', cisSubmittedAt: new Date(), fiscalStatus: 'verified', fiscalVerified: true, verificationDate: new Date() },
        })
      } catch (e) {
        console.warn('[cis] produkcija JIR ni uspel — račun ostane pending:', (e as Error).message)
        // OPS-8 val 2 (v1.72.0): RECEIPT_FAILED push to management (matrix; fire-and-forget)
        void pushEvent('RECEIPT_FAILED', {
          title: 'CIS fiskalizacija ni uspela',
          body: `${receipt.twin.receiptNumber} — ${String((e as Error).message || 'napaka').slice(0, 120)}`,
          url: '/dashboard?tab=racuni',
          tag: `receipt-failed-${receipt.twin.id}`,
        }, { roles: ['manager', 'admin'], locationId: orderPre.locationId })
      }
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
      fursEnvironment: simulation ? 'simulation' : receipt.twin.fiscalStatus === 'verified' ? 'production' : 'production_pending',
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
      // Issue #50: ENAKA preverba vezave kot v predtransakcijskem replay-u —
      // vzporedni zmagovalnik z istim ključem na DRUGEM naročilu ne sme vrniti
      // tujega računa (transakcija se je povrnila v celoti — naročilo ostane unpaid)
      const existing = await findReceiptByIdempotencyKey(idempotencyKey, orderPre.id)
      if (existing && existing.kind === 'foreign') {
        return fail('Idempotenčni ključ je že vezan na drugo naročilo — uporabite nov ključ.', 409)
      }
      if (existing && existing.kind === 'receipt') {
        return ok({ invoice: existing.receipt, replayed: true, order: { id: orderPre.id, status: 'PAID' } }, 200)
      }
    }
    console.error('[furs POST] transakcija ni uspela:', e)
    return fail('Plačila ni bilo mogoče zaključiti. Stanje je nespremenjeno — poskusite znova.', 500)
  }
}

/**
 * Poišči račun po idempotency ključu plačila (replay podpora).
 *  Pokriva tudi deljeno plačilo/zvestobo, kjer so ključi priponjeni: `key#p0`, `key#loyalty`.
 *
 * Issue #50 (P1): idempotenca je VEZANA na kanonični tuple (orderId + ključ):
 *  - plačilo s ključem pripada ISTEMU naročilu → { kind: 'receipt', receipt };
 *  - ključ pripada DRUGEMU naročilu (tudi tujemu tenant-u) → { kind: 'foreign' }
 *    — klicatelj NE dobi tujega računa (klicno mesto vrne 409 brez podatkov);
 *  - ključ ni znan → null.
 * Ker je naročilo klica že varovano z guardResource(user, orderPre.locationId),
 * vezava na isto naročilo zagotavlja tudi isti tenant/lokacijo vračanega računa.
 */
async function findReceiptByIdempotencyKey(
  key: string,
  orderId: string
): Promise<{ kind: 'receipt'; receipt: ReturnType<typeof mapReceipt> } | { kind: 'foreign' } | null> {
  const payment = await db.payment.findFirst({
    where: { OR: [{ idempotencyKey: key }, { idempotencyKey: { startsWith: `${key}#` } }] },
    include: { Check: true },
    orderBy: { createdAt: 'asc' as const },
  })
  if (!payment) return null
  if (payment.Check.orderId !== orderId) return { kind: 'foreign' }
  // #50: račun mora pripadati ISTEMU kanoničnemu naročilu (ne le naročilu plačila);
  // storno negacija NI plačilni račun (enaka bela lista kot pri CAS twin iskanju)
  const receipt = await db.receipt.findFirst({
    where: { orderId, isStorno: false },
    orderBy: { createdAt: 'desc' },
  })
  return receipt ? { kind: 'receipt', receipt: mapReceipt(receipt) } : null
}
