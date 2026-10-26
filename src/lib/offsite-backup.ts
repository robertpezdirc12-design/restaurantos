/**
 * v1.182.0 — šifrirana kopija IZVEN diska (PRD docs/PRD-LOKALNA-BAZA.md, R5:
 * "kopija obnovljiva brez strežnika v obratu").
 *
 * Kaj ta modul DODA in kaj NE:
 *  - doda: odsek, ki gre NA DRUG MEDIJ (USB, zunanji disk, omrežna mapa) in je
 *    šifriran, ker medij potuje izven obrata;
 *  - doda: obnovo iz takega kontejnerja na napravi, ki baze še nikoli ni imela;
 *  - NE doda: prenosa v oblak. Produkcijska baza ne obstaja (Neon je na kvoti),
 *    samodejna pošiljka pa bi bila nov izhod podatkov, ki ga nihče ni
 *    preizkusil — to ostane R5b brez številke.
 *
 * Zakaj je kopiji zaupano šele potem, ko je preverjena trikrat:
 *  1. `VACUUM INTO` — isti mehanizem kot v1.169.0 (navaden prekop čez umazan rep
 *     izgubi zadnji potrjeni zapis, izmerjeno 2 od 3 vrstic);
 *  2. `PRAGMA integrity_check` nad jasnim odsekom, PRED šifriranjem;
 *  3. kontejner se prebere S DISKA, dešifrira in primerja po žigu SHA-256 z
 *     odsekom, ki smo ga šifrirali. Šifriranje, ki ga ni mogoče obrniti, ni
 *     varnostna kopija ampak trajen izbris.
 *
 * Meritve, ki so določile obliko (bun 1.4.3, Windows):
 *  - `fs.statfsSync()` vrne `fsid: undefined` in `type: 0` za katerokoli pot,
 *    zato volumen ločuje `fs.statSync().dev` (C:=3059246764, D:=947176493,
 *    E:=779618308); `ino` je na vseh korenih enak in ne pomeni ničesar;
 *  - `crypto.scryptSync` z `N=2^15` potrebuje 128·N·r = 32 MiB točno, kar je
 *    meja BoringSSL-ovega privzetega `maxmem`: izmerjeno ENKRAT uspe (51 ms),
 *    drugič pade z `MEMORY_LIMIT_EXCEEDED`. Zato se `maxmem` RAČUNA (2× potrebe)
 *    in omeji navzgor, da tuj kontejner ne more zahtevati gigabajtov;
 *  - AES-256-GCM čez živo bazo 3 682 304 B: 25 ms šifriranja, 26 ms dešifriranja
 *    — celoten medij v pomnilnik je cenejši od pretočnega razčlenjevalnika, ki
 *    bi bil prva točka napake.
 *
 * Geslo:
 *  - nikoli ne gre v `argv`: seznam procesov ga izda vsakemu `Get-CimInstance`
 *    in vsaka lupina ga shrani v zgodovino;
 *  - živi v okolju `RESTAURANTOS_OFFSITE_PASSPHRASE` ali v datoteki, ki jo
 *    preberemo enkrat;
 *  - ne pojavi se v kontejnerju, v glavi, v dnevniku, v izpisu ali v imenu
 *    datoteke;
 *  - preberemo ga BREZ stisanja: vodilni in prikonci presledki so del gesla,
 *    sicer naslednjič "pravo" geslo ne ustreza.
 *
 * Moč kopije = moč gesla. Izmerjeno 26. 10. 2026 na tej napravi (pet zaporednih
 * izpeljav pri N=32768): 89–139 ms, povprečje 102 ms, torej ~10 poskusov na sekundo
 * na eni sledi. Kratko, PIN-ju podobno geslo na ključku, ki
 * pade v tuje roke, NI varno. To je zapisano, ker ga je treba vedeti, ne zato,
 * da bi s tem kaj odšteli.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { restoreDatabase, snapshotInto, verifyBackup, type RestoreResult } from './local-durability'

export const LOCAL_OFFSITE_PREFIX = 'dalec-'
export const LOCAL_OFFSITE_EXT = '.rosbak'
export const LOCAL_MAX_OFFSITE_BUNDLES = 8
export const LOCAL_OFFSITE_MIN_PASSPHRASE = 12
export const LOCAL_OFFSITE_PASSPHRASE_ENV = 'RESTAURANTOS_OFFSITE_PASSPHRASE'

export const OFFSITE_FORMAT = 'ros-offsite-1'
export const OFFSITE_CIPHER = 'aes-256-gcm'
export const LOCAL_OFFSITE_KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 } as const

/** Meje, ki jih sme ZAHTIJEVATI glava tujega kontejnerja (napad na pomnilnik). */
export const OFFSITE_KDF_MIN_N = 16384
export const OFFSITE_KDF_MAX_N = 131072
export const OFFSITE_KDF_MEM_CEILING = 268_435_456
export const OFFSITE_HEADER_MAX_BYTES = 8192

