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
import { comboTableIdsOf, parseComboTableIds, autoassignPickForWindow } from '@/lib/table-combos'
import type { AutoassignPick } from '@/lib/table-autoassign'

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

  // v1.245.0 (§19) — KOMBINACIJSKA REZERVACIJA: body.tableIds (≥ 2 miz) =
  // družba, večja od največje posamezne mize (Lightspeed »table combinations«).
  // tableId ostane PRIMARNA miza (prva iz seznama — kompatibilnost z UI/logs);
  // comboTableIds nosi VSE članice ',id1,id2,'. Validacija: vse mize obstajajo,
  // so iz iste lokacije, brez podvajanj, vsota sedežev ≥ oseb (drugače kombinacija
  // nima smisla). Konflikti se preverijo PER ČLANICA znotraj transakcije spodaj.
  const comboIds: string[] = Array.isArray(body.tableIds)
    ? [...new Set((body.tableIds as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean))]
    : []
  if (comboIds.length > 0 && comboIds.length < 2) {
    return ok({ error: 'Kombinacija potrebuje vsaj dve mizi.' }, 400)
  }
  if (comboIds.length > 5) {
    return ok({ error: 'Kombinacija lahko zajema največ 5 miz.' }, 400)
  }
  if (comboIds.length >= 2) {
    const members = await db.table.findMany({ where: { id: { in: comboIds } }, select: { id: true, locationId: true, capacity: true, number: true } })
    if (members.length !== comboIds.length) return ok({ error: 'Ena od miz v kombinaciji ne obstaja.' }, 400)
    const foreign = members.find((m) => m.locationId !== locationId)
    if (foreign) return ok({ error: `Miza ${foreign.number} ne pripada lokaciji rezervacije.` }, 400)
    const seats = members.reduce((s, m) => s + (m.capacity || 0), 0)
    if (seats < (Number(body.guests) || 2)) {
      return ok({ error: `Kombinacija ima skupaj ${seats} sedežev — premalo za ${Number(body.guests) || 2} oseb.` }, 400)
    }
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
      // mize za preverbo konfliktov: kombinacija (vse članice) ali enojna miza
      const conflictTargets: string[] = comboIds.length >= 2 ? comboIds : (body.tableId ? [String(body.tableId)] : [])
      for (const tid of conflictTargets) {
        if (!Number.isFinite(when.getTime())) break
        const conflict = await findTableReservationConflict(tx, {
          tableId: tid,
          at: when,
          durationMin: duration,
        })
        if (conflict) {
          const t = await tx.table.findUnique({ where: { id: tid }, select: { number: true } })
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
      // v1.252.0 (§26) — AVTODODELITEV INTERNE POTI (Lightspeed maj 2026
      // »automatic table assignments«): ko osebje NE izbere mize (telefon /
      // walk-in brez mize) in je ne izklopi izrecno (skipAutoAssign, vzorec
      // allowOutsideHours/forcePacing), strežnik ob ustvarjanju dodeli
      // NAJMANJŠO ustrezno mizo ali registrirano kombinacijo — isti čisti
      // sloj kot javna pot v1.248 (ena resnica o izbiri), a z DEJANSKIM
      // trajanjem rezervacije (interna pot 15–600 min, javna fiksno 120).
      // Teče ZA zaklepom kapacitete → sočasni ustvarjanji ne moreta dobiti
      // iste mize. Nobena ne ustreza → rezervacija BREZ mize (dodelitev je
      // pomoč, ne obveza — osebje dodeli ročno, Lightspeed »skip«).
      let autoPick: AutoassignPick | null = null
      if (!body.tableId && comboIds.length < 2 && !body.skipAutoAssign && Number.isFinite(when.getTime())) {
        autoPick = await autoassignPickForWindow(tx, locationId, when, duration, Number(body.guests) || 2)
      }
      const created = await tx.reservation.create({
        data: {
          id: nid(), customerName: String(body.guestName), customerPhone: String(body.phone || ''),
          customerEmail: email,
          dateTime: new Date(body.reservedAt), partySize: Number(body.guests) || 2,
          tableId: comboIds.length >= 2 ? comboIds[0] : (body.tableId || (autoPick ? autoPick.tableIds[0] : null)),
          // v1.245.0: kombinacija = ',id1,id2,' VSEH miz (vključno s primarno);
          // enojna rezervacija = '' (obstoječe vrstice nespremenjene).
          // v1.252.0: kombinacija iz AVTODODELITVE nosi vse članice enako
          // (primarna = prva članica); explicit > auto > brez mize.
          comboTableIds: comboIds.length >= 2
            ? comboTableIdsOf(comboIds)
            : (autoPick && autoPick.tableIds.length >= 2 ? comboTableIdsOf(autoPick.tableIds) : ''),
          duration,
          status: reservationStatusToDB(body.status || 'CONFIRMED') as ReservationStatus,
          source: reservationSourceToDB(body.source || 'PHONE') as ReservationSource,
          notes: body.note || '',
          specialRequests,
          locationId,
        },
      })
      return { created, pacingUsed, autoPick }
    })
  } catch (e: unknown) {
    // @@unique([tableId, dateTime]) — a concrete table can host only one reservation per slot.
    // v1.252.0: pod zaklepom teoretično nedosegljivo, a če se vseeno zgodi
    // (avtododelitev na točno isti žig), je 409 s poštenim sporočilom
    // boljši od 500 — nikoli ne prevajamo neznane napake v uspeh.
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === 'P2002') {
      return ok({ error: body.tableId ? 'Miza je že rezervirana ob izbranem času.' : 'Miza je pravkar postala zasedena — poskusite znova ali izberite drugo.' }, 409)
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
  // v1.252.0 (§26): avtododeljena miza pusti revizijsko sled (kdor vidi
  // »čudno« mizo, vidi tudi ZAKAJ — strežnik jo je izbral sam). Fire-and-
  // forget: revizija NI kritična pot ustvarjanja (.catch vzorec).
  const autoPick = row.autoPick ?? null
  if (autoPick) {
    await writeAudit(db, {
      userId: user.sub,
      action: 'RESERVATION_AUTOASSIGNED',
      entityType: 'Reservation',
      entityId: resvRow.id,
      locationId,
      details: jstr({
        miza: autoPick.label,
        sedezev: autoPick.seats,
        termin: resvRow.dateTime.toISOString(),
        oseb: resvRow.partySize,
        trajanjeMin: resvRow.duration,
        by: user.name,
      }),
    }).catch(() => {})
  }
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
  // v1.252.0: autoAssignedTable (label | null) — aditivno polje odgovora;
  // UI ga pokaže kot toast, API integratorji pa vidijo, da miza NI bila
  // človeška izbira (null = izrecna izbira ali brez mize).
  return ok({ reservation: mapReservation(resvRow), autoAssignedTable: autoPick ? autoPick.label : null }, 201)
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
    // v1.245.0: kombinacija zaklene VSE članice (claim + lock per miza).
    const resvEnd = existing.dateTime.getTime() + Math.max(15, existing.duration || 120) * 60_000
    const remainingMin = Math.max(15, Math.ceil((resvEnd - now.getTime()) / 60_000))
    const memberIds = [existing.tableId, ...parseComboTableIds(existing.comboTableIds)]
    const uniqueMembers = [...new Set(memberIds)]
    let seated: { ok: false; error: string } | { ok: true; row: typeof existing }
    try {
      seated = await db.$transaction(async (tx) => {
        await lockReservationCapacity(tx, existing.locationId || '')
        for (const tid of uniqueMembers) {
          const claim = await assertTableClaimable(tx, {
            tableId: tid,
            expectLocationId: existing.locationId,
            at: now,
            durationMin: remainingMin,
            excludeReservationId: existing.id,
          })
          if (!claim.ok) return { ok: false as const, error: claim.message }
        }
        for (const tid of uniqueMembers) {
          const lock = await tx.table.updateMany({
            where: { id: tid, status: { not: 'occupied' } },
            data: { status: 'occupied' },
          })
          if (lock.count === 0) return { ok: false as const, error: 'Miza je bila vmes zasedena — osveži in poskusi znova.' }
        }
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
    await writeAudit(db, { userId: user.sub, action: 'RESERVATION_SEATED_TABLE_LOCKED', entityType: 'Reservation', entityId: id, details: jstr({ tableId: existing.tableId, comboTableIds: existing.comboTableIds, tables: uniqueMembers, guestName: existing.customerName, at: now.toISOString() }), locationId: existing.locationId }).catch(() => {})
    return ok({ reservation: mapReservation(seated.row) })
  }

  if ((toDB === 'no_show' || toDB === 'cancelled' || toDB === 'completed') && existing.tableId) {
    // v1.245.0: izpusti VSE mize rezervacije (kombinacija = vse članice;
    // enojna = primarna — obnašanje nespremenjeno). Ista varovala per miza:
    // 'reserved' → 'available' vedno; 'occupied' LE brez aktivnega naročila
    // in brez novejše usaditve čakalne vrste (ne rušimo tujega gosta).
    const memberIds = [...new Set([existing.tableId, ...parseComboTableIds(existing.comboTableIds)])]
    for (const tid of memberIds) {
      const table = await db.table.findUnique({
        where: { id: tid },
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
  }

  const row = await db.reservation.update({ where: { id }, data: { status: toDB } })
  return ok({ reservation: mapReservation(row) })
}
