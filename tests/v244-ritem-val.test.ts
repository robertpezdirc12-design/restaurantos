/**
 * v1.244.0 — RITEM VAL (PRIMERJAVA-VMESNIKOV-2026 §18: sveža raziskava
 * Toast Spring/Fall 2026 + Lightspeed marec/april/november 2026).
 *
 * Štiri ugotovitve, en val:
 *  A · RITEM PRIHODOV (arrival pacing, P1) — interna pot rezervacij (telefon/
 *    walk-in) je bila edina ustvarjalna pot BREZ kapacitetnega varovala (javni
 *    widget ima maxCoversPerSlot + leadMinutes). Skupni strežniški varovalec:
 *    največ gostov na fiksno okno (Lightspeed »Arrival Pacing« april 2026),
 *    preverjen pod zaklepom lockReservationCapacity; izrecen preglas
 *    (forcePacing → revizija RESERVATION_PACING_OVERRIDE).
 *  B · javna pot: enak varovalec brez preglasa (gost izbere drug termin).
 *  C · TLORIS: strežniška značka (waiterName + openedAt na activeOrder —
 *    Lightspeed nov 2026 »server ownership badges … seated times«).
 *  D · čiste funkcije lib-a (pacingWindowStart mreža, parsePacingConfig klemi,
 *    coversByWindow agregacija za UI §18 D).
 *  Ž · registri (verzija, dokument §18, i18n ključi SL/HR, viri na disku).
 *
 * Predpona fiksatur `v244-`; cleanup v afterAll (obratna smer FK).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import { POST as resvPOST } from '../src/app/api/reservations/route'
import { GET as pacingGET, PUT as pacingPUT } from '../src/app/api/reservations/pacing/route'
import { POST as publicPOST } from '../src/app/api/public/reservations/route'
import { GET as tablesGET } from '../src/app/api/tables/route'
import { zonedTimeToUtc, zonedDateParts, localDateKey } from '../src/lib/haccp-ops'
import {
  PACING_CONFIG_MARKER,
  DEFAULT_PACING_CONFIG,
  parsePacingConfig,
  pacingWindowStart,
  coversByWindow,
} from '../src/lib/reservation-pacing'
import { APP_VERSION } from '../src/lib/version'
import { readFileSync } from 'fs'
import { join } from 'path'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v244-'
const RUN = Date.now().toString(36)
const ROOT = process.cwd()
const TZ = 'Europe/Ljubljana'

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

let locA = ''      // interna pot (brez odpiralnega časa = kdorkoli)
let mgrId = ''
let token = ''

let locB = ''      // javna pot (widget + odpiralni čas 10–22)
let mgrBId = ''    // manager NA lokaciji B (requireUserLocation za lokalno vlogo
let tokenB = ''    // prepiše tuji locationId z lastno — pacing B nastavlja B-vodja)

let widgetToken = ''

let tblPace = ''   // C: naročilo z natakarjem
let tblNoWaiter = '' // C: naročilo BREZ natakarja

function req(method: string, url: string, body?: unknown, tok: string | null = token): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function resvReq(body: unknown): NextRequest {
  return req('POST', '/api/reservations', { locationId: locA, ...body })
}

function publicPost(payload: Record<string, unknown>): Promise<Response> {
  return publicPOST(req('POST', '/api/public/reservations', {
    token: widgetToken, partySize: 2, name: `${P}Gost`, phone: '+38640111222', ...payload,
  }, null)) as unknown as Promise<Response>
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

/** Lokalni termin jutri ob uri hh:mm (interni poti — brez pasovnih pasti). */
function tomorrowAt(h: number, m: number): Date {
  const d = new Date(Date.now() + 24 * 3600_000)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0)
}

