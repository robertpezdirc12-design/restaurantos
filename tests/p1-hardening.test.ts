import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as cronGET } from '../src/app/api/cron/daily/route'
import { GET as enterpriseGET } from '../src/app/api/enterprise/route'
import { GET as recurringGET } from '../src/app/api/recurring-po/route'
import { GET as employeeGET, PATCH as employeePATCH } from '../src/app/api/employees/[id]/route'
import { GET as ordersGET } from '../src/app/api/orders/route'
import { tabHasPerm } from '../src/lib/tab-permissions'

/**
 * P1 varnostni val v1.89.0 (brez DDL):
 *  - #27: cron/daily fail-closed v produkciji brez CRON_SECRET (prej: session
 *    fallback ADMIN/MANAGER/OWNER tudi v produkciji);
 *  - #40/#6§C: GET /api/enterprise — neznana organizacija = fail-closed (prej:
 *    fail-open globalni seznam vseh orgov);
 *  - #41/#6§E: GET /api/recurring-po → inventory.manage (prej requireAuth);
 *  - #6§A: employees PATCH permissionOverrides → sessionVersion bump (stara seja 401);
 *  - #28: GET /api/employees/[id] — samo lastni profil ALI employees.manage + obseg;
 *  - #6§F: tabHasPerm fail-closed na prazna dovoljenja.
 *
 * ID-ji s predpono `pih-` (idempotentno, cleanup afterAll).
 */

const PREFIX = 'pih-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locId = ''
let managerId = ''
let waiterId = ''

function req(url: string, token?: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function tokenFor(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

async function seedEmployee(name: string, role: string, pin: string, loc: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}${name}-${RUN}`, name: `${PREFIX}${name}`, email: `${PREFIX}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `PIH-${RUN.toUpperCase()}`, premisesId: `pih-prem-${RUN}` },
  })
  locId = loc.id
  const manager = await seedEmployee('manager', 'manager', pinOf(1), locId)
  managerId = manager.id
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(2), locId)
  waiterId = waiter.id
})

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: PREFIX } }, { payload: { contains: PREFIX } }] } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: `${PREFIX}` } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: locId || '__x__' } }).catch(() => null)
})

describe('Issue #27 — cron/daily fail-closed v produkciji', () => {
  test('produkcija BREZ CRON_SECRET → 401 s sikritnostjo (nikoli session fallback)', async () => {
    const prevNode = process.env.NODE_ENV
    const prevSecret = process.env.CRON_SECRET
    delete process.env.CRON_SECRET
    process.env.NODE_ENV = 'production'
    try {
      const res = await cronGET(req('/api/cron/daily'))
      expect(res.status).toBe(401)
      expect(String((await res.json()).error)).toContain('CRON_SECRET')
    } finally {
      process.env.NODE_ENV = prevNode
      if (prevSecret !== undefined) process.env.CRON_SECRET = prevSecret
    }
  })

  test('produkcija Z napačnim Bearer → 401 neveljaven žeton (enako kot prej)', async () => {
    const prevNode = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    process.env.CRON_SECRET = 'pih-test-secret'
    try {
      const res = await cronGET(req('/api/cron/daily', 'wrong-token'))
      expect(res.status).toBe(401)
      expect(String((await res.json()).error)).toContain('Neveljaven cron žeton')
    } finally {
      process.env.NODE_ENV = prevNode
      delete process.env.CRON_SECRET
    }
  })

  test('dev brez CRON_SECRET → session pot ostaja (401 brez žetona = prijava, NE fail-closed sporočilo)', async () => {
    const prevNode = process.env.NODE_ENV
    const prevSecret = process.env.CRON_SECRET
    delete process.env.CRON_SECRET
    process.env.NODE_ENV = 'development'
    try {
      const res = await cronGET(req('/api/cron/daily'))
      expect(res.status).toBe(401)
      expect(String((await res.json()).error)).not.toContain('ni nastavljen')
    } finally {
      process.env.NODE_ENV = prevNode
      if (prevSecret !== undefined) process.env.CRON_SECRET = prevSecret
    }
  })

  test('dev brez CRON_SECRET + WAITER žeton → 403 (role vrata session poti — brez izvedbe handle)', async () => {
    const prevNode = process.env.NODE_ENV
    const prevSecret = process.env.CRON_SECRET
    delete process.env.CRON_SECRET
    process.env.NODE_ENV = 'development'
    try {
      const res = await cronGET(req('/api/cron/daily', tokenFor(waiterId, 'w', 'WAITER', locId)))
      expect(res.status).toBe(403)
    } finally {
      process.env.NODE_ENV = prevNode
      if (prevSecret !== undefined) process.env.CRON_SECRET = prevSecret
    }
  })
})

