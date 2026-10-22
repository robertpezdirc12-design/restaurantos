/**
 * v1.169.0 — lokalna baza mora preživeti izpad elektrike in pokvarjen disk
 * (PRD docs/PRD-LOKALNA-BAZA.md, R2: WAL + busy timeout, dnevna kopija z
 * integritetnim pregledom, obnova).
 *
 * Testi delajo s PRAVIMI SQLite datotekami v začasnih maps, ne z mocki: edini
 * dokaz, kaj velja, je vsebina kopije po realnem zapisu.
 *
 * Meritve, ki so rodile te teste (Prisma 6.19.2 + bun 1.4.3, Windows):
 *  - sveža baza, odprta samo čez Prizmin pogon: `journal_mode = delete`, torej
 *    WAL se SAM ne vklopi;
 *  - `synchronous = 2` (FULL) in `busy_timeout = 5000` sta privzeta vrednost
 *    pogona, ne naša — zato ju test pinline, da ju nadgradnja tiho ne spremeni;
 *  - URL parametri (`?busy_timeout=`) Prizmin SQLite pogon PREZRE: vedno vrne
 *    5000, torej pragmov ne nastavljamo čez `DATABASE_URL`;
 *  - `copyFileSync` nad bazo z neprečiščenim WAL vrne 2 od 3 vrstic: zadnji
 *    potrjeni transakciji v kopiji NI.
 *  - `VACUUM INTO` vrne vse tri vrstice, tudi kadar je pisec še odprt, in zapiše
 *    ENO samo datoteko. Online Backup API (`backup()`) je sicer pravilen, a na
 *    Windows pusti ciljno datoteko zaklenjeno (EBUSY pri `renameSync`/`rmSync`),
 *    zato ne more služiti zadrževanju. Mehanizem je `VACUUM INTO`.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LOCAL_BUSY_TIMEOUT_MS,
  LOCAL_DAILY_BACKUP_PREFIX,
  LOCAL_MAX_DAILY_BACKUPS,
  LOCAL_PRE_PUSH_BACKUP_PREFIX,
  LOCAL_PRE_RESTORE_PREFIX,
  applyDurability,
  backupDatabase,
  drainWal,
  isDatabaseInUse,
  listBackups,
  openDurabilityDatabase,
  readDurabilityState,
  restoreDatabase,
  verifyBackup,
} from '../src/lib/local-durability'

const tmpDirs: string[] = []
const openHandles = new Set<DatabaseSync>()

function tempDir(prefix = 'ros-v169-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

function handle(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  openHandles.add(db)
  return db
}

/**
 * Pod bunom `close()` ročaja takoj ne sprosti: izmerjeno 2026-10-22 je `-wal`
 * z vsebino preživel zaprtje, naslednji `rename` pa je javil EPERM, dokler
 * tekač ni pobral objekta. Vsaka branja v testu morajo zato potegniti GC.
 */
function sprosti(): void {
  ;(globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }).Bun?.gc?.(true)
}

function closeHandle(db: DatabaseSync): void {
  db.close()
  openHandles.delete(db)
  sprosti()
}

function remove(p: string): void {
  rmSync(p, { force: true })
}

afterAll(() => {
  for (const db of openHandles) {
    try {
      db.close()
    } catch {
      /* že zaprta */
    }
  }
  openHandles.clear()
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* začasna mapa; Windows jo počisti sam */
    }
  }
})

const NOW = new Date('2026-10-22T06:00:00Z')

/** Baza z eno tabelo, ki služi kot števec morebiti izgubljenih vrstic. */
function seedDb(dbPath: string, rows: string[] = ['nova']): DatabaseSync {
  const db = handle(dbPath)
  db.exec('CREATE TABLE IF NOT EXISTS order_row(id INTEGER PRIMARY KEY, code TEXT)')
  for (const code of rows) db.prepare('INSERT INTO order_row(code) VALUES (?)').run(code)
  return db
}

/** Odpre bazo, vklopi WAL in ustavi samodejno čiščenje, da WAL ostane poln. */
function openWithDirtyWal(dbPath: string, code: string): DatabaseSync {
  const db = handle(dbPath)
  db.exec('PRAGMA journal_mode=wal')
  db.exec('PRAGMA wal_autocheckpoint=0')
  db.exec('CREATE TABLE IF NOT EXISTS order_row(id INTEGER PRIMARY KEY, code TEXT)')
  db.prepare('INSERT INTO order_row(code) VALUES (?)').run(code)
  return db
}