async function mkResv(opts: { at: Date; guests?: number; status?: string; locationId?: string }): Promise<string> {
  const id = `${P}rsv-${Math.random().toString(36).slice(2, 10)}-${RUN}`
  await db.reservation.create({
    data: {
      id,
      customerName: `${P}Gost`,
      customerPhone: '',
      dateTime: opts.at,
      partySize: opts.guests ?? 2,
      duration: 120,
      status: (opts.status ?? 'confirmed') as never,
      source: 'walk_in' as never,
      locationId: opts.locationId ?? locA,
    },
  })
  return id
}

async function putPacing(payload: Record<string, unknown>, locationId: string, tok: string = token): Promise<Response> {
  return pacingPUT(req('PUT', '/api/reservations/pacing', { locationId, ...payload }, tok))
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])

  /* ── lokacija A: interna pot ── */
  const a = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Lokacija A`, code: `V244A-${RUN.toUpperCase()}`, premisesId: `v244-premA-${RUN}` } })
  locA = a.id
  mgrId = `${P}mgr-${RUN}`
  const pin = employeePinFields('v244-pin-1234', `${P}mgr-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: mgrId, name: `${P}Natakar Vodja`, email: `${P}mgr-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pin.pin, pinLookup: pin.pinLookup,
    },
  })
  token = createToken({ sub: mgrId, name: `${P}Vodja`, role: 'manager', loc: locA, sv: 0 })

  tblPace = `${P}tbl-pace-${RUN}`
  tblNoWaiter = `${P}tbl-now-${RUN}`
  const N = 6410
  await db.table.createMany({
    data: [
      { id: tblPace, number: N + 1, locationId: locA, status: 'available' },
      { id: tblNoWaiter, number: N + 2, locationId: locA, status: 'available' },
    ],
  })

  /* ── lokacija B: javna pot (widget) ── */
  widgetToken = crypto.randomBytes(16).toString('hex')
  const b = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Lokacija B`, code: `V244B-${RUN.toUpperCase()}`, premisesId: `v244-premB-${RUN}` } })
  locB = b.id
  for (let dow = 0; dow < 7; dow++) {
    await db.openingHours.create({ data: { id: `${P}oh-${dow}-${RUN}`, dayOfWeek: dow, openTime: '10:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false, locationId: locB } })
  }
  // 4 mize × 4 sedeži = 16 (seats kapaciteta NE sproži pred pacingom pri 12)
  for (let n = 1; n <= 4; n++) {
    await db.table.create({ data: { id: `${P}btbl-${n}-${RUN}`, number: N + 10 + n, capacity: 4, locationId: locB } })
  }
  await db.reservationWidget.create({
    data: { id: `${P}widget-${RUN}`, locationId: locB, token: widgetToken, enabled: true, slotMinutes: 30, minParty: 1, maxParty: 8, leadMinutes: 0, maxAdvanceDays: 30, maxCoversPerSlot: 0 },
  })

  // manager na lokaciji B — pacing je per lokacija in requireUserLocation za
  // lokalno vlogo prepiše tuji locationId z LASTNO lokacijo (tenant varovanje)
  mgrBId = `${P}mgrB-${RUN}`
  const pinB = employeePinFields('v244-pinB-1234', `${P}mgrB-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: mgrBId, name: `${P}Vodja B`, email: `${P}mgrB-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locB,
      pin: pinB.pin, pinLookup: pinB.pinLookup,
    },
  })
  tokenB = createToken({ sub: mgrBId, name: `${P}Vodja B`, role: 'manager', loc: locB, sv: 0 })
})

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: P } }, { entityId: PACING_CONFIG_MARKER }] } }).catch(() => null)
  await db.order.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.reservation.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.waitlistEntry.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.reservationWidget.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.integration.deleteMany({ where: { name: PACING_CONFIG_MARKER, locationId: { in: [locA, locB] } } }).catch(() => null)
  await db.openingHours.deleteMany({ where: { id: { startsWith: `${P}oh-` } } }).catch(() => null)
  await db.table.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.counter.deleteMany({ where: { name: { startsWith: 'resvslot:' } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
})

/* ── A · RITEM PRIHODOV — konfiguracija + interna pot ─────────────────── */

describe('v1.244.0 A · konfiguracija pacanja', () => {
  test('A1: GET brez vrstice → privzeta (izklopljeno, 30 min) — obstoječe lokacije nespremenjene', async () => {
    const res = await pacingGET(req('GET', `/api/reservations/pacing?locationId=${locA}`, undefined))
    expect(res.status).toBe(200)
    const d = await body(res)
    expect(d.config).toEqual(DEFAULT_PACING_CONFIG)
  })

  test('A2: PUT veljavna konfiguracija → 200 + kanonična oblika + revizija', async () => {
    const res = await putPacing({ enabled: true, windowMin: 30, maxGuests: 10 }, locA)
    expect(res.status).toBe(200)
    const d = await body(res)
    expect(d.config).toEqual({ enabled: true, windowMin: 30, maxGuests: 10 })
    const audit = await db.auditLog.findFirst({ where: { action: 'RESERVATION_PACING_CONFIG', locationId: locA } })
    expect(audit).not.toBeNull()

    const g = await pacingGET(req('GET', `/api/reservations/pacing?locationId=${locA}`, undefined))
    const gd = await body(g)
    expect(gd.config).toEqual({ enabled: true, windowMin: 30, maxGuests: 10 })
  })

  test('A3: PUT validacija — okno < 10, enabled brez omejitve, manjkajoč enabled → 400', async () => {
    expect((await putPacing({ enabled: true, windowMin: 5, maxGuests: 10 }, locA)).status).toBe(400)
    expect((await putPacing({ enabled: true, windowMin: 30, maxGuests: 0 }, locA)).status).toBe(400)
    expect((await putPacing({ windowMin: 30, maxGuests: 10 }, locA)).status).toBe(400)
    expect((await putPacing({ enabled: 'ja', windowMin: 30, maxGuests: 10 }, locA)).status).toBe(400)
  })

  test('A4: TENANT — lokalni vodja z tujim locationId dobi SAMO svojo lokacijo (requireUserLocation prepiše)', async () => {
    // vodja A sprašuje po locationId=locB → requireUserLocation za lokalno
    // vlogo vrne user.loc (locA) — tuje konfiguracije NI mogoče brati niti pisati
    // (ista disciplina kot vse ostale rute; B-vodja to dokaže v B-seriji).
    const g = await pacingGET(req('GET', `/api/reservations/pacing?locationId=${locB}`, undefined))
    const gd = await body(g)
    expect(gd.config).toEqual({ enabled: true, windowMin: 30, maxGuests: 10 }) // ← to je konfiguracija LOKACIJE A
  })
})

describe('v1.244.0 A · interna pot (telefon/walk-in) pod varovalom', () => {
  test('A5: 4+4 gosta ob 19:10, novi 4 ob 19:20 (isto okno) → 409 ARRIVAL_PACING + overrideRequired', async () => {
    const at = tomorrowAt(19, 10)
    await mkResv({ at, guests: 4 })
    await mkResv({ at: new Date(at.getTime() + 5 * 60_000), guests: 4 })
    const res = await resvPOST(resvReq({ guestName: `${P}Cilka`, reservedAt: tomorrowAt(19, 20).toISOString(), guests: 4 }))
    expect(res.status).toBe(409)
    const d = await body(res)
    expect(d.code).toBe('ARRIVAL_PACING')
    expect(d.overrideRequired).toBe(true)
    expect(String(d.error || '')).toContain('Ritem prihodov')
    expect(String(d.error || '')).toMatch(/\d{2}:\d{2} in \d{2}:\d{2}/)
    expect(d.currentGuests).toBe(8)
    expect(d.maxGuests).toBe(10)
  })

  test('A6: novi 4 ob 19:50 (NASLEDNJE okno) → 201 — košarka je fiksna', async () => {
    const res = await resvPOST(resvReq({ guestName: `${P}Denis`, reservedAt: tomorrowAt(19, 50).toISOString(), guests: 4 }))
    expect(res.status).toBe(201)
  })

  test('A7: točno na meji (6 obstoječih + 4 novi = 10 = limita) → 201 (<=, ne <)', async () => {
    // 8 (19:10/19:15) + 4 (19:50) so že v svojih oknih; novo okno 20:00 z 6 gosti
    await mkResv({ at: tomorrowAt(20, 0), guests: 6 })
    const res = await resvPOST(resvReq({ guestName: `${P}Eva`, reservedAt: tomorrowAt(20, 15).toISOString(), guests: 4 }))
    expect(res.status).toBe(201)
  })

  test('A8: presežek + forcePacing → 201 + revizija RESERVATION_PACING_OVERRIDE', async () => {
    const res = await resvPOST(resvReq({ guestName: `${P}Franc`, reservedAt: tomorrowAt(20, 20).toISOString(), guests: 4, forcePacing: true }))
    expect(res.status).toBe(201)
    const d = await body(res)
    const rid = (d.reservation as { id?: string } | undefined)?.id
    expect(rid).toBeTruthy()
    const audit = await db.auditLog.findFirst({ where: { action: 'RESERVATION_PACING_OVERRIDE', entityType: 'Reservation', entityId: rid } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit?.details ?? '{}') as { maxGuests?: number; currentGuests?: number }
    expect(details.maxGuests).toBe(10)
    expect(details.currentGuests).toBe(10)
  })

  test('A9: preklicana rezervacija NE šteje v okno', async () => {
    await mkResv({ at: tomorrowAt(21, 10), guests: 8, status: 'cancelled' })
    const res = await resvPOST(resvReq({ guestName: `${P}Greta`, reservedAt: tomorrowAt(21, 15).toISOString(), guests: 4 }))
    expect(res.status).toBe(201)
  })

  test('A10: izklop varovala → isti presežek gre čez (privzeto stanje = kot prej)', async () => {
    await putPacing({ enabled: false, windowMin: 30, maxGuests: 10 }, locA)
    await mkResv({ at: tomorrowAt(22, 0), guests: 10 })
    const res = await resvPOST(resvReq({ guestName: `${P}Hinko`, reservedAt: tomorrowAt(22, 10).toISOString(), guests: 6 }))
    expect(res.status).toBe(201)
  })
})

/* ── B · javna pot (widget) — enako varovalo, brez preglasa ───────────── */

describe('v1.244.0 B · javna pot pod varovalom', () => {
  const T = zonedDateParts(new Date(Date.now() + 5 * 24 * 3600_000), TZ)
  const FAR = { y: T.y, m: T.m, d: T.d }
  const FAR_KEY = localDateKey(FAR)

  test('B1: 10 gostov ob 18:00, javni 2 ob 18:00 (isto okno) → 409 z razlago', async () => {
    __resetRateLimitForTests()
    // vklop pacanja na lokaciji B — prek NJENEGA vodje (per-lokacija disciplína)
    const put = await putPacing({ enabled: true, windowMin: 30, maxGuests: 10 }, locB, tokenB)
    expect(put.status).toBe(200)
    // in lokacija B ima res SVOJO vrstico (A je ne vidi — A4 je preveril nasprotno smer)
    const gB = await pacingGET(req('GET', `/api/reservations/pacing?locationId=${locB}`, undefined, tokenB))
    const gBd = await body(gB)
    expect(gBd.config).toEqual({ enabled: true, windowMin: 30, maxGuests: 10 })
    await db.reservation.create({
      data: {
        id: `${P}seed-pub-${RUN}`,
        customerName: `${P}Obstoječi`,
        customerPhone: '+38640111001',
        dateTime: zonedTimeToUtc(FAR.y, FAR.m, FAR.d, 18, 0, TZ),
        partySize: 10,
        duration: 120,
        status: 'confirmed',
        source: 'phone',
        locationId: locB,
      },
    })
    const res = await publicPost({ date: FAR_KEY, time: '18:00', partySize: 2, phone: '+38640111223' })
    expect(res.status).toBe(409)
    const d = await body(res)
    expect(String(d.error || '')).toContain('Ritem prihodov')
    // preglas na javni poti NE obstaja — kljub forcePacing v telesu
    const res2 = await publicPost({ date: FAR_KEY, time: '18:00', partySize: 2, phone: '+38640111224', forcePacing: true })
    expect(res2.status).toBe(409)
  })

  test('B2: javni 2 ob 18:30 (naslednje okno) → 201', async () => {
    __resetRateLimitForTests()
    const res = await publicPost({ date: FAR_KEY, time: '18:30', partySize: 2, phone: '+38640111225' })
    expect(res.status).toBe(201)
    const d = await body(res)
    expect(d.replayed !== true).toBe(true)
  })
})

/* ── C · tloris: strežniška značka na activeOrder ─────────────────────── */

describe('v1.244.0 C · tables GET — waiterName + openedAt', () => {
  test('C1: naročilo Z natakarjem → activeOrder.waiterName + openedAt; brez natakarja → null', async () => {
    const now = new Date()
    await db.order.create({
      data: {
        id: `${P}ord-w-${RUN}`, orderNumber: 964101, locationId: locA, tableId: tblPace,
        status: 'open', paymentStatus: 'unpaid', subtotal: 10, tax: 2.2, total: 12.2,
        employeeId: mgrId, createdAt: now,
      },
    })
    await db.order.create({
      data: {
        id: `${P}ord-nw-${RUN}`, orderNumber: 964102, locationId: locA, tableId: tblNoWaiter,
        status: 'open', paymentStatus: 'unpaid', subtotal: 10, tax: 2.2, total: 12.2,
      },
    })
    const res = await tablesGET(req('GET', '/api/tables', undefined))
    expect(res.status).toBe(200)
    const d = (await body(res)) as { tables?: { id: string; activeOrder: { waiterName?: string | null; openedAt?: string | null } | null }[] }
    const rows = d.tables ?? []
    const withW = rows.find((x) => x.id === tblPace)
    const withoutW = rows.find((x) => x.id === tblNoWaiter)
    expect(withW?.activeOrder?.waiterName).toBe(`${P}Natakar Vodja`)
    expect(typeof withW?.activeOrder?.openedAt).toBe('string')
    expect(withoutW?.activeOrder?.waiterName).toBeNull()
  })
})

/* ── D · čiste funkcije lib-a ─────────────────────────────────────────── */

describe('v1.244.0 D · libreservation-pacing (čiste funkcije)', () => {
  test('D1: pacingWindowStart — fiksna mreža (19:07→19:00, 19:45→19:30, 19:59→19:30 @30)', () => {
    const mk = (h: number, m: number) => new Date(2026, 10, 20, h, m, 0, 0)
    const s = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(s(pacingWindowStart(mk(19, 7), 30))).toBe('19:00')
    expect(s(pacingWindowStart(mk(19, 45), 30))).toBe('19:30')
    expect(s(pacingWindowStart(mk(19, 59), 30))).toBe('19:30')
    expect(s(pacingWindowStart(mk(20, 0), 30))).toBe('20:00')
    // 60-min okno: poravnano na uro
    expect(s(pacingWindowStart(mk(19, 59), 60))).toBe('19:00')
  })

  test('D2: parsePacingConfig — obrambni klemi (okno 5→30, gostje 999→0, enabled samo true, JSON niz)', () => {
    expect(parsePacingConfig(null)).toEqual(DEFAULT_PACING_CONFIG)
    expect(parsePacingConfig({})).toEqual(DEFAULT_PACING_CONFIG)
    expect(parsePacingConfig({ enabled: true, windowMin: 5, maxGuests: 40 })).toEqual({ enabled: true, windowMin: 30, maxGuests: 40 })
    expect(parsePacingConfig({ enabled: true, windowMin: 30, maxGuests: 999 })).toEqual({ enabled: true, windowMin: 30, maxGuests: 0 })
    expect(parsePacingConfig({ enabled: 1, windowMin: 30, maxGuests: 10 })).toEqual({ enabled: false, windowMin: 30, maxGuests: 10 })
    // Integration.config je Json polje — zapis prek JSON.stringify se prebere kot NIZ
    expect(parsePacingConfig('{"enabled":true,"windowMin":45,"maxGuests":20}')).toEqual({ enabled: true, windowMin: 45, maxGuests: 20 })
    expect(parsePacingConfig('ne-veljaven json')).toEqual(DEFAULT_PACING_CONFIG)
  })

  test('D3: coversByWindow — agregacija po oknih, urejeno, neveljavni datumi izpuščeni', () => {
    const at = (h: number, m: number) => new Date(2026, 10, 20, h, m, 0, 0).toISOString()
    const out = coversByWindow([
      { reservedAt: at(12, 0), guests: 4 },
      { reservedAt: at(12, 20), guests: 3 },
      { reservedAt: at(12, 50), guests: 2 },
      { reservedAt: 'ne-veljavno', guests: 9 },
    ], 30)
    expect(out).toHaveLength(2)
    expect(out[0].guests).toBe(7)
    expect(out[0].count).toBe(2)
    expect(out[1].guests).toBe(2)
    expect(out[0].start < out[1].start).toBe(true)
  })
})

/* ── Ž · registri (verzija, dokumenti, i18n, viri) ────────────────────── */

describe('v1.244.0 Ž · verzija in dokumenti', () => {
  test('Ž1: APP_VERSION dvignjena na 1.244.0', () => {
    expect(APP_VERSION).toBe('1.267.0')
  })

  test('Ž2: PRIMERJAVA §18 dokumentira ritem val', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 18. Raziskava')
    expect(doc).toContain('RITEM VAL')
    expect(doc).toContain('Arrival Pacing')
  })

  test('Ž3: i18n — novi ključi v SL in HR (pariteta)', () => {
    const keys = [
      'resv.pacingTitle', 'resv.pacingHint', 'resv.pacingWindow', 'resv.pacingMax',
      'resv.pacingSave', 'resv.pacingSaved', 'resv.pacingOn', 'resv.pacingOff',
      'resv.confirmPacing', 'resv.coversTitle', 'resv.coversTotal', 'resv.coversEmpty',
      'kds.viewOnly', 'kds.viewOnlyOn', 'kds.viewOnlyHint',
      'tables.seatedFor', 'tables.waiterAria',
    ]
    for (const k of keys) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    // pariteta števcev (obe slovarji isto število ključev)
    expect(Object.keys(sl).length).toBe(Object.keys(hr).length)
  })

  test('Ž4: lib + rute na disku z varovalci', () => {
    const lib = read('src/lib/reservation-pacing.ts')
    expect(lib).toContain('assertArrivalPacing')
    expect(lib).toContain(PACING_CONFIG_MARKER)
    const route = read('src/app/api/reservations/route.ts')
    expect(route).toContain('forcePacing')
    expect(route).toContain('RESERVATION_PACING_OVERRIDE')
    const pub = read('src/app/api/public/reservations/route.ts')
    expect(pub).toContain('assertArrivalPacing')
    const pacingRoute = read('src/app/api/reservations/pacing/route.ts')
    expect(pacingRoute).toContain('RESERVATION_PACING_CONFIG')
  })

  test('Ž5: dashboard ima vse štiri plasti vala (pacing preglas, KDS zaklep, značka, pokritost)', () => {
    const dash = read('src/app/dashboard/page.tsx')
    expect(dash).toContain('forcePacing')
    expect(dash).toContain('ro_kds_view_only')
    expect(dash).toContain('tileWaiterInitials')
    expect(dash).toContain('todayCovers')
    expect(dash).toContain('ReservationPacingCard')
  })
})