describe('Issue #40 (#6 §C) — enterprise GET fail-closed za neznano organizacijo', () => {
  test('centralna vloga z NE-verigano lokacijo vidi PRAZEN seznam (prej: VSE organizacije)', async () => {
    // ustvari vsaj eno organizacijo (dokaz, da seznam ni prazen zaradi prazne baze)
    const org = await db.organization.findFirst({ where: { slug: `pih-org-${RUN}` } })
    if (!org) await db.organization.create({ data: { id: `${PREFIX}org-${RUN}`, name: `${PREFIX}Org`, slug: `pih-org-${RUN}` } })
    const res = await enterpriseGET(req('/api/enterprise', tokenFor(managerId, 'm', 'ADMIN', locId)))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { organizations: unknown[] }
    expect(body.organizations.length).toBe(0)
    await db.organization.deleteMany({ where: { id: `${PREFIX}org-${RUN}` } }).catch(() => null)
  })

  test('bootstrap break-glass še vedno vidi organizacije', async () => {
    await db.organization.create({ data: { id: `${PREFIX}org2-${RUN}`, name: `${PREFIX}Org2`, slug: `pih-org2-${RUN}` } })
    const res = await enterpriseGET(req('/api/enterprise', tokenFor('bootstrap', 'bootstrap', 'ADMIN', null)))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { organizations: Array<{ id: string }> }
    expect(body.organizations.some((o) => o.id === `${PREFIX}org2-${RUN}`)).toBe(true)
    await db.organization.deleteMany({ where: { id: `${PREFIX}org2-${RUN}` } }).catch(() => null)
  })
})

describe('Issue #41 (#6 §E) — recurring-po GET zahteva inventory.manage', () => {
  test('WAITER (brez inventory.manage) → 403', async () => {
    const res = await recurringGET(req('/api/recurring-po', tokenFor(waiterId, 'w', 'WAITER', locId)))
    expect(res.status).toBe(403)
  })

  test('MANAGER (inventory.manage) → 200 { rules }', async () => {
    const res = await recurringGET(req('/api/recurring-po', tokenFor(managerId, 'm', 'MANAGER', locId)))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rules: unknown[] }
    expect(Array.isArray(body.rules)).toBe(true)
  })
})

describe('Issue #6 §A — sprememba dovoljenj prekliče staro sejo', () => {
  test('PATCH permissionOverrides → sessionVersion +1 → stara seja (sv:0) 401', async () => {
    const target = await seedEmployee('permtest', 'waiter', pinOf(3), locId)
    const oldToken = tokenFor(target.id, 'pt', 'WAITER', locId)
    // pred spremembo dela
    const before = await ordersGET(req('/api/orders', oldToken))
    expect(before.status).toBe(200)
    const res = await employeePATCH(req(`/api/employees/${target.id}`, tokenFor(managerId, 'm', 'MANAGER', locId), 'PATCH', { permissionOverrides: ['orders.create'] }), { params: Promise.resolve({ id: target.id }) } as never)
    expect(res.status).toBe(200)
    const row = await db.employee.findUnique({ where: { id: target.id }, select: { sessionVersion: true } })
    expect(row?.sessionVersion).toBe(1)
    const after = await ordersGET(req('/api/orders', oldToken))
    expect(after.status).toBe(401)
  })
})

describe('Issue #28 — GET /api/employees/[id] najmanjša pravica + obseg', () => {
  test('WAITER bere TUJI profil (ista lokacija) → 403 (prej 200 s PII)', async () => {
    const res = await employeeGET(req(`/api/employees/${managerId}`, tokenFor(waiterId, 'w', 'WAITER', locId)), { params: Promise.resolve({ id: managerId }) } as never)
    expect(res.status).toBe(403)
  })

  test('WAITER bere LASTNI profil → 200 (Control Center lastnega računa)', async () => {
    const res = await employeeGET(req(`/api/employees/${waiterId}`, tokenFor(waiterId, 'w', 'WAITER', locId)), { params: Promise.resolve({ id: waiterId }) } as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { employee: { id: string } }
    expect(body.employee.id).toBe(waiterId)
  })

  test('MANAGER (employees.manage, ista lokacija) → 200', async () => {
    const res = await employeeGET(req(`/api/employees/${waiterId}`, tokenFor(managerId, 'm', 'MANAGER', locId)), { params: Promise.resolve({ id: waiterId }) } as never)
    expect(res.status).toBe(200)
  })

  test('WAITER bere profil Druge lokacije → 403 (tuja lokacija, ne 404 reveal)', async () => {
    // druga lokacija + zaposleni tam
    const loc2 = await db.location.create({ data: { id: `${PREFIX}loc2-${RUN}`, name: `${PREFIX}Lokacija2`, code: `PI2-${RUN.toUpperCase()}`, premisesId: `pih-prem2-${RUN}` } })
    const other = await seedEmployee('otherloc', 'manager', pinOf(4), loc2.id)
    const res = await employeeGET(req(`/api/employees/${other.id}`, tokenFor(waiterId, 'w', 'WAITER', locId)), { params: Promise.resolve({ id: other.id }) } as never)
    expect(res.status).toBe(403)
    // (samo-manager na lokaciji2 bi moral prav tako pasti na employees.manage — tu waiter)
  })
})

describe('Issue #6 §F — tabHasPerm fail-closed na prazna dovoljenja', () => {
  test('privilegiran zavihek s PRAZNIMI dovoljenji → false (prej: true — permisivno)', () => {
    expect(tabHasPerm('zaposleni', { canManage: false, perms: [] })).toBe(false)
    expect(tabHasPerm('nastavitve', { canManage: false, perms: [] })).toBe(false)
  })

  test('TAB_PERM_ALL zavihki ostanejo vidni z praznimi dovoljenji (osnovne operacije)', () => {
    expect(tabHasPerm('pregled', { canManage: false, perms: [] })).toBe(true)
    expect(tabHasPerm('urnik', { canManage: false, perms: [] })).toBe(true)
  })

  test('manager (canManage) vidi vse — ne glede na seznam', () => {
    expect(tabHasPerm('zaposleni', { canManage: true, perms: [] })).toBe(true)
  })
})