const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
/** Prazna SQLite baza je ena stran (512 B ali več); krajše ni kopija ampak odrezek. */
const MIN_VALID_COPY_BYTES = 512

export interface OffsiteKdf {
  name: string
  N: number
  r: number
  p: number
}

export interface OffsiteHeader {
  format: typeof OFFSITE_FORMAT
  cipher: typeof OFFSITE_CIPHER
  kdf: OffsiteKdf
  salt: string
  iv: string
  tag: string
  createdAt: string
  appVersion: string
  pageCount: number
  cipherBytes: number
}

export interface OffsiteResult {
  file: string
  created: true
  format: typeof OFFSITE_FORMAT
  bytes: number
  pageCount: number
  sourceBytes: number
  appVersion: string
  createdAt: string
  /** `null` pomeni, da naprave nista primerljivi — in to JE treba javiti. */
  sameVolume: boolean | null
  /** Resnična trditev: kopija je dokazano na drugem volumnu. */
  offsite: boolean
  sourceDevice: number | null
  targetDevice: number | null
  pruned: number
}

export interface CreateOptions {
  dbPath: string
  targetDir: string
  passphrase: string
  now?: Date
  appVersion?: string
  allowSameVolume?: boolean
  maxBundles?: number
  /** Meja velikosti odseka (USB ključek je lahko majhen). 0 ali odsotno = meja ni. */
  maxBytes?: number
}

export interface RestoreBundleOptions {
  bundlePath: string
  passphrase: string
  dbPath: string
  now?: Date
  force?: boolean
}

export type OffsiteRestoreResult = RestoreResult & { fromBundle: string; format: typeof OFFSITE_FORMAT }

type StatLike = (p: string) => { dev: number | bigint }
const realStat: StatLike = (p) => statSync(p)

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-')

export function offsiteNameFor(now: Date): string {
  return `${LOCAL_OFFSITE_PREFIX}${stamp(now)}${LOCAL_OFFSITE_EXT}`
}

// ── volumen ──────────────────────────────────────────────────────────────────

/**
 * `dev` je edina izmerjena veljavna oznaka volumna pod `bun` na Windows. Vrne
 * `null`, če poti ni mogoče prebrati; klic jo mora javiti kot NEPOZNANO in ne
 * kot "drug disk".
 */
export function deviceOf(p: string, stat: StatLike = realStat): number | null {
  try {
    const dev = Number(stat(p).dev)
    return Number.isFinite(dev) ? dev : null
  } catch {
    return null
  }
}

export function sameVolume(a: string, b: string, stat: StatLike = realStat): boolean | null {
  const devA = deviceOf(a, stat)
  const devB = deviceOf(b, stat)
  if (devA === null || devB === null) return null
  return devA === devB
}

