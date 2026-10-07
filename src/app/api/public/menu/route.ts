import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import {
  loadPublicMenu,
  resolveQrToken,
  rateLimitPublic,
  clientIp,
  deviceFromToken,
  deviceAlive,
} from '@/lib/guest'

/**
 * Issue #3 — JAVNI meni (ENOTEN vir: isti DB kot POS).
 * Dostop: ?qr=<token mize>  ALI  header X-Device-Token (kiosk naprava).
 * Brez prijave. Rate limit 60/min na IP.
 */
export async function GET(req: NextRequest) {
  if (!rateLimitPublic(`menu:${clientIp(req)}`, 60)) return fail('Preveč zahtevkov. Poskusi čez minuto.', 429)

  const qrToken = req.nextUrl.searchParams.get('qr')
  const deviceToken = req.headers.get('x-device-token')

  let locationId: string | null = null
  let restaurant: string | null = null
  let tableNumber: number | null = null
  let source: 'qr' | 'kiosk' | null = null

  if (qrToken) {
    const table = await resolveQrToken(qrToken)
    if (!table) return fail('QR koda ni veljavna ali je naročanje po QR izklopljeno.', 404)
    locationId = table.locationId
    restaurant = table.Location?.name || 'Restavracija'
    tableNumber = table.number
    source = 'qr'
  } else if (deviceToken) {
    const device = await deviceFromToken(deviceToken)
    if (!deviceAlive(device, ['kiosk'])) return fail('Kiosk naprava ni registrirana.', 401)
    await db.deviceRegistry.update({
      where: { id: device.id },
      data: { status: 'online', lastSeenAt: new Date() },
    })
    locationId = device.locationId || (device.Location ? device.Location.id : null)
    if (!locationId) return fail('Kiosk ni povezan z lokacijo.', 400)
    restaurant = device.Location?.name || 'Restavracija'
    source = 'kiosk'
  } else {
    return fail('Manjka QR token ali identiteta naprave.', 401)
  }

  const menu = await loadPublicMenu(locationId)
  return ok({ restaurant, tableNumber, source, ...menu })
}
