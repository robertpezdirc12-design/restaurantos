import { db } from '@/lib/db'
import { writeAudit } from '@/lib/audit-chain'
import { r2 } from '@/lib/map'
import { finalizePayLinkSet, loadOrderBill } from '@/lib/paylink/core'

/**
 * v1.157.0 — SKUPNO jedro poravnave plačilne povezave.
 *
 * Isto jedro uporabljajo tri vstopne poti (javni POST po vrnitvi gosta,
 * podpisani Stripe webhook, dnevna uskladitev), zato finančni učinek ne more
 * divergirati med njimi: CAS open → paid, naročilo partial/paid, kanonični
 * FURS zaključek (`plkset:<orderId>`, idempotentno) in revizija.
 */

export interface LinkRow {
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
  sessionId: string | null
  expiresAt: Date | null
  paidAt: Date | null
  receiptId: string | null
}

export interface OrderLite {
  id: string
  orderNumber: number
  status: string
  paymentStatus: string
  tableId: string | null
  locationId: string
}

/** Pobrani deleži povezav naročila (vmesna plačila brez končnega računa). */
export async function paidLinkSum(orderId: string): Promise<{ sum: number; count: number }> {
  const rows = await db.payLink.findMany({
    where: { orderId, status: 'paid', receiptId: null, amount: { not: null } },
    select: { amount: true },
  })
  return { sum: rows.length ? r2(rows.reduce((s, l) => s + Number(l.amount), 0)) : 0, count: rows.length }
}

/** Odgovor za plačano povezavo (iz Receipt vrstice — št. računa, EOR/JIR, znesek). */
export async function paidPayload(link: LinkRow) {
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

export type SettleOutcome =
  | { kind: 'settled'; payload: Record<string, unknown>; replayed?: boolean }
  | { kind: 'conflict'; status: number; error: string }

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
export async function settleShareCore(
  order: OrderLite,
  link: LinkRow,
  share: number,
  tip: number,
  approvalCode: string,
  ip: string,
  openOthers: number,
  sessionRef?: string | null,
): Promise<SettleOutcome> {
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
      return { kind: 'settled', payload: await paidPayload(fresh), replayed: true }
    }
    return { kind: 'conflict', status: 409, error: 'Račun je že plačan.' }
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
    return {
      kind: 'settled',
      payload: {
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
      },
    }
  }

  // ── zadnji delež: končni račun prek kanoničnega FURS jedra (0 duplikata) ──
  const result = await finalizePayLinkSet(order.id, ip)
  if (!result.ok) {
    // CAS spor (POS je medtem plačal) → superseded, gost vidi prijazno stanje
    if (result.status === 409) {
      await db.payLink.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'superseded' } }).catch(() => {})
      return { kind: 'conflict', status: 409, error: 'Naročilo je že plačano drugje.' }
    }
    return { kind: 'conflict', status: result.status, error: result.error }
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
  return {
    kind: 'settled',
    payload: { ...(refreshed ? await paidPayload(refreshed) : { status: 'paid' as const }), replayed: result.replayed },
  }
}

/** Seja, kot jo vrne Stripe API ali podpisani webhook dogodek. */
export interface StripeSessionView {
  id: string | null
  paid: boolean
  paymentIntent: string | null
  amountTotalCents: number | null
  currency: string | null
  sessionStatus: string | null
  mode: string | null
  metadata: Record<string, string> | null
  clientReferenceId: string | null
}

export type StripeIgnoredReason =
  | 'not_paid'
  | 'not_canonical'
  | 'binding'
  | 'amount'
  | 'no_amount'
  | 'not_open'
  | 'expired'
  | 'order_terminal'
  | 'order_paid'
  | 'bill_changed'

export type StripeSettlementResult = SettleOutcome | { kind: 'ignored'; reason: StripeIgnoredReason; detail?: string }

/**
 * Plačana Stripe seja → poravnava povezave. Pravila so IDENTIČNA #37:
 * kanonična seja (shranjena na povezavi) + strežniška vezava metadata +
 * znesek/valuta/mode. Razlika med vstopnimi potmi je le `allowExpired`:
 * webhook/uskladitev poravnata tudi po poteku povezave, ker je denar že zajet
 * (zavrnitev bi pustila gosta brez računa); gostov POST ohranja staro mejo.
 */