/**
 * Resničen postanek: otrok odpre bazo, zapiše in umre. Izmerjeno 2026-10-22
 * (Windows, bun 1.4.3) `-wal` tako umre NEPOZIDAN (12392 B) in ga navaden
 * odpri-zapri naknadni proces ne počisti. To je stanje, v katerem operator
 * pripravlja obnovo — aplikacije ni več, rep pa je poln.
 */
function writeFromExitedProcess(dbPath: string, code: string): void {
  const src = [
    "const { DatabaseSync } = require('node:sqlite')",
    `const db = new DatabaseSync(${JSON.stringify(dbPath)})`,
    "db.exec('PRAGMA journal_mode=wal')",
    "db.exec('CREATE TABLE IF NOT EXISTS order_row(id INTEGER PRIMARY KEY, code TEXT)')",
    `db.prepare('INSERT INTO order_row(code) VALUES (?)').run(${JSON.stringify(code)})`,
    'db.close()',
  ].join('\n')
  const run = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`[test] otrok ni zapisal: ${run.stderr.slice(0, 120)}`)
}

function countRows(dbPath: string): number | string {
  try {
    const db = new DatabaseSync(dbPath)
    try {
      return Number(db.prepare('SELECT count(*) AS n FROM order_row').get().n)
    } finally {
      db.close()
      sprosti()
    }
  } catch (err) {
    return `ERR ${(err as Error).message.slice(0, 60)}`
  }
}

function integrity(dbPath: string): string {
  const db = new DatabaseSync(dbPath)
  try {
    return String(db.prepare('PRAGMA integrity_check').get().integrity_check)
  } finally {
    db.close()
    sprosti()
  }
}

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/**
 * Baza, ki se ODPRE normalno, a je vsebinsko pokvarjena — ravno ta razred okvare
 * loči `integrity_check` od preprostega odpovednega odpiranja. Izmerjeno
 * 22. 10. 2026: izničenje celotne podatkovne strani vrne vrstico
 * `Fragmentation of 3349 bytes reported as 0 on page 9`, lažno število celic pa
 * `Tree 3 page 9: btreeInitPage() returns error code 11`. Oboje je VREDNOST, ne
 * izjema, zato ga mora zaslediti koda; pogon sam je ne javi.
 */
function makeOpenableButCorrupt(dbPath: string): void {
  const db = handle(dbPath)
  db.exec('CREATE TABLE order_row(id INTEGER PRIMARY KEY, code TEXT)')
  for (let i = 0; i < 120; i++) db.prepare('INSERT INTO order_row(code) VALUES (?)').run(`STRAN-${i}-${'x'.repeat(60)}`)
  closeHandle(db)
  const dat = readFileSync(dbPath)
  const zacetekStrane = Math.floor(dat.indexOf('STRAN-60-') / 4096) * 4096
  dat.writeUInt16BE(0x7fff, zacetekStrane + 3)
  writeFileSync(dbPath, dat)
}

