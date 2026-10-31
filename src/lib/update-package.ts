/**
 * v1.217.0 — R4b del 2: PODPISANI PAKET NADGRADNJE (PRD docs/PRD-LOKALNA-BAZA.md
 * §8, R4b: »podpisani paket«).
 *
 * Kontekst: v1.216.0 (R4b del 1) je prinesel OBVEŠČANJE o novi različici
 * (primerjava z javnim healthom oblaka) in v mejah eksplicitno zapisal, da je
 * »pred podpisanim paketom to obveščanje, ne varnostna meja«. Ta val je ta
 * ostanek — kot ORODJE, ne kot avtoriteta: program sam ne more izdati zaupanja
 * vrednega paketa, ker ključ pripada lastniku (PRD §13: »nobene od njiju ne
 * more izdati program sam«). Kar pa program ZMORE in kar ta sloj dela:
 *  - generirati par ključev (`local:keygen`) — lastnikovo dejanje, enkrat;
 *  - ZGRADITI in podpisati paket vira (`local:package`) — na gradbeni napravi;
 *  - PREVERITI podpis + celovitost vsake datoteke (`local:package-verify`);
 *  - NADGRADITI namestitev iz preverjenega paketa (`local:package-apply`) —
 *    z varnostno kopijo zamenjane kode, varovalko tečeče aplikacije in
 *    povratno razveljavitev ob napaki sredi zamenjave (vse ali nič).
 *
 * POŠTENOST meja (zapisano, ker je treba vedeti):
 *  - BREZ lastnikovega ključa ni podpisa niti preverbe — orodje takrat ne
 *    podeljuje ničesar, to pa je edino pošteno stanje. Ključ je lastnikov vnos
 *    (okolje/datoteka), isti vzorec kot geslo R5a in SMTP/WhatsApp transporte;
 *  - javni ključ v namestitvi je SIDRO ZAUPANJA na ravni lokalne datoteke —
 *    ščiti paket na poti (USB, omrežje), ne pa naprave, na kateri javni ključ
 *    sam leži; kdor zamenja datoteko signing.pub, zamenja sidro (dokumentirano
 *    v LOKALNI-ZAGON §7);
 *  - prenos paketa je ROČEN (isti medij kot R5a) — oblak ostaja R5b;
 *  - nadgradnja še vedno ni samodejna: po zamenjavi kode lastnik izvede tri
 *    ukaze recepta (install → migrate → build), ki so že dokumentirani.
 *
 * Zrcaljenje vzorcev (izmerjeno, ne ugibano):
 *  - kontejner po vzorcu R5a (offsite-backup.ts): JSON glava v eni vrstici +
 *    \n + binarno telo; roundtrip preverba PO zapisu (kar smo zapisali, se mora
 *    prebrati in preveriti, preden rečemo ✔);
 *  - različica po vzorcu v1.216.0 (update-check.ts): SAMO številska trojka,
 *    ena resnica o razčlenjevanju (parseAppVersion/compareAppVersions) — ta
 *    sloj ne dela lastnega parserja, ker bi bil drift;
 *  - DER pisma Ed25519 sta izmerjena v peskovniku (bun 1.4): PKCS8 predpona
 *    302e020100300506032b657004220420 + 32B seme; SPKI predpona
 *    302a300506032b6570032100 + 32B javni del. Podpis = 64 B (RFC 8032,
 *    determinističen — enaka vlakna dajejo enak podpis, kar je merljivo);
 *  - gzip je v bun/node DETERMINISTIČEN (izmerjeno: enaki vhodi → enaki bajti),
 *    zato je mogoče obljaviti: enak vir + enak ključ + enak čas = enak paket.
 *
 * Oblika paketa (ros-pkg-1):
 *   vrstica 1:  JSON glava + '\n'        (brez podpisa — podpis je rep)
 *   telo:       gzip(zloženka vsebin datotek v vrstnem redu manifesta)
 *   rep:        64 bajtov podpisa Ed25519 nad (glava + '\n' + telo)
 * Podpis torej pokrije TOČNO bajte, kot so zapisani — nobena kanonizacija ni
 * potreben in nobena preureditev glave ne more uiti. Manifest v glavi nosi
 * sha256 posamezne datoteke, ker ga apply rabi za ponovno preverbo NA DISKU
 * po zamenjavi (ista disciplina kot R5a točka 3: zapis, ki ga ni mogoče
 * preveriti, ni zapis ampak tvegana izguba).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { compareAppVersions, parseAppVersion } from './update-check'

// ── konstante ────────────────────────────────────────────────────────────────

export const UPDATE_PKG_FORMAT = 'ros-pkg-1'
export const UPDATE_PKG_EXT = '.rospkg'
export const UPDATE_PKG_SIG_ALG = 'ed25519'
export const UPDATE_PKG_PREFIX = 'restaurantos-'

/** Ed25519 podpis je vedno točno 64 bajtov (RFC 8032). */
export const UPDATE_PKG_SIG_BYTES = 64

/** Seme zasebnega ključa in javni ključ sta vsak točno 32 bajtov. */
export const ED25519_SEED_BYTES = 32
export const ED25519_PUB_BYTES = 32

