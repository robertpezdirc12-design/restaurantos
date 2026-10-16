import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { verifyToken, employeePinFields } from '../src/lib/auth'
import { requirePermission, isResponse } from '../src/lib/api'
import { POST as demoLoginPOST } from '../src/app/api/auth/demo-login/route'

/**
 * DEMO VSTOP BREZ GESLA (v1.118.0 — zahteva lastnika 16. 10. 2026, za čas dela).
 *
 * POST /api/auth/demo-login:
 *  - prijavi NAJSTAREJŠI aktivni vodstveni račun (owner/admin) BREZ MFA;
 *  - neobvezen env DEMO_LOGIN_EMAIL pripne izbiro na točen račun (testi to
 *    izkoriščajo za deterministične poti 403);
 *  - rate-limit 10/min po IP; vsak vstop zapiše audit DEMO_LOGIN;
 *  - MFA-zavarovan račun NIKOLI ni izbran/pripet (demo ne obide MFA).
 */

const P = 'adl-'
const RUN = String(Date.now()).slice(-8)
const PIN_BASE = String(Date.now()).slice(-6)

let org: string, brand: string, prop: string, loc: string
let ownerId: string, waiterId: string, mfaAdminId: string

function req(ip: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/demo-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  })
}

async function cleanup() {
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.property.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.brand.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.organization.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

async function seedEmployee(id: string, name: string, role: string, seq: number): Promise<string> {
  const email = `${id}@test.local`
  const f = employeePinFields(`${PIN_BASE}${seq}`, email)
  await db.employee.create({
    data: {
      id, name, email, role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

beforeAll(async () => {
  await cleanup()
  delete process.env.DEMO_LOGIN_EMAIL
  org = `${P}org-${RUN}`; brand = `${P}brand-${RUN}`; prop = `${P}prop-${RUN}`; loc = `${P}loc-${RUN}`
  await db.organization.create({ data: { id: org, name: `${P}Org`, slug: `${P}-${RUN}` } })
  await db.brand.create({ data: { id: brand, organizationId: org, name: `${P}Brand` } })
  await db.property.create({ data: { id: prop, brandId: brand, name: `${P}Prop` } })
  await db.location.create({ data: { id: loc, name: `${P}Lokacija`, code: `ADL${RUN}`, propertyId: prop, timezone: 'Europe/Ljubljana', currency: 'EUR' } })
  ownerId = await seedEmployee(`${P}owner-${RUN}`, `${P}Vodja`, 'owner', 1)
  waiterId = await seedEmployee(`${P}waiter-${RUN}`, `${P}Natakar`, 'waiter', 2)
  mfaAdminId = await seedEmployee(`${P}mfaadmin-${RUN}`, `${P}MFA Admin`, 'admin', 3)
  await db.employee.update({ where: { id: mfaAdminId }, data: { mfaEnabled: true } })
})

afterAll(async () => {
  delete process.env.DEMO_LOGIN_EMAIL
  await cleanup()
})

describe('demo-login (vstop brez gesla) — env-pripet račun', () => {
  it('200: pripet owner brez MFA → token + employee + dovoljenja + demo:true', async () => {
    process.env.DEMO_LOGIN_EMAIL = `${ownerId}@test.local`
    try {
      const res = await demoLoginPOST(req('10.1.0.1'))
      expect(res.status).toBe(200)
      const d = (await res.json()) as { token?: string; employee?: { id?: string; role?: string; email?: string; permissions?: string[] }; demo?: boolean }
      expect(d.demo).toBe(true)
      expect(d.employee?.id).toBe(ownerId)
      expect(d.employee?.role).toBe('OWNER')
      expect(d.employee?.email).toBe(`${ownerId}@test.local`)
      expect(Array.isArray(d.employee?.permissions)).toBe(true)
      expect((d.employee?.permissions || []).length).toBeGreaterThan(0)
      expect(typeof d.token).toBe('string')
      const payload = verifyToken(String(d.token))
      expect(payload?.sub).toBe(ownerId)
      expect(payload?.role).toBe('OWNER')
      expect(payload?.loc).toBe(loc)
    } finally {
      delete process.env.DEMO_LOGIN_EMAIL
    }
  })

  it('izdani žeton deluje v requirePermission (polna seja, ne enrollment-only)', async () => {
    process.env.DEMO_LOGIN_EMAIL = `${ownerId}@test.local`
    try {
      const res = await demoLoginPOST(req('10.1.0.2'))
      expect(res.status).toBe(200)
      const d = (await res.json()) as { token?: string }
      const user = await requirePermission(
        new NextRequest('http://localhost:3000/api/anything', {
          headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
        }),
        'reports.view',
      )
      expect(isResponse(user)).toBe(false)
    } finally {
      delete process.env.DEMO_LOGIN_EMAIL
    }
  })

  it('vsak vstop zapiše audit DEMO_LOGIN (vidno, ne tiho)', async () => {
    const audit = await db.auditLog.findFirst({
      where: { action: 'DEMO_LOGIN', entityId: ownerId },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).toBeTruthy()
    expect(audit?.entityType).toBe('Employee')
  })

  it('403: pripet račun ne obstaja', async () => {
    process.env.DEMO_LOGIN_EMAIL = `no-such-${RUN}@test.local`
    try {
      const res = await demoLoginPOST(req('10.1.0.3'))
      expect(res.status).toBe(403)
    } finally {
      delete process.env.DEMO_LOGIN_EMAIL
    }
  })

  it('403: pripet račun je waiter (ne-vodstvena vloga)', async () => {
    process.env.DEMO_LOGIN_EMAIL = `${waiterId}@test.local`
    try {
      const res = await demoLoginPOST(req('10.1.0.4'))
      expect(res.status).toBe(403)
    } finally {
      delete process.env.DEMO_LOGIN_EMAIL
    }
  })

  it('403: pripet račun ima vklopljen MFA — demo NE obide MFA', async () => {
    process.env.DEMO_LOGIN_EMAIL = `${mfaAdminId}@test.local`
    try {
      const res = await demoLoginPOST(req('10.1.0.5'))
      expect(res.status).toBe(403)
      const d = (await res.json()) as { error?: string }
      expect(String(d.error)).toContain('MFA')
    } finally {
      delete process.env.DEMO_LOGIN_EMAIL
    }
  })
})

describe('demo-login — samodejna izbira + rate limit', () => {
  it('brez env: izbere SAMO vodstveni račun brez MFA (lastnik, ne waiter/MFA admin)', async () => {
    delete process.env.DEMO_LOGIN_EMAIL
    const res = await demoLoginPOST(req('10.2.0.1'))
    expect(res.status).toBe(200)
    const d = (await res.json()) as { employee?: { id?: string; role?: string } }
    // invarianta: aktiven owner/admin brez MFA — waiter/MFA-račun nikoli izbran
    expect(['OWNER', 'ADMIN']).toContain(d.employee?.role)
    expect(d.employee?.id).not.toBe(waiterId)
    expect(d.employee?.id).not.toBe(mfaAdminId)
  })

  it('rate limit: 11. klic z istim IP v minuti → 429', async () => {
    delete process.env.DEMO_LOGIN_EMAIL
    let last = 200
    for (let i = 0; i < 11; i++) {
      const res = await demoLoginPOST(req('10.3.0.7'))
      last = res.status
      if (i < 10) expect(res.status).toBe(200)
    }
    expect(last).toBe(429)
  })
})