describe('v1.169.0 — lokalna baza teče v WAL načinu', () => {
  it('sveža baza je v delete načinu; applyDurability jo prestavi na wal', async () => {
    const dbPath = join(tempDir(), 'restaurantos.db')
    const db = seedDb(dbPath)
    expect(readDurabilityState(db).journalMode).toBe('delete')
    closeHandle(db)

    const state = applyDurability(dbPath)
    expect(state.journalMode).toBe('wal')
    expect(state.synchronous).toBe(2)
    expect(state.busyTimeout).toBeGreaterThan(0)
  })

  it('WAL ostane v datoteki, zato ga dobi tudi naslednja (Prizmina) povezava', async () => {
    const dbPath = join(tempDir(), 'restaurantos.db')
    closeHandle(seedDb(dbPath))

    applyDurability(dbPath)
    const reopened = handle(dbPath)
    expect(readDurabilityState(reopened).journalMode).toBe('wal')
  })

  it('busy_timeout in synchronous sta izmerjena vrednost pogona, ne izmišljena', async () => {
    expect(LOCAL_BUSY_TIMEOUT_MS).toBe(5000)
    const dbPath = join(tempDir(), 'restaurantos.db')
    const db = openDurabilityDatabase(dbPath)
    try {
      expect(readDurabilityState(db).busyTimeout).toBe(LOCAL_BUSY_TIMEOUT_MS)
      expect(readDurabilityState(db).synchronous).toBe(2)
    } finally {
      db.close()
      openHandles.delete(db)
    }
  })

  it('uporaba pragmov je idempotentna: drugi zagon ne pade in ne podvoji podatkov', async () => {
    const dbPath = join(tempDir(), 'restaurantos.db')
    closeHandle(seedDb(dbPath))

    const prvi = applyDurability(dbPath)
    const drugi = applyDurability(dbPath)
    expect(drugi).toEqual(prvi)
    expect(countRows(dbPath)).toBe(1)
  })

  it('manjkajoče starševske mape ustvari, preden odpre bazo', async () => {
    const dbPath = join(tempDir(), 'globoko', 'pod', 'restaurantos.db')
    expect(applyDurability(dbPath).journalMode).toBe('wal')
  })

  it('NEGATIVNA KONTROLA: po izhodu procesa rep ostane poln, stražar torej laže', async () => {
    const dbPath = join(tempDir(), 'restaurantos.db')
    closeHandle(seedDb(dbPath))
    writeFromExitedProcess(dbPath, 'po-izhodu')

    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)
    expect(isDatabaseInUse(dbPath)).toBe(true)
    expect(countRows(dbPath)).toBe(2)
  })

  it('applyDurability počisti osirotele rep, da obnova ne zavrne zaradi lažne rabe', async () => {
    const dbPath = join(tempDir(), 'restaurantos.db')
    closeHandle(seedDb(dbPath))
    writeFromExitedProcess(dbPath, 'po-izhodu')
    expect(isDatabaseInUse(dbPath)).toBe(true)

    applyDurability(dbPath)

    expect(isDatabaseInUse(dbPath)).toBe(false)
    expect(countRows(dbPath)).toBe(2)
    const reopened = handle(dbPath)
    expect(readDurabilityState(reopened).journalMode).toBe('wal')
    closeHandle(reopened)
  })

  it('drainWal počisti rep in ohrani oba potrjena zapisa', async () => {
    const dbPath = join(tempDir(), 'restaurantos.db')
    closeHandle(seedDb(dbPath))
    writeFromExitedProcess(dbPath, 'po-izhodu')

    drainWal(dbPath)

    expect(existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0).toBe(0)
    expect(countRows(dbPath)).toBe(2)
    expect(integrity(dbPath)).toBe('ok')
  })
})

describe('v1.169.0 — kopija vsebuje zadnji potrjeni zapis', () => {
  it('NEGATIVNA KONTROLA: copyFileSync nad umazanim WAL izgubi zadnjo vrstico', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    closeHandle(seedDb(dbPath))

    const dirty = openWithDirtyWal(dbPath, 'zadnja')
    const plain = join(dir, 'cp.db')
    copyFileSync(dbPath, plain)
    expect(countRows(plain)).toBe(1)
    expect(countRows(dbPath)).toBe(2)
    closeHandle(dirty)
  })

  it('backupDatabase vrne kopijo z vsemi vrsticami tudi ob umazanem WAL', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath))

    const dirty = openWithDirtyWal(dbPath, 'zadnja')
    const result = await backupDatabase(dbPath, backups)
    expect(result.created).toBe(true)
    expect(result.kind).toBe('dnevno')
    expect(result.integrity).toBe('ok')
    expect(existsSync(result.file)).toBe(true)
    expect(countRows(result.file)).toBe(2)
    closeHandle(dirty)
  })

  it('kopija je ena sama datoteka brez -wal/-shm samic, da je prenosna na USB', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath))

    const dirty = openWithDirtyWal(dbPath, 'zadnja')
    const result = await backupDatabase(dbPath, backups)
    closeHandle(dirty)

    expect(existsSync(`${result.file}-wal`)).toBe(false)
    expect(existsSync(`${result.file}-shm`)).toBe(false)
    expect(readdirSync(backups)).toEqual([basename(result.file)])
  })

  it('verifyBackup zavrne datoteko, ki ni baza, in v sporočilu imenuje integrity_check', async () => {
    const dir = tempDir()
    const garbage = join(dir, 'smeti.db')
    writeFileSync(garbage, 'to ni SQLite datoteka, ampak navaden tekst, ki ga SQLite zavrne'.repeat(20))
    let message = ''
    try {
      verifyBackup(garbage)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('integrity_check')
  })

  it('manjkajoča baza: kopija se ne naredi, sporočilo imenuje bazo, mapa ne nastane', async () => {
    const dir = tempDir()
    let message = ''
    try {
      await backupDatabase(join(dir, 'restaurantos.db'), join(dir, 'backups'))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/baze/i)
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('baza, ki ni veljavna SQLite datoteka: nobena kopija ne ostane', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    writeFileSync(dbPath, 'to ni SQLite datoteka'.repeat(40))
    let thrown = false
    try {
      await backupDatabase(dbPath, backups)
    } catch {
      thrown = true
    }
    expect(thrown).toBe(true)
    expect(listBackups(backups, LOCAL_DAILY_BACKUP_PREFIX)).toEqual([])
  })

  it('verifyBackup zavrne odprljivo a pokvarjeno bazo, ne samo datotek, ki jih pogon ne odpre', async () => {
    const dir = tempDir()
    const pokvarjena = join(dir, 'pokvarjena.db')
    makeOpenableButCorrupt(pokvarjena)
    // Predpostavka, brez katere test ne pomeni ničesar: datoteka se odpre in
    // pregled vrne VREDNOST, ki ni `ok` (ne izjeme).
    expect(integrity(pokvarjena)).not.toBe('ok')
    let message = ''
    try {
      verifyBackup(pokvarjena)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('integrity_check')
    // Dokaz, da je zavrnitev prišla iz pregleda in ne iz odpovedi odpiranja.
    expect(message).toMatch(/vrnil /)
  })

  it('kopija je realna baza in ne prazna datoteka', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    closeHandle(seedDb(dbPath))
    const result = await backupDatabase(dbPath, join(dir, 'backups'))
    expect(result.pageCount).toBeGreaterThan(0)
    expect(statSync(result.file).size).toBeGreaterThan(0)
  })
})

