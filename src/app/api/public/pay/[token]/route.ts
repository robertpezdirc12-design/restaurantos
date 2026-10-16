import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail } from '@/lib/api'
import { createToken } from '@/lib/auth'
import { writeAudit } from '@/lib/audit-chain'
import { r2 } from '@/lib/map'
import { rateLimitPublic, clientIp } from '@/lib/guest'
import {
  isPayLinkTokenShape,
  resolvePayProvider,
  simulatedCharge,
  stripeCreateCheckout,
  stripeSessionStatus,
  stripeExpireSession,
  finalizePayLinkSet,
  loadOrderBill,
  payLinkUrl,
  payLinkReady,
} from '@/lib/paylink/core'

/**
 * P0-2 TRZNA-VRZELI (v1.85.0) + P1-6 SPLIT PO GOSTIH (v1.87.0) — JAVNA plačilna
 * povezava (brez prijave).
 *
 * GET  /api/public/pay/<token>  → stanje + račun (kanonični computeBill) +
 *                                 split kontekst (delež i/n, plačanih m)
 * POST /api/public/pay/<token>  → plačilo DELEŽA (split) ali CELOTE (klasično):
 *                                 simulator odobri takoj; Stripe vrne redirect
 *                                 na Checkout sejo ({ verifySession } = potrditev).
 *
 * Issue #37 (P0, v1.98.0) — VEZAVA STRIPE SEJE NA KONKRETNO POVEZAVO:
 *  - ustvarjanje: seja nosi server-side metadata (payLinkId/orderId/locationId/
 *    znesek/valuta) + client_reference_id + Idempotency-Key vezan na
 *    (povezava, znesek); KANONIČNI sessionId se shrani na PayLink atomarno
 *    (CAS) — sočasna klica ustvarijoSAMO eno plačljivo sejo (izgubljenikova
 *    seja se zapre); ponovljen POST z istim zneskom ponovno uporabi isto
 *    odprto sejo, sprememba zneska jo varno zamenja (stara se zapre);
 *  - potrditev: SAMO seja, ki je shranjena kot kanonična ZA TO povezavo, se
 *    sprejme — plačana seja z ISTIM zneskom iz druge povezave/naročila je
 *    ZAVRNJENA (preverjamo sessionId + metadata + valuto + mode + znesek,
 *    strežniško nad Stripe odgovorom);
 *  - poravnava: atomaren prehod open → paid (CAS) — sočasni/dvojni potrditvi
 *    povzročita EN finančni učinek (zgubi → idempotentni replay odgovor).
 *
 * P1-6 split tok (N povezav na naročilo — vsak gost svoj QR/delež):
 *  - delež je FIKSEN na vrstici povezave (amount) — gost ga ne more spremeniti;
 *    napitnina izbira SAMO nase (0 … delež);
 *  - vmesno plačilo: link → paid (amount/tip/approvalCode/paidAt), naročilo →
 *    'partial' (CAS), RAČUN ŠE NI izdan — gost vidi 'vaš delež je plačan';
 *  - ZADNJI delež: kanonični FURS zaključek (issueFursReceipt, parts=[] → jedro
 *    samo prišteje plačane deleže + napitnine) → račun + EOR + miza cleaning;
 *    clientOperationId 'plkset:<orderId>' = idempotentno (replay isti račun);
 *  - POS zaključek preostanka: osebje plača preostanek na POS → jedro prišteje
 *    pobrane deleže k delom plačila (issue.ts P1-6 blok) → en račun za celoto.
 *
 * Varnost (iste discipline kot Issue #3 javni tok):
 *  - token (32-hex skrivnost) JE avtorizacija; ID-ji se rešijo strežniško;
 *  - znesek/napitnina se izračunata na strežniku (computeBill), clientu ne zaupamo;
 *  - CAS/obnova: GET na plačanem deležu brez računa obnovi zaključek niza;
 *  - rate limit: 60 branj/min/IP + 10 plačil/min/IP;
 *  - 404 brez razlikovanja (ne uganjaj žetone).
 */

const TIP_PRESETS = [0, 5, 10, 15]

interface LinkRow {
  id: string
  token: string
  orderId: string
  locationId: string
  status: string
  amount: { toNumber: () => number } | null
  tip: { toNumber: () => number } | null
  splitIndex: number
  splitCount: number
  approvalCode: string
  /** #37: kanonična Stripe Checkout seja za to povezavo. */
  sessionId: string | null
  expiresAt: Date | null
  paidAt: Date | null
  receiptId: string | null
}

