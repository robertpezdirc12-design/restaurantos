/**
 * Webhook za dostavne platforme (issue #2) — stara pot brez segmenta integracije.
 *
 * v1.159.0: logika je v skupnem jedru `@/lib/delivery-webhook`. Tu ostane le
 * tanka ovojnica: z več aktivnimi integracijami iste platforme jedro zahteva
 * ENOLIČNO ujemanje podpisa (0 → 401, 2+ → 409); za enolično usmerjanje
 * uporabite /api/delivery/webhook/<platforma>/<integracija>.
 * GET je »ready« sonda — ne izda podatkov in ne spreminja stanja.
 */
import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { handleDeliveryWebhook } from '@/lib/delivery-webhook'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PROVIDERS = new Set(['glovo', 'wolt'])

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params
  return handleDeliveryWebhook(req, provider, null)
}

/** Health/verify hook za platforme (ne spremeni ničesar). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  if (!PROVIDERS.has(provider?.toLowerCase() ?? '')) return fail('Neznana dostavna platforma.', 404)
  return ok({ ok: true, provider: provider.toLowerCase(), webhook: 'ready' })
}
