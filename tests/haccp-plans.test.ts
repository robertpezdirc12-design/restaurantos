import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as plansGET, POST as plansPOST } from '../src/app/api/haccp/plans/route'
import { PATCH as planPATCH, DELETE as planDELETE } from '../src/app/api/haccp/plans/[id]/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-haccp-plans/route'
import { resetHaccpPlansProbe } from '../src/lib/haccp-plans'
import { classifyDrift } from '../scripts/drift-check'
import { sweepTestFixtures } from './helpers/fixture-sweep'

/**
 * Task 64 — HACCP načrti kontrol (audit §7 vrstica 125 PARTIAL→DONE, v1.62.0):
 *  - GET: settings.manage (waiter → 403); prazen seznam; capability probe true na dev
 *  - POST: 201 + validacije (ime, kategorija, frekvenca, steps) + lokacijski/org gate
 *  - GET seznam: lokacijski scope — owner B NE vidi planov lokacije A
 *  - PATCH: urejanje + active stikalo + audit HACCP_PLAN_UPDATED (chain); cross-lokacija → 403
 *  - DELETE: 404 neznani, cross-lokacija → 403, lastnik → 200 + audit HACCP_PLAN_DELETED
 *  - capability OFF (migracijski vzorec issue-13): GET → ddlPending: true, pisanja → 503
 *  - admin migrate ruta: idempotentna (dev = alreadyApplied), waiter → 403
 *  - drift-check: HaccpPlan stavki → known bucket 'haccp-plans'; tuji stavek → unexpected
 * Fiksature z predpono `hcp64-` (TEST_PREFIXES + FIELD_SWEEP po name/target/responsible).
 */

const PREFIX = 'hcp64-'
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
  const la = await db.location.create({
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `H64A-${RUN.toUpperCase()}` },
  })
  const lb = await db.location.create({
    data: { id: `${PREFIX}loc-b-${RUN}`, name: `${PREFIX}Lokacija B`, code: `H64B-${RUN.toUpperCase()}` },
  })
  locA = la.id
  locB = lb.id
  const ownerA = await seedEmployee('owner-a', 'owner', pinOf(1), locA)
  const ownerB = await seedEmployee('owner-b', 'owner', pinOf(2), locB)
  const managerA = await seedEmployee('manager-a', 'manager', pinOf(3), locA)
  const managerB = await seedEmployee('manager-b', 'manager', pinOf(4), locB)
  const waiterA = await seedEmployee('waiter-a', 'waiter', pinOf(5), locA)
  return {
    ownerA: tokenFor(ownerA.id, ownerA.name, 'OWNER', locA),
    ownerB: tokenFor(ownerB.id, ownerB.name, 'OWNER', locB),
    managerA: tokenFor(managerA.id, managerA.name, 'MANAGER', locA),
    managerB: tokenFor(managerB.id, managerB.name, 'MANAGER', locB),
    waiterA: tokenFor(waiterA.id, waiterA.name, 'WAITER', locA),
  }
}

const setupP = setup()

interface PlanResp {
  id: string; name: string; category: string; frequency: string; target: string
  threshold: string; steps: string[]; responsible: string; active: boolean
  locationId: string | null
}

async function createPlan(token: string, overrides: Record<string, unknown> = {}): Promise<{ status: number; plan?: PlanResp; error?: string }> {
  const r = await plansPOST(req('/api/haccp/plans', token, 'POST', {
    name: `${PREFIX}Dnevna kontrola hladilnikov ${RUN}`,
    category: 'temperature',
    frequency: 'daily',
    target: 'Hladilna vitrina 1',
    threshold: '≤ 4 °C',
    responsible: 'vodja izmene',
    steps: ['Preveri temperaturo', 'Preveri tesnost vrat', 'Zapiši odčitek'],
    ...overrides,
  }))
  const j = (await r.json()) as { plan?: PlanResp; error?: string }
  return { status: r.status, plan: j.plan, error: j.error }
}

const isErr = async (p: Promise<Response>, status: number) => {
  const r = await p
  expect(r.status).toBe(status)
  return (await r.json()) as { error?: string }
}

afterAll(async () => {
  // FK vrstni red: revizija → dogodki → načrti → zaposleni → lokacije
  await db.auditLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { entityId: { startsWith: PREFIX } }] } }).catch(() => null)
  // nid() id — predpona živi v besedilnih poljih (FIELD_SWEEP vzorec, Task 61/62)
  await db.haccpPlan.deleteMany({
    where: { OR: [{ id: { startsWith: PREFIX } }, { name: { startsWith: PREFIX } }, { target: { startsWith: PREFIX } }, { responsible: { startsWith: PREFIX } }] },
  }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  // zagotovi čisto probe stanje za morebitne naslednje teke
  resetHaccpPlansProbe()
})