/** Izmerjeni DER predponi (bun 1.4 peskovnik, openssl zlogovni vrstni red). */
export const ED25519_PKCS8_PREFIX_HEX = '302e020100300506032b657004220420'
export const ED25519_SPKI_PREFIX_HEX = '302a300506032b6570032100'

export const SIGNING_KEY_ENV = 'RESTAURANTOS_SIGNING_KEY'
export const SIGNING_PUB_ENV = 'RESTAURANTOS_SIGNING_PUBKEY'

/** Imeni datotek, ki ju dela `local:keygen` (v mapi po meri). */
export const SIGNING_KEY_FILE = 'signing.key'
export const SIGNING_PUB_FILE = 'signing.pub'

/** Privzeti mapi: ključi v repo (gradbena naprava), paketi v izhodno mapo. */
export const SIGNING_KEYS_DIR = 'signing-keys'
export const DIST_PACKAGES_DIR = 'dist-packages'

/** Zadrževanih varnostnih kopij stare kode po apply (mapa .ros-update-backup-*). */
export const UPDATE_BACKUP_PREFIX = '.ros-update-backup-'
export const UPDATE_MAX_CODE_BACKUPS = 3

/**
 * Meji paketa. Izmerjena osnova tega repozitorija @ v1.217.0: 623 datotek,
 * ~10,2 MB vsebine (src 8,1 MB + public 1,3 MB + prisma 0,6 MB + scripts
 * 0,25 MB + 7 korenskih datotek). Meji sta s 12×/25× rezervo — nanjo pa je
 * VSAK paket ob preverbi ponovko izmerjen in zavrnjen, ker meja, ki se ne
 * preverja, ni meja.
 */
export const UPDATE_PKG_MAX_FILES = 8000
export const UPDATE_PKG_MAX_CONTENT_BYTES = 268_435_456

/** Meja dolžine poti v manifestu (relativna, s poševnicami naprej). */
export const UPDATE_PKG_PATH_MAX = 200

/** Največja dolžina glave (manifest 8000 × ~90 znakov ne more biti pod njo). */
export const UPDATE_PKG_HEADER_MAX_BYTES = 1_048_576

/**
 *  - vsebina paketa = ogledalo Dockerfile COPY seznama (izmerjena resnica o
 *    tem, kaj aplikacija potrebuje) + celoten deploy/ (3 datoteke — mešan
 *    checkout, ki se posodablja s paketi, ne sme nositi starega Dockerfile-a);
 *    .env, baza, node_modules, .next, testi in dokumenti NISO del paketa —
 *    namestitev ima svoj .env in svojo bazo, testi pa niso obratovalna koda.
 */
export const UPDATE_PKG_ROOT_FILES = [
  'package.json',
  'bun.lock',
  'next.config.ts',
  'tsconfig.json',
  'components.json',
  'postcss.config.mjs',
  'tailwind.config.ts',
] as const
export const UPDATE_PKG_ROOT_DIRS = ['prisma', 'public', 'src', 'scripts', 'deploy'] as const

/** Pripone, ki v paket NE smejo priti nikoli — baza ni vir (izmerjena past: prisma/dev.db obstaja na disku razvojnega odjemalca, v gitu pa ni). */
const FORBIDDEN_SUFFIXES = ['.db', '.db-journal', '.db-wal', '.db-shm'] as const

// ── tipi ─────────────────────────────────────────────────────────────────────

export interface UpdatePkgFile {
  /** Relativna pot s POŠEVNICAMI naprej (nikoli poševnica nazaj, nikoli absolutna). */
  path: string
  size: number
  sha256: string
}

export interface UpdatePackageHeader {
  format: typeof UPDATE_PKG_FORMAT
  sig: typeof UPDATE_PKG_SIG_ALG
  version: string
  createdAt: string
  fileCount: number
  /** Vsota velikosti datotek (nezgoščena vsebina). */
  contentBytes: number
  /** Dolžina gzip telesa, kot je zapisanega v datoteki. */
  bodyBytes: number
  /** Prvih 8 bajtov sha256 javnega ključa (hex) — namig, NE dokaz. */
  keyHint: string
  files: UpdatePkgFile[]
}

export interface UpdatePkgInput {
  path: string
  bytes: Buffer
}

export interface BuildUpdateOptions {
  files: UpdatePkgInput[]
  version: string
  privateKey: import('node:crypto').KeyObject
  now?: Date
  /** Testna meja (privzeto UPDATE_PKG_MAX_FILES). */
  maxFiles?: number
  /** Testna meja (privzeto UPDATE_PKG_MAX_CONTENT_BYTES). */
  maxContentBytes?: number
}

export interface BuildUpdateResult {
  buffer: Buffer
  header: UpdatePackageHeader
  /** sha256 celotnega paketa — za ročno primerjavo ob prenosu (podpis je avtoriteta, žig pa izpis). */
  sha256: string
}

export interface VerifyUpdateResult {
  header: UpdatePackageHeader
  totalBytes: number
  /** Žig sha256 celotne datoteke (enak izpisu local:package). */
  sha256: string
}

