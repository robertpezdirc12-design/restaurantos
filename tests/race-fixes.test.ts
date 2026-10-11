import { describe, expect, test, afterAll, beforeAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as payoutPOST } from '../src/app/api/tips/payout/route'
import { POST as expensesPOST } from '../src/app/api/expenses/route'
import { GET as expensesGET } from '../src/app/api/expenses/route'
import { GET as tipsGET } from '../src/app/api/tips/route'
import { POST as syncPOST } from '../src/app/api/sync/route'

/**
 * P2 race popravki (Task 32-a) + N5 GET vrata — DB-backed testi (dev SQLite).
 * R9  — tips payout CAS: dvojni klik → eno izplačilo + en revizijski vnos, 409 na ponovitev
 * R12 — stroški brez dobavitelja: konkurenčna zahteva ne ustvari dveh "Razno" dobaviteljev
 * R7  — sync operacija: neuspel apply → EN DeviceSyncOperation 'failed' zapis; replay
 *       istega clientOperationId ne podvoji vrstice (retryCount raste)
 * N5  — finančni GET konci: waiter brez reports.view → 403, manager → 200
 *
 * Predpona fiksatur `rfix-` + RUN — cleanup v afterAll v obratni smeri FK.
 */

const PREFIX = 'rfix-'
const RUN = Date.now().toString(36)
const PIN = `${String(Date.now()).slice(-6)}1`

let locId = ''
let managerId = ''
let waiterId = ''

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const tokenFor = (sub: string, name: string, role: string, loc: string | null) =>
  createToken({ sub, name, role, loc, sv: 0 })

