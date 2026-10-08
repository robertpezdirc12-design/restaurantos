import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { num } from '@/lib/map'
import { effectiveCardStatus } from '@/lib/giftcards'

/**
 * Issue #1 (triage ③) — iskanje darilne kartice za plačilo (POS dialog).
 *
 * GET /api/giftcards/lookup?q=<št. kartice | zadnjih n znakov | id>
 *   → ena kartica (id, številka, lastnik, saldo, efektivno stanje, rok).
 *     Pravica: requireAuth (blagajnik išče kartico ob plačilu).
 *     Zaščita: zadnjih 4 znakov NE zadostuje (premalo entropije) — zahteva ≥ 6.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const q = (new URL(req.url).searchParams.get('q') || '').trim().toUpperCase()
  if (!q) return fail('Manjka poizvedba (št. kartice ali id).', 400)

  let card: Awaited<ReturnType<typeof db.giftCard.findFirst>> = null
  if (q.startsWith('GC-') || /^\d{6,}$/.test(q)) {
    card = await db.giftCard.findFirst({
      where: { cardNumber: { endsWith: q.startsWith('GC-') ? q : `-${q}` } },
      orderBy: { createdAt: 'desc' },
    })
  }
  if (!card) {
    card = await db.giftCard.findFirst({
      where: { cardNumber: { endsWith: q.slice(-6) } },
      orderBy: { createdAt: 'desc' },
    })
  }
  if (!card && /^[a-z0-9]{8,}$/i.test(q)) {
    card = await db.giftCard.findUnique({ where: { id: q.toLowerCase() } })
  }
  if (!card) return fail('Kartica s to številko ne obstaja.', 404)

  const balanceCents = Math.round(num(card.balance) * 100)
  return ok({
    card: {
      id: card.id,
      cardNumber: card.cardNumber,
      ownerName: card.ownerName,
      balance: num(card.balance),
      status: card.status,
      effectiveStatus: effectiveCardStatus(card.status, balanceCents, card.expiresAt),
      expiresAt: card.expiresAt,
      locationId: card.locationId,
    },
  })
}