export interface ApplyUpdateOptions {
  buffer: Buffer
  /** Koren namestitve (mapa z package.json in src/lib/version.ts). */
  root: string
  /** Pot baze — SAMO za varovalko tečeče aplikacije; sme je ne biti. */
  dbPath: string
  publicKey: import('node:crypto').KeyObject
  now?: Date
  /** Dovoli tudi enako/starejšo različico (nalašč vračanje kode). */
  force?: boolean
  /** Vbrizgljiva varovalka (testi); privzeto isDatabaseInUse iz local-durability. */
  isBusy?: (dbPath: string) => boolean
  maxBackups?: number
}

export interface ApplyUpdateResult {
  header: UpdatePackageHeader
  replaced: number
  created: number
  backupDir: string
  pruned: string[]
  previousVersion: string
  /** Ukazi, ki jih lastnik izvede po zamenjavi (recept §7 LOKALNI-ZAGON). */
  recipe: string[]
}

// ── ključi ───────────────────────────────────────────────────────────────────

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

function b64ToBytes(raw: string): Buffer | null {
  const v = raw.trim()
  if (!B64_RE.test(v)) return null
  try {
    return Buffer.from(v, 'base64')
  } catch {
    return null
  }
}

const PKCS8_PREFIX = Buffer.from(ED25519_PKCS8_PREFIX_HEX, 'hex')
const SPKI_PREFIX = Buffer.from(ED25519_SPKI_PREFIX_HEX, 'hex')

/** Seme (32 B, base64) → KeyObject. Vse ostalo (kratko/dolgo/smeti/ne-niz) → null. */
export function parseSigningSeed(raw: unknown): import('node:crypto').KeyObject | null {
  if (typeof raw !== 'string') return null
  const seed = b64ToBytes(raw)
  if (!seed || seed.length !== ED25519_SEED_BYTES) return null
  try {
    return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  } catch {
    return null
  }
}

/** Javni ključ (32 B, base64) → KeyObject. Neveljavno → null. */
export function parseSigningPublicKey(raw: unknown): import('node:crypto').KeyObject | null {
  if (typeof raw !== 'string') return null
  const pub = b64ToBytes(raw)
  if (!pub || pub.length !== ED25519_PUB_BYTES) return null
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' })
  } catch {
    return null
  }
}

/** Zasebni ključ → surovo seme (base64) — za izpis keygena. */
export function seedOfPrivateKey(key: import('node:crypto').KeyObject): string {
  const der = key.export({ type: 'pkcs8', format: 'der' })
  if (!der.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX) || der.length !== PKCS8_PREFIX.length + ED25519_SEED_BYTES) {
    throw new Error('[local] Ključ ni Ed25519 v pričakovani obliki.')
  }
  return der.subarray(PKCS8_PREFIX.length).toString('base64')
}

/** Javni ključ → surovih 32 bajtov. */
export function rawOfPublicKey(key: import('node:crypto').KeyObject): Buffer {
  const der = key.export({ type: 'spki', format: 'der' })
  if (!der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX) || der.length !== SPKI_PREFIX.length + ED25519_PUB_BYTES) {
    throw new Error('[local] Javni ključ ni Ed25519 v pričakovani obliki.')
  }
  return der.subarray(SPKI_PREFIX.length)
}

/** Prvih 8 bajtov sha256 javnega ključa (hex) — namig ključa, tiskan in v glavi. */
export function keyFingerprint(publicKey: import('node:crypto').KeyObject): string {
  return createHash('sha256').update(rawOfPublicKey(publicKey)).digest('hex').slice(0, 16)
}

/** Nov par Ed25519 — edini generator v projektu (keygen nima lastnega). */
export function generateSigningKeyPair(): { seedB64: string; pubB64: string; keyObject: import('node:crypto').KeyObject; publicKey: import('node:crypto').KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { seedB64: seedOfPrivateKey(privateKey), pubB64: rawOfPublicKey(publicKey).toString('base64'), keyObject: privateKey, publicKey }
}

/** Okolje → zasebni ključ (ENA beseda discipline R5a: nikoli argv). */
export function readSigningKeyEnv(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[SIGNING_KEY_ENV]
  if (v === undefined || v.trim() === '') return null
  return v
}

/** Okolje → javni ključ. */
export function readSigningPubEnv(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[SIGNING_PUB_ENV]
  if (v === undefined || v.trim() === '') return null
  return v
}

/** Datoteka ključa (base64 v eni vrstici) → niz; končnik se odstrani, nič drugega. */
export function readKeyFile(file: string): string {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`[local] Branje ključa iz ${file} ni uspelo; paketa ni bilo mogoče narediti in namestitev ni bila spremenjena.`)
  }
  if (raw.endsWith('\r\n')) raw = raw.slice(0, -2)
  else if (raw.endsWith('\n')) raw = raw.slice(0, -1)
  return raw
}

// ── vrata poti ───────────────────────────────────────────────────────────────

/**
 * Relativna pot manifesta: ne-prazna, ≤ 200 znakov, brez absolutnega začetka,
 * brez poševnic nazaj, brez '.'/'..' segmentov, brez kontrolnih znakov.
 * Preverja se OB GRADNJI in PONOVNO OB ZAPISU NA DISK (obramba v globino:
 * manifest v paketu je tuj vhod, ne zaupaj mu dvakrat istega odgovora).
 */
