/**
 * v1.240.0 (PRIMERJAVA-VMESNIKOV-2026 §16 E, B-načrt 2) — REZERVACIJSKA CELICA:
 * skupni strežniški varovalec zasedenosti mize (assertTableClaimable).
 *
 * NAJDBA (raziskava §16 E): trije klicatelji so vsak po svoje odločali, ali je
 * miza "prosta" — in vsak je gledal le del resnice:
 *  1. POST /api/reservations je varoval SAMO identičen časovni žig
 *     (@@unique [tableId, dateTime]): rezervacija 19:00 (120 min) in 20:00 na
 *     isti mizi sta obe uspeli — UI (autoAssignTable) je prekrivanje znal
 *     preskočiti, strežnik pa ne (»pomoč pri izbiri, ne obveza«).
 *  2. usaditev čakalne vrste (PATCH /api/waitlist → seated) je gledala SAMO
 *     Table.status === 'occupied' — miza z rezervacijo, ki se začne čez 30 min,
 *     je bila "prosta": čakalna vrsta jo je zasedla in povozila rezervacijo.
 *  3. PATCH /api/tables/[id] je dovolil KATERIKOLI status brez varovalca —
 *     natakar je lahko "zasedel" mizo z dejavno rezervacijo, ne da bi kdo
 *     videl konflikt.
 *
 * REŠITEV: ena funkcija, ena resnica. assertTableClaimable preveri VSE tri
 * plasti zasedenosti:
 *  (a) fizična — Table.status === 'occupied' (usajen gost / odprto naročilo);
 *  (b) rezervacijska — DEJAVNA rezervacija (confirmed/seated/completed;
 *      cancelled/no_show ne zavirata — usklajeno z UI autoAssign), katere
 *      interval [dateTime, dateTime+duration) se prekriva z oknom zahteve
 *      [at, at+durationMin);
 *  (c) pripadnost — miza mora biti iz pričakovane lokacije (409, ne ugibanja).
 *
 * Okno zahteve je namerno enako standardnemu obratu mize (CLAIM_WINDOW_MIN =
 * 120, isti vir kot PUBLIC_RESERVATION_DURATION_MIN): gost, ki danes seda,
 * drži mizo eno jed — rezervacija, ki se začne znotraj tega okna, je konflikt.
 *
 * DIALEKT: branje je prek Prisma (PG + SQLite enako); zaklep klicateljev je
 * lockReservationCapacity (UPSERT na Counter — vzorec v1.158.0), ki serializira
 * vse ustvarjalce rezervacij na lokaciji do konca transakcije.
 */

import type { Prisma } from '@prisma/client'
import type { ReservationStatus } from './prisma-types'
import { intervalsOverlap } from './reservation-slots'

/** Standardni obrat mize (min) — okno, ki ga zahteva usaditev / zasedenost. */
export const CLAIM_WINDOW_MIN = 120

/** Statusi rezervacije, ki ZAVIRAJO claim (usklajeno z UI autoAssignTable:
 *  CONFIRMED/SEATED/COMPLETED zavirajo; CANCELLED/NO_SHOW ne). Tip je
 *  ReservationStatus[] — produkcijski (Postgres) Prisma klient zahteva
 *  enumski tip v `status: { in: [...] }` (SQLite zrcalo je popustljivejše,
 *  zato je napako videl šele typecheck-prod v CI, run 41629558664). */
export const CLAIM_BLOCKING_STATUSES: readonly ReservationStatus[] = ['confirmed', 'seated', 'completed']

/** Dejavna rezervacija na mizi (konflikt za okno zahteve). */
export interface TableReservationConflict {
  reservationId: string
  guestName: string
  start: Date
  end: Date
}

export interface ClaimCheck {
  tableId: string
  /** pričakovana lokacija mize (null = brez preverjanja — obstoječa raven) */
  expectLocationId?: string | null
  /** trenutek zahteve (usaditev: now; nova rezervacija: dateTime) */
  at: Date
  /** kako dolgo bo gost držal mizo (min) */
  durationMin: number
  /** rezervacija, ki JO uvajamo — njeno okno ne šteje kot konflikt
   *  (prehod SEATED na lastni rezervaciji, usaditev waitlist vnosa, ki je
   *  povezan z rezervacijo prek WaitlistEntry.reservationId) */
  excludeReservationId?: string
}

