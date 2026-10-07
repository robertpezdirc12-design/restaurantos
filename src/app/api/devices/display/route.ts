import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, requireAuth, isResponse } from '@/lib/api'
import { nid } from '@/lib/map'
import { deviceFromToken, deviceAlive, newPairingCode, rateLimitPublic, clientIp } from '@/lib/guest'

/**
 * Issue #3 — Customer-facing display (CFD): parjenje + push stanja.
 * POS akciji (pair/push) dovolita staff seja (Authorization) ALI X-Device-Token POS naprave;
 * display akciji (connect/unpair + GET) se avtentikirajo z X-Device-Token naprave.
 *
 * POST { action: 'pair' }    → POS: ustvari 6-mestno kodo (TTL 10 min)
 * POST { action: 'connect' } → DISPLAY: poveže se s POS preko kode
 * POST { action: 'push' }    → POS: objavi trenutno transakcijo za display
 * POST { action: 'unpair' }  → DISPLAY ali POS: razveže
 */
const DISPLAY_PAYLOAD_MAX = 8192

/** POS identiteta: staff seja ALI device token (POS upravlja svoj display) */
async function posIdentity(req: NextRequest) {
  const token = req.headers.get('x-device-token')
  if (token) {
    const device = await deviceFromToken(token)
    if (!deviceAlive(device, ['pos'])) return null
    await db.deviceRegistry.update({ where: { id: device.id }, data: { status: 'online', lastSeenAt: new Date() } })
    return { kind: 'device' as const, id: device.id, name: device.name }
  }
  const user = requireAuth(req)
  if (isResponse(user)) return null
  return { kind: 'staff' as const, id: user.sub, name: user.name || 'staff' }
}

/** Najdi ciljno POS napravo (device token → sama; staff → zadnja aktivna POS) */
async function resolvePosRow(kind: 'device' | 'staff', id: string) {
  if (kind === 'device') return { id }
  const row = await db.deviceRegistry.findFirst({
    where: { type: 'pos', revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
  })
  return row
}

export async function POST(req: NextRequest) {
  if (!rateLimitPublic(`display:${clientIp(req)}`, 120)) return fail('Preveč zahtevkov.', 429)
  const body = await req.json().catch(() => null)
  const action = String(body?.action || '')

  // DISPLAY akciji (connect/unpair) — device token obvezen
  if (action === 'connect' || action === 'unpair') {
    const device = await deviceFromToken(req.headers.get('x-device-token'))
    if (!deviceAlive(device, ['pos', 'customer_display'])) return fail('Naprava ni registrirana.', 401)
    await db.deviceRegistry.update({ where: { id: device.id }, data: { status: 'online', lastSeenAt: new Date() } })

    if (action === 'connect') {
      if (device.type !== 'customer_display') return fail('Samo customer display se lahko poveže s kodo.', 403)
      const code = String(body?.code || '').trim()
      if (!/^\d{6}$/.test(code)) return fail('Koda mora biti 6-mestna številka.', 400)
      const pos = await db.deviceRegistry.findFirst({
        where: { pairingCode: code, pairingExpiresAt: { gte: new Date() }, revokedAt: null, type: 'pos' },
      })
      if (!pos) return fail('Koda ni veljavna ali je potekla.', 404)
      await db.deviceRegistry.update({
        where: { id: device.id },
        data: { pairedToDeviceId: pos.id, locationId: pos.locationId },
      })
      await db.auditLog.create({
        data: {
          id: nid(),
          userId: null,
          action: 'DISPLAY_PAIRED',
          entityType: 'DeviceRegistry',
          entityId: pos.id,
          details: `display=${device.name} → POS=${pos.name}`,
          locationId: pos.locationId,
        },
      })
      return ok({ connected: true, posName: pos.name })
    }

    if (device.type === 'customer_display') {
      await db.deviceRegistry.update({ where: { id: device.id }, data: { pairedToDeviceId: null } })
      return ok({ unpaired: true })
    }
    await db.deviceRegistry.updateMany({ where: { pairedToDeviceId: device.id }, data: { pairedToDeviceId: null } })
    return ok({ unpaired: true })
  }

  // POS akciji (pair/push) — staff seja ALI POS device token
  const pos = await posIdentity(req)
  if (!pos) return fail('Avtentikacija obvezna (staff seja ali POS naprava).', 401)

  if (action === 'pair') {
    const posRow = await resolvePosRow(pos.kind, pos.id)
    if (!posRow) return fail('Ni registrirane POS naprave — najprej dodaj napravo tipa POS.', 404)
    const code = newPairingCode()
    await db.deviceRegistry.update({
      where: { id: posRow.id },
      data: { pairingCode: code, pairingExpiresAt: new Date(Date.now() + 10 * 60_000) },
    })
    return ok({ code, expiresInSec: 600 })
  }

  if (action === 'push') {
    const posRow = await resolvePosRow(pos.kind, pos.id)
    if (!posRow) return fail('Ni registrirane POS naprave za display.', 404)
    const payload = JSON.stringify(body?.payload ?? null)
    if (payload.length > DISPLAY_PAYLOAD_MAX) return fail('Prevelik payload za display.', 413)
    await db.deviceRegistry.update({
      where: { id: posRow.id },
      data: { displayPayload: payload, displayUpdatedAt: new Date() },
    })
    return ok({ pushed: true })
  }

  return fail('Neznan action (pair | connect | push | unpair).', 400)
}

/** GET — display preveri svojo vezavo (posName) */
export async function GET(req: NextRequest) {
  const token = req.headers.get('x-device-token')
  const device = await deviceFromToken(token)
  if (!deviceAlive(device, ['pos', 'customer_display'])) return fail('Naprava ni registrirana.', 401)
  await db.deviceRegistry.update({
    where: { id: device.id },
    data: { status: 'online', lastSeenAt: new Date() },
  })
  if (device.type === 'pos') return ok({ type: 'pos', name: device.name })
  if (!device.pairedToDeviceId) return ok({ type: 'customer_display', paired: false })
  const pos = await db.deviceRegistry.findUnique({ where: { id: device.pairedToDeviceId } })
  if (!pos || pos.revokedAt) return ok({ type: 'customer_display', paired: false })
  return ok({
    type: 'customer_display',
    paired: true,
    posName: pos.name,
    posOnline: pos.status === 'online' && !!pos.lastSeenAt && Date.now() - pos.lastSeenAt.getTime() < 120_000,
  })
}