/**
 * Ciljna mapa je lahko še NAREJENA (ustvari jo ta koda). Najbližji OBSTEJOČ
 * prednik je torej tisto, kar je sploh mogoče primerjati — sicer bi bila vsaka
 * nova mapa "nepoznana" in nobena kopije ne bi mogla biti zavrnjena.
 */
function nearestDevice(p: string, stat: StatLike = realStat): number | null {
  let current = path.resolve(p)
  for (let korak = 0; korak < 12; korak++) {
    if (existsSync(current)) return deviceOf(current, stat)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

// ── geslo ────────────────────────────────────────────────────────────────────

/** Samo EN končnik (CRLF ali LF) — ničesar več, da geslo ni tiho spremenjeno. */
function odstrižiKončnik(vrednost: string): string {
  if (vrednost.endsWith('\r\n')) return vrednost.slice(0, -2)
  if (vrednost.endsWith('\n')) return vrednost.slice(0, -1)
  return vrednost
}

export function readPassphraseFromEnv(
  env: Record<string, string | undefined> = process.env,
  name = LOCAL_OFFSITE_PASSPHRASE_ENV,
): string | null {
  const value = env[name]
  if (value === undefined || value === '') return null
  return value.trim() === '' ? null : value
}

export function readPassphraseFromFile(file: string): string {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`[local] Branje gesla iz datoteke ${file} ni uspelo; kopije ni bilo mogoče narediti in podatki niso bili spremenjeni.`)
  }
  return odstrižiKončnik(raw)
}

function zahtevajGeslo(passphrase: string): void {
  if (passphrase.trim() === '') {
    throw new Error('[local] Prazno geslo (ali samo presledki) ni dovoljeno; kopije ni bilo mogoče narediti in podatki niso bili spremenjeni.')
  }
  if (passphrase.length < LOCAL_OFFSITE_MIN_PASSPHRASE) {
    throw new Error(
      `[local] Geslo je prekratko: zahtevanih je najmanj ${LOCAL_OFFSITE_MIN_PASSPHRASE} znakov, to jih ima ${passphrase.length}. Kopije ni bilo mogoče narediti in podatki niso bili spremenjeni.`,
    )
  }
}

/**
 * Pomnilnik, ki ga KDF res potrebuje, z varnostnim faktorjem 2 in absolutno
 * mejo. Izrecno se poslje v `scryptSync`, ker je privzeta meja BoringSSL-a
 * izmerjena na pragu (N=2^15 = 32 MiB točno) in odvisna od stanja procesa.
 */
export function maxmemFor(N: number, r: number, p: number): number {
  const potreb = 128 * N * r * p
  return Math.min(potreb * 2, OFFSITE_KDF_MEM_CEILING)
}

const jePotencaDveh = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0

/** Preveri SAMO KDF dele glave — meje veljajo PRED derivacijo, ne namesto nje. */
export function validateHeaderKdf(header: { kdf?: unknown }): void {
  const kdf = header.kdf as Partial<OffsiteKdf> | undefined
  if (!kdf || typeof kdf !== 'object' || kdf.name !== 'scrypt') {
    throw new Error('[local] Kontejner navaja neznan KDF; izročila se ne znam dešifrirati.')
  }
  const { N, r, p } = kdf
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number') {
    throw new Error('[local] KDF parametri v glavi kontejnerja niso števila.')
  }
  if (!jePotencaDveh(N) || N < OFFSITE_KDF_MIN_N || N > OFFSITE_KDF_MAX_N) {
    throw new Error(
      `[local] KDF parameter N=${N} je izven dovoljenih mej (potence števila 2 med ${OFFSITE_KDF_MIN_N} in ${OFFSITE_KDF_MAX_N}); kontejner je zavrnjen pred derivacijo ključa.`,
    )
  }
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 8) {
    throw new Error(`[local] KDF parametra r=${r} ali p=${p} sta izven dovoljenih mej (1..16 oziroma 1..8).`)
  }
  if (128 * N * r * p > OFFSITE_KDF_MEM_CEILING) {
    throw new Error('[local] KDF parametri zahtevajo več pomnilnika, kot mu ga dovolim.')
  }
}

