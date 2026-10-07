import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, requirePermission, requireUserLocation, locationScope } from '@/lib/api'
import { nid } from '@/lib/map'
import { rateLimitBoolAsync } from '@/lib/rate-limit'
import { clientIp } from '@/lib/guest'

/** Issue #4 §2.1: device token se ne vrača v polni obliki — samo masked prikaz. */
function maskDeviceToken(token: string): string {
  return token.length > 14 ? `${token.slice(0, 12)}…` : `${token.slice(0, 4)}…`
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.deviceRegistry.findMany({
    where: locationScope(user),
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({
    devices: rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type.toUpperCase(),
      // §2.1: maskiran žeton — polni token se izda SAMO ob enrollmentu (claim odgovor)
      token: maskDeviceToken(r.deviceId),
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

const DEVICE_TYPES = ['pos', 'kds', 'kds_bar', 'tablet', 'kiosk', 'mobile', 'customer_display']

/**
 * Issue #4 §2.2 — javni provisioning je UKINJEN.
 * Prej: kdorkoli (anon) je lahko koval neomejeno `rodev_*` tokene z poljubno lokacijo.
 * Zdaj: enrollment poteka prek enkratne vpisne kode:
 *   1. zaposleni (employees.manage) ustvari kodo → POST /api/devices/enroll
 *   2. naprava javno unovči kodo → POST /api/devices/claim (rate-limited, enkratna, 15 min)
 * Ta endpoint ostane za API združljivost, a ZAHTEVA auth + permission + lokacijo.
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await rateLimitBoolAsync(`devcreate:${clientIp(req)}`, 20))) return fail('Preveč zahtevkov.', 429)

  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim()
  const type = String(body?.type || 'pos').toLowerCase()
  const locationId = String(body?.locationId || '').trim()
  if (!name || name.length < 2) return fail('Ime naprave je obvezno (min. 2 znaka).', 400)
  if (!DEVICE_TYPES.includes(type)) return fail('Neznan tip naprave.', 400)

  // §2.2: server-side vezava na dovoljeno lokacijo — staff NE sme izbrati tuje lokacije
  const loc = requireUserLocation(user, locationId || undefined)
  if (typeof loc !== 'string') return loc
  const location = await db.location.findUnique({ where: { id: loc } })
  if (!location) return fail('Lokacija ne obstaja.', 400)

  const deviceToken = `rodev_${crypto.randomBytes(24).toString('hex')}`
  const row = await db.deviceRegistry.create({
    data: {
      id: nid(),
      deviceId: deviceToken,
      name,
      type,
      locationId: location.id,
      status: 'online',
      lastSeenAt: new Date(),
    },
  })
  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'DEVICE_CREATED',
      entityType: 'DeviceRegistry',
      entityId: row.id,
      details: `name=${name} type=${type} location=${location.id}`,
      ipAddress: clientIp(req),
      locationId: location.id,
    },
  })
  // Enrollment moment: polni token se vrne TOČKO tukaj (UI ga pokaže enkrat)
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

/** Issue #4 §2.1: revoke mora takoj onemogočiti credential (glej PATCH /api/devices/[id]). */
