/**
 * v1.159.0 — webhook dostavne platforme, vezan na TOČNO integracijo.
 *
 * /api/delivery/webhook/<platforma>/<Integration.id>
 *
 * Zakaj: stara pot izbira prvo integracijo providerja brez lokacije — ob dveh
 * lokacijah iste platforme je podpis lahko preverjal eno, naročilo pa vezalo
 * na drugo. Ta pot je nedvoumna: id mora obstajati, biti iste platforme in
 * aktiven; secret in lokacija pripadata isti vrstici.
 */
import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { handleDeliveryWebhook } from '@/lib/delivery-webhook'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PROVIDERS = new Set(['glovo', 'wolt'])

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; integration: string }> },
) {
  const { provider, integration } = await params
  return handleDeliveryWebhook(req, provider, integration)
}

/** Health/verify hook za platforme (ne spremeni ničesar). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ provider: string; integration: string }> }) {
  const { provider } = await params
  if (!PROVIDERS.has(provider?.toLowerCase() ?? '')) return fail('Neznana dostavna platforma.', 404)
  return ok({ ok: true, provider: provider.toLowerCase(), webhook: 'ready' })
}
