import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as integrationsGET, POST as integrationsPOST } from '../src/app/api/integrations/route'
import { PATCH as integrationPATCH, DELETE as integrationDELETE } from '../src/app/api/integrations/[id]/route'
import { POST as testConnectionPOST } from '../src/app/api/integrations/[id]/test/route'
import { sweepTestFixtures } from './helpers/fixture-sweep'

/**
 * Task 60 — admin integracije (audit §7 Integracije PARTIAL→DONE):
 *  - POST kreiranje + audit INTEGRATION_CREATED + maskni sentinel ('••••') se izpusti
 *  - GET maskiranje skrivnosti za non-central (waiter vidi '••••' + maskedFields,
 *    lastSyncError pa prazen; owner vidi prave vrednosti)
 *  - PATCH dopolnilni config: maskna vrednost NE prepiše prave skrivnosti + audit
 *  - test povezave: SSRF varovalo (private host → 400), nedosegljiv javni gostitelj
 *    (.invalid, RFC 2606 — deterministično brez omrežja) → disconnected + IntegrationLog
 *  - DELETE = MEHKO brisanje (isActive false + disconnected + audit) + idempotenca
 *  - dovoljenje settings.manage (waiter → 403)
 * Fiksature z predpono `integ60-`, pre-sweep počisti ostanke crashanih tekov (Task 58).
 */

const PREFIX = 'integ60-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locA = ''

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
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `I60A-${RUN.toUpperCase()}` },
  })
  locA = loc.id
  const owner = await seedEmployee('owner', 'owner', pinOf(1), locA)
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(2), locA)
  // žetoni nosijo UI vloge (produkcija: roleToUI → 'OWNER'/'WAITER'); DB vrstice ostanejo lowercase enum
  return {
    owner: tokenFor(owner.id, owner.name, 'OWNER', locA),
    waiter: tokenFor(waiter.id, waiter.name, 'WAITER', locA),
  }
}

const setupP = setup()

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.integrationLog.deleteMany({ where: { integrationId: { startsWith: PREFIX } } }).catch(() => null)
  await db.integration.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
})

const isErr = async (p: Promise<Response>, status: number) => {
  const r = await p
  expect(r.status).toBe(status)
  return (await r.json()) as { error?: string }
}

