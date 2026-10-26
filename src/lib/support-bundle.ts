/**
 * v1.181.0 — podporni paket BREZ skrivnosti (PRD docs/PRD-LOKALNA-BAZA.md, R4:
 * "support bundle brez skrivnosti").
 *
 * Kaj je v paketu: različica, način, pogon, razvrščena diagnostika baze, trajnost
 * (journal_mode izmerjen, pragma kot ju nastavlja aplikacija), inventar kopij
 * (IME + velikost, ne vsebina), rep dnevnika napak in številki redov po tabelah.
 *
 * Kaj NIKOLI ni v paketu — in zakaj:
 *  - `config.json` (appSecret, pinLookupSalt, cronSecret): izdaja seje in
 *    razkriva način razbitja PIN-ov;
 *  - `PRVIC-ZAGON.txt`: PIN lastnika v jasnem besedilu (v1.165.0);
 *  - `tls/*`: zasebni ključ fronte (v1.175.0) — z njim lahko kdorkoli predreza
 *    HTTPS v omrežju obrata;
 *  - `data/*.db` in `backups/*.db`: stranke, računi in osebni podatki osebja.
 *
 * Pravila so tehnično vsiljena, ne zaupana: `readSnapshot` dobi INJEKTIRAN `fs`,
 * zato test meri, KATERE poti so bile odprte (tests/v181 §C), in ne samo, kaj je
 * na koncu zapisanega. `collectSecretValues` je edina funkcija, ki sme prebrati
 * `config.json`, in njena única so vrednosti za redakturo.
 *
 * Poštenost (ista lekcija kot §D v tests/v1801-brand-name.test.ts): negativna
 * trditev "v paketu ni skrivnosti" brez pozitivne kontrole ne trdi ničesar, zato
 * §E najprej dokaže, da je bila skrivnost v surovem vhodu vidna.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LOCAL_SECRETS_FILE, LOCAL_SETUP_MARKER } from './local-runtime'
import { tailErrorLog } from './local-log'

export const BUNDLE_SUBDIR = 'support'
export const BUNDLE_FORMAT = 'ros-support-1'
export const SECRET_PLACEHOLDER = '[RAZMAZKANO]'
export const HOME_PLACEHOLDER = '~'
export const BUNDLE_LOG_LINES = 400
/** Sicer jo izračuna `backupsDirFor` (v1.169.0); ime je zapisano tukaj, da bralec
 *  paketov ne uvaža `node:sqlite` prek lokalne vzdržljivosti. */
const BACKUPS_SUBDIR = 'backups'

/** Imena, ki jih bralec paketov ne sme ODPRTI (ne brati, ne stats). */
export const FORBIDDEN_NAMES: readonly string[] = [LOCAL_SECRETS_FILE, LOCAL_SETUP_MARKER, 'tls', 'data']

/** Pisna pogodba bralca datotečnega sistema — test lahko zabeleži vsako odprto pot. */
export interface RecordingFs {
  existsSync(p: string): boolean
  readdirSync(p: string): string[]
  statSync(p: string): { size: number; mtimeMs: number }
  readFileSync(p: string): string
}

const NODE_FS: RecordingFs = {
  existsSync: (p) => existsSync(p),
  readdirSync: (p) => readdirSync(p) as string[],
  statSync: (p) => statSync(p),
  readFileSync: (p) => readFileSync(p, 'utf8'),
}

export interface BackupEntry {
  name: string
  sizeBytes: number
  ageDays: number
}

export interface Snapshot {
  logs: string[]
  logFiles: string[]
  backups: BackupEntry[]
  warnings: string[]
}

export interface BundleEnvironment {
  platform: string
  release: string
  arch: string
  runtime: string
  home: string
  dataDir: string
  freeDiskMb?: number
}

export interface BuildInput {
  now: Date
  appVersion: string
  commit: string
  mode: string
  databaseEngine: string
  environment: BundleEnvironment
  health: Record<string, unknown> | null
  durability: Record<string, unknown> | null
  backups: BackupEntry[]
  logs: string[]
  counts: Record<string, number>
  secrets: string[]
  warnings?: string[]
}

