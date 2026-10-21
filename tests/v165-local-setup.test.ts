/**
 * v1.165.0 — integracijski test prvega lokalnega zagona (PRD R1, A5/A7).
 *
 * Test zažene PRAVI setup CLI nad začasno podatkovno mapo in nato prebere
 * nastalo SQLite datoteko. Preverja, da:
 *  - se ustvari lastnik z hashiranim PIN-om (ne shranjen v čistini),
 *  - demo računi iz prisma/seed.ts ne nastanejo,
 *  - ponovni zagon ne podvoji lastnika in ne spremeni PIN-hasha,
 *  - se skrivnosti ne rotirajo,
 *  - se pred ponovnim pushom naredi varnostna kopija.
 *
 * `--no-generate` je namenjen: test ne sme regenerirati skupnega Prisma odjemalca
 * med drugimi testi. Setup zato zahteva, da je odjemalec že SQLite.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPin } from '../src/lib/auth'

const ROOT = process.cwd()
const SETUP = join(ROOT, 'scripts', 'local-setup.ts')
const OWNER_EMAIL = 'test-owner@example.test'
const OWNER_PIN = '654321'
const tmpDirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ros-v165-setup-'))
  tmpDirs.push(d)
  return d
}

function runSetup(dataDir: string, pin: string): { code: number; out: string; err: string; json: any } {
  const r = spawnSync(process.execPath, [SETUP, '--data-dir', dataDir, '--owner-email', OWNER_EMAIL, '--owner-pin', pin, '--json', '--no-generate'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, DATABASE_URL: '' },
  })
  const out = r.stdout || ''
  const err = r.stderr || ''
  let json: any = null
  try {
    json = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || 'null')
  } catch {
    json = null
  }
  return { code: r.status ?? -1, out, err, json }
}

function openDb(path: string): Database {
  return new Database(path, { readonly: true })
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe('v1.165.0 — prvi lokalni zagon', () => {
  it(
    'ustvari bazo, lokacijo, nastavitve in enega lastnika; ponovni zagon je idempoten',
    () => {
      const dir = tempDir()
      const first = runSetup(dir, OWNER_PIN)
      expect(first.err).not.toContain('--accept-data-loss')
      expect(first.code).toBe(0)
      expect(first.json?.ownerCreated).toBe(true)
      expect(first.json?.existingEmployees).toBe(0)
      expect(first.json?.secretsCreated).toBe(true)

      const dbPath = join(dir, 'data', 'restaurantos.db')
      expect(first.json?.dbPath).toBe(dbPath)
      expect(existsSync(dbPath)).toBe(true)
      expect(existsSync(join(dir, 'config.json'))).toBe(true)
      expect(existsSync(join(dir, 'PRVIC-ZAGON.txt'))).toBe(true)

      const db = openDb(dbPath)
      try {
        const employees = db.query('SELECT email, role, status, pin, pinLookup, locationId FROM Employee').all() as Array<Record<string, any>>
        expect(employees).toHaveLength(1)
        const owner = employees[0]
        expect(owner.email).toBe(OWNER_EMAIL)
        expect(owner.role).toBe('admin')
        expect(owner.status).toBe('active')
        expect(owner.locationId).toBeTruthy()
        expect(owner.pin).not.toBe(OWNER_PIN)
        expect(owner.pin).toBe(hashPin(OWNER_PIN, OWNER_EMAIL))
        expect(typeof owner.pinLookup).toBe('string')
        expect(owner.pinLookup.length).toBeGreaterThan(32)

        const demo = db.query("SELECT COUNT(*) AS n FROM Employee WHERE email IN ('admin@restaurantos.app','natakar@restaurantos.app','kuhinja@restaurantos.app','vodja@restaurantos.app')").get() as { n: number }
        expect(demo.n).toBe(0)

        expect((db.query('SELECT COUNT(*) AS n FROM Location').get() as { n: number }).n).toBe(1)
        expect((db.query('SELECT COUNT(*) AS n FROM RestaurantSettings').get() as { n: number }).n).toBe(1)
      } finally {
        db.close()
      }

      const credentials = readFileSync(join(dir, 'PRVIC-ZAGON.txt'), 'utf8')
      expect(credentials).toContain(OWNER_EMAIL)
      expect(credentials).toContain(OWNER_PIN)

      const secretsBefore = readFileSync(join(dir, 'config.json'), 'utf8')

      // Drugi zagon z DRUGIM PIN-om: ne sme ustvariti novega lastnika niti
      // spremeniti obstoječega PIN-hasha.
      const second = runSetup(dir, '111111')
      expect(second.code).toBe(0)
      expect(second.json?.ownerCreated).toBe(false)
      expect(second.json?.existingEmployees).toBe(1)
      expect(second.json?.secretsCreated).toBe(false)

      expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(secretsBefore)
      expect(readFileSync(join(dir, 'PRVIC-ZAGON.txt'), 'utf8')).toBe(credentials)

      const db2 = openDb(dbPath)
      try {
        const rows = db2.query('SELECT email, pin, pinLookup FROM Employee').all() as Array<Record<string, any>>
        expect(rows).toHaveLength(1)
        expect(rows[0].pin).toBe(hashPin(OWNER_PIN, OWNER_EMAIL))
        expect(rows[0].pin).not.toBe(hashPin('111111', OWNER_EMAIL))
      } finally {
        db2.close()
      }

      const backupDir = join(dir, 'backups')
      expect(existsSync(backupDir)).toBe(true)
      const backups = readdirSync(backupDir).filter((f) => /^pre-push-.*\.db$/.test(f))
      expect(backups.length).toBeGreaterThanOrEqual(1)
    },
    { timeout: 180000 },
  )
})
