import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { num } from '@/lib/map'
import { effectiveCardStatus } from '@/lib/giftcards'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #1 (triage ③) — detalj + urejanje darilne kartice.
 *
 * GET /api/giftcards/[id]
 *   → kartica + zadnjih 100 transakcij (ledžer, najnovejše najprej).
 *     Pravica: requireAuth.
 *
 * PATCH /api/giftcards/[id] { ownerName?, expiresAt? ('' | null = počisti), status? ('active'|'inactive'), note? }
 *   → urejanje metapodatkov / deaktivacija-reaktivacija.
 *     Pravica: settings.manage (upravljavska odločitev — izdaja/polnjenje ostane blagajni).
 *     Audit GIFT_CARD_UPDATE s before/after polji.
 */
function mapCard(c: {
  id: string
  cardNumber: string
  balance: unknown
  initialBalance: unknown
  status: string
  ownerName: string
  purchasedAt: Date
  expiresAt: Date | null
  locationId: string | null
  createdAt: Date
}) {
  const balanceCents = Math.round(num(c.balance) * 100)
  return {
    id: c.id,
    cardNumber: c.cardNumber,
    balance: num(c.balance),
    initialBalance: num(c.initialBalance),
    status: c.status,
    effectiveStatus: effectiveCardStatus(c.status, balanceCents, c.expiresAt),
    ownerName: c.ownerName,
    purchasedAt: c.purchasedAt,
    expiresAt: c.expiresAt,
    locationId: c.locationId,
    createdAt: c.createdAt,
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const card = await db.giftCard.findUnique({ where: { id } })
  if (!card) return fail('Kartica ne obstaja.', 404)
  const transactions = await db.giftCardTransaction.findMany({
    where: { giftCardId: id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({
    card: mapCard(card),
    transactions: transactions.map((t) => ({
      id: t.id,
      type: t.type,
      amount: num(t.amount),
      balanceAfter: num(t.balanceAfter),
      orderId: t.orderId,
      checkId: t.checkId,
      note: t.note,
      createdAt: t.createdAt,
    })),
  })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'giftcards.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const card = await db.giftCard.findUnique({ where: { id } })
  if (!card) return fail('Kartica ne obstaja.', 404)

  const data: {
    ownerName?: string
    expiresAt?: Date | null
    status?: string
    updatedAt?: Date
  } = {}
  const changes: Record<string, { from: unknown; to: unknown }> = {}

  if (body?.ownerName !== undefined) {
    const v = String(body.ownerName).trim().slice(0, 120)
    if (v !== card.ownerName) {
      data.ownerName = v
      changes.ownerName = { from: card.ownerName, to: v }
    }
  }
  if (body?.expiresAt !== undefined) {
    const raw = typeof body.expiresAt === 'string' ? body.expiresAt.trim() : ''
    let v: Date | null = null
    if (raw) {
      v = new Date(raw)
      if (Number.isNaN(v.getTime())) return fail('Neveljaven datum veljavnosti.', 400)
    }
    const prev = card.expiresAt ? card.expiresAt.getTime() : null
    const next = v ? v.getTime() : null
    if (prev !== next) {
      data.expiresAt = v
      changes.expiresAt = { from: card.expiresAt, to: v }
    }
  }
  if (body?.status !== undefined) {
    const v = String(body.status).trim().toLowerCase()
    if (!['active', 'inactive'].includes(v)) return fail('Status je lahko samo active ali inactive.', 400)
    if (v !== card.status) {
      data.status = v
      changes.status = { from: card.status, to: v }
    }
  }

  if (Object.keys(data).length === 0) {
    return ok({ card: mapCard(card), changed: false })
  }
  data.updatedAt = new Date()

  const updated = await db.giftCard.update({ where: { id }, data })

  await writeAudit(db, { userId: user.sub, action: 'GIFT_CARD_UPDATE', entityType: 'GiftCard', entityId: id, details: JSON.stringify({ cardNumber: card.cardNumber, changes, note: String(body?.note ?? '').slice(0, 200) }), locationId: card.locationId })

  return ok({ card: mapCard(updated), changed: true })
}