export interface Bundle {
  files: Record<string, string>
  redactions: number
}

export interface RedactResult {
  text: string
  redactions: number
}

// ── redaktura ────────────────────────────────────────────────────────────────

const HOME_WINDOWS = /[A-Za-z]:[\\/]+(?:Users|home)[\\/]+[^\\/\s"']+/g
const HOME_POSIX = /\/(?:Users|home)\/[^/\s"']+/g
/** Dolg žeton mešane velikosti z vsaj eno številko (oblika APP_SECRET). UUID-ji in
 *  čista datumska/številčna ID-ja ostanejo berljivi — diagnostika ne sme biti pokosena.
 *  Razred NE sme vsebovati vezaja: živo izmerjeno 2026-10-26 na pravi namestitvi je
 *  pravilo z vezajem požrlo 4 od 6 imen kopij (`pred-obnovo-*` in `pre-push-*` sta
 *  dolga ≥32 znakov, `dnevno-*` je pri 31 ušel) in inventar je brez imen
 *  neuporaben. Tujo skrivnost z vezajem ujamejo pravila znanih vrednosti, BEARER,
 *  USERINFO, QUERY_SECRET in PROVIDER_TOKEN; LONG_TOKEN je samo zadnja mreža. */
const LONG_TOKEN = /\b(?=[A-Za-z0-9_]{32,}\b)(?=[a-z0-9_]*[A-Z])(?=[A-Za-z0-9_]*[a-z])(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{32,}\b/g
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi
const USERINFO = /(:\/\/[^\s/@:]+:)([^\s@]+)(@)/g
const QUERY_SECRET = /([?&](?:password|passwd|secret|token|api[_-]?key|access_token|auth|key)=)([^\s&]+)/gi
const PROVIDER_TOKEN = /\b((?:sk|pk|rk)_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|x-access-token:)([A-Za-z0-9_]{4,})/g

/**
 * Odstrani znane skrivnosti, domače poti in oblike poverilnic. Vrne število
 * posegov, da paket javi, KOLIKO je bilo maskirano — tiha redaktura bi prikrila
 * tudi napako v sami redakturi.
 */
export function redact(text: string, options: { secrets: string[]; home?: string }): RedactResult {
  let out = text
  let n = 0
  const hit = (re: RegExp, repl: string | ((...m: string[]) => string)) => {
    const before = out
    out = before.replace(re, repl as never)
    if (before !== out) n += (before.match(re) || []).length
  }
  for (const value of options.secrets) {
    if (!value || value.length < 8) continue
    const re = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    hit(re, SECRET_PLACEHOLDER)
  }
  if (options.home && options.home.length >= 3) {
    hit(new RegExp(options.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), HOME_PLACEHOLDER)
  }
  hit(HOME_WINDOWS, HOME_PLACEHOLDER)
  hit(HOME_POSIX, HOME_PLACEHOLDER)
  hit(BEARER, (_m, p1) => `${p1}${SECRET_PLACEHOLDER}`)
  hit(USERINFO, (_m, p1, _p2, p3) => `${p1}${SECRET_PLACEHOLDER}${p3}`)
  hit(QUERY_SECRET, (_m, p1) => `${p1}${SECRET_PLACEHOLDER}`)
  hit(PROVIDER_TOKEN, (_m, p1) => `${p1}${SECRET_PLACEHOLDER}`)
  hit(LONG_TOKEN, SECRET_PLACEHOLDER)
  return { text: out, redactions: n }
}

// ── branje ───────────────────────────────────────────────────────────────────

/**
 * Edini bralec `config.json`: vrne SAMO vrednosti, ki jih je treba zamaskirati.
 * Odsotna ali pokvarjena datoteka ni izjema — paket se sestavi brez seznama in
 * z javljenim opozorilom.
 */
export function collectSecretValues(dataDir: string, fs: RecordingFs = NODE_FS): string[] {
  const file = path.join(dataDir, LOCAL_SECRETS_FILE)
  let out: string[] = []
  try {
    if (!fs.existsSync(file)) return out
    const parsed = JSON.parse(fs.readFileSync(file)) as Record<string, unknown>
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' || value.length < 8) continue
      if (/secret|salt|token|key|password|passwd|apikey/i.test(key)) out.push(value)
    }
  } catch {
    out = []
  }
  return out
}

const backupNameRe = /^(dnevno|pre-push|pred-obnovo)-.+\.(db|sqlite)$/i

export function readSnapshot(opts: { dataDir: string; now: Date; fs?: RecordingFs; maxLogLines?: number }): Snapshot {
  const fs = opts.fs || NODE_FS
  const warnings: string[] = []

  const tail = tailErrorLog(opts.dataDir, opts.maxLogLines ?? BUNDLE_LOG_LINES, opts.now, fs)
  if (tail.unavailable) warnings.push('dnevnik napak ni na voljo — obrat še ni zabeležil nobene napake')

  const backups: BackupEntry[] = []
  const backupsDir = path.join(opts.dataDir, BACKUPS_SUBDIR)
  if (!fs.existsSync(backupsDir)) {
    warnings.push('mapa kopij ni na voljo — dnevne kopije še niso bile narejene')
  } else {
    for (const name of fs.readdirSync(backupsDir)) {
      if (!backupNameRe.test(name)) continue
      let st: { size: number; mtimeMs: number }
      try {
        st = fs.statSync(path.join(backupsDir, name))
      } catch {
        warnings.push(`kopija ${name} ni berljiva (stat)`)
        continue
      }
      backups.push({ name, sizeBytes: st.size, ageDays: Math.floor((opts.now.getTime() - st.mtimeMs) / 86_400_000) })
    }
    backups.sort((a, b) => (a.name < b.name ? 1 : -1))
  }

  return { logs: tail.lines, logFiles: tail.files, backups, warnings }
}

// ── sestava ──────────────────────────────────────────────────────────────────

const README = `Podpora — podporni paket RestaurantOS
════════════════════════════════

Kaj je v tem paketu
  - različica, način zagona in podatkovni pogon;
  - razvrščena diagnostika baze (koda napake in nasvet, NE surovo sporočilo);
  - trajnost baze: journal_mode (IZMERJENO iz datoteke) in pragma, ki ju
    aplikacija nastavlja vsaki povezavi, ter inventar kopij po IMENU in VELIKOSTI;
  - zadnje vrstice lokalnega dnevnika napak;
  - ŠTEVILKE redov po tabelah (povzetek, ne vsebina).

Kaj v paketu NI in zakaj ne
  - config.json — vsebuje APP_SECRET, PINLookup sol in CRON_SECRET;
  - PRVIC-ZAGON.txt — vsebuje PIN lastnika v jasnem besedilu;
  - tls/ — zasebni ključ HTTPS fronte;
  - data/ in backups/ — baze s strankami, računi in osebnimi podatki osebja.

Vse kar je bilo v virih skrivnost ali domača pot, je bilo nadomeščeno z
[RAZMAZKANO] oziroma ~. Število posegov je zapisano v manifest.json pod
ključem "redactions".

Kako poslati
  1. celotno mapo zapakiraj (desni klik → Pošlji v → stisnjena mapa).
  2. Poslji jo podpori. Preden jo, sam poglej dnevnik.log — maskiranje je
     samodejno, a zadnji pregled vedno stori človek.

Kaj v paketu manjka? Povej — seznam datotek je namenoma kratek.`

export function buildBundle(input: BuildInput): Bundle {
  const red = (text: string): RedactResult => redact(text, { secrets: input.secrets, home: input.environment.home })

  const stanje: Record<string, unknown> = { counts: input.counts }
  if (input.health) stanje.health = input.health
  if (input.durability) stanje.durability = input.durability
  const warnings = [...(input.warnings || [])]

  const files: Record<string, string> = {
    'README.txt': README,
    'stanje.json': JSON.stringify(izpusti(stanje), null, 2),
    'kopije.json': JSON.stringify({ backups: input.backups }, null, 2),
    'okolje.json': JSON.stringify(
      {
        platform: input.environment.platform,
        release: input.environment.release,
        arch: input.environment.arch,
        runtime: input.environment.runtime,
        dataDir: input.environment.dataDir,
        ...(typeof input.environment.freeDiskMb === 'number' ? { freeDiskMb: input.environment.freeDiskMb } : {}),
      },
      null,
      2,
    ),
    'dnevnik.log': input.logs.join('\n') + (input.logs.length ? '\n' : ''),
  }
  if (!files['dnevnik.log']) warnings.push('dnevnik napak je prazen')

  let redactions = 0
  const out: Record<string, string> = {}
  for (const [name, text] of Object.entries(files)) {
    const r = red(text)
    redactions += r.redactions
    out[name] = r.text
  }

  const manifest = {
    format: BUNDLE_FORMAT,
    generatedAt: input.now.toISOString(),
    appVersion: input.appVersion,
    commit: input.commit,
    mode: input.mode,
    databaseEngine: input.databaseEngine,
    files: Object.keys(out).concat('manifest.json').sort(),
    redactions,
    warnings,
  }
  out['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n'
  return { files: out, redactions }
}

/** JSON ne sme nositi `undefined` polj — izpusti jih, da `health: null` ne ustvari lažnega stanja. */
function izpusti(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out
}

export interface WriteBundleResult {
  dir: string
  files: Record<string, string>
  bytes: number
}

export function writeBundle(opts: { dataDir: string; now: Date; bundle: Bundle; fs?: RecordingFs }): WriteBundleResult {
  const stamp = opts.now.toISOString().replace(/[:.]/g, '-')
  const dir = path.join(opts.dataDir, BUNDLE_SUBDIR, stamp)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const files: Record<string, string> = {}
  let bytes = 0
  for (const [name, text] of Object.entries(opts.bundle.files)) {
    const file = path.join(dir, name)
    writeFileSync(file, text, { mode: 0o600 })
    files[name] = readFileSync(file, 'utf8')
    bytes += Buffer.byteLength(files[name], 'utf8')
  }
  return { dir, files, bytes }
}

/**
 * Zadnja varovalka pred oddajo: nobena znana skrivnost ne sme biti v NOBENI
 * zapisani datoteki. Ne vrne ničesar — javi ime datoteke in začetek vrednosti,
 * da se da napako najti, ne pa tudi same vrednosti.
 */
export function assertBundleClean(files: Record<string, string>, secrets: string[]): void {
  for (const [name, text] of Object.entries(files)) {
    for (const value of secrets) {
      if (value && text.includes(value)) {
        throw new Error(`${name}: v paketu je ostala skrivnost ${value.slice(0, 6)}… — paketa ne oddaj`)
      }
    }
  }
}

/**
 * Števci rel so POGUMNI: paket sme nositi "Order: 42", nikoli pa vrstice same.
 * Baza je odprta SAMO BRALNO, ime tabele pa gre v SQL izključno, če je navaden
 * identifikator — tuje ime (npr. `na red!x`) je preskočeno in JAVLJENO, ne
 * "zavarovano" s citiranjem. Paket torej nikoli ne sestavlja stavka iz zunanjega
 * vira in ne prešteva interne SQLite mehanike.
 */
export interface TableCountResult {
  counts: Record<string, number>
  skipped: string[]
  error?: string
}

const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function countTables(dbPath: string, maxTables = 250): TableCountResult {
  let handle: DatabaseSync | undefined
  try {
    handle = new DatabaseSync(dbPath, { readOnly: true })
    const rows = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    const counts: Record<string, number> = {}
    const skipped: string[] = []
    for (const row of rows.slice(0, maxTables)) {
      const name = String(row.name)
      if (name.startsWith('sqlite_')) continue
      if (!SAFE_TABLE_NAME.test(name)) {
        skipped.push(name)
        continue
      }
      try {
        const got = handle.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number | bigint }
        counts[name] = Number(got.n)
      } catch {
        skipped.push(name)
      }
    }
    return { counts, skipped }
  } catch (err) {
    return { counts: {}, skipped: [], error: (err as Error).message }
  } finally {
    try {
      handle?.close()
    } catch {
      // Pod bunom ročaj sprosti šele GC (enako kot v1.169.0).
    }
  }
}
