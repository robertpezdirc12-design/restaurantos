/**
 * v1.182.0 (R5a) — šifrirana kopija, ki NI na istem disku kot baza, in jo je
 * mogoče obnoviti na računalniku, ki v obratu nikoli ni služil (PRD
 * docs/PRD-LOKALNA-BAZA.md, R5: "kopija obnovljiva brez strežnika v obratu").
 *
 * Zakaj sploh in zakaj tako:
 *  - v1.169.0 (R2a) je vzpostavil dnevno kopijo, a jo je shranil v mapo zraven
 *    baze. Besedilo izdaje se temu ne dela: EN disk, EN računalnik, ENA požarna.
 *    To je zapisano v PRD §14 in v opozorilu ukaza `local:backup`.
 *  - R5 kot celota obljublja "šifrirana kopija v oblak, licenčni ključ,
 *    večobratni nadzor". Oblak ne more biti del te izdaje: produkcijska baza ne
 *    obstaja (Neon je na kvoti), nobena samodejna pošiljka pa ne sme postati nov
 *    izhod podatkov, ki ga nihče ni preizkusil. Izdaja torej nosi **R5a: medij,
 *    ki ga lastnik sam odnese** (USB, zunanji disk, omrežna mapa) in **obnovitev
 *    na drugi napravi**. Prevoz v oblak ostane R5b brez številke.
 *  - Kopija na tujem mediju je izročena svetu, zato sme obstajati SAMO
 *    šifrirana. Karkoli ni šifrirano, ne sme biti zapisano.
 *
 * Meritve, ki so rodile te teste (bun 1.4.3, Windows):
 *  - `fs.statfsSync()` na Windows pod `bun` vrne `fsid: undefined` in `type: 0`
 *    za KATERO KOLI pot — primerjava `fsid` bi bila vedno enaka in torej slepa.
 *    Uporabljen je `fs.statSync().dev`, ki je izmerjen različen po volumenu
 *    (C:=3059246764, D:=947176493, E:=779618308) in enak znotraj volumena;
 *    `ino` je na vseh koreneih enak (1407374883553285) in NEUPORABEN.
 *  - `crypto.scryptSync` z `N=2^15` (32 MiB) je na privzetem `maxmem` MEHEN:
 *    v enem procesu uspe (51 ms), v drugem pade z `MEMORY_LIMIT_EXCEEDED`. Z
 *    izrecnim `maxmem` uspe vedno. Ključ torej `maxmem` RAČUNA, ne zaupa privzete.
 *  - AES-256-GCM čez živo bazo (3 682 304 B): šifriranje 25 ms, dešifriranje 26 ms
 *    — celoten medij v pomnilnik je upravičen, pretočni model bi dodal prvo
 *    napako brez koristi.
 *  - Napačno geslo pade na `Unsupported state or unable to authenticate data`
 *    (preverjen GCM žig), torej obstaja način, ki loči napačno geslo od
 *    pokvarjene datoteke.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LOCAL_MAX_OFFSITE_BUNDLES,
  LOCAL_OFFSITE_EXT,
  LOCAL_OFFSITE_KDF,
  LOCAL_OFFSITE_MIN_PASSPHRASE,
  LOCAL_OFFSITE_PASSPHRASE_ENV,
  LOCAL_OFFSITE_PREFIX,
  OFFSITE_CIPHER,
  OFFSITE_FORMAT,
  OFFSITE_KDF_MAX_N,
  OFFSITE_KDF_MEM_CEILING,
  createOffsiteBundle,
  deriveKey,
  deviceOf,
  inspectBundle,
  jeGcmNapaka,
  listOffsiteBundles,
  maxmemFor,
  offsiteNameFor,
  parseHeader,
  pruneOffsiteBundles,
  readPassphraseFromEnv,
  readPassphraseFromFile,
  restoreFromBundle,
  sameVolume,
  validateHeaderKdf,
} from '../src/lib/offsite-backup'
import { applyDurability } from '../src/lib/local-durability'

const REPO = join(import.meta.dir, '..')
const OFFSITE_CLI = join(REPO, 'scripts', 'local-offsite.ts')
const RESTORE_CLI = join(REPO, 'scripts', 'local-restore.ts')

/* ── hišna oprema: prave SQLite datoteke v začasnih mapah, ne mocki ────────── */

const tmpDirs: string[] = []
const handles = new Set<DatabaseSync>()

function tempDir(prefix = 'ros-v182-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

function sprosti(): void {
  ;(globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }).Bun?.gc?.(true)
}

function handle(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  handles.add(db)
  return db
}

function closeHandle(db: DatabaseSync): void {
  db.close()
  handles.delete(db)
  sprosti()
}

/** Vsi pisecjski ročaji stran — pod bunom jih sprosti šele GC (izmerjeno v1.169.0). */
function pocistiRočaje(): void {
  for (const db of [...handles]) {
    try {
      db.close()
    } catch {
      /* že zaprta */
    }
    handles.delete(db)
  }
  sprosti()
}

afterAll(() => {
  pocistiRočaje()
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* začasna mapa; Windows jo počisti sam */
    }
  }
})

const NOW = new Date('2026-10-26T06:00:00.000Z')
const GESLO = 'gostilna-pivnica-2026'

/** Podatkovna mapa + pot do baze + "USB" na istem disku (sonda ga prepozna). */
function pripravi(prefix: string) {
  const dir = tempDir(prefix)
  const dbPath = join(dir, 'data', 'restaurantos.db')
  const usb = join(dir, 'usb')
  return { dir, dbPath, usb }
}

/** Baza s števcem vrstic — ista igrača kot v tests/v169, da je sledljiva. */
function seedDb(dbPath: string, rows: string[] = ['nova']): DatabaseSync {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = handle(dbPath)
  db.exec('CREATE TABLE IF NOT EXISTS order_row(id INTEGER PRIMARY KEY, code TEXT)')
  for (const code of rows) db.prepare('INSERT INTO order_row(code) VALUES (?)').run(code)
  return db
}

