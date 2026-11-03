/**
 * v1.244.0 (PRIMERJAVA-VMESNIKOV-2026 §18 A) — RITEM PRIHODOV (arrival pacing).
 *
 * Industrijska referenca: Lightspeed Tempo / »Arrival Pacing« (april 2026 —
 * »Max guests arriving within 30 minutes«) in Toast table management —
 * kuhinja ima konično propustnost; rezervacijski sistem, ki dovoli 5× party
 * of 8 v istem polurnem oknu (telefonske rezervacije!), jo preobremeni.
 *
 * NAČELO: javni widget že ima STROGO terminsko politiko (maxCoversPerSlot na
 * mreži slotMinutes + leadMinutes — v1.110.0), INTERNA pot (telefon/walk-in
 * iz dashboarda) pa je šla čez zgolj odpiralni čas + zasedenost mize (§16 G
 * v1.240.0). Ta modul je SKUPNI strežniški varovalec ritma: največ gostov,
 * ki pridejo v fiksnem oknu (privzeto 30 min), po lokaciji.
 *
 * KONFIGURACIJA: Integration vrstica name='resv-pacing-config', type='other',
 * locationId = lokacija (ISTI vzorec kot auto86-config v1.230.0 — 0 DDL;
 * razlika: pacing je PER LOKACIJA, avto-86 je globalen).
 *
 * SEMANTIKA OKNA: fiksni košarki, poravnani na uro (12:00–12:30, 12:30–13:00 …).
 * Implementacija: epoch floor na mrežo windowMin — za 30/15/60 min in celourni
 * časovni pas (Europe/Ljubljana = UTC+1/+2) se košarka poravnajo natanko na
 * :00/:30 lokalno. Deterministično, brez odvisnosti od pasu strežnika.
 *
 * ŠTEJO SE: confirmed + seated z dateTime ZNOTRAJ košarka (gosti, ki PRIHAJAJO
 * oz. so ravno prispeli — enaka statusna množica kot activeReservationsFor v
 * reservation-widget.ts). completed gostje so že odšli (ne obremenjujejo
 * kuhinje ob prihodu), cancelled/no_show ne pridejo.
 *
 * PREGLAS: interna pot lahko varovalo preglasi (forcePacing — isti vzorec kot
 * allowOutsideHours: 409 { overrideRequired: true } → UI ponudi potrditev →
 * revizija RESERVATION_PACING_OVERRIDE). JAVNA pot NE more preglasiti — gost
 * izbere drug termin.
 */

import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'

/** Marker Integration vrstice s konfiguracijo (per lokacija). */
export const PACING_CONFIG_MARKER = 'resv-pacing-config'

/** Kanonična oblika konfiguracije (fiksni nabor polj — odgovor API vedno isti). */
export interface PacingConfig {
  /** Varovalo vklopljeno (brez vrstice = IZKLOP — obstoječe lokacije nespremenjene). */
  enabled: boolean
  /** Širina okna v minutah (10–120, privzeto 30). */
  windowMin: number
  /** Največ gostov, ki smejo priti v enem oknu (1–500; 0 = brez omejitve). */
  maxGuests: number
}

/** Privzeta konfiguracija (vrstice še ni): izklopljeno, 30-min okno. */
export const DEFAULT_PACING_CONFIG: PacingConfig = { enabled: false, windowMin: 30, maxGuests: 0 }

/** Statusi, ki štejejo v okno prihodov (glej komentar zgoraj). */
export const PACING_COUNTED_STATUSES = ['confirmed', 'seated'] as const

/** Minimalna oblika odjemalca za branje konfiguracije (db ali transakcija). */
type PacingReader = Pick<Prisma.TransactionClient, 'integration'>

/** Obrambna normalizacija (pisanje prek API že validira — tu za vrstice, ki bi
 * jih kdajkoli pisal kdo drug; isti vzorec kot widgetPolicyOf). Prejme TUDI
 * JSON niz (Integration.config je Json polje — vrednost, zapisana prek
 * JSON.stringify, se prebere kot string; vzorec parseAuto86Config/jparse). */
export function parsePacingConfig(raw: unknown): PacingConfig {
  const parsed = jparse<unknown>(raw, null)
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n < lo || n > hi) return dflt
    return n
  }
  return {
    enabled: o.enabled === true,
    windowMin: clamp(o.windowMin, 10, 120, DEFAULT_PACING_CONFIG.windowMin),
    maxGuests: clamp(o.maxGuests, 0, 500, DEFAULT_PACING_CONFIG.maxGuests),
  }
}

