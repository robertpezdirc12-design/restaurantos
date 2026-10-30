/**
 * OSS-1 (v1.200.0) — VZDRŽEVANJE OPREME
 * (docs/GAP-ANALIZA-odprtokodna-konkurenca.md — kandidat OSS-1, izvor OrderRestro #16).
 *
 * Merila:
 *  Č1 čisti sloj equipment.ts (PURE, 0 DB): parseEquipmentInput (naziv 1–80
 *     obvezen; vrsta ≤ 40; serijska ≤ 80; datum namestitve; status iz znane
 *     množice active/broken/retired; opombe ≤ 500; interval celo število
 *     1–3650 z privzetkom 90; naziv servisa ≤ 120, privzetek 'Servis'),
 *     parseEquipmentPatch (vsa polja neobvezna; pavza boolean), parseServiceInput
 *     (datum v PRIHODNOSTI je napaka — servis se ne napoveduje nazaj v čas),
 *     nextDueAtFor ((zadnji servis ?? nastanitev) + interval), dueStatus /
 *     dueInDays (izpeljane zastavice ob branju — deterministična UTC-dnevna
 *     aritmetika, brez cron stanja), equipmentDto (pure preslikava).
 *  Č2 backend:
 *     - 401 brez žetona (GET/POST/service);
 *     - 503 do DDL (probe false — eksplicitna, ne tiho; test hook);
 *     - POST ustvari opremo + servisni načrt v ENI transakciji (201) + audit
 *       EQUIPMENT_CREATE; duplikat naziva na lokaciji → 409; manjkajoč naziv → 400;
 *     - GET obseg: manager vidi izključno svojo lokacijo (fail-closed), admin
 *       centralno org obseg + seznam lokacij za izbiro;
 *     - PATCH (status + interval) preizračuna nextDueAt iz zadnjega servisa +
 *       audit EQUIPMENT_UPDATED; tuja lokacija → 403 (guardResource);
 *     - service POST (»servis opravljen«): lastServicedAt + nextDueAt =
 *       servicedAt + interval + audit EQUIPMENT_SERVICE_LOGGED; datum v
 *       prihodnosti → 400; oprema brez načrta → 409; 404 neznani id;
 *     - DELETE v transakciji počisti načrte + audit EQUIPMENT_DELETED.
 *  Č3 DDL ruta /api/admin/migrate-equipment-maintenance: 403 za managerja
 *     (requireCentralRole), 200 za admina (na SQLite tabela že prek db push →
 *     skipped; audit SCHEMA_MIGRATION_EQUIPMENT_MAINTENANCE).
 *  Č4 UI statika + registri: kartica equipment-card (klici + t() ključi),
 *     i18n pariteta novih ključev (SL/HR), modela v OBEH shemah, baseline
 *     migracija, SCHEMA_MIGRATIONS 34 + register, drift allowlist 26
 *     (classifyDrift prepozna CREATE TABLE "Equipment"), verzija pin.
 *
 * Fiksture s predpono v200eq-; tekočo ustvarjene/izbrisane — po teku testa sta
 * tabeli Equipment/EquipmentMaintenancePlan v vhodnem stanju.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import {
  DUE_SOON_DAYS,
  DEFAULT_EQUIPMENT_INTERVAL_DAYS,
  dueInDays,
  dueStatus,
  equipmentDto,
  nextDueAtFor,
  parseEquipmentInput,
  parseEquipmentPatch,
  parseServiceInput,
} from '../src/lib/equipment'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import {
  __setEquipmentTableReadyForTests,
  __resetEquipmentTableReadyForTests,
} from '../src/lib/equipment-store'
import { classifyDrift, KNOWN_DRIFTS } from '../scripts/drift-check'
import { GET as equipmentGET, POST as equipmentPOST } from '../src/app/api/equipment/route'
import { PATCH as equipmentPATCH, DELETE as equipmentDELETE } from '../src/app/api/equipment/[id]/route'
import { POST as servicePOST } from '../src/app/api/equipment/[id]/service/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-equipment-maintenance/route'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v200eq-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TZ = 'Europe/Ljubljana'

let locA = ''
let locB = ''
let mgr = ''
let waiter = ''
let admin = ''
let chef = ''
let tok = ''
let waiterToken = ''
let adminToken = ''
let chefToken = ''

function req(method: string, url: string, token: string | null, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function cleanup() {
  await db.equipmentMaintenancePlan
    .deleteMany({
      where: { OR: [{ equipmentId: { startsWith: P } }, { id: { startsWith: P } }, { updatedById: { startsWith: P } }] },
    })
    .catch(() => null)
  await db.equipment
    .deleteMany({
      where: { OR: [{ locationId: { startsWith: P } }, { id: { startsWith: P } }, { createdById: { startsWith: P } }] },
    })
    .catch(() => null)
  await db.auditLog
    .deleteMany({
      where: {
        OR: [
          { locationId: { startsWith: P } },
          { entityId: { startsWith: P } },
          {
            action: {
              in: [
                'EQUIPMENT_CREATE',
                'EQUIPMENT_UPDATED',
                'EQUIPMENT_DELETED',
                'EQUIPMENT_SERVICE_LOGGED',
                'SCHEMA_MIGRATION_EQUIPMENT_MAINTENANCE',
              ],
            },
          },
        ],
      },
    })
    .catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  __setEquipmentTableReadyForTests(true) // tabela je prek db push prisotna v dev/CI bazi
  await cleanup()

  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `W20A-${RUN.toUpperCase()}`, timezone: TZ, country: 'SI' },
  })
  locA = la.id
  const lb = await db.location.create({
    data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `W20B-${RUN.toUpperCase()}`, timezone: TZ, country: 'SI' },
  })
  locB = lb.id

  const seed = async (key: string, name: string, role: string, seq: number): Promise<string> => {
    const id = `${P}${key}-${RUN}`
    const f = employeePinFields(`${PIN_BASE}${seq}`, `${id}@test.local`)
    await db.employee.create({
      data: { id, name, email: `${id}@test.local`, role, status: 'active', sessionVersion: 0, locationId: locA, pin: f.pin, pinLookup: f.pinLookup },
    })
    return id
  }
  mgr = await seed('mgr', `${P}Vodja Vida`, 'manager', 1)
  waiter = await seed('waiter', `${P}Natakar Nace`, 'waiter', 2)
  admin = await seed('admin', `${P}Admin Alja`, 'admin', 3)
  chef = await seed('chef', `${P}Kuhar Klemen`, 'chef', 4)
  // Issue #72 C1: settings.manage je central grant — manager ga NIMA v privzetkih.
  // Za test lokacijskih varovalk (staff s pravico piše SAMO na svoji lokaciji)
  // vodji pravico eksplicitno dodelimo prek permissionOverrides (vzorec issue23).
  await db.employee.update({ where: { id: mgr }, data: { permissionOverrides: JSON.stringify(['settings.manage']) } })
  tok = createToken({ sub: mgr, name: `${P}Vodja Vida`, role: 'MANAGER', loc: locA, sv: 0 })
  waiterToken = createToken({ sub: waiter, name: `${P}Natakar Nace`, role: 'WAITER', loc: locA, sv: 0 })
  adminToken = createToken({ sub: admin, name: `${P}Admin Alja`, role: 'ADMIN', loc: locA, sv: 0 })
  chefToken = createToken({ sub: chef, name: `${P}Kuhar Klemen`, role: 'KITCHEN', loc: locA, sv: 0 })
})

afterAll(async () => {
  __resetEquipmentTableReadyForTests() // probe nazaj na dev resnico (ponovna preiskava)
  await cleanup()
})

/* ═══════════════════ Č1. ČISTI SLOJ (equipment.ts) ═══════════════════ */