export type ClaimResult =
  | { ok: true; table: { id: string; number: number; status: string; locationId: string } }
  | { ok: false; code: 'not_found' | 'wrong_location' | 'occupied' | 'reservation_conflict'; message: string; conflict?: TableReservationConflict }

/** Minimalna oblika transakcijskega odjemalca (db ali tx — isti vir). */
type ClaimClient = Pick<Prisma.TransactionClient, 'table' | 'reservation'>

/**
 * Poisci prvo DEJAVNO rezervacijo na mizi, ki se prekriva z oknom
 * [at, at+durationMin). Okno branja je razširjeno za ±24 h, da zajame
 * dolga trajanja in čezpolnočne termine (ista logika kot
 * activeReservationsFor v reservation-widget.ts).
 */
export async function findTableReservationConflict(
  client: ClaimClient,
  check: ClaimCheck,
): Promise<TableReservationConflict | null> {
  const atMs = check.at.getTime()
  const durMs = Math.max(15, check.durationMin) * 60_000
  const rows = await client.reservation.findMany({
    where: {
      // v1.245.0 (PRIMERJAVA §19): miza je zasedena, če jo drži rezervacija
      // KOT PRIMARNA (tableId) ali KOT ČLANICA kombinacije (comboTableIds
      // ',id1,id2,' — contains z ločili preprečuje prefix trke id-jev).
      // Prazen comboTableIds (obstoječe enojne rezervacije) se ne primerja.
      OR: [
        { tableId: check.tableId },
        { comboTableIds: { contains: `,${check.tableId},` } },
      ],
      status: { in: [...CLAIM_BLOCKING_STATUSES] },
      dateTime: { gte: new Date(atMs - 24 * 3600_000), lte: new Date(atMs + durMs + 24 * 3600_000) },
      ...(check.excludeReservationId ? { id: { not: check.excludeReservationId } } : {}),
    },
    select: { id: true, customerName: true, dateTime: true, duration: true },
    orderBy: { dateTime: 'asc' },
    take: 50,
  })
  for (const r of rows) {
    const rs = r.dateTime.getTime()
    const re = rs + Math.max(15, r.duration || 120) * 60_000
    if (intervalsOverlap(atMs, atMs + durMs, rs, re)) {
      return { reservationId: r.id, guestName: r.customerName, start: r.dateTime, end: new Date(re) }
    }
  }
  return null
}

/** Človeško berljiv interval "19:00–21:00" (lokalni pas strežnika). */
export function claimConflictMessage(tableNumber: number, c: TableReservationConflict): string {
  const fmt = (d: Date) => d.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
  return `Miza ${tableNumber} ima v tem času rezervacijo: ${c.guestName}, ${fmt(c.start)}–${fmt(c.end)}.`
}

/**
 * Skupni varovalec: ali lah gost ZASEDE mizo v oknu [at, at+durationMin)?
 * Vrača { ok, table } ali { ok: false, code, message } — klicatelj preslika
 * v HTTP (404/409) po svoji semantiki. Fizično zasedeno (occupied) vrača kot
 * konflikt; klicatelj, ki poleg tega drži pogojni updateMany zaklep (waitlist
 * seat, reservation SEATED), ima to kot zadnjo obrambo pred raco.
 */
export async function assertTableClaimable(
  client: ClaimClient,
  check: ClaimCheck,
): Promise<ClaimResult> {
  const table = await client.table.findUnique({
    where: { id: check.tableId },
    select: { id: true, number: true, status: true, locationId: true },
  })
  if (!table) return { ok: false, code: 'not_found', message: 'Miza ne obstaja.' }
  if (check.expectLocationId && table.locationId !== check.expectLocationId) {
    return { ok: false, code: 'wrong_location', message: 'Miza ne pripada pričakovani lokaciji.' }
  }
  if (table.status === 'occupied') {
    return { ok: false, code: 'occupied', message: `Miza ${table.number} je že zasedena — izberi drugo mizo.` }
  }
  const conflict = await findTableReservationConflict(client, check)
  if (conflict) {
    return { ok: false, code: 'reservation_conflict', message: claimConflictMessage(table.number, conflict), conflict }
  }
  return { ok: true, table }
}
