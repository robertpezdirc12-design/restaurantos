/**
 * v1.183.0 — lokalni migracijski pogon: sme SAMO DODAJATI (PRD
 * docs/PRD-LOKALNA-BAZA.md F3, A4 in cesta §8; docs/LOKALNI-ZAGON.md §7 je do
 * te izdaje lastniku pisal, naj POČAKA na pogon, ki ga ni).
 *
 * Zakaj ne `prisma migrate deploy` in ne `prisma db push` — izmerjeno
 * 2026-10-27 na tej napravi (Prisma 6.19.2 + bun 1.4.3 + Windows):
 *  - `prisma/migrations/` ima ENO samo selitev (Postgres osnovna različica) in
 *    `migration_lock.toml` z `provider = "postgresql"`: zgodovine SQLite selitev
 *    NI, `migrate deploy` nima česa izvesti;
 *  - `bun run db:push` nosi `--accept-data-loss` in je za živo obrat prepovedan
 *    (worklog.md:3678 beleži nesrečo, kjer je ta zastavica izbrisala stolpce);
 *  - `migrate diff --from-url <živa> --to-schema-datamodel <zrcalo>` na sveži
 *    usklajeni bazi vrne 32 B (`-- This is an empty migration.`), na bazi, ki jo
 *    je mesecev nabiral `db push`, pa 2796 B `-- RedefineTables` šuma, ker sta
 *    `PayLink` in `PrintJob` nastala iz POSTGRES DDL-ja (`DECIMAL(65,30)`,
 *    `TIMESTAMP(3)`, `CONSTRAINT "…_pkey"`);
 *  - isti diff za manjkajoč `PrintJob.createdAt` (NOT NULL s privzetkom) vrne
 *    1169 B preoblikovanja z `DROP TABLE`, za `PayLink.sessionId` (nullable) pa
 *    66 B čistega `ALTER TABLE … ADD COLUMN`. Izpisa torej NE smemo prepisati:
 *    preoblikovanje je ravno tisto, kar obljubljamo, da ne storimo;
 *  - SQLite pa `ADD COLUMN … NOT NULL DEFAULT true` na tabeli s štirimi vrsticami
 *    SPREJME in vsem štirim da TRUE (izmerjeno: 4 → 4 vrstice, `integrity_check`
 *    `ok`). Definicijo zato vzamemo iz kanoničnega DDL-ja (`migrate diff
 *    --from-empty`, izmerjeno 2026-10-27: 167 915 B izpisa orodja, 167 909 B prek
 *    `Bun.spawnSync`, 135 `CREATE TABLE`, 571 `CREATE INDEX`, 0 `ALTER TABLE`,
 *    2,77 s), jo razkosamo po stolpcih in iz nje sestavimo
 *    samo tisto, kar je res dodajanje.
 *
 * Tri lastnosti, ki jih ta datoteka jamči in jih testi pinnejo:
 *  1) PRIMERJAVA JE PO SQLite AFINITETI (`columnAffinity`), ne po črki: sicer bi
 *     vsaka nabrana baza dobila lažno zavrnitev na `DECIMAL(65,30)`;
 *  2) ZAVRNITEV JE REZULTAT, ne izjema in ne blokada: `buildPlan` vrne razčlenjen
 *     seznam razlogov skupaj z `lahkoUporabi`. Zavrnjenega stolpca pogon NE
 *     dotakne, varni dodatki pa se ZAPIŠEJO — izmerjeno 2026-10-27 na
 *     `prisma/db/ci1.182.0.db`, kjer je edina razlika tuj ključ, ki ga pogon ne
 *     more storiti: če bi zavrnitev blokirala batch, bi bil ukaz na takšni bazi
 *     vedno ničelen, lastnik pa bi prav takrat potreboval nov stolpec. Ostane
 *     javljen povsod: v rezultatu, v izpisu in v izhodni kodi ukaza;
 *  3) PRED PRVIM ZAPISEM nastane preverjena kopija (`VACUUM INTO` + `integrity_check`)
 *     in celoten batch teče v ENI transakciji z `PRAGMA foreign_key_check` pred
 *     `COMMIT`, zato odpoved v sredini pusti bazo nedotaknjeno.
 *
 * Stolpci se namerno dodajo NA KONEC tabele (SQLite `ADD COLUMN` drugače ne zna).
 * Fizični vrstni red stolpcev je v SQLite zunanjem za poimenovane poizvedbe, a
 * PRIMERLJIVO: naslednji `prisma db push` ali `migrate diff` bo zaradi tega hotel
 * preoblikovati tabelo. Pogon na to ne odgovori z brisanjem, ampak z javljanjem.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LOCAL_BUSY_TIMEOUT_MS, drainWal, isDatabaseInUse, snapshotInto, verifyBackup } from './local-durability'

/** Kopija pred migracijo: isti obrat kot `pred-push-` in `pred-obnovo-`. */
export const LOCAL_PRE_MIGRATE_PREFIX = 'pred-migracijo-'
/** Isti prag kot pred-push kopije: migracij je malo, kupa kopij pa je laž. */
export const LOCAL_MAX_PRE_MIGRATE_SNAPSHOTS = 5