describe('Č1 čisti sloj opreme (pure)', () => {
  const NOW = new Date('2026-03-20T10:00:00Z')
  const DAY = 86_400_000

  it('nextDueAtFor: zadnji servis + interval (deterministično)', () => {
    const last = new Date('2026-01-01T00:00:00Z')
    expect(nextDueAtFor(90, last, new Date('2026-02-01T00:00:00Z')).getTime()).toBe(
      new Date('2026-04-01T00:00:00Z').getTime(),
    )
  })

  it('nextDueAtFor: brez zadnjega servisa pada na nastanitev (fallback)', () => {
    const created = new Date('2026-03-01T00:00:00Z')
    expect(nextDueAtFor(30, null, created).getTime()).toBe(new Date('2026-03-31T00:00:00Z').getTime())
  })

  it('dueStatus: overdue / dueSoon (≤ 7 dni) / ok / pavza / brez načrta', () => {
    const due = (d: string, active = true) => ({ intervalDays: 90, lastServicedAt: null, nextDueAt: new Date(d), active })
    expect(dueStatus({ ...due('2026-03-19T23:59:59Z') }, NOW)).toBe('overdue')
    expect(dueStatus({ ...due('2026-03-20T00:00:00Z') }, NOW)).toBe('dueSoon')
    expect(dueStatus({ ...due(`2026-03-20T00:00:00Z`, false) }, NOW)).toBe('paused')
    // roba: točno 7 dni od starta današnjega dne (UTC) — še kmalu zapade
    const edge = new Date(NOW.getTime() - NOW.getTime() % DAY + DUE_SOON_DAYS * DAY)
    expect(dueStatus({ intervalDays: 90, lastServicedAt: null, nextDueAt: edge, active: true }, NOW)).toBe('dueSoon')
    const past = new Date(NOW.getTime() + (DUE_SOON_DAYS + 1) * DAY)
    expect(dueStatus({ intervalDays: 90, lastServicedAt: null, nextDueAt: past, active: true }, NOW)).toBe('ok')
    expect(dueStatus(null, NOW)).toBe('paused')
    expect(dueStatus({ intervalDays: 90, lastServicedAt: null, nextDueAt: null, active: true }, NOW)).toBe('ok')
  })

  it('dueInDays: 7 dni do roka; brez načrta/pavza → null', () => {
    expect(dueInDays({ intervalDays: 90, lastServicedAt: null, nextDueAt: new Date('2026-03-27T00:00:00Z'), active: true }, NOW)).toBe(7)
    expect(dueInDays({ intervalDays: 90, lastServicedAt: null, nextDueAt: new Date('2026-03-19T00:00:00Z'), active: true }, NOW)).toBe(-1)
    expect(dueInDays(null, NOW)).toBeNull()
    expect(dueInDays({ intervalDays: 90, lastServicedAt: null, nextDueAt: new Date('2026-03-27T00:00:00Z'), active: false }, NOW)).toBeNull()
  })

  it('parseEquipmentInput: srečen tok + privzetki (vrsta other, interval 90, servis Servis, status active)', () => {
    const r = parseEquipmentInput({ name: '  Hladilnik 1  ', kind: ' hladilnik ', serialNumber: 'SN-1', intervalDays: '30', planTitle: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      name: 'Hladilnik 1', kind: 'hladilnik', serialNumber: 'SN-1', installedAt: null,
      status: 'active', notes: null, intervalDays: 30, planTitle: 'Servis',
    })
    const d = parseEquipmentInput({ name: 'Pečica', installedAt: '2026-01-15' })
    expect(d.ok && d.value.installedAt?.getTime()).toBe(new Date('2026-01-15T00:00:00Z').getTime())
    expect(DEFAULT_EQUIPMENT_INTERVAL_DAYS).toBe(90)
  })

  it('parseEquipmentInput: napake (brez naziva, dolg naziv, status, interval, datum, opombe, vrsta, serijska, naslov)', () => {
    expect(parseEquipmentInput({}).ok).toBe(false)
    expect(parseEquipmentInput({ name: '' }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'x'.repeat(81) }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', status: 'uporabljeno' }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', intervalDays: 0 }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', intervalDays: 3651 }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', intervalDays: 10.5 }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', installedAt: 'ni-datum' }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', notes: 'x'.repeat(501) }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', kind: 'x'.repeat(41) }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', serialNumber: 'x'.repeat(81) }).ok).toBe(false)
    expect(parseEquipmentInput({ name: 'A', planTitle: 'x'.repeat(121) }).ok).toBe(false)
    expect(parseEquipmentInput(null).ok).toBe(false)
  })

  it('parseEquipmentPatch: delni vnos, prazen → 0 sprememb, pavza boolean strogo', () => {
    const r = parseEquipmentPatch({ status: 'broken', intervalDays: 10, planActive: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.status).toBe('broken')
      expect(r.value.intervalDays).toBe(10)
      expect(r.value.planActive).toBe(true)
    }
    const empty = parseEquipmentPatch({})
    expect(empty.ok).toBe(true)
    expect(parseEquipmentPatch({ planActive: 'da' }).ok).toBe(false)
    expect(parseEquipmentPatch({ intervalDays: 0 }).ok).toBe(false)
    expect(parseEquipmentPatch({ status: 'x' }).ok).toBe(false)
  })

  it('parseServiceInput: privzetek zdaj, izrecen datum, prihodnost → napaka', () => {
    const okR = parseServiceInput({}, NOW)
    expect(okR.ok && okR.value.servicedAt.getTime()).toBe(NOW.getTime())
    const explicit = parseServiceInput({ servicedAt: '2026-03-10T08:00:00Z', note: 'zamenjan filter' }, NOW)
    expect(explicit.ok).toBe(true)
    if (explicit.ok) {
      expect(explicit.value.servicedAt.getTime()).toBe(new Date('2026-03-10T08:00:00Z').getTime())
      expect(explicit.value.note).toBe('zamenjan filter')
    }
    expect(parseServiceInput({ servicedAt: '2026-03-21T10:00:00Z' }, NOW).ok).toBe(false)
    expect(parseServiceInput({ servicedAt: 'ni-datum' }, NOW).ok).toBe(false)
    expect(parseServiceInput({ note: 'x'.repeat(501) }, NOW).ok).toBe(false)
  })

  it('equipmentDto: pure preslikava z izpeljanim due statusom', () => {
    const eq = {
      id: 'eq1', locationId: 'loc', name: 'Klima', kind: 'klima', serialNumber: null,
      installedAt: new Date('2026-01-10T00:00:00Z'), status: 'active', notes: null,
    }
    const plan = { id: 'p1', title: 'Servis', intervalDays: 30, lastServicedAt: null, nextDueAt: new Date('2026-03-10T00:00:00Z'), active: true }
    const dto = equipmentDto(eq, plan, NOW)
    expect(dto.plan?.due).toBe('overdue')
    expect(dto.installedAt).toBe('2026-01-10T00:00:00.000Z')
    expect(equipmentDto(eq, null, NOW).plan).toBeNull()
  })
})