interface OrderLite {
  id: string
  orderNumber: number
  status: string
  paymentStatus: string
  tableId: string | null
  locationId: string
}

/** Pobrani deleži povezav naročila (vmesna plačila brez končnega računa). */
async function paidLinkSum(orderId: string): Promise<{ sum: number; count: number }> {
  const rows = await db.payLink.findMany({
    where: { orderId, status: 'paid', receiptId: null, amount: { not: null } },
    select: { amount: true },
  })
  return { sum: rows.length ? r2(rows.reduce((s, l) => s + Number(l.amount), 0)) : 0, count: rows.length }
}

/** Odgovor za plačano povezavo (iz Receipt vrstice — št. računa, EOR/JIR, znesek). */
async function paidPayload(link: LinkRow) {
  const receipt = link.receiptId
    ? await db.receipt.findUnique({
        where: { id: link.receiptId },
        select: {
          receiptNumber: true,
          eor: true,
          zoi: true,
          cisJir: true,
          cisZki: true,
          total: true,
          tip: true,
          totalWithTip: true,
          paymentMethod: true,
          fiscalStatus: true,
        },
      })
    : null
  const loc = await db.location.findUnique({ where: { id: link.locationId }, select: { name: true } }).catch(() => null)
  const paid = await paidLinkSum(link.orderId)
  const split =
    link.splitCount > 1 || link.amount != null
      ? {
          index: link.splitIndex,
          count: link.splitCount,
          share: link.amount == null ? null : r2(Number(link.amount)),
          paidShares: paid.count,
          receiptPending: !link.receiptId,
        }
      : undefined
  return {
    status: 'paid' as const,
    paidAt: link.paidAt,
    receiptPending: !link.receiptId,
    location: { name: loc?.name || '' },
    receipt: receipt
      ? {
          receiptNumber: receipt.receiptNumber,
          eor: receipt.eor || null,
          zoi: receipt.zoi || null,
          jir: receipt.cisJir || null,
          zki: receipt.cisZki || null,
          total: r2(Number(receipt.total)),
          tip: r2(Number(receipt.tip)),
          totalWithTip: r2(Number(receipt.totalWithTip)),
          paymentMethod: receipt.paymentMethod,
          fiscalStatus: receipt.fiscalStatus,
        }
      : null,
    share: link.amount == null ? null : r2(Number(link.amount)),
    tip: link.tip == null ? null : r2(Number(link.tip)),
    approvalCode: link.approvalCode || null,
    split,
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const ip = clientIp(req)
  if (!rateLimitPublic(`payview:${ip}:${token}`, 60)) return fail('Preveč zahtev. Počakajte trenutek.', 429)
  if (!isPayLinkTokenShape(token)) return fail('Povezava ne obstaja.', 404)
  if (!(await payLinkReady())) return fail('Plačilne povezave trenutno niso aktivne — poskusite kmalu znova.', 503)

  const link = (await db.payLink.findUnique({ where: { token } })) as LinkRow | null
  if (!link) return fail('Povezava ne obstaja.', 404)
  const order = (await db.order.findUnique({
    where: { id: link.orderId },
    select: { id: true, orderNumber: true, status: true, paymentStatus: true, tableId: true, locationId: true },
  })) as OrderLite | null
  if (!order) return fail('Povezava ne obstaja.', 404)

  // plačano prek povezave
  if (link.status === 'paid') {
    // P1-6 obnova: delež plačan, računa še ni, odprtih povezav ni več → DOKONČAJ
    // niz (idempotentno — 'plkset:<orderId>'; napaka ne ruši pogleda gosta)
    if (!link.receiptId) {
      const openLeft = await db.payLink.count({ where: { orderId: order.id, status: 'open' } })
      if (openLeft === 0) {
        await finalizePayLinkSet(order.id, ip).catch(() => null)
        const refreshed = (await db.payLink.findUnique({ where: { token } })) as LinkRow | null
        if (refreshed) link.receiptId = refreshed.receiptId
      }
    }
    return ok(await paidPayload(link))
  }
  if (link.status === 'revoked') return ok({ status: 'revoked' })
  // terminalna naročila (storno/preklic) → povezave mrtve (VSE odprte naročila)
  if (order.paymentStatus === 'storno' || order.paymentStatus === 'cancelled' || order.status === 'cancelled') {
    if (link.status === 'open') {
      await db.payLink.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'revoked' } }).catch(() => {})
    }
    return ok({ status: 'revoked' })
  }
  // plačano drugje (POS) → superseded (leni prehod, vse odprte povezave)
  if (order.paymentStatus === 'paid') {
    if (link.status === 'open') {
      await db.payLink.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'superseded' } }).catch(() => {})
    }
    return ok({ status: 'superseded' })
  }
  if (link.status === 'superseded') return ok({ status: 'superseded' })
  // poteklo
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return ok({ status: 'expired' })

  // ── odprto: kanonični račun + kontekst za gosta (brez PII) ──
  const billData = await loadOrderBill(order.id)
  if (!billData) return fail('Računa ni mogoče izračunati.', 409)
  const [table, location, paid] = await Promise.all([
    order.tableId ? db.table.findUnique({ where: { id: order.tableId }, select: { number: true } }) : null,
    db.location.findUnique({ where: { id: order.locationId }, select: { name: true } }),
    paidLinkSum(order.id),
  ])
  const provider = await resolvePayProvider(order.locationId)
  const split =
    link.splitCount > 1 || link.amount != null
      ? {
          index: link.splitIndex,
          count: link.splitCount,
          share: link.amount == null ? r2(billData.totalDue - paid.sum) : r2(Number(link.amount)),
          paidShares: paid.count,
          paidTotal: paid.sum,
          remaining: r2(billData.totalDue - paid.sum),
        }
      : undefined
  return ok({
    status: 'open',
    provider: provider.kind,
    expiresAt: link.expiresAt,
    order: { orderNumber: order.orderNumber, table: table ? `Miza ${table.number}` : null },
    location: { name: location?.name || '' },
    bill: {
      subtotal: billData.bill['subtotal'],
      tax: billData.bill['tax'],
      discountTotal: billData.bill['discountTotal'],
      totalDue: billData.totalDue,
    },
    tipPresets: TIP_PRESETS,
    split,
  })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const ip = clientIp(req)
  if (!rateLimitPublic(`paypost:${ip}:${token}`, 10)) return fail('Preveč poskusov plačila. Počakajte trenutek.', 429)
  if (!isPayLinkTokenShape(token)) return fail('Povezava ne obstaja.', 404)
  if (!(await payLinkReady())) return fail('Plačilne povezave trenutno niso aktivne — poskusite kmalu znova.', 503)
  const body = (await req.json().catch(() => null)) as { tip?: unknown; verifySession?: unknown } | null

  const link = (await db.payLink.findUnique({ where: { token } })) as LinkRow | null
  if (!link) return fail('Povezava ne obstaja.', 404)
  const order = (await db.order.findUnique({
    where: { id: link.orderId },
    select: { id: true, orderNumber: true, status: true, paymentStatus: true, tableId: true, locationId: true },
  })) as OrderLite | null
  if (!order) return fail('Povezava ne obstaja.', 404)

  if (link.status === 'paid') return fail('Račun je že plačan.', 409)
  if (link.status === 'revoked' || order.paymentStatus === 'storno' || order.paymentStatus === 'cancelled') {
    return fail('Povezava je preklicana.', 409)
  }
  // P1-6: 'partial' je veljaven SAMO kadar je posledica plačanih deležev povezav
  const paid = await paidLinkSum(order.id)
  if (order.paymentStatus === 'paid' || link.status === 'superseded' || (order.paymentStatus !== 'unpaid' && !(order.paymentStatus === 'partial' && paid.count > 0))) {
    if (link.status === 'open') {
      await db.payLink.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'superseded' } }).catch(() => {})
    }
    return fail('Naročilo je že plačano drugje.', 409)
  }
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return fail('Povezava je potekla. Prosimo, zaprosite osebje za novo.', 409)
  }

  const provider = await resolvePayProvider(order.locationId)

  // ── P1-6: delež te povezave (fiksni split ali dinamični preostanek) ──
  const billData = await loadOrderBill(order.id)
  if (!billData) return fail('Računa ni mogoče izračunati.', 409)
  const share = link.amount != null ? r2(Number(link.amount)) : r2(billData.totalDue - paid.sum)
  if (share < 0.01) return fail('Nič ni več za plačilo prek te povezave.', 409)
  // odprte povezave RAZEN te — ali sem zadnji?
  const openOthers = await db.payLink.count({ where: { orderId: order.id, status: 'open', id: { not: link.id } } })
  const paidAfter = r2(paid.sum + share)
  // varovalka konservativnosti zneska (račun se je lahko spremenil po izdaji):
  // nikoli ne poberej VEČ kot je račun; če sem zadnji, mora niz pokriti TOČNO
  // celoto (jedro sicer zavrne s 400 — pred pobiranjem denarja!)
  if (paidAfter > billData.totalDue + 0.004) {
    return fail('Račun se je spremenil — prosite osebje za novo povezavo.', 409)
  }
  if (openOthers === 0 && Math.abs(paidAfter - billData.totalDue) > 0.004) {
    return fail('Račun se je spremenil — prosite osebje za novo povezavo.', 409)
  }

  // ── Stripe potrditev po vrnitvi ({ verifySession }) — Issue #37 ──
  const verifySession = String(body?.verifySession || '').trim()
  if (verifySession) {
    if (provider.kind !== 'stripe' || !provider.secretKey) return fail('Potrditev seje ni na voljo.', 400)
    if (link.amount == null || link.tip == null) return fail('Seja ni bila ustvarjena.', 409)
    // #37 točka 1: SAMO kanonična seja te povezave je veljavna — znani ID
    // TUJE plačane seje (tudi z istim zneskom) se zavrnejo, ŠELE pred klicem
    if (verifySession !== link.sessionId) {
      return fail('Plačilna seja ni veljavna za to povezavo.', 409)
    }
    // Issue #3 §B (P2): stripeSessionStatus lahko pade na omrežju/API (prej surov 500 s
    // tehničnim sporočilom). Gost dobi POŠTENO prijazno sporočilo (502), povezava
    // OSTA odprta — ponovni poskus potrditve je varen (seja ni plačana = ne poravnava).
    let status: Awaited<ReturnType<typeof stripeSessionStatus>>
    try {
      status = await stripeSessionStatus(provider.secretKey, verifySession)
    } catch {
      return fail('Preverjanje plačila trenutno ni dosegljivo. Poskusite znova.', 502)
    }
    if (!status.paid) return fail('Plačilo še ni potrjeno.', 409)
    // #37 točka 2: strežniško preverjena VEZAVA na TO povezavo (Stripe echo id,
    // metadata, ki jih klient ne more ponarediti; valuta/mode/znesek)
    const expected = Math.round((Number(link.amount) + Number(link.tip)) * 100)
    const bound =
      status.id === verifySession &&
      status.metadata?.payLinkId === link.id &&
      status.metadata?.orderId === link.orderId &&
      status.metadata?.locationId === link.locationId &&
      (status.metadata?.expectedAmountCents == null || Number(status.metadata.expectedAmountCents) === expected) &&
      (status.currency == null || status.currency === 'eur') &&
      (status.mode == null || status.mode === 'payment') &&
      status.sessionStatus !== 'expired'
    if (!bound) {
      return fail('Plačilna seja ni veljavna za to povezavo.', 409)
    }
    // neposrednost: znesek seje se mora ujemati z zaklenjenim deležem+napitnino
    if (status.amountTotalCents != null && status.amountTotalCents !== expected) {
      return fail('Znesek seje se ne ujema s povezavo.', 409)
    }
    const approvalCode = (status.paymentIntent || `stripe-${verifySession.slice(0, 20)}`).slice(0, 40)
    return settleShare(order, link, share, Number(link.tip), approvalCode, ip, openOthers, link.sessionId)
  }

  // ── plačilo: najprej kanonični račun (napitnina ≤ DELEŽ) ──
  const tipRaw = Number(body?.tip)
  const tip = Number.isFinite(tipRaw) ? r2(tipRaw) : 0
  if (tip < 0 || tip > share) {
    return fail('Napitnina je izven dovoljenega obsega (0 do zneska deleža).', 400)
  }

  if (provider.kind === 'stripe' && provider.secretKey) {
    const origin = payLinkUrl(req, token).slice(0, -(token.length + 1)) // .../pay
    const amountCents = Math.round((share + tip) * 100)
    const description = link.splitCount > 1 ? `Račun #${order.orderNumber} — delež ${link.splitIndex}/${link.splitCount}` : `Račun #${order.orderNumber}`

    // #37: obstoječa KANONIČNA seja — ponovna uporaba (isti znesek, še odprta)
    // ali poravnava (že plačana, a še nepotrjena), nikoli druga plačljiva seja
    if (link.sessionId) {
      const existing = await stripeSessionStatus(provider.secretKey, link.sessionId).catch(() => null)
      const stillBound = existing?.metadata?.payLinkId === link.id && existing?.metadata?.orderId === link.orderId
      if (existing && existing.paid && stillBound && existing.id === link.sessionId) {
        // seja je ŽE plačana → potrdi prek kanonične poti (ne ustvari nove!)
        const approvalCode = (existing.paymentIntent || `stripe-${link.sessionId.slice(0, 20)}`).slice(0, 40)
        return settleShare(order, link, share, Number(link.tip), approvalCode, ip, openOthers, link.sessionId)
      }
      if (existing && existing.sessionStatus === 'open' && stillBound && existing.url && (existing.amountTotalCents ?? amountCents) === amountCents) {
        // isti znesek (isti delež + napitnina) → ISTA seja (idempotenca; napitnino
        // na povezavi le uskladimo z zaklenjenim stanjem)
        await db.payLink.update({ where: { id: link.id }, data: { amount: share, tip } })
        return ok({ redirect: existing.url, sessionId: link.sessionId, amount: r2(share + tip), share }, 201)
      }
      // seja je zaprta/potekla ali znesek se je spremenil → VARNA ZAMENJAVA:
      // najprej nova seja (Idempotency-Key na nov znesek), nato atomarna
      // zamenjava (CAS na staro vrednost) in zaprtje stare (best-effort).
    }

    const session = await stripeCreateCheckout({
      secretKey: provider.secretKey,
      amountCents,
      currency: 'eur',
      description,
      successUrl: `${origin}/${token}?s={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/${token}`,
      // #37: server-side vezava na KONKRETNO povezavo/naročilo/lokacijo
      payLinkId: link.id,
      orderId: order.id,
      locationId: order.locationId,
    })

    // #37: atomarna prijava KANONIČNE seje (CAS) — sočasna klica ustvarijo samo
    // eno plačljivo sejo; izgubljenikovo sejo zapremo in vrnemo zmagovalčevo
    const prevSession = link.sessionId
    const cas = prevSession
      ? await db.payLink.updateMany({
          where: { id: link.id, status: 'open', sessionId: prevSession },
          data: { sessionId: session.sessionId, amount: share, tip },
        })
      : await db.payLink.updateMany({
          where: { id: link.id, status: 'open', sessionId: null },
          data: { sessionId: session.sessionId, amount: share, tip },
        })
    if (cas.count === 0) {
      // izgubil CAS — zapri svojo (best-effort) in poročaj zmagovalčevo sejo
      await stripeExpireSession(provider.secretKey, session.sessionId).catch(() => null)
      const fresh = (await db.payLink.findUnique({ where: { id: link.id } })) as LinkRow | null
      if (fresh?.sessionId && fresh.sessionId !== session.sessionId) {
        const winner = await stripeSessionStatus(provider.secretKey, fresh.sessionId).catch(() => null)
        if (winner?.url) {
          return ok({ redirect: winner.url, sessionId: fresh.sessionId, amount: r2(share + tip), share }, 201)
        }
        return ok({ sessionId: fresh.sessionId, amount: r2(share + tip), share }, 201)
      }
      // povezava je bila medtem poravnana/preklicana
      return fail('Račun je že plačan.', 409)
    }
    if (prevSession) {
      // zamenjava — staro sejo zapremo (best-effort; denar, če je bil zajet,
      // rešuje samo kanonična pot poravnave)
      await stripeExpireSession(provider.secretKey, prevSession).catch(() => null)
    }
    // P1-6: amount = DELEŽ (brez napitnine — plačilni del), tip posebej
    return ok({ redirect: session.url, sessionId: session.sessionId, amount: r2(share + tip), share }, 201)
  }

  // ── simulator: odobritev + poravna deleža (končni račun SAMO ob zadnjem) ──
  const charge = await simulatedCharge(share + tip)
  return settleShare(order, link, share, tip, charge.approvalCode, ip, openOthers)
}

