/**
 * P1 #8 (v1.190.0) — lastni spletni portal za naročila (/s/<token>): DB plast.
 *
 * Ločitev odgovornosti (vzorec reservation-widget.ts / guest.ts):
 *  - ČISTI deli (token, politika, HMAC sledenja, odprto/zaprto) so testno
 *    pokriti brez DB (tests/v190-web-portal.test.ts),
 *  - TA modul nosi DB dostop: reševanje tokena, nalaganje urnika dneva,
 *    get-or-create konfiguracije.
 *
 * Varnostna pravila (enaka kot QR meni / paylink / rezervacijski widget):
 *  - Token JE skrivnost (32 hex) — gost pošlje SAMO token; lokacija/urnik/
 *    politika se rešijo strežniško. Rotacija = revokacija stare povezave.
 *  - Javno sledenje statusa: orderNumber je majhen števec (uganjljiv), zato
 *    gost dobi trackKey = HMAC-SHA256(trackSecret, orderNumber) — brez
 *    dodatnih stolpcev na Order; brez skrivnosti je odgovor 404 (ne razkriva
 *    obstoja naročila). Rotacija tokena trackSecret NE SPREMENI (sledenje
 *    tekočega naročila preživi rotacijo povezave).
 *  - Cene/opcije se rešijo iz DB (resolveGuestItems) — client cena ni zaupan.
 *  - Dostavna pristojbina in minimalni znesek sta politika LOKACIJE (row) —
 *    client jih ne more nastaviti.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { nid, num } from '@/lib/map'
import { zonedDateParts, localDateKey } from '@/lib/haccp-ops'
import { parseHHMM, type OpeningRow, type SpecialDay } from '@/lib/openinghours'

/** 32-hex skrivnost javne povezave (isti generator kot QR/paylink/widget). */
export function newPortalToken(): string {
  return crypto.randomBytes(16).toString('hex')
}

/** 64-hex skrivnost HMAC-a javnega sledenja (samo strežnik jo ima). */
export function newTrackSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}

// ---------- Politika portala (obrambna normalizacija, vzorec widgetPolicyOf) ----------
export interface PortalPolicy {
  pickupEnabled: boolean
  deliveryEnabled: boolean
  deliveryFee: number
  minOrder: number
  prepMinutes: number
  note: string
}

export const PORTAL_POLICY_DEFAULTS = { prepMinutes: 20 }

function clampNum(v: number, lo: number, hi: number, dflt: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < lo || n > hi) return dflt
  return n
}

/** Politika s zajetimi mejami (pisanje prek nastavitev že validira — tu je
 * obrambna normalizacija za vrstice, ki bi jih kdajkoli pisal kdo drug). */
export function portalPolicyOf(w: {
  pickupEnabled: boolean
  deliveryEnabled: boolean
  deliveryFee: number | bigint | { toNumber: () => number } | null
  minOrder: number | bigint | { toNumber: () => number } | null
  prepMinutes: number
  note: string
}): PortalPolicy {
  return {
    pickupEnabled: Boolean(w.pickupEnabled),
    deliveryEnabled: Boolean(w.deliveryEnabled),
    deliveryFee: clampNum(num(w.deliveryFee), 0, 50, 0),
    minOrder: clampNum(num(w.minOrder), 0, 500, 0),
    prepMinutes: clampNum(Math.round(Number(w.prepMinutes)), 5, 180, PORTAL_POLICY_DEFAULTS.prepMinutes),
    note: String(w.note || '').slice(0, 300),
  }
}

// ---------- Javno sledenje statusa (HMAC — brez dodatnih stolpcev na Order) ----------
export function trackKeyOf(secret: string, orderNumber: number): string {
  if (!secret) return ''
  return crypto.createHmac('sha256', secret).update(`order:${Math.round(orderNumber)}`).digest('hex').slice(0, 32)
}

