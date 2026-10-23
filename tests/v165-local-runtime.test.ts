/**
 * v1.165.0 — samodejni lokalni zagon (PRD docs/PRD-LOKALNA-BAZA.md, R1).
 *
 * Preverja čiste odločitve, ki so lahko nevarne, če se tiho spremenijo:
 *  - kam se shrani baza (nikoli v repo),
 *  - ali se skrivnosti obnovijo ali rotirajo,
 *  - ali se lokalni profil predstavi kot produkcija z zaprto demo prijavo,
 *  - ali je `file:` URL pravilen za Prisma na Windows,
 *  - ali health poroča lokalni način brez razkritja poti.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCAL_DB_FILE,
  LOCAL_SECRETS_FILE,
  databasePathFor,
  generatePin,
  lanUrls,
  localEnv,
  readOrCreateSecrets,
  resolveDataDir,
  sqliteUrlFor,
  type NetworkInterfaceLike,
} from '../src/lib/local-runtime'
import { databaseEngine, isLocalDatabaseUrl, runtimeMode } from '../src/lib/runtime-info'

const tmpDirs: string[] = []
function tempDir(prefix = 'ros-v165-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('v1.165.0 — podatkovna mapa zunaj repozitorija', () => {
  it('Windows: privzeto %LOCALAPPDATA%\\RestaurantOS', () => {
    expect(
      resolveDataDir({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' },
        home: 'C:\\Users\\ana',
      }),
    ).toBe('C:\\Users\\ana\\AppData\\Local\\RestaurantOS')
  })

  it('Windows: brez LOCALAPPDATA uporabi uporabniški profil', () => {
    expect(resolveDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\ana' })).toBe(
      'C:\\Users\\ana\\AppData\\Local\\RestaurantOS',
    )
  })

  it('macOS: Application Support', () => {
    expect(resolveDataDir({ platform: 'darwin', env: {}, home: '/Users/ana' })).toBe(
      '/Users/ana/Library/Application Support/RestaurantOS',
    )
  })

  it('Linux: XDG_DATA_HOME ali ~/.local/share', () => {
    expect(resolveDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/var/lib/ros' }, home: '/home/ana' })).toBe(
      '/var/lib/ros/restaurantos',
    )
    expect(resolveDataDir({ platform: 'linux', env: {}, home: '/home/ana' })).toBe(
      '/home/ana/.local/share/restaurantos',
    )
  })

  it('RESTAURANTOS_DATA_DIR ima prednost pred privzeto potjo', () => {
    const override = tempDir('ros-data-dir-')
    expect(
      resolveDataDir({
        platform: 'win32',
        env: { RESTAURANTOS_DATA_DIR: override, LOCALAPPDATA: 'C:\\ignored' },
        home: 'C:\\Users\\ana',
      }),
    ).toBe(override)
  })

  /**
   * CI run 39905677431 (tests, Linux runner): `Expected: "/tmp/ros-data-dir-89YCzY",
   * Received: "\tmp\ros-data-dir-89YCzY"`. Prej je bil override predelan po
   * MODELIRANI platformi (`path.win32.resolve` na Linux gostitelju), lokalno na
   * Windows pa je isti test moral uspevati — zato napaka ni bila vidna.
   *
   * Invarianta: eksplicitna nastavitev uporabnika je AUTHORITATIVNA. Gostitelj jo
   * naredi absolutno, modelirana platforma (ki služi samo za izbiro PRIVZETE poti)
   * je ne sme preinterpretirati. Test je deterministen na obeh gostiteljih:
   * na Windows razveljavi `linux`/`darwin` veja, na Linux `win32` veja.
   */
  it('override ne sme biti predelan po modelirani platformi — velja sintaksa gostitelja', () => {
    const abs = tempDir('ros-data-dir-')
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(resolveDataDir({ platform, env: { RESTAURANTOS_DATA_DIR: abs } })).toBe(abs)
    }
  })

  it('baza je v data/restaurantos.db, ne v korenu podatkovne mape', () => {
    expect(databasePathFor('C:\\ros', 'win32')).toBe('C:\\ros\\data\\restaurantos.db')
    expect(databasePathFor('/var/ros', 'linux')).toBe('/var/ros/data/restaurantos.db')
    expect(LOCAL_DB_FILE).toBe('restaurantos.db')
  })
})

