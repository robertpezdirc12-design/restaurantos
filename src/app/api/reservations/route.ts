import { NextRequest } from 'next/server'
import type { ReservationStatus, ReservationSource } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, locationScope, requireUserLocation, isCentralRole } from '@/lib/api'
import { guardResource, assertOrgScope } from '@/lib/tenant'
import { mapReservation, reservationStatusToDB, reservationSourceToDB, nid, jstr, ORDER_ACTIVE_DB } from '@/lib/map'
import { outsideHoursFor, validateOpeningHoursRowsPartial, type ValidatedRow } from '@/lib/openinghours'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import { lockReservationCapacity } from '@/lib/reservation-widget'
import { findTableReservationConflict, claimConflictMessage, assertTableClaimable } from '@/lib/table-claim'
import { loadPacingConfig, assertArrivalPacing, type PacingCheck } from '@/lib/reservation-pacing'

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

/**
 * Issue #5 (P0 §B): prej requireAuth — gostovi PII (telefon, e-pošta) iz rezervacij
 * je bil dostopen vsakemu prijavljenemu (kuhar, čistilka). Rezervacije vodi recepcija/
 * natakar (reservations.manage — TAB_PERM.rezervacije) — ostali status naročila spremljajo
 * prek /api/orders.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const rows = await db.reservation.findMany({ where: await locationScope(user), orderBy: { dateTime: 'desc' }, take: 100 })
  return ok({ reservations: rows.map(mapReservation) })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.guestName || !body?.reservedAt) return ok({ error: 'Ime gosta in čas rezervacije sta obvezna.' }, 400)
  let locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId) && isCentralRole(user) && !user.loc) {
    // Issue #96 (QA P1): centralna vloga brez lokacije in brez locationId v telesu
    // — FAIL-CLOSED fallback: natanko ENA aktivna lokacija v obsegu organizacije
    // je enolična (ni ugibanja); pri več lokacijah 400 ostane (dialog v UI ponudi
    // izbirnik, API integrator pa mora poslati locationId).
    const scope = await locationScope(user)
    const rows = await db.location.findMany({
      where: { isActive: true, id: scope.locationId ? (typeof scope.locationId === 'string' ? scope.locationId : { in: scope.locationId.in }) : undefined },
      select: { id: true },
      take: 2,
    })
    if (rows.length === 1) locationId = rows[0].id
  }
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
      await writeAudit(db, { userId: user.sub, action: 'RESERVATION_OUTSIDE_HOURS', entityType: 'Reservation', entityId: 'pending', details: jstr({ when: when.toISOString(), reason: out.reason, label: out.label, locationId }) }).catch(() => {})
    }
  }

  // OPS-8 val 3 (v1.73.0): optional dialog fields — concrete table, channel, guest
  // e-mail, planned duration and special requests (all existing schema columns).
  const email = String(body.customerEmail || '').trim().slice(0, 200)
  const duration = Math.min(600, Math.max(15, Math.round(Number(body.duration) || 120)))
  const specialRequests = String(body.specialRequests || '').trim().slice(0, 500)

  // v1.240.0 (§16 E, B-načrt 1) — STREŽNIŠKI prekrivni pogoj terminov na mizi.
  // @@unique([tableId, dateTime]) zavrne SAMO identičen žig; UI (autoAssignTable)
  // je prekrivanje znal preskočiti, strežnik pa ne — 19:00 (120 min) in 20:00 na
  // isti mizi sta obe uspeli. Zdaj: prekrivanje intervalov [start, start+duration)
  // ∩ obstoječa DEJAVNA rezervacija (confirmed/seated/completed; cancelled/
  // no_show ne zavirata) → 409 z imenom gosta in terminom (korenita razlaga).
  // Zaklep: lockReservationCapacity (UPSERT na Counter, vzorec javnega widgeta
  // v1.158.0) serializira vse ustvarjalce rezervacij na lokaciji do commita —
  // dva sočasna POST-a ne moreta videti iste proste mize. P2002 ostaja kot
  // zadnja obramba za identičen žig.
  let row
  try {
    row = await db.$transaction(async (tx) => {
      await lockReservationCapacity(tx, locationId)
      if (body.tableId && Number.isFinite(when.getTime())) {
        const conflict = await findTableReservationConflict(tx, {
          tableId: String(body.tableId),
          at: when,
          durationMin: duration,
        })
        if (conflict) {
          const t = await tx.table.findUnique({ where: { id: String(body.tableId) }, select: { number: true } })
          return { conflict: claimConflictMessage(t?.number ?? 0, conflict) }
        }
      }
      // v1.244.0 (§18 A) — RITEM PRIHODOV: interna pot (telefon/walk-in) je edina
      // ustvarjalna pot brez kapacitetnega varovala (javni widget ima maxCoversPerSlot
      // + leadMinutes). Skupni strežniški varovalec: največ gostov na fiksno okno,
      // preverjeno pod istim zaklepom; izrecen preglas (forcePacing — vzorec
      // allowOutsideHours) gre z revizijo. Brez konfiguracije = privzeto IZKLOP
      // (obstoječe lokacije nespremenjene).
      let pacingUsed: PacingCheck | null = null
      if (Number.isFinite(when.getTime())) {
        const pacingConfig = await loadPacingConfig(tx, locationId)
        const pacing = await assertArrivalPacing(tx, locationId, when, Number(body.guests) || 2, pacingConfig)
        if (pacing && !body.forcePacing) return { pacing }
        if (pacing && body.forcePacing) pacingUsed = pacing
      }
      const created = await tx.reservation.create({
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
      return { created, pacingUsed }
    })
  } catch (e: unknown) {
    // @@unique([tableId, dateTime]) — a concrete table can host only one reservation per slot
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === 'P2002' && body.tableId) {
      return ok({ error: 'Miza je že rezervirana ob izbranem času.' }, 409)
    }
    throw e
  }
  if ('conflict' in row) return ok({ error: row.conflict, code: 'TABLE_TIME_CONFLICT' }, 409)
  // v1.244.0 (§18 A): ritem prihodov presežen BREZ preglasa → 409 z izrecno
  // ponudbo (UI ponudi potrditev — isti potek kot OUTSIDE_OPENING_HOURS).
  if ('pacing' in row) {
    const p = row.pacing as PacingCheck
    return ok({
      error: p.message,
      code: 'ARRIVAL_PACING',
      overrideRequired: true,
      windowStart: p.windowStart.toISOString(),
      windowEnd: p.windowEnd.toISOString(),
      currentGuests: p.currentGuests,
      maxGuests: p.maxGuests,
    }, 409)
  }
  if (!('created' in row) || !row.created) return ok({ error: 'Rezervacije ni bilo mogoče ustvariti.' }, 500)
  const resvRow = row.created
  // izrecen preglas ritemnega varovala — revizija (isti vzorec kot
  // RESERVATION_OUTSIDE_HOURS: kdor preglasi, pusti sled)
  if (row.pacingUsed) {
    const p = row.pacingUsed
    await writeAudit(db, {
      userId: user.sub,
      action: 'RESERVATION_PACING_OVERRIDE',
      entityType: 'Reservation',
      entityId: resvRow.id,
      details: jstr({
        when: resvRow.dateTime.toISOString(),
        partySize: resvRow.partySize,
        windowStart: p.windowStart.toISOString(),
        windowEnd: p.windowEnd.toISOString(),
        currentGuests: p.currentGuests,
        maxGuests: p.maxGuests,
        by: user.name,
        locationId,
      }),
    }).catch(() => {})
  }
  // OPS-8 val 2 (v1.72.0): push to waiters/management on new reservation (via notification
  // matrix; fire-and-forget — reservation is a critical path)
  void pushEvent('RESERVATION_NEW', {
    title: 'Nova rezervacija',
    body: `${String(body.guestName)} · ${new Date(body.reservedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${Number(body.guests) || 2} oseb`,
    url: '/dashboard?tab=rezervacije',
    tag: `reservation-${resvRow.id}`,
  }, { roles: ['waiter', 'manager'], locationId })
  return ok({ reservation: mapReservation(resvRow) }, 201)
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
  const toDB = reservationStatusToDB(status) as ReservationStatus
  const now = new Date()

  // v1.240.0 (§16 E, B-načrt 2) — prehodi rezervacije upravljajo TUDI mizo:
  //  - SEATED: če ima rezervacija mizo, jo zakleni (pogojno — samo če ni
  //    fizično zasedena / rezervacijsko konfliktna) v isti transakciji kot
  //    sprememba statusa (vzorec usaditve čakalne vrste); actualArrival se
  //    izpolni ob prvem usajanju (semantika modela, prej nikoli nezapolnjena).
  //  - NO_SHOW/CANCELLED/COMPLETED: miza, ki jo je ta rezervacija držala, se
  //    VARNO sprosti — 'reserved' → 'available' vedno; 'occupied' LE brez
  //    aktivnega naročila in brez novejše usaditve čakalne vrste (ista
  //    varovala kot releaseTable v waitlist, v1.162.0). Prej noben terminalni
  //    status ni sprostil ničesar — miza je ostala "rezervirana" za vedno.
  if (toDB === 'seated' && existing.tableId) {
    // okno = preostanek intervala TE rezervacije od zdaj naprej (lastna je
    // izključena; druge dejavne rezervacije na isti mizi so konflikt)
    const resvEnd = existing.dateTime.getTime() + Math.max(15, existing.duration || 120) * 60_000
    const remainingMin = Math.max(15, Math.ceil((resvEnd - now.getTime()) / 60_000))
    let seated: { ok: false; error: string } | { ok: true; row: typeof existing }
    try {
      seated = await db.$transaction(async (tx) => {
        await lockReservationCapacity(tx, existing.locationId || '')
        const claim = await assertTableClaimable(tx, {
          tableId: existing.tableId as string,
          expectLocationId: existing.locationId,
          at: now,
          durationMin: remainingMin,
          excludeReservationId: existing.id,
        })
        if (!claim.ok) return { ok: false as const, error: claim.message }
        const lock = await tx.table.updateMany({
          where: { id: existing.tableId as string, status: { not: 'occupied' } },
          data: { status: 'occupied' },
        })
        if (lock.count === 0) return { ok: false as const, error: 'Miza je bila vmes zasedena — osveži in poskusi znova.' }
        return {
          ok: true as const,
          row: await tx.reservation.update({
            where: { id },
            data: { status: toDB, actualArrival: existing.actualArrival ?? now },
          }),
        }
      })
    } catch {
      return ok({ error: 'Prehod v usajeno ni uspel — poskusi znova.' }, 500)
    }
    if (!seated.ok) return ok({ error: seated.error, code: 'TABLE_TIME_CONFLICT' }, 409)
    await writeAudit(db, { userId: user.sub, action: 'RESERVATION_SEATED_TABLE_LOCKED', entityType: 'Reservation', entityId: id, details: jstr({ tableId: existing.tableId, guestName: existing.customerName, at: now.toISOString() }), locationId: existing.locationId }).catch(() => {})
    return ok({ reservation: mapReservation(seated.row) })
  }

  if ((toDB === 'no_show' || toDB === 'cancelled' || toDB === 'completed') && existing.tableId) {
    const table = await db.table.findUnique({
      where: { id: existing.tableId },
      select: { id: true, number: true, status: true },
    })
    if (table && table.status !== 'available') {
      let released = false
      if (table.status === 'reserved') {
        const freed = await db.table.updateMany({ where: { id: table.id, status: 'reserved' }, data: { status: 'available' } })
        released = freed.count > 0
      } else if (table.status === 'occupied') {
        // fizično zasedena: sprosti SAMO brez aktivnega naročila in brez
        // novejše usaditve čakalne vrste (ne rušimo tujega gosta)
        const activeOrder = await db.order.findFirst({ where: { tableId: table.id, status: { in: ORDER_ACTIVE_DB } }, select: { id: true } })
        const newerSeat = await db.waitlistEntry.findFirst({
          where: { tableId: table.id, status: 'seated', seatedAt: { gt: existing.actualArrival ?? existing.updatedAt } },
          select: { id: true },
        })
        if (!activeOrder && !newerSeat) {
          const freed = await db.table.updateMany({ where: { id: table.id, status: 'occupied' }, data: { status: 'available' } })
          released = freed.count > 0
        }
      }
      if (released) {
        await writeAudit(db, { userId: user.sub, action: 'RESERVATION_TABLE_RELEASED', entityType: 'Reservation', entityId: id, details: jstr({ tableId: table.id, tableNumber: table.number, fromStatus: existing.status, toStatus: toDB }), locationId: existing.locationId }).catch(() => {})
      }
    }
  }

  const row = await db.reservation.update({ where: { id }, data: { status: toDB } })
  return ok({ reservation: mapReservation(row) })
}