/** Odprta baza z NAMERNO umazanim repom: tretja vrstica živi samo v `-wal`. */
function seedDbWithDirtyWal(dbPath: string): DatabaseSync {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = handle(dbPath)
  db.exec('PRAGMA journal_mode=wal')
  db.exec('PRAGMA wal_autocheckpoint=0')
  db.exec('CREATE TABLE IF NOT EXISTS order_row(id INTEGER PRIMARY KEY, code TEXT)')
  db.prepare('INSERT INTO order_row(code) VALUES (?)').run('prva')
  db.prepare('INSERT INTO order_row(code) VALUES (?)').run('druga')
  db.prepare('INSERT INTO order_row(code) VALUES (?)').run('samo-v-repu')
  return db
}

function vrstice(db: DatabaseSync): string[] {
  return (db.prepare('SELECT code FROM order_row ORDER BY id').all() as { code: string }[]).map((r) => r.code)
}

/**
 * Tretjo vrstico zapiše proces, KI GA UBIJEMO, ne ta proces: po clean `close()`
 * SQLite počisti `-wal` (izmerjeno in zapisano v
 * tests/v169-local-durability.test.ts), glavna datoteka je takrat popolna in
 * navaden prekop se ne loči več od `VACUUM INTO`. Mutacija M4 (prekop namesto
 * `VACUUM INTO`) je 2026-10-26 ZDRŽALA prejšnjo obliko D2 prav zato, zato
 * helper zahteva merljiv umazan rep.
 */
function zapiIzUbitegaProcesa(dbPath: string, code: string): void {
  const src = [
    "const { DatabaseSync } = require('node:sqlite')",
    `const db = new DatabaseSync(${JSON.stringify(dbPath)})`,
    "db.exec('PRAGMA journal_mode=wal')",
    "db.exec('PRAGMA wal_autocheckpoint=0')",
    `db.prepare('INSERT INTO order_row(code) VALUES (?)').run(${JSON.stringify(code)})`,
    'setInterval(() => {}, 1000)',
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', src], { timeout: 3000, killSignal: 'SIGKILL', stdio: 'ignore' })
  if (r.signal !== 'SIGKILL' && r.status !== null) {
    throw new Error(`[test] otrok ni bil ubit (status ${String(r.status)}, signal ${String(r.signal)}): ${(r.stderr || '').slice(0, 120)}`)
  }
  const wal = `${dbPath}-wal`
  if (!existsSync(wal) || statSync(wal).size < 1) {
    throw new Error(`[test] Rep ${wal} ni umazan, zato D2 ne more ločiti VACUUM INTO-a od navadnega prekopa.`)
  }
}

/** Vse datoteke v mapi rekurzivno, kot relativna imena — za trditve "ni ostalo". */
function drevo(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...drevo(p, rel))
    else out.push(rel)
  }
  return out.sort()
}

/* ══════════════ A. Pogodba formata ══════════════ */

describe('v1.182.0 §A — kontejner `ros-offsite-1` ima pisno pogodbo', () => {
  test('A1 konstante so zaklenjene (imenovanje, format, parametri KDF)', () => {
    expect(LOCAL_OFFSITE_PREFIX).toBe('dalec-')
    expect(LOCAL_OFFSITE_EXT).toBe('.rosbak')
    expect(OFFSITE_FORMAT).toBe('ros-offsite-1')
    expect(OFFSITE_CIPHER).toBe('aes-256-gcm')
    expect(LOCAL_MAX_OFFSITE_BUNDLES).toBe(8)
    expect(LOCAL_OFFSITE_MIN_PASSPHRASE).toBe(12)
    expect(LOCAL_OFFSITE_PASSPHRASE_ENV).toBe('RESTAURANTOS_OFFSITE_PASSPHRASE')
    expect(LOCAL_OFFSITE_KDF).toEqual({ name: 'scrypt', N: 32768, r: 8, p: 1 })
    expect(OFFSITE_KDF_MAX_N).toBe(131072)
    expect(OFFSITE_KDF_MEM_CEILING).toBe(268_435_456)
  })

  test('A2 ime kopije je ISO žig z nadomeščenima dvopičjema in piko (isti kot v1.169.0)', () => {
    expect(offsiteNameFor(new Date('2026-10-26T07:08:09.123Z'))).toBe('dalec-2026-10-26T07-08-09-123Z.rosbak')
    // Leksikografski red mora ostati kronološki, ker po njem zadrževanje briše.
    expect(offsiteNameFor(new Date('2026-10-26T07:08:09.123Z')) < offsiteNameFor(new Date('2026-10-27T01:00:00.000Z'))).toBe(true)
  })

  test('A3 glava je prva vrstica, dešifrirni material je base64 in ne izgublja ničesar', () => {
    const { dbPath, usb } = pripravi('ros-v182-a3-')
    closeHandle(seedDb(dbPath, ['kava']))
    const res = createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, appVersion: '1.182.0', allowSameVolume: true })
    const surovo = readFileSync(res.file)
    const glavaSurovo = JSON.parse(surovo.subarray(0, surovo.indexOf(0x0a)).toString('utf8')) as Record<string, unknown>
    expect(glavaSurovo.format).toBe(OFFSITE_FORMAT)
    expect(glavaSurovo.cipher).toBe(OFFSITE_CIPHER)
    expect(Buffer.from(String(glavaSurovo.salt), 'base64').length).toBe(16)
    expect(Buffer.from(String(glavaSurovo.iv), 'base64').length).toBe(12)
    expect(Buffer.from(String(glavaSurovo.tag), 'base64').length).toBe(16)
    // `inspectBundle` in `parseHeader` morata vrniti ISTO glavo kot surovo branje:
    // edini dokaz, da funkcija ne sestavlja prijaznejših podatkov iz zraka.
    expect(inspectBundle(res.file)).toEqual(glavaSurovo)
    expect(parseHeader(surovo)).toEqual(glavaSurovo)
    expect(surovo.subarray(surovo.indexOf(0x0a) + 1).length).toBe(Number(glavaSurovo.cipherBytes))
  })

  test('A4 glava NE nosi poti do baze, imena tabele ali samega gesla', () => {
    const { dbPath, usb } = pripravi('ros-v182-a4-')
    closeHandle(seedDb(dbPath, ['kava']))
    const res = createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, appVersion: '1.182.0', allowSameVolume: true })
    const glava = JSON.stringify(inspectBundle(res.file))
    for (const niz of ['restaurantos.db', dbPath, GESLO, 'order_row', 'kava']) {
      expect(glava.includes(niz)).toBe(false)
    }
  })
})

