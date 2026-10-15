import { describe, expect, test, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { SCHEMA_MIGRATIONS, schemaMigrationsStatus, setMigrationProbeOverride, clearMigrationProbeOverrides } from '../src/lib/schema-migrations'
import { POST as stroskiPOST } from '../src/app/api/admin/migrate-stroski-kategorije/route'
import { GET as consoleGET, POST as consolePOST } from '../src/app/api/admin/migrations/route'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * Task 66 — Stroški kategorije: DDL draft (v1.64.0).
 *
 * Zadnja preostala postavka audit §7 (vrstica 122). NOV STOLPEC na živeči tabeli
 * AccountsPayable — drugačen od HaccpPlan (nova tabela):
 *  - main schema.prisma polja ŠE NIMA (client na produkciji ne SELECT-a stolpca →
 *    aditivno-varno tudi PO uporabnikovem DDL kliku, dokler naslednja naloga ne
 *    doda polja v main schema);
 *  - dev zrcalo (schema.sqlite.prisma) polje IMA → db push → probe applied na dev;
 *  - DDL je dialekt-kompatibilen (ADD COLUMN NOT NULL DEFAULT '' — PG 11+ instant,
 *    SQLite podprto).
 *
 * LEKCIJA (testno okolje — raziskano do dna, vpliva na prihodnje DDL teste):
 *  (a) DROP COLUMN je tu NEPREDVIDLJIV — SQLite parsira SHRANJENO CREATE stavko
 *      iz sqlite_master, ki je lahko zastarela glede na runtime stanje (napaka
 *      "no such column" tudi nad konsistentno shemo; quoted + unquoted oblika);
 *  (b) Prisma SQLite engine si shemo cache-a in njegov raw-SELECT read-view je
 *      NEZMOŽEN spraviti v pending stanje v življenju procesa: zunanji pisatelj
 *      (bun:sqlite na isti datoteki) je mu neviden, rename+klon z istim imenom
 *      ne prebudi view-a, niti $disconnect; hkrati pa njegovo branje sqlite_master
 *      vrne REALNO stanje (krvava mešanica — glej worklog Task 66). Delegacijski
 *      stroj pending→apply je KONČNO dokazan z mig65 PrintJob testom (drop table
 *      → probe → POST → rekreirana + oba audita); za STOLPEC je tu namesto tega
 *      statično varovanje DDL vira + realno E2E preverjanje stanja v konzoli.
 *
 * Testi (predpona `sk66-` v TEST_PREFIXES):
 *  1. register vnos #10: id/descKey/endpoint + i18n ključ v SL in HR
 *  2. dev status: probe applied; direkt POST → alreadyApplied (pre-check resnica)
 *  3. avtorizacija: waiter/manager POST na migrate rutо → 403
 *  4. DDL vir integriteta (statično): ruta vsebuje točno pričakovano fiksno DDL
 *     + dev zrcalo res deklarira polje (sqlite_master = realno stanje)
 *  5. probe override (status pending, realno aplicirano): konzola delegira →
 *     alreadyApplied (ok:true), a allApplied ostane false (override je resnica
 *     o statusu, ne o DDL) → po clear spet vse aplicirano
 *  6. v1.86.1 raw-plast: pre-check P2010/42703 (Postgres — produkcija) in
 *     P2010/1 (SQLite) → DDL se IZVEDE (prej 500 "infra napaka" — to je bilo
 *     razlog, da uporabnikov klik "Uporabi" na produkciji ni uspel);
 *     ne-manjkajoča raw koda (42601) ostane 500 (brez maskiranja)
 */

const PREFIX = 'sk66-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

/** Pričakovana fiksna DDL (identična viru v ruti — statično varovanje). */
const EXPECTED_DDL = `ALTER TABLE "AccountsPayable" ADD COLUMN "category" TEXT NOT NULL DEFAULT ''`

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
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `S66A-${RUN.toUpperCase()}` },
  })
  const owner = await seedEmployee('owner', 'owner', pinOf(1), la.id)
  const manager = await seedEmployee('manager', 'manager', pinOf(2), la.id)
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(3), la.id)
  return {
    owner: tokenFor(owner.id, owner.name, 'OWNER', la.id),
    manager: tokenFor(manager.id, manager.name, 'MANAGER', la.id),
    waiter: tokenFor(waiter.id, waiter.name, 'WAITER', la.id),
  }
}