/* ═══════════════════ Č2. BACKEND ═══════════════════ */

describe('Č2 backend opreme', () => {
  let eqA = ''
  let eqB = ''

  it('401 brez žetona (GET, POST, service)', async () => {
    expect((await equipmentGET(req('GET', '/api/equipment', null))).status).toBe(401)
    expect((await equipmentPOST(req('POST', '/api/equipment', null, { name: 'X' }))).status).toBe(401)
    expect((await servicePOST(req('POST', '/api/equipment/x/service', null, {}), params('x'))).status).toBe(401)
  })

  it('503 do DDL (probe false — eksplicitno, vsaka ruta)', async () => {
    __setEquipmentTableReadyForTests(false)
    try {
      expect((await equipmentGET(req('GET', '/api/equipment', tok))).status).toBe(503)
      expect((await equipmentPOST(req('POST', '/api/equipment', tok, { name: 'X' }))).status).toBe(503)
      expect((await equipmentPATCH(req('PATCH', '/api/equipment/x', tok, { status: 'broken' }), params('x'))).status).toBe(503)
      expect((await equipmentDELETE(req('DELETE', '/api/equipment/x', tok), params('x'))).status).toBe(503)
      expect((await servicePOST(req('POST', '/api/equipment/x/service', tok, {}), params('x'))).status).toBe(503)
    } finally {
      __setEquipmentTableReadyForTests(true)
    }
  })

  it('POST ustvari opremo + načrt (201) + audit EQUIPMENT_CREATE', async () => {
    const r = await equipmentPOST(req('POST', '/api/equipment', tok, {
      name: `${P}Hladilnik A`, kind: 'hladilnik', serialNumber: 'SN-A-1', intervalDays: 30,
    }))
    expect(r.status).toBe(201)
    const j = await body(r)
    const eq = j.equipment as Record<string, unknown>
    eqA = String(eq.id)
    expect(eq.name).toBe(`${P}Hladilnik A`)
    expect(eq.status).toBe('active')
    const plan = eq.plan as Record<string, unknown>
    expect(plan.intervalDays).toBe(30)
    expect(plan.title).toBe('Servis')
    expect(plan.due).toBe('ok') // 30 dni > 7 — kmalu še ne
    const audit = await db.auditLog.findFirst({ where: { action: 'EQUIPMENT_CREATE', entityId: eqA } })
    expect(audit).not.toBeNull()
  })

  it('duplikat naziva na isti lokaciji → 409; manjkajoč naziv → 400', async () => {
    expect((await equipmentPOST(req('POST', '/api/equipment', tok, { name: `${P}Hladilnik A` }))).status).toBe(409)
    expect((await equipmentPOST(req('POST', '/api/equipment', tok, {}))).status).toBe(400)
  })

  it('403: waiter brez settings.manage ne ustvari; manager ne sme tuje lokacije (PATCH locB)', async () => {
    expect((await equipmentPOST(req('POST', '/api/equipment', waiterToken, { name: 'X' }))).status).toBe(403)
    const b = await db.equipment.create({
      data: {
        id: `${P}eqB-${RUN}`, locationId: locB, name: `${P}Pečica B`, kind: 'pečica',
        createdById: `${P}seed-${RUN}`,
      },
    })
    eqB = b.id
    await db.equipmentMaintenancePlan.create({
      data: { id: `${P}planB-${RUN}`, equipmentId: eqB, title: 'Servis', intervalDays: 90, nextDueAt: new Date('2026-06-01T00:00:00Z') },
    })
    const pr = await equipmentPATCH(req('PATCH', `/api/equipment/${eqB}`, tok, { status: 'broken' }), params(eqB))
    expect(pr.status).toBe(403)
  })

  it('GET obseg: manager izključno svoja lokacija; chef prek haccp.execute; admin centralno + lokacije', async () => {
    // chef ima haccp.execute (brez settings.manage) — OR-pot za branje servisnih rokov
    expect((await equipmentGET(req('GET', '/api/equipment', chefToken))).status).toBe(200)
    const jm = await body(await equipmentGET(req('GET', '/api/equipment', tok)))
    const rowsM = (jm.equipment as Record<string, unknown>[]).map((x) => String(x.id))
    expect(rowsM).toContain(eqA)
    expect(rowsM).not.toContain(eqB)
    const ja = await body(await equipmentGET(req('GET', '/api/equipment', adminToken)))
    const rowsA = (ja.equipment as Record<string, unknown>[]).map((x) => String(x.id))
    expect(rowsA).toContain(eqA)
    expect(rowsA).toContain(eqB)
    const locs = (ja.locations as { id: string }[]).map((l) => l.id)
    expect(locs).toContain(locA)
    expect(locs).toContain(locB)
  })

  it('PATCH status + interval preizračuna nextDueAt + audit EQUIPMENT_UPDATED', async () => {
    const before = await db.equipmentMaintenancePlan.findFirst({ where: { equipmentId: eqA } })
    const r = await equipmentPATCH(req('PATCH', `/api/equipment/${eqA}`, tok, { status: 'broken', intervalDays: 10 }), params(eqA))
    expect(r.status).toBe(200)
    const j = await body(r)
    const eq = j.equipment as Record<string, unknown>
    expect(eq.status).toBe('broken')
    const plan = eq.plan as Record<string, unknown>
    expect(plan.intervalDays).toBe(10)
    expect(String(plan.nextDueAt)).not.toBe(String(before?.nextDueAt?.toISOString()))
    const audit = await db.auditLog.findFirst({ where: { action: 'EQUIPMENT_UPDATED', entityId: eqA } })
    expect(audit).not.toBeNull()
  })

  it('service POST: lastServicedAt + nextDueAt = servicedAt + interval + audit EQUIPMENT_SERVICE_LOGGED', async () => {
    const r = await servicePOST(req('POST', `/api/equipment/${eqA}/service`, tok, { note: 'zamenjan filter' }), params(eqA))
    expect(r.status).toBe(200)
    const plan = await db.equipmentMaintenancePlan.findFirst({ where: { equipmentId: eqA } })
    expect(plan?.lastServicedAt).not.toBeNull()
    expect(plan?.nextDueAt?.getTime()).toBe(
      (plan?.lastServicedAt?.getTime() ?? 0) + (plan?.intervalDays ?? 0) * 86_400_000,
    )
    const audit = await db.auditLog.findFirst({ where: { action: 'EQUIPMENT_SERVICE_LOGGED', entityId: plan?.id } })
    expect(audit).not.toBeNull()
    const jr = await body(r)
    const dtoPlan = (jr.equipment as Record<string, unknown>).plan as Record<string, unknown>
    expect(dtoPlan.due).toBe('ok') // svež servis → rok v prihodnosti
  })

  it('service: 409 brez načrta, 400 datum v prihodnosti, 404 neznani id; PATCH/DELETE 404', async () => {
    const bare = await db.equipment.create({
      data: { id: `${P}eqNoplan-${RUN}`, locationId: locA, name: `${P}Brez načrta`, createdById: `${P}seed-${RUN}` },
    })
    expect((await servicePOST(req('POST', `/api/equipment/${bare.id}/service`, tok, {}), params(bare.id))).status).toBe(409)
    expect((await servicePOST(req('POST', `/api/equipment/${eqA}/service`, tok, { servicedAt: '2030-01-01T00:00:00Z' }), params(eqA))).status).toBe(400)
    expect((await servicePOST(req('POST', '/api/equipment/ni-kje/service', tok, {}), params('ni-kje'))).status).toBe(404)
    expect((await equipmentPATCH(req('PATCH', '/api/equipment/ni-kje', tok, { status: 'broken' }), params('ni-kje'))).status).toBe(404)
    expect((await equipmentDELETE(req('DELETE', '/api/equipment/ni-kje', tok), params('ni-kje'))).status).toBe(404)
    expect((await equipmentPATCH(req('PATCH', `/api/equipment/${eqA}`, tok, {}), params(eqA))).status).toBe(400)
  })

  it('DELETE pobriše opremo + načrte (transakcija) + audit EQUIPMENT_DELETED', async () => {
    const r = await equipmentDELETE(req('DELETE', `/api/equipment/${eqB}`, adminToken), params(eqB))
    expect(r.status).toBe(200)
    expect(await db.equipment.findUnique({ where: { id: eqB } })).toBeNull()
    expect(await db.equipmentMaintenancePlan.findFirst({ where: { equipmentId: eqB } })).toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'EQUIPMENT_DELETED', entityId: eqB } })
    expect(audit).not.toBeNull()
  })
})