/* ══════════════ B. Dokaz, da kopija ni na istem disku ══════════════ */

describe('v1.182.0 §B — `sameVolume` mora biti viden, ne slep', () => {
  test('B1 pozitivna kontrola: dve resnični poti na istem disku sta ISTI disk', () => {
    // Brez te kontrole bi B4 (zavrnitev istega diska) lahko pisal bralnik, ki
    // nikoli ne vidi razlike — enaka lekcija kot §D v tests/v1801-brand-name.
    const { dir, dbPath } = pripravi('ros-v182-b1-')
    closeHandle(seedDb(dbPath, ['kava']))
    const podmapa = join(dir, 'usb')
    mkdirSync(podmapa)
    const dev = deviceOf(dbPath)
    expect(typeof dev).toBe('number')
    expect(Number.isFinite(dev)).toBe(true)
    expect(deviceOf(dbPath)).toBe(deviceOf(podmapa))
    expect(sameVolume(dbPath, podmapa)).toBe(true)
  })

  test('B2 vstavljena sonda: različen `dev` pomeni RAZLIČEN disk', () => {
    const sonda = (p: string) => ({ dev: BigInt(p.toLowerCase().includes('c:') ? 111 : 222) })
    expect(sameVolume('c:/a/b.db', 'd:/usb/x.rosbak', sonda)).toBe(false)
    expect(sameVolume('c:/a/b.db', 'c:/a/c.db', sonda)).toBe(true)
  })

  test('B3 nepoznano se JAVI kot nepoznano, ne kot "drug disk"', () => {
    const sondaZNapako = () => {
      throw new Error('ENOENT')
    }
    expect(deviceOf('c:/nic/ne/obstaja', sondaZNapako)).toBeNull()
    expect(sameVolume('c:/a.db', 'd:/b.rosbak', sondaZNapako)).toBeNull()
    // in na resnični manjkajoči poti enako — tiha `false` bi bila laž
    expect(sameVolume(join(tempDir('ros-v182-b3-'), 'manjka.db'), 'C:\\Windows')).toBeNull()
  })

  test('B4 na disk, ki je isti kot baza, kopija NE sme pristati brez izrecne privolitve', () => {
    const { dir, dbPath, usb } = pripravi('ros-v182-b4-')
    closeHandle(seedDb(dbPath, ['kava']))
    let sporočilo = ''
    try {
      createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo).toContain('isti disk')
    expect(sporočilo).not.toContain(GESLO)
    // in nič ne sme biti zapisano, dokler lastnik ne potrdi
    expect(existsSync(usb)).toBe(false)

    const res = createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    expect(res.sameVolume).toBe(true)
    expect(res.offsite).toBe(false)
  })

  test('B5 če naprava pozna dva volumna, morata imeti različna `dev` (sicer: nezajeto)', () => {
    // Ta test NE piše na tujem disku in ne piše vanj: meri samo `statSync` korena.
    const koreni = ['C:\\', 'D:\\', 'E:\\', '/mnt'].filter((r) => existsSync(r))
    const devi = koreni.map((r) => deviceOf(r)).filter((d): d is number => typeof d === 'number')
    if (devi.length >= 2) {
      expect(new Set(devi).size).toBe(devi.length)
    } else {
      // Edini volumen: trditev o ločenem disku je na tej napravi dokazana samo z
      // B2 (vstavljena sonda). To je zapisano kot mezda, ne zamaskirano.
      expect(devi.length).toBeLessThanOrEqual(1)
    }
  })
})

/* ══════════════ C. Geslo ══════════════ */

