import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, assertResourceLocation, isResponse, ok, locationScope, requireUserLocation } from '@/lib/api'
import { mapReservation, reservationStatusToDB, reservationSourceToDB, nid } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.reservation.findMany({
    // Issue #4 §1: staff vidi samo rezervacije svoje lokacije
    where: locationScope(user),
    orderBy: { dateTime: 'desc' },
    take: 100,
  })
  return ok({ reservations: rows.map(mapReservation) })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.guestName || !body?.reservedAt) {
    return ok({ error: 'Ime gosta in čas rezervacije sta obvezna.' }, 400)
  }
  // Issue #4 §10: brez findFirst() fallback — staff = svoja lokacija, centralna poda body.locationId
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  // Issue #4 §1: miza rezervacije mora pripadati rezervirani lokaciji
  if (body.tableId) {
    const table = await db.table.findUnique({ where: { id: String(body.tableId) }, select: { locationId: true } })
    if (!table) return ok({ error: 'Miza ne obstaja.' }, 400)
    if (table.locationId !== locationId) return ok({ error: 'Miza ne pripada lokaciji rezervacije.' }, 400)
  }
  const row = await db.reservation.create({
    data: {
      id: nid(),
      customerName: String(body.guestName),
      customerPhone: String(body.phone || ''),
      dateTime: new Date(body.reservedAt),
      partySize: Number(body.guests) || 2,
      tableId: body.tableId || null,
      status: reservationStatusToDB(body.status || 'CONFIRMED'),
      source: reservationSourceToDB(body.source || 'PHONE'),
      notes: body.note || '',
      locationId,
    },
  })
  return ok({ reservation: mapReservation(row) }, 201)
}

/** Sprememba statusa rezervacije (preklic, gost prišel, zaključek, no-show). */
const ALLOWED_STATUSES = ['CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']
export async function PATCH(req: NextRequest) {
  // Issue #4 §1: upravljanje rezervacij zahteva reservations.manage (prej samo prijava)
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  const status = String(body?.status || '').toUpperCase()
  if (!id) return ok({ error: 'ID rezervacije je obvezen.' }, 400)
  if (!ALLOWED_STATUSES.includes(status)) return ok({ error: 'Neznan status rezervacije.' }, 400)
  const existing = await db.reservation.findUnique({ where: { id } })
  if (!existing) return ok({ error: 'Rezervacija ne obstaja.' }, 404)
  // Issue #4 §1: tuja rezervacija (druga lokacija) je nedosegljiva (fail-closed)
  const locRes = assertResourceLocation(user, existing.locationId)
  if (locRes) return locRes
  const row = await db.reservation.update({ where: { id }, data: { status: reservationStatusToDB(status) } })
  return ok({ reservation: mapReservation(row) })
}
