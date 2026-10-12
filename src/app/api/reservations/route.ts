import { NextRequest } from 'next/server'
import type { ReservationStatus, ReservationSource } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, locationScope, requireUserLocation } from '@/lib/api'
import { guardResource, assertOrgScope } from '@/lib/tenant'
import { mapReservation, reservationStatusToDB, reservationSourceToDB, nid, jstr } from '@/lib/map'
import { outsideHoursFor, validateOpeningHoursRowsPartial, type ValidatedRow } from '@/lib/openinghours'
import { auditChainFields } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'

/** Tedenske vrstice lokacije (ali org privzete); delni niz je veljaven — manjkajoči dnevi ne gate-ajo. */
async function weeklyValidated(locationId: string): Promise<ValidatedRow[]> {
  let rows = await db.openingHours.findMany({ where: { locationId }, orderBy: { dayOfWeek: 'asc' } })
  if (rows.length === 0) rows = await db.openingHours.findMany({ where: { locationId: null }, orderBy: { dayOfWeek: 'asc' } })
  if (rows.length === 0) return []
  const v = validateOpeningHoursRowsPartial(rows.map((r) => ({
    dayOfWeek: r.dayOfWeek, openTime: r.openTime, closeTime: r.closeTime,
    breakStart: r.breakStart, breakEnd: r.breakEnd, isClosed: r.isClosed,
  })))
  return v.ok ? v.rows : []
}

async function specialsFor(locationId: string | undefined): Promise<{ date: string; isClosed: boolean; openTime: string; closeTime: string; note: string }[]> {
  const where = locationId ? { OR: [{ locationId }, { locationId: null }] } : { locationId: null }
  const rows = await db.specialOpeningDay.findMany({
    where: { ...where, date: { gte: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10), lte: new Date(Date.now() + 400 * 86400_000).toISOString().slice(0, 10) } },
    orderBy: { date: 'asc' },
  })
  const byDate = new Map<string, { date: string; isClosed: boolean; openTime: string; closeTime: string; note: string; loc: string | null }>()
  for (const r of rows) {
    const prev = byDate.get(r.date)
    if (!prev || (prev.loc === null && r.locationId !== null)) {
      byDate.set(r.date, { date: r.date, isClosed: r.isClosed, openTime: r.openTime, closeTime: r.closeTime, note: r.note, loc: r.locationId })
    }
  }
  return [...byDate.values()].map(({ loc: _loc, ...s }) => s)
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.reservation.findMany({ where: await locationScope(user), orderBy: { dateTime: 'desc' }, take: 100 })
  return ok({ reservations: rows.map(mapReservation) })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.guestName || !body?.reservedAt) return ok({ error: 'Ime gosta in čas rezervacije sta obvezna.' }, 400)
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard
  if (body.tableId) {
    const table = await db.table.findUnique({ where: { id: String(body.tableId) }, select: { locationId: true } })
    if (!table) return ok({ error: 'Miza ne obstaja.' }, 400)
    if (table.locationId !== locationId) return ok({ error: 'Miza ne pripada lokaciji rezervacije.' }, 400)
  }

  // triage ⑦: rezervacija ne sme pasti v zaprtje — 409 z razlago, izrecen preglasi (allowOutsideHours) je dovoljen
  const when = new Date(body.reservedAt)
  if (!Number.isNaN(when.getTime())) {
    const [rowsV, specials] = await Promise.all([weeklyValidated(locationId), specialsFor(locationId)])
    const out = outsideHoursFor(rowsV, specials, when)
    if (out.outside && !body.allowOutsideHours) {
      return ok({
        error: `Rezervacija pada izven odpiralnega časa: ${out.label}.`,
        code: 'OUTSIDE_OPENING_HOURS',
        outsideReason: out.reason,
        overrideRequired: true,
      }, 409)
    }
    if (out.outside && body.allowOutsideHours) {
      const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'RESERVATION_OUTSIDE_HOURS', entityType: 'Reservation', entityId: 'pending', details: jstr({ when: when.toISOString(), reason: out.reason, label: out.label, locationId }), id: __aId2 })
      await db.auditLog.create({
        data: { ...__chain2,
          id: __aId2, userId: user.sub, action: 'RESERVATION_OUTSIDE_HOURS', entityType: 'Reservation', entityId: 'pending',
          details: jstr({ when: when.toISOString(), reason: out.reason, label: out.label, locationId }),
        },
      }).catch(() => {})
    }
  }

  // OPS-8 val 3 (v1.73.0): optional dialog fields — concrete table, channel, guest
  // e-mail, planned duration and special requests (all existing schema columns).
  const email = String(body.customerEmail || '').trim().slice(0, 200)
  const duration = Math.min(600, Math.max(15, Math.round(Number(body.duration) || 120)))
  const specialRequests = String(body.specialRequests || '').trim().slice(0, 500)
  let row
  try {
    row = await db.reservation.create({
      data: {
        id: nid(), customerName: String(body.guestName), customerPhone: String(body.phone || ''),
        customerEmail: email,
        dateTime: new Date(body.reservedAt), partySize: Number(body.guests) || 2, tableId: body.tableId || null,
        duration,
        status: reservationStatusToDB(body.status || 'CONFIRMED') as ReservationStatus,
        source: reservationSourceToDB(body.source || 'PHONE') as ReservationSource,
        notes: body.note || '',
        specialRequests,
        locationId,
      },
    })
  } catch (e: unknown) {
    // @@unique([tableId, dateTime]) — a concrete table can host only one reservation per slot
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === 'P2002' && body.tableId) {
      return ok({ error: 'Miza je že rezervirana ob izbranem času.' }, 409)
    }
    throw e
  }
  // OPS-8 val 2 (v1.72.0): push to waiters/management on new reservation (via notification
  // matrix; fire-and-forget — reservation is a critical path)
  void pushEvent('RESERVATION_NEW', {
    title: 'Nova rezervacija',
    body: `${String(body.guestName)} · ${new Date(body.reservedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${Number(body.guests) || 2} oseb`,
    url: '/dashboard?tab=rezervacije',
    tag: `reservation-${row.id}`,
  }, { roles: ['waiter', 'manager'], locationId })
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
  const locRes = await guardResource(user, existing.locationId)
  if (locRes) return locRes
  const row = await db.reservation.update({ where: { id }, data: { status: reservationStatusToDB(status) as ReservationStatus } })
  return ok({ reservation: mapReservation(row) })
}