describe('v1.169.0 — dnevno kopiranje in zadrževanje', () => {
  it('isti dan ustvari eno samo dnevno kopijo, kljub ponovnim zagonom', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath))

    const prvi = await backupDatabase(dbPath, backups, { now: new Date('2026-10-22T06:00:00Z') })
    const drugi = await backupDatabase(dbPath, backups, { now: new Date('2026-10-22T18:30:00Z') })
    expect(drugi.created).toBe(false)
    expect(drugi.file).toBe(prvi.file)
    expect(listBackups(backups, LOCAL_DAILY_BACKUP_PREFIX)).toHaveLength(1)
  })

  it('naslednji dan ustvari novo kopijo z datumom v imenu', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath))

    await backupDatabase(dbPath, backups, { now: new Date('2026-10-22T06:00:00Z') })
    const drugi = await backupDatabase(dbPath, backups, { now: new Date('2026-10-23T06:00:00Z') })
    expect(drugi.created).toBe(true)
    expect(basename(drugi.file)).toContain(`${LOCAL_DAILY_BACKUP_PREFIX}2026-10-23`)
    expect(listBackups(backups, LOCAL_DAILY_BACKUP_PREFIX)).toHaveLength(2)
  })

  it('zadrži natanko LOCAL_MAX_DAILY_BACKUPS najnovejših, starejše izbriše', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath))

    const files: string[] = []
    const totalDays = LOCAL_MAX_DAILY_BACKUPS + 3
    for (let day = 1; day <= totalDays; day++) {
      const d = day < 10 ? `0${day}` : String(day)
      files.push((await backupDatabase(dbPath, backups, { now: new Date(`2026-09-${d}T06:00:00Z`) })).file)
    }
    expect(listBackups(backups, LOCAL_DAILY_BACKUP_PREFIX)).toHaveLength(LOCAL_MAX_DAILY_BACKUPS)
    for (const f of files.slice(-LOCAL_MAX_DAILY_BACKUPS)) expect(existsSync(f)).toBe(true)
    for (const f of files.slice(0, totalDays - LOCAL_MAX_DAILY_BACKUPS)) expect(existsSync(f)).toBe(false)
  })

  it('zadrževanje dnevnih kopij ne sega po drugih vrstah (pred-push in pred-obnova)', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath))

    const push = await backupDatabase(dbPath, backups, { kind: 'pred-pushom', now: new Date('2026-09-01T06:00:00Z') })
    const varnostna = join(backups, `${LOCAL_PRE_RESTORE_PREFIX}2026-09-02T06-00-00-000Z.db`)
    writeFileSync(varnostna, 'x')

    for (let day = 1; day <= LOCAL_MAX_DAILY_BACKUPS + 2; day++) {
      const d = day < 10 ? `0${day}` : String(day)
      await backupDatabase(dbPath, backups, { now: new Date(`2026-09-${d}T06:00:00Z`) })
    }
    expect(existsSync(push.file)).toBe(true)
    expect(existsSync(varnostna)).toBe(true)
    expect(listBackups(backups, LOCAL_PRE_PUSH_BACKUP_PREFIX)).toHaveLength(1)
  })

  it('pred-push kopij se ne združijo po datumu: vsak poseg v shemo dobi svojo', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath))

    const a = await backupDatabase(dbPath, backups, { kind: 'pred-pushom', now: new Date('2026-10-22T06:00:00Z') })
    const b = await backupDatabase(dbPath, backups, { kind: 'pred-pushom', now: new Date('2026-10-22T06:05:00Z') })
    expect(a.file).not.toBe(b.file)
    expect(listBackups(backups, LOCAL_PRE_PUSH_BACKUP_PREFIX)).toHaveLength(2)
  })
})

