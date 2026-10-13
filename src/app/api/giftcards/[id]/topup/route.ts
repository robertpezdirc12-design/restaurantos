import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num, r2 } from '@/lib/map'
import { effectiveCardStatus, gcNote, giftCardTxId, validateTopUpCents } from '@/lib/giftcards'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #1 (triage ③) — polnjenje darilne kartice.
 *
 * POST /api/giftcards/[id]/topup { amount, note?, clientOperationId? }
 *   → dvigne saldo za amount (r2 na cent), ledžer 'topup' (podpisan +) z
 *     balanceAfter invarianto, audit GIFT_CARD_TOPUP. Pravica: orders.pay (blagajna).
 *
 * Idempotenca: clientOperationId → determinističen id transakcije (replay → isti zapis,
 * brez dodatnega polnjenja). Sočasnost: CAS na prebranem saldu — če se je saldo med
 * branjem in pisanjem spremenil, poskusamo znova (3×) → sicer 409 (ledžer invarianta).
 * Izčrpana kartica SE SME polniti (oživitev); deaktivirana/pretekla ne.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const amount = r2(num(body?.amount))
  const amountCents = Math.round(amount * 100)
  const err = validateTopUpCents(amountCents)
  if (err) return fail(err, 400)
  const note = gcNote(body?.note, 'Polnjenje darilne kartice')
  const clientOperationId =
    typeof body?.clientOperationId === 'string' && body.clientOperationId.trim().length >= 8
      ? body.clientOperationId.trim().slice(0, 64)
      : null

  const card = await db.giftCard.findUnique({ where: { id } })
  if (!card) return fail('Kartica ne obstaja.', 404)
  const st = effectiveCardStatus(card.status, Math.round(num(card.balance) * 100), card.expiresAt)
  if (st === 'inactive') return fail('Kartica je deaktivirana — najprej jo aktivirajte (Nastavitve pravic / urejanje kartice).', 409)
  if (st === 'expired') return fail('Kartica je pretekla — polnjenje ni mogoče.', 409)

  // Idempotentni replay — transakcija za ta clientOperationId že obstaja?
  const txId = giftCardTxId(id, clientOperationId || nid())
  if (clientOperationId) {
    const existing = await db.giftCardTransaction.findUnique({ where: { id: txId } })
    if (existing) {
      return ok(
        {
          card: { id: card.id, cardNumber: card.cardNumber, balance: num(card.balance), status: card.status },
          transaction: { id: existing.id, type: existing.type, amount: num(existing.amount), balanceAfter: num(existing.balanceAfter), note: existing.note, createdAt: existing.createdAt },
          replayed: true,
        },
        200,
      )
    }
  }

  // CAS polnjenje: preberi saldo → zapiši SAMO če se ni spremenil (ledžer invarianta)
  let done: { balanceAfter: number; transactionId: string } | null = null
  try {
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      done = await db.$transaction(async (tx) => {
        const fresh = await tx.giftCard.findUnique({ where: { id }, select: { balance: true } })
        if (!fresh) throw new Error('Kartica je izginila med polnjenjem.')
        // centno-natančna aritmetika (SQLite REAL drift pri Decimal) — saldo vedno iz centov
        const currentCents = Math.round(num(fresh.balance) * 100)
        const newBalance = (currentCents + amountCents) / 100
        const cas = await tx.giftCard.updateMany({
          where: { id, balance: fresh.balance },
          data: { balance: newBalance, updatedAt: new Date() },
        })
        if (cas.count === 0) return null // saldo se je spremenil → retry
        const rec = await tx.giftCardTransaction.create({
          data: {
            id: txId,
            giftCardId: id,
            type: 'topup',
            amount,
            balanceAfter: newBalance,
            note,
          },
        })
        return { balanceAfter: newBalance, transactionId: rec.id }
      })
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    // sočasni replay z istim clientOperationId → determinističen PK ujame → obravnavaj kot replay
    if (clientOperationId && msg.includes('Unique constraint')) {
      const existing = await db.giftCardTransaction.findUnique({ where: { id: txId } })
      if (existing) {
        const freshCard = await db.giftCard.findUnique({ where: { id } })
        return ok(
          {
            card: { id, cardNumber: card.cardNumber, balance: num(freshCard?.balance), status: freshCard?.status },
            transaction: { id: existing.id, type: existing.type, amount: num(existing.amount), balanceAfter: num(existing.balanceAfter), note: existing.note, createdAt: existing.createdAt },
            replayed: true,
          },
          200,
        )
      }
    }
    if (!msg.includes('Unique constraint')) return fail(`Polnjenje ni uspelo: ${msg}`, 500)
  }
  if (!done) return fail('Kartica je bila sočasno spremenjena — poskusite znova.', 409)

  const updated = await db.giftCard.findUnique({ where: { id } })

  await writeAudit(db, { userId: user.sub, action: 'GIFT_CARD_TOPUP', entityType: 'GiftCard', entityId: id, details: JSON.stringify({
        cardNumber: card.cardNumber,
        amount,
        balanceAfter: num(updated?.balance),
        note,
        idempotent: Boolean(clientOperationId),
      }), locationId: card.locationId })

  return ok(
    {
      card: { id, cardNumber: card.cardNumber, balance: num(updated?.balance), status: updated?.status },
      transaction: { id: done.transactionId, type: 'topup', amount, balanceAfter: num(updated?.balance), note, createdAt: new Date() },
      replayed: false,
    },
    201,
  )
}
