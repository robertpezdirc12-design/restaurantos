import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken } from '../src/lib/auth'
import { POST as employeesPOST } from '../src/app/api/employees/route'
import { POST as locationsPOST } from '../src/app/api/locations/route'

/**
 * Task 42 — hardening unique+default("") latentnih kolizij (DB-backed, dev SQLite):
 *  U1 — employees: 2 vzporedna POST z istim email (race okno findUnique→create) →
 *       TOČNO EN 201 + EN 409 (prej: P2002 = 500 na izgubljeno dirko)
 *  U2 — locations: 2. lokacija BREZ FURS premisesId → 409 z akcijskim sporočilom
 *       (prej: generični "Koda ali FURS poslovni prostor že obstaja" / P2002 500);
 *       2. lokacija z drugo kodo pa USPEŠNO ustvarjena (multi-lokacija mora delovati)
 *
 * Predpona fiksatur `uc-` + RUN — cleanup v afterAll v obratni smeri FK.
 */

const PREFIX = 'uc-'
const RUN = Date.now().toString(36)
const PIN = `${String(Date.now()).slice(-6)}2`

let locId = ''
let ownerId = ''

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const tokenFor = (sub: string, name: string, role: string, loc: string | null) =>
  createToken({ sub, name, role, loc, sv: 0 })

// fiksature: lokacija + OWNER (centralna vloga z settings.manage)
const loc = await db.location.create({
  data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}lokacija`, code: `${PREFIX}LC${RUN.slice(-4)}`, country: 'SI' },
})
locId = loc.id
const owner = await db.employee.create({
  data: { id: `${PREFIX}emp-${RUN}`, name: `${PREFIX}owner`, email: `${PREFIX}owner-${RUN}@test.local`, role: 'OWNER', status: 'active', locationId: locId, pin: PIN, pinLookup: `${PREFIX}pl-${RUN}` },
})
ownerId = owner.id

describe('Task 42 — unique kolizijski hardening', () => {
  test('U1: employees — 2 vzporedna POST z istim email → EN 201 + EN 409 (brez 500)', async () => {
    const t = tokenFor(ownerId, `${PREFIX}owner`, 'OWNER', locId)
    const email = `${PREFIX}dupe-${RUN}@test.local`
    const body = { name: `${PREFIX}dup`, email, pin: PIN, role: 'WAITER', locationId: locId }
    const [r1, r2] = await Promise.all([
      employeesPOST(req('/api/employees', t, 'POST', body)),
      employeesPOST(req('/api/employees', t, 'POST', body)),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([201, 409])
    // natanko EN vrstica v bazi
    const rows = await db.employee.findMany({ where: { email } })
    expect(rows).toHaveLength(1)
  })

  test('U2: locations — nova lokacija BREZ premisesId (fiksatura že zaseda prazno oznako) → 409 z akcijskim sporočilom, ne 500/P2002', async () => {
    const t = tokenFor(ownerId, `${PREFIX}owner`, 'OWNER', locId)
    const r = await locationsPOST(req('/api/locations', t, 'POST', { name: `${PREFIX}lok-2-${RUN}`, code: `${PREFIX}L2${RUN.slice(-4)}` }))
    expect(r.status).toBe(409)
    const j = await r.json()
    // Task 42: akcijsko sporočilo (razlikuje premisesId kolizijo od kodne) namesto
    // generičnega 'Koda ali FURS poslovni prostor že obstaja.'
    expect(String(j.error)).toContain('FURS oznako')
  })

  test('U3: locations — 2. lokacija z UNIKATNO kodo in FURS oznako uspe (multi-lokacija deluje)', async () => {
    const t = tokenFor(ownerId, `${PREFIX}owner`, 'OWNER', locId)
    const r = await locationsPOST(req('/api/locations', t, 'POST', {
      name: `${PREFIX}lok-3-${RUN}`,
      code: `${PREFIX}L3${RUN.slice(-4)}`,
      premisesId: `${PREFIX}PP${RUN.slice(-6)}`,
    }))
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.location.premisesId).toBe(`${PREFIX}PP${RUN.slice(-6)}`)
  })
})

afterAll(async () => {
  // cleanup v obratni smeri FK: AuditLog (brez FK, samo higiena) → Employee → Location
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: PREFIX } }, { userId: { startsWith: PREFIX } }] } })
  await db.employee.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { email: { contains: PREFIX } }] } })
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } })
  await db.$disconnect()
})

export { locId, ownerId }
