/**
 * Issue #23 (P1) — write-only skrivnosti: nikoli ne vračaj obstoječih gesel/
 * certifikatov/zasebnih ključev/API key/secret/tokenov — NITI OWNER/ADMIN.
 * Issue #42 (P1) — integracije po ID-ju: PATCH/DELETE/test (in POST target)
 * preverjajo tenant/lokacijski obseg; globalne integracije = izrecna centralna
 * operacija; premik na drug locationId preveri OBOJE (vir + cilj).
 *
 * Živa produkcijska predpostavka (v1.89.0, task 23-42-verify): manager z
 * settings.manage je s PATCH odmevom prebral VAPID privateKey globalne
 * integracije, ki je NI VIDEL v seznamu — to točko tu pokrivamo regijsko.
 *
 * ID-ji s predpono `i23-` (idempotentno, sweep beforeAll/afterAll).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { SECRET_MASK, safeSettingsDto, safeLocationDto, safeIntegrationDto } from '../src/lib/secret-dto'
import { GET as settingsGET, PUT as settingsPUT } from '../src/app/api/settings/route'
import { GET as locationsGET, POST as locationsPOST } from '../src/app/api/locations/route'
import { PATCH as locationPATCH } from '../src/app/api/locations/[id]/route'
import { GET as integrationsGET, POST as integrationsPOST } from '../src/app/api/integrations/route'
import { PATCH as integrationPATCH, DELETE as integrationDELETE } from '../src/app/api/integrations/[id]/route'
import { POST as testConnectionPOST } from '../src/app/api/integrations/[id]/test/route'

const PREFIX = 'i23-'
const RUN = Date.now().toString(36)

let orgA = '', propA = '', brandA = ''
let orgB = '', propB = '', brandB = ''
let locA1 = '', locB1 = '', locA2 = ''
let adminA = '', adminB = '', managerA = '', adminPlat = ''
let integGlobal = '', integA = '', integB = ''
let integrationSeq = 0

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
  const v = (await (r as Promise<unknown> | Response)) as unknown
  expect(v instanceof Response).toBe(true)
  const res = v as Response
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function seedEmployee(name: string, role: string, loc: string | null, pinSeq: number): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
  const pin = String(10000000 + ([...`${id}${pinSeq}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 89999999, 7)))
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${PREFIX}${name}`, email: `${PREFIX}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
  return id
}

/** Integracijska fiksatura (apiKey/apiSecret/config z živimi vrednostmi). */
async function seedIntegration(name: string, locationId: string | null, config: Record<string, unknown>, apiKey = '', apiSecret = ''): Promise<string> {
  return (await db.integration.create({
    data: {
      id: `${PREFIX}${name}-${RUN}`, name: `${PREFIX}${name}`, type: 'other', provider: 'test',
      baseUrl: 'https://i23-example.invalid', apiKey, apiSecret,
      locationId,
      config: JSON.stringify(config),
    },
  })).id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  orgA = `${PREFIX}orgA-${RUN}`; brandA = `${PREFIX}brandA-${RUN}`; propA = `${PREFIX}propA-${RUN}`
  orgB = `${PREFIX}orgB-${RUN}`; brandB = `${PREFIX}brandB-${RUN}`; propB = `${PREFIX}propB-${RUN}`
  locA1 = `${PREFIX}locA1-${RUN}`; locB1 = `${PREFIX}locB1-${RUN}`; locA2 = `${PREFIX}locA2-${RUN}`
  await db.organization.create({ data: { id: orgA, name: 'I23 Org A', slug: `${PREFIX}a-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: 'I23 Org B', slug: `${PREFIX}b-${RUN}` } })
  await db.brand.create({ data: { id: brandA, organizationId: orgA, name: 'BA' } })
  await db.brand.create({ data: { id: brandB, organizationId: orgB, name: 'BB' } })
  await db.property.create({ data: { id: propA, brandId: brandA, name: 'PA' } })
  await db.property.create({ data: { id: propB, brandId: brandB, name: 'PB' } })
  await db.location.create({ data: { id: locA1, name: 'I23 A1', code: `${PREFIX}A1-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB1, name: 'I23 B1', code: `${PREFIX}B1-${RUN}`, propertyId: propB } })
  // lokacija z NASTAVLJENIM fursCertPassword (maska mora zamenjati surovo vrednost)
  await db.location.create({ data: { id: locA2, name: 'I23 A2', code: `${PREFIX}A2-${RUN}`, propertyId: propA, fursCertPassword: 'LOC-SECRET-A2' } })

  adminA = await seedEmployee('adminA', 'admin', locA1, 1)
  adminB = await seedEmployee('adminB', 'admin', locB1, 2)
  managerA = await seedEmployee('managerA', 'manager', locA1, 3) // MANAGER = settings.manage (kot vodja@ na produkciji)
  // platform-level admin (loc null, kot produkcijski info@) — upravlja GLOBALNE integracije
  adminPlat = await seedEmployee('adminPlat', 'admin', null, 4)

  // nastavitve z živimi skrivnostmi (enak vzorec kot issue5 fiksatura)
  await db.restaurantSettings.create({
    data: {
      id: `${PREFIX}settings-${RUN}`, name: 'I23 Test', fursCertPassword: 'SECRET-FURS-123',
      emailSmtpPassword: 'SECRET-SMTP-456', apiKeys: '["SECRET-API"]', cisCertPassword: 'SECRET-CIS-789',
      receiptFooter: 'I23 footer', currency: 'EUR',
    },
  })

  // VAPID-like globalna integracija (produkcijski push-vapid vzorec)
  integGlobal = await seedIntegration('global-vapid', null, {
    publicKey: 'BJH-public-key-value', privateKey: 'tadl-private-key-value', subject: 'mailto:i23@test.local',
  }, 'ak-global-1', 'as-global-1')
  // org-scoped integraciji
  integA = await seedIntegration('integ-a', locA1, { apiKey_a: 'sk-a-1', region: 'eu' }, 'ak-a-1', 'as-a-1')
  integB = await seedIntegration('integ-b', locB1, { apiKey_b: 'sk-b-1', region: 'si' })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

/* ══════════════════════ #23 — maskiranje skrivnosti ══════════════════════ */

describe('issue #23 — write-only skrivnosti (varni DTO-ji tudi za nastavitvene vloge)', () => {
  it('settings GET (settings.manage): skrivnosti = maska, NIKOLI surove vrednosti', async () => {
    const r = await status(settingsGET(req('/api/settings', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(r.code).toBe(200)
    const s = r.body.settings as Record<string, unknown>
    expect(s.fursCertPassword).toBe(SECRET_MASK)
    expect(s.emailSmtpPassword).toBe(SECRET_MASK)
    expect(s.cisCertPassword).toBe(SECRET_MASK)
    expect(s.apiKeys).toBe(SECRET_MASK) // neprazen seznam → maska
    expect(s.name).toBe('I23 Test') // poslovni podatki ostanejo
    expect(s.receiptFooter).toBe('I23 footer')
    // surove vrednosti se nikjer v odgovoru ne smejo pojaviti
    expect(JSON.stringify(r.body)).not.toContain('SECRET-')
  })

  it('settings PUT: odgovor odmeva VARNI DTO (ne obstoječih skrivnosti)', async () => {
    const r = await status(settingsPUT(req('/api/settings', tok(adminA, 'a', 'ADMIN', locA1), 'PUT', { name: 'I23 Test 2' })))
    expect(r.code).toBe(200)
    const s = r.body.settings as Record<string, unknown>
    expect(s.name).toBe('I23 Test 2')
    expect(s.fursCertPassword).toBe(SECRET_MASK)
    expect(JSON.stringify(r.body)).not.toContain('SECRET-')
    // DB ostane nedotaknjen (write-only: sprememba imena ne pobriše skrivnosti)
    const row = await db.restaurantSettings.findUnique({ where: { id: `${PREFIX}settings-${RUN}` } })
    expect(row?.fursCertPassword).toBe('SECRET-FURS-123')
  })

  it('settings GET minimal (brez settings.manage): skrivnosti ODSOTNE (vzorec #5 ostaja)', async () => {
    const wTok = tok(await seedEmployee('waiterA', 'waiter', locA1, 9), 'w', 'WAITER', locA1)
    const r = await status(settingsGET(req('/api/settings', wTok)))
    expect(r.code).toBe(200)
    const s = r.body.settings as Record<string, unknown>
    expect(Object.keys(s)).not.toContain('fursCertPassword')
    expect(Object.keys(s)).not.toContain('apiKeys')
  })

  it('locations GET/POST/PATCH: fursCertPassword = maska (ne LOC-SECRET-A2)', async () => {
    const r = await status(locationsGET(req('/api/locations', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(r.code).toBe(200)
    const locs = r.body.locations as Array<Record<string, unknown>>
    const a2 = locs.find((l) => l.id === locA2)
    expect(a2).toBeDefined()
    expect(a2!.fursCertPassword).toBe(SECRET_MASK)
    expect(JSON.stringify(r.body)).not.toContain('LOC-SECRET-A2')
    // POST odgovor = varni DTO (fursCertPassword prisoten kot indikator '')
    const p = await status(locationsPOST(req('/api/locations', tok(adminA, 'a', 'ADMIN', locA1), 'POST', {
      name: `${PREFIX}Nova`, code: `${PREFIX}NV-${RUN}`, locationId: locA1,
    })))
    expect(p.code).toBe(201)
    expect((p.body.location as Record<string, unknown>).fursCertPassword).toBe('')
    // PATCH lastne lokacije = 200 + varni DTO
    const u = await status(locationPATCH(req(`/api/locations/${locA2}`, tok(adminA, 'a', 'ADMIN', locA1), 'PATCH', { phone: '01' }), { params: Promise.resolve({ id: locA2 }) }))
    expect(u.code).toBe(200)
    expect((u.body.location as Record<string, unknown>).fursCertPassword).toBe(SECRET_MASK)
    expect(JSON.stringify(u.body)).not.toContain('LOC-SECRET-A2')
  })

  it('integrations GET: config maskiran ZA VSE vloge (tudi centralna) + apiKey/apiSecret indikator', async () => {
    const r = await status(integrationsGET(req('/api/integrations', tok(adminA, 'a', 'ADMIN', locA1))))
    expect(r.code).toBe(200)
    const list = r.body.integrations as Array<Record<string, unknown>>
    // ZAVEZANA centralna vloga orgA vidi SAMO svoje (locationScope org allow-lista) —
    // globalnih (locationId null) and orgB NE vidi (list↔mutacija konsistentnost)
    expect(list.some((x) => x.id === integGlobal)).toBe(false)
    expect(list.some((x) => x.id === integA)).toBe(true)
    expect(list.some((x) => x.id === integB)).toBe(false)
    const a = list.find((x) => x.id === integA)!
    const cfgA = a.config as Record<string, unknown>
    expect(cfgA.apiKey_a).toBe(SECRET_MASK) // tudi centralna vloga vidi masko (#23 §3)
    expect(cfgA.region).toBe('eu')
    expect(a.apiKey).toBe(SECRET_MASK)
    // PLATFORM admin (loc null) vidi globalno + vse — preveri masko VAPID vzorca
    const rp = await status(integrationsGET(req('/api/integrations', tok(adminPlat, 'p', 'ADMIN', null))))
    expect(rp.code).toBe(200)
    const listP = rp.body.integrations as Array<Record<string, unknown>>
    expect(listP.some((x) => x.id === integGlobal)).toBe(true)
    const g = listP.find((x) => x.id === integGlobal)!
    const cfg = g.config as Record<string, unknown>
    expect(cfg.privateKey).toBe(SECRET_MASK) // #23 §3: VAPID privateKey ZA VSE vloge maskiran
    expect(cfg.publicKey).toBe('BJH-public-key-value') // javni ključ ostaja viden
    expect(cfg.subject).toBe('mailto:i23@test.local')
    expect((g.maskedFields as string[]).sort()).toEqual(['privateKey'].sort())
    expect(g.apiKey).toBe(SECRET_MASK) // nastavljen → indikator
    expect(g.apiSecret).toBe(SECRET_MASK)
    expect(JSON.stringify(rp.body)).not.toContain('tadl-private-key-value')
    expect(JSON.stringify(rp.body)).not.toContain('as-global-1')
    // integracija BREZ apiKey → iskren prazen indikator
    const noKey = await seedIntegration('integ-nokey', locA1, { region: 'eu' })
    const r2 = await status(integrationsGET(req('/api/integrations', tok(adminA, 'a', 'ADMIN', locA1))))
    const list2 = r2.body.integrations as Array<Record<string, unknown>>
    expect((list2.find((x) => x.id === noKey))!.apiKey).toBe('')
  })

  it('integrations POST: odgovor = varni DTO (ne odmeva poslanih apiKey/apiSecret/config skrivnosti)', async () => {
    const r = await status(integrationsPOST(req('/api/integrations', tok(adminA, 'a', 'ADMIN', locA1), 'POST', {
      name: `${PREFIX}created-${++integrationSeq}`, type: 'delivery',
      baseUrl: 'https://api.example.com',
      apiKey: 'ak-new-secret', apiSecret: 'as-new-secret',
      config: { apiKey_cfg: 'sk-cfg-secret', region: 'eu' },
      locationId: locA1,
    })))
    expect(r.code).toBe(201)
    const it = r.body.integration as Record<string, unknown>
    expect(it.apiKey).toBe(SECRET_MASK)
    expect(it.apiSecret).toBe(SECRET_MASK)
    expect((it.config as Record<string, unknown>).apiKey_cfg).toBe(SECRET_MASK)
    expect((it.config as Record<string, unknown>).region).toBe('eu')
    expect(JSON.stringify(r.body)).not.toContain('ak-new-secret')
    expect(JSON.stringify(r.body)).not.toContain('sk-cfg-secret')
  })

  it('integrations PATCH/DELETE: odgovor = varni DTO (brez surovih vrednosti)', async () => {
    const id = await seedIntegration('patchme', locA1, { apiKey_pm: 'sk-pm-1' }, 'ak-pm', 'as-pm')
    const p = await status(integrationPATCH(req(`/api/integrations/${id}`, tok(adminA, 'a', 'ADMIN', locA1), 'PATCH', { syncInterval: 600 }), { params: Promise.resolve({ id }) }))
    expect(p.code).toBe(200)
    const it = p.body.integration as Record<string, unknown>
    expect(it.apiKey).toBe(SECRET_MASK)
    expect((it.config as Record<string, unknown>).apiKey_pm).toBe(SECRET_MASK)
    expect(JSON.stringify(p.body)).not.toContain('sk-pm-1')
    expect(JSON.stringify(p.body)).not.toContain('ak-pm')
    const d = await status(integrationDELETE(req(`/api/integrations/${id}`, tok(adminA, 'a', 'ADMIN', locA1), 'DELETE'), { params: Promise.resolve({ id }) }))
    expect(d.code).toBe(200)
    expect(JSON.stringify(d.body)).not.toContain('sk-pm-1')
    expect(((d.body.integration as Record<string, unknown>)).apiKey).toBe(SECRET_MASK)
  })

  it('DTO helperji: enote (maskSecretValue/safeSettingsDto/safeLocationDto/safeIntegrationDto)', () => {
    // safeIntegrationDto tip: Prisma vrstica minimale
    const row = {
      id: 'x', name: 'n', type: 't', provider: 'p', baseUrl: 'https://e.invalid',
      apiKey: 'ak', apiSecret: 'as', syncEnabled: true, syncInterval: 300, lastSyncAt: null,
      lastSyncStatus: '', lastSyncError: 'err', isActive: true, connectionStatus: 'connected',
      locationId: null, config: { publicKey: 'pk', privateKey: 'pr' }, events: [],
      createdAt: new Date(), updatedAt: new Date(),
    } as never as import('@prisma/client').Integration
    const dto = safeIntegrationDto(row, { central: false })
    expect(dto.lastSyncError).toBe('') // non-central ne vidi
    const dtoC = safeIntegrationDto(row, { central: true })
    expect(dtoC.lastSyncError).toBe('err')
  })
})

/* ══════════════════════ #42 — tenant obseg integracij po ID-ju ══════════════════════ */

describe('issue #42 — integracije po ID-ju: PATCH/DELETE/test/POST scope', () => {
  it('admin orgA NE more PATCH/DELETE/testirati integracije orgB (znani ID)', async () => {
    const t = tok(adminA, 'a', 'ADMIN', locA1)
    const p = await status(integrationPATCH(req(`/api/integrations/${integB}`, t, 'PATCH', { syncInterval: 600 }), { params: Promise.resolve({ id: integB }) }))
    expect(p.code).toBe(403)
    const d = await status(integrationDELETE(req(`/api/integrations/${integB}`, t, 'DELETE'), { params: Promise.resolve({ id: integB }) }))
    expect(d.code).toBe(403)
    // test pot: 403 PRED omrežnim klicem (baseUrl .invalid — dokaz, da sploh ne poizkusi)
    const ts = await status(testConnectionPOST(req(`/api/integrations/${integB}/test`, t, 'POST'), { params: Promise.resolve({ id: integB }) }))
    expect(ts.code).toBe(403)
    // DB nedotaknjena
    const row = await db.integration.findUnique({ where: { id: integB } })
    expect(row?.syncInterval).toBe(300)
    expect(row?.isActive).toBe(true)
  })

  it('admin orgA NE more prestaviti lastne integracije v lokacijo orgB', async () => {
    const t = tok(adminA, 'a', 'ADMIN', locA1)
    const p = await status(integrationPATCH(req(`/api/integrations/${integA}`, t, 'PATCH', { locationId: locB1 }), { params: Promise.resolve({ id: integA }) }))
    expect(p.code).toBe(403)
    const row = await db.integration.findUnique({ where: { id: integA } })
    expect(row?.locationId).toBe(locA1) // premik se ni zgodil
  })

  it('MANAGER (non-central, settings.manage): globalna integracija = 403 na PATCH/DELETE/test', async () => {
    const t = tok(managerA, 'm', 'MANAGER', locA1)
    // živa produkcija v1.89.0: točno ta pot je razkrila VAPID privateKey — zdaj 403
    const p = await status(integrationPATCH(req(`/api/integrations/${integGlobal}`, t, 'PATCH', { syncInterval: 300 }), { params: Promise.resolve({ id: integGlobal }) }))
    expect(p.code).toBe(403)
    const d = await status(integrationDELETE(req(`/api/integrations/${integGlobal}`, t, 'DELETE'), { params: Promise.resolve({ id: integGlobal }) }))
    expect(d.code).toBe(403)
    const ts = await status(testConnectionPOST(req(`/api/integrations/${integGlobal}/test`, t, 'POST'), { params: Promise.resolve({ id: integGlobal }) }))
    expect(ts.code).toBe(403)
    const row = await db.integration.findUnique({ where: { id: integGlobal } })
    expect(row?.isActive).toBe(true)
    expect(row?.connectionStatus).toBe('disconnected') // test se ni izvedel
  })

  it('MANAGER: lastna lokacijska integracija = 200 (pozitivna pot) + varni DTO', async () => {
    const t = tok(managerA, 'm', 'MANAGER', locA1)
    const p = await status(integrationPATCH(req(`/api/integrations/${integA}`, t, 'PATCH', { syncInterval: 450 }), { params: Promise.resolve({ id: integA }) }))
    expect(p.code).toBe(200)
    const it = p.body.integration as Record<string, unknown>
    expect(it.syncInterval).toBe(450)
    expect(it.apiKey).toBe(SECRET_MASK) // tudi manager dobi samo indikator
    expect((it.config as Record<string, unknown>).apiKey_a).toBe(SECRET_MASK)
    expect(JSON.stringify(p.body)).not.toContain('sk-a-1')
    // seznam za managerja VSEBUJE lastno lokacijsko integracijo (list↔mutacija konsistentna)
    const g = await status(integrationsGET(req('/api/integrations', t)))
    expect(g.code).toBe(200)
    const list = g.body.integrations as Array<Record<string, unknown>>
    expect(list.some((x) => x.id === integA)).toBe(true)
    expect(list.some((x) => x.id === integGlobal)).toBe(false) // globalnih ne vidi
  })

  it('MANAGER: premik lastne integracije v GLOBALNO (null) → 403 (izrecna centralna operacija)', async () => {
    const t = tok(managerA, 'm', 'MANAGER', locA1)
    const p = await status(integrationPATCH(req(`/api/integrations/${integA}`, t, 'PATCH', { locationId: null }), { params: Promise.resolve({ id: integA }) }))
    expect(p.code).toBe(403)
    const row = await db.integration.findUnique({ where: { id: integA } })
    expect(row?.locationId).toBe(locA1)
  })

  it('CENTRALNA ZAVEZANA vloga (adminA, orgA): globalna integracija = 403 (niti je ne vidi v seznamu)', async () => {
    const t = tok(adminA, 'a', 'ADMIN', locA1)
    const p = await status(integrationPATCH(req(`/api/integrations/${integGlobal}`, t, 'PATCH', { syncInterval: 360 }), { params: Promise.resolve({ id: integGlobal }) }))
    expect(p.code).toBe(403)
  })

  it('PLATFORM admin (loc null): globalna integracija = 200 (izrecna platform-level operacija)', async () => {
    const t = tok(adminPlat, 'p', 'ADMIN', null)
    const p = await status(integrationPATCH(req(`/api/integrations/${integGlobal}`, t, 'PATCH', { syncInterval: 360 }), { params: Promise.resolve({ id: integGlobal }) }))
    expect(p.code).toBe(200)
    const it = p.body.integration as Record<string, unknown>
    expect(it.syncInterval).toBe(360)
    expect(it.apiKey).toBe(SECRET_MASK) // tudi platform admin vidi samo indikator (#23)
    expect((it.config as Record<string, unknown>).privateKey).toBe(SECRET_MASK)
    // povrni na 300 za ostale teste
    await db.integration.update({ where: { id: integGlobal }, data: { syncInterval: 300 } })
  })

  it('POST: ciljna lokacija orgB → 403; manager brez locationId → VEZANO na svojo lokacijo', async () => {
    const adminTok = tok(adminA, 'a', 'ADMIN', locA1)
    const b = await status(integrationsPOST(req('/api/integrations', adminTok, 'POST', {
      name: `${PREFIX}post-b-${RUN}`, locationId: locB1,
    })))
    expect(b.code).toBe(403)
    // manager brez locationId → samodejno VEZANA na lastno lokacijo (ni več globalna!)
    const mgrTok = tok(managerA, 'm', 'MANAGER', locA1)
    const m = await status(integrationsPOST(req('/api/integrations', mgrTok, 'POST', {
      name: `${PREFIX}post-m-${RUN}`, type: 'delivery',
    })))
    expect(m.code).toBe(201)
    expect((m.body.integration as Record<string, unknown>).locationId).toBe(locA1)
    const id = (m.body.integration as Record<string, unknown>).id as string
    // manager vidi svojo v seznamu
    const g = await status(integrationsGET(req('/api/integrations', mgrTok)))
    expect((g.body.integrations as Array<Record<string, unknown>>).some((x) => x.id === id)).toBe(true)
  })

  it('locations PATCH: admin orgA NE more patchati lokacije orgB (settings.manage ne zadostuje)', async () => {
    const t = tok(adminA, 'a', 'ADMIN', locA1)
    const r = await status(locationPATCH(req(`/api/locations/${locB1}`, t, 'PATCH', { phone: '02' }), { params: Promise.resolve({ id: locB1 }) }))
    expect(r.code).toBe(403)
    const row = await db.location.findUnique({ where: { id: locB1 } })
    expect(row?.phone).not.toBe('02')
  })
})
