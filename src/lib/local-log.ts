/**
 * v1.181.0 — lokalni dnevnik napak (PRD docs/PRD-LOKALNA-BAZA.md, R4: "dnevnik napak").
 *
 * Zakaj sploh datoteka: `src/lib/db-error.ts:138` je do te izdaje pisal napake
 * samo v `console.error`. Od kar aplikacijo ob prijavi zaganja opravilna datoteka
 * (v1.175.0, R2b2), stdout nima bralca — lastnik do izpisa ne pride, razen če
 * ročno zažene `bun run local` v terminalu. Podpora je torej ostala brez
 * dokazov, zato je dnevnik prvi del R4.
 *
 * Pravila, ki jih brani tests/v181-support-bundle.test.ts:
 *  - zapis NIKOLI ne vrže: diagnostika ne sme sesuti obdelave zahteve;
 *  - en zapis = ena vrstica (nov vrstice v sporočilu se nadomestijo s presledkom),
 *    sled klicev se piše v svoje vrstice s predpono `| `, da `tail` šteje realne
 *    zapise;
 *  - dnevna rota po UTC, meja 1 MiB na datoteko, največ 3 datoteke na dan, 7 dni
 *    hrambe. Ko zmanjka prostora, se to JAVI (`error` in `appended: false`) in ne
 *    tiho pozabi — tiho izgubljen dokaz je enak nikoli napisanemu;
 *  - mapa `logs` sme vsebovati tudi tuje datoteke; čiščenje pobriše SAMO lastne.
 *
 * Zadrževanje je namenoma krajše od kopij (14 dni, v1.169.0): kopija varuje
 * podatke, dnevnik pojasnjuje, kaj je šlo narobe. Podporni paket vedno bere samo rep.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const LOCAL_LOG_SUBDIR = 'logs'
export const LOCAL_LOG_PREFIX = 'errors-'
export const LOCAL_MAX_LOG_DAYS = 7
export const LOCAL_MAX_LOG_FILES_PER_DAY = 3
export const LOCAL_MAX_LOG_BYTES = 1_048_576

export interface ErrorLogEntry {
  scope: string
  message: string
  code?: string
  stack?: string
  at: Date
}

export interface LogWriteResult {
  file: string
  appended: boolean
  error?: string
}

export interface LogTail {
  lines: string[]
  files: string[]
  /** Javljeno stanje, ko dnevnika ni — prazen seznam ne sme delovati kot "brez napak". */
  unavailable?: string
}

const LOG_NAME_RE = new RegExp(`^${LOCAL_LOG_PREFIX}(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.log$`)

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

export function logsDirFor(dataDir: string): string {
  return path.join(dataDir, LOCAL_LOG_SUBDIR)
}

function fileNameFor(key: string, index: number): string {
  return index <= 1 ? `${LOCAL_LOG_PREFIX}${key}.log` : `${LOCAL_LOG_PREFIX}${key}.${index}.log`
}

/** Aktivna datoteka dneva: najvišja še ne polna, sicer naslednja, sicer meja. */
function resolveActive(dataDir: string, now: Date): { file: string; full: boolean } {
  const dir = logsDirFor(dataDir)
  const key = dayKey(now)
  for (let i = LOCAL_MAX_LOG_FILES_PER_DAY; i >= 1; i--) {
    const file = path.join(dir, fileNameFor(key, i))
    let size = -1
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size < LOCAL_MAX_LOG_BYTES) return { file, full: false }
    if (i === LOCAL_MAX_LOG_FILES_PER_DAY) return { file, full: true }
    return { file: path.join(dir, fileNameFor(key, i + 1)), full: false }
  }
  return { file: path.join(dir, fileNameFor(key, 1)), full: false }
}

export function logFilePathFor(dataDir: string, now: Date = new Date()): string {
  return resolveActive(dataDir, now).file
}

/** Bralec, ki ga lahko injicira test ali podporni paket (zabeleži odprte poti). */
export interface LogReader {
  readdirSync(p: string): string[]
  readFileSync(p: string): string
}