describe('v1.165.0 — Prisma SQLite URL', () => {
  it('Windows pot pretvori v file: URL s poševnicami naprej (presledki ostanejo)', () => {
    expect(sqliteUrlFor('C:\\Users\\ana\\AppData\\Local\\RestaurantOS\\data\\restaurantos.db')).toBe(
      'file:C:/Users/ana/AppData/Local/RestaurantOS/data/restaurantos.db',
    )
    expect(sqliteUrlFor('C:\\Users\\ana\\App Data\\restaurantos.db')).toBe(
      'file:C:/Users/ana/App Data/restaurantos.db',
    )
  })

  it('lokalni način prepozna samo file: URL', () => {
    expect(isLocalDatabaseUrl('file:./db/dev.db')).toBe(true)
    expect(isLocalDatabaseUrl('file:C:/ros/data/restaurantos.db')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://user:pass@host/db')).toBe(false)
    expect(isLocalDatabaseUrl(undefined)).toBe(false)
    expect(runtimeMode({ DATABASE_URL: 'file:./x.db' })).toBe('local')
    expect(runtimeMode({ DATABASE_URL: 'postgresql://x' })).toBe('cloud')
    expect(databaseEngine({ DATABASE_URL: 'file:./x.db' })).toBe('sqlite')
    expect(databaseEngine({ DATABASE_URL: 'postgresql://x' })).toBe('postgresql')
  })
})

describe('v1.165.0 — skrivnosti se ustvarijo enkrat in se ne rotirajo', () => {
  it('prvi zagon ustvari tri skrivnosti, drugi jih prebere nespremenjene', () => {
    const dir = tempDir()
    const first = readOrCreateSecrets(dir)
    expect(first.created).toBe(true)
    expect(first.secrets.appSecret.length).toBeGreaterThanOrEqual(40)
    expect(first.secrets.pinLookupSalt.length).toBeGreaterThanOrEqual(40)
    expect(first.secrets.cronSecret.length).toBeGreaterThanOrEqual(40)

    const second = readOrCreateSecrets(dir)
    expect(second.created).toBe(false)
    expect(second.secrets).toEqual(first.secrets)

    const raw = readFileSync(join(dir, LOCAL_SECRETS_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.appSecret).toBe(first.secrets.appSecret)
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, LOCAL_SECRETS_FILE)).mode & 0o777).toBe(0o600)
    }
  })

  it('poškodovana konfiguracija se zavrne in se NE prepiše', () => {
    const dir = tempDir()
    const file = join(dir, LOCAL_SECRETS_FILE)
    writeFileSync(file, '{ poškodovano', 'utf8')
    expect(() => readOrCreateSecrets(dir)).toThrow(/config|konfiguracij/i)
    expect(readFileSync(file, 'utf8')).toBe('{ poškodovano')
  })

  it('lokalno okolje je produkcijsko, demo prijava zaprta, break-glass prazen', () => {
    const secrets = readOrCreateSecrets(tempDir()).secrets
    const env = localEnv(secrets, 'C:\\ros\\data\\restaurantos.db', { port: 3100 })
    expect(env.DATABASE_URL).toBe('file:C:/ros/data/restaurantos.db')
    expect(env.APP_SECRET).toBe(secrets.appSecret)
    expect(env.PIN_LOOKUP_SALT).toBe(secrets.pinLookupSalt)
    expect(env.CRON_SECRET).toBe(secrets.cronSecret)
    expect(env.NODE_ENV).toBe('production')
    expect(env.RESTAURANTOS_LOCAL).toBe('1')
    expect(env.DEMO_LOGIN_ENABLED).toBe('0')
    expect(env.BOOTSTRAP_ADMIN_EMAIL).toBe('')
    expect(env.BOOTSTRAP_ADMIN_PIN).toBe('')
    expect(env.HOSTNAME).toBe('0.0.0.0')
    expect(env.PORT).toBe('3100')
  })

  it('PIN je natanko 6 števk in ni vedno isti', () => {
    const pins = new Set(Array.from({ length: 20 }, () => generatePin()))
    for (const p of pins) expect(p).toMatch(/^\d{6}$/)
    expect(pins.size).toBeGreaterThan(1)
  })
})

describe('v1.165.0 — omrežni naslovi', () => {
  it('izpusti notranje in IPv6 naslove, obdrži LAN IPv4', () => {
    const ifaces: Record<string, NetworkInterfaceLike[]> = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
    }
    expect(lanUrls(3000, ifaces)).toEqual(['http://192.168.1.20:3000'])
  })
})

describe('v1.165.0 — statične varnostne invariante', () => {
  it('package.json ima lokalni zagon in setup', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts.local).toContain('scripts/local-start.ts')
    expect(pkg.scripts['local:setup']).toContain('scripts/local-setup.ts')
  })

  it('setup ne uporablja --accept-data-loss in ne seje demo PIN-ov', () => {
    const setup = read('src/lib/local-setup.ts')
    // Komentarji smejo flag omenjati (opozorilo bralcu); prepoved velja za kodo.
    const code = setup.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('--accept-data-loss')
    expect(code).not.toContain('prisma/seed')
    expect(setup).toContain('LOCAL_SETUP_MARKER')
    expect(read('src/lib/local-runtime.ts')).toContain("LOCAL_SETUP_MARKER = 'PRVIC-ZAGON.txt'")
    expect(setup).toContain('generatePin')
  })

  it('local-start zažene setup in ne demo seeda', () => {
    const start = read('scripts/local-start.ts')
    expect(start).toContain('runLocalSetup')
    expect(start).not.toContain('prisma/seed')
    expect(start).toContain('0.0.0.0')
  })

  it('health poroča način in motor baze', () => {
    const health = read('src/app/api/health/route.ts')
    expect(health).toContain('runtimeMode')
    expect(health).toContain('databaseEngine')
  })

  it('README in PRD opisujeta lokalni zagon', () => {
    expect(read('README.md')).toContain('bun run local')
    expect(read('docs/PRD-LOKALNA-BAZA.md')).toContain('R1 — v1.165.0')
  })

  it('podatkovna mapa ni v repozitoriju (privzeta pot je zunaj cwd)', () => {
    const d = resolveDataDir({ platform: process.platform, env: {}, home: tmpdir() })
    expect(d.startsWith(process.cwd())).toBe(false)
  })
})