export function deriveKey(passphrase: string, salt: Buffer, kdf: OffsiteKdf = { ...LOCAL_OFFSITE_KDF }): Buffer {
  zahtevajGeslo(passphrase)
  validateHeaderKdf({ kdf })
  if (salt.length !== SALT_BYTES) throw new Error('[local] Sol kontejnerja ni dolga 16 bajtov.')
  return scryptSync(passphrase, salt, KEY_BYTES, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: maxmemFor(kdf.N, kdf.r, kdf.p) })
}

// ── glava ────────────────────────────────────────────────────────────────────

const dolzinaBase64 = (vrednost: unknown): number | null => {
  if (typeof vrednost !== 'string' || vrednost.length === 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(vrednost)) return null
  try {
    return Buffer.from(vrednost, 'base64').length
  } catch {
    return null
  }
}

function preveriGlavo(nepoznano: unknown): OffsiteHeader {
  if (!nepoznano || typeof nepoznano !== 'object') throw new Error('[local] Glava kontejnerja ni objekt.')
  const g = nepoznano as Record<string, unknown>
  if (g.format !== OFFSITE_FORMAT) throw new Error(`[local] Kontejner je oblike ${String(g.format)}, ta izdaja pa bere samo ${OFFSITE_FORMAT}.`)
  if (g.cipher !== OFFSITE_CIPHER) throw new Error(`[local] Kontejner pravi, da je šifriran z ${String(g.cipher)}, jaz pa poznam samo ${OFFSITE_CIPHER}.`)
  if (dolzinaBase64(g.salt) !== SALT_BYTES) throw new Error('[local] Sol v glavi kontejnerja ni veljavna.')
  if (dolzinaBase64(g.iv) !== IV_BYTES) throw new Error('[local] Vektor v glavi kontejnerja ni veljaven.')
  if (dolzinaBase64(g.tag) !== TAG_BYTES) throw new Error('[local] Žig v glavi kontejnerja ni veljaven.')
  if (typeof g.cipherBytes !== 'number' || !Number.isInteger(g.cipherBytes) || g.cipherBytes < MIN_VALID_COPY_BYTES) {
    throw new Error('[local] Glava kontejnerja navaja smešno dolžino šifriranega dela.')
  }
  if (typeof g.pageCount !== 'number' || !Number.isInteger(g.pageCount) || g.pageCount < 1) {
    throw new Error('[local] Glava kontejnerja navaja smešno število strani.')
  }
  if (typeof g.createdAt !== 'string' || Number.isNaN(Date.parse(g.createdAt))) {
    throw new Error('[local] Glava kontejnerja nima veljavnega časa nastanka.')
  }
  if (typeof g.appVersion !== 'string') throw new Error('[local] Glava kontejnerja nima različice.')
  validateHeaderKdf({ kdf: g.kdf })
  return g as unknown as OffsiteHeader
}

export function parseHeader(kontejner: Buffer): OffsiteHeader {
  const konecVrstice = kontejner.indexOf(0x0a)
  if (konecVrstice < 0) throw new Error('[local] Kontejner nima glave (manjka ločilna vrstica).')
  if (konecVrstice > OFFSITE_HEADER_MAX_BYTES) throw new Error('[local] Glava kontejnerja je predolga.')
  let jasna: unknown
  try {
    jasna = JSON.parse(kontejner.subarray(0, konecVrstice).toString('utf8'))
  } catch {
    throw new Error('[local] Glava kontejnerja ni veljaven JSON.')
  }
  return preveriGlavo(jasna)
}

export function inspectBundle(file: string): OffsiteHeader {
  if (!existsSync(file)) throw new Error(`[local] Kontejnerja ${file} ni.`)
  return parseHeader(readFileSync(file))
}

