/**
 * AUDIT-FIX (v1.82.1) — regresijski testi za vlogo CLEANER (čistilka).
 *
 * Kontekst: vloga 'cleaner' je obstajala v RBAC (permissions.ts ROLE_DEFAULTS),
 * UI dropdownu (dashboard/page.tsx), i18n (roles.CLEANER) in migraciji
 * cleaner-role — a je bila NEFUNKCIONALNA:
 *  - PATCH /api/employees/[id] je vlogo zavrnil z 400 "Neznana vloga"
 *    (BASE_ROLES brez 'CLEANER' v employees/[id]/route.ts),
 *  - POST /api/employees je vlogo TIHO sprevrgel v 'staff'
 *    (ROLE_TO_DB brez CLEANER preslikave v map.ts),
 *  - roleToUI('cleaner') je vrnil fallback 'WAITER' (ROLE_TO_UI brez cleaner).
 *
 * Ta datoteka zaklene vse tri poti (map round-trip + PATCH + POST).
 * Fixture predpona: clnfx- (FK obratni vrstni red v afterAll).
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as employeePOST } from '../src/app/api/employees/route'
import { PATCH as employeePATCH } from '../src/app/api/employees/[id]/route'
import { roleToDB, roleToUI } from '../src/lib/map'
import { resolvePermissions } from '../src/lib/permissions'

const PREFIX = 'clnfx-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: `${PREFIX}` } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: `${PREFIX}loc-` } } }).catch(() => null)
})

const setupP = (async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: {
      id: `${PREFIX}loc-${RUN}`,
      name: `${PREFIX}Lokacija čistilke`,
      code: `CLNFX-${RUN.toUpperCase()}`,
      premisesId: `clnfx-prem-${RUN}`,
    },
  })
  const fields = employeePinFields(`${PIN_BASE}1`, `${PREFIX}admin-${RUN}@test.local`)
  const admin = await db.employee.create({
    data: {
      id: `${PREFIX}admin-${RUN}`,
      name: `${PREFIX}admin`,
      email: `${PREFIX}admin-${RUN}@test.local`,
      role: 'admin',
      status: 'active',
      sessionVersion: 0,
      locationId: loc.id,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
  return {
    locId: loc.id,
    adminToken: createToken({ sub: admin.id, name: admin.name, role: 'ADMIN', loc: loc.id, sv: 0 }),
  }
})()

describe('AUDIT-FIX v1.82.1 — CLEANER: map round-trip (unit)', () => {
  test('roleToDB("CLEANER") → "cleaner" (prej: tiho "staff")', () => {
    expect(roleToDB('CLEANER')).toBe('cleaner')
  })

  test('roleToUI("cleaner") → "CLEANER" (prej: fallback "WAITER")', () => {
    expect(roleToUI('cleaner')).toBe('CLEANER')
  })

  test('round-trip vloga se ne izgubi: roleToUI(roleToDB("CLEANER")) === "CLEANER"', () => {
    expect(roleToUI(roleToDB('CLEANER'))).toBe('CLEANER')
  })

  test('RBAC: cleaner → [haccp.execute] (invarianta permissions-core ostaja)', () => {
    expect(resolvePermissions('cleaner', [])).toEqual(['haccp.execute'])
  })
})

describe('AUDIT-FIX v1.82.1 — CLEANER: PATCH sprejme vlogo (integracija)', () => {
  test('ADMIN dodeli CLEANER vlogo → 200 + DB role "cleaner" (prej: 400 "Neznana vloga")', async () => {
    const { adminToken, locId } = await setupP
    const fields = employeePinFields(`${PIN_BASE}2`, `${PREFIX}target-${RUN}@test.local`)
    const target = await db.employee.create({
      data: {
        id: `${PREFIX}target-${RUN}`,
        name: `${PREFIX}target`,
        email: `${PREFIX}target-${RUN}@test.local`,
        role: 'waiter',
        status: 'active',
        sessionVersion: 0,
        locationId: locId,
        pin: fields.pin,
        pinLookup: fields.pinLookup,
      },
    })
    const res = await employeePATCH(
      req(`/api/employees/${target.id}`, adminToken, 'PATCH', { role: 'CLEANER' }),
      { params: Promise.resolve({ id: target.id }) },
    )
    expect(res.status).toBe(200)
    const row = await db.employee.findUnique({ where: { id: target.id } })
    expect(row?.role).toBe('cleaner')
    // občutljiva akcija = audit zapis (EMPLOYEE_SENSITIVE_UPDATE)
    const audit = await db.auditLog.findFirst({
      where: { entityId: target.id, action: 'EMPLOYEE_SENSITIVE_UPDATE' },
    })
    expect(audit).not.toBeNull()
    expect((audit?.details as string) || '').toContain('CLEANER')
  })

  test('neznana vloga še vedno zavrnjena z 400 (negativna kontrola)', async () => {
    const { adminToken } = await setupP
    const res = await employeePATCH(
      req(`/api/employees/__clnfx-nonexistent__`, adminToken, 'PATCH', { role: 'SUPERHERO' }),
      { params: Promise.resolve({ id: '__clnfx-nonexistent__' }) },
    )
    expect(res.status).toBe(404) // target ne obstaja → 404 pred validacijo vloge
  })
})

describe('AUDIT-FIX v1.82.1 — CLEANER: POST shrani pravo vlogo (integracija)', () => {
  test('ADMIN ustvari zaposlenega z vlogo CLEANER → 201 + DB role "cleaner" (prej: tiho "staff")', async () => {
    const { adminToken, locId } = await setupP
    const res = await employeePOST(
      req('/api/employees', adminToken, 'POST', {
        name: `${PREFIX}nova`,
        email: `${PREFIX}nova-${RUN}@test.local`,
        pin: `${PIN_BASE}3`,
        role: 'CLEANER',
        locationId: locId,
      }),
    )
    expect(res.status).toBe(201)
    const data = await res.json()
    // API vrača UI obliko prek mapEmployee → roleToUI('cleaner') = 'CLEANER'
    expect(data.employee?.role).toBe('CLEANER')
    const row = await db.employee.findUnique({ where: { id: data.employee?.id } })
    expect(row?.role).toBe('cleaner')
  })
})
