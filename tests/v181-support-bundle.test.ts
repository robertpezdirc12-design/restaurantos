/**
 * v1.181.0 — R4a: lokalni dnevnik napak in podporni paket BREZ skrivnosti
 * (PRD docs/PRD-LOKALNA-BAZA.md, R4: "dnevnik napak" + "support bundle brez
 * skrivnosti").
 *
 * Zakaj se začne R4 tu in ne pri preverjanju posodobitev: edini del R4, kjer
 * lahko napaka tiho pošlje skrivnosti navzven, je paket, ki ga lastnik pošlje
 * podpori. Preostali trije deli (preverjanje, podpisani paket, rollback) v
 * najslabšem primeru ne naredijo nič. Zato ta datoteka brani prav izdajo, kjer je
 * cena napake najvišja.
 *
 * Meritve, ki so rodile te teste (bun 1.4.3, Windows, 2026-10-26):
 *  - lokalni profil piše napake SAMO v `console.error` (`src/lib/db-error.ts:138`).
 *    Od kar je zagon ob prijavi (v1.175.0 R2b2), stdout nima bralca: lastnik do
 *    izpisa ne pride, razen če ročno zažene `bun run local` v terminalu;
 *  - podpora torej danes ne dobi NIC. Paket brez dnevnika je nabor številk, ki
 *    ne pojasni nobene napake, zato sta oba dela v eni izdaji;
 *  - v podatkovni mapi ležijo štiri stvari, ki nikoli ne smejo navzven:
 *    `config.json` (appSecret / pinLookupSalt / cronSecret), `PRVIC-ZAGON.txt`
 *    (PIN lastnika v jasnem besedilu), `tls/*` (zasebni ključ fronte) in
 *    `data/*.db` (stranke, računi, osebje). Paket jih ne sme nikoli prebrati —
 *    zato `readSnapshot` dobi INJICIRAN `fs` in test meri, KATERE poti so bile
 *    odprte, ne samo kaj je v izpisu.
 *  - `PRAGMA busy_timeout` in `PRAGMA synchronous` veljata SAMO za povezavo: na
 *    sveži povezavi (bralni ali pisateljski) je `busy_timeout = 0`,
 *    `synchronous = 2`. Trajna je samo `journal_mode` — WAL je v glavi datoteke in
 *    ga vidi naslednji ročaj. Razlaga v1.169.0 je bila napačna: brala je pragme
 *    takoj za tem, ko jih je ISTA povezava nastavila. Podporni paket zato meri
 *    journal_mode, za pragmi pa navaja vrednosti, ki ju aplikacija nastavlja
 *    (izmerjeno 2026-10-26).
 *
 * Poštenost varovalke (§E): negativna trditev "v paketu ni skrivnosti" brez
 * pozitivne kontrole ne trdi ničesar — ista vrednost MORA biti v surovem vhodu
 * vidna, sicer preizkus ni dokazal ničesar (isti vzorec kot §D v
 * tests/v1801-brand-name.test.ts).
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { APP_VERSION } from '../src/lib/version'
import { LOCAL_BUSY_TIMEOUT_MS, LOCAL_SYNCHRONOUS, applyDurability } from '../src/lib/local-durability'
import {
  LOCAL_LOG_SUBDIR,
  LOCAL_LOG_PREFIX,
  LOCAL_MAX_LOG_DAYS,
  LOCAL_MAX_LOG_BYTES,
  LOCAL_MAX_LOG_FILES_PER_DAY,
  logsDirFor,
  logFilePathFor,
  appendErrorLog,
  tailErrorLog,
  pruneErrorLogs,
} from '../src/lib/local-log'
import {
  BUNDLE_SUBDIR,
  SECRET_PLACEHOLDER,
  HOME_PLACEHOLDER,
  FORBIDDEN_NAMES,
  collectSecretValues,
  countTables,
  redact,
  readSnapshot,
  buildBundle,
  writeBundle,
  assertBundleClean,
  type BuildInput,
  type RecordingFs,
} from '../src/lib/support-bundle'

const tmpDirs: string[] = []
function tempDir(prefix = 'ros-v181-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

/**
 * Pod bunom `close()` ročaja `DatabaseSync` takoj ne sprosti — datoteka ostane
 * zaklenjena, dokler tekač ne pobere objekta (izmerjeno že pri v1.169.0, kjer je
 * naslednji `renameSync` javil EPERM). Brez tega `rmSync` v startsnem pogonu javi
 * EBUSY, zato je čistnja začela z ročnim GC in se do petkrat ponovi.
 */
function sprostiRočaje(): void {
  ;(globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }).Bun?.gc?.(true)
}

afterAll(() => {
  sprostiRočaje()
  for (const d of tmpDirs) {
    for (let attempt = 1; ; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt >= 5) throw err
        sprostiRočaje()
      }
    }
  }
})

// Tri prave skrivnosti (32+ znakov base64url kot jih generira readOrCreateSecrets).
const APP_SECRET = 'appSekreta8N3dLp0rQzT7vKxWmBqYcFhR2sJuVe_1Zg'
const PIN_SALT = 'saltSekreta4XkP0mNzQ8rLwT7vB3aYcJhFd2sKuYe_9Zg'
const CRON_SECRET = 'cronSekreta9ZxK3mNp0rQ7LvTwB8aYcJhFd2sKuVe_1Z'
const SECRETS = [APP_SECRET, PIN_SALT, CRON_SECRET]
// Kratka (13 znakov) znana vrednost je POD mejo LONG_TOKEN (32): edini razlog, da
// pade, je seznam, nabran iz `config.json`. Brez nje bi bili trije dolgi žetoni
// maskirani tudi, ko seznam sploh ne deluje — mutacija M2 je zato ušla.
const SHORT_SECRET = 'KratkoGeslo7x'
// Kratek Bearer žeton: pravilo BEARER je edini, ki ga ujame (LONG_TOKEN ne, ker je
// kratek; QUERY_SECRET ne, ker ni `?token=`).
const SHORT_BEARER = 'cronZeton12'

const day = (iso: string) => new Date(iso)
const NOW = day('2026-10-26T07:00:00.000Z')
const dayKey = (d: Date) => d.toISOString().slice(0, 10)

function baseInput(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    now: NOW,
    appVersion: '1.181.0',
    commit: 'devtestcommit',
    mode: 'local',
    databaseEngine: 'sqlite',
    environment: {
      platform: 'win32',
      release: '10.0.19045',
      arch: 'x64',
      runtime: 'bun 1.4.3',
      home: 'C:\\Users\\robert',
      dataDir: 'C:\\Users\\robert\\AppData\\Local\\RestaurantOS',
      freeDiskMb: 351000,
    },
    health: { status: 'degraded', database: 'connected', schema: 'drift', latencyMs: 12, dbError: { code: 'P2021', category: 'schema', hint: 'Manjka tabela.' } },
    durability: { journalMode: 'wal', synchronous: 'FULL', busyTimeoutMs: 5000 },
    backups: [{ name: 'dnevno-2026-10-25.db', sizeBytes: 245760, ageDays: 1 }],
    logs: ['2026-10-26T06:59:00.000Z [GET /api/health — schema probe] (P2021): table missing'],
    counts: { Location: 1, Order: 42 },
    secrets: SECRETS,
    ...overrides,
  }
}