// ── seznam in zadrževanje ────────────────────────────────────────────────────

const OFFSITE_NAME_RE = new RegExp(`^${LOCAL_OFFSITE_PREFIX}.+\\${LOCAL_OFFSITE_EXT}$`)

export function listOffsiteBundles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((ime) => OFFSITE_NAME_RE.test(ime))
    .sort()
}

/**
 * Pobriše SAMO lastne kontejnerje (predpona + končnica + ISO žig). Tujih
 * datotek na ključku ne sme dotakniti enako, kot jih ne sme `pruneErrorLogs`.
 */
export function pruneOffsiteBundles(dir: string, max: number): string[] {
  const imena = listOffsiteBundles(dir)
  const odstranjena: string[] = []
  for (const ime of imena.slice(0, Math.max(0, imena.length - max))) {
    rmSync(path.join(dir, ime), { force: true })
    odstranjena.push(ime)
  }
  return odstranjena
}

// ── ustvarjanje ──────────────────────────────────────────────────────────────

const jasnaPot = (targetDir: string, zdaj: Date) => path.join(targetDir, `.zacasna-${stamp(zdaj)}.db`)
const delnaPot = (targetDir: string, zdaj: Date) => path.join(targetDir, `.delna-${stamp(zdaj)}${LOCAL_OFFSITE_EXT}`)