export interface StolpecIzSheme {
  ime: string
  /** Celotna vrstica iz kanoničnega DDL-ja, brez vejice na koncu. */
  izjava: string
  tip: string
  niNull: boolean
  privzetek: string | null
  vPrimarnemKljuceu: boolean
}

export interface TujKljuc {
  stolpci: string[]
  naTabelo: string
  onDelete: string | null
  onUpdate: string | null
}

export interface Indeks {
  ime: string
  tabela: string
  unikaten: boolean
  stolpci: string[]
  /** Kanonični `CREATE … INDEX …` brez podajice na koncu. */
  definicija: string
}

export interface TabelaIzSheme {
  ime: string
  stolpci: StolpecIzSheme[]
  tujihKljucov: TujKljuc[]
  indeksi: Indeks[]
  /** Kanonični DDL blok, pripravljen za izvedbo. */
  ddl: string
}

export interface StolpecIzBaze {
  ime: string
  tip: string
  niNull: boolean
  privzetek: string | null
  vPrimarnemKljuceu: boolean
}

export interface TabelaIzBaze {
  ime: string
  stolpci: StolpecIzBaze[]
  tujihKljucov: TujKljuc[]
  indeksi: Indeks[]
}

export type VrstaStavke = 'dodaj-stolpec' | 'ustvari-tabelo' | 'ustvari-indeks'

export interface Stavka {
  vrsta: VrstaStavke
  tabela: string
  stolpec?: string
  /** Ime indeksa, da ga suhi tek izpiše razločljivo (`ustvari-indeks` jih je lahko več na tabelo). */
  indeks?: string
  /** En stavek BREZ podajice na koncu: `db.exec` jo sprejme, izpis načrta pa je berljiv. */
  sql: string
}

export type KodZavrnitve =
  | 'spremeni-tip'
  | 'zatesni-null'
  | 'popusti-null'
  | 'spremeni-privzetek'
  | 'nov-primarni-kljuc'
  | 'spremeni-primarni-kljuc'
  | 'manjka-privzetek'
  | 'nov-tuj-kljuc'

export interface Zavrnitev {
  tabela: string
  stolpec?: string
  kod: KodZavrnitve
  razlog: string
}

export interface Odvecek {
  tabela: string
  stolpec: string
}

export interface Nacrt {
  stavke: Stavka[]
  zavrnitve: Zavrnitev[]
  /** Stolpci, ki jih je baza nekdaj imela, shema pa jih ne pozna več. Nikoli se ne izbrišejo. */
  odvecni: Odvecek[]
  jePrazen: boolean
  lahkoUporabi: boolean
}

export interface RezultatMigracije {
  opravljene: string[]
  zavrnitve: Zavrnitev[]
  odvecni: Odvecek[]
  kopija: string | null
  napaka: string | null
  vrsticePred: Record<string, number>
  vrsticePo: Record<string, number>
  journalMode: string
}

export interface NacrtujVhod {
  /** Kanonični DDL; če ga ni, ga pogon sam iztakne iz `schemaPath`. */
  schemaText?: string
  schemaPath?: string
  dbPath: string
  cwd?: string
}

export interface UporabiVhod {
  dbPath: string
  plan: Nacrt
  backupsDir: string
  now?: Date
}

const ZIG = (now: Date) => now.toISOString().replace(/[:.]/g, '-')

function sprosti(): void {
  ;(globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }).Bun?.gc?.(true)
}