/** Timing-safe primerjava (isti vzorec kot delivery.verifyWebhookSignature). */
export function verifyTrackKey(secret: string, orderNumber: number, key: string): boolean {
  const expected = trackKeyOf(secret, orderNumber)
  if (!expected || !key || key.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(String(key))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- Reševanje javnega tokena ----------
export interface PortalRow {
  id: string
  locationId: string
  token: string
  enabled: boolean
  pickupEnabled: boolean
  deliveryEnabled: boolean
  deliveryFee: number
  minOrder: number
  prepMinutes: number
  note: string
  trackSecret: string
}

/** Reši javni token → konfiguracija portala (+ ime/urnik lokacije). Vrne null,
 * če token ne obstaja, je izklopljen ali lokacija neaktivna. */
export async function resolvePortalToken(token: string): Promise<{ portal: PortalRow; restaurantName: string; timezone: string } | null> {
  if (!token || token.length < 16 || !/^[a-f0-9]+$/i.test(token)) return null
  const row = await db.webOrderPortal.findUnique({ where: { token } })
  if (!row || !row.enabled) return null
  const loc = await db.location.findUnique({ where: { id: row.locationId }, select: { name: true, timezone: true, isActive: true } })
  if (!loc || !loc.isActive) return null
  return {
    portal: {
      id: row.id,
      locationId: row.locationId,
      token: row.token,
      enabled: row.enabled,
      pickupEnabled: row.pickupEnabled,
      deliveryEnabled: row.deliveryEnabled,
      deliveryFee: num(row.deliveryFee),
      minOrder: num(row.minOrder),
      prepMinutes: row.prepMinutes,
      note: row.note,
      trackSecret: row.trackSecret,
    },
    restaurantName: loc.name,
    timezone: loc.timezone || 'Europe/Ljubljana',
  }
}

// ---------- Odprto/zaprto (urnik lokacije; čist del je testno pokrit) ----------

/** Lokalni deli trenutka v pasu lokacije (brez DB — čista funkcija spodaj). */
export interface LocalNowParts {
  /** 0 = nedelja … 6 = sobota (kot OpeningRow.dayOfWeek) */
  weekday: number
  /** minute od polnoči (0–1439) */
  minutes: number
  /** YYYY-MM-DD v pasu lokacije */
  dateKey: string
}

export type OpenState = 'open' | 'closed' | 'unknown'

/**
 * Čisti gate urnika: special overrides tedensko vrstico; prekoračitev polnoči
 * (close ≤ open) je odprta čez polnoč; odmor zapre okno. 'unknown' = za ta
 * dan NI konfiguracije — klicatelj sam odloči (ruta NE blokira naročil, ker
 * nekonfiguriran urnik ne sme blokirati prodaje; pošteno ne lažemo "odprto").
 */
export function openStateAt(rows: OpeningRow[], specials: SpecialDay[], parts: LocalNowParts): OpenState {
  // 1) posebni dan prevlada (npr. praznik)
  const special = specials.find((s) => s.date === parts.dateKey)
  if (special) {
    if (special.isClosed) return 'closed'
    const o = parseHHMM(special.openTime)
    const c = parseHHMM(special.closeTime)
    if (o == null || c == null) return 'unknown'
    if (c <= o) return parts.minutes >= o || parts.minutes <= c ? 'open' : 'closed'
    return parts.minutes >= o && parts.minutes < c ? 'open' : 'closed'
  }

  // 2) tedenska vrstica
  const row = rows.find((r) => r.dayOfWeek === parts.weekday)
  if (!row) return 'unknown'
  if (row.isClosed) return 'closed'
  const o = parseHHMM(row.openTime)
  const c = parseHHMM(row.closeTime)
  if (o == null || c == null) return 'unknown'

  // odmor (samo tedenska vrstica ga ima)
  const b0 = row.breakStart ? parseHHMM(row.breakStart) : null
  const b1 = row.breakEnd ? parseHHMM(row.breakEnd) : null
  const inBreak = b0 != null && b1 != null && b1 > b0 && parts.minutes >= b0 && parts.minutes < b1

  if (c <= o) {
    // prekoračitev polnoči: break se ne upošteva čez dva dneva (honest preprostost)
    return !inBreak && (parts.minutes >= o || parts.minutes <= c) ? 'open' : 'closed'
  }
  return !inBreak && parts.minutes >= o && parts.minutes < c ? 'open' : 'closed'
}

/** Tedenske vrstice lokacije (ali org default locationId=null). */
export async function openingRowsFor(locationId: string): Promise<OpeningRow[]> {
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

/** Posebni dnevi okoli datuma (isti vzorec kot reservation-widget.specialsFor). */
export async function specialsFor(locationId: string, dateKey: string): Promise<SpecialDay[]> {
  const rows = await db.specialOpeningDay.findMany({ where: { date: dateKey, OR: [{ locationId }, { locationId: null }] } })
  return rows.map((r) => ({ date: r.date, isClosed: r.isClosed, openTime: r.openTime, closeTime: r.closeTime, note: r.note }))
}

/** DB vstop v čisti gate: urnik + posebni dan za ZDAJ v pasu lokacije. */
export async function openStateNow(locationId: string, timezone: string, now = new Date()): Promise<OpenState> {
  const parts = zonedDateParts(now, timezone)
  const dateKey = localDateKey(parts)
  const [rows, specials] = await Promise.all([openingRowsFor(locationId), specialsFor(locationId, dateKey)])
  const weekday = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay()
  return openStateAt(rows, specials, { weekday, minutes: parts.hh * 60 + parts.mm, dateKey })
}

// ---------- Get-or-create (nastavitvena ruta) ----------
export async function getOrCreatePortal(locationId: string) {
  const existing = await db.webOrderPortal.findUnique({ where: { locationId } })
  if (existing) return existing
  return db.webOrderPortal.create({
    data: { id: nid(), locationId, token: newPortalToken(), trackSecret: newTrackSecret() },
  })
}
