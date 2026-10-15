/**
 * Issue #13 (P1/P2, v1.110.0) — javni rezervacijski widget: DB plast.
 *
 * Ločitev odgovornosti (vzorec guest.ts / haccp-ops.ts):
 *  - reservation-slots.ts = ČISTI motor (brez DB, testno pokrit)
 *  - TA modul = DB dostop: reševanje tokena, nalaganje konteksta dneva
 *    (urnik, posebni dnevi, dejavne rezervacije, sedeži miz), get-or-create
 *    konfiguracije, normalizacija politike.
 *
 * Varnostna pravila (enaka kot QR meni / paylink):
 *  - Token JE skrivnost (32 hex) — gost pošlje SAMO token; lokacija/urnik/
 *    kapaciteta se rešijo strežniško. Rotacija = revokacija stare povezave.
 *  - Javni odgovori ne izdajejo PII drugih gostov (samo agregati).
 */

import crypto from 'crypto'
import { db } from '@/lib/db'
import { nid } from '@/lib/map'
import {
  WIDGET_POLICY_DEFAULTS,
  slotsForDate,
  type WidgetPolicy,
  type DayHoursInput,
  type ExistingReservation,
  type SlotsForDateResult,
} from './reservation-slots'

export type ReservationWidgetRow = {
  id: string
  locationId: string
  token: string
  enabled: boolean
  slotMinutes: number
  minParty: number
  maxParty: number
  leadMinutes: number
  maxAdvanceDays: number
  maxCoversPerSlot: number
}

/** 32-hex skrivnost (isti generator kot QR/paylink). */
export function newWidgetToken(): string {
  return crypto.randomBytes(16).toString('hex')
}

/** Reši javni token → konfiguracija widgeta (+ ime lokacije). Vrne null, če
 * token ne obstaja, je izklopljen ali oblike, ki je ne sprejemamo. */
export async function resolveWidgetToken(token: string): Promise<{ widget: ReservationWidgetRow; restaurantName: string; timezone: string } | null> {
  if (!token || token.length < 16 || !/^[a-f0-9]+$/i.test(token)) return null
  const widget = await db.reservationWidget.findUnique({ where: { token } })
  if (!widget || !widget.enabled) return null
  const loc = await db.location.findUnique({ where: { id: widget.locationId }, select: { name: true, timezone: true, isActive: true } })
  if (!loc || !loc.isActive) return null
  return {
    widget: widget as unknown as ReservationWidgetRow,
    restaurantName: loc.name,
    timezone: loc.timezone || 'Europe/Ljubljana',
  }
}

/** Politika s zajetimi mejami (pisanje prek nastavitev že validira — tu je
 * obrambna normalizacija za vrstice, ki bi jih kdajkoli pisal kdo drug).
 * Sprejme vsako strukturo s številskimi polji politike (tudi brez tokena). */
export function widgetPolicyOf(w: {
  slotMinutes: number
  minParty: number
  maxParty: number
  leadMinutes: number
  maxAdvanceDays: number
  maxCoversPerSlot: number
}): WidgetPolicy {
  const clamp = (v: number, lo: number, hi: number, dflt: number) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n < lo || n > hi) return dflt
    return n
  }
  return {
    slotMinutes: clamp(w.slotMinutes, 5, 240, WIDGET_POLICY_DEFAULTS.slotMinutes),
    minParty: clamp(w.minParty, 1, 40, WIDGET_POLICY_DEFAULTS.minParty),
    maxParty: clamp(w.maxParty, 1, 40, WIDGET_POLICY_DEFAULTS.maxParty),
    leadMinutes: clamp(w.leadMinutes, 0, 1440, WIDGET_POLICY_DEFAULTS.leadMinutes),
    maxAdvanceDays: clamp(w.maxAdvanceDays, 1, 365, WIDGET_POLICY_DEFAULTS.maxAdvanceDays),
    maxCoversPerSlot: clamp(w.maxCoversPerSlot, 0, 500, WIDGET_POLICY_DEFAULTS.maxCoversPerSlot),
  }
}

/** Tedenske vrstice lokacije (ali org default locationId=null) — surove
 * OpeningRow oblike za motor. */
