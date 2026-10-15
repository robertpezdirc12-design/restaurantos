/**
 * Issue #13 (P1/P2, v1.110.0) — javni rezervacijski widget (/r/<token>).
 *
 * Pokritost:
 *  A. MOTOR (čiste funkcije, reservation-slots.ts): terminska mreža (prvi/zadnji
 *     termin, korak), zaprt dan, poseben dan (zaprt + nadomestni urnik), odmor
 *     (celoten interval termina zunaj odmora), lead time, kapaciteta (obsežene
 *     confirmed/seated, cancelled NE šteje), prekrivnost intervalov, override
 *     maxCoversPerSlot, overnight urnik, fail-closed brez urnika, DST
 *     (CEST/CET oktobra 2026), validateSlot stroge poti, nextOpenDateKeys,
 *     publicSlotsPayload (brez PII).
 *  B. PLOŠČA (GET /api/public/reservations): napačen token 404, izklopljen 404,
 *     veljaven token → sloti + politika + ime, brez datuma → danes po pasu
 *     lokacije, rate limit 429.
 *  C. REZERVACIJA (POST): zlata pot 201 (source=website, status=confirmed,
 *     notes='Spletna rezervacija', audit GUEST_RESERVATION_CREATED), replay
 *     (isti telefon+termin ≤2 min → replayed:true, NI dvojnika), party zunaj
 *     meja 400, off-grid termin 409, zaseden termin 409 (kapaciteta), manjkajoč
 *     telefon 400, neveljaven e-mail 400, datum v preteklosti 409, izven
 *     maxAdvanceDays 409, rate limit 429.
 *  D. NASTAVITVE (GET/PUT/DELETE /api/reservations/widget): inicializacija
 *     (izda token + URL), GET ne razkrije tokena, RBAC (natakar 403 na PUT,
 *     manager vidi GET), rotacija = nov token (stari 404), validacije meja 400,
 *     izklop DELETE → 404 na javni poti, org scope (tuja lokacija 403).
 *  E. SWEEP + register + drift.
 *
 * Fiksture s predpono i13-. Hitrostni limiter se resetira med skupinami
 * (__resetRateLimitForTests — POST limit 5/min bi sicer zadušil teste).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import {
  slotsForDate, validateSlot, nextOpenDateKeys, publicSlotsPayload,
  intervalsOverlap, weekdayOf, WIDGET_POLICY_DEFAULTS,
  type WidgetPolicy, type DayHoursInput, type ExistingReservation,
} from '../src/lib/reservation-slots'
import { widgetPolicyOf, newWidgetToken } from '../src/lib/reservation-widget'
import { zonedDateParts, zonedTimeToUtc, localDateKey, type LocalDate } from '../src/lib/haccp-ops'
import { GET as publicGET, POST as publicPOST } from '../src/app/api/public/reservations/route'
import { GET as widgetGET, PUT as widgetPUT, DELETE as widgetDELETE } from '../src/app/api/reservations/widget/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-reservation-widget/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { classifyDrift, isReservationWidgetStatement } from '../scripts/drift-check'

const P = 'i13-'
const RUN = Date.now().toString(36)

let locA = ''
let locB = ''
let mgrAId = ''
let waiterAId = ''
let mgrBId = ''
let tokMgrA = ''
let tokMgrB = ''
let tokWaiterA = ''
let widgetToken = ''
const TZ = 'Europe/Ljubljana'

/** Dinamični datumi glede na REALNI čas (API uporablja new Date()):
 *  DATE = jutri v pasu lokacije, PAST = včeraj, FAR = +60 dni (maxAdvance 30). */
function keyOf(d: LocalDate): string { return localDateKey(d) }
function addDays(d: LocalDate, n: number): LocalDate {
  const dt = new Date(Date.UTC(d.y, d.m - 1, d.d + n))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}