describe('v1.182.0 §C — geslo sme živeti samo v pomnilniku', () => {
  test('C1 prekratko geslo je zavrnjeno, sporočilo pa ne ponovi poskušanega', () => {
    const { dir, dbPath, usb } = pripravi('ros-v182-c1-')
    closeHandle(seedDb(dbPath, ['kava']))
    let sporočilo = ''
    try {
      createOffsiteBundle({ dbPath, targetDir: usb, passphrase: 'kava', now: NOW, allowSameVolume: true })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo).toContain(String(LOCAL_OFFSITE_MIN_PASSPHRASE))
    expect(sporočilo).not.toContain('kava')
    expect(drevo(dir).filter((f) => f.startsWith('usb/'))).toEqual([])
  })

  test('C2 prazno in samo-presledno geslo sta enaka napaka', () => {
    expect(() => deriveKey('   ', Buffer.alloc(16, 7))).toThrow(/geslo/)
    expect(() => deriveKey('', Buffer.alloc(16, 7))).toThrow(/geslo/)
  })

  test('C3 iz okolja: samo presledek pomeni "ni gesla", vodilni in prikonci presledki OSTANEJO del gesla', () => {
    expect(readPassphraseFromEnv({})).toBeNull()
    expect(readPassphraseFromEnv({ RESTAURANTOS_OFFSITE_PASSPHRASE: '   ' })).toBeNull()
    expect(readPassphraseFromEnv({ RESTAURANTOS_OFFSITE_PASSPHRASE: ' geslo s presledki ' })).toBe(' geslo s presledki ')
    expect(readPassphraseFromEnv({ DRUGO: 'x' }, 'DRUGO')).toBe('x')
  })

  test('C4 iz datoteke: en sam končnik CRLF, nič več (geslo se ne sme "popravljati")', () => {
    const dir = tempDir('ros-v182-c4-')
    const f = join(dir, 'geslo.txt')
    writeFileSync(f, 'gostilna-pivnica-2026\r\n')
    expect(readPassphraseFromFile(f)).toBe('gostilna-pivnica-2026')
    writeFileSync(f, 'a  \n\n')
    expect(readPassphraseFromFile(f)).toBe('a  \n')
    expect(() => readPassphraseFromFile(join(dir, 'manjka.txt'))).toThrow(/datoteke/)
  })

  test('C5 gesla ni v kontejnerju — ne v glavi, ne v šifriranem telesu', () => {
    const { dbPath, usb } = pripravi('ros-v182-c5-')
    closeHandle(seedDb(dbPath, ['kava']))
    const res = createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    const surovo = readFileSync(res.file)
    expect(surovo.includes(Buffer.from(GESLO, 'utf8'))).toBe(false)
    // Pozitivna kontrola: da "ni najdeno" pomeni kaj, mora isti test najti niz,
    // ki V VISOKO verjetnostjo nastopi v razširjenem odseku — jasna SQLite baza.
    const jasna = join(tempDir('ros-v182-c5b-'), 'jasna.db')
    closeHandle(seedDb(jasna, ['kava']))
    expect(readFileSync(jasna).includes(Buffer.from('kava', 'utf8'))).toBe(true)
    // in je ne v šifriranem kontejnerju
    expect(surovo.includes(Buffer.from('SQLite format 3', 'utf8'))).toBe(false)
    expect(surovo.includes(Buffer.from('kava', 'utf8'))).toBe(false)
  })

  test('C6 `maxmem` se RAČUNA iz parametrov in ima absolutno mejo (izmerjen mejni N)', () => {
    expect(maxmemFor(32768, 8, 1)).toBe(67_108_864) // 2 × 128·N·r, ne 32 MiB točno
    expect(maxmemFor(131072, 8, 1)).toBe(268_435_456)
    expect(maxmemFor(2 ** 22, 8, 1)).toBeLessThanOrEqual(OFFSITE_KDF_MEM_CEILING)
    // Realna meja: ključ z zaklenjenimi parametri nastane in ne pade na BoringSSL
    // omejitev, ki je izmerjena na meji (32 MiB točno).
    expect(deriveKey(GESLO, Buffer.alloc(16, 1)).length).toBe(32)
  })
})

/* ══════════════ D. Ustvarjanje kopije ══════════════ */

