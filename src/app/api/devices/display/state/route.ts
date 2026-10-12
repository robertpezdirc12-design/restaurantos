import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import { deviceFromToken, deviceAlive, rateLimitPublic, clientIp } from '@/lib/guest'
import { DISPLAY_PROMOS_MARKER, MAX_PROMOS, sanitizePromos, activeAds } from '@/lib/display-promos'

/**
 * Issue #3 — Customer display: branje stanja POS-a (polling vs ~2s).
 * GET /api/devices/display/state  (X-Device-Token = customer_display naprava)
 * Vrne zadnji displayPayload, ki ga je POS potisnil prek POST { action: 'push' }.
 * OPS-10 val 2 (v1.78.0): poleg payloada vrača tudi AKTIVNE promocije (max 5) —
 * STALNO (ne samo v idle): client sam izbere, kaj prikaže. Ključ je aditiven
 * (back-compat: obstoječi odgovor se ne spreminja).
 */
export async function GET(req: NextRequest) {
  if (!(await rateLimitPublic(`displaystate:${clientIp(req)}`, 120))) return fail('Preveč zahtevkov.', 429)
  const device = await deviceFromToken(req.headers.get('x-device-token'))
  if (!deviceAlive(device, ['customer_display'])) return fail('Display naprava ni registrirana.', 401)

  if (!device.pairedToDeviceId) return ok({ paired: false, promos: [] })

  const [pos, promosRow] = await Promise.all([
    db.deviceRegistry.findUnique({ where: { id: device.pairedToDeviceId } }),
    db.integration.findFirst({ where: { name: DISPLAY_PROMOS_MARKER, type: 'other' }, select: { config: true } }),
  ])
  if (!pos || pos.revokedAt) return ok({ paired: false, promos: [] })

  const payload = jparse<Record<string, unknown> | null>(pos.displayPayload, null)
  // promos read on every poll (cheap findFirst) — no extra caching layer needed at 2 s
  const promos = activeAds(sanitizePromos(jparse<unknown>(promosRow?.config ?? null, null)).ads).slice(0, MAX_PROMOS)
  return ok({
    paired: true,
    posName: pos.name,
    posOnline: !!pos.lastSeenAt && Date.now() - pos.lastSeenAt.getTime() < 120_000,
    updatedAt: pos.displayUpdatedAt,
    payload,
    promos,
  })
}
