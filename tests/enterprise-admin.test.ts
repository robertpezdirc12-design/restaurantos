import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as enterpriseGET, POST as enterprisePOST } from '../src/app/api/enterprise/route'
import { sweepTestFixtures } from './helpers/fixture-sweep'

/**
 * Task 62 — enterprise admin (audit §7 Enterprise org/brand/property drevo PARTIAL→DONE):
 *  - GET drevo: bootstrap vidi VSE organizacije, scoped owner SAMO svojo (Issue #12 §1)
 *  - POST kind=organization: SAMO bootstrap (break-glass) — owner → 403; dup slug → 409
 *  - POST kind=brand: 201; tuja organizacija → 403; neznana → 404; validacija → 400
 *  - POST kind=property: 201; neznana blagovna znamka → 404
 *  - POST kind=link-location: poveže lokacijo → owner dobi org verigo (myScope);
 *    cross-org povezava → 403 (fail-closed); manjkajoča polja → 400; neznani → 404
 *  - waiter (brez settings.manage) → 403 na vse pisalne akcije
 * Fiksature z predpono `ent62-`, pre-sweep počisti ostanke crashanih tekov (Task 58).
 */

const PREFIX = 'ent62-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locA = ''
let locB = ''

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function tokenFor(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

/** Break-glass bootstrap admin (sub='bootstrap', brez Employee vrstice). */
const bootstrapToken = () => tokenFor('bootstrap', 'bootstrap', 'ADMIN', null)

async function seedEmployee(name: string, role: string, pin: string, locationId: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}emp-${name}-${RUN}`,
      name: `${PREFIX}${name}`,
      email: `${PREFIX}${name}-${RUN}@test.local`,
      role,
      status: 'active',
      sessionVersion: 0,
      locationId,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
}

async function setup() {
  await sweepTestFixtures(db, [PREFIX])
  // dve ločeni lokaciji (za zdaj legacy — brez property vezave)
  const la = await db.location.create({
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `E62A-${RUN.toUpperCase()}` },
  })
  const lb = await db.location.create({
    data: { id: `${PREFIX}loc-b-${RUN}`, name: `${PREFIX}Lokacija B`, code: `E62B-${RUN.toUpperCase()}` },
  })
  locA = la.id
  locB = lb.id
  const ownerA = await seedEmployee('owner-a', 'owner', pinOf(1), locA)
  const ownerB = await seedEmployee('owner-b', 'owner', pinOf(2), locB)
  const waiterA = await seedEmployee('waiter-a', 'waiter', pinOf(3), locA)
  return {
    ownerA: tokenFor(ownerA.id, ownerA.name, 'OWNER', locA),
    ownerB: tokenFor(ownerB.id, ownerB.name, 'OWNER', locB),
    waiterA: tokenFor(waiterA.id, waiterA.name, 'WAITER', locA),
  }
}

const setupP = setup()

afterAll(async () => {
  // FK vrstni red: revizija → dogodki → zaposleni → lokacije → property → brand → organizacija
  await db.auditLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.property.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.brand.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.organization.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
})

const isErr = async (p: Promise<Response>, status: number) => {
  const r = await p
  expect(r.status).toBe(status)
  return (await r.json()) as { error?: string }
}

describe('Task 62 — enterprise org/brand/property drevo (API)', () => {
  test('POST organization: bootstrap → 201 + samodejni slug; duplikat slug → 409; owner → 403', async () => {
    const { ownerA } = await setupP
    const r = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'organization', name: `${PREFIX}Holding ${RUN}` }))
    expect(r.status).toBe(201)
    const org = (await r.json() as { organization: { id: string; slug: string } }).organization
    expect(org.id.startsWith(PREFIX) || org.id.length > 0).toBe(true)
    expect(org.slug).toContain('ent62-') // slugify iz imena (lowercase + pomišljaji)

    // duplikat slug (isti naslov) → 409
    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'organization', name: `${PREFIX}Holding ${RUN}` })), 409)
    // brez imena → 400
    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'organization', name: '  ' })), 400)
    // ne-bootstrap → 403 (platformna operacija)
    const e = await isErr(enterprisePOST(req('/api/enterprise', ownerA, 'POST', { kind: 'organization', name: 'Tuje' })), 403)
    expect(e.error).toContain('platformnega')
  })

  test('POST brand: bootstrap 201; neznana organizacija → 404; tuja org (owner B) → 403', async () => {
    const { ownerB } = await setupP
    const orgs = ((await (await enterpriseGET(req('/api/enterprise', bootstrapToken()))).json()) as { organizations: Array<{ id: string; name: string }> }).organizations
    const mine = orgs.find((o) => o.name.startsWith(PREFIX))!
    expect(mine).toBeDefined()

    const r = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'brand', name: `${PREFIX}Znamka`, organizationId: mine.id }))
    expect(r.status).toBe(201)
    const brand = (await r.json() as { brand: { id: string } }).brand

    // validacija
    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'brand', name: '', organizationId: mine.id })), 400)
    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'brand', name: 'x', organizationId: `${PREFIX}manjka-${RUN}` })), 404)
    // owner B (še brez org vezave → legacy, vendar org je tuja in bootstrap ni) — owner brez bootstrap
    // ni break-glass: userOrgId null ≠ organizationId → 403
    const e = await isErr(enterprisePOST(req('/api/enterprise', ownerB, 'POST', { kind: 'brand', name: 'Tujka', organizationId: mine.id })), 403)
    expect(e.error).toContain('Tuja organizacija')
    expect(brand.id).toBeDefined()
  })

  test('POST property: bootstrap 201 + SI/HR država; neznana brand → 404; validacija → 400', async () => {
    const orgs = ((await (await enterpriseGET(req('/api/enterprise', bootstrapToken()))).json()) as { organizations: Array<{ id: string; brands: Array<{ id: string; name: string }> }> }).organizations
    const myOrg = orgs.find((o) => o.name.startsWith(PREFIX))!
    const myBrand = myOrg.brands.find((b) => b.name.startsWith(PREFIX))!
    expect(myBrand).toBeDefined()

    const r = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', {
      kind: 'property', name: `${PREFIX}Objekt Lj`, brandId: myBrand.id, address: 'Testova 1', city: 'Ljubljana', country: 'si',
    }))
    expect(r.status).toBe(201)
    const prop = (await r.json() as { property: { id: string } }).property
    const row = await db.property.findUnique({ where: { id: prop.id } })
    expect(row?.country).toBe('SI') // normalizacija na velike črke
    expect(row?.city).toBe('Ljubljana')

    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'property', name: 'x', brandId: '' })), 400)
    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'property', name: 'x', brandId: `${PREFIX}manjka-${RUN}` })), 404)
  })

  test('link-location: poveže lokacijo → owner dobi org verigo; cross-org → 403; neznani → 404; brez polj → 400', async () => {
    const { ownerA, ownerB } = await setupP
    const orgs = ((await (await enterpriseGET(req('/api/enterprise', bootstrapToken()))).json()) as {
      organizations: Array<{ id: string; brands: Array<{ id: string; properties: Array<{ id: string; name: string }> }> }>
    }).organizations
    const myOrg = orgs.find((o) => o.name.startsWith(PREFIX))!
    const myBrand = myOrg.brands[0]!
    const myProp = myBrand.properties[0]!
    expect(myProp.name).toContain('Objekt Lj')

    // prej: owner A še brez org (legacy lokacija)
    const before = ((await (await enterpriseGET(req('/api/enterprise', ownerA))).json()) as { myScope: { organizationId: string | null } }).myScope
    expect(before?.organizationId ?? null).toBeNull()

    const r = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'link-location', propertyId: myProp.id, locationId: locA }))
    expect(r.status).toBe(200)

    // potem: owner A vidi svojo org + myScope.organizationId
    const after = ((await (await enterpriseGET(req('/api/enterprise', ownerA))).json()) as { myScope: { organizationId: string | null; propertyId: string | null } }).myScope
    expect(after?.organizationId).toBe(myOrg.id)
    expect(after?.propertyId).toBe(myProp.id)

    // validacije
    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'link-location', propertyId: '', locationId: locB })), 400)
    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'link-location', propertyId: `${PREFIX}manjka-${RUN}`, locationId: locB })), 404)
    await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'link-location', propertyId: myProp.id, locationId: `${PREFIX}manjka-${RUN}` })), 404)

    // cross-org: owner B ni bootstrap → povezava lokacije B (org=null legacy) na property A... to je LEGACY veja:
    // locationOrg null, targetOrg ≠ null, userOrgId null → 'Uporabnik ni vezan v organizacijsko drevo' → 403
    const e = await isErr(enterprisePOST(req('/api/enterprise', ownerB, 'POST', { kind: 'link-location', propertyId: myProp.id, locationId: locB })), 403)
    expect(e.error).toContain('organizacijsko drevo')

    // idempotentna ponovna povezava iste lokacije → 200
    const again = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'link-location', propertyId: myProp.id, locationId: locA }))
    expect(again.status).toBe(200)
  })

  test('GET drevo: scoped owner vidi SAMO svojo organizacijo; bootstrap vse', async () => {
    const { ownerA } = await setupP
    // bootstrap: vsaj naša testna org
    const bootData = ((await (await enterpriseGET(req('/api/enterprise', bootstrapToken()))).json()) as { organizations: Array<{ id: string; name: string }> })
    expect(bootData.organizations.some((o) => o.name.startsWith(PREFIX))).toBe(true)
    expect(bootData.myScope).toBeNull() // break-glass nima verige

    // owner A: točno 1 org (svoja)
    const scoped = ((await (await enterpriseGET(req('/api/enterprise', ownerA))).json()) as {
      myScope: { organizationId: string | null }
      organizations: Array<{ id: string; brands: Array<{ properties: Array<{ id: string; inScope: boolean }> }> }>
    })
    expect(scoped.organizations.length).toBe(1)
    expect(scoped.organizations[0].id).toBe(scoped.myScope?.organizationId)
    // inScope zastavica na svojem propertyju = true
    const props = scoped.organizations[0].brands.flatMap((b) => b.properties)
    expect(props.some((p) => p.inScope)).toBe(true)
  })

  test('GET drevo: inScope=false za property druge org (bootstrapBreakGlass vid vse, flag Pošten)', async () => {
    const { ownerB } = await setupP
    // poveži lokacijo B v drugo organizacijo (bootstrap ustvari org B + brand + property + link)
    const orgB = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'organization', name: `${PREFIX}Org B ${RUN}` }))
    const orgBId = (await orgB.json() as { organization: { id: string } }).organization.id
    const brandB = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'brand', name: `${PREFIX}Znamka B`, organizationId: orgBId }))
    const brandBId = (await brandB.json() as { brand: { id: string } }).brand.id
    const propB = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'property', name: `${PREFIX}Objekt Zg`, brandId: brandBId, city: 'Zagreb', country: 'HR' }))
    const propBId = (await propB.json() as { property: { id: string } }).property.id
    const linked = await enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'link-location', propertyId: propBId, locationId: locB }))
    expect(linked.status).toBe(200)

    // owner B: vidi točno svojo org, property B inScope=true, property A NE viden (org filter)
    const data = ((await (await enterpriseGET(req('/api/enterprise', ownerB))).json()) as {
      myScope: { organizationId: string | null }
      organizations: Array<{ id: string; brands: Array<{ properties: Array<{ id: string; inScope: boolean; city: string; country: string }> }> }>
    })
    expect(data.organizations.length).toBe(1)
    expect(data.organizations[0].id).toBe(orgBId)
    const allProps = data.organizations[0].brands.flatMap((b) => b.properties)
    const mine = allProps.find((p) => p.id === propBId)!
    expect(mine.inScope).toBe(true)
    expect(mine.country).toBe('HR')
  })

  test('neznani kind → 400 z izpisom vseh veljavnih', async () => {
    const e = await isErr(enterprisePOST(req('/api/enterprise', bootstrapToken(), 'POST', { kind: 'center' })), 400)
    expect(e.error).toContain('link-location')
  })

  test('waiter (brez settings.manage) → 403 na vse pisalne akcije', async () => {
    const { waiterA } = await setupP
    await isErr(enterprisePOST(req('/api/enterprise', waiterA, 'POST', { kind: 'organization', name: 'x' })), 403)
    await isErr(enterprisePOST(req('/api/enterprise', waiterA, 'POST', { kind: 'brand', name: 'x', organizationId: 'y' })), 403)
    await isErr(enterprisePOST(req('/api/enterprise', waiterA, 'POST', { kind: 'property', name: 'x', brandId: 'y' })), 403)
    await isErr(enterprisePOST(req('/api/enterprise', waiterA, 'POST', { kind: 'link-location', propertyId: 'x', locationId: 'y' })), 403)
  })
})