const TODAY = zonedDateParts(new Date(), TZ)
const DATE = keyOf(addDays(TODAY, 1))
const PAST = keyOf(addDays(TODAY, -1))
const FAR = keyOf(addDays(TODAY, 60))

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(method: string, url: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

async function seedEmp(name: string, role: string, loc: string | null): Promise<{ id: string; pin: string }> {
  const id = `${P}${name}-${RUN}`
  const email = `${P}${name}-${RUN}@test.local`
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  await db.employee.create({
    data: { id, name: `${P}${name}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
  })
  return { id, pin }
}

async function newLoc(tag: string): Promise<string> {
  const id = `${P}loc${tag}-${RUN}`
  await db.location.create({ data: { id, code: `${P}L${tag}${RUN}`, name: `${P}Lok ${tag}`, premisesId: `${P}prem${tag}-${RUN}` } })
  return id
}

async function seedHours(loc: string, rows: DayHoursInput['rows']): Promise<void> {
  for (const r of rows) {
    await db.openingHours.create({ data: { id: `${P}oh-${loc.slice(-4)}-${r.dayOfWeek}-${RUN}`, dayOfWeek: r.dayOfWeek, openTime: r.openTime, closeTime: r.closeTime, breakStart: r.breakStart || '', breakEnd: r.breakEnd || '', isClosed: r.isClosed, locationId: loc } })
  }
}

async function seedTables(loc: string, seats: number[], prefix: string): Promise<void> {
  let n = 1
  for (const s of seats) {
    await db.table.create({ data: { id: `${P}tbl${prefix}-${n}-${RUN}`, number: n, capacity: s, locationId: loc } })
    n++
  }
}

/** Nedelja 15.11.2026 (prost terminski dan, stabilen UTC trenutek). */
const FUTURE_KEY = '2026-11-15'
/** Fiksni "now" za motor: ponedeljek 9.11.2026 10:00 UTC (11:00 CET). */
const NOW = new Date('2026-11-09T10:00:00Z')

const HOURS_ALL: DayHoursInput['rows'] = Array.from({ length: 7 }, (_, dow) => ({
  dayOfWeek: dow, openTime: '10:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false,
}))

const POLICY: WidgetPolicy = { ...WIDGET_POLICY_DEFAULTS }

beforeAll(async () => {
  __resetRateLimitForTests()
  locA = await newLoc('A')
  locB = await newLoc('B')
  mgrAId = (await seedEmp('mgrA', 'manager', locA)).id
  waiterAId = (await seedEmp('waiterA', 'waiter', locA)).id
  mgrBId = (await seedEmp('mgrB', 'manager', locB)).id
  tokMgrA = tok(mgrAId, `${P}mgrA`, 'MANAGER', locA)
  tokMgrB = tok(mgrBId, `${P}mgrB`, 'MANAGER', locB)
  tokWaiterA = tok(waiterAId, `${P}waiterA`, 'WAITER', locA)

  // inicializacija widgeta prek JAVNEGA settings tokov (PUT — hkrati test inicializacije)
  const res = await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrA, {
    locationId: locA, enabled: true, slotMinutes: 30, minParty: 1, maxParty: 8, leadMinutes: 0, maxAdvanceDays: 30,
  }))
  const j = await body(res)
  widgetToken = String(j.token || '')
  expect(widgetToken.length).toBe(32)
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})

/* ═══════════════ A. MOTOR — ČISTE FUNKCIJE ═══════════════ */

describe('A. terminski motor (reservation-slots.ts)', () => {
  it('A1: mreža — 10:00–22:00, slot 30 min, trajanje 120 → prvi 10:00, zadnji 20:00 (21 terminov)', () => {
    const r = slotsForDate(POLICY, { rows: HOURS_ALL, specials: [] }, FUTURE_KEY, NOW, [], 0, TZ)
    expect(r.open).toBe(true)
    expect(r.slots[0]?.time).toBe('10:00')
    expect(r.slots[r.slots.length - 1]?.time).toBe('20:00')
    expect(r.slots.length).toBe(21)
    expect(r.slots[1]?.time).toBe('10:30') // korak 30
  })

  it('A2: zaprt dan → open:false z imenom dneva v opombi', () => {
    const rows = HOURS_ALL.map((r) => ({ ...r, isClosed: true }))
    const r = slotsForDate(POLICY, { rows, specials: [] }, FUTURE_KEY, NOW, [], 0, TZ)
    expect(r.open).toBe(false)
    expect(r.slots.length).toBe(0)
    expect(r.note).toBe('Nedelja') // 15.11.2026 = nedelja (DAY_NAMES_SL)
  })

  it('A3: fail-closed — brez urnika ni terminov (javni gost ne vidi "vse prosto" brez podatka)', () => {
    const r = slotsForDate(POLICY, { rows: [], specials: [] }, FUTURE_KEY, NOW, [], 0, TZ)
    expect(r.open).toBe(false)
    expect(r.slots.length).toBe(0)
  })

  it('A4: poseben dan zaprt → open:false; poseben odprt urnik NADOMESTI tedenskega', () => {
    const closed = slotsForDate(POLICY, { rows: HOURS_ALL, specials: [{ date: FUTURE_KEY, isClosed: true, openTime: '', closeTime: '', note: 'zaprto za zasebno' }] }, FUTURE_KEY, NOW, [], 0, TZ)
    expect(closed.open).toBe(false)
    expect(closed.note).toBe('zaprto za zasebno')

    const special = slotsForDate(POLICY, { rows: HOURS_ALL, specials: [{ date: FUTURE_KEY, isClosed: false, openTime: '12:00', closeTime: '16:00', note: 'kraješi urnik' }] }, FUTURE_KEY, NOW, [], 0, TZ)
    expect(special.open).toBe(true)
    expect(special.slots[0]?.time).toBe('12:00')
    expect(special.slots[special.slots.length - 1]?.time).toBe('14:00') // 14:00+120=16:00 ✓
    expect(special.slots.length).toBe(5)
  })

  it('A5: odmor — termin, ki prekriva odmor, izpade; termini pred in po odmoru ostanejo', () => {
    // odmor 15:00–17:00. Termin 14:00 traja do 16:00 → prekriva odmor → izpade.
    const rows = HOURS_ALL.map((r) => ({ ...r, breakStart: '15:00', breakEnd: '17:00' }))
    const r = slotsForDate(POLICY, { rows, specials: [] }, FUTURE_KEY, NOW, [], 0, TZ)
    expect(r.slots.some((s) => s.time === '14:30')).toBe(false) // 14:30–16:30 prekriva
    expect(r.slots.some((s) => s.time === '14:00')).toBe(false) // 14:00–16:00 prekriva
    expect(r.slots.some((s) => s.time === '12:30')).toBe(true) // 12:30–14:30 čisto pred odmorom
    expect(r.slots.some((s) => s.time === '17:00')).toBe(true) // 17:00–19:00 čisto po odmoru
  })

  it('A6: lead time — termin, ki je bližje kot leadMinutes, izpade', () => {
    // NOW = 9.11. 11:00 CET; lead 90 min → najzgodnejši termin ≥ 12:30
    const policy = { ...POLICY, leadMinutes: 90 }
    const r = slotsForDate(policy, { rows: HOURS_ALL, specials: [] }, '2026-11-09', NOW, [], 10, TZ)
    expect(r.slots.length).toBeGreaterThan(0)
    for (const s of r.slots) {
      expect(s.start.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 90 * 60_000)
    }
    // 11:00 in 11:30 sta preblizu → nista med termini
    expect(r.slots.some((s) => s.time === '11:00')).toBe(false)
    expect(r.slots.some((s) => s.time === '12:30')).toBe(true)
  })

  it('A7: kapaciteta — obsežene confirmed/seated štejejo, cancelled NE; remaining = kapaciteta − dezelve', () => {
    const seats = 20
    const resv: ExistingReservation[] = [
      { start: new Date('2026-11-15T18:00:00Z'), durationMin: 120, partySize: 6, status: 'confirmed' },
      { start: new Date('2026-11-15T19:00:00Z'), durationMin: 120, partySize: 4, status: 'seated' },
      { start: new Date('2026-11-15T19:00:00Z'), durationMin: 120, partySize: 99, status: 'cancelled' },
    ]
    const r = slotsForDate(POLICY, { rows: HOURS_ALL, specials: [] }, FUTURE_KEY, NOW, resv, seats, TZ)
    // 19:00 slot: prekrivata oba (18:00–20:00 in 19:00–21:00) → 20 − 10 = 10
    const s1900 = r.slots.find((s) => s.time === '19:00')
    expect(s1900?.remaining).toBe(10)
    // 16:00 slot: brez prekrivanja → 20
    const s1600 = r.slots.find((s) => s.time === '16:00')
    expect(s1600?.remaining).toBe(20)
  })

  it('A8: prekrivnost intervalov — [18:30,20:30) se dotika [19:00,21:00) in [17:30,19:30), NE pa [16:00,18:00)', () => {
    expect(intervalsOverlap(19 * 60, 21 * 60, 18 * 60 + 30, 20 * 60 + 30)).toBe(true)
    expect(intervalsOverlap(17 * 60 + 30, 19 * 60 + 30, 18 * 60 + 30, 20 * 60 + 30)).toBe(true)
    expect(intervalsOverlap(16 * 60, 18 * 60, 18 * 60 + 30, 20 * 60 + 30)).toBe(false)
  })

  it('A9: override maxCoversPerSlot — fiksna kapaciteta namesto seštevka sedežev', () => {
    const policy = { ...POLICY, maxCoversPerSlot: 8 }
    const r = slotsForDate(policy, { rows: HOURS_ALL, specials: [] }, FUTURE_KEY, NOW, [], 999, TZ)
    expect(r.capacity).toBe(8)
    expect(r.slots[0]?.remaining).toBe(8)
  })

  it('A10: overnight urnik 20:00–02:00 — termini čez polnoč, wrap ure (% 24)', () => {
    const rows = HOURS_ALL.map((r) => ({ ...r, openTime: '20:00', closeTime: '02:00' }))
    const r = slotsForDate(POLICY, { rows, specials: [] }, FUTURE_KEY, NOW, [], 0, TZ)
    expect(r.open).toBe(true)
    // zadnji termin 00:00 (+120 = 02:00 ✓); ure se prikažejo 00:00 ne 24:00
    expect(r.slots.some((s) => s.time === '00:00')).toBe(true)
    expect(r.slots.some((s) => s.time === '23:30')).toBe(true)
    expect(r.slots.every((s) => Number(s.time.slice(0, 2)) < 24)).toBe(true)
  })

  it('A11: DST — 19:00 termina: 15.10.2026 (CEST) = 17:00 UTC; 26.10.2026 (CET) = 18:00 UTC', () => {
    const r1 = slotsForDate(POLICY, { rows: HOURS_ALL, specials: [] }, '2026-10-15', new Date('2026-10-01T10:00:00Z'), [], 0, TZ)
    const s1 = r1.slots.find((s) => s.time === '19:00')
    expect(s1?.start.toISOString().slice(11, 16)).toBe('17:00')
    const r2 = slotsForDate(POLICY, { rows: HOURS_ALL, specials: [] }, '2026-10-26', new Date('2026-10-01T10:00:00Z'), [], 0, TZ)
    const s2 = r2.slots.find((s) => s.time === '19:00')
    expect(s2?.start.toISOString().slice(11, 16)).toBe('18:00')
  })

  it('A12: validateSlot — uspeh; pretekli datum; izven maxAdvance; neveljaven termin; zaseden', () => {
    const hours: DayHoursInput = { rows: HOURS_ALL, specials: [] }
    const okRes = validateSlot(POLICY, hours, FUTURE_KEY, '19:00', 2, NOW, [], 10, TZ)
    expect(okRes.ok).toBe(true)
    if (okRes.ok) expect(okRes.start.getUTCHours()).toBe(18) // 19:00 CET

    const past = validateSlot(POLICY, hours, '2026-11-01', '19:00', 2, NOW, [], 10, TZ)
    expect(past.ok).toBe(false)
    if (!past.ok) expect(past.code).toBe('date_in_past')

    const far = validateSlot({ ...POLICY, maxAdvanceDays: 7 }, hours, '2026-12-15', '19:00', 2, NOW, [], 10, TZ)
    expect(far.ok).toBe(false)
    if (!far.ok) expect(far.code).toBe('date_out_of_range')

    const offGrid = validateSlot(POLICY, hours, FUTURE_KEY, '19:17', 2, NOW, [], 10, TZ)
    expect(offGrid.ok).toBe(false)

    // kapaciteta 10, rezervacija 9 oseb ob 19:00 → termin za 2 ni prost
    const booked: ExistingReservation[] = [{ start: new Date('2026-11-15T18:00:00Z'), durationMin: 120, partySize: 9, status: 'confirmed' }]
    const full = validateSlot(POLICY, hours, FUTURE_KEY, '19:00', 2, NOW, booked, 10, TZ)
    expect(full.ok).toBe(false)
    if (!full.ok) expect(full.code).toBe('slot_unavailable')
  })

  it('A13: nextOpenDateKeys — zaprti dnevi izpadejo iz seznama datumov', () => {
    const rows = HOURS_ALL.map((r, i) => ({ ...r, isClosed: i === 0 || i === 6 })) // sobota+nedelja zaprta
    const keys = nextOpenDateKeys(POLICY, { rows, specials: [] }, NOW, TZ, 14)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) {
      const [y, m, d] = k.split('-').map(Number)
      expect(weekdayOf({ y, m, d })).toBeLessThan(6) // 0=ned, 6=sob
    }
  })

  it('A14: publicSlotsPayload — brez PII gostov, politika + trajanje + sloti', () => {
    const r = slotsForDate(POLICY, { rows: HOURS_ALL, specials: [] }, FUTURE_KEY, NOW, [], 12, TZ)
    const p = publicSlotsPayload('Testna', r, POLICY)
    expect(p.restaurant).toBe('Testna')
    expect(p.durationMinutes).toBe(120)
    expect(p.policy).toEqual({ minParty: 1, maxParty: 12, maxAdvanceDays: 30 })
    expect(p.slots[0]).toEqual({ time: '10:00', available: true, remaining: 12 })
    expect(JSON.stringify(p)).not.toContain('customerName')
    expect(JSON.stringify(p)).not.toContain('phone')
  })

  it('A15: widgetPolicyOf — zunanjih vrednosti ne spusti (obrambna normalizacija)', () => {
    const p = widgetPolicyOf({ slotMinutes: 0, minParty: -5, maxParty: 999, leadMinutes: -1, maxAdvanceDays: 0, maxCoversPerSlot: -3 })
    expect(p.slotMinutes).toBe(WIDGET_POLICY_DEFAULTS.slotMinutes)
    expect(p.minParty).toBe(WIDGET_POLICY_DEFAULTS.minParty)
    expect(p.maxParty).toBe(WIDGET_POLICY_DEFAULTS.maxParty)
    expect(p.leadMinutes).toBe(WIDGET_POLICY_DEFAULTS.leadMinutes)
    expect(p.maxAdvanceDays).toBe(WIDGET_POLICY_DEFAULTS.maxAdvanceDays)
    expect(p.maxCoversPerSlot).toBe(WIDGET_POLICY_DEFAULTS.maxCoversPerSlot)
  })

  it('A16: newWidgetToken — 32 hex znakov, naključnost', () => {
    const a = newWidgetToken()
    const b = newWidgetToken()
    expect(a).toMatch(/^[a-f0-9]{32}$/)
    expect(a).not.toBe(b)
  })
})

/* ═══════════════ B. JAVNA PLOŠČA (GET) ═══════════════ */

describe('B. javna plošča terminov', () => {
  beforeAll(async () => {
    // urnik + mize na lokaciji A (10:00–22:00 vsak dan, 2 mizi po 4)
    await seedHours(locA, HOURS_ALL)
    await seedTables(locA, [4, 4], 'A')
  })

  it('B1: napačen token → 404', async () => {
    const res = await publicGET(req('GET', '/api/public/reservations?token=0000000000000000'))
    expect(res.status).toBe(404)
  })

  it('B2: izklopljen widget → 404', async () => {
    // lokacija B: widget ustvarjen a izklopljen
    const put = await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrB, { locationId: locB, enabled: false }))
    const j = await body(put)
    const tokenB = String(j.token || '')
    expect(tokenB.length).toBe(32)
    const res = await publicGET(req('GET', `/api/public/reservations?token=${tokenB}`))
    expect(res.status).toBe(404)
  })

  it('B3: veljaven token → plošča s termini, politiko in imenom lokacije', async () => {
    const res = await publicGET(req('GET', `/api/public/reservations?token=${widgetToken}&date=2026-11-15`))
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.restaurant).toBe(`${P}Lok A`)
    expect(j.open).toBe(true)
    const slots = j.slots as { time: string; available: boolean; remaining: number }[]
    expect(slots.length).toBe(21)
    expect(j.policy).toEqual({ minParty: 1, maxParty: 8, maxAdvanceDays: 30 })
    expect(j.capacity).toBe(8) // 2 mizi × 4 sedeži
  })

  it('B4: brez datuma → danes v pasu lokacije (ne UTC brskalnika)', async () => {
    const res = await publicGET(req('GET', `/api/public/reservations?token=${widgetToken}`))
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(String(j.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('B5: rate limit — 61. klic v minuti → 429', async () => {
    __resetRateLimitForTests()
    let last = 200
    for (let i = 0; i < 61; i++) {
      last = (await publicGET(req('GET', `/api/public/reservations?token=${widgetToken}`))).status
      if (last === 429) break
    }
    expect(last).toBe(429)
    __resetRateLimitForTests()
  })
})

/* ═══════════════ C. JAVNA REZERVACIJA (POST) ═══════════════ */

describe('C. javna rezervacija', () => {
  function postReq(payload: Record<string, unknown>): NextRequest {
    return req('POST', '/api/public/reservations', undefined, { token: widgetToken, date: DATE, time: '19:00', partySize: 2, name: `${P}Ana`, phone: `+38640${RUN.slice(-6)}`, ...payload })
  }

  it('C1: zlata pot — 201, vir website, status confirmed, notes + opomba gosta, audit', async () => {
    __resetRateLimitForTests()
    const phone = `+38641100001`
    const res = await publicPOST(postReq({ phone, email: `${P}@test.local`, note: 'otroški stol' }))
    const j = await body(res)
    expect(res.status).toBe(201)
    expect(j.replayed).toBe(false)
    const rsv = j.reservation as { partySize: number; status: string }
    expect(rsv.partySize).toBe(2)
    expect(rsv.status).toBe('confirmed')

    const row = await db.reservation.findFirst({ where: { customerPhone: phone } })
    expect(row?.source).toBe('website')
    expect(row?.notes).toBe('Spletna rezervacija')
    expect(row?.specialRequests).toBe('otroški stol')
    expect(row?.customerName).toBe(`${P}Ana`)
    expect(row?.locationId).toBe(locA)
    // termin po LOKACIJSKEM pasu — enak zonedTimeToUtc kot motor (DST pravilen po A11)
    const [yy, mm, dd] = DATE.split('-').map(Number)
    expect(row?.dateTime.getTime()).toBe(zonedTimeToUtc(yy, mm, dd, 19, 0, TZ).getTime())

    const audit = await db.auditLog.findFirst({ where: { action: 'GUEST_RESERVATION_CREATED', entityId: row?.id } })
    expect(audit).not.toBeNull()
    expect(audit?.userId).toBeNull()
  })

  it('C2: replay — dvojni klik (isti telefon + isti termin) → ISTA rezervacija, brez dvojnika', async () => {
    __resetRateLimitForTests()
    const phone = '+38641100002'
    const p1 = await publicPOST(postReq({ phone }))
    const j1 = await body(p1)
    expect(p1.status).toBe(201)
    const p2 = await publicPOST(postReq({ phone }))
    const j2 = await body(p2)
    expect(p2.status).toBe(200)
    expect(j2.replayed).toBe(true)
    expect((j2.reservation as { id: string }).id).toBe((j1.reservation as { id: string }).id)
    const count = await db.reservation.count({ where: { customerPhone: phone } })
    expect(count).toBe(1)
  })

  it('C3: drugače telefon/termin → NI replaya (nova rezervacija)', async () => {
    __resetRateLimitForTests()
    const p = await publicPOST(postReq({ phone: '+38641100003' }))
    expect(p.status).toBe(201)
    const p2 = await publicPOST(postReq({ phone: '+38641100004' }))
    expect(p2.status).toBe(201)
  })

  it('C4: party zunaj meja (max 8) → 400', async () => {
    __resetRateLimitForTests()
    const res = await publicPOST(postReq({ phone: '+38641100005', partySize: 9 }))
    const j = await body(res)
    expect(res.status).toBe(400)
    expect(String(j.error)).toContain('med 1 in 8')
  })

  it('C5: off-grid termin → 409', async () => {
    __resetRateLimitForTests()
    const res = await publicPOST(postReq({ phone: '+38641100005', time: '19:17' }))
    expect(res.status).toBe(409)
  })

  it('C6: kapaciteta — termin čez mejo → 409 slot_unavailable', async () => {
    __resetRateLimitForTests()
    // kapaciteta 8 (2×4). Rezerviraj 6 oseb na 12:00 → ostane 2. Naslednja 3 → 409.
    await publicPOST(postReq({ phone: '+38641100006', partySize: 6, time: '12:00' }))
    // 12:00 ima sedaj 6/8 → za 3 ni prostora
    const res = await publicPOST(postReq({ phone: '+38641100007', partySize: 3, time: '12:00' }))
    expect(res.status).toBe(409)
    const resOk = await publicPOST(postReq({ phone: '+38641100008', partySize: 2, time: '12:00' }))
    expect(resOk.status).toBe(201)
  })

  it('C7: manjkajoč telefon → 400; neveljaven e-mail → 400; kratko ime → 400', async () => {
    __resetRateLimitForTests()
    expect((await publicPOST(postReq({ phone: '' }))).status).toBe(400)
    expect((await publicPOST(postReq({ phone: '+38641100009', email: 'ni-mail' }))).status).toBe(400)
    expect((await publicPOST(postReq({ phone: '+38641100009', name: 'A' }))).status).toBe(400)
  })

  it('C8: datum v preteklosti → 409; izven maxAdvanceDays → 409', async () => {
    __resetRateLimitForTests()
    const past = await publicPOST(postReq({ phone: '+38641100010', date: PAST }))
    expect(past.status).toBe(409)
    const far = await publicPOST(postReq({ phone: '+38641100010', date: FAR }))
    expect(far.status).toBe(409)
  })

  it('C9: rate limit — 6. POST v minuti → 429', async () => {
    __resetRateLimitForTests()
    let last = 400
    for (let i = 0; i < 6; i++) {
      last = (await publicPOST(postReq({ phone: `+38641700${String(i).padStart(2, '0')}`, time: '12:00' }))).status
      if (last === 429) break
    }
    expect(last).toBe(429)
    __resetRateLimitForTests()
  })

  it('C10: napačen token → 404 (tudi za POST)', async () => {
    __resetRateLimitForTests()
    const res = await publicPOST(req('POST', '/api/public/reservations', undefined, { token: '0'.repeat(32), date: DATE, time: '19:00', partySize: 2, name: 'X Y', phone: '+38641100099' }))
    expect(res.status).toBe(404)
  })
})

/* ═══════════════ D. NASTAVITVE WIDGETA (GET/PUT/DELETE) ═══════════════ */

describe('D. nastavitve widgeta (osebje)', () => {
  it('D1: GET — natakar (reservations.manage) vidi konfiguracijo BREZ tokena; settings.manage ga vidi', async () => {
    const res = await widgetGET(req('GET', `/api/reservations/widget?locationId=${locA}`, tokWaiterA))
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.widget).not.toBeNull()
    expect(JSON.stringify(j)).not.toContain(widgetToken)
    // manager ima settings.manage → povezava se razkrije (kopiranje za goste)
    const res2 = await widgetGET(req('GET', `/api/reservations/widget?locationId=${locA}`, tokMgrA))
    const j2 = await body(res2)
    expect(res2.status).toBe(200)
    expect(String(j2.token || '')).toBe(widgetToken)
    expect(String(j2.publicUrl || '')).toBe(`/r/${widgetToken}`)
  })

  it('D2: RBAC — natakar (brez settings.manage) 403 na PUT; manager OK', async () => {
    const res = await widgetPUT(req('PUT', '/api/reservations/widget', tokWaiterA, { locationId: locA, enabled: true }))
    expect(res.status).toBe(403)
    const res2 = await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrA, { locationId: locA, maxParty: 10 }))
    expect(res2.status).toBe(200)
  })

  it('D3: rotacija — nov token; STARI takoj preneha delovati (404)', async () => {
    const res = await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrA, { locationId: locA, rotateToken: true }))
    const j = await body(res)
    expect(res.status).toBe(200)
    const newToken = String(j.token || '')
    expect(newToken.length).toBe(32)
    expect(newToken).not.toBe(widgetToken)
    const old = await publicGET(req('GET', `/api/public/reservations?token=${widgetToken}`))
    expect(old.status).toBe(404)
    const fresh = await publicGET(req('GET', `/api/public/reservations?token=${newToken}`))
    expect(fresh.status).toBe(200)
    widgetToken = newToken // nadaljnji testi uporabljajo novi
  })

  it('D4: validacija meja — slotMinutes 3 → 400; minParty > maxParty → 400', async () => {
    const res = await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrA, { locationId: locA, slotMinutes: 3 }))
    expect(res.status).toBe(400)
    const res2 = await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrA, { locationId: locA, minParty: 6, maxParty: 4 }))
    expect(res2.status).toBe(400)
  })

  it('D5: org scope — manager B (ne-centralen) NE more pisati widgeta lokacije A (pripne se locB)', async () => {
    const before = await db.reservationWidget.findUnique({ where: { locationId: locA } })
    const res = await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrB, { locationId: locA, enabled: false, maxParty: 3 }))
    expect(res.status).toBe(200)
    const j = await body(res)
    // pisanje je pristalo na NANJI lokaciji uporabnika (locB) — ne na locA
    expect((j.widget as { locationId: string }).locationId).toBe(locB)
    const after = await db.reservationWidget.findUnique({ where: { locationId: locA } })
    expect(after?.enabled).toBe(before?.enabled) // locA nedotaknjen
    expect(after?.maxParty).not.toBe(3)
    expect(after?.maxParty).toBe(before?.maxParty)
  })

  it('D6: izklop (DELETE) → javna povezava takoj 404; ponovni vklop deluje', async () => {
    const res = await widgetDELETE(req('DELETE', '/api/reservations/widget', undefined, undefined))
    // DELETE brez žetona → 401 (avtentikacija)
    expect(res.status).toBe(401)
    const res2 = await widgetDELETE(req('DELETE', '/api/reservations/widget', tokMgrA, { locationId: locA }))
    expect(res2.status).toBe(200)
    const public1 = await publicGET(req('GET', `/api/public/reservations?token=${widgetToken}`))
    expect(public1.status).toBe(404)
    await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrA, { locationId: locA, enabled: true }))
    const public2 = await publicGET(req('GET', `/api/public/reservations?token=${widgetToken}`))
    expect(public2.status).toBe(200)
  })

  it('D7: audit sled nastavitev — RESERVATION_WIDGET_UPDATED zapisan', async () => {
    const row = await db.auditLog.findFirst({ where: { action: 'RESERVATION_WIDGET_UPDATED', locationId: locA } })
    expect(row).not.toBeNull()
  })
})

/* ═══════════════ E. DDL + REGISTER + DRIFT ═══════════════ */

describe('E. DDL/register/drift', () => {
  it('E1: register vsebuje reservation-widget (id, endpoint, probe)', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'reservation-widget')
    expect(m).toBeDefined()
    expect(m?.endpoint).toBe('/api/admin/migrate-reservation-widget')
  })

  it('E2: DDL ruta idempotentna (že aplikirana v dev SQLite); manager 403', async () => {
    const denied = await migratePOST(req('POST', '/api/admin/migrate-reservation-widget', tokMgrA))
    expect(denied.status).toBe(403) // requireCentralRole — manager NI centralna vloga
    const adminTok = tok('bootstrap', 'Bootstrap', 'ADMIN', null)
    const res = await migratePOST(req('POST', '/api/admin/migrate-reservation-widget', adminTok))
    const j = await body(res)
    expect(res.status).toBe(200)
    expect(j.alreadyApplied).toBe(true)
  })

  it('E3: drift matcher — stavki ReservationWidget prepoznani; tuji NE', () => {
    expect(isReservationWidgetStatement('CREATE TABLE "ReservationWidget" (id TEXT)')).toBe(true)
    expect(isReservationWidgetStatement('CREATE UNIQUE INDEX "ReservationWidget_token_key" ON "ReservationWidget"("token")')).toBe(true)
    expect(isReservationWidgetStatement('ALTER TABLE "ReservationWidget" ADD COLUMN "x" TEXT')).toBe(true)
    expect(isReservationWidgetStatement('DROP TABLE "ReservationWidget"')).toBe(false)
    expect(isReservationWidgetStatement('CREATE TABLE "HaccpAction" (id TEXT)')).toBe(false)
  })

  it('E4: classifyDrift — ReservationWidget stavki razvrščeni kot znani (ne unexpected)', () => {
    const sql = [
      'CREATE TABLE "ReservationWidget" (id TEXT NOT NULL)',
      'CREATE UNIQUE INDEX "ReservationWidget_locationId_key" ON "ReservationWidget"("locationId")',
      'CREATE INDEX "ReservationWidget_enabled_idx" ON "ReservationWidget"("enabled")',
    ].join(';\n')
    const out = classifyDrift(sql)
    expect(out.unexpected.length).toBe(0)
    expect(out.known.some((k) => k.id === 'reservation-widget')).toBe(true)
  })
})