/**
 * P1-6 poravna DELEŽA povezave: označi plačan (amount/tip/approvalCode), CAS
 * naročilo → 'partial'; če je povezava ZADNJA odprta → kanonični FURS zaključek
 * celotnega niza (parts=[] → jedro prišteje plačane deleže; idempotenca
 * 'plkset:<orderId>'), sicer gost vidi 'delež plačan, račun sledi ob zaključku'.
 *
 * Issue #37: prehod open → paid je ATOMAREN (CAS updateMany na status='open') —
 * sočasni/dvojni potrditvi povzročita EN finančni učinek; zgubljeni zahtevek
 * dobi idempotentni (že plačano) ali zavrnjeni (409) odgovor BREZ ponovnega
 * obračuna. sessionRef (Stripe cs_ prefix) se zapiše v revizijo v omejeni,
 * ne-skrivni obliki (sledljivost do seje — issue zahteva).
 */
async function settleShare(
  order: OrderLite,
  link: LinkRow,
  share: number,
  tip: number,
  approvalCode: string,
  ip: string,
  openOthers: number,
  sessionRef?: string | null,
) {
  const now = new Date()
  // #37: ATOMARNI prehod open → paid (CAS) — samo zmagovalni zahtevek nadaljuje
  const cas = await db.payLink.updateMany({
    where: { id: link.id, status: 'open' },
    data: {
      status: 'paid',
      paidAt: now,
      amount: share,
      tip: r2(tip),
      approvalCode: String(approvalCode || '').slice(0, 40),
    },
  })
  if (cas.count === 0) {
    // sočasni/dvojni zahtevek — idempotentni odgovor brez drugega učinka
    const fresh = (await db.payLink.findUnique({ where: { id: link.id } })) as LinkRow | null
    if (fresh?.status === 'paid') {
      return ok({ ...(await paidPayload(fresh)), replayed: true })
    }
    return fail('Račun je že plačan.', 409)
  }

  if (openOthers > 0) {
    // ── vmesni delež: naročilo 'partial' (CAS — unpaid → partial), brez računa ──
    await db.order
      .updateMany({ where: { id: order.id, paymentStatus: 'unpaid' }, data: { paymentStatus: 'partial' } })
      .catch(() => {})
    await writeAudit(db, {
      userId: null,
      action: 'PAY_LINK_SHARE_PAID',
      entityType: 'PayLink',
      entityId: link.id,
      details: `order=#${order.orderNumber} token=${link.token.slice(0, 8)}… share=${share.toFixed(2)} tip=${r2(tip).toFixed(2)} approval=${String(approvalCode).slice(0, 20)}${sessionRef ? ` session=${String(sessionRef).slice(0, 14)}…` : ''} split=${link.splitIndex}/${link.splitCount}`,
      ipAddress: ip,
      locationId: order.locationId,
    }).catch(() => {})
    const paidNow = await paidLinkSum(order.id)
    return ok({
      status: 'paid',
      paidAt: now,
      share,
      tip: r2(tip),
      approvalCode: String(approvalCode || '').slice(0, 40),
      split: {
        index: link.splitIndex,
        count: link.splitCount,
        paidShares: paidNow.count,
        receiptPending: true,
      },
      receipt: null,
      receiptPending: true,
    })
  }

  // ── zadnji delež: končni račun prek kanoničnega FURS jedra (0 duplikata) ──
  const result = await finalizePayLinkSet(order.id, ip)
  if (!result.ok) {
    // CAS spor (POS je medtem plačal) → superseded, gost vidi prijazno stanje
    if (result.status === 409) {
      await db.payLink.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'superseded' } }).catch(() => {})
      return fail('Naročilo je že plačano drugje.', 409)
    }
    return fail(result.error, result.status)
  }
  if (!result.replayed) {
    await writeAudit(db, {
      userId: null,
      action: 'PAY_LINK_PAID',
      entityType: 'PayLink',
      entityId: link.id,
      details: `order=#${order.orderNumber} token=${link.token.slice(0, 8)}… final=1 share=${share.toFixed(2)} tip=${r2(tip).toFixed(2)} approval=${String(approvalCode).slice(0, 20)}${sessionRef ? ` session=${String(sessionRef).slice(0, 14)}…` : ''} split=${link.splitIndex}/${link.splitCount}`,
      ipAddress: ip,
      locationId: order.locationId,
    }).catch(() => {})
  }
  const refreshed = (await db.payLink.findUnique({ where: { id: link.id } })) as LinkRow | null
  return ok({ ...(refreshed ? await paidPayload(refreshed) : { status: 'paid' as const }), replayed: result.replayed })
}