describe('v1.182.0 §D — kopija je res kopija, ne prekop datoteke', () => {
  test('D1 uspešna pot: mapa nastane, kopija obstaja, pageCount je izmerjen', () => {
    const { dbPath, usb } = pripravi('ros-v182-d1-')
    closeHandle(seedDb(dbPath, ['kava']))
    const res = createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, appVersion: '1.182.0', allowSameVolume: true })
    expect(existsSync(res.file)).toBe(true)
    expect(basename(res.file)).toBe(offsiteNameFor(NOW))
    expect(res.pageCount).toBeGreaterThan(0)
    expect(res.bytes).toBe(statSync(res.file).size)
    expect(res.format).toBe(OFFSITE_FORMAT)
    expect(res.created).toBe(true)
    expect(res.appVersion).toBe('1.182.0')
  })

  test('D2 umazan rep: kopija nosi TRETJO vrstico, navaden prekop je ne bi', () => {
    // Isti pouk kot v1.169.0: prekop GLAVNE datoteke čez umazan rep vrne 2 od 3
    // vrstic. R5a sme uporabljati samo `VACUUM INTO`, sicer šifriramo kopijo, ki
    // laže — in je ne moremo več razglasiti za veljavno.
    const { dbPath, usb } = pripravi('ros-v182-d2-')
    closeHandle(seedDb(dbPath, ['prva', 'druga']))
    zapiIzUbitegaProcesa(dbPath, 'samo-v-repu')
    // Pozitivna kontrola, ki dokazuje, da ima test sploh kaj dokazovati: isti
    // prekop, ki ga mutacija M4 vstavi v proizvodnjo pot, RES izgubi tretjo
    // vrstico. Brez te vrstice bi D2 lahko zelenal tudi brez `VACUUM INTO`.
    const naivna = join(tempDir('ros-v182-d2-naivna-'), 'naivna.db')
    copyFileSync(dbPath, naivna)
    const preveriNaivno = handle(naivna)
    expect(vrstice(preveriNaivno)).toEqual(['prva', 'druga'])
    closeHandle(preveriNaivno)

    const res = createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    const ciljnaBaza = join(tempDir('ros-v182-d2-cilj-'), 'data', 'restaurantos.db')
    const r = restoreFromBundle({ bundlePath: res.file, passphrase: GESLO, dbPath: ciljnaBaza, now: NOW })
    expect(r.pageCount).toBe(res.pageCount)
    const preveri = handle(ciljnaBaza)
    expect(vrstice(preveri)).toEqual(['prva', 'druga', 'samo-v-repu'])
    closeHandle(preveri)
  })

  test('D3 zadrževanje pobriše samo LASTNIKE predpone, tujih datotek ne dotakne', () => {
    const { dbPath, usb } = pripravi('ros-v182-d3-')
    closeHandle(seedDb(dbPath, ['kava']))
    mkdirSync(usb, { recursive: true })
    const tuja = join(usb, 'tuje-dalec-2020.rosbak')
    const tujaBaza = join(usb, 'dnevno-2020.db')
    const tujaMapa = join(usb, 'ze-duze-veljavno.rosbak.extra')
    writeFileSync(tuja, 'tuje')
    writeFileSync(tujaBaza, 'tuja baza')
    mkdirSync(tujaMapa)
    for (let dan = 1; dan <= LOCAL_MAX_OFFSITE_BUNDLES + 3; dan++) {
      const now = new Date(Date.UTC(2026, 9, 1 + dan, 8, 0, 0, dan))
      createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now, allowSameVolume: true })
    }
    const najdeno = listOffsiteBundles(usb)
    expect(najdeno.length).toBe(LOCAL_MAX_OFFSITE_BUNDLES)
    // Izpeljano, ne na pamet: ustvarjenih je 11, shrani se 8, pobrisanih torej 11-8=3
    // (dan 1, 2, 3) in najstarejša OHRANJENA je dan 4 = 5. oktober, ms 4.
    const najstarejsaOhranjena = LOCAL_MAX_OFFSITE_BUNDLES + 3 - LOCAL_MAX_OFFSITE_BUNDLES + 1
    expect(najstarejsaOhranjena).toBe(4)
    expect(najdeno[0]).toBe(offsiteNameFor(new Date(Date.UTC(2026, 9, 1 + najstarejsaOhranjena, 8, 0, 0, najstarejsaOhranjena))))
    expect(existsSync(tuja)).toBe(true)
    expect(existsSync(tujaBaza)).toBe(true)
    expect(readdirSync(usb)).toContain(basename(tujaMapa))
    // zadrževanje je ločena funkcija in test jo pozna tudi samostojno
    expect(pruneOffsiteBundles(usb, 2).length).toBe(LOCAL_MAX_OFFSITE_BUNDLES - 2)
    expect(listOffsiteBundles(usb).length).toBe(2)
    expect(existsSync(tuja)).toBe(true)
  })

  test('D4 spodletel zagon NE sme pustiti jasne kopije na disku', () => {
    const { dbPath, usb } = pripravi('ros-v182-d4-')
    closeHandle(seedDb(dbPath, ['kava']))
    mkdirSync(usb, { recursive: true })
    // Prava napaka, ne vstavljena: končno ime že obstaja, preimenovanje torej pade.
    writeFileSync(join(usb, offsiteNameFor(NOW)), 'ze obstaja')
    let sporočilo = ''
    try {
      createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo.length).toBeGreaterThan(0)
    expect(sporočilo).not.toContain(GESLO)
    const ostalo = readdirSync(usb)
    expect(ostalo).toEqual([offsiteNameFor(NOW)])
    expect(readFileSync(join(usb, offsiteNameFor(NOW)), 'utf8')).toBe('ze obstaja')
    // noben jasen odsek (`.db`), začasna datoteka ali pika na začetku ne sme preživeti
    for (const f of ostalo) expect(f.endsWith('.db') || f.endsWith('.tmp') || f.startsWith('.')).toBe(false)
  })

  test('D4b odpoved SKOZI pot (prevelik odsek) počisti jasno kopijo, ne samo pred potjo', () => {
    // D4 pade, preden nastane karkoli — to je predrago. Tukaj odpove ZA `VACUUM
    // INTO`, ko je jasna kopija že na disku, in edini dokaz, da jo koda pobere,
    // je seznam datotek PO poskusu.
    const { dbPath, usb } = pripravi('ros-v182-d4b-')
    closeHandle(seedDb(dbPath, ['kava']))
    let sporočilo = ''
    try {
      createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true, maxBytes: 1 })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo).toMatch(/meja/i)
    expect(sporočilo).toContain('1 B')
    expect(sporočilo).not.toContain(GESLO)
    expect(drevo(usb)).toEqual([])
  })

  test('D5 baze ni: kopije ni in nič ni bilo spremenjenega', () => {
    const { dir, dbPath, usb } = pripravi('ros-v182-d5-')
    let sporočilo = ''
    try {
      createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo).toContain('Podatki niso bili spremenjeni')
    expect(existsSync(usb)).toBe(false)
    expect(drevo(dir)).toEqual([])
  })

  test('D6 isti žig dvakrat: druga kopija NE prepisuje prve in ne more prve', () => {
    const { dbPath, usb } = pripravi('ros-v182-d6-')
    closeHandle(seedDb(dbPath, ['kava']))
    const prvi = createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    const prvaVsebina = readFileSync(prvi.file)
    let drugic: Error | null = null
    try {
      createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    } catch (err) {
      drugic = err as Error
    }
    // Odločitev je zapisana: istega imena ne prepisujemo tiho, ampak javimo.
    expect(drugic).not.toBeNull()
    expect(drugic!.message).not.toContain(GESLO)
    expect(readFileSync(prvi.file).equals(prvaVsebina)).toBe(true)
    expect(listOffsiteBundles(usb).length).toBe(1)
  })
})

/* ══════════════ E. Obnova ══════════════ */

