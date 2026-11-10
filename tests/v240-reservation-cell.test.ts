/**
 * v1.240.0 — REZERVACIJSKA CELICA (PRIMERJAVA-VMESNIKOV-2026 §16 E, B-načrta 1+2).
 *
 * Tri vrzeli, en val:
 *  A · STREŽNIŠKI prekrivni pogoj terminov na mizi — @@unique([tableId,
 *    dateTime]) je zavrnjal SAMO identičen žig: 19:00 (120 min) in 20:00 na
 *    isti mizi sta obe uspeli (UI autoAssign je znal preskočiti, strežnik ne).
 *  B · assertTableClaimable — skupni varovalec zasedenosti mize (fizična +
 *    rezervacijska plast): usaditev čakalne vrste je lahko povozila mizo z
 *    rezervacijo, ki se začne čez 30 min.
 *  C–E · prehodi rezervacij upravljajo mizo (SEATED zaklep + actualArrival;
 *    NO_SHOW/CANCELLED/COMPLETED varna sprostitev) + tables PATCH varovalec
 *    ročne zasedbe z izrecnim preglasilom (force).
 *
 * Predpona fiksatur `v240-`; cleanup v afterAll (obratna smer FK).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as resvPOST, PATCH as resvPATCH } from '../src/app/api/reservations/route'
import { PATCH as waitlistPATCH } from '../src/app/api/waitlist/route'
import { PATCH as tablePATCH } from '../src/app/api/tables/[id]/route'
import { assertTableClaimable, findTableReservationConflict, CLAIM_WINDOW_MIN } from '../src/lib/table-claim'
import { APP_VERSION } from '../src/lib/version'
import { readFileSync } from 'fs'
import { join } from 'path'

const P = 'v240-'
const RUN = Date.now().toString(36)
const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

let locA = ''
let mgrId = ''
let token = ''

// mize
let tblMain = ''      // A-series: overlap testi
let tblSecond = ''    // A2: druga miza isti čas
let tblClaim = ''     // B/C: claim testi
let tblOccupied = ''  // C3/D2: fizično zasedena (z naročilom)
let tblRelres = ''    // D3: miza v statusu 'reserved'
let tblRelocc = ''    // D4: miza occupied z aktivnim naročilom
let tblForce = ''     // E: force override testi

function resvReq(body: unknown, tok: string | null = token): NextRequest {
  return new NextRequest('http://localhost:3000/api/reservations', {
    method: 'POST',
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ locationId: locA, ...body }),
  })
}

function resvPatch(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/reservations', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function wlReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/waitlist', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Klic tables/[id] PATCH z dinamičnim kontekstom (vzorec v239: params Promise). */
function callTable(id: string, body: unknown): Promise<Response> {
  return tablePATCH(
    new NextRequest(`http://localhost:3000/api/tables/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

async function mkResv(opts: {
  tableId?: string | null
  at: Date
  duration?: number
  status?: string
  name?: string
}): Promise<string> {
  const id = `${P}rsv-${Math.random().toString(36).slice(2, 10)}-${RUN}`
  await db.reservation.create({
    data: {
      id,
      customerName: opts.name ?? `${P}Gost`,
      customerPhone: '',
      dateTime: opts.at,
      partySize: 2,
      duration: opts.duration ?? 120,
      status: (opts.status ?? 'confirmed') as never,
      source: 'walk_in' as never,
      locationId: locA,
      ...(opts.tableId ? { tableId: opts.tableId } : {}),
    },
  })
  return id
}

beforeAll(async () => {
  // v1.290.0 repni vhod: široki klic (po vzorcu centralnih klicev v283–v288) —
  // repna datoteka počisti ostanke datotek pred sabo + rep prejšnjega teka
  // (TEST_PREFIXES vsebuje tudi lastno predpono — ozek klic je podmnožica).
  await sweepTestFixtures(db, TEST_PREFIXES)

  const a = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Lokacija A`, code: `V240A-${RUN.toUpperCase()}`, premisesId: `v240-premA-${RUN}` } })
  locA = a.id

  mgrId = `${P}mgr-${RUN}`
  const pin = employeePinFields('v240-pin-1234', `${P}mgr-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: mgrId, name: `${P}Vodja`, email: `${P}mgr-${RUN}@test.local`,
      role: 'manager', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pin.pin, pinLookup: pin.pinLookup,
    },
  })
  token = createToken({ sub: mgrId, name: `${P}Vodja`, role: 'manager', loc: locA, sv: 0 })

  tblMain = `${P}tbl-main-${RUN}`
  tblSecond = `${P}tbl-2-${RUN}`
  tblClaim = `${P}tbl-claim-${RUN}`
  tblOccupied = `${P}tbl-occ-${RUN}`
  tblRelres = `${P}tbl-relres-${RUN}`
  tblRelocc = `${P}tblo-relocc-${RUN}`
  tblForce = `${P}tbl-force-${RUN}`
  const N = 6310
  await db.table.createMany({
    data: [
      { id: tblMain, number: N + 1, locationId: locA, status: 'available' },
      { id: tblSecond, number: N + 2, locationId: locA, status: 'available' },
      { id: tblClaim, number: N + 3, locationId: locA, status: 'available' },
      { id: tblOccupied, number: N + 4, locationId: locA, status: 'occupied' },
      { id: tblRelres, number: N + 5, locationId: locA, status: 'reserved' },
      { id: tblRelocc, number: N + 6, locationId: locA, status: 'available' },
      { id: tblForce, number: N + 7, locationId: locA, status: 'available' },
    ],
  })

  await db.order.create({
    data: {
      id: `${P}ord-occ-${RUN}`, orderNumber: 963101, locationId: locA, tableId: tblOccupied,
      status: 'open', paymentStatus: 'unpaid', subtotal: 10, tax: 2.2, total: 12.2,
    },
  })
})

afterAll(async () => {
  await db.order.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.reservation.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.waitlistEntry.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.table.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.counter.deleteMany({ where: { name: { startsWith: `resvslot:` } } }).catch(() => null)
  // v1.290.0 repni izhod: široki klic — javni widget POST /api/reservations
  // piše Reservation z nid() id-jem (predpona v customerName; izhodišče: 6
  // vrstic v repu), ki ga zgornji afterAll ne vidi; rep suite po teku = 0
  // neodvisno od readdir reda.
  await sweepTestFixtures(db, TEST_PREFIXES)
})

/* ── A · strežniški prekrivni pogoj terminov (POST) ─────────────────────── */

describe('v1.240.0 A · POST overlap terminov na mizi', () => {
  test('A1: 19:00 (120 min) nato 20:00 ista miza → 409 z imenom gosta in terminom', async () => {
    const day = new Date(Date.now() + 24 * 3600_000)
    const at1900 = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    const at2000 = new Date(at1900.getTime() + 60 * 60_000)

    const r1 = await resvPOST(resvReq({ guestName: `${P}Ana`, reservedAt: at1900.toISOString(), tableId: tblMain, guests: 2 }))
    expect(r1.status).toBe(201)
    const r2 = await resvPOST(resvReq({ guestName: `${P}Bor`, reservedAt: at2000.toISOString(), tableId: tblMain, guests: 2 }))
    expect(r2.status).toBe(409)
    const body = (await r2.json()) as { error?: string; code?: string }
    expect(body.code).toBe('TABLE_TIME_CONFLICT')
    expect(String(body.error || '')).toContain(`${P}Ana`)
    expect(String(body.error || '')).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/)
  })

  test('A2: druga miza isti čas → 201 (prekrivanje je per-miza, ne globalno)', async () => {
    const day = new Date(Date.now() + 2 * 24 * 3600_000)
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    await mkResv({ tableId: tblMain, at })
    const r = await resvPOST(resvReq({ guestName: `${P}Cilka`, reservedAt: at.toISOString(), tableId: tblSecond, guests: 2 }))
    expect(r.status).toBe(201)
  })

  test('A3: ista miza naslednji dan isto uro → 201 (interval ne seže čez dan)', async () => {
    const day = new Date(Date.now() + 3 * 24 * 3600_000)
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    await mkResv({ tableId: tblMain, at })
    const next = new Date(at.getTime() + 24 * 3600_000)
    const r = await resvPOST(resvReq({ guestName: `${P}Denis`, reservedAt: next.toISOString(), tableId: tblMain, guests: 2 }))
    expect(r.status).toBe(201)
  })

  test('A4: točno ob koncu obstoječega intervala (21:00 po 19:00+120) → 201 (polodprti [s,e))', async () => {
    const day = new Date(Date.now() + 4 * 24 * 3600_000)
    const at1900 = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    await mkResv({ tableId: tblSecond, at: at1900, duration: 120 })
    const at2100 = new Date(at1900.getTime() + 120 * 60_000)
    const r = await resvPOST(resvReq({ guestName: `${P}Eva`, reservedAt: at2100.toISOString(), tableId: tblSecond, guests: 2 }))
    expect(r.status).toBe(201)
  })

  test('A5: brez mize → 201 (nedotaknjena pot; kapaciteta je widget plast)', async () => {
    const day = new Date(Date.now() + 5 * 24 * 3600_000)
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    await mkResv({ at })
    const r = await resvPOST(resvReq({ guestName: `${P}Franci`, reservedAt: at.toISOString(), guests: 4 }))
    expect(r.status).toBe(201)
  })

  test('A6: CANCELLED rezervacija ne zavira prekrivajoče nove na isti mizi → 201', async () => {
    const day = new Date(Date.now() + 6 * 24 * 3600_000)
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 19, 0, 0, 0)
    await mkResv({ tableId: tblMain, at, status: 'cancelled' })
    // 20:00 se prekriva s cancelled 19:00+120 — status NE zavira (identičen žig
    // bi sicer zavrnil @@unique, to pa je prekrivanje intervalov = nova logika)
    const overlapping = new Date(at.getTime() + 60 * 60_000)
    const r = await resvPOST(resvReq({ guestName: `${P}Greta`, reservedAt: overlapping.toISOString(), tableId: tblMain, guests: 2 }))
    expect(r.status).toBe(201)
  })
})

/* ── B · assertTableClaimable (čista enota) ─────────────────────────────── */

describe('v1.240.0 B · assertTableClaimable', () => {
  test('B1: rezervacija, ki se začne znotraj okna [now, now+120) → reservation_conflict', async () => {
    const at = new Date(Date.now() + 30 * 60_000)
    const rid = await mkResv({ tableId: tblClaim, at, duration: 120 })
    const res = await assertTableClaimable(db, { tableId: tblClaim, at: new Date(), durationMin: CLAIM_WINDOW_MIN })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('reservation_conflict')
      expect(res.conflict?.reservationId).toBe(rid)
    }
    await db.reservation.delete({ where: { id: rid } })
  })

  test('B2: rezervacija, ki se začne čez 3 ure → ok (zunaj okna obrata mize)', async () => {
    const at = new Date(Date.now() + 3 * 3600_000)
    const rid = await mkResv({ tableId: tblClaim, at, duration: 120 })
    const res = await assertTableClaimable(db, { tableId: tblClaim, at: new Date(), durationMin: CLAIM_WINDOW_MIN })
    expect(res.ok).toBe(true)
    await db.reservation.delete({ where: { id: rid } })
  })

  test('B3: excludeReservationId izključi lastno rezervacijo (SEATED na lastni)', async () => {
    const at = new Date(Date.now() - 15 * 60_000) // že v teku
    const rid = await mkResv({ tableId: tblClaim, at, duration: 120 })
    const res = await assertTableClaimable(db, {
      tableId: tblClaim, at: new Date(), durationMin: CLAIM_WINDOW_MIN, excludeReservationId: rid,
    })
    expect(res.ok).toBe(true)
    await db.reservation.delete({ where: { id: rid } })
  })

  test('B4: fizično zasedena miza (occupied) → occupied', async () => {
    const res = await assertTableClaimable(db, { tableId: tblOccupied, at: new Date(), durationMin: CLAIM_WINDOW_MIN })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('occupied')
  })

  test('B5: no_show in cancelled ne štejeta kot konflikt', async () => {
    const at1 = new Date(Date.now() + 30 * 60_000)
    const at2 = new Date(Date.now() + 45 * 60_000)
    const r1 = await mkResv({ tableId: tblClaim, at: at1, status: 'no_show' })
    const r2 = await mkResv({ tableId: tblClaim, at: at2, status: 'cancelled' })
    const res = await assertTableClaimable(db, { tableId: tblClaim, at: new Date(), durationMin: CLAIM_WINDOW_MIN })
    expect(res.ok).toBe(true)
    await db.reservation.deleteMany({ where: { id: { in: [r1, r2] } } })
  })

  test('B6: napačna lokacija → wrong_location (fail-closed, brez ugibanja)', async () => {
    const res = await assertTableClaimable(db, { tableId: tblOccupied, expectLocationId: 'tuja-lokacija', at: new Date(), durationMin: CLAIM_WINDOW_MIN })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('wrong_location')
  })

  test('B7: findTableReservationConflict vrača prvi konflikt po času (orderBy dateTime asc)', async () => {
    const base = new Date(Date.now() + 30 * 60_000)
    const r1 = await mkResv({ tableId: tblClaim, at: new Date(base.getTime() + 20 * 60_000), duration: 60 })
    const r2 = await mkResv({ tableId: tblClaim, at: new Date(base.getTime() + 50 * 60_000), duration: 60 })
    const c = await findTableReservationConflict(db, { tableId: tblClaim, at: new Date(), durationMin: CLAIM_WINDOW_MIN })
    expect(c?.reservationId).toBe(r1)
    await db.reservation.deleteMany({ where: { id: { in: [r1, r2] } } })
  })
})

/* ── C · usaditev čakalne vrste ne povozita rezervacije ─────────────────── */

describe('v1.240.0 C · waitlist seat varovalec', () => {
  test('C1: usaditev na mizi z rezervacijo čez 30 min → 409 z razlago', async () => {
    const at = new Date(Date.now() + 30 * 60_000)
    const rid = await mkResv({ tableId: tblClaim, at, name: `${P}Rezerviran` })

    const eId = `${P}wl-c1-${RUN}`
    await db.waitlistEntry.create({
      data: { id: eId, guestName: `${P}Vrsta`, partySize: 2, status: 'waiting', checkedInAt: new Date(Date.now() - 20 * 60_000), locationId: locA },
    })
    const res = await waitlistPATCH(wlReq({ id: eId, status: 'seated', tableId: tblClaim }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string }
    expect(String(body.error || '')).toContain(`${P}Rezerviran`)
    // vnos OSTANE waiting (prehod se ni zgodil) + miza ni bila zasedena
    const rec = await db.waitlistEntry.findUnique({ where: { id: eId } })
    expect(rec?.status).toBe('waiting')
    expect(rec?.tableId).toBeNull()
    const table = await db.table.findUnique({ where: { id: tblClaim } })
    expect(table?.status).toBe('available')
    await db.reservation.delete({ where: { id: rid } }).catch(() => null)
    await db.waitlistEntry.delete({ where: { id: eId } }).catch(() => null)
  })

  test('C2: usaditev na prosti mizi → 200 + miza occupied (nespremenjena pot)', async () => {
    const eId = `${P}wl-c2-${RUN}`
    await db.waitlistEntry.create({
      data: { id: eId, guestName: `${P}Prosti`, partySize: 2, status: 'waiting', checkedInAt: new Date(Date.now() - 10 * 60_000), locationId: locA },
    })
    const res = await waitlistPATCH(wlReq({ id: eId, status: 'seated', tableId: tblSecond }))
    expect(res.status).toBe(200)
    const table = await db.table.findUnique({ where: { id: tblSecond } })
    expect(table?.status).toBe('occupied')
    // povrnemo za kasnejše teste
    await db.table.update({ where: { id: tblSecond }, data: { status: 'available' } })
    await db.waitlistEntry.delete({ where: { id: eId } }).catch(() => null)
  })

  test('C3: usaditev na fizično zasedeni mizi → 409 (obstoječa obramba ostaja)', async () => {
    const eId = `${P}wl-c3-${RUN}`
    await db.waitlistEntry.create({
      data: { id: eId, guestName: `${P}Zasedena`, partySize: 2, status: 'waiting', checkedInAt: new Date(Date.now() - 5 * 60_000), locationId: locA },
    })
    const res = await waitlistPATCH(wlReq({ id: eId, status: 'seated', tableId: tblOccupied }))
    expect(res.status).toBe(409)
    await db.waitlistEntry.delete({ where: { id: eId } }).catch(() => null)
  })
})

/* ── D · prehodi rezervacij upravljajo mizo ─────────────────────────────── */

describe('v1.240.0 D · PATCH reservations: SEATED zaklep + terminalna sprostitev', () => {
  test('D1: SEATED z mizo → 200 + miza occupied + actualArrival + revizija', async () => {
    const at = new Date(Date.now() - 10 * 60_000) // v teku
    const rid = await mkResv({ tableId: tblMain, at, duration: 120, name: `${P}Usajen` })
    const res = await resvPATCH(resvPatch({ id: rid, status: 'SEATED' }))
    expect(res.status).toBe(200)
    const table = await db.table.findUnique({ where: { id: tblMain } })
    expect(table?.status).toBe('occupied')
    const rec = await db.reservation.findUnique({ where: { id: rid } })
    expect(rec?.status).toBe('seated')
    expect(rec?.actualArrival).not.toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'RESERVATION_SEATED_TABLE_LOCKED', entityId: rid } })
    expect(audit).not.toBeNull()
  })

  test('D2: SEATED z mizo, ki je fizično zasedena z naročilom → 409, status ostane confirmed', async () => {
    const at = new Date(Date.now() - 5 * 60_000)
    const rid = await mkResv({ tableId: tblOccupied, at, duration: 120 })
    const res = await resvPATCH(resvPatch({ id: rid, status: 'SEATED' }))
    expect(res.status).toBe(409)
    const rec = await db.reservation.findUnique({ where: { id: rid } })
    expect(rec?.status).toBe('confirmed')
  })

  test('D3: CANCELLED z mizo v statusu reserved → miza available + revizija RESERVATION_TABLE_RELEASED', async () => {
    const at = new Date(Date.now() + 60 * 60_000)
    const rid = await mkResv({ tableId: tblRelres, at, duration: 120 })
    const res = await resvPATCH(resvPatch({ id: rid, status: 'CANCELLED' }))
    expect(res.status).toBe(200)
    const table = await db.table.findUnique({ where: { id: tblRelres } })
    expect(table?.status).toBe('available')
    const rec = await db.reservation.findUnique({ where: { id: rid } })
    expect(rec?.status).toBe('cancelled')
    const audit = await db.auditLog.findFirst({ where: { action: 'RESERVATION_TABLE_RELEASED', entityId: rid } })
    expect(audit).not.toBeNull()
  })

  test('D4: NO_SHOW z mizo occupied + AKTIVNIM naročilom → status no_show, miza OSTANE occupied', async () => {
    const at = new Date(Date.now() + 30 * 60_000)
    const rid = await mkResv({ tableId: tblOccupied, at, duration: 120 })
    const res = await resvPATCH(resvPatch({ id: rid, status: 'NO_SHOW' }))
    expect(res.status).toBe(200)
    const rec = await db.reservation.findUnique({ where: { id: rid } })
    expect(rec?.status).toBe('no_show')
    const table = await db.table.findUnique({ where: { id: tblOccupied } })
    expect(table?.status).toBe('occupied') // ne rušimo tujega gosta z odprtim računom
  })

  test('D5: COMPLETED z mizo occupied BREZ naročila → varna sprostitev (available)', async () => {
    const at = new Date(Date.now() - 30 * 60_000)
    const rid = await mkResv({ tableId: tblRelocc, at, duration: 120 })
    // miza fizično occupied, a brez naročila in brez novejše usaditve
    await db.table.update({ where: { id: tblRelocc }, data: { status: 'occupied' } })
    const res = await resvPATCH(resvPatch({ id: rid, status: 'COMPLETED' }))
    expect(res.status).toBe(200)
    const table = await db.table.findUnique({ where: { id: tblRelocc } })
    expect(table?.status).toBe('available')
  })

  test('D6: prehod brez mize (stara pot) → 200 brez dotikanja miz', async () => {
    const at = new Date(Date.now() + 2 * 3600_000)
    const rid = await mkResv({ at })
    const res = await resvPATCH(resvPatch({ id: rid, status: 'CANCELLED' }))
    expect(res.status).toBe(200)
    const rec = await db.reservation.findUnique({ where: { id: rid } })
    expect(rec?.status).toBe('cancelled')
  })
})

/* ── E · tables PATCH varovalec ročne zasedbe ───────────────────────────── */

describe('v1.240.0 E · tables PATCH: occupied varovalec + force', () => {
  test('E1: occupied na mizi z rezervacijo čez 30 min → 409 overrideRequired + razlaga', async () => {
    const at = new Date(Date.now() + 30 * 60_000)
    const rid = await mkResv({ tableId: tblForce, at, name: `${P}Prihaja` })
    const res = await callTable(tblForce, { status: 'OCCUPIED' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string; overrideRequired?: boolean }
    expect(body.overrideRequired).toBe(true)
    expect(String(body.error || '')).toContain(`${P}Prihaja`)
    const table = await db.table.findUnique({ where: { id: tblForce } })
    expect(table?.status).toBe('available')
    await db.reservation.delete({ where: { id: rid } }).catch(() => null)
  })

  test('E2: occupied z force: true → 200 + miza occupied + revizija TABLE_OCCUPIED_OVERRIDE', async () => {
    const at = new Date(Date.now() + 30 * 60_000)
    const rid = await mkResv({ tableId: tblForce, at })
    const res = await callTable(tblForce, { status: 'OCCUPIED', force: true })
    expect(res.status).toBe(200)
    const table = await db.table.findUnique({ where: { id: tblForce } })
    expect(table?.status).toBe('occupied')
    const audit = await db.auditLog.findFirst({ where: { action: 'TABLE_OCCUPIED_OVERRIDE', entityId: tblForce } })
    expect(audit).not.toBeNull()
    await db.reservation.delete({ where: { id: rid } }).catch(() => null)
  })

  test('E3: FREE in DIRTY brez varovalca (nespremenjena operativna pot)', async () => {
    const r1 = await callTable(tblForce, { status: 'FREE' })
    expect(r1.status).toBe(200)
    const r2 = await callTable(tblForce, { status: 'DIRTY' })
    expect(r2.status).toBe(200)
    const table = await db.table.findUnique({ where: { id: tblForce } })
    expect(table?.status).toBe('cleaning')
  })

  test('E4: occupied → occupied (idempotenten no-op) gre čez brez varovalca', async () => {
    const res = await callTable(tblOccupied, { status: 'OCCUPIED' })
    expect(res.status).toBe(200)
  })
})

/* ── Ž · verzija + dokumentacija ────────────────────────────────────────── */

describe('v1.240.0 Ž · verzija in dokumenti', () => {
  test('Ž1: APP_VERSION dvignjena na 1.240.0', () => {
    expect(APP_VERSION).toBe('1.301.0')
    expect(read('src/lib/version.ts')).toContain("'1.301.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.301.0')
  })

  test('Ž2: PRIMERJAVA §16 G dokumentira rezervacijsko celico', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('REZERVACIJSKA CELICA')
    expect(doc).toContain('assertTableClaimable')
  })

  test('Ž3: nova lib datoteka table-claim.ts na disku z varovalcem', () => {
    const src = read('src/lib/table-claim.ts')
    expect(src).toContain('export async function assertTableClaimable')
    expect(src).toContain('CLAIM_WINDOW_MIN = 120')
    expect(src).toContain("['confirmed', 'seated', 'completed']")
  })
})
