/**
 * v1.169.0 — vzdržljivost lokalne baze (PRD docs/PRD-LOKALNA-BAZA.md, R2).
 *
 * Zakaj sploh posebej: lokalni profil od v1.165.0 teče na SQLite, a nobena
 * koda ni nastavila replica. Izmerjeno (Prisma 6.19.2 + bun 1.4.3, Windows):
 *  - sveža baza, odprta čez Prizmin pogon, je `journal_mode = delete` — WAL se
 *    SAM ne vklopi, ob izpadu elektrike med zapisom je to klasičen pokvarjen paket;
 *  - `synchronous = 2` (FULL) in `busy_timeout = 5000` sta privzeta vrednost
 *    pogona; parametri v URL (`?busy_timeout=`) so PREZRTI, zato pragmov ne
 *    nastavljamo čez `DATABASE_URL`, ampak na lastni povezavi;
 *  - `copyFileSync` nad bazo z neprečiščenim WAL vrne 2 od 3 vrstic — zadnji
 *    potrjeni zapis v kopiji manjka.
 *
 * Kopija nastane z `VACUUM INTO`, ki prebere tudi vsebino replica in vedno
 * zapiše ENO samo datoteko. Zakaj ne Online Backup API (`node:sqlite`
 * `backup()`): izmerjeno 2026-10-22 — po `await backup()` in zaprtih povezavah
 * ciljna datoteka ostane zaklenjena, `renameSync` in `rmSync` pa javita EBUSY,
 * kar razbije zadrževanje, ki mora brisati starejše kopije.
 *
 * Isti zaklenjeni ročaj se pokaže tudi pri pregledu kopije: `close()` na
 * Windows ročaja vrne šele, ko tekač pobere objekt (brez GC-ja premik ali brisanje
 * ne uspe nemmeno po 2,5 s čakanja). Zato sme biti povezava do datoteke samo
 * znotraj `withDatabase` — zunaj nje pokličemo `releaseFileHandles`.
 *
 * `journal_mode` je edini prag, ki ostane ZAPISAN v datoteki, zato ga zadostuje
 * nastaviti enkrat ob zagonu: tudi naslednja Prizmina povezava dobi WAL.
 * `busy_timeout` in `synchronous` veljata za povezavo — tu ju nastavimo na
 * naših povezavah, na Prizminih sta lastna privzeta 5000 ms oziroma FULL.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Merjena privzeta vrednost Prizminega pogona — test jo pinne. */
export const LOCAL_BUSY_TIMEOUT_MS = 5000
export const LOCAL_SYNCHRONOUS = 'FULL'

export const LOCAL_DAILY_BACKUP_PREFIX = 'dnevno-'
/** Obstoječe ime iz v1.165.0: ne preimenuj, da zadrževanje pobriše tudi stare kopije. */
export const LOCAL_PRE_PUSH_BACKUP_PREFIX = 'pre-push-'
export const LOCAL_PRE_RESTORE_PREFIX = 'pred-obnovo-'

/** Dva tedna dnevnih kopij: en sam disk v obratu ne more ponuditi več. */
export const LOCAL_MAX_DAILY_BACKUPS = 14
export const LOCAL_MAX_PRE_PUSH_BACKUPS = 5

export type BackupKind = 'dnevno' | 'pred-pushom'

export interface DurabilityState {
  journalMode: string
  synchronous: number
  busyTimeout: number
}

export interface BackupResult {
  file: string
  created: boolean
  kind: BackupKind
  integrity: 'ok'
  pageCount: number
}

export interface BackupOptions {
  now?: Date
  kind?: BackupKind
  maxBackups?: number
}

export interface RestoreOptions {
  backupPath: string
  dbPath: string
  now?: Date
  force?: boolean
}

export interface RestoreResult {
  backupPath: string
  dbPath: string
  backupsDir: string
  integrity: 'ok'
  pageCount: number
  /** Stanje replica v obnovljeni bazi — mora biti `wal`, ne šele po naslednjem zagonu. */
  journalMode: string
  /** Varnostna kopija stanja, ki smo ga prepisali — samo če je baza obstajala. */
  safetyCopy?: string
}