/** Inektiran `fs`, ki ZAPISUJE vsako odprto pot — dokaz o prepovedanih branchah. */
function recordingFs(root: string): RecordingFs & { opened: string[] } {
  const opened: string[] = []
  const rec = (p: string) => opened.push(p)
  return {
    opened,
    existsSync(p) {
      rec(p)
      return existsSync(p)
    },
    readdirSync(p) {
      rec(p)
      return readdirSync(p) as string[]
    },
    statSync(p) {
      rec(p)
      return statSync(p)
    },
    readFileSync(p) {
      rec(p)
      return readFileSync(p, 'utf8')
    },
    root,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §A — dnevnik napak: pot, zapis, branje po ponovnem zagonu
// ─────────────────────────────────────────────────────────────────────────────

describe('v181 §A lokalni dnevnik napak', () => {
  it('A1 koren podatkovne mapi je logs in datoteka je dnevna po UTC', () => {
    const root = tempDir()
    expect(logsDirFor(root)).toBe(join(root, LOCAL_LOG_SUBDIR))
    expect(logFilePathFor(root, NOW)).toBe(join(root, LOCAL_LOG_SUBDIR, `${LOCAL_LOG_PREFIX}${dayKey(NOW)}.log`))
  })

  it('A2 zapis ustvari mapo in vrne pot; vsebina je berljiva', () => {
    const root = tempDir()
    const res = appendErrorLog(root, { scope: 'GET /api/health', message: ' disconnected', code: 'P1001', at: NOW }, NOW)
    expect(res.appended).toBe(true)
    expect(res.error).toBeUndefined()
    expect(existsSync(res.file)).toBe(true)
    const text = readFileSync(res.file, 'utf8')
    expect(text).toContain('P1001')
    expect(text).toContain('GET /api/health')
  })

  it('A3 več zapisov istega dne se dodaja, ne prepisuje', () => {
    const root = tempDir()
    appendErrorLog(root, { scope: 'prva', message: 'x', at: NOW }, NOW)
    const drugi = appendErrorLog(root, { scope: 'druga', message: 'y', at: day('2026-10-26T07:30:00.000Z') }, day('2026-10-26T07:30:00.000Z'))
    expect(drugi.file).toBe(logFilePathFor(root, NOW))
    const lines = readFileSync(drugi.file, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
  })

  it('A4 sled klicev: vsaka vrstica dobi predpono, zapis ostane en blok brez izgube', () => {
    const root = tempDir()
    const res = appendErrorLog(root, { scope: 's', message: 'm', stack: 'Error: m\n    at a.ts:1\n    at b.ts:2', at: NOW }, NOW)
    const text = readFileSync(res.file, 'utf8')
    expect(text.trim().split('\n').length).toBe(4)
    expect(text).toContain('\n| at a.ts:1')
  })

  it('A5 zapisi različnih dni ustvarijo različne datoteke', () => {
    const root = tempDir()
    const a = appendErrorLog(root, { scope: 'd1', message: 'x', at: day('2026-10-24T01:00:00.000Z') }, day('2026-10-24T01:00:00.000Z'))
    const b = appendErrorLog(root, { scope: 'd2', message: 'x', at: day('2026-10-25T01:00:00.000Z') }, day('2026-10-25T01:00:00.000Z'))
    expect(a.file).not.toBe(b.file)
    expect(readdirSync(logsDirFor(root)).sort()).toEqual([
      `${LOCAL_LOG_PREFIX}2026-10-24.log`,
      `${LOCAL_LOG_PREFIX}2026-10-25.log`,
    ])
  })

  it('A6 lokalni dnevnik preživi ponovni zagon (novi bralec vidi prejšnje vrstice)', () => {
    const root = tempDir()
    appendErrorLog(root, { scope: 'pred-zagonom', message: 'izgubil se ne sme', at: NOW }, NOW)
    const tail = tailErrorLog(root, 50, NOW)
    expect(tail.unavailable).toBeUndefined()
    expect(tail.lines.join('\n')).toContain('pred-zagonom')
  })

  it('A7 tail vrača najnovejše vrstice in ne več kot zahtevanih', () => {
    const root = tempDir()
    for (let i = 0; i < 12; i++) {
      appendErrorLog(root, { scope: `zapis-${String(i).padStart(2, '0')}`, message: 'm', at: day(`2026-10-26T07:${String(i).padStart(2, '0')}:00.000Z`) }, day(`2026-10-26T07:${String(i).padStart(2, '0')}:00.000Z`))
    }
    const tail = tailErrorLog(root, 4, NOW)
    expect(tail.lines.length).toBe(4)
    expect(tail.lines.join('\n')).toContain('zapis-11')
    expect(tail.lines.join('\n')).not.toContain('zapis-00')
  })

  it('A8 odsoten dnevnik je javno stanje in ne prazen seznam', () => {
    const root = tempDir()
    const tail = tailErrorLog(root, 50, NOW)
    expect(tail.lines).toEqual([])
    expect(tail.unavailable).toContain('dnevnik')
  })

  it('A9 nepisna pot ne vrže izjeme, ampak javi razlog', () => {
    const root = tempDir()
    const ovajana = join(root, 'ni-mapa')
    writeFileSync(ovajana, 'x')
    const res = appendErrorLog(ovajana, { scope: 's', message: 'm', at: NOW }, NOW)
    expect(res.appended).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('A10 meja na dan povzroči preobrat na .2.log in ne tihe izgube', () => {
    const root = tempDir()
    appendErrorLog(root, { scope: 'polni', message: 'x'.repeat(LOCAL_MAX_LOG_BYTES), at: NOW }, NOW)
    const preobrat = appendErrorLog(root, { scope: 'naključna', message: 'y', at: NOW }, NOW)
    expect(preobrat.appended).toBe(true)
    expect(preobrat.file).toContain(`${LOCAL_LOG_PREFIX}${dayKey(NOW)}.2.log`)
  })

  it('A11 zapora dnevnika po doseženi najvišji številki datoteke je javljena', () => {
    const root = tempDir()
    for (let i = 1; i <= LOCAL_MAX_LOG_FILES_PER_DAY; i++) {
      appendErrorLog(root, { scope: `polni-${i}`, message: 'x'.repeat(LOCAL_MAX_LOG_BYTES), at: NOW }, NOW)
    }
    const res = appendErrorLog(root, { scope: 'prepozno', message: 'y', at: NOW }, NOW)
    expect(res.appended).toBe(false)
    expect(res.error).toContain('meja')
  })

  it('A12 čiščenje pobriše starejše od LOCAL_MAX_LOG_DAYS dni in pusti sveže', () => {
    const root = tempDir()
    const stara = day('2026-10-01T01:00:00.000Z')
    const sveza = day('2026-10-26T01:00:00.000Z')
    appendErrorLog(root, { scope: 'stara', message: 'x', at: stara }, stara)
    appendErrorLog(root, { scope: 'sveza', message: 'x', at: sveza }, sveza)
    const removed = pruneErrorLogs(root, NOW)
    expect(removed).toEqual([`${LOCAL_LOG_PREFIX}2026-10-01.log`])
    expect(existsSync(logFilePathFor(root, stara))).toBe(false)
    expect(existsSync(logFilePathFor(root, sveza))).toBe(true)
    expect(LOCAL_MAX_LOG_DAYS).toBe(7)
  })

  it('A13 tuje datoteke v mapi logs se ne pobriše', () => {
    const root = tempDir()
    mkdirSync(logsDirFor(root), { recursive: true })
    writeFileSync(join(logsDirFor(root), 'opomba.txt'), 'to ni dnevnik')
    const removed = pruneErrorLogs(root, NOW)
    expect(removed).toEqual([])
    expect(existsSync(join(logsDirFor(root), 'opomba.txt'))).toBe(true)
  })

  it('A14 na POSIX datoteka dobi 0600 (Windows preskočeno — mode ni uveljavljen)', () => {
    const root = tempDir()
    const res = appendErrorLog(root, { scope: 's', message: 'm', at: NOW }, NOW)
    if (process.platform === 'win32') {
      expect(existsSync(res.file)).toBe(true)
      return
    }
    expect(statSync(res.file).mode & 0o077).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §B — redaktura
// ─────────────────────────────────────────────────────────────────────────────

describe('v181 §B redaktura', () => {
  it('B1 znana skrivnost je zamenjana z oznako, vrste pa zabeležena', () => {
    const vhod = `povezava ${APP_SECRET} in še ${PIN_SALT}`
    const out = redact(vhod, { secrets: SECRETS })
    expect(out.text).toContain(SECRET_PLACEHOLDER)
    expect(out.text).not.toContain(APP_SECRET)
    expect(out.text).not.toContain(PIN_SALT)
    expect(out.redactions).toBe(2)
  })

  it('B2 domača pot je zamenjana z okrajšavo (uporabniško ime ni za podporo)', () => {
    const out = redact('C:\\Users\\robert\\AppData\\Local\\RestaurantOS', { secrets: [] })
    expect(out.text).toBe(`${HOME_PLACEHOLDER}\\AppData\\Local\\RestaurantOS`)
    expect(out.text).not.toContain('robert')
  })

  it('B3 neznana oblika gesla je zamenjana tudi brez seznama skrivnosti', () => {
    const out = redact('GET https://user:SuperGeslo12@host/db?token=abc123def456ghi7', { secrets: [] })
    expect(out.text).not.toContain('SuperGeslo12')
    expect(out.text).not.toContain('token=abc123def456ghi7')
    expect(out.redactions).toBeGreaterThanOrEqual(2)
  })

  it('B4 žetoni tretjih oseb so prepoznani po obliki', () => {
    const out = redact('stripe sk_live_ABCDEFGHIJKLMNOPQRSTUV stripe in github ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA', { secrets: [] })
    expect(out.text).not.toContain('sk_live_ABCDEFGHIJKLMNOPQRSTUV')
    expect(out.text).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  })

  it('B5 navadno besedilo ostane nespremenjeno (redaktura ne kosi diagnostike)', () => {
    const vhod = '2026-10-26T06:59:00.000Z [GET /api/orders] (P2002): Unique constraint failed on Order.number'
    expect(redact(vhod, { secrets: SECRETS }).text).toBe(vhod)
  })

  it('B6 prazen seznam skrivnosti ni izgovor — oblike vseeno padejo', () => {
    const out = redact(`x ${APP_SECRET} y`, { secrets: [] })
    expect(out.text).not.toContain(APP_SECRET)
  })

  it('B7 imena kopij ostanejo nedotaknjena (pravilo z vezajem jih je požrlo)', () => {
    // Živa meritev 2026-10-26: LONG_TOKEN z vezajem je pojedel `pre-push-*` (33) in
    // `pred-obnovo-*` (36 znakov); `dnevno-*` (31) je ušel zaradi meje 32. Inventar
    // brez imen je neuporaben, zato ta preizkus brani dolžino in ne samo oblike.
    const vhod = JSON.stringify({
      backups: [
        { name: 'pred-obnovo-2026-10-22T17-26-26-725Z.db', sizeBytes: 3_682_304, ageDays: 3 },
        { name: 'pre-push-2026-10-24T09-42-53-795Z.db', sizeBytes: 3_682_304, ageDays: 2 },
        { name: 'dnevno-2026-10-22T17-08-24-494Z.db', sizeBytes: 3_682_304, ageDays: 3 },
      ],
    })
    const out = redact(vhod, { secrets: SECRETS })
    expect(out.text).toBe(vhod)
    expect(out.redactions).toBe(0)
  })

  it('B8 kratka znana vrednost pade IZKLJUČNO prek seznama (LONG_TOKEN je ne ujame)', () => {
    const out = redact(`obrazec z vrednostjo ${SHORT_SECRET} ni sprejet`, { secrets: [...SECRETS, SHORT_SECRET] })
    expect(out.text).not.toContain(SHORT_SECRET)
    expect(out.text).toContain(SECRET_PLACEHOLDER)
    expect(out.redactions).toBe(1)
    // Pozitivna kontrola: brez seznama mora ostati nedotaknjena, sicer preizkus ne
    // trdi ničesar o seznamu.
    expect(redact(`obrazec z vrednostjo ${SHORT_SECRET} ni sprejet`, { secrets: [] }).text).toContain(SHORT_SECRET)
  })

  it('B9 Bearer glava: kratek žeton pobere samo pravilo BEARER', () => {
    const out = redact(`GET /api/cron vrne 401, v glavi Bearer ${SHORT_BEARER}`, { secrets: [] })
    expect(out.text).not.toContain(SHORT_BEARER)
    expect(out.text).toContain(`Bearer ${SECRET_PLACEHOLDER}`)
    expect(out.redactions).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §C — branje stanja: nobene prepovedane poti ne odpre
// ─────────────────────────────────────────────────────────────────────────────

describe('v181 §C readSnapshot ne odpre prepovedanega', () => {
  it('C1 seznam prepovedanih imen je izrecen in zajema vse štiri vire', () => {
    expect(FORBIDDEN_NAMES).toContain('config.json')
    expect(FORBIDDEN_NAMES).toContain('PRVIC-ZAGON.txt')
    expect(FORBIDDEN_NAMES).toContain('tls')
    expect(FORBIDDEN_NAMES).toContain('data')
  })

  it('C2 odprte poti so samo logs, backups in koren; nobena prepovedana', () => {
    const root = tempDir()
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'restaurantos.db'), 'NE BERI')
    mkdirSync(join(root, 'tls'), { recursive: true })
    writeFileSync(join(root, 'tls', 'server.key'), 'NE BERI')
    writeFileSync(join(root, 'config.json'), JSON.stringify({ appSecret: APP_SECRET }))
    writeFileSync(join(root, 'PRVIC-ZAGON.txt'), 'PIN: 123456')
    mkdirSync(join(root, 'backups'), { recursive: true })
    writeFileSync(join(root, 'backups', 'dnevno-2026-10-25.db'), 'x'.repeat(123))
    appendErrorLog(root, { scope: 'napaka', message: 'P2021', at: NOW }, NOW)

    const fs = recordingFs(root)
    const snap = readSnapshot({ dataDir: root, now: NOW, fs })
    const prepovedane = fs.opened.filter((p) => FORBIDDEN_NAMES.some((n) => p.split(/[\\/]/).includes(n)))
    expect(prepovedane).toEqual([])
    expect(snap.backups.length).toBe(1)
    expect(snap.backups[0].sizeBytes).toBe(123)
    expect(snap.logs.join('\n')).toContain('napaka')
  })

  it('C3 Inventar kopij vsebuje IME in velikost, nikoli vsebine', () => {
    const root = tempDir()
    mkdirSync(join(root, 'backups'), { recursive: true })
    writeFileSync(join(root, 'backups', 'dnevno-2026-10-20.db'), 'TA-BESEDILO-NIE-SME-SVIT')
    const fs = recordingFs(root)
    const snap = readSnapshot({ dataDir: root, now: NOW, fs })
    expect(snap.backups[0].name).toBe('dnevno-2026-10-20.db')
    expect(JSON.stringify(snap)).not.toContain('TA-BESEDILO-NIE-SME-SVIT')
  })

  it('C3b tuja datoteka v mapi kopij ne pride v inventar', () => {
    // Inventar naj bi podpori povedal, KTERA kopija je na voljo za obnovo. Tuja
    // datoteka (izvoz, začasna mapa) ni kopija in je ne sme varati.
    const root = tempDir()
    mkdirSync(join(root, 'backups'), { recursive: true })
    writeFileSync(join(root, 'backups', 'dnevno-2026-10-20.db'), 'x')
    writeFileSync(join(root, 'backups', 'izvoz-strank.csv'), 'ime,priimek')
    writeFileSync(join(root, 'backups', 'naključna.txt'), 'x')
    const snap = readSnapshot({ dataDir: root, now: NOW, fs: recordingFs(root) })
    expect(snap.backups.map((b) => b.name)).toEqual(['dnevno-2026-10-20.db'])
    expect(JSON.stringify(snap)).not.toContain('izvoz-strank')
  })

  it('C4 odsotna mapa kopij ni napaka, ampak javljeno prazno stanje', () => {
    const root = tempDir()
    const snap = readSnapshot({ dataDir: root, now: NOW, fs: recordingFs(root) })
    expect(snap.backups).toEqual([])
    expect(snap.warnings.join(' ')).toContain('kopij')
  })

  it('C5 collectSecretValues prebere config.json in vrne samo vrednosti', () => {
    const root = tempDir()
    writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, appSecret: APP_SECRET, pinLookupSalt: PIN_SALT, cronSecret: CRON_SECRET, createdAt: '2026-10-20T00:00:00.000Z' }))
    const values = collectSecretValues(root)
    expect(values).toContain(APP_SECRET)
    expect(values).toContain(PIN_SALT)
    expect(values).toContain(CRON_SECRET)
    expect(values.join(' ')).not.toContain('createdAt')
  })

  it('C6 odsoten config.json javi opozorilo in ne vrže', () => {
    const root = tempDir()
    expect(() => collectSecretValues(root)).not.toThrow()
    expect(collectSecretValues(root)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §D — sestava paketa
// ─────────────────────────────────────────────────────────────────────────────

describe('v181 §D buildBundle', () => {
  it('D1 paket je sestavljen iz šestih datotek', () => {
    const b = buildBundle(baseInput())
    expect(Object.keys(b.files).sort()).toEqual(['README.txt', 'stanje.json', 'okolje.json', 'kopije.json', 'dnevnik.log', 'manifest.json'].sort())
    expect(Object.keys(b.files).length).toBe(6)
  })

  it('D2 manifest nosi različico, način in pogon ter število redaktur', () => {
    const b = buildBundle(baseInput())
    const m = JSON.parse(b.files['manifest.json'])
    expect(m.appVersion).toBe('1.181.0')
    expect(m.mode).toBe('local')
    expect(m.databaseEngine).toBe('sqlite')
    expect(m.generatedAt).toBe('2026-10-26T07:00:00.000Z')
    expect(typeof m.redactions).toBe('number')
    expect(m.files).toEqual(Object.keys(b.files).sort())
  })

  it('D3 README pojasnjuje, kaj je v paketu in kaj ne', () => {
    const readme = buildBundle(baseInput()).files['README.txt']
    expect(readme).toContain('config.json')
    expect(readme).toContain('PRVIC-ZAGON.txt')
    expect(readme).toContain('baze')
    expect(readme).toContain('Podpora')
  })

  it('D4 številke redov so povzetek in ne vrstic (nikoli celic)', () => {
    const b = buildBundle(baseInput())
    const s = JSON.parse(b.files['stanje.json'])
    expect(s.counts).toEqual({ Location: 1, Order: 42 })
    expect(s.stranke).toBeUndefined()
  })

  it('D5 diagnostika sheme ostane razvrščena, surovo sporočilo izjeme ne', () => {
    const s = JSON.parse(buildBundle(baseInput()).files['stanje.json'])
    expect(s.health.schema).toBe('drift')
    expect(s.health.dbError.code).toBe('P2021')
    expect(s.health.dbError.hint).toBe('Manjka tabela.')
  })

  it('D6 trajnost in kopija sta v paketu, kopija sama ne', () => {
    const b = buildBundle(baseInput())
    const s = JSON.parse(b.files['stanje.json'])
    expect(s.durability.journalMode).toBe('wal')
    const k = JSON.parse(b.files['kopije.json'])
    expect(k.backups[0].sizeBytes).toBe(245760)
    expect(k.backups[0].ageDays).toBe(1)
    expect(Object.keys(k.backups[0]).sort()).toEqual(['ageDays', 'name', 'sizeBytes'])
  })

  it('D7 brez zdravstva ni izjeme — polje se izpusti, opozorilo ostane', () => {
    const b = buildBundle(baseInput({ health: null, warnings: ['zdravstvo ni na voljo'] }))
    const s = JSON.parse(b.files['stanje.json'])
    expect(s.health).toBeUndefined()
    const m = JSON.parse(b.files['manifest.json'])
    expect(m.warnings.join(' ')).toContain('zdravstvo')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §E — varnostna trditev s pozitivno kontrolo
// ─────────────────────────────────────────────────────────────────────────────

describe('v181 §E paket je dokazano brez skrivnosti', () => {
  const vloga = [
    `2026-10-26T06:00:00.000Z [prijava] (P2002): sol ${PIN_SALT} in secret ${APP_SECRET}`,
    `2026-10-26T06:01:00.000Z [cron] Bearer ${CRON_SECRET} zavrnjen`,
    `2026-10-26T06:02:00.000Z [seed] C:\\Users\\robert\\Desktop\\izvoz.txt`,
  ].join('\n')

  it('E1 POZITIVNA KONTROLA: surov vhod skrivnosti VSEBUJE (sicer E2 ne trdi nič)', () => {
    for (const s of SECRETS) expect(vloga).toContain(s)
    expect(vloga).toContain('C:\\Users\\robert')
  })

  it('E2 paket ne vsebuje nobene skrivnosti, čeprav je bila v dnevniku', () => {
    const b = buildBundle(baseInput({ logs: [vloga] }))
    const vse = Object.values(b.files).join('\n')
    for (const s of SECRETS) expect(vse).not.toContain(s)
    expect(vse).not.toContain('C:\\Users\\robert')
    expect(vse).toContain(SECRET_PLACEHOLDER)
    expect(vse).toContain(HOME_PLACEHOLDER)
  })

  it('E3 redakture so štete in javljene v manifestu', () => {
    const b = buildBundle(baseInput({ logs: [vloga] }))
    const m = JSON.parse(b.files['manifest.json'])
    expect(m.redactions).toBeGreaterThanOrEqual(4)
    expect(b.redactions).toBe(m.redactions)
  })

  it('E4 assertBundleClean spravi pravi paket', () => {
    const b = buildBundle(baseInput({ logs: [vloga] }))
    expect(() => assertBundleClean(b.files, SECRETS)).not.toThrow()
  })

  it('E5 assertBundleClean javi ranjeni paket (mutacija, ne tiho) in ime datoteke', () => {
    const umazen: Record<string, string> = { ...buildBundle(baseInput()).files, 'dnevnik.log': `slabo ${APP_SECRET}` }
    let msg = ''
    try {
      assertBundleClean(umazen, SECRETS)
    } catch (err) {
      msg = (err as Error).message
    }
    expect(msg).toContain('dnevnik.log')
    expect(msg).toContain(APP_SECRET.slice(0, 6))
  })

  it('E6 writeBundle zapiše na disk in zapisano tudi pregleda', () => {
    const root = tempDir()
    const b = buildBundle(baseInput({ logs: [vloga] }))
    const res = writeBundle({ dataDir: root, now: NOW, bundle: b })
    expect(res.dir).toBe(join(root, BUNDLE_SUBDIR, '2026-10-26T07-00-00-000Z'))
    expect(readdirSync(res.dir).sort()).toEqual(Object.keys(b.files).sort())
    expect(() => assertBundleClean(res.files, SECRETS)).not.toThrow()
    expect(res.files['dnevnik.log']).toContain(SECRET_PLACEHOLDER)
  })

  it('E7 drugi zagon v isto minuto ne prepise prvega (tisk v ime)', () => {
    const root = tempDir()
    const b = buildBundle(baseInput())
    const a = writeBundle({ dataDir: root, now: NOW, bundle: b })
    const c = writeBundle({ dataDir: root, now: day('2026-10-26T07:00:00.001Z'), bundle: b })
    expect(c.dir).not.toBe(a.dir)
    expect(readdirSync(join(root, BUNDLE_SUBDIR)).length).toBe(2)
  })

  it('E8 writeBundle ni pisal v mapo repozitorija, če mu je podana', () => {
    const root = tempDir()
    const repozitorij = join(root, 'ros')
    mkdirSync(repozitorij, { recursive: true })
    const b = buildBundle(baseInput())
    const res = writeBundle({ dataDir: root, now: NOW, bundle: b })
    expect(res.dir.startsWith(repozitorij)).toBe(false)
    expect(readdirSync(repozitorij)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §F — vezava v obstoječo pot napak
// ─────────────────────────────────────────────────────────────────────────────

describe('v181 §F logDbError piše v dnevnik samo v lokalnem načinu', () => {
  it('F1 lokalni način: napaka pade v datoteko in v console.error', async () => {
    const root = tempDir()
    const { logDbError } = await import('../src/lib/db-error')
    const pred = process.env.RESTAURANTOS_LOCAL
    const predDir = process.env.RESTAURANTOS_DATA_DIR
    process.env.RESTAURANTOS_LOCAL = '1'
    process.env.RESTAURANTOS_DATA_DIR = root
    try {
      logDbError('v181 test F1', new Error('namerna napaka P1000'), NOW)
      const tail = tailErrorLog(root, 10, NOW)
      expect(tail.lines.join('\n')).toContain('v181 test F1')
      expect(tail.lines.join('\n')).toContain('namerna napaka P1000')
    } finally {
      if (pred === undefined) delete process.env.RESTAURANTOS_LOCAL
      else process.env.RESTAURANTOS_LOCAL = pred
      if (predDir === undefined) delete process.env.RESTAURANTOS_DATA_DIR
      else process.env.RESTAURANTOS_DATA_DIR = predDir
    }
  })

  it('F2 oblak: nobene datoteke ne ustvari (nikoli ne piši na disk produkcije)', async () => {
    const root = tempDir()
    const { logDbError } = await import('../src/lib/db-error')
    const pred = process.env.RESTAURANTOS_LOCAL
    const predDir = process.env.RESTAURANTOS_DATA_DIR
    delete process.env.RESTAURANTOS_LOCAL
    process.env.RESTAURANTOS_DATA_DIR = root
    try {
      logDbError('v181 test F2', new Error('oblak'), NOW)
      expect(existsSync(join(root, LOCAL_LOG_SUBDIR))).toBe(false)
    } finally {
      if (pred === undefined) delete process.env.RESTAURANTOS_LOCAL
      else process.env.RESTAURANTOS_LOCAL = pred
      if (predDir === undefined) delete process.env.RESTAURANTOS_DATA_DIR
      else process.env.RESTAURANTOS_DATA_DIR = predDir
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §G — konstante, ki jih obljublja PRD
// ─────────────────────────────────────────────────────────────────────────────
describe('v181 §G pinline', () => {
  it('G1 zapisnik ne preraste: 7 dni, 3 datoteke na dan, 1 MiB na datoteko', () => {
    expect(LOCAL_MAX_LOG_DAYS).toBe(7)
    expect(LOCAL_MAX_LOG_FILES_PER_DAY).toBe(3)
    expect(LOCAL_MAX_LOG_BYTES).toBe(1048576)
  })

  it('G2 oznaki sta prepoznavni in ne spominjata na pravo vrednost', () => {
    expect(SECRET_PLACEHOLDER).toBe('[RAZMAZKANO]')
    expect(HOME_PLACEHOLDER).toBe('~')
  })

  it('G3 dokumenta imenujeta PRAVO predpono datoteke dnevnika', () => {
    // Merjeno živo 2026-10-26: `appendErrorLog` na disku ustvari
    // `logs/errors-<UTC-dan>.log`. Runbook in PRD sta bila prva napisana z
    // domišljijskim `dnevnik-` — bralec, ki po dokumentu išče datoteko, je ne
    // najde. Pin veže besedilo dokumentov na konstanto v kodi, da naslednji
    // prepis imena ne more ostati neopažen.
    const koren = join(import.meta.dir, '..')
    expect(LOCAL_LOG_PREFIX).toBe('errors-')
    for (const rel of ['docs/LOKALNI-ZAGON.md', 'docs/PRD-LOKALNA-BAZA.md']) {
      const text = readFileSync(join(koren, rel), 'utf8')
      expect(text).toContain(`logs/${LOCAL_LOG_PREFIX}`)
      expect(text).not.toContain('logs/dnevnik-')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §H — števci rel: povzetek brez vsebine in brez vstavljene SQL
// ─────────────────────────────────────────────────────────────────────────────

describe('v181 §H countTables', () => {
  function baza(tables: string[]): string {
    const file = join(tempDir(), 'restaurantos.db')
    const db = new DatabaseSync(file)
    for (const t of tables) db.exec(t)
    db.close()
    return file
  }

  it('H1 prešteje navadne tabele in preskoči notranje', () => {
    const file = baza([
      'CREATE TABLE "Location" (id TEXT PRIMARY KEY)',
      'INSERT INTO "Location" (id) VALUES (\'a\'), (\'b\')',
      'CREATE TABLE "Order" (id TEXT PRIMARY KEY)',
      'INSERT INTO "Order" (id) VALUES (\'x\')',
    ])
    const res = countTables(file)
    expect(res.error).toBeUndefined()
    expect(res.counts.Location).toBe(2)
    expect(res.counts.Order).toBe(1)
    expect(Object.keys(res.counts).every((k) => !k.startsWith('sqlite_'))).toBe(true)
  })

  it('H2 ime, ki ni navaden identifikator, je preskočeno in NE gre v SQL', () => {
    const file = baza(['CREATE TABLE "na red!x" (id INTEGER)', 'CREATE TABLE "Location" (id TEXT PRIMARY KEY)'])
    const res = countTables(file)
    expect(res.skipped).toEqual(['na red!x'])
    expect(res.counts.Location).toBe(0)
    expect(res.counts['na red!x']).toBeUndefined()
  })

  it('H3 odsotna baza javi razlog in ne vrže', () => {
    const res = countTables(join(tempDir(), 'ni-baze.db'))
    expect(Object.keys(res.counts)).toEqual([])
    expect(res.skipped).toEqual([])
    expect(res.error).toBeTruthy()
  })

  it('H4 notranja tabela dejansko obstaja in NE pride v števce', () => {
    // H1 je trdil, da notranje tabele padejo ven, a v njegovi bazi nobena notranja
    // tabela ni niti obstala (brez AUTOINCREMENT ni `sqlite_sequence`) — mutacija,
    // ki izbriše filter, je zato preživela. Tu je ista trditev opremljena s
    // pozitivno kontrolo: najprej DOKAŽEMO, da tabela v datoteki je.
    const file = baza([
      'CREATE TABLE "Kdor" (id INTEGER PRIMARY KEY AUTOINCREMENT, ime TEXT)',
      "INSERT INTO \"Kdor\" (ime) VALUES ('Ana')",
    ])
    const db = new DatabaseSync(file, { readOnly: true })
    const notranje = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sqlite_%'").all() as { name: string }[]
    ).map((r) => r.name)
    db.close()
    sprostiRočaje()
    expect(notranje).toContain('sqlite_sequence')
    const res = countTables(file)
    expect(res.error).toBeUndefined()
    expect(res.counts.Kdor).toBe(1)
    expect(res.counts.sqlite_sequence).toBeUndefined()
    expect(Object.keys(res.counts)).toEqual(['Kdor'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §I — `bun run local:support`: paket se sestavi iz PRAVE podatkovne mape
//
// Ostali oddelki testirajo knjižnico. Ta oddelek zažene ukaz kot ga bo zagnal
// lastnik: prava mapa, pravi `config.json`, prava SQLite datoteka, pravi
// podproces. Edini dokaz, da je paket v resnici varen za pošiljanje, je meritev
// na izhodu procesa.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = join(import.meta.dir, '..')
const SCRIPT = join(REPO, 'scripts', 'local-support.ts')
const SIX = ['README.txt', 'dnevnik.log', 'kopije.json', 'manifest.json', 'okolje.json', 'stanje.json']
const MARKER_PIN = 'PIN: 730915'
const TLS_SENTINEL = 'ZIPOBNI-KLJUC-NE-SME-V-PAKET'
const ROW_SENTINEL = 'ROJEN-VD-STRANKE'

interface CliOut {
  code: number
  stdout: string
  stderr: string
}

function runCli(dataDir: string, flags: string[] = []): CliOut {
  // Pod bunom zaprt ročaj `DatabaseSync` še drži datoteko, otrok pa jo odpira.
  sprostiRočaje()
  const env = { ...process.env }
  delete env.RESTAURANTOS_DATA_DIR
  const got = spawnSync(process.execPath, [SCRIPT, '--data-dir', dataDir, '--json', ...flags], {
    cwd: REPO,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  })
  return { code: got.status ?? -1, stdout: got.stdout || '', stderr: got.stderr || '' }
}

/** Zadnja JSON vrstica na stdoutu — opozorila pogona smejo iti pred izpis. */
function lastJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t) as Record<string, unknown>
    } catch {
      // ni JSON — poskusi prejšnjo vrstico
    }
  }
  return null
}

function makeDataDir(withDb = true, wal = true): string {
  const dataDir = tempDir('ros-v181-cli-')
  mkdirSync(join(dataDir, 'data'), { recursive: true, mode: 0o700 })
  mkdirSync(join(dataDir, 'tls'), { recursive: true, mode: 0o700 })
  mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 })
  // Prava oblika: trije skrivnostni ključi + navaden ključ, ki NE sme v seznam.
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      appSecret: APP_SECRET,
      pinLookupSalt: PIN_SALT,
      cronSecret: CRON_SECRET,
      backupPassword: SHORT_SECRET,
      zadnjiZagon: '2026-10-26T06:55:00.000Z',
    }),
    { mode: 0o600 },
  )
  writeFileSync(join(dataDir, 'PRVIC-ZAGON.txt'), `Prvi zagon RestaurantOS\n${MARKER_PIN}\nSpremeni ga v nastavitvah.\n`, { mode: 0o600 })
  writeFileSync(join(dataDir, 'tls', 'server.key'), `${TLS_SENTINEL}\n`, { mode: 0o600 })
  if (withDb) {
    const file = join(dataDir, 'data', 'restaurantos.db')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE "Location" (id TEXT PRIMARY KEY, name TEXT)')
    db.exec(`INSERT INTO "Location" (id, name) VALUES ('l1', '${ROW_SENTINEL}'), ('l2', 'Druga')`)
    db.exec('CREATE TABLE "Order" (id TEXT PRIMARY KEY)')
    db.exec("INSERT INTO \"Order\" (id) VALUES ('o1')")
    db.close()
    // `bun run local` vsaki zagon nastavi pragme (v1.169.0); brez tega bi test
    // opisoval ročno narejeno bazo, ne tiste, ki jo podpora dejansko najde.
    if (wal) applyDurability(file)
  }
  writeFileSync(join(dataDir, 'backups', 'dnevno-2026-10-25T07-00-00-000Z.db'), 'kopija', { mode: 0o600 })
  // Živa meritev 2026-10-26: ime `dnevno-*` (31 znakov) je ušlo, pravilo z vezajem pa
  // je požrlo dolgi imeni (33 in 36 znakov). Brez obeh §I napake ne vidi.
  writeFileSync(join(dataDir, 'backups', 'pre-push-2026-10-25T07-00-00-000Z.db'), 'kopija', { mode: 0o600 })
  writeFileSync(join(dataDir, 'backups', 'pred-obnovo-2026-10-25T07-00-00-000Z.db'), 'kopija', { mode: 0o600 })
  // Napaka, ki jo je povzročila skrivnost: to je edini realni vir uhajanja v paket.
  appendErrorLog(dataDir, {
    scope: 'CLI §I',
    message: `povzrocilo je ${APP_SECRET} na poti C:\\Users\\robert\\ros\\app.ts`,
    code: 'P2021',
    stack: `Error: ${PIN_SALT}\n  at nowhere (C:\\Users\\robert\\ros\\x)`,
    at: new Date(),
  })
  // Drugi zapis nosi tisto, kar ujamejo SAMO pravila za znani seznam in za Bearer:
  // kratka vrednost je pod mejo LONG_TOKEN, brez nje v viru I13 ne trdi ničesar.
  appendErrorLog(dataDir, {
    scope: 'CLI §I kratka',
    message: `prijava z geslom ${SHORT_SECRET} in glavo Bearer ${SHORT_BEARER} ni uspela`,
    code: 'P1000',
    at: new Date(),
  })
  return dataDir
}

interface Primary {
  dataDir: string
  json: Record<string, unknown>
  bundleDir: string
  files: Record<string, string>
}

let primary: Primary | null = null
function primaryRun(): Primary {
  if (primary) return primary
  const dataDir = makeDataDir()
  const run = runCli(dataDir)
  const json = lastJson(run.stdout)
  if (!json || json.ok !== true) {
    throw new Error(`local:support ni uspel (izhod ${run.code}); stdout=${run.stdout.slice(0, 400)} stderr=${run.stderr.slice(0, 400)}`)
  }
  const bundleDir = String(json.dir)
  const files: Record<string, string> = {}
  for (const name of readdirSync(bundleDir)) files[name] = readFileSync(join(bundleDir, name), 'utf8')
  primary = { dataDir, json, bundleDir, files }
  return primary
}

function manifestOf(p: Primary): Record<string, unknown> {
  return JSON.parse(p.files['manifest.json']) as Record<string, unknown>
}

/** Katera datoteka paketa nosi vrednost — ime v napaki, nikoli vrednost. */
function nosilci(files: Record<string, string>, value: string): string[] {
  return Object.entries(files)
    .filter(([, text]) => text.includes(value))
    .map(([name]) => name)
}

describe('v181 §I lokalni ukaz local:support', () => {
  it('I1 izpiše natanko šest obljubljenih datotek v <dataDir>\\support', () => {
    const p = primaryRun()
    expect(Object.keys(p.files).sort()).toEqual(SIX)
    expect((p.json.files as string[]).sort()).toEqual(SIX)
    expect(p.bundleDir.startsWith(join(p.dataDir, 'support'))).toBe(true)
  })

  it('I2 paket ne pristane v mapi repozitorija', () => {
    primaryRun()
    expect(existsSync(join(REPO, 'support'))).toBe(false)
    expect(existsSync(join(REPO, 'manifest.json'))).toBe(false)
  })

  it('I3 pozitivna kontrola: skrivnost je bila V VIRU, je pa NI v paketu', () => {
    const p = primaryRun()
    expect(readFileSync(join(p.dataDir, 'config.json'), 'utf8')).toContain(APP_SECRET)
    const logsDir = logsDirFor(p.dataDir)
    const surovo = readdirSync(logsDir)
      .map((n) => readFileSync(join(logsDir, n), 'utf8'))
      .join('\n')
    expect(surovo).toContain(APP_SECRET)
    for (const value of SECRETS) expect(nosilci(p.files, value)).toEqual([])
    expect(Number(p.json.redactions)).toBeGreaterThanOrEqual(SECRETS.length)
    expect(p.files['dnevnik.log']).toContain(SECRET_PLACEHOLDER)
  })

  it('I4 marker, TLS ključ in vrstica tabele ne pridejo v paket', () => {
    const p = primaryRun()
    expect(nosilci(p.files, MARKER_PIN)).toEqual([])
    expect(nosilci(p.files, TLS_SENTINEL)).toEqual([])
    expect(nosilci(p.files, ROW_SENTINEL)).toEqual([])
  })

  it('I5 stanje.json nosi prave števce in sondo, ne pa vsebine', () => {
    const p = primaryRun()
    const stanje = JSON.parse(p.files['stanje.json']) as {
      counts: Record<string, number>
      health: { database: string; schema: string }
      durability: { journalMode: string; configuredBusyTimeoutMs: number; configuredSynchronous: string }
    }
    expect(stanje.counts.Location).toBe(2)
    expect(stanje.counts.Order).toBe(1)
    expect(stanje.health.database).toBe('connected')
    expect(stanje.health.schema).toBe('ok')
    // Trajno dejstvo, izmerjeno iz datoteke: WAL je vklopljen.
    expect(stanje.durability.journalMode).toBe('wal')
    // Pragmi `synchronous` in `busy_timeout` sta VEZ NA POVEZAVO: na novi bralni
    // povezavi se vrneta 2 oziroma 0 (izmerjeno 2026-10-26). Paket sme zato
    // sporočati samo vrednost, KI JO APLIKACIJA NASTAVI, ne izmišljenega "stanja".
    expect(stanje.durability.configuredBusyTimeoutMs).toBe(LOCAL_BUSY_TIMEOUT_MS)
    expect(stanje.durability.configuredSynchronous).toBe(LOCAL_SYNCHRONOUS)
    expect(manifestOf(p).appVersion).toBe(APP_VERSION)
  })

  it('I5b baza brez WAL-a: paket javi opozorilo, ki ga podpora potrebuje', () => {
    const run = runCli(makeDataDir(true, false))
    const json = lastJson(run.stdout)
    expect(json?.ok).toBe(true)
    const warnings = String((json?.warnings as string[] | undefined)?.join(' '))
    expect(/wal/i.test(warnings)).toBe(true)
  })

  it('I6 --help obljubi, da se umazan paket zbriše', () => {
    const run = runCli(makeDataDir(), ['--help'])
    expect(run.code).toBe(0)
    expect(run.stdout.replace(/\s+/g, ' ')).toMatch(/izbri/i)
  })

  it('I7 neznana možnost konča z izhodno kodo 2 in ne sestavi paketa', () => {
    const dataDir = makeDataDir()
    const run = runCli(dataDir, ['--vse'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Neznana možnost')
    expect(existsSync(join(dataDir, 'support'))).toBe(false)
  })

  it('I8 pokvarjena baza: paket se vseeno sestavi in javi razlog', () => {
    const dataDir = makeDataDir(false)
    rmSync(join(dataDir, 'data'), { recursive: true, force: true })
    const run = runCli(dataDir)
    const json = lastJson(run.stdout)
    expect(run.code).toBe(0)
    expect(json?.ok).toBe(true)
    const warnings = String((json?.warnings as string[] | undefined)?.join(' '))
    expect(/baz/i.test(warnings)).toBe(true)
    const bundleDir = String(json?.dir)
    const files: Record<string, string> = {}
    for (const name of readdirSync(bundleDir)) files[name] = readFileSync(join(bundleDir, name), 'utf8')
    expect(Object.keys(files).sort()).toEqual(SIX)
    for (const value of SECRETS) expect(nosilci(files, value)).toEqual([])
    const stanje = JSON.parse(files['stanje.json']) as { counts: Record<string, number>; health: { database: string } }
    expect(stanje.health.database).toBe('disconnected')
    expect(stanje.counts).toEqual({})
  })

  it('I9 ukaz je ponujen prek `bun run local:support`', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['local:support']).toBe('bun scripts/local-support.ts')
  })

  it('I10 kopije.json na izhodu procesa ohrani vsa tri imena kopij', () => {
    // B7 meri knjižnico; ta meri IZHOD UKAZA, kjer se sestanejo JSON, redaktura in
    // disk. Na živi namestitvi 2026-10-26 je prav tukaj manjkalo 4 od 6 imen.
    const k = JSON.parse(primaryRun().files['kopije.json']) as { backups: { name: string }[] }
    expect(k.backups.map((b) => b.name).sort()).toEqual([
      'dnevno-2026-10-25T07-00-00-000Z.db',
      'pre-push-2026-10-25T07-00-00-000Z.db',
      'pred-obnovo-2026-10-25T07-00-00-000Z.db',
    ])
    expect(k.backups.some((b) => b.name.includes(SECRET_PLACEHOLDER))).toBe(false)
  })

  it('I11 ukaz ne spremeni vsebine baze in ne piše izven podatkovne mapi', () => {
    // Meritev 2026-10-26 (node 24 in bun 1.4.3, Windows): branje WAL baze vedno
    // ustvari `-wal` in `-shm` ter ju pusti na disku — enako pri `readOnly: true`
    // in `readOnly: false`. Na tej platformi torej NI opazne razlike med obema
    // odpiranjema in M10 ostane NEZAJETO. Kar JE opazno in kar podpora obljublja:
    // žig baze se ne spremeni, zunaj `support` pa ne nastane nobena datoteka.
    const dataDir = makeDataDir()
    const dbFile = join(dataDir, 'data', 'restaurantos.db')
    const predZig = createHash('sha256').update(readFileSync(dbFile)).digest('hex')
    const run = runCli(dataDir)
    expect(run.code).toBe(0)
    expect(createHash('sha256').update(readFileSync(dbFile)).digest('hex')).toBe(predZig)
    const dovoljene = ['backups', 'config.json', 'data', 'logs', 'PRVIC-ZAGON.txt', 'support', 'tls']
    expect(readdirSync(dataDir).filter((n) => !dovoljene.includes(n))).toEqual([])
    expect(readdirSync(join(dataDir, 'data')).filter((n) => !/^restaurantos\.db(-wal|-shm)?$/.test(n))).toEqual([])
  })

  it('I12 manifest na živi poti javi LOKALNI profil in SQLite pogon', () => {
    // `bun` samodejno naloži `.env`; če bi ukaz bral `DATABASE_URL`, bi lahko
    // javil oblak medtem ko bere lokalno datoteko. Način je zato zapisan neposredno.
    const m = JSON.parse(primaryRun().files['manifest.json']) as { mode: string; databaseEngine: string; commit: string }
    expect(m.mode).toBe('local')
    expect(m.databaseEngine).toBe('sqlite')
    expect(typeof m.commit).toBe('string')
    expect(m.commit.length).toBeGreaterThan(0)
  })

  it('I13 na izhodu procesa padeta tudi kratka znana vrednost in Bearer žeton', () => {
    // B8/B9 merita knjižnico. Tu meri SAM seznam, ki ga ukaz naredi iz pravega
    // `config.json`: če ga ne bi, bi ukaz maskiral samo dolge žetone (LONG_TOKEN)
    // in bi `backupPassword` šel na pošto. Zato je v viru zapis, ki nosi OBOJE.
    const p = primaryRun()
    const logsDir = logsDirFor(p.dataDir)
    const surovo = readdirSync(logsDir)
      .map((n) => readFileSync(join(logsDir, n), 'utf8'))
      .join('\n')
    expect(readFileSync(join(p.dataDir, 'config.json'), 'utf8')).toContain(SHORT_SECRET)
    expect(surovo).toContain(SHORT_SECRET)
    expect(surovo).toContain(SHORT_BEARER)
    expect(nosilci(p.files, SHORT_SECRET)).toEqual([])
    expect(nosilci(p.files, SHORT_BEARER)).toEqual([])
    expect(p.files['dnevnik.log']).toContain(`Bearer ${SECRET_PLACEHOLDER}`)
  })

  it('I14 podpora sme bazo odpreti samo bralno (pin na vir, ne na vedenje)', () => {
    // Izmerjeno 2026-10-26: podpora NE more ujeti mutacije `readOnly: false` z
    // vedenjskim preizkusom — branje WAL baze ustvari `-wal` in `-shm` pri obeh
    // odpiranjih, `chmodSync(0o444)` pa SQLiteja na Windows ne ustavi (obe odpiranj
    // sta uspeli, žig datoteke se ni spremenil). Kar JE dokazljivo: pogodoba je
    // zapisana v viru in pisanja v bazo ni; pin zato opozori, če jo kdo odstrani.
    const vir = readFileSync(SCRIPT, 'utf8')
    expect(vir).toContain('{ readOnly: true }')
    expect(vir).not.toContain('{ readOnly: false }')
    expect(vir.match(/new DatabaseSync\(/g)).toHaveLength(1)
  })
})
