import { NextRequest } from 'next/server'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { getVapidConfig } from '@/lib/push'

/**
 * OPS-7 (v1.70.0) — javni VAPID public key (brskalnik ga potrebuje za subscribe).
 * GET /api/push/key → {publicKey} (ključi se enkrat generirajo + trajno shranijo v DB).
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  try {
    const cfg = await getVapidConfig()
    if (!cfg?.publicKey) return fail('VAPID ključi niso na voljo.', 500)
    return ok({ publicKey: cfg.publicKey })
  } catch (e) {
    return fail(`Push ključi: ${(e as Error).message}`, 500)
  }
}
