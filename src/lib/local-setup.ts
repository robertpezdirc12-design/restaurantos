/**
 * v1.165.0 — prvi lokalni zagon (PRD docs/PRD-LOKALNA-BAZA.md, F3–F5/F8/F9).
 * v1.169.0 — kopija pred pushom je preverjena, baza pa se pred vsakim zapisom
 * prestavi v WAL (R2, `local-durability.ts`).
 *
 * Naredi natanko toliko, da lokalna namestitev deluje brez Neon računa:
 *  1. podatkovna mapa + trajne skrivnosti (0600),
 *  2. SQLite odjemalec in shema iz zrcala (brez `--accept-data-loss`),
 *  3. preverjena varnostna kopija pred vsakim posegom v shemo,
 *  4. minimalna baza: ena lokacija, nastavitve in lastnik z naključnim PIN-om.
 *
 * Demo seed (prisma/seed.ts) se NIKOLI ne izvede: vsebuje javne PIN-e 1234/2345,
 * ki v lokalnem omrežju niso sprejemljivi. Break-glass okolje je izpraznjeno.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { employeePinFields } from './auth'
import { applyDurability, backupDatabase } from './local-durability'
import {
  LOCAL_SETUP_MARKER,
  databasePathFor,
  generatePin,
  localEnv,
  readOrCreateSecrets,
  resolveDataDir,
} from './local-runtime'

const ROOT = process.cwd()
const SQLITE_SCHEMA = path.join(ROOT, 'prisma', 'schema.sqlite.prisma')
const PRISMA_CLI = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js')
const CLIENT_SCHEMA = path.join(ROOT, 'node_modules', '.prisma', 'client', 'schema.prisma')

export const DEFAULT_OWNER_EMAIL = 'lastnik@restaurantos.local'
export const DEFAULT_RESTAURANT_NAME = 'Moja restavracija'

export interface LocalSetupOptions {
  dataDir?: string
  ownerEmail?: string
  ownerPin?: string
  restaurantName?: string
  allowGenerate?: boolean
}

export interface LocalSetupResult {
  dataDir: string
  dbPath: string
  ownerCreated: boolean
  ownerEmail: string
  existingEmployees: number
  secretsCreated: boolean
  backupCreated?: string
  /** Stanje replica po nastavitvi pragmov — lokalni profil mora biti `wal`. */
  journalMode: string
  /** Vrnjen samo, kadar je PIN generiran (nikoli ne odmevaj uporabnikovega). */
  pin?: string
}

function assertRepoRoot(): void {
  if (!existsSync(SQLITE_SCHEMA) || !existsSync(PRISMA_CLI)) {
    throw new Error('[local] Zaženite ukaz iz korena repozitorija RestaurantOS (manjka prisma shema ali Prisma CLI).')
  }
}

function generatedProvider(): string | null {
  if (!existsSync(CLIENT_SCHEMA)) return null
  const m = readFileSync(CLIENT_SCHEMA, 'utf8').match(/datasource\s+\w+\s*\{[\s\S]*?provider\s*=\s*"([^"]+)"/)
  return m?.[1] ?? null
}

function prismaCommand(args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(process.execPath, [PRISMA_CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  })
  if (r.status !== 0) {
    const detail = `${r.stderr || ''}\n${r.stdout || ''}`.trim().slice(-4000)
    throw new Error(
      `[local] Prisma (${args.slice(0, 2).join(' ')}) je prekinil ukaz. Baza ni bila namerno spremenjena.\n${detail}`,
    )
  }
}

function ensureSqliteClient(env: NodeJS.ProcessEnv, allowGenerate: boolean): void {
  const provider = generatedProvider()
  if (provider === 'sqlite') return
  if (!allowGenerate) {
    throw new Error(
      `[local] Prisma odjemalec je generiran za ${provider ?? 'neznan'} provider, ne za sqlite. ` +
        'Zaženite `bun run local:setup` brez --no-generate ali `bun run db:generate`.',
    )
  }
  prismaCommand(['generate', '--schema', SQLITE_SCHEMA], env)
  const after = generatedProvider()
  if (after !== 'sqlite') {
    throw new Error(`[local] Po generiranju je provider še vedno ${after ?? 'neznan'} — pričakovan sqlite.`)
  }
}