describe('Task 64 — HACCP načrti kontrol (API)', () => {
  test('GET: prazen seznam + ddlPending false na dev (tabela obstaja); waiter → 403', async () => {
    const { ownerA, waiterA } = await setupP
    const r = await plansGET(req('/api/haccp/plans', ownerA))
    expect(r.status).toBe(200)
    const j = (await r.json()) as { plans: PlanResp[]; ddlPending: boolean }
    expect(j.ddlPending).toBe(false)
    expect(Array.isArray(j.plans)).toBe(true)
    expect(j.plans.filter((p) => p.name.startsWith(PREFIX)).length).toBe(0)

    await isErr(plansGET(req('/api/haccp/plans', waiterA)), 403)
  })

  test('POST: 201 — polja echo, steps razčlenjeni, kategorija UPPER, audit chain zapisan', async () => {
    const { ownerA } = await setupP
    const { status, plan } = await createPlan(ownerA)
    expect(status).toBe(201)
    expect(plan).toBeDefined()
    expect(plan!.name).toContain(PREFIX)
    expect(plan!.category).toBe('TEMPERATURE')
    expect(plan!.frequency).toBe('daily')
    expect(plan!.steps).toEqual(['Preveri temperaturo', 'Preveri tesnost vrat', 'Zapiši odčitek'])
    expect(plan!.locationId).toBe(locA)
    expect(plan!.active).toBe(true)

    const row = await db.haccpPlan.findUnique({ where: { id: plan!.id } })
    expect(row).not.toBeNull()

    const audit = await db.auditLog.findFirst({ where: { action: 'HACCP_PLAN_CREATED', entityId: plan!.id } })
    expect(audit).not.toBeNull()
    expect(audit!.chainHash).not.toBe('')
  })

  test('POST: validacije — 400 (brez imena, neznana kategorija, neznana frekvenca, steps ne-seznam, > 20 korakov)', async () => {
    const { ownerA } = await setupP
    await isErr(plansPOST(req('/api/haccp/plans', ownerA, 'POST', { name: '  ', category: 'temperature' })), 400)
    await isErr(plansPOST(req('/api/haccp/plans', ownerA, 'POST', { name: 'X', category: 'neznana' })), 400)
    await isErr(plansPOST(req('/api/haccp/plans', ownerA, 'POST', { name: 'X', category: 'temperature', frequency: 'hourly' })), 400)
    await isErr(plansPOST(req('/api/haccp/plans', ownerA, 'POST', { name: 'X', category: 'temperature', steps: 'ni seznam' })), 400)
    await isErr(plansPOST(req('/api/haccp/plans', ownerA, 'POST', { name: 'X', category: 'temperature', steps: Array.from({ length: 21 }, (_, i) => `k${i}`) })), 400)
  })

  test('GET seznam: lokacijski scope — manager B NE vidi plana lokacije A (non-central = strogi scope)', async () => {
    const { managerA, managerB } = await setupP
    const ra = await plansGET(req('/api/haccp/plans', managerA))
    const ja = (await ra.json()) as { plans: PlanResp[] }
    expect(ja.plans.some((p) => p.name.startsWith(PREFIX))).toBe(true)

    const rb = await plansGET(req('/api/haccp/plans', managerB))
    const jb = (await rb.json()) as { plans: PlanResp[] }
    expect(jb.plans.some((p) => p.name.startsWith(PREFIX))).toBe(false)
  })

  test('PATCH: urejanje + active stikalo + audit; cross-lokacija (manager B) → 403; neznani → 404', async () => {
    const { ownerA, managerB } = await setupP
    const { plan } = await createPlan(ownerA, { name: `${PREFIX}Tedenska kontrola ${RUN}`, frequency: 'weekly' })
    expect(plan).toBeDefined()
    const id = plan!.id

    // urejanje imena + korakov
    const r = await planPATCH(req(`/api/haccp/plans/${id}`, ownerA, 'PATCH', {
      name: `${PREFIX}Tedenska kontrola (urejena) ${RUN}`,
      steps: ['Nov prvi korak'],
    }), { params: Promise.resolve({ id }) })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { plan: PlanResp }
    expect(j.plan.name).toContain('(urejena)')
    expect(j.plan.steps).toEqual(['Nov prvi korak'])
    expect(j.plan.frequency).toBe('weekly')

    // active stikalo
    const r2 = await planPATCH(req(`/api/haccp/plans/${id}`, ownerA, 'PATCH', { active: false }), { params: Promise.resolve({ id }) })
    expect(((await r2.json()) as { plan: PlanResp }).plan.active).toBe(false)

    const audit = await db.auditLog.findFirst({ where: { action: 'HACCP_PLAN_UPDATED', entityId: id } })
    expect(audit).not.toBeNull()

    // cross-lokacija: manager B ureja plan lokacije A → 403 (guardResource)
    await isErr(planPATCH(req(`/api/haccp/plans/${id}`, managerB, 'PATCH', { name: 'Tuj' }), { params: Promise.resolve({ id }) }), 403)
    // neznani id → 404
    await isErr(planPATCH(req('/api/haccp/plans/neznani-id', ownerA, 'PATCH', { name: 'X' }), { params: Promise.resolve({ id: 'neznani-id' }) }), 404)
    // brez sprememb → 400
    await isErr(planPATCH(req(`/api/haccp/plans/${id}`, ownerA, 'PATCH', {}), { params: Promise.resolve({ id }) }), 400)
  })

  test('DELETE: cross-lokacija (manager B) → 403; lastnik → 200 + vrstica izginjena + audit; neznani → 404', async () => {
    const { ownerA, managerB } = await setupP
    const a = await createPlan(ownerA, { name: `${PREFIX}Za brisanje ${RUN}` })
    const b = await createPlan(ownerA, { name: `${PREFIX}Za ostane ${RUN}` })
    expect(a.plan).toBeDefined()
    expect(b.plan).toBeDefined()

    await isErr(planDELETE(req(`/api/haccp/plans/${a.plan!.id}`, managerB, 'DELETE'), { params: Promise.resolve({ id: a.plan!.id }) }), 403)
    await isErr(planDELETE(req('/api/haccp/plans/neznani-id', ownerA, 'DELETE'), { params: Promise.resolve({ id: 'neznani-id' }) }), 404)

    const r = await planDELETE(req(`/api/haccp/plans/${a.plan!.id}`, ownerA, 'DELETE'), { params: Promise.resolve({ id: a.plan!.id }) })
    expect(r.status).toBe(200)
    expect(await db.haccpPlan.findUnique({ where: { id: a.plan!.id } })).toBeNull()

    const audit = await db.auditLog.findFirst({ where: { action: 'HACCP_PLAN_DELETED', entityId: a.plan!.id } })
    expect(audit).not.toBeNull()
  })

  test('Capability OFF (issue-13 vzorec): GET → ddlPending true; POST/PATCH/DELETE → 503', async () => {
    const { ownerA } = await setupP
    try {
      resetHaccpPlansProbe(false)

      const rg = await plansGET(req('/api/haccp/plans', ownerA))
      expect(rg.status).toBe(200)
      const jg = (await rg.json()) as { plans: PlanResp[]; ddlPending: boolean }
      expect(jg.ddlPending).toBe(true)
      expect(jg.plans.length).toBe(0)

      const e1 = await isErr(plansPOST(req('/api/haccp/plans', ownerA, 'POST', { name: 'X', category: 'temperature' })), 503)
      expect(e1.error).toContain('migrate-haccp-plans')
      await isErr(planPATCH(req('/api/haccp/plans/karkoli', ownerA, 'PATCH', { name: 'X' }), { params: Promise.resolve({ id: 'karkoli' }) }), 503)
      await isErr(planDELETE(req('/api/haccp/plans/karkoli', ownerA, 'DELETE'), { params: Promise.resolve({ id: 'karkoli' }) }), 503)
    } finally {
      resetHaccpPlansProbe() // vedno obnovi — naslednji klici ponovno probejajo (dev = true)
    }
    // po resetu je capability spet true (tabela obstaja na dev)
    const r = await plansGET(req('/api/haccp/plans', ownerA))
    expect(((await r.json()) as { ddlPending: boolean }).ddlPending).toBe(false)
  })

  test('Admin migrate ruta: idempotentna (dev tabela že obstaja → alreadyApplied); waiter → 403', async () => {
    const { ownerA, waiterA } = await setupP
    // waiter ni centralna vloga → 403 (N4)
    await isErr(migratePOST(req('/api/admin/migrate-haccp-plans', waiterA, 'POST')), 403)
    // owner (centralna) na dev — tabela že obstaja (db push) → alreadyApplied, brez DDL
    const r = await migratePOST(req('/api/admin/migrate-haccp-plans', ownerA, 'POST'))
    expect(r.status).toBe(200)
    const j = (await r.json()) as { alreadyApplied: boolean; applied: unknown[] }
    expect(j.alreadyApplied).toBe(true)
    expect(j.applied.length).toBe(0)
  })

  test('Statika + drift-check: DDL vsebuje CREATE TABLE "HaccpPlan"; HaccpPlan stavki → known bucket', () => {
    const src = readFileSync('src/app/api/admin/migrate-haccp-plans/route.ts', 'utf8')
    expect(src).toContain('CREATE TABLE "HaccpPlan"')
    expect(src).toContain('"HaccpPlan_locationId_fkey"')

    const driftSql = [
      'CREATE TABLE "HaccpPlan" ("id" TEXT NOT NULL, "name" TEXT NOT NULL);',
      'CREATE INDEX "HaccpPlan_locationId_idx" ON "HaccpPlan"("locationId");',
      'ALTER TABLE "HaccpPlan" ADD CONSTRAINT "HaccpPlan_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id");',
      'ALTER TABLE "NekajDrugega" ADD COLUMN "x" TEXT;',
    ].join('\n')
    const c = classifyDrift(driftSql)
    const known = c.known.find((k) => k.id === 'haccp-plans')
    expect(known).toBeDefined()
    expect(known!.statements.length).toBe(3)
    expect(c.unexpected).toEqual(['ALTER TABLE "NekajDrugega" ADD COLUMN "x" TEXT'])

    // tuji stavek z besedom "HaccpPlan" v ne-DDL kontekstu NE sme iti v known
    const c2 = classifyDrift('DELETE FROM "HaccpPlan";')
    expect(c2.known.find((k) => k.id === 'haccp-plans')).toBeUndefined()
    expect(c2.unexpected.length).toBe(1)
  })
})
