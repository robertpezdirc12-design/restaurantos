/**
 * Issue #61 (P1) — zaključek blagajne: legacy izmena BREZ lokacije mora fail-closed;
 * `locationId: null || undefined` je iz Prisma where-filtra izpustil lokacijsko
 * omejitev in bi Z-poročilo agregiralo RAČUNE VSEH LOKACIJ v oknu. Testi:
 * null-loc izmena → 409 + rollback (izmena ostane odprta, nič ZReport/totals),
 * tudi za centralno vlogo; normalna izmena zajame SAMO račune svoje lokacije.
 * Issue #62 (P1) — timeclock atomarni prehodi: sočasen dvojni clock-in → ena
 * evidenca; CAS break-start/break-end (dvojni break-end NE podvoji minut);
 * clock-out = CAS + izračun + audit v ENI transakciji (zaprta evidenca VEDNO
 * ima zneske); ročni vnos ne ustvari odprte evidence.
 * Issue #63 (P1) — bazen napitnin na (dan, lokacija) je atomaren: dva sočasna
 * POST → NATANKO en bazen + en niz distribucij (drugi 409); vsota delov =
 * totalCents; payout ostane CAS-idempotenten.
 * Issue #60 (P1) — staff-shifts tenant obseg: PATCH/DELETE na null-location
 * legacy izmeni → 403 za navadne vloge (guard se NE preskoči), centralna vloga
 * = izrecen dostop; POST z obvezno lokacijo + org preverba zaposlenega
 * (cross-tenant employeeId → 403, medlokacijsko znotraj iste org dovoljeno);
 * DELETE + audit v isti transakciji.
 *
 * Vzorec: direktni uvoz route handlerjev (race-fixes-p1 / i52) — NextRequest
 * z žetonom createToken; fiksature s predpono `i60-`; sweep beforeAll/afterAll.
 * Žetoni nosijo UI role UPPERCASE ('MANAGER'/'ADMIN'/'WAITER').
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as shiftsPOST } from '../src/app/api/shifts/route'
import { POST as timeclockPOST } from '../src/app/api/timeclock/route'
import { POST as tipsPOST } from '../src/app/api/tips/route'
import { POST as tipsPayoutPOST } from '../src/app/api/tips/payout/route'
import { POST as staffShiftsPOST, PATCH as staffShiftsPATCH, DELETE as staffShiftsDELETE } from '../src/app/api/staff-shifts/route'
import { nid } from '../src/lib/map'

const PREFIX = 'i60-'
const RUN = Date.now().toString(36)

let orgA = '', propA = '', brandA = ''
let orgB = '', propB = '', brandB = ''
let locA1 = '', locA2 = '', locB1 = ''
let managerA = '', adminA = '', empX = '', empA2 = '', empB = '', empNoLoc = '', empManual = ''

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function status(r: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = (await (r as Promise<unknown> | Response)) as Response
  expect(res instanceof Response).toBe(true)
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function seedEmployee(name: string, role: string, loc: string | null, pinSeq: number): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
  const pin = String(10000000 + ([...`${id}${pinSeq}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 89999999, 7)))
  const fields = employeePinFields(pin, `${id}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${name}`, email: `${id}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  return id
}

/* ── naročilo + fiskalni račun (Issue #61) ── */
let ordSeq = 0
async function mkOrder(loc: string): Promise<string> {
  const orderId = `${PREFIX}ord-${++ordSeq}-${RUN}`
  await db.order.create({
    data: {
      id: orderId, orderNumber: 984000 + ordSeq, locationId: loc,
      status: 'paid', paymentStatus: 'paid', type: 'dine-in', employeeId: empX,
    },
  })
  return orderId
}

let rcSeq = 0
async function mkReceipt(loc: string, total: number, createdAt: Date): Promise<string> {
  const orderId = await mkOrder(loc)
  const id = `${PREFIX}rc-${++rcSeq}-${RUN}`
  await db.receipt.create({
    data: {
      id, receiptNumber: `I60-${RUN}-${rcSeq}`, orderId,
      businessName: 'I60 test', businessAddress: 'I60 addr', businessId: 'I60', taxId: 'SI-I60',
      subtotal: total, vatBreakdown: '{}', totalVat: 0, total, paymentMethod: 'cash',
      createdAt, locationId: loc,
    },
  })
  return id
}

