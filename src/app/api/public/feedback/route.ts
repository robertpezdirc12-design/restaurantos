import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'
import { rateLimitPublic, clientIp, resolveQrToken } from '@/lib/guest'

/**
 * P1 audit točka 6 — mnenja gostov: vnosni API (QR stran je imela prikaz, ni vnos).
 *
 * POST /api/public/feedback
 *   { token, overallRating, foodRating?, serviceRating?, atmosphereRating?,
 *     comment?, guestName?, tags?, wouldReturn?, wouldRecommend?, orderId? }
 *
 * Varnost (isti pravilnik kot preostali javni tok, src/lib/guest.ts):
 *  - QR token JE skrivnost: locationId/tableId se rešita SERVER-side iz tokena —
 *    gost nikoli ne pošilja ID-jev lokacije/mize (spoofing nemogoč).
 *  - orderId po želji, a SAMO če res pripada rešeni mizi/lokaciji (sicer se ignorira).
 *  - Rate limit: 5 mnenj / minuto / IP (zloraba mnenj ne more saturirati baze).
 *  - Vse vhode trdo omejimo (dolžine, razponi 0–5, tags ≤ 10 × 30 znakov).
 *
 * Odgovor 201 { ok: true, feedbackId } — brez PII (shrani samo opcionalno ime).
 */
export async function POST(req: NextRequest) {
  if (!(await rateLimitPublic(`feedback:${clientIp(req)}`, 5))) {
    return fail('Preveč zahtevkov. Poskusi čez minuto.', 429)
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Manjkajo podatki.', 400)

  // token = skrivnost mize — edini vir lokacije (gost ne pošilja locationId)
  const token = typeof body.token === 'string' ? body.token : ''
  const table = await resolveQrToken(token)
  if (!table) return fail('Neveljaven ali izklopljen QR token.', 404)

  const clamp5 = (v: unknown): number => {
    const n = Math.round(Number(v) || 0)
    return Math.min(5, Math.max(0, n))
  }
  const overallRating = clamp5(body.overallRating)
  if (overallRating < 1) return fail('Ocena je obvezna (1–5).', 400)

  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) : ''
  const guestName = typeof body.guestName === 'string' ? body.guestName.trim().slice(0, 80) : ''
  const tags = Array.isArray(body.tags)
    ? body.tags.slice(0, 10).map((t: unknown) => String(t).slice(0, 30)).filter(Boolean)
    : []
  const wouldReturn = body.wouldReturn === undefined ? true : Boolean(body.wouldReturn)
  const wouldRecommend = body.wouldRecommend === undefined ? true : Boolean(body.wouldRecommend)

  // orderId sprejmemo samo, če res pripada tej mizi/lokaciji (sicer ignoriramo)
  let orderId: string | null = null
  if (typeof body.orderId === 'string' && body.orderId) {
    const order = await db.order.findUnique({ where: { id: body.orderId }, select: { id: true, locationId: true, tableId: true } })
    if (order && order.locationId === table.locationId && (order.tableId ?? null) === (table.id ?? null)) {
      orderId = order.id
    }
  }

  const row = await db.guestFeedback.create({
    data: {
      id: nid(),
      guestName,
      orderId,
      overallRating,
      foodRating: clamp5(body.foodRating),
      serviceRating: clamp5(body.serviceRating),
      atmosphereRating: clamp5(body.atmosphereRating),
      comment,
      tags: JSON.stringify(tags),
      wouldReturn,
      wouldRecommend,
      source: 'qr',
      locationId: table.locationId,
      tableId: table.id,
      tableNumber: table.number !== undefined ? String(table.number) : null,
      status: 'new',
    },
  })

  return ok({ ok: true, feedbackId: row.id }, 201)
}