function firstRunCredentials(input: {
  dataDir: string
  dbPath: string
  ownerEmail: string
  pin: string
  restaurantName: string
}): string {
  return [
    'RestaurantOS — prvi zagon',
    '',
    `Datum: ${new Date().toISOString()}`,
    `Obrat: ${input.restaurantName}`,
    `Podatkovna mapa: ${input.dataDir}`,
    `Baza: ${input.dbPath}`,
    '',
    `Prijava: ${input.ownerEmail}`,
    `PIN: ${input.pin}`,
    '',
    'To datoteko shranite varno (vsebuje poverilnice) in jo izbrišite, ko si PIN zapomnite.',
    'Demo podatki niso bili naloženi.',
    '',
  ].join('\n')
}

export async function runLocalSetup(options: LocalSetupOptions = {}): Promise<LocalSetupResult> {
  assertRepoRoot()

  const dataDir = options.dataDir ? resolveDataDir({ env: { RESTAURANTOS_DATA_DIR: options.dataDir } }) : resolveDataDir()
  const dbPath = databasePathFor(dataDir)
  const ownerEmail = (options.ownerEmail || DEFAULT_OWNER_EMAIL).trim().toLowerCase()
  const restaurantName = (options.restaurantName || DEFAULT_RESTAURANT_NAME).trim() || DEFAULT_RESTAURANT_NAME
  const explicitPin = options.ownerPin?.trim()

  if (!/^[^@\s]+@[^@\s]+$/.test(ownerEmail)) throw new Error(`[local] Neveljaven e-poštni naslov lastnika: ${ownerEmail}`)
  if (explicitPin !== undefined && !/^\d{4,8}$/.test(explicitPin)) {
    throw new Error('[local] PIN mora imeti 4–8 števk.')
  }

  const { secrets, created: secretsCreated } = readOrCreateSecrets(dataDir)
  const env: NodeJS.ProcessEnv = { ...process.env, ...localEnv(secrets, dbPath) }
  Object.assign(process.env, env)

  ensureSqliteClient(env, options.allowGenerate !== false)

  // Kopija in WAL morata biti vzpostavljena PRED `db push`: poseg v shemo je
  // edini korak, ki ga v tej izdaji ne moremo razveljaviti.
  const backupsDir = path.join(dataDir, 'backups')
  const backupCreated = existsSync(dbPath)
    ? (await backupDatabase(dbPath, backupsDir, { kind: 'pred-pushom' })).file
    : undefined
  const journalMode = applyDurability(dbPath).journalMode

  prismaCommand(['db', 'push', '--schema', SQLITE_SCHEMA, '--skip-generate'], env)

  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  try {
    const existingEmployees = await db.employee.count()

    let location = await db.location.findFirst({ orderBy: { createdAt: 'asc' } })
    if (!location) {
      location = await db.location.create({
        data: {
          id: 'local-main',
          name: restaurantName,
          code: 'LOC-01',
          type: 'restaurant',
          isOpen: true,
          isActive: true,
        },
      })
    }

    const settings = await db.restaurantSettings.findFirst({ orderBy: { createdAt: 'asc' } })
    if (!settings) {
      await db.restaurantSettings.create({
        data: { id: 'local-settings', name: restaurantName, email: ownerEmail },
      })
    }

    let ownerCreated = false
    let pin: string | undefined
    let generated = false
    let ownerEmailResult = ownerEmail
    if (existingEmployees === 0) {
      generated = explicitPin === undefined
      pin = explicitPin ?? generatePin()
      const fields = employeePinFields(pin, ownerEmail)
      await db.employee.create({
        data: {
          id: 'local-owner',
          name: 'Lastnik',
          email: ownerEmail,
          role: 'admin',
          status: 'active',
          locationId: location.id,
          pin: fields.pin,
          pinLookup: fields.pinLookup,
        },
      })
      ownerCreated = true
      writeFileSync(
        path.join(dataDir, LOCAL_SETUP_MARKER),
        firstRunCredentials({ dataDir, dbPath, ownerEmail, pin, restaurantName }),
        { mode: 0o600 },
      )
    } else {
      // Ponovni zagon: za izpis poišči dejanskega lastnika, ne privzete e-pošte.
      const existingAdmin = await db.employee.findFirst({
        where: { role: 'admin' },
        orderBy: { createdAt: 'asc' },
        select: { email: true },
      })
      if (existingAdmin) ownerEmailResult = existingAdmin.email
    }

    return {
      dataDir,
      dbPath,
      ownerCreated,
      ownerEmail: ownerEmailResult,
      existingEmployees,
      secretsCreated,
      journalMode,
      ...(backupCreated ? { backupCreated } : {}),
      ...(ownerCreated && generated && pin ? { pin } : {}),
    }
  } finally {
    await db.$disconnect()
  }
}