const PREFIXES: Record<BackupKind, string> = {
  dnevno: LOCAL_DAILY_BACKUP_PREFIX,
  'pred-pushom': LOCAL_PRE_PUSH_BACKUP_PREFIX,
}

const LIMITS: Record<BackupKind, number> = {
  dnevno: LOCAL_MAX_DAILY_BACKUPS,
  'pred-pushom': LOCAL_MAX_PRE_PUSH_BACKUPS,
}

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-')
const dayKey = (now: Date) => now.toISOString().slice(0, 10)
const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

/**
 * Zaprtje povezave ročaja na Windows ne vrne takoj, zato pregledane kopije ni
 * mogoče preimenovati ali izbrisati. Pod `bun` tekač sprosti šele expliciten GC.
 */
function releaseFileHandles(): void {
  const runtime = globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }
  runtime.Bun?.gc?.(true)
}

/** Povezava sme obstajati samo znotraj tega: ob izhodu je ročaj dejansko sproščen. */
function withDatabase<T>(file: string, fn: (db: DatabaseSync) => T): T {
  try {
    const db = new DatabaseSync(file)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } finally {
    releaseFileHandles()
  }
}

/**
 * `VACUUM INTO` prebere tudi neprečiščen rep, zato kopija vsebuje zadnji
 * potrjeni zapis; vedno zapiše ENO samo datoteko brez `-wal`/`-shm` samic.
 * Izvora ne odpiramo s pragmi — kopija ne sme spreminjati baze. Če ciljna pot
 * že obstaja, SQLite odkaže, tako da kopija nikoli ne prepise kopije.
 */
function snapshotInto(sourcePath: string, targetPath: string): void {
  if (existsSync(targetPath)) {
    throw new Error(`ciljna kopija ${path.basename(targetPath)} že obstaja`)
  }
  withDatabase(sourcePath, (db) => {
    db.exec(`PRAGMA busy_timeout=${LOCAL_BUSY_TIMEOUT_MS}`)
    db.exec(`VACUUM INTO ${sqlLiteral(targetPath)}`)
  })
}

/** Neuspela kopija ne sme pustiti polovičnega odseka. */
function removePartial(file: string): void {
  rmSync(file, { force: true })
  removeSidecars(file)
}

/**
 * Samo sapnice, nikoli datoteka sama: po obnovi morajo osiroteli `-wal`/`-shm`
 * stran, sicer preživijo stanje pred obnovo.
 */
function removeSidecars(file: string): void {
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
}

/**
 * Kopije spadajo zraven podatkovne mape, ne noter: `.../data/restaurantos.db`
 * ima `.../backups`.
 */
export function backupsDirFor(dbPath: string): string {
  const parent = path.dirname(dbPath)
  return path.basename(parent) === 'data' ? path.join(path.dirname(parent), 'backups') : path.join(parent, 'backups')
}

export function openDurabilityDatabase(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(dbPath)
  applyPragmas(db)
  return db
}

function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=wal')
  db.exec(`PRAGMA synchronous=${LOCAL_SYNCHRONOUS}`)
  db.exec(`PRAGMA busy_timeout=${LOCAL_BUSY_TIMEOUT_MS}`)
}

export function readDurabilityState(db: DatabaseSync): DurabilityState {
  const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string | number }
  const sync = db.prepare('PRAGMA synchronous').get() as { synchronous: number | string }
  const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number | string }
  return {
    journalMode: String(journal.journal_mode).toLowerCase(),
    synchronous: Number(sync.synchronous),
    busyTimeout: Number(timeout.timeout),
  }
}

/** Idempotentno: vrne WAL, če ga je kak poseg v shemo vrzel v delete. */
export function applyDurability(dbPath: string): DurabilityState {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
  return withDatabase(dbPath, (db) => {
    applyPragmas(db)
    return readDurabilityState(db)
  })
}