export function guardPkgPath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('[local] Pot v manifestu paketa ni veljaven niz.')
  }
  if (p.length > UPDATE_PKG_PATH_MAX) {
    throw new Error(`[local] Pot ${p.slice(0, 40)}… je daljša od ${UPDATE_PKG_PATH_MAX} znakov.`)
  }
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) {
    throw new Error('[local] Pot v manifestu je absolutna; tak paket ne gre skozi.')
  }
  if (p.includes('\\')) {
    throw new Error('[local] Pot v manifestu nosi poševnico nazaj; pričakovane so poševnice naprej.')
  }
  const segments = p.split('/')
  if (segments.some((s) => s === '.' || s === '..' || s === '')) {
    throw new Error(`[local] Pot ${p} v manifestu ima prazen ali skok-del-gor segment; tak paket ne gre skozi.`)
  }
  if (/[\u0000-\u001f\u007f]/.test(p)) {
    throw new Error('[local] Pot v manifestu vsebuje kontrolne znake.')
  }
  return p
}

// ── gradnja ──────────────────────────────────────────────────────────────────

const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export function buildUpdatePackage(opts: BuildUpdateOptions): BuildUpdateResult {
  const now = opts.now ?? new Date()
  const maxFiles = opts.maxFiles ?? UPDATE_PKG_MAX_FILES
  const maxContentBytes = opts.maxContentBytes ?? UPDATE_PKG_MAX_CONTENT_BYTES

  // Različica MORA biti berljiva trojka — paket z neberljivo različico bi
  // preverba na drugi strani zavrgla, gradnja pa bi dejala ✔ (laž).
  if (!parseAppVersion(opts.version)) {
    throw new Error(`[local] Različica paketa »${opts.version}« ni številska trojka (npr. 1.217.0); paketa ni bilo mogoče zgraditi.`)
  }
  if (!Array.isArray(opts.files) || opts.files.length === 0) {
    throw new Error('[local] Paket brez datotek ni paket; gradnja je bila zavrnjena.')
  }
  if (opts.files.length > maxFiles) {
    throw new Error(`[local] Paket nosi ${opts.files.length} datotek, meja pa je ${maxFiles}; gradnja je bila zavrnjena.`)
  }

  const seen = new Set<string>()
  const manifest: UpdatePkgFile[] = []
  let contentBytes = 0
  for (const f of opts.files) {
    if (!f || typeof f.path !== 'string' || !Buffer.isBuffer(f.bytes)) {
      throw new Error('[local] Vsaka datoteka paketa potrebuje pot in bajte; gradnja je bila zavrnjena.')
    }
    const rel = guardPkgPath(f.path)
    if (seen.has(rel)) {
      throw new Error(`[local] Datoteka ${rel} je v paketu dvakrat; gradnja je bila zavrnjena.`)
    }
    seen.add(rel)
    manifest.push({ path: rel, size: f.bytes.length, sha256: sha256hex(f.bytes) })
    contentBytes += f.bytes.length
  }
  if (contentBytes > maxContentBytes) {
    throw new Error(`[local] Vsebina paketa je ${contentBytes} B, meja pa je ${maxContentBytes} B; gradnja je bila zavrnjena.`)
  }

  // Deterministični vrstni red pomembno: enak vir → enak paket. Klicatelj
  // lahko vrstni red že prinese, gradnja pa mu ne zaupa in sortira SAMA,
  // zloženka telesa pa se sestavi po sortiranem manifestu.
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const poPotiVhoda = new Map(opts.files.map((f) => [guardPkgPath(f.path), f.bytes]))
  const body = gzipSync(Buffer.concat(manifest.map((m) => poPotiVhoda.get(m.path) as Buffer)))

  const header: UpdatePackageHeader = {
    format: UPDATE_PKG_FORMAT,
    sig: UPDATE_PKG_SIG_ALG,
    version: opts.version,
    createdAt: now.toISOString(),
    fileCount: manifest.length,
    contentBytes,
    bodyBytes: body.length,
    // Namig ključa se izpelje iz JAVNEGA dela zasebnega ključa (izvoz SPKI
    // nad zasebnim ključem ni možen — seme je PKCS8, javni del pa SPKI).
    keyHint: keyFingerprint(createPublicKey(opts.privateKey)),
    files: manifest,
  }
  const headLine = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')
  if (headLine.length > UPDATE_PKG_HEADER_MAX_BYTES) {
    throw new Error(`[local] Glava paketa je ${headLine.length} B, meja pa je ${UPDATE_PKG_HEADER_MAX_BYTES} B; gradnja je bila zavrnjena.`)
  }

  // Podpis pokriva TOČNO bajte glave+telesa, kot bodo zapisani (vrstni red
  // zloženke = sortiran manifest, zgostitev ena, Ed25519 determinističen).
  const signature = sign(null, Buffer.concat([headLine, body]), opts.privateKey)
  if (signature.length !== UPDATE_PKG_SIG_BYTES) {
    throw new Error('[local] Podpis ni dolg 64 bajtov — to ni Ed25519; gradnja je bila zavrnjena.')
  }

  const buffer = Buffer.concat([headLine, body, signature])
  return { buffer, header, sha256: sha256hex(buffer) }
}

// ── pregled in preverba ──────────────────────────────────────────────────────

