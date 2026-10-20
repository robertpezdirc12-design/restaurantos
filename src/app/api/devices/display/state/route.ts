import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import { deviceFromTokenLite, deviceAlive, rateLimitPublic, clientIp } from '@/lib/guest'
import { DISPLAY_PROMOS_MARKER, MAX_PROMOS, sanitizePromos, activeAds } from '@/lib/display-promos'
import { displayStateVersion } from '@/lib/display-poll'

/**
 * Issue #3 — Customer display: branje stanja POS-a (polling vs ~2s).
 * GET /api/devices/display/state  (X-Device-Token = customer_display naprava)
 * Vrne zadnji displayPayload, ki ga je POS potisnil prek POST { action: 'push' }.
 * OPS-10 val 2 (v1.78.0): poleg payloada vrača tudi AKTIVNE promocije (max 5) —
 * STALNO (ne samo v idle): client sam izbere, kaj prikaže. Ključ je aditiven
 * (back-compat: obstoječi odgovor se ne spreminja).
 * v1.156.0: pogojni polling — ob `?v=<version>` in nespremenjenem stanju
 * (payload + promocije) se NE bereta displayPayload in config, odgovor pa ne
 * vsebuje payloada/promocij. Zaslon tako ne prenaša nespremenjenih vrstic vsaki
 * 2 s (porabnik Neon kvote prenosa).
 */
export async function GET(req: NextRequest) {
  if (!(await rateLimitPublic(`displaystate:${clientIp(req)}`, 120))) return fail('Preveč zahtevkov.', 429)
  const device = await deviceFromTokenLite(req.headers.get('x-device-token'))
  if (!deviceAlive(device, ['customer_display'])) return fail('Display naprava ni registrirana.', 401)

  if (!device.pairedToDeviceId) return ok({ paired: false, promos: [] })

  // Lahka pot: samo meta polja (brez displayPayload) + različica promocij.
  const [posMeta, promosMeta] = await Promise.all([
    db.deviceRegistry.findUnique({
      where: { id: device.pairedToDeviceId },
      select: { name: true, lastSeenAt: true, displayUpdatedAt: true, revokedAt: true },
    }),
    db.integration.findFirst({
      where: { name: DISPLAY_PROMOS_MARKER, type: 'other' },
      select: { id: true, updatedAt: true },
    }),
  ])
  if (!posMeta || posMeta.revokedAt) return ok({ paired: false, promos: [] })

  const posOnline = !!posMeta.lastSeenAt && Date.now() - posMeta.lastSeenAt.getTime() < 120_000
  const version = displayStateVersion(posMeta.displayUpdatedAt, promosMeta?.id, promosMeta?.updatedAt)
  if (req.nextUrl.searchParams.get('v') === version) {
    return ok({ paired: true, posName: posMeta.name, posOnline, unchanged: true, version })
  }

  const [pos, promosRow] = await Promise.all([
    db.deviceRegistry.findUnique({ where: { id: device.pairedToDeviceId }, select: { displayPayload: true } }),
    db.integration.findFirst({ where: { name: DISPLAY_PROMOS_MARKER, type: 'other' }, select: { config: true } }),
  ])
  const payload = jparse<Record<string, unknown> | null>(pos?.displayPayload ?? null, null)
  // OPS-11 val 2: activeAds()/sanitizePromos() gained an optional campaign window
  // ('YYYY-MM-DD' start/end); both default `now` to the current moment, so this call
  // site needs no change — only in-window ads reach the carousel.
  const promos = activeAds(sanitizePromos(jparse<unknown>(promosRow?.config ?? null, null)).ads).slice(0, MAX_PROMOS)
  return ok({
    paired: true,
    posName: posMeta.name,
    posOnline,
    updatedAt: posMeta.displayUpdatedAt,
    payload,
    promos,
    version,
  })
}