describe('v1.182.0 §E — kopija je obnovljiva brez strežnika v obratu', () => {
  function snop(dbPath: string, usb: string, now = NOW) {
    closeHandle(seedDb(dbPath, ['kava', 'rocna']))
    return createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now, allowSameVolume: true })
  }

  test('E1 obnova na PRAZNI napravi: nobene baze ni bilo, po obnovi sta vrstici in WAL', () => {
    const vir = pripravi('ros-v182-e1-')
    const res = snop(vir.dbPath, vir.usb)
    const novaBaza = join(tempDir('ros-v182-e1-cilj-'), 'data', 'restaurantos.db')
    pocistiRočaje()
    const r = restoreFromBundle({ bundlePath: res.file, passphrase: GESLO, dbPath: novaBaza, now: NOW })
    expect(r.journalMode).toBe('wal')
    expect(r.safetyCopy).toBeUndefined()
    const preveri = handle(novaBaza)
    expect(vrstice(preveri)).toEqual(['kava', 'rocna'])
    closeHandle(preveri)
    // "brez strežnika v obratu" pomeni: obnovitev ne potrebuje ničesar razen
    // kontejnerja, gesla in kode — zato kopija sme potovati na samem.
    const sam = tempDir('ros-v182-e1-sam-')
    copyFileSync(res.file, join(sam, 'kopija.rosbak'))
    const baza2 = join(tempDir('ros-v182-e1-cilj2-'), 'data', 'restaurantos.db')
    pocistiRočaje()
    restoreFromBundle({ bundlePath: join(sam, 'kopija.rosbak'), passphrase: GESLO, dbPath: baza2, now: NOW })
    const preveri2 = handle(baza2)
    expect(vrstice(preveri2)).toEqual(['kava', 'rocna'])
    closeHandle(preveri2)
  })

  test('E2 obstoječa baza brez privolitve NE sme biti prepisana', () => {
    const vir = pripravi('ros-v182-e2-')
    const res = snop(vir.dbPath, vir.usb)
    const ciljnaBaza = join(tempDir('ros-v182-e2-cilj-'), 'data', 'restaurantos.db')
    closeHandle(seedDb(ciljnaBaza, ['tuje']))
    pocistiRočaje()
    const predKopijo = readFileSync(ciljnaBaza)
    let sporočilo = ''
    try {
      restoreFromBundle({ bundlePath: res.file, passphrase: GESLO, dbPath: ciljnaBaza, now: NOW })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo).toContain('--force')
    expect(readFileSync(ciljnaBaza).equals(predKopijo)).toBe(true)
    // in z --force JE obnovljena, varnostna kopija prejšnjega stanja pa obstaja
    const r = restoreFromBundle({ bundlePath: res.file, passphrase: GESLO, dbPath: ciljnaBaza, now: NOW, force: true })
    expect(r.safetyCopy).toBeTruthy()
    const preveri = handle(ciljnaBaza)
    expect(vrstice(preveri)).toEqual(['kava', 'rocna'])
    closeHandle(preveri)
  })

  test('E3 napačno geslo: napaka pravi GESLO, ne poskušanega; baza se NE ustvari', () => {
    const vir = pripravi('ros-v182-e3-')
    const res = snop(vir.dbPath, vir.usb)
    const cilj = tempDir('ros-v182-e3-cilj-')
    const ciljnaBaza = join(cilj, 'data', 'restaurantos.db')
    let sporočilo = ''
    try {
      restoreFromBundle({ bundlePath: res.file, passphrase: 'to-ni-pravo-geslo', dbPath: ciljnaBaza, now: NOW })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo.toLowerCase()).toContain('gesl')
    expect(sporočilo).not.toContain('to-ni-pravo-geslo')
    expect(existsSync(ciljnaBaza)).toBe(false)
    expect(drevo(cilj)).toEqual([])
  })

  test('E4 zlonamerna glava: KDF omejitve veljajo PRED derivacijo ključa', () => {
    const vir = pripravi('ros-v182-e4-')
    const res = snop(vir.dbPath, vir.usb)
    const glava = inspectBundle(res.file) as unknown as Record<string, any>
    const surovo = readFileSync(res.file)
    const teleso = surovo.subarray(surovo.indexOf(0x0a) + 1)
    const cilj = join(vir.dir, 'cilj', 'data', 'restaurantos.db')
    const ponaredi = (mutacija: Record<string, unknown>, oznaka: string) => {
      const f = join(vir.dir, `podezelj-${oznaka}.rosbak`)
      writeFileSync(f, Buffer.concat([Buffer.from(JSON.stringify({ ...glava, ...mutacija }) + '\n', 'utf8'), teleso]))
      return f
    }

    const primeri: Array<[Record<string, unknown>, string]> = [
      [{ kdf: { ...glava.kdf, N: 2 ** 20 } }, 'velikN'], // 1 GiB — zavrnjeno pred KDF-om
      [{ kdf: { ...glava.kdf, N: 2 ** 11 } }, 'majhenN'],
      [{ kdf: { ...glava.kdf, N: 12345 } }, 'nePotence'],
      [{ kdf: { ...glava.kdf, r: 1024 } }, 'velikR'],
      [{ cipher: 'aes-128-cbc' }, 'tujenCipher'],
      [{ format: 'ros-offsite-2' }, 'tujenFormat'],
    ]
    for (const [mutacija, oznaka] of primeri) {
      const f = ponaredi(mutacija, oznaka)
      let sporočilo = ''
      try {
        restoreFromBundle({ bundlePath: f, passphrase: GESLO, dbPath: cilj, now: NOW })
      } catch (err) {
        sporočilo = (err as Error).message
      }
      expect(sporočilo.length).toBeGreaterThan(0)
      expect(sporočilo).not.toMatch(/MEMORY_LIMIT/i)
      expect(existsSync(cilj)).toBe(false)
    }
    // enotski pregled: meji sta pisni in veljata sami
    expect(() => validateHeaderKdf({ ...glava, kdf: { ...glava.kdf, N: OFFSITE_KDF_MAX_N } } as never)).not.toThrow()
    expect(() => validateHeaderKdf({ ...glava, kdf: { ...glava.kdf, N: OFFSITE_KDF_MAX_N * 2 } } as never)).toThrow(/KDF/)
  })

  test('E5 porezan kontejner: žig javi poškodbo in ne "napačnega gesla"', () => {
    const vir = pripravi('ros-v182-e5-')
    const res = snop(vir.dbPath, vir.usb)
    const p = join(vir.dir, 'porezan.rosbak')
    const surovo = readFileSync(res.file)
    writeFileSync(p, surovo.subarray(0, surovo.length - 64))
    const cilj = join(vir.dir, 'cilj', 'data', 'restaurantos.db')
    let sporočilo = ''
    try {
      restoreFromBundle({ bundlePath: p, passphrase: GESLO, dbPath: cilj, now: NOW })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo).toMatch(/poškodovan|nepopoln|integrity/)
    expect(existsSync(cilj)).toBe(false)
  })

  test('E6 obnova NE sme zaobiti varovalk iz v1.169.0: aplikacija še teče', () => {
    const vir = pripravi('ros-v182-e6-')
    const res = snop(vir.dbPath, vir.usb)
    const cilj = join(vir.dir, 'cilj', 'data', 'restaurantos.db')
    // Pisec z umazanim repom OSTANE odprt: R2a mora zaznati, da aplikacija še teče.
    const pisec = seedDbWithDirtyWal(cilj)
    let sporočilo = ''
    try {
      restoreFromBundle({ bundlePath: res.file, passphrase: GESLO, dbPath: cilj, now: NOW, force: true })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo).toContain('rep')
    expect(vrstice(pisec)).toEqual(['prva', 'druga', 'samo-v-repu'])
    closeHandle(pisec)
  })

  test('E7 dešifrirana vmesna datoteka NE sme preživeti obnove', () => {
    const vir = pripravi('ros-v182-e7-')
    const res = snop(vir.dbPath, vir.usb)
    const ciljDir = join(vir.dir, 'cilj')
    const cilj = join(ciljDir, 'data', 'restaurantos.db')
    pocistiRočaje()
    restoreFromBundle({ bundlePath: res.file, passphrase: GESLO, dbPath: cilj, now: NOW })
    expect(readdirSync(join(ciljDir, 'data')).filter((f) => !f.endsWith('-shm') && !f.endsWith('-wal'))).toEqual(['restaurantos.db'])
    pocistiRočaje()
  })

  test('E8 napaka, ki NI GCM žig, NE sme biti preimenovana v "napačno geslo"', () => {
    // Veja ni hipotetična: med razvojem te izdaje je `ReferenceError` iz
    // dešifriranja padel v isti `catch` in je bil preimenovan v "geslo ne
    // ustreza". E3 je to spil kot dokazano pravilo, ker je vsaka napaka bila
    // "geslo". Razločevalec torej dobi svoj test, sicer je varovalka neživa.
    expect(jeGcmNapaka('Unsupported state or unable to authenticate data')).toBe(true)
    expect(jeGcmNapaka('unable to authenticate data')).toBe(true)
    for (const tuja of ['ReferenceError: žil is not defined', 'ERR_MEMORY_LIMIT_EXCEEDED', 'Invalid initialization vector', '']) {
      expect(jeGcmNapaka(tuja)).toBe(false)
    }
    // Resničen napačni žig mora priti skozi prvo vejo — dokaz, da klasifikator
    // ne zavrača sporočil, ki jih vidi na tej platformi.
    const vir = pripravi('ros-v182-e8-')
    const res = snop(vir.dbPath, vir.usb)
    const cilj = join(vir.dir, 'cilj', 'data', 'restaurantos.db')
    let sporočilo = ''
    try {
      restoreFromBundle({ bundlePath: res.file, passphrase: 'geslo-drugo-2026', dbPath: cilj, now: NOW })
    } catch (err) {
      sporočilo = (err as Error).message
    }
    expect(sporočilo).toContain('Geslo ne ustreza')
    expect(sporočilo).not.toContain('neznanega razloga')
    expect(sporočilo).not.toContain('geslo-drugo-2026')
    expect(existsSync(cilj)).toBe(false)
  })
})

