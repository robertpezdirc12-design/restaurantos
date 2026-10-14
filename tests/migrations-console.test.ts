import { describe, expect, test, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { SCHEMA_MIGRATIONS, schemaMigrationsStatus, setMigrationProbeOverride, clearMigrationProbeOverrides } from '../src/lib/schema-migrations'
import { GET as consoleGET, POST as consolePOST } from '../src/app/api/admin/migrations/route'
import { sweepTestFixtures } from './helpers/fixture-sweep'

/**
 * Task 65 — Migracijska konzola (v1.63.0):
 *  - register: 11 migracij (od OPS-4 v1.67.0 tudi cleaner-role), unikatni id-ji,
 *    vsak endpoint kaže na obstoječo rutо na disku
 *  - probe: dialekt-agnostične (dev SQLite = vse aplicirano po db push)
 *  - GET: waiter/manager 403 (samo centralne vloge); owner 200 z 10 vnosi, allApplied
 *  - POST: brez body = vse čakajoče (dev: nič); {id:'nope'} 400; {id} že apliciran → alreadyApplied
 *  - delegacija: {id:<vsak iz registra>} → 200 (mapa HANDLERS pokriva ves register)
 *  - PENDING simulacija (issue10 — DDL je SQLite-kompatibilen): DROP TABLE → probe
 *    false → POST aplicira preko delegirane rute → tabela spet obstaja + oba audita
 *    (SCHEMA_MIGRATION_ISSUE10 delegata + SCHEMA_MIGRATION_CONSOLE konzola)
 *  - vsebuje napake: probe override issue13 → delegirana PG DDL na SQLite failne →
 *    konzola vseeno 200, rezultat ok:false z detail, ostalo nedotaknjeno
 * Fiksature s predpono `mig65-` (TEST_PREFIXES).
 */

const PREFIX = 'mig65-'
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
  const la = await db.location.create({
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `M65A-${RUN.toUpperCase()}` },
  })
  locA = la.id
  const owner = await seedEmployee('owner', 'owner', pinOf(1), locA)
  const manager = await seedEmployee('manager', 'manager', pinOf(2), locA)
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(3), locA)
  return {
    owner: tokenFor(owner.id, owner.name, 'OWNER', locA),
    manager: tokenFor(manager.id, manager.name, 'MANAGER', locA),
    waiter: tokenFor(waiter.id, waiter.name, 'WAITER', locA),
  }
}

const setupP = setup()

interface MigResp {
  migrations: { id: string; descKey: string; endpoint: string; applied: boolean; error?: string }[]
  pending: number
  allApplied: boolean
}

