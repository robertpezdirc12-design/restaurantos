/**
 * Revizija 2026-10 (v1.147.0) — najdbi #8 in #9.
 *
 * #8 (P1): premik zaposlenega in naprave na drugo lokacijo je preverjal samo VIR
 * (`guardResource` na trenutni lokaciji), CILJ pa samo to, da obstaja. Vodja svoje
 * poslovalnice je zato z dovoljenjem `employees.manage` in poljubnim `locationId`
 * (javno dostopnim prek #9) lahko sodelavca ali napravo premaknil v TUJO
 * poslovalnico ali celo v TUJO organizacijo. Vzorec popravka je `integrations/[id]`
 * (issue #42 točki 3 in 4): premik preveri vir IN cilj, odklop brez lokacije pa je
 * platform-level operacija.
 *
 * #9 (P2): `/api/auth/locations` je javen (brez njega prijava ne more izbrati
 * poslovalnice) in našteje vse aktivne lokacije. Odprava bi zlomila prijavo, zato
 * release razkritja ne odpravi, ga pa omeji: 30 zahtevkov na minuto po IP-ju in
 * `no-store` (kopija seznama ne sme ostati v brskalniku, CDN-u ali vmesnem
 * posredniku) na vseh treh izhodih.
 *
 * Predpone ID-jev `a89-` (počisti jih sweepTestFixtures, tudi ob crashu teka).
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { PATCH as employeePATCH } from '../src/app/api/employees/[id]/route'
import { PATCH as devicePATCH } from '../src/app/api/devices/[id]/route'
import { GET as locationsGET } from '../src/app/api/auth/locations/route'

const PREFIX = 'a89-'
const RUN = Date.now().toString(36)

let orgA = '', brandA = '', propA = ''
let orgB = '', brandB = '', propB = ''
let locA1 = '', locA2 = '', locB1 = '', locFree = ''
let adminA = '', adminLoose = '', managerA = '', waiterA = ''
let devA1 = '', devA2 = ''

function tok(sub: string, role: string, loc: string | null): string {
  return createToken({ sub, name: sub, role, loc, sv: 0 })
}

function req(url: string, token: string, body: unknown, ip?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function call(res: Response | Promise<unknown>): Promise<{ code: number; body: Record<string, unknown> }> {
  const r = (await res) as Response
  return { code: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Javen GET (brez žetona) — IP je baza rate limit ključa. */
function getReq(ip: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/locations', {
    method: 'GET',
    headers: { 'x-forwarded-for': ip },
  })
}

async function seedEmployee(tag: string, role: string, loc: string | null): Promise<string> {
  const id = `${PREFIX}${tag}-${RUN}`
  const email = `${PREFIX}${tag}-${RUN}@test.local`
  const pin = String(10000000 + ([...`${id}${role}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 89999999, 7)))
  const fields = employeePinFields(pin, email)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${tag}`, email, role, status: 'active', sessionVersion: 0,
      locationId: loc, pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  return id
}

async function seedDevice(tag: string, locationId: string): Promise<string> {
  const row = await db.deviceRegistry.create({
    data: {
      id: `${PREFIX}${tag}-${RUN}`,
      deviceId: `rodev_${PREFIX}${tag}${RUN}`,
      name: `${PREFIX}Naprava ${tag}`,
      type: 'pos',
      status: 'online',
      locationId,
    },
  })
  return row.id
}

const empLoc = (id: string) => db.employee.findUnique({ where: { id }, select: { locationId: true, sessionVersion: true } })
const devLoc = (id: string) => db.deviceRegistry.findUnique({ where: { id }, select: { locationId: true, name: true } })

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locA1 = `${PREFIX}locA1-${RUN}`; locA2 = `${PREFIX}locA2-${RUN}`; locB1 = `${PREFIX}locB1-${RUN}`
  locFree = `${PREFIX}locFree-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'A89 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: 'A89 Org B', slug: `${PREFIX}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'A89 BA' } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'A89 BB' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'A89 PA' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'A89 PB' } })
  await db.location.create({ data: { id: locA1, name: 'A89 Gastro A1', code: `${PREFIX}A1-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locA2, name: 'A89 Gastro A2', code: `${PREFIX}A2-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB1, name: 'A89 Konkurent B1', code: `${PREFIX}B1-${RUN}`, propertyId: propB } })
  // nevezana lokacija (legacy, propertyId null) — migracijska varnost organizacijske meje
  await db.location.create({ data: { id: locFree, name: 'A89 Nevezana', code: `${PREFIX}FR-${RUN}` } })

  adminA = await seedEmployee('adminA', 'admin', locA1)
  adminLoose = await seedEmployee('adminLoose', 'admin', null)
  managerA = await seedEmployee('managerA', 'manager', locA1)
  waiterA = await seedEmployee('waiterA', 'waiter', locA1)
  devA1 = await seedDevice('devA1', locA1)
  devA2 = await seedDevice('devA2', locA1)
})

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } })
  await sweepTestFixtures(db, [PREFIX])
})