/* ══════════════ F. ukazna vrstica ══════════════ */

describe('v1.182.0 §F — `bun run local:offsite`', () => {
  function pozeni(skript: string, args: string[], env: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [skript, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, DATABASE_URL: '', ...env },
    })
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '', skupaj: `${r.stdout || ''}${r.stderr || ''}` }
  }

  function zadnjiJson(stdout: string): Record<string, unknown> | null {
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        return JSON.parse(t) as Record<string, unknown>
      } catch {
        /* ne-JSON vrstica pred odgovorom */
      }
    }
    return null
  }

  test('F1 --help: izhod 0 in pove vse vire gesla, nikoli pa samega gesla', () => {
    const r = pozeni(OFFSITE_CLI, ['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--to')
    expect(r.stdout).toContain('--passphrase-file')
    expect(r.stdout).toContain(LOCAL_OFFSITE_PASSPHRASE_ENV)
    expect(r.stdout).toContain('--allow-same-volume')
    expect(r.stdout).toContain('--json')
  })

  test('F2 neznana možnost konča z 2', () => {
    expect(pozeni(OFFSITE_CLI, ['--kaj-ta-ne-pozna']).code).toBe(2)
  })

  test('F3 brez gesla (prazno okolje, brez datoteke) konča z 2 in ne zapiše ničesar', () => {
    const { dir, dbPath, usb } = pripravi('ros-v182-f3-')
    closeHandle(seedDb(dbPath, ['kava']))
    const r = pozeni(OFFSITE_CLI, ['--data-dir', dir, '--to', usb, '--json'], { [LOCAL_OFFSITE_PASSPHRASE_ENV]: '' })
    expect(r.code).toBe(2)
    expect(r.skupaj).not.toContain('kava')
    expect(existsSync(usb)).toBe(false)
  })

  test('F4 isti disk: izhod 1 z razlogom; z --allow-same-volume --json uspe in JAVI resnično stanje', () => {
    const { dir, dbPath, usb } = pripravi('ros-v182-f4-')
    closeHandle(seedDb(dbPath, ['kava']))
    const env = { [LOCAL_OFFSITE_PASSPHRASE_ENV]: GESLO }
    const zavrnjen = pozeni(OFFSITE_CLI, ['--data-dir', dir, '--to', usb, '--json'], env)
    expect(zavrnjen.code).toBe(1)
    expect(zavrnjen.skupaj).toContain('isti disk')
    expect(zavrnjen.skupaj).not.toContain(GESLO)

    const sosnji = pozeni(OFFSITE_CLI, ['--data-dir', dir, '--to', usb, '--allow-same-volume', '--json'], env)
    expect(sosnji.code).toBe(0)
    const json = zadnjiJson(sosnji.stdout)
    expect(json).not.toBeNull()
    expect(json!.ok).toBe(true)
    expect(json!.sameVolume).toBe(true)
    expect(json!.offsite).toBe(false)
    expect(json!.format).toBe(OFFSITE_FORMAT)
    expect(Number(json!.pageCount)).toBeGreaterThan(0)
    expect(sosnji.stdout).not.toContain(GESLO)
  })

  test('F5 geslo iz datoteke: CLI ga prebere, stdout ga ne izpije', () => {
    const { dir, dbPath, usb } = pripravi('ros-v182-f5-')
    closeHandle(seedDb(dbPath, ['kava']))
    const gesloFile = join(dir, 'geslo.txt')
    writeFileSync(gesloFile, GESLO + '\n')
    const r = pozeni(OFFSITE_CLI, ['--data-dir', dir, '--to', usb, '--allow-same-volume', '--passphrase-file', gesloFile, '--json'], {
      [LOCAL_OFFSITE_PASSPHRASE_ENV]: '',
    })
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain(GESLO)
    expect(listOffsiteBundles(usb).length).toBe(1)
  })

  test('F6 obnova kontejnerja prek obstoječega `local:restore --bundle`', () => {
    const vir = pripravi('ros-v182-f6-')
    closeHandle(seedDb(vir.dbPath, ['kava', 'f6']))
    const snopRes = createOffsiteBundle({ dbPath: vir.dbPath, targetDir: vir.usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    const cilj = tempDir('ros-v182-f6-cilj-')
    pocistiRočaje()
    const ok = pozeni(RESTORE_CLI, ['--bundle', snopRes.file, '--data-dir', cilj, '--json'], { [LOCAL_OFFSITE_PASSPHRASE_ENV]: GESLO })
    expect(ok.code).toBe(0)
    expect(zadnjiJson(ok.stdout)!.ok).toBe(true)
    expect(ok.stdout).not.toContain(GESLO)
    const obnovljena = join(cilj, 'data', 'restaurantos.db')
    expect(existsSync(obnovljena)).toBe(true)
    const db = handle(obnovljena)
    expect(vrstice(db)).toEqual(['kava', 'f6'])
    closeHandle(db)
  })

  test('F7 `--bundle` brez gesla je 2, z napačnim geslom 1 in obnovitev ni napisala baze', () => {
    const vir = pripravi('ros-v182-f7-')
    closeHandle(seedDb(vir.dbPath, ['kava']))
    const snopRes = createOffsiteBundle({ dbPath: vir.dbPath, targetDir: vir.usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    pocistiRočaje()
    const cilj = tempDir('ros-v182-f7-cilj-')
    expect(pozeni(RESTORE_CLI, ['--bundle', snopRes.file, '--data-dir', cilj, '--json'], { [LOCAL_OFFSITE_PASSPHRASE_ENV]: '' }).code).toBe(2)
    const napacno = pozeni(RESTORE_CLI, ['--bundle', snopRes.file, '--data-dir', cilj, '--json'], {
      [LOCAL_OFFSITE_PASSPHRASE_ENV]: 'geslo-ki-ne-spada-sem',
    })
    expect(napacno.code).toBe(1)
    expect(napacno.skupaj).not.toContain('geslo-ki-ne-spada-sem')
    expect(existsSync(join(cilj, 'data', 'restaurantos.db'))).toBe(false)
  })

  test('F8 `--to` je obvezen: kopija ne sme tiho pristati v podatkovni mapi', () => {
    const { dir, dbPath } = pripravi('ros-v182-f8-')
    closeHandle(seedDb(dbPath, ['kava']))
    const r = pozeni(OFFSITE_CLI, ['--data-dir', dir, '--json'], { [LOCAL_OFFSITE_PASSPHRASE_ENV]: GESLO })
    expect(r.code).toBe(2)
    expect(drevo(dir).filter((f) => f.endsWith(LOCAL_OFFSITE_EXT))).toEqual([])
  })
})

/* ══════════════ G. trajnost po obnovi (povzetek pouka iz v1.169.0) ══════════════ */

describe('v1.182.0 §G — obnovljena baza je takoj obratno sposobna', () => {
  test('G1 `journal_mode` je ob obnovi `wal` in ŽIVI v datoteki; pragma vez na povezavo se ne zahteva', () => {
    const { dbPath, usb } = pripravi('ros-v182-g1-')
    closeHandle(seedDb(dbPath, ['kava']))
    const res = createOffsiteBundle({ dbPath, targetDir: usb, passphrase: GESLO, now: NOW, allowSameVolume: true })
    const nova = join(tempDir('ros-v182-g1-cilj-'), 'data', 'restaurantos.db')
    pocistiRočaje()
    restoreFromBundle({ bundlePath: res.file, passphrase: GESLO, dbPath: nova, now: NOW })
    // Nova povezava, ki NIE nastavila pragmov: `journal_mode` mora biti wal,
    // ker živi v glavi datoteke. `busy_timeout`/`synchronous` sta lastni
    // vrednosti sveže povezave (izmerjeno 0 oziroma 2) in ju test NE zahteva.
    const db = handle(nova)
    const stanje = String((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toLowerCase()
    closeHandle(db)
    expect(stanje).toBe('wal')
    // Druga povezava do istega rezultata z uradnim bralcem stanja:
    expect(applyDurability(nova).journalMode).toBe('wal')
  })
})
