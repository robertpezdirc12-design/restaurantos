import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken } from '../src/lib/auth'
import { POST as employeesPOST } from '../src/app/api/employees/route'
import { POST as locationsPOST } from '../src/app/api/locations/route'
import { PATCH as locationsPATCH } from '../src/app/api/locations/[id]/route'

/**
 * Task 42 + 44 — hardening unique latentnih kolizij (DB-backed, dev SQLite):
 *  U1 — employees: 2 vzporedna POST z istim email (race okno findUnique→create) →
 *       TOČNO EN 201 + EN 409 (prej: P2002 = 500 na izgubljeno dirko)
 *  U2 — locations: lokacija BREZ FURS premisesId → 201 (Task 44: oznaka je
 *       OPCIJSKA — nullable; prej default("") trčil na P2002 ob 2. lokaciji)
 *  U3 — locations: lokacija z UNIKATNO kodo in FURS oznako uspe (multi-lokacija)
 *  U4 — locations: VEČ lokacij BREZ FURS oznake → vse 201 (več NULL dovoljenih;
 *       to je jedro Task 44 fixa — prej netestabilno/netočno)
 *  U5 — PATCH: čiščenje FURS oznake ('' → null) + ponovna uporaba oznake → 201
 *
 * Predpona fiksatur `uc-` + RUN — cleanup v afterAll v obratni smeri FK.
 */

const PREFIX = 'uc-'
const RUN = Date.now().toString(36)
const PIN = `${String(Date.now()).slice(-6)}2`

let locId = ''
let ownerId = ''
let loc3Id = '' // U3 lokacija (id iz POST responsea — POST ustvari nid() id, ne prefix)

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const tokenFor = (sub: string, name: string, role: string, loc: string | null) =>
  createToken({ sub, name, role, loc, sv: 0 })

// fiksature: lokacija (premisesId ostane NULL — od Task 44 brez default("")) + OWNER
await sweepTestFixtures(db, [PREFIX])
const loc = await db.location.create({
  data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}lokacija`, code: `${PREFIX}LC${RUN.slice(-4)}`, country: 'SI' },
})
locId = loc.id
const owner = await db.employee.create({
  data: { id: `${PREFIX}emp-${RUN}`, name: `${PREFIX}owner`, email: `${PREFIX}owner-${RUN}@test.local`, role: 'OWNER', status: 'active', locationId: locId, pin: PIN, pinLookup: `${PREFIX}pl-${RUN}` },
})
ownerId = owner.id

describe('Task 42 + 44 — unique kolizijski hardening', () => {
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

  test('U2: locations — lokacija BREZ FURS premisesId → 201 (oznaka opcijska, nullable)', async () => {
    const t = tokenFor(ownerId, `${PREFIX}owner`, 'OWNER', locId)
    const r = await locationsPOST(req('/api/locations', t, 'POST', { name: `${PREFIX}lok-2-${RUN}`, code: `${PREFIX}L2${RUN.slice(-4)}` }))
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.location.premisesId).toBeNull()
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
    loc3Id = String(j.location.id)
  })

  test('U4: locations — TRETJA lokacija brez FURS oznake → 201 (več NULL = jedro Task 44)', async () => {
    const t = tokenFor(ownerId, `${PREFIX}owner`, 'OWNER', locId)
    const r = await locationsPOST(req('/api/locations', t, 'POST', { name: `${PREFIX}lok-4-${RUN}`, code: `${PREFIX}L4${RUN.slice(-4)}` }))
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.location.premisesId).toBeNull()
    // v bazi res dve ustvarjeni lokaciji (U2 + U4) z NULL oznako — po IMENU
    // (POST ustvari nid() id, brez prefixa; fiksatura 'uc-lokacija' ne šteje)
    const nulls = await db.location.count({ where: { name: { startsWith: `${PREFIX}lok-` }, premisesId: null } })
    expect(nulls).toBe(2)
  })

  test("U5: PATCH — čiščenje FURS oznake ('' → null) + ponovna uporaba oznake → 201", async () => {
    const t = tokenFor(ownerId, `${PREFIX}owner`, 'OWNER', locId)
    expect(loc3Id).not.toBe('')
    const pp = `${PREFIX}PP${RUN.slice(-6)}`

    const clr = await locationsPATCH(req(`/api/locations/${loc3Id}`, t, 'PATCH', { premisesId: '' }), { params: Promise.resolve({ id: loc3Id }) })
    expect(clr.status).toBe(200)
    const cj = await clr.json()
    expect(cj.location.premisesId).toBeNull()

    // po čiščenju je oznaka prosto uporabna (nova lokacija z isto oznako uspe)
    const reuse = await locationsPOST(req('/api/locations', t, 'POST', {
      name: `${PREFIX}lok-5-${RUN}`,
      code: `${PREFIX}L5${RUN.slice(-4)}`,
      premisesId: pp,
    }))
    expect(reuse.status).toBe(201)
  })

  test('U6: locations — dupliciran FURS poslovni prostor → 409 z jasnim sporočilom', async () => {
    const t = tokenFor(ownerId, `${PREFIX}owner`, 'OWNER', locId)
    const pp = `${PREFIX}PP${RUN.slice(-6)}` // že zasedena (U5 reuse)
    const r = await locationsPOST(req('/api/locations', t, 'POST', {
      name: `${PREFIX}lok-6-${RUN}`,
      code: `${PREFIX}L6${RUN.slice(-4)}`,
      premisesId: pp,
    }))
    expect(r.status).toBe(409)
    const j = await r.json()
    expect(String(j.error)).toContain('FURS poslovni prostor')
  })
})

afterAll(async () => {
  // cleanup v obratni smeri FK: AuditLog (brez FK, samo higiena) → Employee → Location
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: PREFIX } }, { userId: { startsWith: PREFIX } }] } })
  await db.employee.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { email: { contains: PREFIX } }] } })
  await db.location.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { name: { startsWith: PREFIX } }] } }) // Task 44: POST lokacije imajo nid() id → briši po imenu
  await db.$disconnect()
})

export { locId, ownerId }