/** neposredno odprta izmena (kontroliran openedAt) */
async function mkShift(employeeId: string, locationId: string | null, openedAt: Date): Promise<string> {
  const id = `${PREFIX}shift-${nid().slice(0, 8)}-${RUN}`
  await db.cashRegisterShift.create({
    data: { id, employeeId, employeeName: `${PREFIX}user`, status: 'open', openedAt, startingCash: 50, locationId },
  })
  return id
}

/* ── plačilo z napitnino (Issue #63) ── */
let tipSeq = 0
async function mkTipPayment(loc: string, tipAmount: number, employeeId: string, createdAt: Date): Promise<void> {
  const orderId = await mkOrder(loc)
  const checkId = `${PREFIX}chk-${++tipSeq}-${RUN}`
  await db.check.create({
    data: {
      id: checkId, checkNumber: tipSeq, orderId,
      subtotal: 50, tax: 0, total: 50, tip: tipAmount, totalWithTip: 50 + tipAmount,
      paymentStatus: 'paid', paymentMethod: 'cash',
    },
  })
  await db.payment.create({
    data: {
      id: `${PREFIX}pay-${tipSeq}-${RUN}`, checkId, amount: 50, tipAmount,
      type: 'cash', status: 'completed', employeeId, createdAt,
    },
  })
}

/* ── pripravljena aktivna evidenca (Issue #62, kontroliran prejšnji stanji) ── */
async function mkOpenEntry(employeeId: string, opts: { clockInAgoMin?: number; breakStartAgoMin?: number | null; breakMinutes?: number; payRate?: number } = {}): Promise<string> {
  const now = Date.now()
  const id = `${PREFIX}te-${nid().slice(0, 8)}-${RUN}`
  await db.timeEntry.create({
    data: {
      id, employeeId,
      clockIn: new Date(now - (opts.clockInAgoMin ?? 60) * 60_000),
      clockOut: null,
      breakStart: opts.breakStartAgoMin != null ? new Date(now - opts.breakStartAgoMin * 60_000) : null,
      breakEnd: null,
      breakMinutes: opts.breakMinutes ?? 0,
      payRate: opts.payRate ?? 0,
      totalPay: 0,
      type: 'regular', status: 'active', notes: '', locationId: locA1,
    },
  })
  return id
}

