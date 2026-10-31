import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { jstr, nid } from '@/lib/map'
import { clientIp, rateLimitPublic } from '@/lib/guest'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import { sendBookingConfirmation } from '@/lib/reminders'
import { resolveWidgetToken, widgetPolicyOf, openingRowsFor, specialsFor, activeReservationsFor, tableSeatsFor, publicSlotsForDate, dayBoundsUtc, lockReservationCapacity } from '@/lib/reservation-widget'
import { publicSlotsPayload, validateSlot, type DayHoursInput } from '@/lib/reservation-slots'
import { brandThemeForLocation } from '@/lib/brand-themes-server'
import { zonedDateParts, localDateKey } from '@/lib/haccp-ops'
import { isValidDateKey, parseHHMM } from '@/lib/openinghours'

/**
 * Issue #13 (P1/P2, v1.110.0) — JAVNI rezervacijski widget (/r/<token>).
 *
 * GET  ?token=&date=YYYY-MM-DD   → terminska plošča (mreža + prostost)
 * POST { token, date, time, partySize, name, phone, email?, note? } → rezervacija
 *
 * Varnost (isti vzorec kot /api/public/orders in /pay):
 *  - token JE skrivnost; lokacija/urnik/kapaciteta se rešijo STREŽNIŠKO
 *  - gost ne more izbrati termina, ki ga plošča ni pokazala kot prostega
 *    (STROGA validacija skozi isti motor — validateSlot)
 *  - PII: samo lastni vnos (ime/telefon/e-pošta/opomba); odgovor NE izdaje
 *    podatkov drugih gostov (samo lastna rezervacija)
 *  - rate limit: 60 GET/min/IP, 5 POST/min/IP
 *  - kapaciteta: gleda se CELOTEN izbrani dan (ne okno okoli "now"); preverba
 *    in ustvarjanje tečeta pod zaklepom lokacije (vrstica Counter), zato dve
 *    sočasni rezervaciji ne moreta obe preseči zmogljivosti (v1.158.0)
 *  - replay: dvojni klik/refresh (isti telefon + isti termin v 2 min) →
 *    ISTA rezervacija z replayed:true (brez dvojnikov)
 *  - vir: ReservationSource.website, status: confirmed (enak internemu
 *    privzetku); osebje upravlja nadaljnje prehode (seated/no-show/cancel)
 *  - audit: GUEST_RESERVATION_CREATED (userId null, IP)
 *  - push: RESERVATION_NEW natakarjem/vodstvu (obstoječi tip)
 *  - potrditev gostu: e-mail/SMS fail-soft (reminders infra)
 *
 * Do aplikacije DDL tabele ReservationWidget: resolveWidgetToken vrne null →
 * 404 (graceful — povezavo šele ustvari osebje prek nastavitev).
 */

const MAX_NOTE = 300

