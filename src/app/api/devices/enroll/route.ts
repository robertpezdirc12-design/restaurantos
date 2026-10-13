import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid } from '@/lib/map'
import { rateLimitBoolAsync } from '@/lib/rate-limit'
import { newEnrollmentCode, clientIp } from '@/lib/guest'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #4 §2.2 — device enrollment z ENKRATNO vpisno kodo.
 *
 * Flow:
 *  1. Zaposleni z employees.manage ustvari kodo: POST /api/devices/enroll
 *     { name, type, locationId? } → { code, expiresAt } (koda velja 15 min)
 *  2. Naprava (javno, na lokaciji) unovči kodo: PUT /api/devices/enroll { code }
 *     → dobi poljni device token (IZKLJUČNO ob claimu), lokacija je server-side vezana.
 *
 * Varnost:
 *  - koda je enkratna (po claimu se izbriše iz DB);
 *  - kratka veljavnost (15 min);
 *  - rate limit na claim (brute-force zaščita: 10 poskusov / 5 min / IP);
 *  - lokacija se veže server-side (staff ne more izbrati tuje lokacije);
 *  - device type whitelist;
 *  - audit (brez skrivnosti v logih).
 */
const DEVICE_TYPES = ['pos', 'kds', 'kds_bar', 'tablet', 'kiosk', 'mobile', 'customer_display']
const ENROLLMENT_TTL_MS = 15 * 60_000

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await rateLimitBoolAsync(`enroll:${clientIp(req)}`, 30))) return fail('Preveč zahtevkov.', 429)

  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim()
  const type = String(body?.type || 'pos').toLowerCase()
  if (!name || name.length < 2) return fail('Ime naprave je obvezno (min. 2 znaka).', 400)
  if (!DEVICE_TYPES.includes(type)) return fail('Neznan tip naprave.', 400)

  const loc = requireUserLocation(user, body?.locationId)
  if (typeof loc !== 'string') return loc
  const orgGuard = await assertOrgScope(user, loc)
  if (orgGuard) return orgGuard
  const location = await db.location.findUnique({ where: { id: loc } })
  if (!location) return fail('Lokacija ne obstaja.', 400)

  const code = newEnrollmentCode()
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS)
  const row = await db.deviceRegistry.create({
    data: {
      id: nid(),
      // token se kova šele pri claimu — pred tem naprava nima credentials
      deviceId: `pending_${nid()}`,
      name,
      type,
      locationId: location.id,
      status: 'enrollment_pending',
      enrollmentCode: code,
      enrollmentExpiresAt: expiresAt,
      enrollmentClaimedAt: null,
    },
  })
  await writeAudit(db, { userId: user.sub, action: 'DEVICE_ENROLLMENT_CREATED', entityType: 'DeviceRegistry', entityId: row.id, details: `name=${name} type=${type} location=${location.id} ttl=${ENROLLMENT_TTL_MS / 1000}s`, ipAddress: clientIp(req), locationId: location.id })
  return ok({ code, expiresAt, device: { id: row.id, name: row.name, type: row.type.toUpperCase(), locationId: row.locationId } }, 201)
}

/**
 * Javni claim (naprava na lokaciji): { code } → poljni token (samo tokrat).
 * Rate limit + enkratnost + TTL. Koda brez tokena ne da ničesar.
 */
export async function PUT(req: NextRequest) {
  if (!(await rateLimitBoolAsync(`claim:${clientIp(req)}`, 10, 5 * 60_000))) {
    return fail('Preveč poskusov. Poskusi čez nekaj minut.', 429)
  }
  const body = await req.json().catch(() => null)
  const code = String(body?.code || '').trim()
  if (!/^\d{8}$/.test(code)) return fail('Vpisna koda ni veljavna (8 števk).', 400)

  const device = await db.deviceRegistry.findFirst({
    where: { enrollmentCode: code },
  })
  if (!device) return fail('Neznana ali že unovčena vpisna koda.', 404)
  if (device.enrollmentClaimedAt) return fail('Vpisna koda je bila že uporabljena.', 410)
  if (!device.enrollmentExpiresAt || device.enrollmentExpiresAt.getTime() < Date.now()) {
    return fail('Vpisna koda je potekla. Ustvari novo v nastavitvah.', 410)
  }
  if (device.revokedAt) return fail('Naprava je razveljavljena.', 403)

  const deviceToken = `rodev_${crypto.randomBytes(24).toString('hex')}`
  const updated = await db.deviceRegistry.update({
    where: { id: device.id },
    data: {
      deviceId: deviceToken,
      status: 'online',
      lastSeenAt: new Date(),
      enrollmentCode: null,
      enrollmentClaimedAt: new Date(),
    },
  })
  await writeAudit(db, { userId: null, action: 'DEVICE_CLAIMED', entityType: 'DeviceRegistry', entityId: device.id, details: `name=${device.name} type=${device.type} location=${device.locationId || 'brez'}`, ipAddress: clientIp(req), locationId: device.locationId })
  // ENKRATNI izpis polnega tokena (enrollment moment)
  return ok({
    device: {
      id: updated.id,
      name: updated.name,
      type: updated.type.toUpperCase(),
      token: deviceToken,
      locationId: updated.locationId,
    },
  })
}
