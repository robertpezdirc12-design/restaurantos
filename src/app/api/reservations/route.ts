import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { mapReservation, reservationStatusToDB, reservationSourceToDB, nid } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.reservation.findMany({ orderBy: { dateTime: 'desc' }, take: 100 })
  return ok({ reservations: rows.map(mapReservation) })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.guestName || !body?.reservedAt) {
    return ok({ error: 'Ime gosta in čas rezervacije sta obvezna.' }, 400)
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
      locationId: user.loc || (await db.location.findFirst())?.id || null,
    },
  })
  return ok({ reservation: mapReservation(row) }, 201)
}
