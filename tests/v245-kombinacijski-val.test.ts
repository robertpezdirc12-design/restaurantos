/**
 * v1.245.0 — KOMBINACIJSKI VAL (PRIMERJAVA-VMESNIKOV-2026 §19:
 * Lightspeed november 2026 — »table combinations« + »bookable tables«).
 *
 * Dve ugotovitvi:
 *  A · KOMBINACIJSKE MIZE (P1): družba 8 na lokaciji z največjo mizo 6 je
 *    bila brez odgovora — Reservation je nosila EN tableId, varovala pa
 *    ni znala blokirati več miz. Zdaj: registr (Integration) + stolpec
 *    comboTableIds ',id1,id2,' + guardi OR contains + SEATED/CANCELLED
 *    upravljata VSE članice.
 *  B · WALK-IN REZERVA (P2): spletna kapaciteta terminov = fizični MINUS
 *    izključene mize (onlineSeatsFor); interna pot ni omejena.
 *
 * Predpona fiksatur `v245-`; cleanup v afterAll (obratna smer FK).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as resvPOST, PATCH as resvPATCH } from '../src/app/api/reservations/route'
import { GET as combosGET, PUT as combosPUT } from '../src/app/api/tables/combos/route'
import { PATCH as waitlistPATCH } from '../src/app/api/waitlist/route'
import { onlineSeatsFor, tableSeatsFor } from '../src/lib/reservation-widget'
import {
  TABLE_COMBOS_MARKER,
  RESV_BOOKABLE_MARKER,
  comboTableIdsOf,
  parseComboTableIds,
  parseCombos,
  parseBookableExcluded,
  seatCandidatesForParty,
} from '../src/lib/table-combos'
import { KNOWN_DRIFTS, isReservationComboStatement } from '../scripts/drift-check'
import { APP_VERSION } from '../src/lib/version'
import { readFileSync } from 'fs'
import { join } from 'path'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v245-'
const RUN = Date.now().toString(36)
const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf-8')
}

let locA = ''      // kombinacije (brez odpiralnega časa = kdorkoli)
let mgrId = ''
let token = ''
let tblA = ''      // 4 sedeži — kombinacija A+B = 8
let tblB = ''      // 4 sedeži
let tblC = ''      // 6 sedežev — največja enojna
let tblD = ''      // 4 sedeži — walk-in rezerva (locB public test)
let tblE = ''      // prostа za claim test
let tblF = ''      // 4 sedeža — SVEŽ par za SEATED/CANCELLED (brez drugih rezervacij
let tblG = ''      // 4 sedeža — v oknu, da claim ne konfliktuje s prejšnjimi testi)

let locB = ''      // javni widget (B-serija)
let mgrBId = ''    // vodja NA lokaciji B (requireUserLocation za lokalno vlogo
let tokenB = ''    // prepiše tuji locationId z lastno — B2 potrebuje B-vodjo)
let widgetToken = ''

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

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

/** Lokalni termin jutri ob uri hh:mm. */
function tomorrowAt(h: number, m: number): Date {
  const d = new Date(Date.now() + 24 * 3600_000)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0)
}

