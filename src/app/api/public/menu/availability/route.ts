import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { fail } from '@/lib/api'
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
 * Issue #9 (v1.119.0) — JAVNA lahkotna ruta za osveževanje RAZPOLOŽLJIVOSTI brez
 * polnega menija (QR/kiosk polling vsakih ~30 s → 86-plošča se vidi brez reloada).
 *
 * Avtentikacija IDENTIČNA /api/public/menu (isti helperji/ključi):
 *  - query `qr` (resolveQrToken — veljaven 32-hex mizni žeton) ALI
 *  - header `x-device-token` (deviceFromToken + deviceAlive(['kiosk'])) → locationId.
 *  - Brez obeh → 401; slab/neznan → 401 (sporočila ISTA kot menu ruta; menu ruta
 *    za slab QR vrača 404 — tu je vir "avtentikacija", zato enotno 401 po pogodbi).
 * Rate limit 60/min po IP (isti vzorec/limit kot menu ruta, lasten ključ).
 *
 * ETag: sha256 nad MINIMALNIM payloadom (samo availability vrstice — brez
 * generatedAt), If-None-Match ujema → 304 s praznim telesom (polling ~0 B).
 * Odgovor 200: { generatedAt, availability: [{id, isAvailable, price}] } —
 * preslikano IZ loadPublicMenu (ENOTEN vir = isti DB kot POS, num() cene),
 * cache-control no-store (razpoložljivost je živo stanje).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  if (!(await rateLimitPublic(`avail:${clientIp(req)}`, 60))) return fail('Preveč zahtevkov. Poskusi čez minuto.', 429)

  const qrToken = req.nextUrl.searchParams.get('qr')
  const deviceToken = req.headers.get('x-device-token')

  let locationId: string | null = null

  if (qrToken) {
    const table = await resolveQrToken(qrToken)
    if (!table) return fail('QR koda ni veljavna ali je naročanje po QR izklopljeno.', 401)
    locationId = table.locationId
  } else if (deviceToken) {
    const device = await deviceFromToken(deviceToken)
    if (!deviceAlive(device, ['kiosk'])) return fail('Kiosk naprava ni registrirana.', 401)
    // isti kiosk heartbeat kot menu ruta (status/lastSeenAt osvežita živo)
    await db.deviceRegistry.update({
      where: { id: device.id },
      data: { status: 'online', lastSeenAt: new Date() },
    }).catch(() => null)
    locationId = device.locationId || (device.Location ? device.Location.id : null)
    if (!locationId) return fail('Kiosk ni povezan z lokacijo.', 400)
  } else {
    return fail('Manjka QR token ali identiteta naprave.', 401)
  }

  // ENOTEN vir: iste vrstice kot /api/public/menu (id/isAvailable/price num())
  const menu = await loadPublicMenu(locationId)
  const availability = menu.items.map((i) => ({ id: i.id, isAvailable: i.isAvailable, price: i.price }))

  // Stabilen ETag nad minimalnim payloadom (brez generatedAt — ta se spreminja vsak klic)
  const etag = '"' + createHash('sha256').update(JSON.stringify(availability), 'utf8').digest('hex') + '"'
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } })
  }
  return NextResponse.json(
    { generatedAt: new Date().toISOString(), availability },
    { headers: { etag, 'cache-control': 'no-store' } },
  )
}
