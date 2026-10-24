/**
 * v1.165.0 — lokalni runtime (PRD docs/PRD-LOKALNA-BAZA.md, F1/F2/F6).
 *
 * Čiste funkcije brez stranskih učinkov razen branja/pisanja konfiguracije:
 *  - podatkovna mapa je VEDNO zunaj repozitorija (privzeto v uporabniškem
 *    profilu), da `git status` ne vidi baze in da posodobitev kode ne more
 *    povoziti podatkov;
 *  - skrivnosti se ustvarijo enkrat in se ob ponovnem zagonu NE rotirajo
 *    (rotacija APP_SECRET bi razveljavila seje, rotacija PIN_LOOKUP_SALT pa
 *    zaklenila obstoječe PIN-e);
 *  - konfiguracija s 0600; poškodovane datoteke se ne prepišejo tiho.
 */
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export const LOCAL_DB_SUBDIR = 'data'
export const LOCAL_DB_FILE = 'restaurantos.db'
export const LOCAL_SECRETS_FILE = 'config.json'
export const LOCAL_SETUP_MARKER = 'PRVIC-ZAGON.txt'

export interface DataDirOptions {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
}

export function resolveDataDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
}: DataDirOptions = {}): string {
  const override = env.RESTAURANTOS_DATA_DIR?.trim()
  if (override) {
    // EKSPlicitna nastavitev je authoritative: naredi jo absolutno v sintaksi
    // GOSTITELJA. `platform` tu ne sme poseči — `path.win32.resolve('/tmp/x')` na
    // Linuxu vrne `\tmp\x` (CI run 39905677431), lokalno na Windows pa isti test
    // uspe, zato napaka ostane skrita. Modelirana platforma izbira samo PRIVZETO pot.
    return path.resolve(override)
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local')
    return path.win32.join(base, 'RestaurantOS')
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'RestaurantOS')
  }
  const base = env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share')
  return path.posix.join(base, 'restaurantos')
}

export function databasePathFor(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  return p.join(dataDir, LOCAL_DB_SUBDIR, LOCAL_DB_FILE)
}

/** Prisma zahteva `file:` URL; poševnice naprej tudi na Windows. Presledki ostanejo nekodirani (preverjeno). */
export function sqliteUrlFor(dbPath: string): string {
  return `file:${dbPath.replace(/\\/g, '/')}`
}

export interface LocalSecrets {
  version: 1
  appSecret: string
  pinLookupSalt: string
  cronSecret: string
  createdAt: string
}

export interface SecretsResult {
  secrets: LocalSecrets
  created: boolean
}

function newSecret(random: (size: number) => Buffer): string {
  return random(48).toString('base64url')
}

function validateSecrets(value: unknown): LocalSecrets {
  if (!value || typeof value !== 'object') throw new Error('ni objekt')
  const v = value as Record<string, unknown>
  if (v.version !== 1) throw new Error('neznana različica')
  for (const key of ['appSecret', 'pinLookupSalt', 'cronSecret'] as const) {
    if (typeof v[key] !== 'string' || (v[key] as string).length < 32) throw new Error(`manjka ali je prekratek ${key}`)
  }
  if (typeof v.createdAt !== 'string') throw new Error('manjka createdAt')
  return {
    version: 1,
    appSecret: v.appSecret as string,
    pinLookupSalt: v.pinLookupSalt as string,
    cronSecret: v.cronSecret as string,
    createdAt: v.createdAt,
  }
}