/** Privzeti vrednosti primerjamo po enaki obliki: presledki, velike črke, BOOLEAN kot 0/1. */
function normalizirajPrivzetek(v: string | null): string | null {
  if (v === null) return null
  const t = v.replace(/\s+/g, ' ').trim().toUpperCase()
  if (t === 'TRUE') return '1'
  if (t === 'FALSE') return '0'
  return t
}

/**
 * SQLite afiniteta po dokumentiranih pravilih (vrstni red preizkusov je del
 * pravila: `INT` zmaga pred vsem, zato je npr. `TIMESTAMP` NUMERIC in `BIGINT`
 * INTEGER). Pri nabranih bazah to prepreči lažne razlike: `DECIMAL(65,30)` in
 * `DECIMAL` sta ISTA afiniteta, pa ju `migrate diff` razglasa za razliko.
 */
export function columnAffinity(izjava: string): 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC' {
  const t = izjava.toUpperCase()
  if (t.includes('INT')) return 'INTEGER'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT'
  if (t.includes('BLOB')) return 'BLOB'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

function razčleniStolpec(vrstica: string): StolpecIzSheme | null {
  const ujeta = vrstica.match(/^"([^"]+)"\s+(\S+)\s*(.*)$/)
  if (!ujeta) return null
  const [, ime, tip, rep] = ujeta
  const privzetek = rep.match(/\bDEFAULT\s+([\s\S]+)$/i)
  return {
    ime,
    izjava: vrstica,
    tip,
    niNull: /\bNOT NULL\b/i.test(rep),
    privzetek: privzetek ? privzetek[1].trim() : null,
    vPrimarnemKljuceu: /\bPRIMARY KEY\b/i.test(rep),
  }
}

function razčleniTujKljuc(vrstica: string): TujKljuc | null {
  const ujeta = vrstica.match(/^CONSTRAINT\s+"[^"]+"\s+FOREIGN KEY\s*\(([^)]*)\)\s+REFERENCES\s+"([^"]+)"\s*\(([^)]*)\)/i)
  if (!ujeta) return null
  return {
    stolpci: razcepiSeznam(ujeta[1]),
    naTabelo: ujeta[2],
    onDelete: referencijskiUklop(vrstica, 'DELETE'),
    onUpdate: referencijskiUklop(vrstica, 'UPDATE'),
  }
}

/**
 * Referencijski uklop kot besedilo, ne kot poljubna črkovna zveza: na napačno
 * oblikovanem vzorcu je `ON DELETE CASCADE ON UPDATE CASCADE` vrnil `CASCADE ON`,
 * kar je razvidno iz F1 na pravi shemi (izmerjeno 2026-10-27).
 */
const UKLOPI = 'NO ACTION|SET NULL|SET DEFAULT|RESTRICT|CASCADE'
function referencijskiUklop(vrstica: string, smer: 'DELETE' | 'UPDATE'): string | null {
  const ujeto = vrstica.match(new RegExp(`ON ${smer} (${UKLOPI})`, 'i'))
  return ujeto ? ujeto[1].toUpperCase() : null
}

/** `"a", "b"` → `['a', 'b']`: stopec se lahko imenuje tudi s presledkom, narekovaji pa so vedno naveden. */
function razcepiSeznam(surov: string): string[] {
  return surov
    .split(',')
    .map((x) => x.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

function razčleniIndeks(vrstica: string): Indeks | null {
  const ujeta = vrstica.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+"([^"]+)"\s*\((.*)\)\s*;?$/i)
  if (!ujeta) return null
  return {
    ime: ujeta[2],
    tabela: ujeta[3],
    unikaten: Boolean(ujeta[1]),
    stolpci: razcepiSeznam(ujeta[4]),
    /** Kanonični `CREATE … INDEX …` brez podajice na koncu. */
    definicija: vrstica.replace(/;$/, '').trim(),
  }
}

/**
 * Bere SAMO obliko, kakršno izda `prisma migrate diff --from-empty` (izmerjeno
 * 2026-10-27): `CREATE TABLE "T" (` na svoji vrsti, vsak stolpec in vsaka
 * omejitev na svoji vrsti z zamikom, zaprto z `);`, indeksi posebej.
 */