describe('v1.169.0 — obnova iz kopije', () => {
  it('obnova vrne stanje iz kopije, novejši zapisi pa ostanejo v varnostni kopiji', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')

    closeHandle(seedDb(dbPath, ['kopicirana']))
    applyDurability(dbPath)
    const kopija = await backupDatabase(dbPath, backups)

    const live = handle(dbPath)
    live.prepare('INSERT INTO order_row(code) VALUES (?)').run('novejsi')
    closeHandle(live)
    expect(countRows(dbPath)).toBe(2)

    const result = await restoreDatabase({ backupPath: kopija.file, dbPath, now: new Date('2026-10-22T07:00:00Z'), force: true })
    expect(result.dbPath).toBe(dbPath)
    expect(countRows(dbPath)).toBe(1)
    expect(result.safetyCopy).toBeDefined()
    expect(countRows(result.safetyCopy as string)).toBe(2)
    expect(integrity(dbPath)).toBe('ok')
    // Kopija je nastala z VACUUM INTO, torej je v delete načinu. Obnova mora ga
    // sama vrniti v WAL: če bi čakala na naslednji zagon, bi bil prvi
    // izpad elektrike po obnovi spet klasičen pokvarjen paket.
    const obnovljena = handle(dbPath)
    expect(readDurabilityState(obnovljena).journalMode).toBe('wal')
    closeHandle(obnovljena)
    expect(result.journalMode).toBe('wal')
  })

  it('obnova nad obstoječo bazo brez --force se zavrne in ne spremeni ničesar', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')

    closeHandle(seedDb(dbPath))
    applyDurability(dbPath)
    const kopija = await backupDatabase(dbPath, backups)

    const live = handle(dbPath)
    live.prepare('INSERT INTO order_row(code) VALUES (?)').run('dodan')
    closeHandle(live)

    let message = ''
    try {
      await restoreDatabase({ backupPath: kopija.file, dbPath, now: new Date('2026-10-22T07:00:00Z') })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/--force/)
    expect(countRows(dbPath)).toBe(2)
    expect(listBackups(backups, LOCAL_PRE_RESTORE_PREFIX)).toEqual([])
  })

  it('obnova v prazno podatkovno mapo uspe brez --force (ni kaj izgubiti)', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')

    closeHandle(seedDb(dbPath, ['prva']))
    const kopija = await backupDatabase(dbPath, backups)
    remove(dbPath)

    const result = await restoreDatabase({ backupPath: kopija.file, dbPath, now: NOW })
    expect(countRows(result.dbPath)).toBe(1)
    expect(result.safetyCopy).toBeUndefined()
  })

  it('obnova pokvarjene kopije se zavrne, baza ostane nedotaknjena', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    closeHandle(seedDb(dbPath, ['edina']))
    const pokvarjena = join(dir, 'pokvarjena.db')
    writeFileSync(pokvarjena, 'naključne binarne vsebine'.repeat(400))

    let message = ''
    try {
      await restoreDatabase({ backupPath: pokvarjena, dbPath, now: NOW, force: true })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('integrity_check')
    expect(countRows(dbPath)).toBe(1)
  })

  it('obnova zavrne tudi kopijo, ki se odpre a je vsebinsko pokvarjena', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath, ['edina']))
    const pokvarjena = join(dir, 'pokvarjena.db')
    makeOpenableButCorrupt(pokvarjena)

    let message = ''
    try {
      await restoreDatabase({ backupPath: pokvarjena, dbPath, now: NOW, force: true })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/vrnil /)
    expect(countRows(dbPath)).toBe(1)
    // Pregled mora priti PRED varnostno kopijo: sicer bi že zavrnjena obnova
    // pustila sled v backups/.
    expect(listBackups(backups, LOCAL_PRE_RESTORE_PREFIX)).toEqual([])
  })

  it('obnova med aktivnim zapisom (WAL z odprtim zapisom) se zavrne', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')

    closeHandle(seedDb(dbPath))
    const kopija = await backupDatabase(dbPath, backups)
    const dirty = openWithDirtyWal(dbPath, 'v-uporabi')
    expect(isDatabaseInUse(dbPath)).toBe(true)

    let message = ''
    try {
      await restoreDatabase({ backupPath: kopija.file, dbPath, now: new Date('2026-10-22T07:00:00Z'), force: true })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/ustavi/)
    expect(countRows(dbPath)).toBe(2)

    closeHandle(dirty)
    expect(isDatabaseInUse(dbPath)).toBe(false)
  })

  it('obnova počisti osirotele -wal/-shm datoteke, da ne preživijo stanje pred obnovo', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'restaurantos.db')
    const backups = join(dir, 'backups')

    closeHandle(seedDb(dbPath, ['prva']))
    const kopija = await backupDatabase(dbPath, backups)
    // Osamel -wal: nastal je, a aplikacija je bila ustavljena pred obnovo.
    writeFileSync(`${dbPath}-wal`, 'surovi')
    remove(dbPath)

    await restoreDatabase({ backupPath: kopija.file, dbPath, now: NOW })
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
    expect(countRows(dbPath)).toBe(1)
  })
})

