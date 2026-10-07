import { NextRequest } from 'next/server'
import { ReservationStatus, ReservationSource } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, assertResourceLocation, isResponse, ok, locationScope, requireUserLocation } from '@/lib/api'
import { mapReservation, reservationStatusToDB, reservationSourceToDB, nid } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.reservation.findMany({ where: locationScope(user), orderBy: { dateTime: 'desc' }, take: 100 })
  return ok({ reservations: rows.map(mapReservation) })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.guestName || !body?.reservedAt) return ok({ error: 'Ime gosta in čas rezervacije sta obvezna.' }, 400)
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  if (body.tableId) {
    const table = await db.table.findUnique({ where: { id: String(body.tableId) }, select: { locationId: true } })
    if (!table) return ok({ error: 'Miza ne obstaja.' }, 400)
    if (table.locationId !== locationId) return ok({ error: 'Miza ne pripada lokaciji rezervacije.' }, 400)
  }
  const row = await db.reservation.create({
    data: {
      id: nid(), customerName: String(body.guestName), customerPhone: String(body.phone || ''),
      dateTime: new Date(body.reservedAt), partySize: Number(body.guests) || 2, tableId: body.tableId || null,
      status: reservationStatusToDB(body.status || 'CONFIRMED') as ReservationStatus,
      source: reservationSourceToDB(body.source || 'PHONE') as ReservationSource,
      notes: body.note || '', locationId,
    },
  })
  return ok({ reservation: mapReservation(row) }, 201)
}

const ALLOWED_STATUSES = ['CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const
export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  const status = String(body?.status || '').toUpperCase()
  if (!id) return ok({ error: 'ID rezervacije je obvezen.' }, 400)
  if (!ALLOWED_STATUSES.includes(status as typeof ALLOWED_STATUSES[number])) return ok({ error: 'Neznan status rezervacije.' }, 400)
  const existing = await db.reservation.findUnique({ where: { id } })
  if (!existing) return ok({ error: 'Rezervacija ne obstaja.' }, 404)
  const locRes = assertResourceLocation(user, existing.locationId)
  if (locRes) return locRes
  const row = await db.reservation.update({ where: { id }, data: { status: reservationStatusToDB(status) as ReservationStatus } })
  return ok({ reservation: mapReservation(row) })
}
