import { db } from '@/lib/db'
import { resolvePayProvider, stripeSessionStatus } from '@/lib/paylink/core'
import {
  auditStripeReview,
  settleStripeSession,
  type LinkRow,
  type OrderLite,
  type StripeSessionView,
} from '@/lib/paylink/settle'

/**
 * v1.157.0 — uskladitev plačanih Stripe sej (varovalka ob webhooku).
 *
 * Webhook je primarna pot, a lahko ni konfiguriran, dostava pa tudi spodleti.
 * Ta prehod redno (dnevni cron) pogleda ODPRTE povezave s kanonično sejo,
 * vpraša Stripe za njeno stanje in PLAČANE poravna po istem jedru kot javni
 * POST. Poravna samo seje, ki so strežniško vezane na povezavo — tuje/neskladne
 * seje se zabeležijo v revizijo, denar pa se NE poravna samodejno.
 */

export interface ReconcileOptions {
  /** Največ povezav na en tek (privzeto 20, največ 100). */
  limit?: number
  /** Zoži na eno lokacijo (testi/ročna diagnostika); cron uporablja vse. */
  locationId?: string
  /** Injekcija za teste; privzeto Stripe API. */
  fetcher?: (secretKey: string, sessionId: string) => Promise<StripeSessionView>
  source?: string
}

export interface ReconcileSummary {
  scanned: number
  settled: number
  replayed: number
  skipped: number
  errors: number
  review: number
}

const REVIEW_REASONS = new Set([
  'not_canonical',
  'binding',
  'amount',
  'no_amount',
  'not_open',
  'order_terminal',
  'order_paid',
  'bill_changed',
])

export async function reconcilePaidStripeSessions(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)))
  const fetchStatus = opts.fetcher ?? stripeSessionStatus
  const source = opts.source ?? 'cron-paylinks'
  const rows = (await db.payLink.findMany({
    where: {
      status: 'open',
      sessionId: { not: null },
      amount: { not: null },
      ...(opts.locationId ? { locationId: opts.locationId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })) as unknown as LinkRow[]

  const summary: ReconcileSummary = { scanned: rows.length, settled: 0, replayed: 0, skipped: 0, errors: 0, review: 0 }

  for (const link of rows) {
    const order = (await db.order.findUnique({
      where: { id: link.orderId },
      select: { id: true, orderNumber: true, status: true, paymentStatus: true, tableId: true, locationId: true },
    })) as OrderLite | null
    if (!order) {
      summary.skipped++
      continue
    }
    let provider: Awaited<ReturnType<typeof resolvePayProvider>>
    try {
      provider = await resolvePayProvider(order.locationId)
    } catch {
      summary.errors++
      continue
    }
    if (provider.kind !== 'stripe' || !provider.secretKey) {
      summary.skipped++
      continue
    }
    let session: StripeSessionView
    try {
      session = await fetchStatus(provider.secretKey, link.sessionId as string)
    } catch {
      summary.errors++
      continue
    }
    if (!session.paid) {
      summary.skipped++
      continue
    }
    const result = await settleStripeSession({
      order,
      link,
      session,
      verifySessionId: link.sessionId as string,
      ip: source,
      allowExpired: true,
    })
    if (result.kind === 'settled') {
      summary.settled++
      if (result.replayed) summary.replayed++
      continue
    }
    if (result.kind === 'conflict') {
      summary.skipped++
      continue
    }
    summary.skipped++
    if (REVIEW_REASONS.has(result.reason)) {
      summary.review++
      await auditStripeReview({ order, link, session, reason: result.reason, detail: result.detail, source })
    }
  }
  return summary
}