describe('v1.169.0 — CLI za kopijo in obnovo', () => {
  function zazeni(skript: string, ...zastavice: string[]) {
    return spawnSync(process.execPath, [skript, ...zastavice], { encoding: 'utf8' })
  }

  function uspel(run: { status: number | null; stdout: string; stderr: string }): void {
    if (run.status !== 0) throw new Error(`[test] ${skriptOutput(run)}`)
  }

  const skriptOutput = (run: { stdout: string; stderr: string }) => `${run.stdout}\n${run.stderr}`.slice(0, 400)

  it('local:backup in local:restore --latest --force vrnejo bazo v stanje kopije', () => {
    const dir = tempDir('ros-v169-cli-')
    mkdirSync(join(dir, 'data'), { recursive: true })
    const dbPath = join(dir, 'data', 'restaurantos.db')
    closeHandle(seedDb(dbPath, ['kopicirana']))

    const kopiranje = zazeni('scripts/local-backup.ts', '--data-dir', dir, '--json')
    uspel(kopiranje)
    const rezultatKopije = JSON.parse(kopiranje.stdout)
    expect(rezultatKopije.ok).toBe(true)
    expect(rezultatKopije.created).toBe(true)

    // Aplikacija ŠE TEČE: rep je odprt v živem procesu, obnova mora zavrniti.
    const zivaAplikacija = openWithDirtyWal(dbPath, 'izgubljen-po-kopiji')
    expect(countRows(dbPath)).toBe(2)

    const prezgodaj = zazeni('scripts/local-restore.ts', '--data-dir', dir, '--latest', '--force', '--json')
    expect(prezgodaj.status).not.toBe(0)
    expect(skriptOutput(prezgodaj)).toMatch(/še teče/)
    expect(countRows(dbPath)).toBe(2)

    closeHandle(zivaAplikacija)
    drainWal(dbPath)
    const obnova = zazeni('scripts/local-restore.ts', '--data-dir', dir, '--latest', '--force', '--json')
    uspel(obnova)
    const rezultatObnove = JSON.parse(obnova.stdout)
    expect(rezultatObnove.ok).toBe(true)
    expect(countRows(dbPath)).toBe(1)
    expect(rezultatObnove.safetyCopy).toBeDefined()
    expect(countRows(rezultatObnove.safetyCopy as string)).toBe(2)
  })

  it('local:restore --list pokaže dejansko pot kopij in jo tudi najde', () => {
    const dir = tempDir('ros-v169-cli-')
    mkdirSync(join(dir, 'data'), { recursive: true })
    const dbPath = join(dir, 'data', 'restaurantos.db')
    closeHandle(seedDb(dbPath))
    uspel(zazeni('scripts/local-backup.ts', '--data-dir', dir, '--json'))

    const seznam = zazeni('scripts/local-restore.ts', '--data-dir', dir, '--list', '--json')
    uspel(seznam)
    const rezultat = JSON.parse(seznam.stdout)
    expect(rezultat.kopije.length).toBe(1)
    uspel(zazeni('scripts/local-restore.ts', '--data-dir', dir, '--latest', '--force', '--json'))
  })

  it('local:restore --latest izbere dnevno kopijo, ne mlajše varnostne', () => {
    const dir = tempDir('ros-v169-cli-')
    mkdirSync(join(dir, 'data'), { recursive: true })
    const dbPath = join(dir, 'data', 'restaurantos.db')
    const backups = join(dir, 'backups')
    closeHandle(seedDb(dbPath, ['kopicirana']))
    uspel(zazeni('scripts/local-backup.ts', '--data-dir', dir, '--json'))

    writeFromExitedProcess(dbPath, 'nova-post-kopiji')
    drainWal(dbPath)
    // Starejša vsebina, mlajše ime: tako izgleda varnostna kopija, nastala pri
    // obnovi po napaki. `--latest` je recovery point, ne najmlajša datoteka.
    copyFileSync(dbPath, join(backups, `${LOCAL_PRE_RESTORE_PREFIX}2099-01-01T00-00-00-000Z.db`))
    expect(countRows(dbPath)).toBe(2)

    uspel(zazeni('scripts/local-restore.ts', '--data-dir', dir, '--latest', '--force', '--json'))
    expect(countRows(dbPath)).toBe(1)
  })
})

