import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.deviceRegistry.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  return ok({
    devices: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type.toUpperCase(),
      token: r.deviceId,
      lastSeen: r.lastSeenAt,
      status: r.status,
      locationId: r.locationId,
      createdAt: r.createdAt,
      // Issue #3: onboarding/revoke/cfd stanje
      revoked: !!r.revokedAt,
      revokedAt: r.revokedAt,
      pairedToDeviceId: r.pairedToDeviceId,
      hasDisplayPayload: !!r.displayPayload,
    })),
  })
}

/**
 * Poveži napravo z lokacijo (LOGIN PROVISIONING — javna ruta, kot v originalu R248).
 * Uporablja se na prijavni strani PRED prijavo: naprava dobi enkraten deviceId (token),
 * ki se prikaže samo enkrat. Zahteva veljavno lokacijo, ime in tip naprave.
 */
const DEVICE_TYPES = ['pos', 'kds', 'kds_bar', 'tablet', 'kiosk', 'mobile', 'customer_display']
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim()
  const type = String(body?.type || 'pos').toLowerCase()
  const locationId = String(body?.locationId || '').trim()
  if (!name || name.length < 2) return fail('Ime naprave je obvezno (min. 2 znaka).', 400)
  if (!DEVICE_TYPES.includes(type)) return fail('Neznan tip naprave.', 400)
  const location = locationId ? await db.location.findUnique({ where: { id: locationId } }) : null
  if (locationId && !location) return fail('Lokacija ne obstaja.', 400)

  const deviceToken = `rodev_${crypto.randomBytes(24).toString('hex')}`
  const row = await db.deviceRegistry.create({
    data: {
      id: nid(),
      deviceId: deviceToken,
      name,
      type,
      locationId: location?.id ?? null,
      status: 'online',
      lastSeenAt: new Date(),
    },
  })
  return ok({
    device: {
      id: row.id,
      name: row.name,
      type: row.type.toUpperCase(),
      token: row.deviceId,
      locationId: row.locationId,
      createdAt: row.createdAt,
    },
  }, 201)
}