describe('Task 60 — admin integracije (API za povezovanje)', () => {
  test('POST ustvari povezavo + audit INTEGRATION_CREATED; maskni sentinel se izpusti', async () => {
    const { owner } = await setupP
    const r = await integrationsPOST(req('/api/integrations', owner, 'POST', {
      name: `${PREFIX}Glovo`, type: 'delivery', provider: 'glovo',
      baseUrl: 'https://api.glovoapp.com', config: { apiKey_prod: '••••', region: 'eu' },
      locationId: locA,
    }))
    expect(r.status).toBe(201)
    const d = ((await r.json()) as { integration: { id: string; config: Record<string, unknown>; locationId: string | null } }).integration
    const cfg = d.config // #23: odgovor = varni DTO, config je objekt (ne JSON niz)
    expect(cfg.region).toBe('eu')
    expect('apiKey_prod' in cfg).toBe(false) // maska se NIKOLI ne shrani
    expect(d.locationId).toBe(locA)
    const audit = await db.auditLog.count({ where: { action: 'INTEGRATION_CREATED', entityId: d.id } })
    expect(audit).toBe(1)
  })

  test('POST validacija: brez imena → 400; napačen baseUrl → 400', async () => {
    const { owner } = await setupP
    await isErr(integrationsPOST(req('/api/integrations', owner, 'POST', { name: '  ' })), 400)
    await isErr(integrationsPOST(req('/api/integrations', owner, 'POST', { name: 'x', baseUrl: 'ftp://y' })), 400)
  })

  test('GET (issue #5+#23): waiter (brez settings.manage) → 403; owner vidi MASKIRANE vrednosti', async () => {
    const { owner, waiter } = await setupP
    const created = await integrationsPOST(req('/api/integrations', owner, 'POST', {
      name: `${PREFIX}Bizi`, type: 'delivery', config: { apiKey_bizi: 'sk-secret-42', region: 'si' },
    }))
    const id = ((await created.json()) as { integration: { id: string } }).integration.id
    await db.integration.update({ where: { id }, data: { lastSyncError: 'stari napaki' } })

    // issue #5 (v1.88.0): GET zahteva settings.manage — waiter sploh NE pride do seznama
    // (prej requireAuth z maskiranjem; masker ostaja kot notranji obrambni sloj)
    const wRes = await integrationsGET(req('/api/integrations', waiter))
    expect(wRes.status).toBe(403)

    const o = ((await (await integrationsGET(req('/api/integrations', owner))).json()) as {
      integrations: Array<{ id: string; config: Record<string, unknown>; maskedFields?: string[]; lastSyncError: string }>
    }).integrations.find((x) => x.id === id)!
    expect(o.config.apiKey_bizi).toBe('••••') // #23 §3: tudi centralne vloge vidijo masko
    expect((o.maskedFields as string[] | undefined)).toEqual(['apiKey_bizi'])
    expect(o.lastSyncError).toBe('stari napaki') // lastSyncError ostaja za centralne (ni skrivnost)
  })

  test('PATCH config: maskna vrednost NE prepiše skrivnosti, ostalo se posodobi + audit', async () => {
    const { owner } = await setupP
    const created = await integrationsPOST(req('/api/integrations', owner, 'POST', {
      name: `${PREFIX}Wolt`, config: { apiKey_wolt: 'sk-real-77', city: 'lj' },
    }))
    const id = ((await created.json()) as { integration: { id: string } }).integration.id
    const r = await integrationPATCH(req(`/api/integrations/${id}`, owner, 'PATCH', {
      config: { apiKey_wolt: '••••', city: 'kp' }, syncInterval: 120,
    }), { params: Promise.resolve({ id }) })
    expect(r.status).toBe(200)
    const d = ((await r.json()) as { integration: { config: Record<string, unknown>; syncInterval: number } }).integration
    expect(d.config.apiKey_wolt).toBe('••••') // #23: odgovor = maska (nikoli surova vrednost)
    expect(d.config.city).toBe('kp')
    expect(d.syncInterval).toBe(120)
    const row = await db.integration.findUnique({ where: { id } })
    const dbCfg = JSON.parse(String(row?.config ?? '{}')) as Record<string, unknown>
    expect(dbCfg.apiKey_wolt).toBe('sk-real-77') // ohranjeno v DB — maska ni prepišala
    const audit = await db.auditLog.count({ where: { action: 'INTEGRATION_UPDATED', entityId: id } })
    expect(audit).toBe(1)
    await isErr(integrationPATCH(req(`/api/integrations/${id}`, owner, 'PATCH', { syncInterval: 10 }), { params: Promise.resolve({ id }) }), 400)
  })

  test('test povezave: zasebni gostitelj → 400 (SSRF varovalo, brez fetcha)', async () => {
    const { owner } = await setupP
    const created = await integrationsPOST(req('/api/integrations', owner, 'POST', {
      name: `${PREFIX}Notranji`, baseUrl: 'http://127.0.0.1:3000',
    }))
    const id = ((await created.json()) as { integration: { id: string } }).integration.id
    const e = await isErr(testConnectionPOST(req(`/api/integrations/${id}/test`, owner, 'POST'), { params: Promise.resolve({ id }) }), 400)
    expect(e.error).toContain('zasebnih')
  })

  test('test povezave: nedosegljiv javni gostitelj → disconnected + IntegrationLog + audit', async () => {
    const { owner } = await setupP
    const created = await integrationsPOST(req('/api/integrations', owner, 'POST', {
      name: `${PREFIX}Mrtvi`, baseUrl: 'https://integ60-definitivno-ne-obstaja.invalid',
    }))
    const id = ((await created.json()) as { integration: { id: string } }).integration.id
    const r = await testConnectionPOST(req(`/api/integrations/${id}/test`, owner, 'POST'), { params: Promise.resolve({ id }) })
    expect(r.status).toBe(200)
    const d = (await r.json()) as { connectionStatus: string; reachable: boolean }
    expect(d.reachable).toBe(false)
    expect(d.connectionStatus).toBe('disconnected')
    const row = await db.integration.findUnique({ where: { id } })
    expect(row?.connectionStatus).toBe('disconnected')
    expect(row?.lastSyncStatus).toBe('failed')
    const log = await db.integrationLog.count({ where: { integrationId: id, action: 'test_connection', status: 'failed' } })
    expect(log).toBe(1)
    const audit = await db.auditLog.count({ where: { action: 'INTEGRATION_TESTED', entityId: id } })
    expect(audit).toBe(1)
  })

  test('test povezave: neznani id → 404', async () => {
    const { owner } = await setupP
    await isErr(testConnectionPOST(req(`/api/integrations/${PREFIX}ne-obstaja-${RUN}`, owner, 'POST'), { params: Promise.resolve({ id: `${PREFIX}ne-obstaja-${RUN}` }) }), 404)
  })

  test('DELETE = mehko brisanje (isActive false + disconnected + audit) + idempotentno', async () => {
    const { owner } = await setupP
    const created = await integrationsPOST(req('/api/integrations', owner, 'POST', { name: `${PREFIX}Ubriši` }))
    const id = ((await created.json()) as { integration: { id: string } }).integration.id
    const r = await integrationDELETE(req(`/api/integrations/${id}`, owner, 'DELETE'), { params: Promise.resolve({ id }) })
    expect(r.status).toBe(200)
    const d = (await r.json()) as { disabled: boolean; integration: { isActive: boolean; connectionStatus: string } }
    expect(d.disabled).toBe(true)
    expect(d.integration.isActive).toBe(false)
    expect(d.integration.connectionStatus).toBe('disconnected')
    // še vedno na seznamu (mehko)
    const list = ((await (await integrationsGET(req('/api/integrations', owner))).json()) as { integrations: Array<{ id: string }> }).integrations
    expect(list.some((x) => x.id === id)).toBe(true)
    const audit = await db.auditLog.count({ where: { action: 'INTEGRATION_DISABLED', entityId: id } })
    expect(audit).toBe(1)
    const again = await integrationDELETE(req(`/api/integrations/${id}`, owner, 'DELETE'), { params: Promise.resolve({ id }) })
    expect(again.status).toBe(200)
  })

  test('PATCH/DELETE/test na neznani id → 404', async () => {
    const { owner } = await setupP
    const missing = `${PREFIX}manjka-${RUN}`
    await isErr(integrationPATCH(req(`/api/integrations/${missing}`, owner, 'PATCH', { name: 'x' }), { params: Promise.resolve({ id: missing }) }), 404)
    await isErr(integrationDELETE(req(`/api/integrations/${missing}`, owner, 'DELETE'), { params: Promise.resolve({ id: missing }) }), 404)
  })

  test('waiter (brez settings.manage) → 403 na vse pisalne akcije', async () => {
    const { waiter } = await setupP
    await isErr(integrationsPOST(req('/api/integrations', waiter, 'POST', { name: 'x' })), 403)
    await isErr(integrationPATCH(req(`/api/integrations/${PREFIX}karkoli-${RUN}`, waiter, 'PATCH', { isActive: true }), { params: Promise.resolve({ id: `${PREFIX}karkoli-${RUN}` }) }), 403)
    await isErr(integrationDELETE(req(`/api/integrations/${PREFIX}karkoli-${RUN}`, waiter, 'DELETE'), { params: Promise.resolve({ id: `${PREFIX}karkoli-${RUN}` }) }), 403)
  })
})