const NODE_READER: LogReader = {
  readdirSync: (p) => readdirSync(p) as string[],
  readFileSync: (p) => readFileSync(p, 'utf8'),
}

/** Seznam datotek dnevnika, najnovejša najprej (dan padajoče, nato indeks padajoče). */
function listLogFiles(dataDir: string, cutoffKey?: string, reader: LogReader = NODE_READER): string[] {
  let names: string[]
  try {
    names = reader.readdirSync(logsDirFor(dataDir))
  } catch {
    return []
  }
  const parsed = names
    .map((name) => {
      const m = LOG_NAME_RE.exec(name)
      if (!m) return null
      return { name, key: m[1], index: m[2] ? Number(m[2]) : 1 }
    })
    .filter((x): x is { name: string; key: string; index: number } => x !== null)
    .filter((x) => !cutoffKey || x.key >= cutoffKey)
  parsed.sort((a, b) => (a.key === b.key ? b.index - a.index : a.key < b.key ? 1 : -1))
  return parsed.map((x) => path.join(logsDirFor(dataDir), x.name))
}

function toLine(entry: ErrorLogEntry): string {
  const stamp = entry.at.toISOString()
  const code = entry.code ? ` (${entry.code})` : ''
  const message = entry.message.replace(/\r?\n/g, ' ')
  const out = [`${stamp} [${entry.scope}]${code}: ${message}`]
  for (const l of (entry.stack || '').split(/\r?\n/)) {
    if (l.trim()) out.push(`| ${l.trim()}`)
  }
  return out.join('\n')
}

export function appendErrorLog(dataDir: string, entry: ErrorLogEntry, now: Date = entry.at): LogWriteResult {
  const active = resolveActive(dataDir, now)
  if (active.full) {
    return { file: active.file, appended: false, error: `meja dnevnika dosežena (${LOCAL_MAX_LOG_FILES_PER_DAY} x ${LOCAL_MAX_LOG_BYTES} B)` }
  }
  try {
    mkdirSync(logsDirFor(dataDir), { recursive: true, mode: 0o700 })
    writeFileSync(active.file, toLine(entry) + '\n', { flag: 'a+', mode: 0o600 })
    return { file: active.file, appended: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code || 'EPIS'
    return { file: active.file, appended: false, error: `${code}: ${(err as Error).message}` }
  }
}

export function tailErrorLog(
  dataDir: string,
  maxLines: number,
  now: Date = new Date(),
  reader: LogReader = NODE_READER,
): LogTail {
  const cutoffKey = dayKey(new Date(now.getTime() - (LOCAL_MAX_LOG_DAYS - 1) * 86_400_000))
  const files = listLogFiles(dataDir, cutoffKey, reader)
  if (!files.length) {
    return { lines: [], files: [], unavailable: `dnevnik ne obstaja (ni datotek v ${LOCAL_LOG_SUBDIR})` }
  }
  const collected: string[] = []
  const used: string[] = []
  for (const file of files) {
    let text: string
    try {
      text = reader.readFileSync(file)
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
    if (!lines.length) continue
    used.push(file)
    collected.unshift(...lines)
    if (collected.length >= maxLines) break
  }
  return { lines: collected.slice(-Math.max(0, maxLines)), files: used }
}

export function pruneErrorLogs(dataDir: string, now: Date = new Date()): string[] {
  const dir = logsDirFor(dataDir)
  let names: string[]
  try {
    names = readdirSync(dir) as string[]
  } catch {
    return []
  }
  const cutoff = dayKey(new Date(now.getTime() - (LOCAL_MAX_LOG_DAYS - 1) * 86_400_000))
  const removed: string[] = []
  for (const name of names) {
    const m = LOG_NAME_RE.exec(name)
    if (!m) continue
    if (m[1] >= cutoff) continue
    try {
      rmSync(path.join(dir, name), { force: true })
      removed.push(name)
    } catch {
      // Datoteka je zaklenjena — prihodnji zagon počisti znova.
    }
  }
  return removed.sort()
}