/** Prebere konfiguracijo pacanja za lokacijo (brez vrstice → privzeta). */
export async function loadPacingConfig(client: PacingReader, locationId: string): Promise<PacingConfig> {
  const row = await client.integration.findFirst({
    where: { name: PACING_CONFIG_MARKER, type: 'other', locationId },
    select: { config: true },
  })
  return parsePacingConfig(row?.config)
}

/** Začetek fiksnega okna, v katerega pade `when` (epoch mreža windowMin). */
export function pacingWindowStart(when: Date, windowMin: number): Date {
  const ms = Math.max(1, Math.round(windowMin)) * 60_000
  return new Date(Math.floor(when.getTime() / ms) * ms)
}

/** Slovenska oznaka ure HH:MM iz UTC datuma v lokalnem pasu strežnika. */
function hhmm(d: Date): string {
  return d.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
}

/** Izid preverbe ritma (null = varovalo izklopljeno / brez omejitve). */
export interface PacingCheck {
  windowStart: Date
  windowEnd: Date
  currentGuests: number
  /** Gosti SKUPAJ s prihajajočo rezervacijo (current + partySize). */
  totalGuests: number
  maxGuests: number
  message: string
}

/**
 * Strežniški varovalec ritma prihodov — kliče se ZNOTRAJ transakcije pod
 * zaklepom lockReservationCapacity (serijski dostop do števca okna; isti
 * vzorec kot findTableReservationConflict v table-claim.ts).
 *
 * Vrne null, če je varovalo izklopljeno ali maxGuests == 0 (običajna pot).
 * Vrne PacingCheck (message = strežniška SL za 409), če bi nova rezervacija
 * presegla omejitev okna.
 */
export async function assertArrivalPacing(
  tx: Pick<Prisma.TransactionClient, 'reservation'>,
  locationId: string,
  when: Date,
  partySize: number,
  config: PacingConfig,
): Promise<PacingCheck | null> {
  if (!config.enabled || config.maxGuests <= 0) return null
  if (!Number.isFinite(when.getTime())) return null
  const windowStart = pacingWindowStart(when, config.windowMin)
  const windowEnd = new Date(windowStart.getTime() + config.windowMin * 60_000)
  const agg = await tx.reservation.aggregate({
    where: {
      locationId,
      status: { in: [...PACING_COUNTED_STATUSES] },
      dateTime: { gte: windowStart, lt: windowEnd },
    },
    _sum: { partySize: true },
  })
  const currentGuests = Math.max(0, Math.floor(agg._sum.partySize ?? 0))
  const totalGuests = currentGuests + Math.max(0, Math.round(partySize || 0))
  if (totalGuests <= config.maxGuests) return null
  return {
    windowStart,
    windowEnd,
    currentGuests,
    totalGuests,
    maxGuests: config.maxGuests,
    message:
      `Ritem prihodov: med ${hhmm(windowStart)} in ${hhmm(windowEnd)} prihaja že ${currentGuests} gostov ` +
      `(omejitev ${config.maxGuests}). Izberite drug termin ali preglasite varovalo.`,
  }
}

/* ── ČISTA agregacija za UI (§18 D — pričakovani gostje čez dan) ────────── */

/** Vrstica povzetka pokritosti enega okna (izrisek v zavihku Rezervacije). */
export interface CoversSlot {
  /** ISO začetek okna. */
  start: string
  /** HH:MM lokalno (izračun na klientu iz start — prikaz takoj). */
  guests: number
  /** Število rezervacij v oknu. */
  count: number
}

/**
 * Porazdeli rezervacije dneva po fiksnih oknih (ista mreža kot varovalo —
 * ena resnica o »oknu prihodov«). Čista funkcija: vhod so že filtrirane
 * (CONFIRMED+SEATED) rezervacije izbranega dne, izhod urejen po času.
 * Prazna okna se NE izrisujejo (call-site filtrira guests > 0).
 */
export function coversByWindow(
  reservations: { reservedAt: string; guests: number }[],
  windowMin: number,
): CoversSlot[] {
  const ms = Math.max(1, Math.round(windowMin)) * 60_000
  const buckets = new Map<number, CoversSlot>()
  for (const r of reservations) {
    const at = new Date(r.reservedAt).getTime()
    if (!Number.isFinite(at)) continue
    const key = Math.floor(at / ms) * ms
    const cur = buckets.get(key) ?? { start: new Date(key).toISOString(), guests: 0, count: 0 }
    cur.guests += Math.max(0, Math.round(r.guests || 0))
    cur.count += 1
    buckets.set(key, cur)
  }
  return [...buckets.values()].sort((a, b) => a.start.localeCompare(b.start))
}

/** Kanonična referenca na db (uvoz testom/reputaciji — en sam vir). */
export const pacingDb = db