export function readOrCreateSecrets(
  dataDir: string,
  random: (size: number) => Buffer = crypto.randomBytes,
): SecretsResult {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = path.join(dataDir, LOCAL_SECRETS_FILE)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const secrets: LocalSecrets = {
      version: 1,
      appSecret: newSecret(random),
      pinLookupSalt: newSecret(random),
      cronSecret: newSecret(random),
      createdAt: new Date().toISOString(),
    }
    try {
      writeFileSync(file, JSON.stringify(secrets, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      return { secrets, created: true }
    } catch (createErr) {
      // Drug proces je medtem ustvaril datoteko — preberi njegovo, ne prepiši.
      if ((createErr as NodeJS.ErrnoException).code !== 'EEXIST') throw createErr
      return readOrCreateSecrets(dataDir, random)
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `[local] ${LOCAL_SECRETS_FILE} ni veljaven JSON (${(err as Error).message}). Datoteke ne prepišem — popravite jo ali jo premaknite stran.`,
    )
  }
  try {
    return { secrets: validateSecrets(parsed), created: false }
  } catch (err) {
    throw new Error(
      `[local] ${LOCAL_SECRETS_FILE} je neveljaven (${(err as Error).message}). Datoteke ne prepišem — popravite jo ali jo premaknite stran.`,
    )
  }
}

export interface LocalEnvOptions {
  port?: number
}

/**
 * Okolje lokalnega profila: produkcijski NODE_ENV (cookie/secure vede), vendar
 * zaprta demo prijava in izpraznjena break-glass pot — lokalna namestitev ne
 * sme imeti skritih demo računov.
 */
export function localEnv(
  secrets: LocalSecrets,
  dbPath: string,
  { port = 3000 }: LocalEnvOptions = {},
): Record<string, string> {
  return {
    DATABASE_URL: sqliteUrlFor(dbPath),
    APP_SECRET: secrets.appSecret,
    PIN_LOOKUP_SALT: secrets.pinLookupSalt,
    CRON_SECRET: secrets.cronSecret,
    NODE_ENV: 'production',
    RESTAURANTOS_LOCAL: '1',
    DEMO_LOGIN_ENABLED: '0',
    BOOTSTRAP_ADMIN_EMAIL: '',
    BOOTSTRAP_ADMIN_PIN: '',
    HOSTNAME: '0.0.0.0',
    PORT: String(port),
  }
}

export function generatePin(randomInt: (min: number, max: number) => number = crypto.randomInt): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export interface NetworkInterfaceLike {
  address: string
  family: string | number
  internal: boolean
}

export function lanIpv4(interfaces: Record<string, NetworkInterfaceLike[] | undefined> = os.networkInterfaces()): string[] {
  const naslovi: string[] = []
  for (const list of Object.values(interfaces)) {
    for (const iface of list || []) {
      if (iface.internal) continue
      if (iface.family !== 'IPv4' && iface.family !== 4) continue
      if (!naslovi.includes(iface.address)) naslovi.push(iface.address)
    }
  }
  return naslovi
}

export function lanUrls(
  port: number,
  interfaces: Record<string, NetworkInterfaceLike[] | undefined> = os.networkInterfaces(),
  scheme: 'http' | 'https' = 'http',
): string[] {
  return lanIpv4(interfaces).map((ip) => `${scheme}://${ip}:${port}`)
}

/** Rezervirana vrata lokalne fronte pri `--https`; `--https-port` jih premakne. */
export const LOCAL_HTTPS_PORT = 3443

export interface LocalServingOptions {
  port: number
  https: boolean
  httpsPort?: number
}

export interface LocalServingPlan {
  nextHost: string
  nextPort: number
  /** 0 pomeni, da front ne teče in Next sam ponuja javni vnos. */
  frontPort: number
  scheme: 'http' | 'https'
  publicPort: number
}

/**
 * Kdo posluša kje. Ko je HTTPS vklopljen, sme Next brati samo zanko: `next
 * start -H` je edina nastavitev vezave, zato bi 0.0.0.0 pomenil goli HTTP tik ob
 * obljubljenem HTTPS naslovu. Fronta je takrat edini javni vnos.
 */
export function servingPlan(o: LocalServingOptions): LocalServingPlan {
  if (!o.https) {
    return { nextHost: '0.0.0.0', nextPort: o.port, frontPort: 0, scheme: 'http', publicPort: o.port }
  }
  const frontPort = o.httpsPort ?? LOCAL_HTTPS_PORT
  return { nextHost: '127.0.0.1', nextPort: o.port, frontPort, scheme: 'https', publicPort: frontPort }
}
