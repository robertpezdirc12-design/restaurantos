import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, num, r2 } from '@/lib/map'
import {
  cardNumberFor,
  effectiveCardStatus,
  gcNote,
  giftCardIssueId,
  giftCardTxId,
  validateIssueCents,
} from '@/lib/giftcards'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Issue #1 (triage ③) — darilne kartice: izdaja + seznam.
 *
 * GET /api/giftcards?q=&status=&limit=
 *   → seznam kartic (lokacijsko omejen po §10) + statistika (aktivne, saldo,
 *     izdane 30 dni, unovčeno 30 dni).
 *     N5 (revizija §4): polni seznam + saldo statistika so finančni podatki — UI
 *     prikaže zavihek Darilne kartice samo z 'reports.view' (TAB_PERM.darilne),
 *     zato backend uveljavlja isto kanonično dovoljenje (prej: requireAuth).
 *     POS plačilni tok je ohranjen: iskanje ENE kartice ob plačilu gre prek
 *     GET /api/giftcards/lookup (requireAuth — blagajnik/natakar jo potrebuje
 *     v plačilnem dialogu), ki ostaja odprt; podrobnost kartice (GET /api/giftcards/[id])
 *     ni del tega popravka (N5 za darilne gate-a samo polni seznam).
 *
 * POST /api/giftcards { ownerName?, initialBalance, expiresAt?, locationId?, note?, clientOperationId? }
 *   → izdaja kartice: GC-YYYYMMDD-XXXXXX številka, začetni saldo (0 = brez vrednosti),
 *     transakcija 'issue' + audit GIFT_CARD_ISSUE. Pravica: orders.pay (blagajna).
 *     Idempotenca: clientOperationId → determinističen id kartice (replay → isti zapis).
 *
 * Kanonični tok: GiftCard + GiftCardTransaction (podpisani zneski, §18: brez shematskih sprememb).
 * locationId kartice = lokacija PRODAJE (poročanje); unovčenje ni lokacijsko omejeno
 * (kartica je instrument podjetja, ne poslovalnice).
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

export async function GET(req: NextRequest) {
  // N5: polni seznam + saldo statistika → 'reports.view' (skladen z UI zavihkom);
  // plačilni tok ne gre skozi ta seznam (glej /api/giftcards/lookup — requireAuth)
  const user = await requirePermission(req, 'giftcards.manage')
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const q = (url.searchParams.get('q') || '').trim()
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100))

  const where = {
    ...(await locationScope(user)),
    ...(q
      ? {
          OR: [
            { cardNumber: { contains: q } },
            { ownerName: { contains: q } },
          ],
        }
      : {}),
  }
  const cards = await db.giftCard.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit })

  // statistika (30-dnevna okna) — nad vsemi karticami v dosegu
  const d30 = new Date(Date.now() - 30 * 864e5)
  const now = new Date()
  const [allCount, activeAgg, issued30, redeemed30] = await Promise.all([
    db.giftCard.count({ where }),
    db.giftCard.aggregate({
      where: { ...where, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      _count: { _all: true },
      _sum: { balance: true },
    }),
    db.giftCard.count({ where: { ...where, purchasedAt: { gte: d30 } } }),
    db.giftCardTransaction.aggregate({
      where: { type: 'redeem', createdAt: { gte: d30 }, GiftCard: where },
      _sum: { amount: true },
    }),
  ])

  return ok({
    cards: cards.map(mapCard),
    stats: {
      total: allCount,
      active: activeAgg._count._all,
      totalBalance: num(activeAgg._sum.balance),
      issued30,
      redeemed30: Math.abs(num(redeemed30._sum.amount)),
    },
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const ownerName = String(body?.ownerName ?? '').trim().slice(0, 120)
  const initialBalance = r2(num(body?.initialBalance))
  const expiresAtRaw = typeof body?.expiresAt === 'string' && body.expiresAt.trim() ? body.expiresAt.trim() : null
  const note = gcNote(body?.note, 'Izdaja darilne kartice')
  const clientOperationId =
    typeof body?.clientOperationId === 'string' && body.clientOperationId.trim().length >= 8
      ? body.clientOperationId.trim().slice(0, 64)
      : null

  const err = validateIssueCents(Math.round(initialBalance * 100), expiresAtRaw)
  if (err) return fail(err, 400)
  if (expiresAtRaw && Number.isNaN(new Date(expiresAtRaw).getTime())) return fail('Neveljaven datum veljavnosti.', 400)
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null

  // lokacija prodaje — §10: staff MORA imeti lokacijo; centralne jo lahko podajo
  const loc = requireUserLocation(user, body?.locationId)
  if (isResponse(loc)) return loc
  const orgGuard = await assertOrgScope(user, loc)
  if (orgGuard) return orgGuard

  // Idempotentni replay — kartica za ta clientOperationId že obstaja?
  const cardId = clientOperationId ? giftCardIssueId(clientOperationId) : nid()
  if (clientOperationId) {
    const existing = await db.giftCard.findUnique({ where: { id: cardId } })
    if (existing) {
      return ok({ card: mapCard(existing), replayed: true }, 200)
    }
  }

  try {
    const created = await db.$transaction(async (tx) => {
      // številka: dnevno zaporedje z retry ob unique koliziji
      const dayPrefix = `GC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
      let cardNumber = ''
      for (let attempt = 0; attempt < 5; attempt++) {
        const floor = await tx.giftCard.count({ where: { cardNumber: { startsWith: dayPrefix } } })
        const candidate = cardNumberFor(floor + 1 + attempt)
        const clash = await tx.giftCard.findUnique({ where: { cardNumber: candidate } })
        if (!clash) {
          cardNumber = candidate
          break
        }
      }
      if (!cardNumber) throw new Error('Prosta številka kartice ni bila najdena.')

      const card = await tx.giftCard.create({
        data: {
          id: cardId,
          cardNumber,
          balance: initialBalance,
          initialBalance,
          status: 'active',
          ownerName,
          purchasedAt: new Date(),
          expiresAt,
          locationId: loc,
        },
      })
      await tx.giftCardTransaction.create({
        data: {
          id: giftCardTxId(cardId, clientOperationId || nid()),
          giftCardId: cardId,
          type: 'issue',
          amount: initialBalance,
          balanceAfter: initialBalance,
          note,
        },
      })
      return card
    })

    const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'GIFT_CARD_ISSUE', entityType: 'GiftCard', entityId: created.id, details: JSON.stringify({ cardNumber: created.cardNumber, initialBalance, ownerName, expiresAt, locationId: loc, note, idempotent: Boolean(clientOperationId), }), locationId: loc, id: __aId2 })
    await db.auditLog.create({
      data: { ...__chain2,
        id: __aId2,
        userId: user.sub,
        action: 'GIFT_CARD_ISSUE',
        entityType: 'GiftCard',
        entityId: created.id,
        details: JSON.stringify({
          cardNumber: created.cardNumber,
          initialBalance,
          ownerName,
          expiresAt,
          locationId: loc,
          note,
          idempotent: Boolean(clientOperationId),
        }),
        locationId: loc,
      },
    })

    return ok({ card: mapCard(created), replayed: false }, 201)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Unique constraint')) return fail('Številka kartice je že v uporabi — poskusite znova.', 409)
    return fail(`Izdaja kartice ni uspela: ${msg}`, 500)
  }
}