afterAll(async () => {
  clearMigrationProbeOverrides()
  // revizija: konzola + delegirane rute (akcije so izključno admin/testne)
  await db.auditLog.deleteMany({
    where: { action: { in: ['SCHEMA_MIGRATION_CONSOLE', 'SCHEMA_MIGRATION_ISSUE10', 'SCHEMA_MIGRATION_ISSUE13'] } },
  }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
})

describe('register shematskih migracij', () => {
  test('15 migracij z unikatnimi id-ji in metapodatki (+paylink v1.85.1, +paylink-split v1.87.0, +paylink-session v1.98.0 #37, +issue38 v1.100.0)', () => {
    expect(SCHEMA_MIGRATIONS.length).toBe(15)
    const ids = SCHEMA_MIGRATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(15)
    for (const m of SCHEMA_MIGRATIONS) {
      expect(m.descKey.startsWith('mig.')).toBe(true)
      expect(m.endpoint.startsWith('/api/admin/migrate-')).toBe(true)
      expect(typeof m.probe).toBe('function')
    }
  })

  test('vsak endpoint kaže na obstoječo rutо na disku (integriteta, lekcija Task 64-b)', () => {
    for (const m of SCHEMA_MIGRATIONS) {
      // '/api/admin/migrate-x' → 'src/app/api/admin/migrate-x/route.ts'
      const p = join(import.meta.dir, '..', 'src', 'app', ...m.endpoint.slice(1).split('/'), 'route.ts')
      expect(existsSync(p)).toBe(true)
    }
  })

  test('status na dev SQLite: vse aplicirano (schema je pushana)', async () => {
    const status = await schemaMigrationsStatus()
    expect(status.length).toBe(15)
    expect(status.every((s) => s.applied)).toBe(true)
    expect(status.every((s) => s.error === undefined)).toBe(true)
  })
})

describe('migracijska konzola — avtorizacija', () => {
  test('GET: waiter 403, manager 403 (samo centralne vloge)', async () => {
    const { waiter, manager } = await setupP
    expect((await consoleGET(req('/api/admin/migrations', waiter))).status).toBe(403)
    expect((await consoleGET(req('/api/admin/migrations', manager))).status).toBe(403)
  })

  test('POST: waiter 403', async () => {
    const { waiter } = await setupP
    expect((await consolePOST(req('/api/admin/migrations', waiter, 'POST', {}))).status).toBe(403)
  })
})

describe('migracijska konzola — status in delegacija', () => {
  test('GET owner: 15 vnosov, vse aplicirano na dev, oblika vnosa', async () => {
    const { owner } = await setupP
    const r = await consoleGET(req('/api/admin/migrations', owner))
    expect(r.status).toBe(200)
    const j = (await r.json()) as MigResp
    expect(j.migrations.length).toBe(15)
    expect(j.allApplied).toBe(true)
    expect(j.pending).toBe(0)
    for (const m of j.migrations) {
      expect(m.applied).toBe(true)
      expect(m.descKey.startsWith('mig.')).toBe(true)
      expect(m.endpoint.startsWith('/api/admin/migrate-')).toBe(true)
    }
    // vrstni red registra je ohranjen
    expect(j.migrations.map((m) => m.id)).toEqual(SCHEMA_MIGRATIONS.map((m) => m.id))
  })

  test('POST brez body: nič čakajočega na dev → prazen applied + audit konzole', async () => {
    const { owner } = await setupP
    const r = await consolePOST(req('/api/admin/migrations', owner, 'POST'))
    expect(r.status).toBe(200)
    const j = (await r.json()) as { applied: unknown[]; pending: number; allApplied: boolean }
    expect(j.applied).toEqual([])
    expect(j.pending).toBe(0)
    expect(j.allApplied).toBe(true)
    const audit = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_CONSOLE', entityId: 'all_pending' }, orderBy: { timestamp: 'desc' } })
    expect(audit).not.toBeNull()
  })

  test('POST {id:neznano} → 400', async () => {
    const { owner } = await setupP
    const r = await consolePOST(req('/api/admin/migrations', owner, 'POST', { id: 'mig65-neznano' }))
    expect(r.status).toBe(400)
  })

  test('POST {id} že apliciran → alreadyApplied brez DDL', async () => {
    const { owner } = await setupP
    const r = await consolePOST(req('/api/admin/migrations', owner, 'POST', { id: 'haccp-plans' }))
    expect(r.status).toBe(200)
    const j = (await r.json()) as { alreadyApplied: boolean; applied: unknown[] }
    expect(j.alreadyApplied).toBe(true)
    expect(j.applied).toEqual([])
  })

  test('delegacijska mapa pokriva VES register (vsak {id} → 200)', async () => {
    const { owner } = await setupP
    for (const m of SCHEMA_MIGRATIONS) {
      const r = await consolePOST(req('/api/admin/migrations', owner, 'POST', { id: m.id }))
      expect(r.status).toBe(200)
      const j = (await r.json()) as { alreadyApplied?: boolean }
      // dev: vse aplicirano → vsak klic se konča z alreadyApplied (brez DDL izvedbe)
      expect(j.alreadyApplied).toBe(true)
    }
  })
})

describe('migracijska konzola — pending simulacija (issue10, SQLite-kompatibilen DDL)', () => {
  test('DROP TABLE → probe false → POST aplicira preko delegirane rute → tabela spet obstaja', async () => {
    const { owner } = await setupP

    // 1) simuliraj DDL pending: spusti PrintJob (realna tabelarična migracija issue10)
    //    tolerantno na sveže crashan prejšnji tek (tabela že manjka → nič)
    await db.$executeRawUnsafe('DROP TABLE "PrintJob"').catch((e) => {
      if (!String((e as Error).message).includes('no such table')) throw e
    })
    let status = await schemaMigrationsStatus()
    const issue10 = status.find((s) => s.id === 'issue10')
    expect(issue10?.applied).toBe(false)

    // 2) GET pokaže pending števec
    const g = await consoleGET(req('/api/admin/migrations', owner))
    const gj = (await g.json()) as MigResp
    expect(gj.pending).toBe(1)
    expect(gj.allApplied).toBe(false)
    expect(gj.migrations.find((m) => m.id === 'issue10')?.applied).toBe(false)

    // 3) POST (vse čakajoče) → delegacija na migrate-issue10 → DDL se izvede
    const r = await consolePOST(req('/api/admin/migrations', owner, 'POST'))
    expect(r.status).toBe(200)
    const j = (await r.json()) as { applied: { id: string; ok: boolean; status: number }[]; allApplied: boolean }
    expect(j.applied.length).toBe(1)
    expect(j.applied[0].id).toBe('issue10')
    expect(j.applied[0].ok).toBe(true)
    expect(j.allApplied).toBe(true)

    // 4) tabela spet obstaja + status apliciran
    await db.$queryRawUnsafe('SELECT 1 FROM "PrintJob" LIMIT 1')
    status = await schemaMigrationsStatus()
    expect(status.find((s) => s.id === 'issue10')?.applied).toBe(true)

    // 5) oba audit zapisa: delegirana ruta + konzola
    const del = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_ISSUE10' }, orderBy: { timestamp: 'desc' } })
    expect(del).not.toBeNull()
    const con = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_CONSOLE' }, orderBy: { timestamp: 'desc' } })
    expect(con).not.toBeNull()
    const details = JSON.parse(con?.details ?? '{}') as { targets: string[]; results: { id: string; ok: boolean }[] }
    expect(details.targets).toEqual(['issue10'])
    expect(details.results[0].ok).toBe(true)
  })
})

describe('migracijska konzola — vsebovanje napak', () => {
  test('probe override pending → delegirana ruta failne (PG DDL na SQLite) → konzola 200 + ok:false + detail', async () => {
    const { owner } = await setupP
    setMigrationProbeOverride('issue13', false)
    try {
      const r = await consolePOST(req('/api/admin/migrations', owner, 'POST', { id: 'issue13' }))
      expect(r.status).toBe(200)
      const j = (await r.json()) as { applied: { id: string; ok: boolean; status: number; detail?: string }[]; allApplied: boolean }
      expect(j.applied.length).toBe(1)
      expect(j.applied[0].id).toBe('issue13')
      expect(j.applied[0].ok).toBe(false)
      expect(j.applied[0].status).toBe(500)
      expect(typeof j.applied[0].detail).toBe('string')
      expect(j.allApplied).toBe(false) // override še vedno vsiljuje pending
      // audit konzole vseeno zapisan (resnica o neuspehu je sledljiva)
      const con = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_CONSOLE', entityId: 'issue13' }, orderBy: { timestamp: 'desc' } })
      expect(con).not.toBeNull()
    } finally {
      clearMigrationProbeOverrides()
    }
    // po čistilni akciji override je izginil → dev spet vse aplicirano
    const status = await schemaMigrationsStatus()
    expect(status.every((s) => s.applied)).toBe(true)
  })
})