export function listBackups(backupsDir: string, prefix: string): string[] {
  if (!existsSync(backupsDir)) return []
  return readdirSync(backupsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .sort()
}

/** ISO žig v imenu: leksikografski red je kronološki, zato so prve najstarejše. */
function prune(backupsDir: string, prefix: string, max: number): void {
  const names = listBackups(backupsDir, prefix)
  for (const name of names.slice(0, Math.max(0, names.length - max))) {
    rmSync(path.join(backupsDir, name), { force: true })
  }
}

export interface BackupVerification {
  integrity: 'ok'
  pageCount: number
}

/**
 * Edini pregled, ki loči prazno datoteko od baze: `PRAGMA integrity_check`
 * mora vrniti `ok`. Sporočilo vedno imenuje pregled, da runbook ostane berljiv.
 */
export function verifyBackup(file: string): BackupVerification {
  try {
    return withDatabase(file, (db) => {
      const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      const pages = db.prepare('PRAGMA page_count').get() as { page_count: number | string }
      const result = String(check.integrity_check).toLowerCase()
      if (result !== 'ok') throw new Error(`vrnil "${result}"`)
      return { integrity: 'ok' as const, pageCount: Number(pages.page_count) }
    })
  } catch (err) {
    throw new Error(
      `[local] Kopija ${path.basename(file)} ni veljavna: integritetni pregled (integrity_check) ni uspel (${(err as Error).message}).`,
    )
  }
}

/**
 * Ena sama kopija na koledarski dan (UTC); pred-push kopije ima vsak poseg v
 * shemo svojo. Kopija je ena sama datoteka, prenosna na USB.
 */
export async function backupDatabase(dbPath: string, backupsDir: string, options: BackupOptions = {}): Promise<BackupResult> {
  const now = options.now ?? new Date()
  const kind = options.kind ?? 'dnevno'
  const prefix = PREFIXES[kind]
  const max = options.maxBackups ?? LIMITS[kind]

  if (!existsSync(dbPath)) {
    throw new Error(`[local] Baze ${dbPath} ni, zato kopije ni bilo mogoče narediti. Podatki niso bili spremenjeni.`)
  }

  if (kind === 'dnevno') {
    const today = listBackups(backupsDir, prefix).filter((f) => f.includes(dayKey(now)))
    if (today.length > 0) {
      const file = path.join(backupsDir, today[0])
      return { file, created: false, kind, ...verifyBackup(file) }
    }
  }

  mkdirSync(backupsDir, { recursive: true, mode: 0o700 })
  const file = path.join(backupsDir, `${prefix}${stamp(now)}.db`)
  try {
    snapshotInto(dbPath, file)
  } catch (err) {
    removePartial(file)
    throw new Error(`[local] Kopije baze ni bilo mogoče narediti (${(err as Error).message}). Podatki niso bili spremenjeni.`)
  }
  const verified = verifyBackup(file)
  prune(backupsDir, prefix, max)
  return { file, created: true, kind, ...verified }
}

/**
 * Heuristika, ne zagotovilo: rep z vsebino pomeni, da je nekdo zapisoval in
 * repa še ni počistil. Obstoječa baza + rep = aplikacija verjetno še teče.
 *
 * Omejevanje je izmerjeno (Windows, bun 1.4.3): rep NE izgine sam od sebe, ko
 * proces po ustavljanju umre — zato ga mora aplikacija počistiti ob postanku
 * (`drainWal`), sicer ta heuristika po pravilno ustavljenem obratu laže.
 */
export function isDatabaseInUse(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  const wal = `${dbPath}-wal`
  if (!existsSync(wal)) return false
  try {
    return statSync(wal).size > 0
  } catch {
    return false
  }
}

/**
 * Pretaka rep v bazo (`wal_checkpoint(TRUNCATE)`), da naslednji zagon ali
 * obnova ne vidita osirotelega repa. Izmerjeno 2026-10-22: proces, ki po
 * zapisu umre, pusti `-wal` poln (4152 B) in ga naslednji navaden odpri-zapri
 * NE pobriše; ta korak ga spravi na 0 ob ohranjenih obeh vrsticah.
 *
 * Klice se SAMO, kadar verjamemo, da aplikacije ne teče več (postnek zagona).
 * Repa ne brišemo: pri živem procesu je brisanje `-shm` onemogočeno (EBUSY),
 * `-wal` pa po uspešnem checkpointu ostane prazen in zato ne moti heuristike.
 */
export function drainWal(dbPath: string): void {
  if (!existsSync(dbPath)) return
  withDatabase(dbPath, (db) => {
    db.exec(`PRAGMA busy_timeout=${LOCAL_BUSY_TIMEOUT_MS}`)
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  })
}

/**
 * Obnova VEDNO najprej preveri kopijo in stanje, ki ga bo prepisala. Vrstni red
 * ni poljuben: pregled kopije mora biti pred vsako spremembo baze, sicer
 * pokvarjena kopija pobriše zadnjo veljavno stanje.
 */
export async function restoreDatabase({ backupPath, dbPath, now = new Date(), force = false }: RestoreOptions): Promise<RestoreResult> {
  const backupsDir = backupsDirFor(dbPath)
  if (!existsSync(backupPath)) {
    throw new Error(`[local] Kopije ${backupPath} ni. Obnova se ni začela in baza ni bila spremenjena.`)
  }
  const verified = verifyBackup(backupPath)
  if (existsSync(dbPath) && !force) {
    throw new Error(
      `[local] Baza ${dbPath} že obstaja in jo bo obnova prepisala. Potrdite z --force (stanje prej shranimo med kopije).`,
    )
  }
  if (isDatabaseInUse(dbPath)) {
    throw new Error(
      '[local] Baza ima rep z neprečiščenimi zapisi, zato je videti, da aplikacija še teče. ' +
        'Ustavite jo z Ctrl+C in ponovite obnovo. Če je bila ustavljena na silo (Upravitelj opravil, ' +
        'izpad elektrike), enkrat zaženite `bun run local` in ga ustavite s Ctrl+C — ob postanku se rep počisti.',
    )
  }

  let safetyCopy: string | undefined
  if (existsSync(dbPath)) {
    mkdirSync(backupsDir, { recursive: true, mode: 0o700 })
    safetyCopy = path.join(backupsDir, `${LOCAL_PRE_RESTORE_PREFIX}${stamp(now)}.db`)
    try {
      snapshotInto(dbPath, safetyCopy)
      verifyBackup(safetyCopy)
    } catch (err) {
      removePartial(safetyCopy)
      throw new Error(
        `[local] Varnostne kopije trenutne baze ni bilo mogoče narediti (${(err as Error).message}). Obnova se NI začela in baza je nedotaknjena.`,
      )
    }
    prune(backupsDir, LOCAL_PRE_RESTORE_PREFIX, LIMITS.dnevno)
  }

  // Prekop na začasno ime in preimenovanje: med kopiranjem nikoli ne obstaja
  // polovična baza na končni poti.
  const staging = `${dbPath}.obnova.tmp`
  try {
    copyFileSync(backupPath, staging)
    verifyBackup(staging)
    renameSync(staging, dbPath)
  } catch (err) {
    removePartial(staging)
    throw new Error(`[local] Obnova ni uspela (${(err as Error).message}). Varnostna kopija stanja pred obnovo je v ${backupsDir}.`)
  }
  // Osiroleli -wal/-shm bi sicer preživeli stanje pred obnovo.
  removeSidecars(dbPath)
  // Kopija je nastala z `VACUUM INTO`, torej je v delete načinu. Obnova mora
  // WAL vrniti takoj: če bi čakala na naslednji zagon, bi bil prvi izpad
  // elektrike po obnovi spet pokvarjen paket.
  const state = applyDurability(dbPath)
  return { backupPath, dbPath, backupsDir, ...verified, journalMode: state.journalMode, ...(safetyCopy ? { safetyCopy } : {}) }
}