const setupP = setup()

/** REALNO stanje shranjene CREATE stavke (sqlite_master — ni odvisen od cache-a). */
async function storedCreateSqlNow(): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ sql: string }[]>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'AccountsPayable'",
  )
  if (!rows[0]?.sql) throw new Error('AccountsPayable ne obstaja v dev bazi')
  return rows[0].sql
}

/** Self-heal: osiroteli original iz crashane DDL kirurgije → restavriraj. */
async function restoreIfOrphan(): Promise<void> {
  const orphan = await db.$queryRawUnsafe<{ x: number }[]>(
    "SELECT 1 x FROM sqlite_master WHERE name = 'sk66_aporig'",
  )
  if (orphan.length === 0) return
  await db.$executeRawUnsafe('DROP TABLE IF EXISTS "AccountsPayable"') // klon
  await db.$executeRawUnsafe('ALTER TABLE "sk66_aporig" RENAME TO "AccountsPayable"') // original nazaj
}

/** Self-heal: stolpec manjka v REALNEM stanju → dodaj (DDL se vedno izvede). */
async function ensureCategoryColumn(): Promise<void> {
  const sql = await storedCreateSqlNow()
  if (sql.includes('"category"')) return
  await db.$executeRawUnsafe(EXPECTED_DDL)
}

afterAll(async () => {
  clearMigrationProbeOverrides()
  // self-healing: osiroteli original iz crashane DDL kirurgije → restavriraj
  await restoreIfOrphan().catch(() => null)
  // self-healing: kljub morebitnim napakam testov mora dev bazo zapustiti s stolpcem
  await ensureCategoryColumn().catch(() => null)
  // revizija: samo lastne akcije (CONSOLE omejen na entityId te migracije)
  await db.auditLog.deleteMany({ where: { action: 'SCHEMA_MIGRATION_STROSKI_KATEGORIJE' } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { action: 'SCHEMA_MIGRATION_CONSOLE', entityId: 'stroski-kategorije' } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
})

describe('stroski-kategorije: register + i18n', () => {
  test('register vnos #10 z metapodatki + i18n ključ v obeh jezikih', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'stroski-kategorije')
    expect(m).toBeDefined()
    expect(m?.descKey).toBe('mig.stroskiKategorije.desc')
    expect(m?.endpoint).toBe('/api/admin/migrate-stroski-kategorije')
    expect(typeof m?.probe).toBe('function')
    expect(SCHEMA_MIGRATIONS.length).toBe(17) // v1.104.0: +allergen-truth (#7) // v1.100.0: +issue38 (#38)
    // i18n: ključ obstaja v SL in HR (globalna pariteta → tests/i18n.test.ts)
    expect(typeof sl['mig.stroskiKategorije.desc']).toBe('string')
    expect(typeof hr['mig.stroskiKategorije.desc']).toBe('string')
    expect(sl['mig.stroskiKategorije.desc']).toContain('AccountsPayable')
    expect(hr['mig.stroskiKategorije.desc']).toContain('AccountsPayable')
  })

  test('dev status: probe applied (zrcalna shema + db push) in direkten POST → alreadyApplied', async () => {
    const { owner } = await setupP
    const status = await schemaMigrationsStatus()
    expect(status.find((s) => s.id === 'stroski-kategorije')?.applied).toBe(true)

    const r = await stroskiPOST(req('/api/admin/migrate-stroski-kategorije', owner, 'POST'))
    expect(r.status).toBe(200)
    const j = (await r.json()) as { alreadyApplied: boolean; applied: unknown[] }
    expect(j.alreadyApplied).toBe(true)
    expect(j.applied).toEqual([])
  })

  test('avtorizacija: waiter/manager POST → 403 (samo centralne vloge)', async () => {
    const { waiter, manager } = await setupP
    expect((await stroskiPOST(req('/api/admin/migrate-stroski-kategorije', waiter, 'POST'))).status).toBe(403)
    expect((await stroskiPOST(req('/api/admin/migrate-stroski-kategorije', manager, 'POST'))).status).toBe(403)
  })
})