async function mkResv(opts: { tableIds?: string[]; tableId?: string; at: Date; guests?: number; status?: string; locationId?: string }): Promise<string> {
  const id = `${P}rsv-${Math.random().toString(36).slice(2, 10)}-${RUN}`
  await db.reservation.create({
    data: {
      id,
      customerName: `${P}Gost ${id.slice(-4)}`,
      customerPhone: '',
      dateTime: opts.at,
      partySize: opts.guests ?? 2,
      duration: 120,
      status: (opts.status ?? 'confirmed') as never,
      source: 'walk_in' as never,
      locationId: opts.locationId ?? locA,
      ...(opts.tableId ? { tableId: opts.tableId } : {}),
      ...(opts.tableIds && opts.tableIds.length >= 2
        ? { tableId: opts.tableIds[0], comboTableIds: comboTableIdsOf(opts.tableIds) }
        : {}),
    },
  })
  return id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])

  const a = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Lokacija A`, code: `V245A-${RUN.toUpperCase()}`, premisesId: `v245-premA-${RUN}` } })
  locA = a.id
  mgrId = `${P}mgr-${RUN}`
  const pin = employeePinFields('v245-pin-1234', `${P}mgr-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: mgrId, name: `${P}Vodja`, email: `${P}mgr-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pin.pin, pinLookup: pin.pinLookup,
    },
  })
  token = createToken({ sub: mgrId, name: `${P}Vodja`, role: 'manager', loc: locA, sv: 0 })

  tblA = `${P}tbl-a-${RUN}`
  tblB = `${P}tbl-b-${RUN}`
  tblC = `${P}tbl-c-${RUN}`
  tblD = `${P}tbl-d-${RUN}`
  tblE = `${P}tbl-e-${RUN}`
  tblF = `${P}tbl-f-${RUN}`
  tblG = `${P}tbl-g-${RUN}`
  const N = 6510
  await db.table.createMany({
    data: [
      { id: tblA, number: N + 1, capacity: 4, locationId: locA, status: 'available' },
      { id: tblB, number: N + 2, capacity: 4, locationId: locA, status: 'available' },
      { id: tblC, number: N + 3, capacity: 6, locationId: locA, status: 'available' },
      { id: tblD, number: N + 4, capacity: 4, locationId: locA, status: 'available' },
      { id: tblE, number: N + 5, capacity: 4, locationId: locA, status: 'available' },
      { id: tblF, number: N + 6, capacity: 4, locationId: locA, status: 'available' },
      { id: tblG, number: N + 7, capacity: 4, locationId: locA, status: 'available' },
    ],
  })

  /* ── lokacija B: javni widget (walk-in rezerva) ── */
  widgetToken = crypto.randomBytes(16).toString('hex')
  const b = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Lokacija B`, code: `V245B-${RUN.toUpperCase()}`, premisesId: `v245-premB-${RUN}` } })
  locB = b.id
  for (let dow = 0; dow < 7; dow++) {
    await db.openingHours.create({ data: { id: `${P}oh-${dow}-${RUN}`, dayOfWeek: dow, openTime: '10:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false, locationId: locB } })
  }
  for (let n = 1; n <= 4; n++) {
    await db.table.create({ data: { id: `${P}btbl-${n}-${RUN}`, number: N + 10 + n, capacity: 4, locationId: locB } })
  }
  await db.reservationWidget.create({
    data: { id: `${P}widget-${RUN}`, locationId: locB, token: widgetToken, enabled: true, slotMinutes: 30, minParty: 1, maxParty: 8, leadMinutes: 0, maxAdvanceDays: 30, maxCoversPerSlot: 0 },
  })

  // vodja na lokaciji B — B2 potrebuje lokalni token (requireUserLocation za
  // lokalno vlogo prepiše tuji locationId z LASTNO lokacijo — tenant varovanje)
  mgrBId = `${P}mgrB-${RUN}`
  const pinB = employeePinFields('v245-pinB-1234', `${P}mgrB-${RUN}@test.local`)
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
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: P } }, { entityId: { in: [TABLE_COMBOS_MARKER, RESV_BOOKABLE_MARKER] } }] } }).catch(() => null)
  await db.reservation.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.waitlistEntry.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.reservationWidget.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.integration.deleteMany({ where: { name: { in: [TABLE_COMBOS_MARKER, RESV_BOOKABLE_MARKER] }, locationId: { in: [locA, locB] } } }).catch(() => null)
  await db.openingHours.deleteMany({ where: { id: { startsWith: `${P}oh-` } } }).catch(() => null)
  await db.table.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.counter.deleteMany({ where: { name: { startsWith: 'resvslot:' } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
})

/* ── A · registr kombinacij ──────────────────────────────────────────── */

describe('v1.245.0 A · registr kombinacij (GET/PUT /api/tables/combos)', () => {
  test('A1: GET brez vrstic → prazno (obstoječe lokacije nespremenjene)', async () => {
    const res = await combosGET(req('GET', `/api/tables/combos?locationId=${locA}`, undefined))
    expect(res.status).toBe(200)
    const d = await body(res)
    expect(d.combos).toEqual([])
    expect(d.excludedTableIds).toEqual([])
  })

  test('A2: PUT kombinacija [A,B] → 200 + revizija TABLE_COMBOS_CONFIG + GET vrne', async () => {
    const res = await combosPUT(req('PUT', '/api/tables/combos', { locationId: locA, combos: [{ tableIds: [tblA, tblB] }] }))
    expect(res.status).toBe(200)
    const d = await body(res)
    expect((d.combos as { tableIds: string[] }[]).length).toBe(1)
    const audit = await db.auditLog.findFirst({ where: { action: 'TABLE_COMBOS_CONFIG', locationId: locA } })
    expect(audit).not.toBeNull()
    const g = await combosGET(req('GET', `/api/tables/combos?locationId=${locA}`, undefined))
    const gd = await body(g)
    expect((gd.combos as { tableIds: string[] }[])[0].tableIds).toEqual([tblA, tblB])
  })

  test('A3: PUT validacija — 1 miza, neznana miza, tuja lokacija → 400', async () => {
    expect((await combosPUT(req('PUT', '/api/tables/combos', { locationId: locA, combos: [{ tableIds: [tblA] }] }))).status).toBe(400)
    expect((await combosPUT(req('PUT', '/api/tables/combos', { locationId: locA, combos: [{ tableIds: [tblA, 'ne-obstaja'] }] }))).status).toBe(400)
    // miza iz locB je tuja za locA
    const foreign = await db.table.findFirst({ where: { locationId: locB }, select: { id: true } })
    expect((await combosPUT(req('PUT', '/api/tables/combos', { locationId: locA, combos: [{ tableIds: [tblA, foreign!.id] }] }))).status).toBe(400)
  })

  test('A4: GET izpusti zamujeno kombinacijo z izbrisano mizo (self-healing)', async () => {
    // vrstica z neveljavnim idjem direktno (bypass PUT validacije) — branje ga tiho spusti
    await db.integration.create({
      data: { id: `${P}stale-${RUN}`, name: TABLE_COMBOS_MARKER, type: 'other', provider: 'internal', isActive: true, syncEnabled: false, locationId: locA, config: JSON.stringify({ combos: [{ id: 'stale', tableIds: [tblA, 'izbrisana-miza'] }] }) },
    })
    const g = await combosGET(req('GET', `/api/tables/combos?locationId=${locA}`, undefined))
    const gd = await body(g)
    expect((gd.combos as unknown[]).length).toBe(1) // samo velična [A,B]
    await db.integration.delete({ where: { id: `${P}stale-${RUN}` } })
  })
})

/* ── A · kombinacijska rezervacija (POST) ─────────────────────────────── */

describe('v1.245.0 A · POST kombinacijske rezervacije', () => {
  test('A5: tableIds [A,B] 8 oseb → 201; DB: tableId=A (primarna), comboTableIds ,A,B,', async () => {
    const res = await resvPOST(resvReq({ guestName: `${P}Druzba`, reservedAt: tomorrowAt(19, 0).toISOString(), guests: 8, tableIds: [tblA, tblB] }))
    expect(res.status).toBe(201)
    const d = await body(res)
    const rid = (d.reservation as { id: string }).id
    const row = await db.reservation.findUnique({ where: { id: rid } })
    expect(row?.tableId).toBe(tblA)
    expect(row?.comboTableIds).toBe(`,${tblA},${tblB},`)
    expect((d.reservation as { tableIds: string[] }).tableIds).toEqual([tblA, tblB])
  })

  test('A6: 9 oseb > 8 sedežev kombinacije → 400 (vsota sedežev)', async () => {
    const res = await resvPOST(resvReq({ guestName: `${P}Prevelika`, reservedAt: tomorrowAt(19, 0).toISOString(), guests: 9, tableIds: [tblA, tblB] }))
    expect(res.status).toBe(400)
    const d = await body(res)
    expect(String(d.error || '')).toContain('sedežev')
  })

  test('A7: konflikt ČLANICE: obstoječa single na B 19:00 → kombinacija [A,B] 19:30 → 409 z imenom gosta', async () => {
    const day = new Date(Date.now() + 2 * 24 * 3600_000)
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    const blocker = await mkResv({ tableId: tblB, at, guests: 2 })
    const res = await resvPOST(resvReq({ guestName: `${P}Kombi`, reservedAt: new Date(at.getTime() + 30 * 60_000).toISOString(), guests: 8, tableIds: [tblA, tblB] }))
    expect(res.status).toBe(409)
    const d = await body(res)
    expect(d.code).toBe('TABLE_TIME_CONFLICT')
    const row = await db.reservation.findUnique({ where: { id: blocker } })
    expect(String(d.error || '')).toContain(row?.customerName ?? '?')
    await db.reservation.delete({ where: { id: blocker } })
  })

  test('A8: kombinacija BLOKIRA članico: obstoječa kombinacija [A,B] → nova single na B → 409', async () => {
    const day = new Date(Date.now() + 3 * 24 * 3600_000)
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    await mkResv({ tableIds: [tblA, tblB], at, guests: 8 })
    const res = await resvPOST(resvReq({ guestName: `${P}Solo`, reservedAt: new Date(at.getTime() + 60 * 60_000).toISOString(), guests: 2, tableId: tblB }))
    expect(res.status).toBe(409)
    expect((await body(res)).code).toBe('TABLE_TIME_CONFLICT')
  })

  test('A9: usaditev čakalne vrste na ČLANICO med aktivno kombinacijo → 409 (claim guard podeduje)', async () => {
    const at = new Date(Date.now() + 30 * 60_000)
    await mkResv({ tableIds: [tblC, tblE], at, guests: 8 })
    const eId = `${P}wl-a9-${RUN}`
    await db.waitlistEntry.create({
      data: { id: eId, guestName: `${P}Vrsta`, partySize: 2, status: 'waiting', checkedInAt: new Date(Date.now() - 10 * 60_000), locationId: locA },
    })
    const res = await waitlistPATCH(req('PATCH', '/api/waitlist', { id: eId, status: 'seated', tableId: tblE }))
    expect(res.status).toBe(409)
    await db.waitlistEntry.delete({ where: { id: eId } }).catch(() => null)
  })

  test('A10: enojna pot nespremenjena — comboTableIds je PRAZEN, odgovor tableIds = []', async () => {
    const res = await resvPOST(resvReq({ guestName: `${P}Solo2`, reservedAt: tomorrowAt(20, 0).toISOString(), guests: 2, tableId: tblC }))
    expect(res.status).toBe(201)
    const d = await body(res)
    const rid = (d.reservation as { id: string }).id
    const row = await db.reservation.findUnique({ where: { id: rid } })
    expect(row?.comboTableIds).toBe('')
    expect((d.reservation as { tableIds: string[] }).tableIds).toEqual([])
  })
})

/* ── A · prehodi upravljajo VSE mize ──────────────────────────────────── */

describe('v1.245.0 A · SEATED/CANCELLED upravljata vse mize', () => {
  test('A11: SEATED kombinacija → OBE mizi occupied + actualArrival; CANCELLED → obe sproščeni', async () => {
    const day = new Date(Date.now() + 4 * 24 * 3600_000)
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    // SVEŽ par (F+G) — SEATED claim okno sega od zdaj do konca rezervacije,
    // zato članici ne smeta imeti NOBENE druge rezervacije v tem obsegu
    const res = await resvPOST(resvReq({ guestName: `${P}Prehod`, reservedAt: at.toISOString(), guests: 8, tableIds: [tblF, tblG] }))
    expect(res.status).toBe(201)
    const rid = ((await body(res)).reservation as { id: string }).id

    const seated = await resvPATCH(req('PATCH', '/api/reservations', { id: rid, status: 'SEATED' }))
    expect(seated.status).toBe(200)
    const tF = await db.table.findUnique({ where: { id: tblF } })
    const tG = await db.table.findUnique({ where: { id: tblG } })
    expect(tF?.status).toBe('occupied')
    expect(tG?.status).toBe('occupied')
    const row1 = await db.reservation.findUnique({ where: { id: rid } })
    expect(row1?.actualArrival).not.toBeNull()

    const cancelled = await resvPATCH(req('PATCH', '/api/reservations', { id: rid, status: 'CANCELLED' }))
    expect(cancelled.status).toBe(200)
    const tF2 = await db.table.findUnique({ where: { id: tblF } })
    const tG2 = await db.table.findUnique({ where: { id: tblG } })
    expect(tF2?.status).toBe('available')
    expect(tG2?.status).toBe('available')
    const audits = await db.auditLog.count({ where: { action: 'RESERVATION_TABLE_RELEASED', entityId: rid } })
    expect(audits).toBeGreaterThanOrEqual(2) // ena revizija PER sproščena miza
  })
})

/* ── A · čisti helperji ──────────────────────────────────────────────── */

describe('v1.245.0 A · čisti helperji (lib/table-combos)', () => {
  test('A12: comboTableIdsOf/parseComboTableIds roundtrip + dedupe + prazno', () => {
    expect(comboTableIdsOf(['a', 'b', 'a'])).toBe(',a,b,')
    expect(parseComboTableIds(',a,b,')).toEqual(['a', 'b'])
    expect(parseComboTableIds('')).toEqual([])
    expect(parseComboTableIds(null)).toEqual([])
    expect(parseComboTableIds(comboTableIdsOf(['x']))).toEqual(['x'])
  })

  test('A13: parseCombos/parseBookableExcluded defenzivno (JSON niz + smeti)', () => {
    expect(parseCombos('{"combos":[{"id":"c1","tableIds":["a","b"]}]}')).toEqual([{ id: 'c1', tableIds: ['a', 'b'] }])
    expect(parseCombos(null)).toEqual([])
    expect(parseCombos('ne-veljavno')).toEqual([])
    expect(parseCombos({ combos: [{ id: 'c1', tableIds: ['samo-ena'] }] })).toEqual([]) // < 2 mize
    expect(parseBookableExcluded('{"excludedTableIds":["a","a","b"]}')).toEqual(['a', 'b'])
    expect(parseBookableExcluded(null)).toEqual([])
  })

  test('A14: seatCandidatesForParty — družba 8 nad max 6 → kombinacija; članica zasedena → izpade; najmanjša prva', () => {
    const tables = [
      { id: 't4a', number: 1, name: 'Miza 1', seats: 4, locationId: 'L1' },
      { id: 't4b', number: 2, name: 'Miza 2', seats: 4, locationId: 'L1' },
      { id: 't6', number: 3, name: 'Miza 3', seats: 6, locationId: 'L1' },
    ]
    const combos = [{ id: 'c12', tableIds: ['t4a', 't4b'] }]
    // enojne ne sežejo 8; kombinacija 4+4=8 DA
    const out = seatCandidatesForParty({ tables, combos, party: 8, busyTableIds: new Set(), locationId: 'L1' })
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe('Miza 1+2')
    expect(out[0].seats).toBe(8)
    expect(out[0].comboId).toBe('c12')
    // zasedena članica → kombinacija izpade
    const out2 = seatCandidatesForParty({ tables, combos, party: 8, busyTableIds: new Set(['t4a']), locationId: 'L1' })
    expect(out2).toHaveLength(0)
    // družba 4: enojna 4 je pred kombinacijo (najmanjša prva)
    const out3 = seatCandidatesForParty({ tables, combos, party: 4, busyTableIds: new Set(), locationId: 'L1' })
    expect(out3[0].tableIds).toEqual(['t4a'])
    expect(out3[0].comboId).toBeNull()
  })
})

/* ── B · walk-in rezerva (spletna kapaciteta) ─────────────────────────── */

describe('v1.245.0 B · walk-in rezerva (onlineSeatsFor)', () => {
  test('B1: izključitev mize zmanjša SPLETNO kapaciteto, fizična ostane', async () => {
    const physicalBefore = await tableSeatsFor(locB)
    const onlineBefore = await onlineSeatsFor(locB)
    expect(onlineBefore.seats).toBe(physicalBefore)
    expect(onlineBefore.excluded).toEqual([])

    const first = await db.table.findFirst({ where: { locationId: locB }, select: { id: true } })
    await db.integration.create({
      data: { id: `${P}bookable-${RUN}`, name: RESV_BOOKABLE_MARKER, type: 'other', provider: 'internal', isActive: true, syncEnabled: false, locationId: locB, config: JSON.stringify({ excludedTableIds: [first!.id] }) },
    })
    const onlineAfter = await onlineSeatsFor(locB)
    expect(onlineAfter.seats).toBe(physicalBefore - 4) // ena miza = 4 sedeži
    expect(onlineAfter.excluded).toEqual([first!.id])
    const physicalAfter = await tableSeatsFor(locB)
    expect(physicalAfter).toBe(physicalBefore) // fizična nespremenjena
  })

  test('B2: interna pot NI omejena — telefonska rezervacija na izključeni mizi → 201', async () => {
    const first = await db.table.findFirst({ where: { locationId: locB }, select: { id: true } })
    const res = await resvPOST(req('POST', '/api/reservations', {
      locationId: locB, guestName: `${P}Telefon`, reservedAt: tomorrowAt(18, 0).toISOString(), guests: 2, tableId: first!.id,
    }, tokenB))
    expect(res.status).toBe(201)
  })
})

/* ── Ž · registri (verzija, dokumenti, DDL, i18n, viri) ──────────────── */

describe('v1.245.0 Ž · verzija in dokumenti', () => {
  test('Ž1: APP_VERSION dvignjena na 1.245.0', () => {
    expect(APP_VERSION).toBe('1.281.0')
  })

  test('Ž2: PRIMERJAVA §19 dokumentira kombinacijski val', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 19. Raziskava november 2026 — KOMBINACIJSKI VAL v1.245.0')
    expect(doc).toContain('table combinations')
    expect(doc).toContain('comboTableIds')
  })

  test('Ž3: i18n — novi ključi v SL in HR (pariteta 3968/3968)', () => {
    const keys = [
      'resv.comboTitle', 'resv.comboHint', 'resv.comboAdd', 'resv.comboRemove',
      'resv.comboEmpty', 'resv.comboSeats', 'resv.comboSaved', 'resv.comboAutoOk',
      'resv.bookableTitle', 'resv.bookableHint', 'resv.bookableAll',
      'mig.reservationCombo.desc',
    ]
    for (const k of keys) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    expect(Object.keys(sl).length).toBe(Object.keys(hr).length)
  })

  test('Ž4: DDL ritual — KNOWN_DRIFTS vnos + matcher + mig ruta + konzola + probe', () => {
    expect(KNOWN_DRIFTS.some((d) => d.id === 'reservation-combo')).toBe(true)
    expect(isReservationComboStatement('ALTER TABLE "Reservation" ADD COLUMN "comboTableIds" TEXT NOT NULL DEFAULT \'\'')).toBe(true)
    expect(isReservationComboStatement('ALTER TABLE "Reservation" DROP COLUMN "comboTableIds"')).toBe(false)
    expect(isReservationComboStatement('ALTER TABLE "Order" ADD COLUMN "comboTableIds" TEXT')).toBe(false)
    const route = read('src/app/api/admin/migrate-reservation-combo/route.ts')
    expect(route).toContain('SCHEMA_MIGRATION_RESERVATION_COMBO')
    const migrations = read('src/app/api/admin/migrations/route.ts')
    expect(migrations).toContain("'reservation-combo': reservationComboPOST")
    const schemaMig = read('src/lib/schema-migrations.ts')
    expect(schemaMig).toContain("columnExists('Reservation', 'comboTableIds')")
    const shema = read('prisma/schema.prisma')
    expect(shema).toContain('comboTableIds')
  })

  test('Ž5: dashboard ima vse plasti vala (combo select, avtododelitev, kartica, badge, overlay)', () => {
    const dash = read('src/app/dashboard/page.tsx')
    expect(dash).toContain('seatCandidatesForParty')
    expect(dash).toContain('combo:')
    expect(dash).toContain('ReservationCombosCard')
    expect(dash).toContain('tableCombos')
    const card = read('src/components/tabs/reservation-combos-card.tsx')
    expect(card).toContain('/api/tables/combos')
    expect(card).toContain('resv.comboTitle')
    const claim = read('src/lib/table-claim.ts')
    expect(claim).toContain('comboTableIds: { contains:')
  })

  test('Ž6: worklog vrhnji vnos nosi Task ID v1.245.0', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.281.0-oss-potrditev')
  })
})
