import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { verifyToken, employeePinFields } from '../src/lib/auth'
import { requirePermission, isResponse } from '../src/lib/api'
import { POST as demoLoginPOST, GET as demoLoginGET, demoGate } from '../src/app/api/auth/demo-login/route'

/**
 * DEMO VSTOP BREZ GESLA (v1.118.0 — zahteva lastnika 16. 10. 2026, za čas dela).
 *
 * POST /api/auth/demo-login:
 *  - prijavi NAJSTAREJŠI aktivni vodstveni račun (owner/admin) BREZ MFA;
 *  - neobvezen env DEMO_LOGIN_EMAIL pripne izbiro na točen račun (testi to
 *    izkoriščajo za deterministične poti 403);
 *  - rate-limit 10/min po IP; vsak vstop zapiše audit DEMO_LOGIN;
 *  - MFA-zavarovan račun NIKOLI ni izbran/pripet (demo ne obide MFA).
 *
 * Issue #7 (v1.148.0): vrata dobijo ZAPORO — DEMO_LOGIN_ENABLED=0 in/ali
 * DEMO_LOGIN_EXPIRES_AT=<ISO>. Blok "zapora" pokriva obe zavori, fail-closed
 * vedenje ob neveljavnem datumu, GET stanja (samo stanje, brez računov) in
 * vrstni red (zapora se preveri PREJ kot rate limit).
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
        'reports.sales',
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

// ════════════════════════════════════════════════════════════════════════════
// Issue #7 (v1.148.0) — ZAPORA demo vrat: env izklop, rok, GET stanja
// ════════════════════════════════════════════════════════════════════════════
describe('#7 zapora demo vrat — demoGate() (enota, brez pomikanja sistemskih ur)', () => {
  const now = new Date('2026-10-19T12:00:00Z')

  it('G0.1 ne nastavljeno: vrata so ODPRTA in brez roka (sedanja lastnikova odločitev)', () => {
    delete process.env.DEMO_LOGIN_ENABLED
    delete process.env.DEMO_LOGIN_EXPIRES_AT
    expect(demoGate(now)).toEqual({ open: true, expiresAt: null })
  })

  it('G0.2 izklop sprejme 0/false/no/off (maloprintno, presledki) — NE tudi "1" ali "ne"', () => {
    delete process.env.DEMO_LOGIN_EXPIRES_AT
    for (const v of ['0', 'false', 'NO', ' off ']) {
      process.env.DEMO_LOGIN_ENABLED = v
      const g = demoGate(now)
      expect(g.open).toBe(false)
      expect((g as { code?: string }).code).toBe('DEMO_LOGIN_DISABLED')
    }
    for (const v of ['1', 'true', 'ne', '', '   ']) {
      process.env.DEMO_LOGIN_ENABLED = v
      expect(demoGate(now).open).toBe(true)
    }
    delete process.env.DEMO_LOGIN_ENABLED
  })

  it('G0.3 prihodnji rok → odprta z expiresAt; pretekli rok → zaprta z DEMO_LOGIN_EXPIRED', () => {
    delete process.env.DEMO_LOGIN_ENABLED
    process.env.DEMO_LOGIN_EXPIRES_AT = '2030-01-01T00:00:00Z'
    expect(demoGate(now)).toEqual({ open: true, expiresAt: new Date('2030-01-01T00:00:00Z') })
    process.env.DEMO_LOGIN_EXPIRES_AT = '2020-01-01T00:00:00Z'
    const g = demoGate(now)
    expect(g.open).toBe(false)
    expect((g as { code?: string }).code).toBe('DEMO_LOGIN_EXPIRED')
    delete process.env.DEMO_LOGIN_EXPIRES_AT
  })

  it('G0.4 neveljaven zapis roka zapre (fail-closed): tipkarska napaka NE sme pomeniti "nikoli ne poteče"', () => {
    delete process.env.DEMO_LOGIN_ENABLED
    for (const bad of ['jutri', '31.12.2030', '2030-13-45T00:00:00Z', 'X']) {
      process.env.DEMO_LOGIN_EXPIRES_AT = bad
      const g = demoGate(now)
      expect(g.open).toBe(false)
      expect((g as { code?: string }).code).toBe('DEMO_LOGIN_CONFIG_INVALID')
    }
    delete process.env.DEMO_LOGIN_EXPIRES_AT
  })

  it('G0.5 izklop ima prednost pred rokom (branje enva, brez DB dela)', () => {
    process.env.DEMO_LOGIN_ENABLED = '0'
    process.env.DEMO_LOGIN_EXPIRES_AT = '2030-01-01T00:00:00Z'
    const g = demoGate(now)
    expect((g as { code?: string }).code).toBe('DEMO_LOGIN_DISABLED')
    delete process.env.DEMO_LOGIN_ENABLED
    delete process.env.DEMO_LOGIN_EXPIRES_AT
  })
})

describe('#7 zapora demo vrat — HTTP vedenje', () => {
  const ip = (n: number) => `10.7.0.${n}`

  it('G1 DEMO_LOGIN_ENABLED=0: POST → 403 s strojno berljivo kodo in BREZ žetona', async () => {
    delete process.env.DEMO_LOGIN_EMAIL
    process.env.DEMO_LOGIN_ENABLED = '0'
    try {
      const res = await demoLoginPOST(req(ip(11)))
      expect(res.status).toBe(403)
      const d = (await res.json()) as { token?: string; error?: string; code?: string }
      expect(d.code).toBe('DEMO_LOGIN_DISABLED')
      expect(d.token).toBeUndefined()
      expect(String(d.error)).toMatch(/DEMO_LOGIN_ENABLED/)
    } finally {
      delete process.env.DEMO_LOGIN_ENABLED
    }
  })

  it('G2 potekel rok: POST → 403 DEMO_LOGIN_EXPIRED (brez žetona)', async () => {
    delete process.env.DEMO_LOGIN_EMAIL
    process.env.DEMO_LOGIN_EXPIRES_AT = '2020-01-01T00:00:00Z'
    try {
      const res = await demoLoginPOST(req(ip(12)))
      expect(res.status).toBe(403)
      const d = (await res.json()) as { token?: string; code?: string }
      expect(d.code).toBe('DEMO_LOGIN_EXPIRED')
      expect(d.token).toBeUndefined()
    } finally {
      delete process.env.DEMO_LOGIN_EXPIRES_AT
    }
  })

  it('G3 prihodnji rok: POST → 200 (vrata so odprta DO roka, ne zaprta)', async () => {
    process.env.DEMO_LOGIN_EMAIL = `${ownerId}@test.local`
    process.env.DEMO_LOGIN_EXPIRES_AT = '2030-12-31T23:59:00Z'
    try {
      const res = await demoLoginPOST(req(ip(13)))
      expect(res.status).toBe(200)
      const d = (await res.json()) as { token?: string; demo?: boolean }
      expect(typeof d.token).toBe('string')
      expect(d.demo).toBe(true)
    } finally {
      delete process.env.DEMO_LOGIN_EMAIL
      delete process.env.DEMO_LOGIN_EXPIRES_AT
    }
  })

  it('G4 neveljaven rok: POST → 403 (fail-closed, ne "nikoli ne poteče")', async () => {
    delete process.env.DEMO_LOGIN_EMAIL
    process.env.DEMO_LOGIN_EXPIRES_AT = 'konec leta'
    try {
      const res = await demoLoginPOST(req(ip(14)))
      expect(res.status).toBe(403)
      const d = (await res.json()) as { code?: string; token?: string }
      expect(d.code).toBe('DEMO_LOGIN_CONFIG_INVALID')
      expect(d.token).toBeUndefined()
    } finally {
      delete process.env.DEMO_LOGIN_EXPIRES_AT
    }
  })

  it('G5 GET vrne SAMO stanje vrat — brez imen, e-pošt in ID-jev (brez žetona)', async () => {
    delete process.env.DEMO_LOGIN_ENABLED
    delete process.env.DEMO_LOGIN_EXPIRES_AT
    const res = await demoLoginGET()
    expect(res.status).toBe(200)
    const d = (await res.json()) as Record<string, unknown>
    expect(Object.keys(d).sort()).toEqual(['code', 'enabled', 'expiresAt'])
    expect(d.enabled).toBe(true)
    expect(d.code).toBeNull()
    expect(d.expiresAt).toBeNull()
    const raw = JSON.stringify(d)
    expect(raw).not.toContain('@test.local')
    expect(raw).not.toContain(ownerId)
    expect(raw).not.toContain(waiterId)
  })

  it('G6 GET skladen s POST: zaprtima stanjema ustrezata enabled=false in koda', async () => {
    process.env.DEMO_LOGIN_ENABLED = '0'
    try {
      const d = (await (await demoLoginGET()).json()) as { enabled: boolean; code: string | null; expiresAt: string | null }
      expect(d.enabled).toBe(false)
      expect(d.code).toBe('DEMO_LOGIN_DISABLED')
      expect(d.expiresAt).toBeNull()
    } finally {
      delete process.env.DEMO_LOGIN_ENABLED
    }
    process.env.DEMO_LOGIN_EXPIRES_AT = '2020-01-01T00:00:00Z'
    try {
      const d = (await (await demoLoginGET()).json()) as { enabled: boolean; code: string | null }
      expect(d.enabled).toBe(false)
      expect(d.code).toBe('DEMO_LOGIN_EXPIRED')
    } finally {
      delete process.env.DEMO_LOGIN_EXPIRES_AT
    }
  })

  it('G7 GET ima Cache-Control: no-store (stanje vrat ne sme ostati v predpomnilniku)', async () => {
    delete process.env.DEMO_LOGIN_ENABLED
    delete process.env.DEMO_LOGIN_EXPIRES_AT
    expect((await demoLoginGET()).headers.get('cache-control')).toBe('no-store')
    process.env.DEMO_LOGIN_ENABLED = '0'
    try {
      expect((await demoLoginGET()).headers.get('cache-control')).toBe('no-store')
    } finally {
      delete process.env.DEMO_LOGIN_ENABLED
    }
  })

  it('G8 zavrnjen poskus NE piše audit DEMO_LOGIN (javen endpoint brez sledenja napadom)', async () => {
    delete process.env.DEMO_LOGIN_EMAIL
    const before = await db.auditLog.count({ where: { action: 'DEMO_LOGIN', entityId: ownerId } })
    process.env.DEMO_LOGIN_ENABLED = '0'
    try {
      for (let i = 0; i < 3; i++) expect((await demoLoginPOST(req(ip(20 + i)))).status).toBe(403)
    } finally {
      delete process.env.DEMO_LOGIN_ENABLED
    }
    const after = await db.auditLog.count({ where: { action: 'DEMO_LOGIN', entityId: ownerId } })
    expect(after).toBe(before)
  })

  it('G9 zapora se preveri PREJ kot rate limit: 12 klikov z istim IP → sami 403, noben 429', async () => {
    delete process.env.DEMO_LOGIN_EMAIL
    process.env.DEMO_LOGIN_ENABLED = '0'
    try {
      for (let i = 0; i < 12; i++) {
        const res = await demoLoginPOST(req(ip(30)))
        expect(res.status).toBe(403)
      }
    } finally {
      delete process.env.DEMO_LOGIN_ENABLED
    }
  })

  it('G10 uspešen vstop zabeleži rok (ali njegovo manjkaje) v audit podrobnostih', async () => {
    process.env.DEMO_LOGIN_EMAIL = `${ownerId}@test.local`
    const readLatest = async () =>
      (await db.auditLog.findFirst({ where: { action: 'DEMO_LOGIN', entityId: ownerId }, orderBy: { timestamp: 'desc' } }))?.details

    process.env.DEMO_LOGIN_EXPIRES_AT = '2030-12-31T23:59:00Z'
    try {
      expect((await demoLoginPOST(req(ip(40)))).status).toBe(200)
    } finally {
      delete process.env.DEMO_LOGIN_EXPIRES_AT
    }
    expect(await readLatest()).toContain('2030-12-31T23:59:00.000Z')

    expect((await demoLoginPOST(req(ip(41)))).status).toBe(200)
    expect(await readLatest()).toContain('DEMO_LOGIN_EXPIRES_AT ni nastavljen')
    delete process.env.DEMO_LOGIN_EMAIL
  })
})

describe('#7 zapora demo vrat — pini vira in UI', () => {
  const routeSrc = () => Bun.file(`${import.meta.dir}/../src/app/api/auth/demo-login/route.ts`).text()

  it('P1 zapora je PREJ od rate-limite in prej od DB poizvedbe', async () => {
    const src = await routeSrc()
    // merimo KLICNE v POST veji (uvoz modula in GET steja vsebujeta ista imena)
    const post = src.indexOf('export async function POST')
    const gate = src.indexOf('const gate = demoGate()', post)
    const limit = src.indexOf('rateLimitSharedAsync(', post)
    const dbCall = src.indexOf('await fetchCandidates()', post)
    expect(post).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(limit)
    expect(limit).toBeLessThan(dbCall)
  })

  it('P2 GET je registriran kot javna rota in ne vrne računov (samo stanje)', async () => {
    const src = await routeSrc()
    expect(src).toContain('export async function GET()')
    expect(src).toContain("'Cache-Control': 'no-store'")
    // resolvePermissions se uporabi SAMO v POST uspešnem odgovoru (en klic)
    expect(src.match(/resolvePermissions\(/g)?.length).toBe(1)
  })

  it('P3 prijavni zaslon upošteva stanje vrat in ne obeta zaprtega gumba', async () => {
    const src = await Bun.file(`${import.meta.dir}/../src/app/page.tsx`).text()
    expect(src).toContain("fetch('/api/auth/demo-login')")
    expect(src).toContain('setDemoOpen')
    expect(src).toContain('{demoOpen && (')
  })

  it('P4 log zapornih vrat je združen po kodi (javna rota pred limitom ne sme pisati na klic)', async () => {
    const src = await routeSrc()
    expect(src).toContain('const refusalWarned = new Set<string>()')
    // zapis mora biti UZAPET v zaklepu, sicer je brezpogojen: anonimen 403 bi pisal
    // eno log vrstico na klic, rate-limit pa je v tej poti šele ZA to vejo (P1).
    expect(/if \(!refusalWarned\.has\(gate\.code\)\) \{\s*\n\s*refusalWarned\.add\(gate\.code\)\s*\n\s*console\.warn/.test(src)).toBe(true)
    expect(src.match(/demo-login zavrnjen/g)?.length).toBe(1)
  })
})
