import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'

import { writeAudit } from '@/lib/audit-chain'

const DEVICE_TYPES = ['pos', 'kds', 'kds_bar', 'tablet', 'kiosk', 'mobile', 'customer_display']

/**
 * Issue #3 — Device onboarding administracija. · Issue #4 §1/§2:
 * lokacijski gate (naprava tuje lokacije ni upravljiva), revoke takoj onemogoči credential,
 * revoke/restore/invalidate tudi uniči enrollment kodo.
 * PATCH  /api/devices/[id] — urejanje (ime/tip/lokacija) ali revoke/restore naprave
 * DELETE /api/devices/[id] — brisanje naprave
 * id = DeviceRegistry.id (ne deviceId token!)
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)

  const device = await db.deviceRegistry.findUnique({ where: { id } })
  if (!device) return fail('Naprava ne obstaja.', 404)
  // Issue #4 §1: staff sme upravljati SAMO naprave svoje lokacije (OWNER/ADMIN centralno)
  const locGuard = await guardResource(user, device.locationId)
  if (locGuard) return locGuard

  if (body?.action === 'revoke' || body?.action === 'restore') {
    const revoke = body.action === 'revoke'
    const updated = await db.deviceRegistry.update({
      where: { id },
      data: {
        revokedAt: revoke ? new Date() : null,
        status: revoke ? 'revoked' : 'offline',
        // revoke tudi razveže customer display + uniči enrollment kodo (§2.2)
        pairedToDeviceId: revoke ? null : device.pairedToDeviceId,
        pairingCode: revoke ? null : device.pairingCode,
        enrollmentCode: revoke ? null : device.enrollmentCode,
        enrollmentExpiresAt: revoke ? null : device.enrollmentExpiresAt,
      },
    })
    await writeAudit(db, { userId: user.sub, action: revoke ? 'DEVICE_REVOKED' : 'DEVICE_RESTORED', entityType: 'DeviceRegistry', entityId: id, details: `naprava=${device.name} (${device.type})`, locationId: device.locationId })
    return ok({ device: { id: updated.id, revoked: !!updated.revokedAt, status: updated.status } })
  }

  const data: Record<string, unknown> = {}
  if (body?.name !== undefined) {
    const name = String(body.name).trim()
    if (name.length < 2) return fail('Ime naprave je obvezno (min. 2 znaka).', 400)
    data.name = name
  }
  if (body?.type !== undefined) {
    const type = String(body.type).toLowerCase()
    if (!DEVICE_TYPES.includes(type)) return fail('Neznan tip naprave.', 400)
    data.type = type
  }
  if (body?.locationId !== undefined) {
    const locationId = String(body.locationId || '').trim()
    if (locationId) {
      const location = await db.location.findUnique({ where: { id: locationId } })
      if (!location) return fail('Lokacija ne obstaja.', 400)
      data.locationId = location.id
    } else {
      data.locationId = null
    }
  }
  if (Object.keys(data).length === 0) return fail('Ni sprememb.')

  const updated = await db.deviceRegistry.update({ where: { id }, data })
  return ok({
    device: {
      id: updated.id,
      name: updated.name,
      type: updated.type.toUpperCase(),
      locationId: updated.locationId,
      revoked: !!updated.revokedAt,
    },
  })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const device = await db.deviceRegistry.findUnique({ where: { id } })
  if (!device) return fail('Naprava ne obstaja.', 404)
  // Issue #4 §1: lokacijski gate
  const delGuard = await guardResource(user, device.locationId)
  if (delGuard) return delGuard
  await db.deviceRegistry.delete({ where: { id } })
  await writeAudit(db, { userId: user.sub, action: 'DEVICE_DELETED', entityType: 'DeviceRegistry', entityId: id, details: `naprava=${device.name} (${device.type})`, locationId: device.locationId })
  return ok({ deleted: true })
}
