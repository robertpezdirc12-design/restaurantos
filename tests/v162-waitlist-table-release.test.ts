/**
 * v1.162.0 — čakalna vrsta: sprostitev mize, ki jo je zaklenila usaditev.
 *
 * Najdba: PATCH (usaditev) mizo zaklene (`Table.status='occupied'`) v isti
 * transakciji, vendar čakalna vrsta ni imela NOBENE poti, da bi to mizo
 * sprostila — niti ko gost odide niti ko je bila usaditev pomota. Miza je
 * ostala zasedena, dokler je nekdo ni ročno prestavil na tlorisu.
 *
 * Popravek doda eksplicitno dejanje `releaseTable` na PATCH:
 *  - dovoljeno SAMO za usajen vnos z dodeljeno mizo;
 *  - miza se sprosti le, če je še 'occupied', brez aktivnega računa in je nihče
 *    drug ni medtem zasedel prek čakalne vrste (novejši usajen vnos);
 *  - stanje vnosa se NE spremeni (ostane 'seated' — statistika »Usajeni danes«
 *    se ne izgubi), zato je dejanje idempotentno in varno za ponovitev.
 *
 * Predpona fiksatur `v162-`; cleanup v afterAll (obratna smer FK).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { PATCH as waitlistPATCH } from '../src/app/api/waitlist/route'

const P = 'v162-'
const RUN = Date.now().toString(36)

let locA = ''
let locB = ''
let waiterId = ''
let token = ''

let tblFree = ''
let tblOrder = ''
let tblNewer = ''
let tblAvailable = ''
let tblOtherLoc = ''
let tblLegacy = ''

let eFree = ''
let eOrder = ''
let eNewer = ''
let eAvailable = ''
let eWaiting = ''
let eOtherLoc = ''
let eLegacyWaiting = ''

function req(body: unknown, tok: string | null = token): NextRequest {
  return new NextRequest('http://localhost:3000/api/waitlist', {
    method: 'PATCH',
    headers: {
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function entry(status: string, tableId: string | null, seatedMinutesAgo?: number): Promise<string> {
  const id = `${P}wl-${Math.random().toString(36).slice(2, 10)}-${RUN}`
  const now = Date.now()
  await db.waitlistEntry.create({
    data: {
      id,
      guestName: `${P}Gost`,
      partySize: 2,
      status,
      checkedInAt: new Date(now - 40 * 60_000),
      ...(seatedMinutesAgo !== undefined ? { seatedAt: new Date(now - seatedMinutesAgo * 60_000) } : {}),
      tableId,
      locationId: locA,
    },
  })
  return id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])

  const a = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Lokacija A`, code: `V162A-${RUN.toUpperCase()}`, premisesId: `v162-premA-${RUN}` } })
  const b = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Lokacija B`, code: `V162B-${RUN.toUpperCase()}`, premisesId: `v162-premB-${RUN}` } })
  locA = a.id
  locB = b.id

  waiterId = `${P}waiter-${RUN}`
  const pin = employeePinFields('v162-pin-1234', `${P}waiter-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: waiterId, name: `${P}Natakar`, email: `${P}waiter-${RUN}@test.local`,
      role: 'waiter', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pin.pin, pinLookup: pin.pinLookup,
    },
  })
  token = createToken({ sub: waiterId, name: `${P}Natakar`, role: 'waiter', loc: locA, sv: 0 })

  tblFree = `${P}tbl-free-${RUN}`
  tblOrder = `${P}tbl-order-${RUN}`
  tblNewer = `${P}tbl-newer-${RUN}`
  tblAvailable = `${P}tbl-avail-${RUN}`
  tblOtherLoc = `${P}tbl-locb-${RUN}`
  tblLegacy = `${P}tbl-legacy-${RUN}`
  await db.table.createMany({
    data: [
      { id: tblFree, number: 6201, locationId: locA, status: 'occupied' },
      { id: tblOrder, number: 6202, locationId: locA, status: 'occupied' },
      { id: tblNewer, number: 6203, locationId: locA, status: 'occupied' },
      { id: tblAvailable, number: 6204, locationId: locA, status: 'available' },
      { id: tblOtherLoc, number: 6205, locationId: locB, status: 'occupied' },
      { id: tblLegacy, number: 6206, locationId: locA, status: 'occupied' },
    ],
  })

  await db.order.create({
    data: {
      id: `${P}ord-open-${RUN}`, orderNumber: 916201, locationId: locA, tableId: tblOrder,
      status: 'open', paymentStatus: 'unpaid', subtotal: 10, tax: 2.2, total: 12.2,
    },
  })

  eFree = await entry('seated', tblFree, 10)
  eOrder = await entry('seated', tblOrder, 15)
  eNewer = await entry('seated', tblNewer, 20)
  await entry('seated', tblNewer, 5) // novejši usajen gost na isti mizi
  eAvailable = await entry('seated', tblAvailable, 12)
  eWaiting = await entry('waiting', null)
  eOtherLoc = await entry('seated', tblOtherLoc, 10)
  eLegacyWaiting = await entry('waiting', tblLegacy) // legacy/nepravilni zapis: miza pri vnosu, ki še čaka
})

afterAll(async () => {
  await db.order.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.waitlistEntry.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.table.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
})

describe('v1.162.0 — sprostitev mize iz čakalne vrste', () => {
  test('usajen vnos z zasedeno mizo → 200 released:true, miza available, vnos ostane seated + revizija', async () => {
    const res = await waitlistPATCH(req({ id: eFree, releaseTable: true }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { released: boolean; tableId?: string }
    expect(body.released).toBe(true)
    expect(body.tableId).toBe(tblFree)

    const table = await db.table.findUnique({ where: { id: tblFree } })
    expect(table?.status).toBe('available')

    const rec = await db.waitlistEntry.findUnique({ where: { id: eFree } })
    expect(rec?.status).toBe('seated')
    expect(rec?.leftAt).toBeNull()

    const audit = await db.auditLog.findFirst({ where: { action: 'WAITLIST_TABLE_RELEASED', entityId: eFree } })
    expect(audit).not.toBeNull()
  })

  test('miza z odprtim računom → 409 in miza ostane zasedena', async () => {
    const res = await waitlistPATCH(req({ id: eOrder, releaseTable: true }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string }
    expect(String(body.error || '')).toMatch(/odprt račun/i)
    const table = await db.table.findUnique({ where: { id: tblOrder } })
    expect(table?.status).toBe('occupied')
  })

  test('miza je že prosta → 200 released:false (idempotentno, brez napake)', async () => {
    const res = await waitlistPATCH(req({ id: eAvailable, releaseTable: true }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { released: boolean; reason?: string }
    expect(body.released).toBe(false)
    expect(body.reason).toBe('table_not_occupied')
  })

  test('vnos, ki še čaka (brez mize) → 409', async () => {
    const res = await waitlistPATCH(req({ id: eWaiting, releaseTable: true }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string }
    expect(String(body.error || '')).toMatch(/usajen vnos|nima dodeljene mize/i)
  })

  test('mizo je medtem zasedel novejši usajen vnos → 409 (ne ugibaj čigava je)', async () => {
    const res = await waitlistPATCH(req({ id: eNewer, releaseTable: true }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string }
    expect(String(body.error || '')).toMatch(/medtem/i)
    const table = await db.table.findUnique({ where: { id: tblNewer } })
    expect(table?.status).toBe('occupied')
  })

  test('vnos v čakanju z dodeljeno mizo (legacy) → 409 in miza ostane zasedena', async () => {
    const res = await waitlistPATCH(req({ id: eLegacyWaiting, releaseTable: true }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string }
    expect(String(body.error || '')).toMatch(/usajen vnos/i)
    const table = await db.table.findUnique({ where: { id: tblLegacy } })
    expect(table?.status).toBe('occupied')
  })

  test('miza druge lokacije → 409 (tenant meja tudi za legacy zapis)', async () => {
    const res = await waitlistPATCH(req({ id: eOtherLoc, releaseTable: true }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string }
    expect(String(body.error || '')).toMatch(/lokaciji/i)
    const table = await db.table.findUnique({ where: { id: tblOtherLoc } })
    expect(table?.status).toBe('occupied')
  })

  test('brez žetona → 401', async () => {
    const res = await waitlistPATCH(req({ id: eFree, releaseTable: true }, null))
    expect(res.status).toBe(401)
  })
})