const timeclockAuditCount = (employeeId: string, action: string) =>
  db.auditLog.count({ where: { userId: employeeId, action } })

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locA1 = `${PREFIX}locA1-${RUN}`; locA2 = `${PREFIX}locA2-${RUN}`; locB1 = `${PREFIX}locB1-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'I60 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: 'I60 Org B', slug: `${PREFIX}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'I60 BA' } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'I60 BB' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'I60 PA' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'I60 PB' } })
  await db.location.create({ data: { id: locA1, name: 'I60 A1', code: `${PREFIX}A1-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locA2, name: 'I60 A2', code: `${PREFIX}A2-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB1, name: 'I60 B1', code: `${PREFIX}B1-${RUN}`, propertyId: propB } })

  managerA = await seedEmployee('managerA', 'manager', locA1, 1)
  adminA = await seedEmployee('adminA', 'admin', locA1, 2)
  empX = await seedEmployee('empX', 'waiter', locA1, 3)
  empA2 = await seedEmployee('empA2', 'waiter', locA2, 4)
  empB = await seedEmployee('empB', 'waiter', locB1, 5)
  empNoLoc = await seedEmployee('empNoLoc', 'waiter', null, 6)
  empManual = await seedEmployee('empManual', 'waiter', locA1, 7)
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #61 — zaključek blagajne: null-location izmena ne sme agregirati vseh
// ════════════════════════════════════════════════════════════════════════════
describe('#61 shifts stop — legacy null-loc izmena fail-closed', () => {
  const jan = new Date('2020-01-15T10:00:00Z')
  const feb = new Date('2020-02-15T10:00:00Z')

  it('MANAGER: stop null-loc izmene → 409, BREZ ZReport, izmena ostane ODPRTA (rollback claima)', async () => {
    // računa na A1 in B1 v oknu januarske izmene — če bi null-loc prišel do
    // agregacije, bi Z-poročilo seštevalo A+B (150)
    await mkReceipt(locA1, 100, new Date('2020-01-15T10:05:00Z'))
    await mkReceipt(locB1, 50, new Date('2020-01-15T10:06:00Z'))
    const shiftId = await mkShift(managerA, null, jan)
    const r = await status(shiftsPOST(req('/api/shifts', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'POST', { action: 'stop', closingCash: 100 })))
    expect(r.code).toBe(409)
    expect(String(r.body.error)).toMatch(/lokacij/i)
    // rollback celote: izmena še vedno odprta, closedAt/totals nespremenjeni
    const shift = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(shift?.status).toBe('open')
    expect(shift?.closedAt).toBeNull()
    expect(shift?.totalSales?.toString()).toBe('0')
    // NIČ Z-poročila za to izmeno (niti globalnega niti lokacijskega)
    expect(await db.zReport.count({ where: { openedAt: jan } })).toBe(0)
  })

  it('centralna ADMIN vloga: stop null-loc izmene → 409 (ni implicitnega globalnega poročila)', async () => {
    const shiftId = await mkShift(adminA, null, new Date('2020-03-15T10:00:00Z'))
    const r = await status(shiftsPOST(req('/api/shifts', tok(adminA, `${PREFIX}a`, 'ADMIN', locA1), 'POST', { action: 'stop', closingCash: 0 })))
    expect(r.code).toBe(409)
    expect(String(r.body.error)).toMatch(/lokacij/i)
    const shift = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(shift?.status).toBe('open')
  })

  it('normalna izmena A1 zajame SAMO račune A1 (ne B1) — filter zavezujoč v vseh poizvedbah', async () => {
    await mkReceipt(locA1, 100, new Date('2020-02-15T10:05:00Z'))
    await mkReceipt(locB1, 50, new Date('2020-02-15T10:06:00Z'))
    const shiftId = await mkShift(managerA, locA1, feb) // novejša od januarske (findFirst po openedAt desc)
    const r = await status(shiftsPOST(req('/api/shifts', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'POST', { action: 'stop', closingCash: 150 })))
    expect(r.code).toBe(200)
    const z = r.body.zReport as Record<string, unknown>
    expect(z.totalSales).toBe(100) // SAMO A1; brez B1 (prej bi null || undefined vzel oba)
    expect(z.receipts).toBe(1)
    const zr = await db.zReport.findFirst({ where: { openedAt: feb } })
    expect(zr?.locationId).toBe(locA1)
    expect(zr?.totalSales?.toString()).toBe('100')
    expect(zr?.totalOrders).toBe(1)
    const shift = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
    expect(shift?.status).toBe('closed')
    expect(shift?.cashSales?.toString()).toBe('100')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #62 — timeclock: atomarni prehodi
// ════════════════════════════════════════════════════════════════════════════
describe('#62 timeclock — atomarni clock-in / break / clock-out', () => {
  it('dva SOČASNA clock-in → [201, 409]; NATANKO ena odprta evidenca + en audit', async () => {
    const empTok = tok(empX, `${PREFIX}x`, 'WAITER', locA1)
    const results = await Promise.all([
      status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'clock-in' }))),
      status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'clock-in' }))),
    ])
    const codes = results.map((r) => r.code).sort()
    expect(codes).toEqual([201, 409])
    const open = await db.timeEntry.findMany({ where: { employeeId: empX, clockOut: null } })
    expect(open.length).toBe(1) // prej: 2 (check-then-create brez atomarnosti)
    expect(await timeclockAuditCount(empX, 'TIMECLOCK_IN')).toBe(1)
    // počistimo vnose, da ne vplivajo na nadaljnje timeclock teste
    await db.auditLog.deleteMany({ where: { userId: empX } })
    await db.timeEntry.deleteMany({ where: { employeeId: empX } })
  })

  it('drugi break-start po KONČANEM odmoru → 200 (zaporedje ostane delujoče)', async () => {
    const entryId = await mkOpenEntry(empX, { breakStartAgoMin: 30, breakMinutes: 5 })
    const empTok = tok(empX, `${PREFIX}x`, 'WAITER', locA1)
    const end = await status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'break-end' })))
    expect(end.code).toBe(200)
    const second = await status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'break-start' })))
    expect(second.code).toBe(200)
    const e = await db.timeEntry.findUnique({ where: { id: entryId } })
    expect(e?.breakStart).not.toBeNull()
    expect(e?.breakEnd).toBeNull()
    await db.timeEntry.deleteMany({ where: { employeeId: empX } })
  })

  it('dva SOČASNA break-start → [200, 409]; breakStart zapisan NATANKO enkrat', async () => {
    await mkOpenEntry(empX, {})
    const empTok = tok(empX, `${PREFIX}x`, 'WAITER', locA1)
    const results = await Promise.all([
      status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'break-start' }))),
      status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'break-start' }))),
    ])
    expect(results.map((r) => r.code).sort()).toEqual([200, 409])
    const entries = await db.timeEntry.findMany({ where: { employeeId: empX, clockOut: null } })
    expect(entries.length).toBe(1)
    expect(entries[0].breakStart).not.toBeNull()
    await db.timeEntry.deleteMany({ where: { employeeId: empX } })
  })

  it('dva SOČASNA break-end → [200, 409]; trajanje prišteto NATANKO enkrat (15, ne 25)', async () => {
    // breakStart pred 10 min, breakMinutes 5 → zmagovalni break-end prišteje 10
    await mkOpenEntry(empX, { breakStartAgoMin: 10, breakMinutes: 5 })
    const empTok = tok(empX, `${PREFIX}x`, 'WAITER', locA1)
    const results = await Promise.all([
      status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'break-end' }))),
      status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'break-end' }))),
    ])
    expect(results.map((r) => r.code).sort()).toEqual([200, 409])
    const e = await db.timeEntry.findFirst({ where: { employeeId: empX, clockOut: null } })
    expect(e?.breakEnd).not.toBeNull()
    expect(e?.breakMinutes).toBe(15) // 5 + 10; dvojni increment bi dal 25
    await db.timeEntry.deleteMany({ where: { employeeId: empX } })
  })

  it('dva SOČASNA clock-out → [200, 409]; zmagovalec ima izračunane zneske, en audit', async () => {
    // 60 min izmene, odmor 5 min + odprt odmor 10 min, plačilo 20 €/h
    await mkOpenEntry(empX, { clockInAgoMin: 60, breakStartAgoMin: 10, breakMinutes: 5, payRate: 20 })
    const empTok = tok(empX, `${PREFIX}x`, 'WAITER', locA1)
    const results = await Promise.all([
      status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'clock-out' }))),
      status(timeclockPOST(req('/api/timeclock', empTok, 'POST', { action: 'clock-out' }))),
    ])
    expect(results.map((r) => r.code).sort()).toEqual([200, 409])
    const e = await db.timeEntry.findFirst({ where: { employeeId: empX } })
    expect(e?.clockOut).not.toBeNull()
    // FRESH izračun znotraj transakcije: breakMinutes 5+10=15, minute 60-15=45, plačilo 15.00
    expect(e?.breakMinutes).toBe(15)
    expect(e?.totalMinutes).toBe(45)
    expect(e?.totalPay?.toString()).toBe('15')
    expect(await timeclockAuditCount(empX, 'TIMECLOCK_OUT')).toBe(1)
    await db.auditLog.deleteMany({ where: { userId: empX } })
    await db.timeEntry.deleteMany({ where: { employeeId: empX } })
  })

  it('ročni vnos (employees.manage) NE ustvari odprte evidence', async () => {
    const now = Date.now()
    const r = await status(timeclockPOST(req('/api/timeclock', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'POST', {
      action: 'manual', employeeId: empManual,
      clockIn: new Date(now - 120 * 60_000).toISOString(),
      clockOut: new Date(now - 60 * 60_000).toISOString(),
      breakMinutes: 10, type: 'regular', note: 'I60 popravek',
    })))
    expect(r.code).toBe(201)
    expect(await db.timeEntry.count({ where: { employeeId: empManual, clockOut: null } })).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #63 — bazen napitnin: atomaren na (dan, lokacija)
// ════════════════════════════════════════════════════════════════════════════
describe('#63 tips — en atomaren bazen na dan + lokacijo', () => {
  const date = '2030-01-15'
  const range = { from: new Date(`${date}T00:00:00.000Z`), to: new Date('2030-01-16T00:00:00.000Z') }

  it('dva SOČASNA POST za isti dan+lokacijo → [201, 409]; NATANKO en bazen, vsota delov = total', async () => {
    await mkTipPayment(locA1, 12, empX, new Date(`${date}T12:00:00Z`))
    const mTok = tok(managerA, `${PREFIX}m`, 'MANAGER', locA1)
    const results = await Promise.all([
      status(tipsPOST(req('/api/tips', mTok, 'POST', { date, method: 'hours' }))),
      status(tipsPOST(req('/api/tips', mTok, 'POST', { date, method: 'hours' }))),
    ])
    expect(results.map((r) => r.code).sort()).toEqual([201, 409])
    const pools = await db.tipPool.findMany({ where: { date: { gte: range.from, lt: range.to }, locationId: locA1 } })
    expect(pools.length).toBe(1) // prej: 2 (findFirst izven transakcije)
    const dists = await db.tipDistribution.findMany({ where: { tipPoolId: pools[0].id } })
    expect(dists.length).toBe(1)
    const sumCents = Math.round(dists.reduce((a, d) => a + Number(d.amount) * 100, 0))
    expect(sumCents).toBe(1200)
    expect(Math.round(Number(pools[0].totalTips) * 100)).toBe(1200)
    expect(pools[0].status).toBe('pending')
  })

  it('druga lokacija (ista org, centralna vloga) → ločen bazen (2 skupaj, vsak svoj locationId)', async () => {
    await mkTipPayment(locA2, 5, empA2, new Date(`${date}T13:00:00Z`))
    const r = await status(tipsPOST(req('/api/tips', tok(adminA, `${PREFIX}a`, 'ADMIN', locA1), 'POST', { date, method: 'hours', locationId: locA2 })))
    expect(r.code).toBe(201)
    const both = await db.tipPool.findMany({ where: { locationId: { in: [locA1, locA2] }, date: { gte: range.from, lt: range.to } } })
    expect(both.length).toBe(2)
    expect(both.filter((p) => p.locationId === locA1).length).toBe(1)
    expect(both.filter((p) => p.locationId === locA2).length).toBe(1)
    expect(Math.round(Number(both.find((p) => p.locationId === locA2)!.totalTips) * 100)).toBe(500)
  })

  it('dva SOČASNA payout istega bazena → [200, 409]; distribucija izplačana ENKRAT', async () => {
    const pool = (await db.tipPool.findFirst({ where: { locationId: locA1, date: { gte: range.from, lt: range.to } } }))!
    const mTok = tok(managerA, `${PREFIX}m`, 'MANAGER', locA1)
    const results = await Promise.all([
      status(tipsPayoutPOST(req('/api/tips/payout', mTok, 'POST', { poolId: pool.id }))),
      status(tipsPayoutPOST(req('/api/tips/payout', mTok, 'POST', { poolId: pool.id }))),
    ])
    expect(results.map((r) => r.code).sort()).toEqual([200, 409])
    const dists = await db.tipDistribution.findMany({ where: { tipPoolId: pool.id } })
    expect(dists.every((d) => d.status === 'paid' && d.paidAt !== null)).toBe(true)
    const after = await db.tipPool.findUnique({ where: { id: pool.id } })
    expect(after?.status).toBe('paid')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Issue #60 — staff-shifts: tenant obseg + fail-closed na null lokaciji
// ════════════════════════════════════════════════════════════════════════════
describe('#60 staff-shifts — null-loc guard, org obseg zaposlenega, atomarni DELETE', () => {
  let legacyNullLoc = ''

  beforeAll(async () => {
    legacyNullLoc = `${PREFIX}ss-null-${RUN}`
    await db.staffShift.create({
      data: {
        id: legacyNullLoc, employeeId: empX, shiftDate: new Date('2031-01-10T00:00:00Z'),
        shiftType: 'full', startTime: '10:00', endTime: '18:00',
        locationId: null, role: 'waiter', status: 'scheduled', breakMinutes: 0, notes: 'I60 legacy',
      },
    })
  })

  it('MANAGER: PATCH null-loc izmene → 403; zapis NESPREMENJEN; brez audita', async () => {
    const r = await status(staffShiftsPATCH(req('/api/staff-shifts', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'PATCH', { id: legacyNullLoc, notes: 'hacked' })))
    expect(r.code).toBe(403)
    const s = await db.staffShift.findUnique({ where: { id: legacyNullLoc } })
    expect(s?.notes).toBe('I60 legacy')
    expect(await db.auditLog.count({ where: { action: 'STAFF_SHIFT_UPDATE', entityId: legacyNullLoc } })).toBe(0)
  })

  it('MANAGER: DELETE null-loc izmene → 403; zapis OHRANJEN', async () => {
    const r = await status(staffShiftsDELETE(req('/api/staff-shifts', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'DELETE', { id: legacyNullLoc })))
    expect(r.code).toBe(403)
    expect(await db.staffShift.findUnique({ where: { id: legacyNullLoc } })).not.toBeNull()
  })

  it('centralna ADMIN: PATCH null-loc izmene → 200 (izrecen centralni dostop)', async () => {
    const r = await status(staffShiftsPATCH(req('/api/staff-shifts', tok(adminA, `${PREFIX}a`, 'ADMIN', locA1), 'PATCH', { id: legacyNullLoc, status: 'confirmed' })))
    expect(r.code).toBe(200)
    const s = await db.staffShift.findUnique({ where: { id: legacyNullLoc } })
    expect(s?.status).toBe('confirmed')
  })

  it('POST: zaposleni iz orgB na lokacijo orgA → 403; BREZ nove StaffShift', async () => {
    const before = await db.staffShift.count({ where: { employeeId: empB } })
    const r = await status(staffShiftsPOST(req('/api/staff-shifts', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'POST', {
      employeeId: empB, shiftDate: '2031-01-15', shiftType: 'full', startTime: '10:00', endTime: '18:00', locationId: locA1,
    })))
    expect(r.code).toBe(403)
    expect(String(r.body.error)).toMatch(/organizacij/i)
    expect(await db.staffShift.count({ where: { employeeId: empB } })).toBe(before)
  })

  it('POST: medlokacijska izmena ZNOTRAJ iste organizacije (empA2 na A1) → 200 (uspeh)', async () => {
    const r = await status(staffShiftsPOST(req('/api/staff-shifts', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'POST', {
      employeeId: empA2, shiftDate: '2031-01-16', shiftType: 'full', startTime: '12:00', endTime: '20:00', locationId: locA1,
    })))
    expect(r.code).toBe(200)
    const created = await db.staffShift.findFirst({ where: { employeeId: empA2, locationId: locA1 } })
    expect(created).not.toBeNull()
  })

  it('POST: zaposleni BREZ lokacije in brez body.locationId → 400; BREZ izmene', async () => {
    const before = await db.staffShift.count({ where: { employeeId: empNoLoc } })
    const r = await status(staffShiftsPOST(req('/api/staff-shifts', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'POST', {
      employeeId: empNoLoc, shiftDate: '2031-01-17', shiftType: 'full', startTime: '10:00', endTime: '18:00',
    })))
    expect(r.code).toBe(400)
    expect(String(r.body.error)).toMatch(/Lokacija izmene/i)
    expect(await db.staffShift.count({ where: { employeeId: empNoLoc } })).toBe(before)
  })

  it('DELETE: izmena izbrisana IN audit zapisan (ista transakcija — sled vedno obstaja)', async () => {
    const id = `${PREFIX}ss-del-${RUN}`
    await db.staffShift.create({
      data: {
        id, employeeId: empX, shiftDate: new Date('2031-01-20T00:00:00Z'),
        shiftType: 'full', startTime: '09:00', endTime: '17:00',
        locationId: locA1, role: 'waiter', status: 'scheduled', breakMinutes: 0,
      },
    })
    const r = await status(staffShiftsDELETE(req('/api/staff-shifts', tok(managerA, `${PREFIX}m`, 'MANAGER', locA1), 'DELETE', { id })))
    expect(r.code).toBe(200)
    expect(await db.staffShift.findUnique({ where: { id } })).toBeNull()
    expect(await db.auditLog.count({ where: { action: 'STAFF_SHIFT_DELETE', entityId: id } })).toBe(1)
  })
})
