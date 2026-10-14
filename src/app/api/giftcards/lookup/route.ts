import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { num, jstr } from '@/lib/map'
import { effectiveCardStatus } from '@/lib/giftcards'
import { rateLimitSharedAsync } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #1 (triage ③) — iskanje darilne kartice za plačilo (POS dialog).
 *
 * GET /api/giftcards/lookup?q=<št. kartice | zadnjih n znakov | id>
 *   → ena kartica (id, številka, lastnik, saldo, efektivno stanje, rok).
 *
 * Issue #46 (P1) — enumeracijska zaščita (dotriagirana trije hrošči):
 *  1. PRAVICE: requireAuth → requirePermission('orders.pay') — iskanje je del
 *     POS plačilnega toka (blagajnik/natakar/šank); kuhinja/čistilka prej nista
 *     bili upravičeni, a sta lahko ugibala številke kartic (GET je prejel vsako
 *     veljavno sejo). Upravljanje kartic/ledger ostaja ločeno (#26: giftcards.manage
 *     na /api/giftcards/[id]); medposlovalnično unovčenje v isti org NI blokirano.
 *  2. DOLŽINA: strežniška validacija PRED vsako DB poizvedbo — q mora imeti ≥ 6
 *     znakov (suffix endsWith išče po zadnjih 6; komentar v stari kodi je to
 *     zahteval, koda pa je 1–5 znakov tiho spustila skozi q.slice(-6)).
 *  3. RATE LIMIT: kanonični rateLimitSharedAsync (isti vzorec kot prijava #32),
 *     ključ uporabnik + IP; agregirana revizija zavrnitev BREZ poizvedbe/PII.
 *
 * Odgovor vrača SAMO podatke za potrditev instrumenta pri plačilu; locationId
 * je IZPUŠČEN (potrditev plačila ga ne potrebuje, razkrival pa bi organizacijsko
 * strukturo). Polno ime lastnika ostaja (natisnjeno na fizični kartici — blagajnik
 * ga primerja, legitimni POS tok).
 */
export const GIFT_CARD_LOOKUP_MIN = 6
const LOOKUP_RATE_LIMIT = 30
const LOOKUP_RATE_WINDOW_MS = 60_000

function ipOf(req: NextRequest): string {
  const vff = req.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()
  if (vff) return vff
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

export async function GET(req: NextRequest) {
  // #46 (1): pravica usklajena z dejanskim POS plačilnim tokom
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const q = (new URL(req.url).searchParams.get('q') || '').trim().toUpperCase()
  // #46 (2): dolžina preverjena strežniško, PRED vsako DB poizvedbo —
  // 1–5 znakov NE sproži iskanja (endsWith na kratek suffix = enumeracija)
  if (q.length < GIFT_CARD_LOOKUP_MIN) {
    return fail(`Iskanje zahteva vsaj ${GIFT_CARD_LOOKUP_MIN} znakov (polna številka kartice ali njen konec).`, 400)
  }
  // #46 (3): kanonični store-aware limiter — ključ IP + uporabnik
  const ip = ipOf(req)
  const rl = await rateLimitSharedAsync(`gclookup:${user.sub}:${ip}`, LOOKUP_RATE_LIMIT, LOOKUP_RATE_WINDOW_MS)
  if (!rl.allowed) {
    // agregirana revizija zavrnitve — BREZ iskalne vrednosti in osebnih podatkov
    await writeAudit(db, {
      userId: user.sub,
      action: 'GIFT_CARD_LOOKUP_RATE_LIMITED',
      entityType: 'GiftCard',
      entityId: '',
      details: jstr({ rate: `${LOOKUP_RATE_LIMIT}/min`, ip }),
    }).catch(() => {})
    return fail('Preveč iskanj kartic — počakajte minuto in poskusite znova.', 429)
  }

  let card: Awaited<ReturnType<typeof db.giftCard.findFirst>> = null
  if (q.startsWith('GC-')) {
    card = await db.giftCard.findFirst({
      where: { cardNumber: { endsWith: q } },
      orderBy: { createdAt: 'desc' },
    })
  }
  if (!card && /^\d{6,}$/.test(q)) {
    card = await db.giftCard.findFirst({
      where: { cardNumber: { endsWith: `-${q}` } },
      orderBy: { createdAt: 'desc' },
    })
  }
  // generični suffix: zadnjih 6 znakov (q je garantiran ≥ 6 s preverbo zgoraj)
  if (!card) {
    card = await db.giftCard.findFirst({
      where: { cardNumber: { endsWith: q.slice(-6) } },
      orderBy: { createdAt: 'desc' },
    })
  }
  if (!card && /^[A-Z0-9]{8,}$/.test(q)) {
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
      // #46: locationId IZPUŠČEN — potrditev plačila ga ne potrebuje
    },
  })
}