function preveriGlavoPaketa(neznano: unknown): UpdatePackageHeader {
  if (!neznano || typeof neznano !== 'object') throw new Error('[local] Glava paketa ni objekt.')
  const g = neznano as Record<string, unknown>
  if (g.format !== UPDATE_PKG_FORMAT) {
    throw new Error(`[local] Paket je oblike ${String(g.format)}, ta izdaja pa bere samo ${UPDATE_PKG_FORMAT}.`)
  }
  if (g.sig !== UPDATE_PKG_SIG_ALG) {
    throw new Error(`[local] Paket navaja podpisni algoritem ${String(g.sig)}, jaz pa poznam samo ${UPDATE_PKG_SIG_ALG}.`)
  }
  if (typeof g.version !== 'string' || !parseAppVersion(g.version)) {
    throw new Error(`[local] Različica v glavi paketa (»${String(g.version)}«) ni številska trojka.`)
  }
  if (typeof g.createdAt !== 'string' || Number.isNaN(Date.parse(g.createdAt))) {
    throw new Error('[local] Glava paketa nima veljavnega časa nastanka.')
  }
  if (typeof g.keyHint !== 'string' || !/^[0-9a-f]{16}$/.test(g.keyHint)) {
    throw new Error('[local] Namig ključa v glavi paketa ni veljaven.')
  }
  if (!Array.isArray(g.files) || g.files.length === 0) {
    throw new Error('[local] Manifest paketa je prazen ali ni seznam.')
  }
  if (g.files.length > UPDATE_PKG_MAX_FILES) {
    throw new Error(`[local] Manifest nosi ${g.files.length} datotek, meja pa je ${UPDATE_PKG_MAX_FILES}; paket je zavrnjen.`)
  }
  if (typeof g.fileCount !== 'number' || g.fileCount !== g.files.length) {
    throw new Error('[local] fileCount v glavi se ne ujema z dolžino manifesta — glava laže o svoji vsebini.')
  }
  let vsota = 0
  const poti = new Set<string>()
  for (const f of g.files) {
    if (!f || typeof f !== 'object') throw new Error('[local] Vnos manifesta ni objekt.')
    const v = f as Record<string, unknown>
    if (typeof v.path !== 'string') throw new Error('[local] Vnos manifesta nima poti.')
    guardPkgPath(v.path) // javi svojo napako
    if (poti.has(v.path)) throw new Error(`[local] Datoteka ${v.path} je v manifestu dvakrat.`)
    poti.add(v.path)
    if (typeof v.size !== 'number' || !Number.isInteger(v.size) || v.size < 0) {
      throw new Error(`[local] Velikost datoteke ${v.path} v manifestu ni veljavna.`)
    }
    if (typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) {
      throw new Error(`[local] Žig datoteke ${v.path} v manifestu ni veljaven sha256.`)
    }
    vsota += v.size
  }
  if (typeof g.contentBytes !== 'number' || g.contentBytes !== vsota) {
    throw new Error('[local] contentBytes v glavi se ne ujema z vsoto velikosti manifesta — glava laže o svoji vsebini.')
  }
  if (g.contentBytes > UPDATE_PKG_MAX_CONTENT_BYTES) {
    throw new Error(`[local] Paket obljublja ${String(g.contentBytes)} B vsebine, meja pa je ${UPDATE_PKG_MAX_CONTENT_BYTES} B; paket je zavrnjen.`)
  }
  if (typeof g.bodyBytes !== 'number' || !Number.isInteger(g.bodyBytes) || g.bodyBytes <= 0) {
    throw new Error('[local] Dolžina telesa v glavi paketa ni veljavna.')
  }
  return g as unknown as UpdatePackageHeader
}

/** Prebere in preveri STRUKTURO paketa (brez ključa): glava, dolžine, vrata poti. */
export function inspectUpdatePackage(buffer: Buffer): UpdatePackageHeader {
  if (!Buffer.isBuffer(buffer) || buffer.length < UPDATE_PKG_SIG_BYTES + 2) {
    throw new Error('[local] Datoteka je prekratka, da bi bil paket; nič ni bilo preverjeno.')
  }
  const konecVrstice = buffer.indexOf(0x0a)
  if (konecVrstice < 0) {
    throw new Error('[local] Paket nima glave (manjka ločilna vrstica).')
  }
  if (konecVrstice > UPDATE_PKG_HEADER_MAX_BYTES) {
    throw new Error(`[local] Glava paketa je ${konecVrstice} B, meja pa je ${UPDATE_PKG_HEADER_MAX_BYTES} B; paket je zavrnjen.`)
  }
  let jasna: unknown
  try {
    jasna = JSON.parse(buffer.subarray(0, konecVrstice).toString('utf8'))
  } catch {
    throw new Error('[local] Glava paketa ni veljaven JSON.')
  }
  const header = preveriGlavoPaketa(jasna)
  const expected = konecVrstice + 1 + header.bodyBytes + UPDATE_PKG_SIG_BYTES
  if (buffer.length !== expected) {
    throw new Error(
      `[local] Paket je nepopoln: glava obljublja skupno ${expected} B, datoteka jih ima ${buffer.length}. Prenos je bil prekinjen ali datoteka porezana; preverjanje ni bilo začeto.`,
    )
  }
  return header
}

