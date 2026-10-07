import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import { deviceFromToken, deviceAlive, rateLimitPublic, clientIp } from '@/lib/guest'

/**
 * Issue #3 — Customer display: branje stanja POS-a (polling vs ~2s).
 * GET /api/devices/display/state  (X-Device-Token = customer_display naprava)
 * Vrne zadnji displayPayload, ki ga je POS potisnil prek POST { action: 'push' }.
 */
export async function GET(req: NextRequest) {
  if (!rateLimitPublic(`displaystate:${clientIp(req)}`, 120)) return fail('Preveč zahtevkov.', 429)
  const device = await deviceFromToken(req.headers.get('x-device-token'))
  if (!deviceAlive(device, ['customer_display'])) return fail('Display naprava ni registrirana.', 401)

  if (!device.pairedToDeviceId) return ok({ paired: false })

  const pos = await db.deviceRegistry.findUnique({ where: { id: device.pairedToDeviceId } })
  if (!pos || pos.revokedAt) return ok({ paired: false })

  const payload = jparse<Record<string, unknown> | null>(pos.displayPayload, null)
  return ok({
    paired: true,
    posName: pos.name,
    posOnline: !!pos.lastSeenAt && Date.now() - pos.lastSeenAt.getTime() < 120_000,
    updatedAt: pos.displayUpdatedAt,
    payload,
  })
}