export async function settleStripeSession(args: {
  order: OrderLite
  link: LinkRow
  session: StripeSessionView
  verifySessionId: string
  ip: string
  allowExpired?: boolean
}): Promise<StripeSettlementResult> {
  const { order, link, session, verifySessionId, ip, allowExpired = false } = args
  if (!session.paid) return { kind: 'ignored', reason: 'not_paid' }
  if (session.id !== verifySessionId || link.sessionId !== verifySessionId) {
    return { kind: 'ignored', reason: 'not_canonical' }
  }
  if (link.amount == null) return { kind: 'ignored', reason: 'no_amount' }

  const share = r2(Number(link.amount))
  const tip = r2(Number(link.tip ?? 0))
  const expected = Math.round((share + tip) * 100)
  const bound =
    session.metadata?.payLinkId === link.id &&
    session.metadata?.orderId === link.orderId &&
    session.metadata?.locationId === link.locationId &&
    (session.metadata?.expectedAmountCents == null || Number(session.metadata.expectedAmountCents) === expected) &&
    (session.currency == null || session.currency === 'eur') &&
    (session.mode == null || session.mode === 'payment') &&
    session.sessionStatus !== 'expired'
  if (!bound) return { kind: 'ignored', reason: 'binding' }
  if (session.amountTotalCents != null && session.amountTotalCents !== expected) {
    return { kind: 'ignored', reason: 'amount' }
  }
  if (share < 0.01) return { kind: 'ignored', reason: 'amount', detail: 'share<0.01' }

  if (link.status === 'paid') {
    const fresh = (await db.payLink.findUnique({ where: { id: link.id } })) as LinkRow | null
    if (fresh?.status === 'paid') return { kind: 'settled', payload: await paidPayload(fresh), replayed: true }
  }
  if (link.status !== 'open') return { kind: 'ignored', reason: 'not_open' }
  if (!allowExpired && link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return { kind: 'ignored', reason: 'expired' }
  }
  if (order.paymentStatus === 'storno' || order.paymentStatus === 'cancelled' || order.status === 'cancelled') {
    return { kind: 'ignored', reason: 'order_terminal' }
  }
  if (order.paymentStatus === 'paid') {
    await db.payLink.updateMany({ where: { orderId: order.id, status: 'open' }, data: { status: 'superseded' } }).catch(() => {})
    return { kind: 'ignored', reason: 'order_paid' }
  }

  const billData = await loadOrderBill(order.id)
  if (!billData) return { kind: 'ignored', reason: 'bill_changed', detail: 'bill' }
  const paid = await paidLinkSum(order.id)
  const openOthers = await db.payLink.count({ where: { orderId: order.id, status: 'open', id: { not: link.id } } })
  const paidAfter = r2(paid.sum + share)
  // varovalka konservativnosti zneska (račun se je lahko spremenil po izdaji):
  // nikoli ne poberej VEČ kot je račun; če sem zadnji, mora niz pokriti TOČNO
  // celoto (jedro sicer zavrne s 400 — tukaj denar je že zajet → revizija).
  if (paidAfter > billData.totalDue + 0.004) {
    return { kind: 'ignored', reason: 'bill_changed', detail: 'over' }
  }
  if (openOthers === 0 && Math.abs(paidAfter - billData.totalDue) > 0.004) {
    return { kind: 'ignored', reason: 'bill_changed', detail: 'final' }
  }

  const approvalCode = (session.paymentIntent || `stripe-${verifySessionId.slice(0, 20)}`).slice(0, 40)
  return settleShareCore(order, link, share, tip, approvalCode, ip, openOthers, verifySessionId)
}

/**
 * Zajeto plačilo, ki ga NI mogoče varno poravnati (tuja seja, spremenjen
 * račun, plačano drugje) → revizijska sled za osebje (morebitno vračilo).
 */
export async function auditStripeReview(args: {
  order: OrderLite
  link: LinkRow
  session: StripeSessionView
  reason: string
  source: string
  detail?: string
}): Promise<void> {
  const expected =
    args.link.amount == null ? '-' : String(Math.round((Number(args.link.amount) + Number(args.link.tip ?? 0)) * 100))
  await writeAudit(db, {
    userId: null,
    action: 'PAY_LINK_STRIPE_REVIEW',
    entityType: 'PayLink',
    entityId: args.link.id,
    details: `source=${args.source} order=#${args.order.orderNumber} token=${args.link.token.slice(0, 8)}… reason=${args.reason} session=${String(args.session.id || '').slice(0, 24)} amount=${args.session.amountTotalCents ?? '-'} expected=${expected}${args.detail ? ` detail=${args.detail}` : ''}`,
    ipAddress: args.source,
    locationId: args.order.locationId,
  }).catch(() => {})
}