export function parseCanonicalDdl(sql: string): Map<string, TabelaIzSheme> {
  const tabele = new Map<string, TabelaIzSheme>()
  const primarniKljuci = new Map<string, Set<string>>()
  let trenutna: TabelaIzSheme | null = null

  for (const surova of sql.split(/\r?\n/)) {
    const vrstica = surova.trim()
    if (!vrstica) continue

    if (vrstica === ');') {
      if (trenutna) {
        trenutna.ddl += ');'
        trenutna = null
      }
      continue
    }

    const zacetek = vrstica.match(/^CREATE TABLE "([^"]+)" \($/)
    if (zacetek) {
      trenutna = { ime: zacetek[1], stolpci: [], tujihKljucov: [], indeksi: [], ddl: `${surova.replace(/\s+$/, '')}\n` }
      tabele.set(trenutna.ime, trenutna)
      primarniKljuci.set(trenutna.ime, new Set())
      continue
    }

    if (trenutna) {
      const ddlVrstica = surova.replace(/\s+$/, '')
      trenutna.ddl += `${ddlVrstica}\n`
      const osnova = vrstica.replace(/,$/, '')
      if (/^CONSTRAINT\b/i.test(osnova) || /^PRIMARY KEY\b/i.test(osnova) || /^UNIQUE\b/i.test(osnova)) {
        const tuj = razčleniTujKljuc(osnova)
        if (tuj) trenutna.tujihKljucov.push(tuj)
        const pk = osnova.match(/^(?:CONSTRAINT\s+"[^"]+"\s+)?PRIMARY KEY\s*\(([^)]*)\)/i)
        if (pk) {
          for (const ime of razcepiSeznam(pk[1])) primarniKljuci.get(trenutna.ime)?.add(ime)
        }
        continue
      }
      const stolpec = razčleniStolpec(osnova)
      if (stolpec) trenutna.stolpci.push(stolpec)
      continue
    }

    const indeks = razčleniIndeks(vrstica)
    if (indeks && tabele.has(indeks.tabela)) tabele.get(indeks.tabela)?.indeksi.push(indeks)
  }

  for (const [ime, tabela] of tabele) {
    const cl = primarniKljuci.get(ime)
    if (!cl?.size) continue
    for (const stolpec of tabela.stolpci) if (cl.has(stolpec.ime)) stolpec.vPrimarnemKljuceu = true
  }

  return tabele
}

/** Indeks, ki ga še ni, ustvari z `IF NOT EXISTS`, da ponovni tek ne sme biti napaka. */
function indeksSql(i: Indeks): string {
  return i.definicija.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\b/i, (_v, unikaten) => `CREATE ${unikaten ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS`)
}

/**
 * Stanje žive baze, samo z BRANJEM (`readOnly`): tabel, njihovih stolpcev po
 * vrsti, tujih ključev (`PRAGMA foreign_key_list`) in poimenovanih indeksov.
 */