describe('v1.169.0 — statične invariante', () => {
  it('package.json pozna lokalno kopijo in obnovo', async () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['local:backup']).toContain('local-backup')
    expect(pkg.scripts['local:restore']).toContain('local-restore')
  })

  it('setup NE več kopira baze s copyFileSync (rabi WAL-varno pot)', async () => {
    expect(read('src/lib/local-setup.ts')).not.toContain('copyFileSync')
  })

  it('zagon lokalnega profila vklopi pragme in pokliče kopijo', async () => {
    expect(read('src/lib/local-setup.ts')).toMatch(/applyDurability|openDurabilityDatabase/)
    expect(read('scripts/local-start.ts')).toMatch(/backupDatabase/)
  })

  it('postanek lokalnega profila počisti rep, da naslednja obnova ne zavrne', async () => {
    const src = read('scripts/local-start.ts')
    // Pin je sidran na izhodno vejo, ne na besedo `drainWal` kjerkoli v datoteki:
    // sam uvoz bi bil v pinu enako viden, čiščenje pa se ob postanku ne bi zgodilo.
    const izhod = src.slice(src.indexOf(`child.on('exit'`))
    expect(izhod).not.toBe(src)
    expect(izhod).toMatch(/drainWal\(setup\.dbPath\)/)
  })

  it('kopija nastane PRED `db push`, ne za njim', async () => {
    const src = read('src/lib/local-setup.ts')
    const kopija = src.search(/backupDatabase\(/)
    const push = src.indexOf(`'db', 'push'`)
    expect(kopija).toBeGreaterThan(-1)
    expect(push).toBeGreaterThan(-1)
    expect(kopija).toBeLessThan(push)
  })

  it('PRD cesta ne obljublja več verzij, ki so jih pojedle druge izdaje', async () => {
    const prd = read('docs/PRD-LOKALNA-BAZA.md')
    expect(prd).not.toMatch(/v1\.16[678]\.0\*\*\s*\|\s*(Varen lokalni obrat|Namestitev v 10 minutah)/)
    expect(prd).toMatch(/R2a — v1\.169\.0\*\* \| Vzdržljiva lokalna baza/)
    expect(prd).toMatch(/R2b — v1\.170\.0\*\* \| Varen lokalni obrat/)
  })

  it('runbook lokalnega zagona opisuje kopijo, obnovo in izvedeno vajo obnove', async () => {
    const doc = read('docs/LOKALNI-ZAGON.md')
    expect(doc).toMatch(/local:backup/)
    expect(doc).toMatch(/local:restore/)
    expect(doc).toMatch(/integrity_check/)
    expect(doc).toMatch(/Vaja obnovitve/)
  })
})