async function seedEmployee(name: string, role: string, pin: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}${name}-${RUN}`,
      name: `${PREFIX}${name}`,
      email: `${PREFIX}${name}-${RUN}@test.local`,
      role,
      status: 'active',
      sessionVersion: 0,
      locationId: locId,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
}

beforeAll(async () => {
  // Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: {
      id: `${PREFIX}loc-${RUN}`,
      name: `${PREFIX}Testna lokacija`,
      code: `RFIX-${RUN.toUpperCase()}`,
      premisesId: `rfix-prem-${RUN}`,
    },
  })
  locId = loc.id
  const manager = await seedEmployee('manager', 'manager', PIN)
  const waiter = await seedEmployee('waiter', 'waiter', `${PIN.slice(0, -1)}2`)
  managerId = manager.id
  waiterId = waiter.id
})

afterAll(async () => {
  // obratna smer FK: sync zapisi → napitnine → AP/stroški → zaposleni → lokacija
  await db.deviceSyncOperation.deleteMany({ where: { deviceId: { startsWith: `${PREFIX}dev` } } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: `${PREFIX}pool` } }, { entityType: 'AccountsPayable' }] } }).catch(() => null)
  await db.tipDistribution.deleteMany({ where: { tipPoolId: { startsWith: `${PREFIX}pool` } } }).catch(() => null)
  await db.tipPool.deleteMany({ where: { id: { startsWith: `${PREFIX}pool` } } }).catch(() => null)
  await db.accountsPayable.deleteMany({ where: { id: { startsWith: `${PREFIX}ap` } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: `${PREFIX}` } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: locId || '__x__' } }).catch(() => null)
})

describe('R9 — tips payout CAS (dvojno izplačilo nemogoče)', () => {
  test('prvo izplačilo 200 → vse distribucije paid + bazen paid + točno EN TIP_PAYOUT revizijski vnos; drugi klic → 409', async () => {
    const t = { manager: tokenFor(managerId, `${PREFIX}manager`, 'MANAGER', locId) }
    const pool = await db.tipPool.create({
      data: {
        id: `${PREFIX}pool-${RUN}`,
        date: new Date(),
        totalTips: 20,
        cashTips: 20,
        status: 'pending',
        locationId: locId,
      },
    })
    await db.tipDistribution.create({
      data: { id: `${PREFIX}dist-a-${RUN}`, tipPoolId: pool.id, employeeId: managerId, employeeName: `${PREFIX}manager`, amount: 12, hoursWorked: 6, points: 1, status: 'pending' },
    })
    await db.tipDistribution.create({
      data: { id: `${PREFIX}dist-b-${RUN}`, tipPoolId: pool.id, employeeId: managerId, employeeName: `${PREFIX}manager`, amount: 8, hoursWorked: 4, points: 1, status: 'pending' },
    })

    const res1 = await payoutPOST(req('/api/tips/payout', t.manager, 'POST', { poolId: pool.id }))
    expect(res1.status).toBe(200)
    const dists = await db.tipDistribution.findMany({ where: { tipPoolId: pool.id } })
    expect(dists.every((d) => d.status === 'paid' && d.paidAt !== null)).toBe(true)
    const poolAfter = await db.tipPool.findUnique({ where: { id: pool.id } })
    expect(poolAfter?.status).toBe('paid')
    const audits = await db.auditLog.findMany({ where: { action: 'TIP_PAYOUT', entityId: pool.id } })
    expect(audits).toHaveLength(1)

    // drugi klic: ni več čakajočih → 409, brez drugega revizijskega vnosa
    const res2 = await payoutPOST(req('/api/tips/payout', t.manager, 'POST', { poolId: pool.id }))
    expect(res2.status).toBe(409)
    const auditsAfter = await db.auditLog.findMany({ where: { action: 'TIP_PAYOUT', entityId: pool.id } })
    expect(auditsAfter).toHaveLength(1)
  })
})

describe('R12 — stroški: brez duplikatov dobavitelja "Razno" pod konkurenco', () => {
  test('2 vzporedna POST brez supplierId → 2 AccountsPayable, k "Razno" pride največ 1 nov vnos', async () => {
    const t = { manager: tokenFor(managerId, `${PREFIX}manager`, 'MANAGER', locId) }
    const before = await db.supplier.findMany({ where: { name: 'Razno' } })
    const b = before.length

    const [r1, r2] = await Promise.all([
      expensesPOST(req('/api/expenses', t.manager, 'POST', { description: `${PREFIX}racun A-${RUN}`, amount: 5.5, locationId: locId })),
      expensesPOST(req('/api/expenses', t.manager, 'POST', { description: `${PREFIX}racun B-${RUN}`, amount: 7.25, locationId: locId })),
    ])
    expect([200, 201]).toContain(r1.status)
    expect([200, 201]).toContain(r2.status)
    const j1 = await r1.json()
    const j2 = await r2.json()
    expect(j1.expense.id).not.toBe(j2.expense.id)

    const after = await db.supplier.findMany({ where: { name: 'Razno' } })
    // upsert invarianta: ali so obstajale (b ostane), ali je nastal TOČNO en
    if (b === 0) expect(after.length).toBe(1)
    else expect(after.length).toBe(b)

    const aps = await db.accountsPayable.findMany({ where: { OR: [{ id: { startsWith: `${PREFIX}ap` } }, { notes: { contains: `${PREFIX}racun` } }] } })
    expect(aps.length).toBeGreaterThanOrEqual(2)
  })
})

describe('R7 — sync: neuspela operacija → EN failed zapis, replay ne podvoji', () => {
  test('kitchen.status z neobstoječo postavko → ok=false, EN DeviceSyncOperation failed; ponovitev → še vedno EN zapis (retryCount raste)', async () => {
    const t = { manager: tokenFor(managerId, `${PREFIX}manager`, 'MANAGER', locId) }
    const deviceId = `${PREFIX}dev-${RUN}`
    const coid = `${PREFIX}coid-${RUN}`

    const body = { deviceId, ops: [{ kind: 'kitchen.status', clientOperationId: coid, payload: { itemId: 'ne-obstaja', status: 'READY' } }] }
    const res1 = await syncPOST(req('/api/sync', t.manager, 'POST', body))
    expect(res1.status).toBe(200)
    const j1 = await res1.json()
    expect(j1.results?.[0]?.ok).toBe(false)

    const rows1 = await db.deviceSyncOperation.findMany({ where: { deviceId, clientOperationId: coid } })
    expect(rows1).toHaveLength(1)
    expect(rows1[0].status).toBe('failed')
    expect(rows1[0].lastError).toBeTruthy()
    expect(rows1[0].clientRetryCount).toBe(1)

    // replay istega clientOperationId — NE sme nastati druga vrstica
    const res2 = await syncPOST(req('/api/sync', t.manager, 'POST', body))
    expect(res2.status).toBe(200)
    const rows2 = await db.deviceSyncOperation.findMany({ where: { deviceId, clientOperationId: coid } })
    expect(rows2).toHaveLength(1)
    expect(rows2[0].clientRetryCount).toBe(2)
  })
})

describe('N5 — finančni GET konci (waiter brez reports.view)', () => {
  test('GET /api/expenses: waiter → 403, manager → 200', async () => {
    const t = {
      manager: tokenFor(managerId, `${PREFIX}manager`, 'MANAGER', locId),
      waiter: tokenFor(waiterId, `${PREFIX}waiter`, 'WAITER', locId),
    }
    const w = await expensesGET(req('/api/expenses', t.waiter))
    expect(w.status).toBe(403)
    const m = await expensesGET(req('/api/expenses', t.manager))
    expect(m.status).toBe(200)
  })

  test('GET /api/tips: waiter → 403, manager → 200', async () => {
    const t = {
      manager: tokenFor(managerId, `${PREFIX}manager`, 'MANAGER', locId),
      waiter: tokenFor(waiterId, `${PREFIX}waiter`, 'WAITER', locId),
    }
    const w = await tipsGET(req('/api/tips', t.waiter))
    expect(w.status).toBe(403)
    const m = await tipsGET(req('/api/tips', t.manager))
    expect(m.status).toBe(200)
  })
})