export function readLiveState(dbPath: string): Map<string, TabelaIzBaze> {
  const stanje = new Map<string, TabelaIzBaze>()
  if (!existsSync(dbPath)) return stanje
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tabele = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
      name: string
    }>
    for (const { name } of tabele) {
      const citat = `"${name.replace(/"/g, '""')}"`
      const stolpci = (
        db.prepare(`PRAGMA table_info(${citat})`).all() as Array<{
          name: string
          type: string
          notnull: number
          dflt_value: string | null
          pk: number
        }>
      ).map((s) => ({
        ime: s.name,
        tip: s.type,
        niNull: s.notnull === 1,
        privzetek: s.dflt_value === null || s.dflt_value === undefined ? null : String(s.dflt_value),
        vPrimarnemKljuceu: s.pk > 0,
      }))
      const fkVrstice = db.prepare(`PRAGMA foreign_key_list(${citat})`).all() as Array<{
        id: number
        seq: number
        table: string
        from: string
        on_delete: string
        on_update: string
      }>
      const poId = new Map<number, TujKljuc>()
      for (const r of fkVrstice) {
        const dosedanji = poId.get(r.id) ?? { stolpci: [] as string[], naTabelo: r.table, onDelete: null, onUpdate: null }
        dosedanji.stolpci.push(r.from)
        dosedanji.onDelete = r.on_delete ? String(r.on_delete).toUpperCase() : null
        dosedanji.onUpdate = r.on_update ? String(r.on_update).toUpperCase() : null
        poId.set(r.id, dosedanji)
      }
      const indeksi = (
        db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name`).all(name) as Array<{
          name: string
          sql: string
        }>
      )
        .map((r) => razčleniIndeks(r.sql))
        .filter((i): i is Indeks => i !== null)
      stanje.set(name, { ime: name, stolpci, tujihKljucov: [...poId.values()], indeksi })
    }
  } finally {
    db.close()
    sprosti()
  }
  return stanje
}

/**
 * Razlika med shemo in bazo, razčlenjena NA STOLPCE. Vrstni red stolpcev namenoma
 * NI merilo: SQLite ga `ADD COLUMN` ne more ohraniti, menjava vrstnega reda pa
 * podatkov ne pomeni.
 */
export function buildPlan(shema: Map<string, TabelaIzSheme>, baza: Map<string, TabelaIzBaze>): Nacrt {
  const stavke: Stavka[] = []
  const zavrnitve: Zavrnitev[] = []
  const odvecni: Odvecek[] = []

  for (const [ime, izSheme] of shema) {
    const izBaze = baza.get(ime)
    if (!izBaze) {
      // Celotna tabela manjka: kanonični DDL blok je že samostojen stavek.
      const ddl = izSheme.ddl.trimEnd().replace(/;$/, '')
      stavke.push({ vrsta: 'ustvari-tabelo', tabela: ime, sql: ddl })
      for (const i of izSheme.indeksi) stavke.push({ vrsta: 'ustvari-indeks', tabela: ime, indeks: i.ime, sql: indeksSql(i) })
      continue
    }

    const vBazi = new Map(izBaze.stolpci.map((s) => [s.ime, s]))
    for (const s of izSheme.stolpci) {
      const t = vBazi.get(s.ime)
      if (!t) {
        if (s.vPrimarnemKljuceu) {
          zavrnitve.push({
            tabela: ime,
            stolpec: s.ime,
            kod: 'nov-primarni-kljuc',
            razlog: `Stolpec ${ime}.${s.ime} je v shemi primarni ključ, v bazi pa ga ni. SQLite primarnega ključa na živo tabelo ne more dodati, to zahteva preoblikovanje tabele, tega pa lokalni pogon ne stori.`,
          })
          continue
        }
        if (s.niNull && s.privzetek === null) {
          zavrnitve.push({
            tabela: ime,
            stolpec: s.ime,
            kod: 'manjka-privzetek',
            razlog: `Stolpec ${ime}.${s.ime} je NOT NULL brez privzete vrednosti. SQLite tak DDL na neprazni tabeli zavrne, na prazni pa ga sprejme in šele naslednji vnos pade z "NOT NULL constraint failed" (izmerjeno 2026-10-27). Oboje je baza, ki jo bo aplikacija pisala v napako, zato ga pogon ne izda. Modelu dodajte privzeto vrednost (@default) in ukaz ponovite.`,
          })
          continue
        }
        if (/AUTOINCREMENT/i.test(s.izjava)) {
          zavrnitve.push({
            tabela: ime,
            stolpec: s.ime,
            kod: 'nov-primarni-kljuc',
            razlog: `Stolpec ${ime}.${s.ime} bi moral biti AUTOINCREMENT, SQLite pa samodejnega povečevanja na živo tabelo ne more dodati. To zahteva preoblikovanje tabele, tega pa lokalni pogon ne stori.`,
          })
          continue
        }
        stavke.push({ vrsta: 'dodaj-stolpec', tabela: ime, stolpec: s.ime, sql: `ALTER TABLE "${ime}" ADD COLUMN ${s.izjava}` })
        continue
      }

      if (columnAffinity(s.tip) !== columnAffinity(t.tip)) {
        zavrnitve.push({
          tabela: ime,
          stolpec: s.ime,
          kod: 'spremeni-tip',
          razlog: `Stolpec ${ime}.${s.ime} ima v bazi izjavo "${t.tip}", shema pa zahteva "${s.tip}"; to sta različni SQLite afiniteti (${columnAffinity(t.tip)} proti ${columnAffinity(s.tip)}). Sprememba tipa zahteva preoblikovanje tabele, tega pa lokalni pogon ne stori.`,
        })
        continue
      }
      if (s.vPrimarnemKljuceu !== t.vPrimarnemKljuceu) {
        zavrnitve.push({
          tabela: ime,
          stolpec: s.ime,
          kod: 'spremeni-primarni-kljuc',
          razlog: `Stolpec ${ime}.${s.ime} je v primarnem ključu drugje, kot ga zahteva shema. To zahteva preoblikovanje tabele, tega pa lokalni pogon ne stori.`,
        })
        continue
      }
      if (s.niNull && !t.niNull) {
        zavrnitve.push({
          tabela: ime,
          stolpec: s.ime,
          kod: 'zatesni-null',
          razlog: `Stolpec ${ime}.${s.ime} baza dopušča kot NULL, shema pa zahteva NOT NULL. Zatesnitev zahteva preoblikovanje tabele, tega pa lokalni pogon ne stori.`,
        })
        continue
      }
      if (!s.niNull && t.niNull) {
        zavrnitve.push({
          tabela: ime,
          stolpec: s.ime,
          kod: 'popusti-null',
          razlog: `Stolpec ${ime}.${s.ime} je v bazi NOT NULL, shema pa ga sedaj dopušča kot NULL. Popustitev zahteva preoblikovanje tabele, tega pa lokalni pogon ne stori.`,
        })
        continue
      }
      if (normalizirajPrivzetek(s.privzetek) !== normalizirajPrivzetek(t.privzetek)) {
        zavrnitve.push({
          tabela: ime,
          stolpec: s.ime,
          kod: 'spremeni-privzetek',
          razlog: `Stolpec ${ime}.${s.ime} ima v bazi privzeto vrednost ${t.privzetek ?? 'brez'}, shema pa zahteva ${s.privzetek ?? 'brez'}. Privzete vrednosti SQLite na živo ne more spremeniti, to zahteva preoblikovanje tabele, tega pa lokalni pogon ne stori.`,
        })
      }
    }

    for (const fk of izSheme.tujihKljucov) {
      const gaZeJe = izBaze.tujihKljucov.some((x) => x.naTabelo === fk.naTabelo && x.stolpci.join(',') === fk.stolpci.join(','))
      if (!gaZeJe) {
        zavrnitve.push({
          tabela: ime,
          stolpec: fk.stolpci[0],
          kod: 'nov-tuj-kljuc',
          razlog: `Shema za tabelo ${ime} zahteva tuj ključ (${fk.stolpci.join(', ')}) → ${fk.naTabelo}, v bazi pa takega ni. Tujega ključa SQLite na živo tabelo ne more dodati brez preoblikovanja, tega pa lokalni pogon ne stori.`,
        })
      }
    }

    const imenaIndeksov = new Set(izBaze.indeksi.map((i) => i.ime))
    for (const i of izSheme.indeksi) {
      if (!imenaIndeksov.has(i.ime)) stavke.push({ vrsta: 'ustvari-indeks', tabela: ime, indeks: i.ime, sql: indeksSql(i) })
    }
  }

  for (const [ime, izBaze] of baza) {
    const izSheme = shema.get(ime)
    if (!izSheme) continue
    const vShemi = new Set(izSheme.stolpci.map((s) => s.ime))
    for (const s of izBaze.stolpci) if (!vShemi.has(s.ime)) odvecni.push({ tabela: ime, stolpec: s.ime })
  }

  return {
    stavke,
    zavrnitve,
    odvecni,
    jePrazen: stavke.length === 0 && zavrnitve.length === 0,
    lahkoUporabi: zavrnitve.length === 0,
  }
}

type BunRod = { spawnSync: (cmd: string[], opts: { cwd?: string }) => { exitCode: number; stdout: { toString(): string }; stderr: { toString(): string } } }

/**
 * Kanonični DDL cele zrcalne sheme, kot ga izdela Prisma sama. Nič se ne
 * dotakne baze: `--from-empty` je samo vir besedila.
 */
export function canonicalDdlFromSchema(schemaPath: string, cwd: string = process.cwd()): string {
  const rod = (globalThis as { Bun?: BunRod }).Bun
  if (!rod?.spawnSync) {
    throw new Error('[local] Kanoničnega DDL-ja ni bilo mogoče narediti: pogon potrebuje bun tekač (Bun.spawnSync).')
  }
  const absolutna = path.isAbsolute(schemaPath) ? schemaPath : path.join(cwd, schemaPath)
  if (!existsSync(absolutna)) {
    throw new Error(`[local] Zrcalne sheme ${schemaPath} ni, zato kanoničnega DDL-ja ni bilo mogoče narediti. Sheme ni bilo mogoče spremeniti.`)
  }
  const rezultat = rod.spawnSync(['bunx', 'prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', absolutna, '--script'], { cwd })
  if (rezultat.exitCode !== 0) {
    throw new Error(
      `[local] Kanoničnega DDL-ja ni bilo mogoče narediti: ukaz "prisma migrate diff --from-empty" ni uspel (izhodna koda ${rezultat.exitCode}): ${rezultat.stderr
        .toString()
        .trim()
        .slice(0, 300)}`,
    )
  }
  return rezultat.stdout.toString()
}

export function planMigration(vhod: NacrtujVhod): Nacrt {
  const kanonicni = vhod.schemaText ?? canonicalDdlFromSchema(vhod.schemaPath ?? 'prisma/schema.sqlite.prisma', vhod.cwd ?? process.cwd())
  const shema = parseCanonicalDdl(kanonicni)
  // Meritev 27. 10. 2026: prazna ali tuja besedila (npr. obvestilo `prisma migrate
  // diff` druge različice orodja, ki izide z izhodno kodo 0) razčlenijo na NIO
  // tabel. `buildPlan` nad prazno shemo ne najde ne razlike ne odvečnega stolpca,
  // zato bi izpis „0 dodatkov · 0 zavrnitev · izhod 0" trdil, da je baza usklajena
  // — najpomirjujoč napačen odgovor, kar bi ga ukaz lahko dal. Brez vira definicij
  // pogon ne sodi ničesar.
  if (shema.size === 0) {
    throw new Error(
      '[local] Iz kanoničnega DDL-ja ni bilo razčlenjene nobene tabele, zato razlike do sheme ni mogoče soditi. ' +
        'Ukaz `prisma migrate diff --from-empty` je najverjetneje izpisal obvestilo in ne DDL-ja (druga različica orodja?). ' +
        'Dokler vira definicij ni, pogon NE trdi, da je baza usklajena.',
    )
  }
  return buildPlan(shema, readLiveState(vhod.dbPath))
}

function steVrstice(db: DatabaseSync, tabela: string): number {
  const obstaja = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tabela)
  if (!obstaja) return 0
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM "${tabela.replace(/"/g, '""')}"`).get() as { c: number }).c)
}

