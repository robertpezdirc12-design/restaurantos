import { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource, isBootstrapAdmin } from '@/lib/tenant'
import { num, jstr } from '@/lib/map'
import { effectiveCardStatus } from '@/lib/giftcards'
import { writeAudit } from '@/lib/audit-chain'
import type { AuthPayload } from '@/lib/auth'

/**
 * Issue #1 (triage ③) — detalj + urejanje darilne kartice.
 *
 * Issue #26 (P1) — TENANT IZOLACIJA branja in sprememb:
 *  - GET: requireAuth → requirePermission('giftcards.manage') (podrobni
 *    finančni dnevnik NI odprt vsaki prijavljeni osebi) + guardResource
 *    (staff = lastna lokacija — skladno s seznamom /api/giftcards; centralni
 *    vlogi = meja organizacije; bootstrap = break-glass);
 *  - PATCH: enaka varovalka PRED mutacijo (prej je globalni findUnique
 *    dovolil giftcards.manage uporabniku orgA spreminjati kartico orgB);
 *  - legacy kartica brez locationId → fail-closed: 404 (enoten z neobstoječo,
 *    brez razkrivanja obstoja/vrednosti) za vse razen bootstrap operaterja;
 *  - zavrnitve se zabeležijo v revizijo (GIFT_CARD_ACCESS_DENIED) BREZ
 *    številke/salda/lastnika (samo id + vzrok).
 *
 * GET /api/giftcards/[id]
 *   → kartica + zadnjih 50 transakcij (ledžer, najnovejše najprej;
 *     #26: zmanjšano s 100 — najnujnejša polja za upravljalski pregled).
 *
 * PATCH /api/giftcards/[id] { ownerName?, expiresAt? ('' | null = počisti), status? ('active'|'inactive'), note? }
 *   → urejanje metapodatkov / deaktivacija-reaktivacija.
 *     Audit GIFT_CARD_UPDATE s before/after polji.
 */
const TX_TAKE_MAX = 50

/** #26: zabeleži zavrnjen poskus dostopa (brez podatkov kartice — samo id + vzrok). */
async function auditDenied(userId: string, id: string, op: string, reason: string) {
  await writeAudit(db, {
    userId,
    action: 'GIFT_CARD_ACCESS_DENIED',
    entityType: 'GiftCard',
    entityId: id,
    details: jstr({ op, reason }),
  }).catch(() => {})
}

/**
 * #26: skupna varovalka za točkovne poti (GET/PATCH/topup) — po najdeni kartici:
 *  1. legacy brez locationId → 404 (fail-closed; razen bootstrap break-glass);
 *  2. guardResource → 403 (staff = lastna lokacija; centralni = org meja).
 * Vrne NextResponse ali null (dostop dovoljen).
 */
async function guardCard(
  user: AuthPayload,
  id: string,
  card: { locationId: string | null },
  op: string,
): Promise<NextResponse | null> {
  if (!card.locationId && !isBootstrapAdmin(user)) {
    await auditDenied(user.sub, id, op, 'legacy-no-location')
    return fail('Kartica ne obstaja.', 404)
  }
  const guard = await guardResource(user, card.locationId)
  if (guard) {
    await auditDenied(user.sub, id, op, 'cross-tenant')
    return guard
  }
  return null
}
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
  // #26: podrobni dnevnik = finančni pregled → giftcards.manage (enako kot
  // seznam kartic); navadna seja ga NE sme videti (prej: requireAuth)
  const user = await requirePermission(req, 'giftcards.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const card = await db.giftCard.findUnique({ where: { id } })
  if (!card) return fail('Kartica ne obstaja.', 404)
  const denied = await guardCard(user, id, card, 'GET')
  if (denied) return denied
  const transactions = await db.giftCardTransaction.findMany({
    where: { giftCardId: id },
    orderBy: { createdAt: 'desc' },
    take: TX_TAKE_MAX,
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
  const denied = await guardCard(user, id, card, 'PATCH')
  if (denied) return denied

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