export function createOffsiteBundle(opts: CreateOptions): OffsiteResult {
  const now = opts.now ?? new Date()
  const appVersion = opts.appVersion ?? 'neznana'
  const maxBundles = opts.maxBundles ?? LOCAL_MAX_OFFSITE_BUNDLES
  const maxBytes = opts.maxBytes ?? 0
  const targetDir = path.resolve(opts.targetDir)
  const dbPath = path.resolve(opts.dbPath)

  // 1) Geslo in baza morata biti veljavna, PREDEN nastane kaka mapa: kopija, ki
  //    jo zavrnemo, ne sme pustiti sledi na tujem disku.
  zahtevajGeslo(opts.passphrase)
  if (!existsSync(dbPath)) {
    throw new Error(`[local] Baze ${dbPath} ni, zato šifrirane kopije ni bilo mogoče narediti. Podatki niso bili spremenjeni.`)
  }

  // 2) volumen
  const sourceDevice = deviceOf(dbPath)
  const targetDevice = nearestDevice(targetDir)
  const same = sourceDevice === null || targetDevice === null ? null : sourceDevice === targetDevice
  if (same === true && !opts.allowSameVolume) {
    throw new Error(
      `[local] Ciljna mapa ${targetDir} je na volumnu ${String(targetDevice)} — to je isti disk kot baza. Kopija na istem disku ne zavaruje pred okvaro diska; če jo vseeno želiš, potrdi z --allow-same-volume. Podatki niso bili spremenjeni.`,
    )
  }

  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  const file = path.join(targetDir, offsiteNameFor(now))
  if (existsSync(file)) {
    throw new Error(
      `[local] Kontejner ${path.basename(file)} že obstaja in ga ne prepišem. Počakaj na naslednji žig ali izberi drugo mapo. Podatki niso bili spremenjeni.`,
    )
  }
  const jasna = jasnaPot(targetDir, now)
  const delna = delnaPot(targetDir, now)

  try {
    // 3) Odsek sme obstajati SAMO na ciljnem mediju, nikoli na sistemu disku
    //    obrata — zato tudi začasna datoteka nastane v `targetDir`.
    snapshotInto(dbPath, jasna)
    const preverjen = verifyBackup(jasna)
    const sourceBytes = statSync(jasna).size
    if (maxBytes > 0 && sourceBytes > maxBytes) {
      throw new Error(`[local] Odsek zavzema ${sourceBytes} B, dovoljena meja pa je bila ${maxBytes} B; kopija je bila pobrisana, baza je nedotaknjena.`)
    }

    // 4) Šifriranje
    const vsebina = readFileSync(jasna)
    const sol = randomBytes(SALT_BYTES)
    const iv = randomBytes(IV_BYTES)
    const kljuc = deriveKey(opts.passphrase, sol)
    const sifrir = createCipheriv(OFFSITE_CIPHER, kljuc, iv)
    const teleso = Buffer.concat([sifrir.update(vsebina), sifrir.final()])
    const tagBuf = sifrir.getAuthTag()
    const glava: OffsiteHeader = {
      format: OFFSITE_FORMAT,
      cipher: OFFSITE_CIPHER,
      kdf: { ...LOCAL_OFFSITE_KDF },
      salt: sol.toString('base64'),
      iv: iv.toString('base64'),
      tag: tagBuf.toString('base64'),
      createdAt: now.toISOString(),
      appVersion,
      pageCount: preverjen.pageCount,
      cipherBytes: teleso.length,
    }
    writeFileSync(delna, Buffer.concat([Buffer.from(`${JSON.stringify(glava)}\n`, 'utf8'), teleso]), { mode: 0o600 })

    // 5) Krožek ČEZ DISK: kar smo zapisali, se mora vrniti identično. Brez tega
    //    koraka bi bil kontejner lahko neuporaben, mi pa bi rekli "✔".
    let izpisVrnjen: Buffer
    try {
      izpisVrnjen = dešifrirajKontejner(readFileSync(delna), opts.passphrase)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`[local] Kontejner ${path.basename(delna)} po zapisu ni več berljiv (${message}). Ni bil shranjen.`)
    }
    if (createHash('sha256').update(izpisVrnjen).digest('hex') !== createHash('sha256').update(vsebina).digest('hex')) {
      throw new Error('[local] Dešifrirani odsek se ne ujema z izvirnikom; kontejner je bil zavrnjen in ni bil shranjen.')
    }
    renameSync(delna, file)
    const pruned = pruneOffsiteBundles(targetDir, maxBundles)
    return {
      file,
      created: true,
      format: OFFSITE_FORMAT,
      bytes: statSync(file).size,
      pageCount: preverjen.pageCount,
      sourceBytes,
      appVersion,
      createdAt: glava.createdAt,
      sameVolume: same,
      offsite: same === false,
      sourceDevice,
      targetDevice,
      pruned: pruned.length,
    }
  } catch (err) {
    izbrišiZačasne([jasna, delna])
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('[local]')) throw err
    throw new Error(`[local] Šifrirane kopije ni bilo mogoče narediti (${message}). Podatki v bazi niso bili spremenjeni.`)
  } finally {
    izbrišiZačasne([jasna, delna])
  }
}

function izbrišiZačasne(poti: string[]): void {
  for (const p of poti) {
    rmSync(p, { force: true })
    // `VACUUM INTO` sicer zapiše ENO samo datoteko, a repa ne puščamo nikoli.
    rmSync(`${p}-wal`, { force: true })
    rmSync(`${p}-shm`, { force: true })
  }
  const runtime = globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }
  runtime.Bun?.gc?.(true)
}

// ── dešifriranje ─────────────────────────────────────────────────────────────

/**
 * GCM pozna samo ENO sporočilno vejo: žig se ne ujema. Vse ostalo je napaka v
 * kodi ali v okolju in bi jo preimenovanje v "napačno geslo" skrilo — se je
 * med razvojem te izdaje tudi zgodilo, zato ima klasifikator svoj test (E8).
 */
export function jeGcmNapaka(sporočilo: string): boolean {
  return /unable to authenticate|Unsupported state|bad decrypt|authentication tag/i.test(sporočilo)
}