/* ═══════════════════ Č3. DDL RUTA ═══════════════════ */

describe('Č3 DDL ruta migrate-equipment-maintenance', () => {
  it('403 za managerja (requireCentralRole)', async () => {
    expect((await migratePOST(req('POST', '/api/admin/migrate-equipment-maintenance', tok, {}))).status).toBe(403)
  })

  it('200 za admina — na SQLite tabela že prek db push → skipped + audit', async () => {
    const r = await migratePOST(req('POST', '/api/admin/migrate-equipment-maintenance', adminToken, {}))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.alreadyApplied).toBe(true)
    expect((j.skipped as string[]).sort()).toEqual(['Equipment', 'EquipmentMaintenancePlan'])
    const audit = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_EQUIPMENT_MAINTENANCE' } })
    expect(audit).not.toBeNull()
  })
})

/* ═══════════════════ Č4. UI STATIKA + REGISTRI + VERZIJA ═══════════════════ */

describe('Č4 registri, i18n in verzija', () => {
  it('SCHEMA_MIGRATIONS: 34. vnos equipment-maintenance (descKey/endpoint/probe)', () => {
    expect(SCHEMA_MIGRATIONS).toHaveLength(34) // v1.200.0: +equipment-maintenance (OSS-1)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'equipment-maintenance')
    expect(m).toBeDefined()
    expect(m?.descKey).toBe('mig.equipmentMaintenance.desc')
    expect(m?.endpoint).toBe('/api/admin/migrate-equipment-maintenance')
    expect(typeof m?.probe).toBe('function')
  })

  it('drift allowlist: 26 vnosov; CREATE TABLE Equipment/Plan je znan drift', () => {
    expect(KNOWN_DRIFTS).toHaveLength(26) // v1.200.0: +equipment-maintenance (OSS-1)
    const cls = classifyDrift(
      'CREATE TABLE "Equipment" ("id" TEXT NOT NULL, "locationId" TEXT NOT NULL, CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id"));\n' +
        'CREATE TABLE "EquipmentMaintenancePlan" ("id" TEXT NOT NULL, "equipmentId" TEXT NOT NULL, CONSTRAINT "EquipmentMaintenancePlan_pkey" PRIMARY KEY ("id"));\n' +
        'CREATE INDEX "Equipment_locationId_idx" ON "Equipment"("locationId");\n' +
        'CREATE INDEX "EquipmentMaintenancePlan_nextDueAt_idx" ON "EquipmentMaintenancePlan"("nextDueAt");',
    )
    expect(cls.unexpected).toEqual([])
    expect(cls.known.map((k) => k.id)).toEqual(['equipment-maintenance'])
    expect(classifyDrift('CREATE TABLE "Backdoor" ("id" TEXT NOT NULL);').unexpected).toHaveLength(1)
  })

  it('modela v OBEH shemah + baseline migracija nosi obe tabeli', () => {
    const prod = readFileSync('prisma/schema.prisma', 'utf8')
    const sqlite = readFileSync('prisma/schema.sqlite.prisma', 'utf8')
    const migration = readFileSync('prisma/migrations/00000000000000_init/migration.sql', 'utf8')
    for (const s of [prod, sqlite]) {
      expect(s).toContain('model Equipment {')
      expect(s).toContain('model EquipmentMaintenancePlan {')
    }
    expect(migration).toContain('CREATE TABLE "Equipment"')
    expect(migration).toContain('CREATE TABLE "EquipmentMaintenancePlan"')
    expect(migration).toContain('CREATE INDEX "EquipmentMaintenancePlan_nextDueAt_idx"')
  })

  it('i18n pariteta: eq.* (29 ključev) + mig.equipmentMaintenance.desc v SL in HR', () => {
    const slEq = Object.keys(sl).filter((k) => k.startsWith('eq.')).sort()
    const hrEq = Object.keys(hr).filter((k) => k.startsWith('eq.')).sort()
    expect(slEq.length).toBe(29)
    expect(hrEq).toEqual(slEq)
    for (const k of slEq) {
      expect(String(sl[k]).length).toBeGreaterThan(0)
      expect(String(hr[k]).length).toBeGreaterThan(0)
    }
    expect(sl['mig.equipmentMaintenance.desc']).toBeDefined()
    expect(hr['mig.equipmentMaintenance.desc']).toBeDefined()
  })

  it('UI statika: kartica + barrel + montaža v Nastavitve → Operacija', () => {
    const card = readFileSync('src/components/tabs/equipment-card.tsx', 'utf8')
    expect(card).toContain("t('eq.title')")
    expect(card).toContain("t('eq.serviceDone')")
    expect(card).toContain('/api/equipment')
    const barrel = readFileSync('src/components/dashboard-tabs.tsx', 'utf8')
    expect(barrel).toContain("export { EquipmentCard } from './tabs/equipment-card'")
    const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')
    expect(page).toContain('<EquipmentCard />')
  })

  it('verzija 1.200.0', () => {
    expect(APP_VERSION).toBe('1.200.0')
  })
})