describe('stroski-kategorije: raw-plast P2010 (v1.86.1 produkcijska lekcija)', () => {
  /** PrismaClientKnownRequestError podobnost (P2010 "Raw query failed"). */
  function p2010(dbCode: string, message: string): Error {
    return Object.assign(
      new Error(
        `Invalid \`prisma.$queryRawUnsafe()\` invocation:\n\nRaw query failed. Code: \`${dbCode}\`. Message: \`${message}\``,
      ),
      { code: 'P2010', meta: { code: dbCode, message } },
    )
  }

  type RawFn = (sql: string) => Promise<unknown>
  const holder = db as unknown as { $queryRawUnsafe: RawFn; $executeRawUnsafe: RawFn }
  const origQuery = holder.$queryRawUnsafe.bind(db)
  const origExec = holder.$executeRawUnsafe.bind(db)

  function restoreRaw(): void {
    holder.$queryRawUnsafe = origQuery
    holder.$executeRawUnsafe = origExec
  }

  test('pre-check P2010/42703 (Postgres — produkcija!) → DDL se IZVEDE (prej 500 "infra")', async () => {
    const { owner } = await setupP
    const ddlCalls: string[] = []
    holder.$queryRawUnsafe = async (sql: string) => {
      // preverba idempotence vidi "stolpec manjka" v RAW obliki (P2010 + PG koda)
      if (sql.includes('SELECT "category" FROM "AccountsPayable"')) {
        throw p2010('42703', 'column "category" does not exist')
      }
      return origQuery(sql) // post-check (count) ostane realen
    }
    holder.$executeRawUnsafe = async (sql: string) => {
      if (sql.includes('ADD COLUMN "category"')) {
        ddlCalls.push(sql) // simuliran Neon DDL uspeh (stolpec na dev že obstaja)
        return 1
      }
      return origExec(sql)
    }
    try {
      const r = await stroskiPOST(req('/api/admin/migrate-stroski-kategorije', owner, 'POST'))
      expect(r.status).toBe(200)
      const j = (await r.json()) as { alreadyApplied: boolean; applied: { ddl: string }[]; apCountAfter: number }
      expect(j.alreadyApplied).toBe(false)
      expect(j.applied.length).toBe(1)
      expect(j.applied[0].ddl).toContain('ADD COLUMN "category"')
      expect(ddlCalls.length).toBe(1)
      expect(typeof j.apCountAfter).toBe('number')
    } finally {
      restoreRaw()
    }
  })

  test('pre-check P2010/1 (SQLite "no such column") → DDL se izvede (dialekt-pariteta)', async () => {
    const { owner } = await setupP
    const ddlCalls: string[] = []
    holder.$queryRawUnsafe = async (sql: string) => {
      if (sql.includes('SELECT "category" FROM "AccountsPayable"')) {
        throw p2010('1', 'no such column: category')
      }
      return origQuery(sql)
    }
    holder.$executeRawUnsafe = async (sql: string) => {
      if (sql.includes('ADD COLUMN "category"')) {
        ddlCalls.push(sql)
        return 1
      }
      return origExec(sql)
    }
    try {
      const r = await stroskiPOST(req('/api/admin/migrate-stroski-kategorije', owner, 'POST'))
      expect(r.status).toBe(200)
      const j = (await r.json()) as { alreadyApplied: boolean; applied: unknown[] }
      expect(j.alreadyApplied).toBe(false)
      expect(j.applied.length).toBe(1)
      expect(ddlCalls.length).toBe(1)
    } finally {
      restoreRaw()
    }
  })

  test('pre-check P2010 z NE-manjkajočo kodo (42601 sintaksa) → 500 infra resnica (brez maskiranja)', async () => {
    const { owner } = await setupP
    holder.$queryRawUnsafe = async (sql: string) => {
      if (sql.includes('SELECT "category" FROM "AccountsPayable"')) {
        throw p2010('42601', 'syntax error at or near "FROM"')
      }
      return origQuery(sql)
    }
    try {
      const r = await stroskiPOST(req('/api/admin/migrate-stroski-kategorije', owner, 'POST'))
      expect(r.status).toBe(500)
      const j = (await r.json()) as { error?: string }
      expect(String(j.error)).toContain('Infrastrukturna napaka')
    } finally {
      restoreRaw()
    }
  })
})