/**
 * Polna preverba: podpis nad TOČNO bajti (glava + telo) + sprehod po manifestu
 * (vsaka datoteka razširjena, prežeta in primerjana po sha256). Vrne glavo, če
 * je vse pošteno; sicer javi točno vzrok in se NE dotakne diska.
 */
export function verifyUpdatePackage(buffer: Buffer, publicKey: import('node:crypto').KeyObject): VerifyUpdateResult {
  const header = inspectUpdatePackage(buffer)
  const messageEnd = buffer.length - UPDATE_PKG_SIG_BYTES
  const signature = buffer.subarray(messageEnd)
  const ok = verify(null, buffer.subarray(0, messageEnd), publicKey, signature)
  if (!ok) {
    const lokalni = keyFingerprint(publicKey)
    if (header.keyHint !== lokalni) {
      throw new Error(
        `[local] Paket je podpisan z drugim ključem (paket: ${header.keyHint}, ta namestitev: ${lokalni}). Namestitev ni bila spremenjena.`,
      )
    }
    throw new Error('[local] Podpis paketa ni veljaven — datoteka je bila po prenosu spremenjena ali poškodovana. Namestitev ni bila spremenjena.')
  }

  // Obramba v globino: podpis že pokriva bajte, a manifest se vseeno prehodi —
  // zapis, ki bi ga lahko prebrali brez preverbe, ni zapis ampak tvegana izguba.
  let telo: Buffer
  try {
    telo = gunzipSync(buffer.subarray(buffer.indexOf(0x0a) + 1, messageEnd))
  } catch {
    throw new Error('[local] Telo paketa ni veljaven gzip — datoteka je poškodovana. Namestitev ni bila spremenjena.')
  }
  if (telo.length !== header.contentBytes) {
    throw new Error(
      `[local] Razširjeno telo je ${telo.length} B, manifest pa obljublja ${header.contentBytes} B; paket je zavrnjen.`,
    )
  }
  let off = 0
  for (const f of header.files) {
    const kos = telo.subarray(off, off + f.size)
    if (kos.length !== f.size) {
      throw new Error(`[local] Datoteke ${f.path} v telesu paketa ni cele; paket je zavrnjen.`)
    }
    if (sha256hex(kos) !== f.sha256) {
      throw new Error(`[local] Žig sha256 datoteke ${f.path} se ne ujema z manifestom; paket je zavrnjen.`)
    }
    off += f.size
  }
  return { header, totalBytes: buffer.length, sha256: sha256hex(buffer) }
}

/** Ime paketa: restaurantos-<različica>.rospkg (brez presledkov, kot pot). */
export function updatePackageNameFor(version: string): string {
  if (!parseAppVersion(version)) {
    throw new Error(`[local] Različica »${version}« ni številska trojka; imena paketa ni bilo mogoče sestaviti.`)
  }
  return `${UPDATE_PKG_PREFIX}${version}${UPDATE_PKG_EXT}`
}

// ── zbiranje vira ────────────────────────────────────────────────────────────

function jePrepovedanaPripona(p: string): boolean {
  return FORBIDDEN_SUFFIXES.some((s) => p.endsWith(s))
}

function walkDir(root: string, relDir: string, out: UpdatePkgInput[]): void {
  const abs = path.join(root, relDir)
  let imena: string[]
  try {
    imena = readdirSync(abs)
  } catch {
    throw new Error(`[local] Mape ${abs} ni bilo mogoče prebrati; paketa ni bilo mogoče zgraditi.`)
  }
  for (const ime of imena.sort()) {
    const rel = relDir ? `${relDir}/${ime}` : ime
    const polna = path.join(root, rel)
    // lstat, NE stat: statSync SLEDI simbolnim povezavam, zato bi povezava na
    // datoteko IZVEN drevesa (izmerjeno v1.217.0: public/img/skrivnost.txt →
    // zunanja vsebina je pristala v podpisanem paketu) tiho vključila tuje
    // bajte, zlomljena povezava pa bi sesula gradnjo s surovim ENOENT. Odkar
    // v1.217.1: povezave se PRESKOČIJO (komentar ne laže več) — vir paketa je
    // SAMO prave datoteke in mape znotraj korena.
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(polna)
    } catch (err) {
      const razlog = err instanceof Error ? err.message : String(err)
      throw new Error(`[local] Nad ${polna} ni bilo mogoče brskati (${razlog}); paketa ni bilo mogoče zgraditi.`)
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      walkDir(root, rel, out)
    } else if (st.isFile()) {
      // BAZA NIKOLI NI VIR: prisma/dev.db obstaja na disku razvojnega odjemalca
      // (v gitu ni), .db-wal pa nastane ob vsakem zagonu — ti v paket ne gredo.
      if (jePrepovedanaPripona(ime)) continue
      out.push({ path: rel, bytes: readFileSync(polna) })
    }
  }
}

/**
 * Zbere vir paketa iz korena repozitorija: ogledalo Dockerfile COPY seznama
 * + celoten deploy/. Vrne datoteke s POŠEVNICAMI naprej, sortirane.
 */