function dešifrirajKontejner(kontejner: Buffer, passphrase: string): Buffer {
  const glava = parseHeader(kontejner)
  // Imena za šifirni material so NAMERANO ASCII: dva zapisa črke s strešico sta
  // v urejevalniku videti enako, a različna. Take razlike se pokažejo šele ob
  // branju kopije — torej tedaj, ko jo potrebujemo.
  const saltBuf = Buffer.from(glava.salt, 'base64')
  const ivBuf = Buffer.from(glava.iv, 'base64')
  const tagBuf = Buffer.from(glava.tag, 'base64')
  const teleso = kontejner.subarray(kontejner.indexOf(0x0a) + 1)
  if (teleso.length !== glava.cipherBytes) {
    throw new Error(
      `[local] Kontejner je nepopoln: glava obljublja ${glava.cipherBytes} B, datoteka jih ima ${teleso.length}. Kopija je bila prekinjena ali porezana; dešifriranja ni bilo začeto.`,
    )
  }
  const kljuc = deriveKey(passphrase, saltBuf, glava.kdf)
  let jasno: Buffer
  try {
    const dekoder = createDecipheriv(OFFSITE_CIPHER, kljuc, ivBuf)
    dekoder.setAuthTag(tagBuf)
    jasno = Buffer.concat([dekoder.update(teleso), dekoder.final()])
  } catch (err) {
    const sporočilo = err instanceof Error ? err.message : String(err)
    if (!jeGcmNapaka(sporočilo)) {
      throw new Error(
        `[local] Dešifriranje kontejnerja ni uspelo iz neznanega razloga (${sporočilo}). Baza ni bila spremenjena in dešifrirane datoteke ni bilo zapisane.`,
      )
    }
    throw new Error(
      '[local] Geslo ne ustreza ali je kontejner poškodovan: žig (GCM tag) se ne ujema. Baza ni bila spremenjena in dešifrirane datoteke ni bilo zapisane.',
    )
  }
  return jasno
}

// ── obnova ───────────────────────────────────────────────────────────────────

/**
 * Obnova iz kontejnerja JE isti korak kot R2a, z enim dodatnim vhodom:
 * najprej dešifriramo V POMNILNIKU (napačno geslo torej ne sme zapisati
 * ničesar na cilj), nato datoteko predamo preizkušenemu `restoreDatabase`. Ta
 * odloči, ali sme prepisati, naredi varnostno kopijo stanja in preveri rep —
 * R5a nobene od tistih prever ne zaobide, ker nima svoje obnove.
 */
export function restoreFromBundle(opts: RestoreBundleOptions): OffsiteRestoreResult {
  const now = opts.now ?? new Date()
  const bundlePath = path.resolve(opts.bundlePath)
  const dbPath = path.resolve(opts.dbPath)
  if (!existsSync(bundlePath)) throw new Error(`[local] Kontejnerja ${bundlePath} ni. Obnova se ni začela in baza ni bila spremenjena.`)

  const surovo = readFileSync(bundlePath)
  const razkodirano = dešifrirajKontejner(surovo, opts.passphrase)

  const začasna = `${dbPath}.odkodirana.tmp`
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    writeFileSync(začasna, razkodirano, { mode: 0o600 })
    const rezultat = restoreDatabase({ backupPath: začasna, dbPath, now, force: opts.force })
    return { ...rezultat, fromBundle: bundlePath, format: OFFSITE_FORMAT }
  } finally {
    izbrišiZačasne([začasna])
  }
}

/** Opozorilo za CLI: kopija, ki ni dokazano na drugem mediju, je še vedno en disk. */
export function offsiteWarning(res: { sameVolume: boolean | null }): string | null {
  if (res.sameVolume === true) return 'Kopija je na istem disku kot baza — pred okvaro diska ne zavaruje ničesar.'
  if (res.sameVolume === null) return 'Volumena ciljne mape in baze ni bilo mogoče primerjati; ročno preveri, da kopija res stoji na drugem mediju.'
  return null
}