export async function openingRowsFor(locationId: string): Promise<DayHoursInput['rows']> {
  let rows = await db.openingHours.findMany({ where: { locationId }, orderBy: { dayOfWeek: 'asc' } })
  if (rows.length === 0) rows = await db.openingHours.findMany({ where: { locationId: null }, orderBy: { dayOfWeek: 'asc' } })
  return rows.map((r) => ({
    dayOfWeek: r.dayOfWeek,
    openTime: r.openTime,
    closeTime: r.closeTime,
    breakStart: r.breakStart,
    breakEnd: r.breakEnd,
    isClosed: r.isClosed,
  }))
}

/** Posebni dnevi okoli datuma (lokalni + org default; lokacija ima prednost). */
export async function specialsFor(locationId: string, fromKey: string, toKey: string): Promise<DayHoursInput['specials']> {
  const rows = await db.specialOpeningDay.findMany({
    where: { date: { gte: fromKey, lte: toKey }, OR: [{ locationId }, { locationId: null }] },
    orderBy: { date: 'asc' },
  })
  const byDate = new Map<string, DayHoursInput['specials'][number] & { loc: string | null }>()
  for (const r of rows) {
    const prev = byDate.get(r.date)
    if (!prev || (prev.loc === null && r.locationId !== null)) {
      byDate.set(r.date, { date: r.date, isClosed: r.isClosed, openTime: r.openTime, closeTime: r.closeTime, note: r.note, loc: r.locationId })
    }
  }
  return [...byDate.values()].map(({ loc: _loc, ...s }) => s)
}

/** Dejavne rezervacije, ki lahko obsegajo termine na dan dateKey (confirmed +
 * seated; pretekla < današnji − 6 h ne more več obsegati prihodnjih terminov). */
export async function activeReservationsFor(locationId: string, dayStartUtc: Date, dayEndUtc: Date): Promise<ExistingReservation[]> {
  const rows = await db.reservation.findMany({
    where: {
      locationId,
      status: { in: ['confirmed', 'seated'] },
      dateTime: { gte: new Date(dayStartUtc.getTime() - 24 * 3600_000), lte: new Date(dayEndUtc.getTime() + 24 * 3600_000) },
    },
    select: { dateTime: true, duration: true, partySize: true, status: true },
    take: 500,
  })
  return rows.map((r) => ({ start: r.dateTime, durationMin: r.duration || 120, partySize: r.partySize, status: r.status }))
}

/** Seštevek sedežev vseh miz lokacije (fizikalna kapaciteta). */
export async function tableSeatsFor(locationId: string): Promise<number> {
  const agg = await db.table.aggregate({ where: { locationId }, _sum: { capacity: true } })
  return Math.max(0, Math.floor(agg._sum.capacity ?? 0))
}

/** Terminska plošča za javni GET — ena poizvedba vlakna. */
export async function publicSlotsForDate(
  widget: ReservationWidgetRow,
  restaurantName: string,
  timeZone: string,
  dateKey: string,
  now: Date,
): Promise<SlotsForDateResult> {
  const policy = widgetPolicyOf(widget)
  const [rows, specials, seats] = await Promise.all([
    openingRowsFor(widget.locationId),
    specialsFor(widget.locationId, dateKey, dateKey),
    tableSeatsFor(widget.locationId),
  ])
  const reservations = await activeReservationsFor(widget.locationId, new Date(now.getTime() - 6 * 3600_000), new Date(now.getTime() + 24 * 3600_000))
  return slotsForDate(policy, { rows, specials }, dateKey, now, reservations, seats, timeZone)
}

/** Get-or-create konfiguracije widgeta za lokacijo (token se izda ob prvem
 * stiku — nastavitvena ruta). Osveži tudi ROTACIJO tokena (rotate=true). */
export async function ensureWidget(locationId: string, rotate = false): Promise<ReservationWidgetRow> {
  const existing = await db.reservationWidget.findUnique({ where: { locationId } })
  if (existing && !rotate) return existing as unknown as ReservationWidgetRow
  if (existing && rotate) {
    const row = await db.reservationWidget.update({ where: { id: existing.id }, data: { token: newWidgetToken() } })
    return row as unknown as ReservationWidgetRow
  }
  const row = await db.reservationWidget.create({
    data: { id: nid(), locationId, token: newWidgetToken(), enabled: false },
  })
  return row as unknown as ReservationWidgetRow
}