function zadrziKopije(backupsDir: string): void {
  if (!existsSync(backupsDir)) return
  const svoji = readdirSync(backupsDir)
    .filter((f) => f.startsWith(LOCAL_PRE_MIGRATE_PREFIX) && f.endsWith('.db'))
    .sort()
  for (const name of svoji.slice(0, Math.max(0, svoji.length - LOCAL_MAX_PRE_MIGRATE_SNAPSHOTS))) {
    rmSync(path.join(backupsDir, name), { force: true })
  }
}

/**
 * Vse ali nič. Vrstni red korakov je del obljube:
 *  1) baze mora biti in aplikacije ne sme biti v njej (rep z vsebino);
 *  2) če ni česa dodati, se NE ZAPIŠE NIČ, tudi kopije ne;
 *  3) zavrnitev ne blokira varnih dodatkov (E2), ostane pa javljena v rezultatu;
 *  4) šele tedaj kopija, preverjena PRED prvim zapisom;
 *  5) batch v eni transakciji, `foreign_key_check` in `integrity_check` pred COMMIT.
 */
export function applyMigration({ dbPath, plan, backupsDir, now = new Date() }: UporabiVhod): RezultatMigracije {
  const nic = (): RezultatMigracije => ({
    opravljene: [],
    zavrnitve: plan.zavrnitve,
    odvecni: plan.odvecni,
    kopija: null,
    napaka: null,
    vrsticePred: {},
    vrsticePo: {},
    journalMode: '',
  })

  if (!existsSync(dbPath)) {
    throw new Error(
      `[local] Baze ${dbPath} ni, zato migracije ni bilo mogoče začeti. Nobena datoteka ni bila spremenjena — prvo namestitev naredi ` +
        '`bun run local`, ne ta ukaz.',
    )
  }
  if (isDatabaseInUse(dbPath)) {
    throw new Error(
      '[local] Baza ima rep z neprečiščenimi zapisi, zato je videti, da aplikacija še teče. Migracija se NI začela in nobena datoteka ni bila ' +
        'spremenjena. Ustavite jo s Ctrl+C in ponovite. Če aplikacija NE teče (ustavljena je bila na silo ali je baza kopija), jo enkrat zaženite ' +
        'z `bun run local` in ustavite s Ctrl+C — ob čistem postanku se rep počisti. Datoteke `-wal` nikoli ne brišite ročno, ker v njej še je.',
    )
  }
  if (plan.stavke.length === 0) return nic()

  mkdirSync(backupsDir, { recursive: true, mode: 0o700 })
  const kopija = path.join(backupsDir, `${LOCAL_PRE_MIGRATE_PREFIX}${ZIG(now)}.db`)
  try {
    snapshotInto(dbPath, kopija)
    verifyBackup(kopija)
  } catch (err) {
    rmSync(kopija, { force: true })
    rmSync(`${kopija}-wal`, { force: true })
    rmSync(`${kopija}-shm`, { force: true })
    throw new Error(`[local] Varnostne kopije pred migracijo ni bilo mogoče narediti (${(err as Error).message}). Baza NI bila spremenjena.`)
  }
  zadrziKopije(backupsDir)

  const prizadete = [...new Set(plan.stavke.map((s) => s.tabela))]
  const vrsticePred: Record<string, number> = {}
  const vrsticePo: Record<string, number> = {}
  const db = new DatabaseSync(dbPath)
  let napaka: string | null = null
  let journalMode = ''
  let opravljene: string[] = []
  try {
    db.exec(`PRAGMA busy_timeout=${LOCAL_BUSY_TIMEOUT_MS}`)
    db.exec('PRAGMA foreign_keys=OFF')
    journalMode = String((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toLowerCase()
    for (const t of prizadete) vrsticePred[t] = steVrstice(db, t)
    db.exec('BEGIN')
    const poTransakciji: Record<string, number> = {}
    try {
      for (const s of plan.stavke) db.exec(s.sql)
      const krsitve = db.prepare('PRAGMA foreign_key_check').all()
      if (krsitve.length > 0) {
        throw new Error(`tuji ključi so v nasprotju s podatki (${krsitve.length} zadetkov v pregledu foreign_key_check)`)
      }
      for (const t of prizadete) poTransakciji[t] = steVrstice(db, t)
      const pregled = String((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toLowerCase()
      if (pregled !== 'ok') throw new Error(`integritetni pregled je vrnil "${pregled}"`)
      db.exec('COMMIT')
      Object.assign(vrsticePo, poTransakciji)
      opravljene = plan.stavke.map((s) => s.sql)
    } catch (err) {
      db.exec('ROLLBACK')
      napaka = (err as Error).message
    }
  } finally {
    db.close()
    sprosti()
    // Postanek, ki ga lastnik ne more narediti ročno: če repa ne pretakamo, ga
    // naslednji zagon ali obnova vidi kot neprečiščen zapis, `isDatabaseInUse`
    // pa laže. Izmerjeno 2026-10-27: po zaprtju rep ALI izgine ALI ostane z
    // vsebino (20632 B) — neodločeno, zato mora biti ta korak naš, ne srečin.
    drainWal(dbPath)
  }

  return {
    opravljene,
    zavrnitve: plan.zavrnitve,
    odvecni: plan.odvecni,
    kopija,
    napaka,
    vrsticePred,
    vrsticePo,
    journalMode,
  }
}

/** Za runbook in CLI: kaj naj lastnik stori, kadar pogon kaj zavrne. */
export function migracijskoOpozorilo(plan: Nacrt): string {
  if (plan.zavrnitve.length === 0) return ''
  const stavki = plan.zavrnitve.map((z) => `  - ${z.tabela}${z.stolpec ? `.${z.stolpec}` : ''}: ${z.razlog}`).join('\n')
  return (
    `[local] Zavrnjenih razlik je ${plan.zavrnitve.length}, ker bi zahtevale preoblikovanje tabele ali brisanje. ` +
    `Pogon zna samo dodajati, zato jih NE stori.\n${stavki}\n` +
    '  → Za tak poseg je potrebna ročno napisana selitev v razvojni veji; `bun run db:push` je ne sme nadomestiti, ker nosi --accept-data-loss.'
  )
}