/* ───────────── A) zaposleni: cilj premika je preverjen ───────────── */

describe('A — employees/[id] PATCH: varovalka CILJNE lokacije (najdba #8)', () => {
  it('A1 vodja premakne sodelavca v tujo ORGANIZACIJO → 403, v bazi se ne spremeni nič', async () => {
    const before = await empLoc(waiterA)
    const res = await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(managerA, 'MANAGER', locA1), { locationId: locB1 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(res.code).toBe(403)
    expect(await empLoc(waiterA)).toEqual(before as never)
  })

  it('A2 vodja premakne sodelavca v drugo lokacijo ISTe organizacije → 403 (staff = izključno svoja)', async () => {
    const res = await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(managerA, 'MANAGER', locA1), { locationId: locA2 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(res.code).toBe(403)
    expect((await empLoc(waiterA))?.locationId).toBe(locA1)
  })

  it('A3 centralna vloga premakne znotraj svoje ORGANIZACIJE → 200 + odpoved seje (legitimni tok obstaja)', async () => {
    const before = await empLoc(waiterA)
    const res = await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(adminA, 'ADMIN', locA1), { locationId: locA2 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(res.code).toBe(200)
    const after = await empLoc(waiterA)
    expect(after?.locationId).toBe(locA2)
    expect(Number(after?.sessionVersion)).toBe(Number(before?.sessionVersion) + 1)
  })

  it('A4 centralna vloga orgA premakne v lokacijo orgB → 403 (org meja velja tudi za cilj)', async () => {
    const res = await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(adminA, 'ADMIN', locA1), { locationId: locB1 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(res.code).toBe(403)
    expect((await empLoc(waiterA))?.locationId).toBe(locA2)
  })

  it('A5 premik na ISTO lokacijo → 400 (nič za posodobiti); tuji VIR pa je odbit že prej (403)', async () => {
    const same = await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(adminA, 'ADMIN', locA1), { locationId: locA2 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(same.code).toBe(400)
    expect(same.body.error).toContain('Nič za posodobiti')
    const foreignSource = await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(adminLoose, 'ADMIN', locB1), { locationId: locA2 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(foreignSource.code).toBe(403)
  })

  it('A6 neobstoječ locationId → 404, obstoječ a tuj → 403 (obstoj se preveri prvi)', async () => {
    const missing = await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(adminA, 'ADMIN', locA1), { locationId: `${PREFIX}ni-te-loc-${RUN}` }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(missing.code).toBe(404)
    const foreign = await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(adminA, 'ADMIN', locA1), { locationId: locB1 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(foreign.code).toBe(403)
  })

  it('A7 zavrnjen premik NE pusti revizijske sledi, dovoljen premik jo pusti', async () => {
    const countAudits = () => db.auditLog.count({ where: { action: 'EMPLOYEE_SENSITIVE_UPDATE', entityId: waiterA } })
    const before = await countAudits()
    await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(managerA, 'MANAGER', locA1), { locationId: locB1 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(await countAudits()).toBe(before)
    await call(employeePATCH(req(`/api/employees/${waiterA}`, tok(adminA, 'ADMIN', locA1), { locationId: locA1 }), { params: Promise.resolve({ id: waiterA }) } as never))
    expect(await countAudits()).toBe(before + 1)
    const last = await db.auditLog.findFirst({ where: { action: 'EMPLOYEE_SENSITIVE_UPDATE', entityId: waiterA }, orderBy: { timestamp: 'desc' }, select: { details: true } })
    expect(String(last?.details)).toContain('sprememba lokacije')
  })
})

/* ───────────── B) naprave: cilj + odklop ───────────── */

describe('B — devices/[id] PATCH: varovalka CILJNE lokacije in odklopa (najdba #8)', () => {
  it('B1 vodja premakne napravo v tujo organizacijo → 403, naprava ostane na svoji lokaciji', async () => {
    const res = await call(devicePATCH(req(`/api/devices/${devA1}`, tok(managerA, 'MANAGER', locA1), { locationId: locB1 }), { params: Promise.resolve({ id: devA1 }) } as never))
    expect(res.code).toBe(403)
    expect((await devLoc(devA1))?.locationId).toBe(locA1)
  })

  it('B2 vodja premakne napravo v drugo lokacijo iste organizacije → 403 (staff = izključno svoja)', async () => {
    const res = await call(devicePATCH(req(`/api/devices/${devA1}`, tok(managerA, 'MANAGER', locA1), { locationId: locA2 }), { params: Promise.resolve({ id: devA1 }) } as never))
    expect(res.code).toBe(403)
    expect((await devLoc(devA1))?.locationId).toBe(locA1)
  })

  it('B3 centralna vloga premakne napravo znotraj organizacije → 200; v tujo org → 403', async () => {
    const inside = await call(devicePATCH(req(`/api/devices/${devA1}`, tok(adminA, 'ADMIN', locA1), { locationId: locA2 }), { params: Promise.resolve({ id: devA1 }) } as never))
    expect(inside.code).toBe(200)
    expect((await devLoc(devA1))?.locationId).toBe(locA2)
    const foreign = await call(devicePATCH(req(`/api/devices/${devA1}`, tok(adminA, 'ADMIN', locA1), { locationId: locB1 }), { params: Promise.resolve({ id: devA1 }) } as never))
    expect(foreign.code).toBe(403)
    expect((await devLoc(devA1))?.locationId).toBe(locA2)
  })

  it('B4 odklop naprave iz lokacije je rezerviran: osebje IN zavezana centralna vloga → 403', async () => {
    const byManager = await call(devicePATCH(req(`/api/devices/${devA2}`, tok(managerA, 'MANAGER', locA1), { locationId: '' }), { params: Promise.resolve({ id: devA2 }) } as never))
    expect(byManager.code).toBe(403)
    const byBoundAdmin = await call(devicePATCH(req(`/api/devices/${devA2}`, tok(adminA, 'ADMIN', locA1), { locationId: null }), { params: Promise.resolve({ id: devA2 }) } as never))
    expect(byBoundAdmin.code).toBe(403)
    expect((await devLoc(devA2))?.locationId).toBe(locA1)
  })

  it('B5 nevezana centralna vloga (platform) napravo odklopi in jo vrne na svojo lokacijo', async () => {
    const off = await call(devicePATCH(req(`/api/devices/${devA2}`, tok(adminLoose, 'ADMIN', null), { locationId: '' }), { params: Promise.resolve({ id: devA2 }) } as never))
    expect(off.code).toBe(200)
    expect((await devLoc(devA2))?.locationId).toBeNull()
    const back = await call(devicePATCH(req(`/api/devices/${devA2}`, tok(adminA, 'ADMIN', locA1), { locationId: locA1 }), { params: Promise.resolve({ id: devA2 }) } as never))
    expect(back.code).toBe(200)
    expect((await devLoc(devA2))?.locationId).toBe(locA1)
  })

  it('B6 urejanje imena in tipa na svoji lokaciji ostane dovoljeno (brez posega v obseg)', async () => {
    // devA2 je še vedno na locA1 (B5 jo je vrnil) — vodja LOCA1 sme urejati vse
    // razen lokacije; devA1 je bila v B3 premeščena na locA2 in je zato TUJA
    // (vodja je sme samo brati/urejati znotraj svoje lokacije)
    const res = await call(devicePATCH(req(`/api/devices/${devA2}`, tok(managerA, 'MANAGER', locA1), { name: 'A89 Preimenovana', type: 'kds' }), { params: Promise.resolve({ id: devA2 }) } as never))
    expect(res.code).toBe(200)
    const row = await db.deviceRegistry.findUnique({ where: { id: devA2 }, select: { name: true, type: true, locationId: true } })
    expect(row?.name).toBe('A89 Preimenovana')
    expect(row?.type).toBe('kds')
    expect(row?.locationId).toBe(locA1)
    const foreignDevice = await call(devicePATCH(req(`/api/devices/${devA1}`, tok(managerA, 'MANAGER', locA1), { name: 'A89 Uzurpacija' }), { params: Promise.resolve({ id: devA1 }) } as never))
    expect(foreignDevice.code).toBe(403)
    expect((await devLoc(devA1))?.locationId).toBe(locA2)
  })
})

/* ───────────── C) javna lista lokacij (najdba #9) ───────────── */

describe('C — /api/auth/locations: javni seznam z omejitvijo in brez predpomnilnika', () => {
  const ip = (tag: string) => `203.0.113.${tag}`

  it('C1 DTO je minimalen {id, name} in NE vsebuje neaktivnih lokacij', async () => {
    await db.location.update({ where: { id: locFree }, data: { isActive: false } })
    try {
      const res = await call(locationsGET(getReq(ip('1'))))
      expect(res.code).toBe(200)
      const list = res.body.locations as Record<string, unknown>[]
      const byId = new Map(list.map((l) => [String(l.id), l]))
      expect(byId.has(locA1)).toBe(true)
      expect(byId.get(locA1)).toEqual({ id: locA1, name: 'A89 Gastro A1' })
      expect(byId.has(locFree)).toBe(false)
      for (const l of list) expect(Object.keys(l).sort()).toEqual(['id', 'name'])
    } finally {
      await db.location.update({ where: { id: locFree }, data: { isActive: true } })
    }
  })

  it('C2 odgovor je brez predpomnilnika — kopija seznama ne ostane v brskalniku/CDN/proxy-ju', async () => {
    const res = await locationsGET(getReq(ip('2')))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('C3 izpad baze ostane strukturiran 503 (issue #76) in prav tako brez predpomnilnika', async () => {
    const orig = db.location.findMany
    ;(db.location as unknown as { findMany: unknown }).findMany = async () => {
      throw new Error('ECONNREFUSED mocked')
    }
    try {
      const res = await locationsGET(getReq(ip('3')))
      expect(res.status).toBe(503)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe('DB_UNAVAILABLE')
      expect(res.headers.get('cache-control')).toBe('no-store')
    } finally {
      ;(db.location as unknown as { findMany: unknown }).findMany = orig
    }
  })

  it('C4 javna pot ne sme vrniti skrivnosti ali številk zaposlenih (pin, davčna, FURS) v nobeni vrsti', async () => {
    const res = await locationsGET(getReq(ip('4')))
    const raw = JSON.stringify(await (res as unknown as Response).json())
    for (const leak of ['fursCertPassword', 'taxId', 'businessId', 'pin', 'address', 'phone', 'email', 'employee']) {
      expect(raw.toLowerCase()).not.toContain(leak)
    }
  })

  it('C5 31. klic z istega IP v minuti → 429 z Retry-After, drugi IP pa ima mir (test zadnji)', async () => {
    const scraper = ip('42')
    let last = 0
    for (let i = 0; i < 30; i++) last = (await locationsGET(getReq(scraper))).status
    expect(last).toBe(200)
    const blocked = await locationsGET(getReq(scraper))
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as Record<string, unknown>
    expect(body.code).toBe('RATE_LIMITED')
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(blocked.headers.get('cache-control')).toBe('no-store')
    const neighbour = await locationsGET(getReq(ip('43')))
    expect(neighbour.status).toBe(200)
  })
})

/* ───────────── D) pini vira ───────────── */

describe('D — pini vira (najdbi #8 in #9)', () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8')

  it('D1 employees PATCH: cilj je overjen pred vpisom (vzorec integrations/[id])', () => {
    const s = src('app/api/employees/[id]/route.ts')
    expect(s).toContain('guardResource(user, loc.id)')
    expect(s).toMatch(/const targetGuard = await guardResource\(user, loc\.id\)\s*\n\s*if \(targetGuard\) return targetGuard/)
  })

  it('D2 devices PATCH: cilj overjen, odklop = platform-level (guardGlobalResource)', () => {
    const s = src('app/api/devices/[id]/route.ts')
    expect(s).toContain('guardGlobalResource')
    expect(s).toMatch(/const targetGuard = await guardResource\(user, location\.id\)\s*\n\s*if \(targetGuard\) return targetGuard/)
    expect(s).toMatch(/const globalGuard = await guardGlobalResource\(user\)\s*\n\s*if \(globalGuard\) return globalGuard/)
  })

  it('D3 javni seznam: omejitev po IP + no-store na vseh odgovorih', () => {
    const s = src('app/api/auth/locations/route.ts')
    expect(s).toContain('rateLimitSharedAsync')
    expect(s).toContain('clientIp(req)')
    expect(s).toContain("'Cache-Control': 'no-store'")
    // issue #76 ostaja pokrit (503 + strukturirana klasifikacija)
    expect(s).toContain('DB_UNAVAILABLE')
    expect(s).toContain('logDbError')
  })

  it('D4 register javnih rut je posodobljen (utemeljitev vsebuje omejitev)', () => {
    const s = readFileSync(join(process.cwd(), 'tests', 'route-coverage.test.ts'), 'utf8')
    const line = s.split('\n').find((l) => l.includes("path: '/api/auth/locations'")) ?? ''
    expect(line).toContain('rate-limit')
    expect(line).toContain('no-store')
  })
})