/** Prava datoteka (NE povezava — isto varovalo kot walkDir, za korenske vnose). */
function jePravaDatoteka(p: string): boolean {
  try {
    return lstatSync(p).isFile()
  } catch {
    return false
  }
}

/** Prava mapa (NE povezava). */
function jePravaMapa(p: string): boolean {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

export function collectUpdateSource(root: string): UpdatePkgInput[] {
  const out: UpdatePkgInput[] = []
  const manjkajo: string[] = []
  for (const f of UPDATE_PKG_ROOT_FILES) {
    const polna = path.join(root, f)
    // lstat tudi tu: korenska datoteka, ki je povezava, NI vir (enako
    // varovalo kot walkDir — sicer bi zadnja vrata zbiranja bila široka).
    if (!jePravaDatoteka(polna)) {
      manjkajo.push(f)
      continue
    }
    if (jePrepovedanaPripona(f)) continue
    out.push({ path: f, bytes: readFileSync(polna) })
  }
  for (const d of UPDATE_PKG_ROOT_DIRS) {
    if (!jePravaMapa(path.join(root, d))) manjkajo.push(`${d}/`)
  }
  if (manjkajo.length > 0) {
    throw new Error(
      `[local] V korenu ${root} manjka ${manjkajo.join(', ')} — to ni koren repozitorija RestaurantOS; paketa ni bilo mogoče zgraditi.`,
    )
  }
  for (const d of UPDATE_PKG_ROOT_DIRS) walkDir(root, d, out)
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

// ── nadgradnja namestitve ────────────────────────────────────────────────────

/** Različica namestitve iz src/lib/version.ts (ENA resnica, v1.124.0). */
export function readInstalledVersion(root: string): string | null {
  try {
    const vir = readFileSync(path.join(root, 'src', 'lib', 'version.ts'), 'utf8')
    const m = /APP_VERSION\s*=\s*'(\d{1,8}\.\d{1,8}\.\d{1,8})'/.exec(vir)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-')

function listCodeBackups(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((ime) => ime.startsWith(UPDATE_BACKUP_PREFIX)).sort()
}

/**
 * Zamenja kodo namestitve iz PREVERJENEGA paketa. Vrsta varovalk (nobena ni
 * okrasna):
 *  1. podpis + manifest (verifyUpdatePackage) — pred vsakim dotikom diska;
 *  2. vrata različice: brez --force se enaka/starejša zavrne (vračanje kode je
 *     nalašč dejanje, ne nesreča);
 *  3. tečeča aplikacija: poln -wal pomeni, da nekdo piše v bazo — nadgradnja
 *     kode med obratom je treba odkleniti šele po ustavitvi;
 *  4. varnostna kopija ZAMENJANIH datotek (.ros-update-backup-*, zadržanih 3);
 *  5. po zamenjavi se VSAKA datoteka na disku ponovno prežge (R5a točka 3);
 *  6. napaka sredi zamenjave = VSE ALI NIČ: zamenjene se vrnejo iz kopije,
 *     nove se pobrišejo, kopija se umakne (ista disciplina kot pogon R6).
 * Datoteke, ki jih paket ne nosi, se NE dotaknejo (aditivna semantika).
 */
export function applyUpdatePackage(opts: ApplyUpdateOptions): ApplyUpdateResult {
  const now = opts.now ?? new Date()
  const root = path.resolve(opts.root)
  const maxBackups = opts.maxBackups ?? UPDATE_MAX_CODE_BACKUPS

  // 1) preverba paketa — ob padcu se disk ne dotakne
  const verified = verifyUpdatePackage(opts.buffer, opts.publicKey)
  const header = verified.header

  // 2) koren res je namestitev
  if (!existsSync(path.join(root, 'package.json')) || !existsSync(path.join(root, 'src', 'lib', 'version.ts'))) {
    throw new Error(`[local] ${root} ni koren namestitve RestaurantOS (manjka package.json ali src/lib/version.ts); nadgradnja se ni začela.`)
  }
  const previousVersion = readInstalledVersion(root)
  if (!previousVersion) {
    throw new Error('[local] Različice namestitve ni bilo mogoče prebrati iz src/lib/version.ts; nadgradnja se ni začela in namestitev ni bila spremenjena.')
  }
  const cmp = compareAppVersions(parseAppVersion(header.version) as [number, number, number], parseAppVersion(previousVersion) as [number, number, number])
  if (cmp <= 0 && !opts.force) {
    throw new Error(
      `[local] Paket nosi ${header.version}, namestitev pa že ${previousVersion}. Nadgradnja na enako/starejšo različico je vračanje kode — potrdi ga z --force, če ga res želiš. Namestitev ni bila spremenjena.`,
    )
  }

  // 3) aplikacija mora stati
  const isBusy = opts.isBusy ?? ((p: string) => {
    const wal = `${p}-wal`
    try {
      return existsSync(p) && existsSync(wal) && statSync(wal).size > 0
    } catch {
      return false
    }
  })
  if (isBusy(opts.dbPath)) {
    throw new Error('[local] Baza ima poln dnevniški rep — aplikacija najbrž teče. Ustavi jo (Ctrl+C ali zapri okno) in ponovi nadgradnjo; namestitev ni bila spremenjena.')
  }

  // 4) načrt zamenjave (poti se PONOVNO pregledajo — manifest je tuj vhod)
  const zamenjaj: Array<{ rel: string; abs: string }> = []
  const nove: Array<{ rel: string; abs: string }> = []
  for (const f of header.files) {
    const rel = guardPkgPath(f.path)
    const abs = path.join(root, rel)
    const resolved = path.resolve(abs)
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(`[local] Pot ${rel} bi segala izven korena namestitve; paket je zavrnjen in namestitev ni bila spremenjena.`)
    }
    ;(existsSync(abs) ? zamenjaj : nove).push({ rel, abs })
  }

  // 5) varnostna kopija stare kode
  const backupDir = path.join(root, `${UPDATE_BACKUP_PREFIX}${stamp(now)}`)
  if (existsSync(backupDir)) {
    throw new Error('[local] Varnostna kopija s tem časovnim žigom že obstaja — počakaj sekundo ali počisti stare; namestitev ni bila spremenjena.')
  }
  mkdirSync(backupDir, { recursive: true })
  for (const z of zamenjaj) {
    const cilj = path.join(backupDir, z.rel)
    mkdirSync(path.dirname(cilj), { recursive: true })
    copyFileSync(z.abs, cilj)
  }
  writeFileSync(
    path.join(backupDir, 'zamenjava.json'),
    `${JSON.stringify({ from: previousVersion, to: header.version, at: now.toISOString(), replaced: zamenjaj.map((z) => z.rel), created: nove.map((n) => n.rel) }, null, 2)}\n`,
  )

  // 6) zamenjava — po bajtih iz RAZŠIRJENEGA telesa (ne iz operatorja iz glave)
  let telo: Buffer
  try {
    telo = gunzipSync(opts.buffer.subarray(opts.buffer.indexOf(0x0a) + 1, opts.buffer.length - UPDATE_PKG_SIG_BYTES))
  } catch {
    rmSync(backupDir, { recursive: true, force: true })
    throw new Error('[local] Telo paketa med nadgradnjo ni več berljivo; namestitev ni bila spremenjena.')
  }
  const ofseti = new Map<string, number>()
  {
    let off = 0
    for (const f of header.files) {
      ofseti.set(f.path, off)
      off += f.size
    }
  }
  const pisanja: Array<{ rel: string; abs: string; bytes: Buffer }> = []
  for (const f of header.files) {
    const rel = guardPkgPath(f.path)
    const abs = path.join(root, rel)
    const off = ofseti.get(f.path) as number
    pisanja.push({ rel, abs, bytes: telo.subarray(off, off + f.size) })
  }

  try {
    for (const p of pisanja) {
      mkdirSync(path.dirname(p.abs), { recursive: true })
      writeFileSync(p.abs, p.bytes)
    }
    // 7) ponovna preverba NA DISKU — kar smo zapisali, se mora prebrati
    for (const f of header.files) {
      const abs = path.join(root, guardPkgPath(f.path))
      const naDisku = readFileSync(abs)
      if (sha256hex(naDisku) !== f.sha256) {
        throw new Error(`[local] Datoteka ${f.path} se po zapisu na disk ne ujema z manifestom; zamenjava se razveljavlja.`)
      }
    }
  } catch (err) {
    // VSE ALI NIČ: zamenjane nazaj iz kopije, nove stran, kopija umaknjena.
    // existsSync pred rmSync je NAMEREN: rmSync s silo potlači samo ENOENT,
    // ne pa ENOTDIR (starš je navadna datoteka) — razveljavitev ne sme pasti
    // na datoteki, ki je nikoli ni bilo.
    const sporočilo = err instanceof Error ? err.message : String(err)
    let obnovitev = true
    try {
      for (const z of zamenjaj) {
        const vir = path.join(backupDir, z.rel)
        if (existsSync(vir)) copyFileSync(vir, z.abs)
      }
      for (const n of nove) {
        if (existsSync(n.abs)) rmSync(n.abs, { force: true })
      }
    } catch {
      obnovitev = false
    }
    if (obnovitev) {
      rmSync(backupDir, { recursive: true, force: true })
      throw new Error(`[local] Nadgradnja ni uspela (${sporočilo}) in je bila v celoti RAZVELJAVLJENA — namestitev je v prejšnjem stanju. Podatki v bazi niso bili spremenjeni.`)
    }
    throw new Error(
      `[local] Nadgradnja ni uspela (${sporočilo}) in razveljavitev ni uspela do konca — stara koda je v ${backupDir}; ročno prekopirajte datoteke iz nje. Podatki v bazi niso bili spremenjeni.`,
    )
  }

  // 8) zadrževanje kopij (po uspehu — kopija padle nadgradnje se ne pobriše)
  const vse = listCodeBackups(root)
  const pruned: string[] = []
  for (const ime of vse.slice(0, Math.max(0, vse.length - maxBackups))) {
    rmSync(path.join(root, ime), { recursive: true, force: true })
    pruned.push(ime)
  }

  return {
    header,
    replaced: zamenjaj.length,
    created: nove.length,
    backupDir,
    pruned,
    previousVersion,
    recipe: ['bun install', 'bun run local:migrate        # suhi tek: pokaže načrt', 'bun run local:migrate --apply # šele potem izvede', 'bun run local --build'],
  }
}