describe('stroski-kategorije: DDL vir integriteta (statično)', () => {
  test('ruta vsebuje točno pričakovano fiksno DDL + dev shema res deklarira polje', async () => {
    // 1) statično: vir rute vsebuje točno pričakovano DDL (brez prostoformskega SQL)
    const src = readFileSync('src/app/api/admin/migrate-stroski-kategorije/route.ts', 'utf8')
    expect(src.includes(EXPECTED_DDL)).toBe(true)
    // ena sama DDL izjava (aditivna, dialekt-kompatibilna — brez DROP/DELETE)
    expect(src.match(/DROP\s+COLUMN|DELETE\s+FROM/i)).toBeNull()

    // 2) realno: dev baza (db push iz zrcalne sheme) res ima stolpec
    const sql = await storedCreateSqlNow()
    expect(sql.includes('"category"')).toBe(true)
    // indeksi + FK ostanejo nedotaknjeni (7 indeksov: pkey autoindex + 6)
    const idx = await db.$queryRawUnsafe<{ c: bigint }[]>(
      "SELECT count(*) AS c FROM sqlite_master WHERE type = 'index' AND tbl_name = 'AccountsPayable'",
    )
    expect(Number(idx[0].c)).toBe(7)
  })
})

describe('stroski-kategorije: konzola — status + delegacija + vsebovanje napak', () => {
  test('probe override (status pending, realno aplicirano): delegacija → alreadyApplied ok:true, allApplied ostane false', async () => {
    const { owner } = await setupP
    setMigrationProbeOverride('stroski-kategorije', false)
    try {
      // konzola GET pokaže vsiljen pending
      const g = await consoleGET(req('/api/admin/migrations', owner))
      const gj = (await g.json()) as { pending: number; allApplied: boolean; migrations: { id: string; applied: boolean }[] }
      expect(gj.migrations.find((m) => m.id === 'stroski-kategorije')?.applied).toBe(false)
      expect(gj.allApplied).toBe(false)

      // POST {id} → delegacija → ruta pre-check: realno aplicirano → alreadyApplied
      const r = await consolePOST(req('/api/admin/migrations', owner, 'POST', { id: 'stroski-kategorije' }))
      expect(r.status).toBe(200)
      const j = (await r.json()) as { applied: { id: string; ok: boolean }[]; allApplied: boolean }
      // konzola NI izvedla DDL (alreadyApplied); allApplied=false je izključno
      // posledica vsiljenega override-a (override je resnica o statusu, ne o DDL)
      expect(j.applied.length).toBe(1)
      expect(j.applied[0].id).toBe('stroski-kategorije')
      expect(j.applied[0].ok).toBe(true)
      expect(j.allApplied).toBe(false)
      const con = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_CONSOLE', entityId: 'stroski-kategorije' }, orderBy: { timestamp: 'desc' } })
      expect(con).not.toBeNull()
    } finally {
      clearMigrationProbeOverrides()
    }
    const status = await schemaMigrationsStatus()
    expect(status.every((s) => s.applied)).toBe(true)
  })
})