export async function GET(req: NextRequest) {
  if (!(await rateLimitPublic(`resvget:${clientIp(req)}`, 60))) return fail('Preveč zahtevkov. Poskusite čez minuto.', 429)

  const token = String(req.nextUrl.searchParams.get('token') || '')
  const dateParam = String(req.nextUrl.searchParams.get('date') || '')
  const resolved = await resolveWidgetToken(token)
  if (!resolved) return fail('Povezava za rezervacije ne obstaja ali je izklopljena.', 404)
  if (dateParam && !isValidDateKey(dateParam)) return fail('Neveljaven datum.', 400)

  // brez datuma → danes v pasu lokacije (zonedDateParts — DST varno)
  const now = new Date()
  const date = dateParam || localDateKey(zonedDateParts(now, resolved.timezone))

  const result = await publicSlotsForDate(resolved.widget, resolved.restaurantName, resolved.timezone, date, now)
  // OSS-11 (v1.213.0): `theme` ADDITIVE — absent = odgovor byte-identičen.
  const theme = await brandThemeForLocation(resolved.widget.locationId)
  const payload = publicSlotsPayload(resolved.restaurantName, result, widgetPolicyOf(resolved.widget))
  return ok(theme ? { ...payload, theme } : payload)
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Neveljavno telo zahteve.', 400)

  const ip = clientIp(req)
  if (!(await rateLimitPublic(`resvpost:${ip}`, 5))) return fail('Preveč poskusov rezervacije. Počakajte trenutek.', 429)

  const token = String(body.token || '')
  const resolved = await resolveWidgetToken(token)
  if (!resolved) return fail('Povezava za rezervacije ne obstaja ali je izklopljena.', 404)
  const { widget, restaurantName, timezone } = resolved
  const policy = widgetPolicyOf(widget)

  // ── vhodna normalizacija ──
  const date = String(body.date || '')
  const time = String(body.time || '')
  const partySize = Math.round(Number(body.partySize))
  const name = String(body.name || '').trim().slice(0, 80)
  const phone = String(body.phone || '').trim().slice(0, 30)
  const email = String(body.email || '').trim().slice(0, 200)
  const note = String(body.note || '').trim().slice(0, MAX_NOTE)

  if (!isValidDateKey(date)) return fail('Neveljaven datum.', 400)
  const hhmm = parseHHMM(time)
  if (hhmm === null) return fail('Neveljaven čas.', 400)
  if (!name || name.length < 2) return fail('Ime je obvezno (vsaj 2 znaki).', 400)
  if (!phone || phone.replace(/[^\d+]/g, '').length < 5) return fail('Telefonska številka je obvezna.', 400)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Neveljaven e-poštni naslov.', 400)
  if (!Number.isFinite(partySize) || partySize < policy.minParty || partySize > policy.maxParty) {
    return fail(`Število oseb mora biti med ${policy.minParty} in ${policy.maxParty}.`, 400)
  }

  // ── STROGA terminska validacija (isti motor kot plošča) ──
  const now = new Date()
  const [rows, specials, seats] = await Promise.all([
    openingRowsFor(widget.locationId),
    specialsFor(widget.locationId, date, date),
    tableSeatsFor(widget.locationId),
  ])
  // v1.158.0: zasedenost se gleda za CELOTEN izbrani dan, ne za okno
  // [now, now+24h] — prihodnji datumi so sicer videli prazno kapaciteto
  // (prekomerno rezerviranje).
  const { start: dayStart, end: dayEnd } = dayBoundsUtc(date, timezone)
  const reservations = await activeReservationsFor(widget.locationId, dayStart, dayEnd)
  const hours: DayHoursInput = { rows, specials }
  const slotCheck = validateSlot(policy, hours, date, time, partySize, now, reservations, seats, timezone)
  if (!slotCheck.ok) return fail(slotCheck.message, 409)

  // ── replay + ustvarjanje POD ZAKLEPOM lokacije ──
  // Preverba zgoraj je hitra pot za jasno sporočilo. Odloča ponovna preverba
  // znotraj transakcije, kjer UPSERT na vrstico Counterja drži zaklep do
  // commita: dve sočasni zahtevi ne moreta obe videti istega prostega termina.
  // (Prej je bil 409 ob sočasnosti le komentar — obe zahtevi sta ustvarili.)
  const replayWindowStart = new Date(now.getTime() - 2 * 60_000)
  type ReservationRow = { id: string; dateTime: Date; partySize: number; status: string }
  let outcome:
    | { kind: 'replay'; row: ReservationRow }
    | { kind: 'taken'; message: string }
    | { kind: 'created'; row: ReservationRow; start: Date }
  try {
    outcome = await db.$transaction(async (tx) => {
      await lockReservationCapacity(tx, widget.locationId)

      // replay (dvojni klik): isti telefon + isti termin + nedavno ustvarjena
      const replay = await tx.reservation.findFirst({
        where: {
          locationId: widget.locationId,
          customerPhone: phone,
          status: 'confirmed',
          dateTime: slotCheck.start,
          createdAt: { gte: replayWindowStart },
        },
        orderBy: { createdAt: 'desc' },
      })
      if (replay) return { kind: 'replay' as const, row: replay }

      const fresh = await activeReservationsFor(widget.locationId, dayStart, dayEnd, tx)
      const recheck = validateSlot(policy, hours, date, time, partySize, new Date(), fresh, seats, timezone)
      if (!recheck.ok) return { kind: 'taken' as const, message: recheck.message }

      // kanonični model — isti vir kot interni POS
      const row = await tx.reservation.create({
        data: {
          id: nid(),
          customerName: name,
          customerPhone: phone,
          customerEmail: email,
          dateTime: recheck.start,
          partySize,
          duration: 120,
          status: 'confirmed',
          source: 'website',
          notes: 'Spletna rezervacija',
          specialRequests: note,
          confirmedAt: now,
          locationId: widget.locationId,
        },
      })
      return { kind: 'created' as const, row, start: recheck.start }
    })
  } catch {
    return fail('Termin je žal pravkar zasedel drug gost. Izberite drug termin.', 409)
  }

  if (outcome.kind === 'replay') {
    return ok({
      replayed: true,
      reservation: {
        id: outcome.row.id,
        dateTime: outcome.row.dateTime,
        partySize: outcome.row.partySize,
        status: outcome.row.status,
      },
    })
  }
  if (outcome.kind === 'taken') return fail(outcome.message, 409)

  const row = outcome.row
  const start = outcome.start

  // audit (tamper-evident veriga — isti vzorec kot GUEST_ORDER_CREATED)
  await writeAudit(db, {
    userId: null,
    action: 'GUEST_RESERVATION_CREATED',
    entityType: 'Reservation',
    entityId: row.id,
    details: jstr({ vir: 'widget', termin: start.toISOString(), oseb: partySize, ime: name, telefon: phone }),
    ipAddress: ip,
    locationId: widget.locationId,
  }).catch(() => {})

  // push natakarjem/vodstvu (obstoječi tip RESERVATION_NEW — isti vizual kot interni)
  void pushEvent('RESERVATION_NEW', {
    title: 'Nova spletna rezervacija',
    body: `${name} · ${start.toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${partySize} oseb`,
    url: '/dashboard?tab=rezervacije',
    tag: `reservation-${row.id}`,
  }, { roles: ['waiter', 'manager'], locationId: widget.locationId }).catch(() => {})

  // potrditev gostu — fail-soft, NE blokira odgovora
  const loc = await db.location.findUnique({ where: { id: widget.locationId }, select: { locale: true } })
  void sendBookingConfirmation({
    guestName: name, restaurantName, when: start, partySize, email: email || null, phone,
  }, loc?.locale ?? null, widget.locationId).catch(() => {})

  return ok({
    replayed: false,
    reservation: {
      id: row.id,
      dateTime: row.dateTime,
      partySize: row.partySize,
      status: row.status,
    },
  }, 201)
}
