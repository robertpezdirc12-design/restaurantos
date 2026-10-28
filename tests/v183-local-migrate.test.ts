/**
 * v1.183.0 — lokalni migracijski pogon (PRD docs/PRD-LOKALNA-BAZA.md: F3, A4,
 * §8 „lokalni migracijski pogon, ki ga še ni", in docs/LOKALNI-ZAGON.md §7, ki
 * lastniku trenutno ukazuje, naj NANJ POČAKA).
 *
 * Zakaj sploh poseben pogon in ne `prisma migrate deploy` ali `db push` —
 * izmerjeno 2026-10-27 na tej napravi (Prisma 6.19.2 + bun 1.4.3 + Windows):
 *  - `prisma/migrations/` ima ENO samo selitev (00000000000000_init, Postgres
 *    osnovna različica) in `migration_lock.toml` z `provider = "postgresql"`:
 *    zgodovine SQLite selitev NI, `migrate deploy` nima česa izvesti;
 *  - `bun run db:push` nosi `--accept-data-loss` in je zato za živo obrat
 *    prepovedan (worklog.md:3678 beleži nesrečo, kjer je ta zastavica izbrisala
 *    stolpce);
 *  - `prisma migrate diff --from-url <živa> --to-schema-datamodel <zrcalo>` na
 *    sveži, popolnoma usklajeni bazi vrne 32 B („-- This is an empty migration."),
 *    na bazi, ki jo je mesecev nabiral `db push`, pa 2796 B `-- RedefineTables`
 *    šuma, ker sta bila `PayLink` in `PrintJob` nekdaj ustvarjena iz POSTGRES
 *    DDL-ja (`DECIMAL(65,30)`, `TIMESTAMP(3)`, `CONSTRAINT "…_pkey"`);
 *  - isti diff za NEDOLŽIVO manjkajoč stolpec `PrintJob.createdAt` (NOT NULL s
 *    privzetkom) vrne 1169 B preoblikovanja z `DROP TABLE "PrintJob"`, za
 *    `PayLink.sessionId` (nullable, brez privzetka) pa 66 B čistega
 *    `ALTER TABLE … ADD COLUMN`. Pogon torej NE more kar prepisati izpisa
 *    orodja `migrate diff`: preoblikovanja so ravno tisto, kar obljubljamo, da
 *    ne storimo;
 *  - SQLite pa `ALTER TABLE "Location" ADD COLUMN "emailEnabled" BOOLEAN NOT NULL
 *    DEFAULT true` SPREJME na tabeli s štirimi vrsticami in vsem štirim da TRUE
 *    (izmerjeno: vrstic 4 → 4, integritetni pregled `ok`). Manjkajoči stolpec
 *    lahko torej dodamo BREZ preoblikovanja, če vzamemo definicijo iz Prisminega
 *    kanoničnega DDL-ja (`migrate diff --from-empty`, izmerjeno 2026-10-27:
 *    167 915 B izpisa orodja / 167 909 B prek `Bun.spawnSync`,
 *    135 `CREATE TABLE`, 571 `CREATE INDEX`, 0 `ALTER TABLE`, 2,78 s).
 *
 * Obljuba testa: pogon SAMO DODAJA. Kar zahteva preoblikovanje ali brisanje,
 * zavrne — in zavrnitev je RAZČLENJEN REZULTAT, ne izjema. Pred prvim zapisom
 * nastane preverjena kopija (`VACUUM INTO`), celoten batch je v ENI
 * transakciji, zato polovično posodobljene baze ni.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  LOCAL_MAX_PRE_MIGRATE_SNAPSHOTS,
  LOCAL_PRE_MIGRATE_PREFIX,
  applyMigration,
  buildPlan,
  canonicalDdlFromSchema,
  columnAffinity,
  migracijskoOpozorilo,
  parseCanonicalDdl,
  planMigration,
  readLiveState,
  type Nacrt,
} from '../src/lib/local-migrate'
import { backupsDirFor, drainWal, listBackups, verifyBackup } from '../src/lib/local-durability'

const tmpDirs: string[] = []
const handles = new Set<DatabaseSync>()

function tempDir(prefix = 'ros-v183-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

function odpri(pot: string): DatabaseSync {
  const db = new DatabaseSync(pot)
  handles.add(db)
  return db
}

function zapri(db: DatabaseSync): void {
  db.close()
  handles.delete(db)
  ;(globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }).Bun?.gc?.(true)
}

afterAll(() => {
  for (const db of handles) {
    try {
      db.close()
    } catch {
      /* že zaprta */
    }
  }
  handles.clear()
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* Windows drži ročaj; začasna mapa je naslednja za pobrat. */
    }
  }
})

const ZIG = (s: string) => new Date(s).toISOString().replace(/[:.]/g, '-')

/**
 * Kanonični DDL, kakršnega izda `prisma migrate diff --from-empty` (oblika
 * izmerjena 2026-10-27): vsak stolpec na svoji vrsti z zamikom, tuji ključ kot
 * `CONSTRAINT "…_fkey"`, indeksi posebej. Tu brez tujih ključev, da lahko
 * testi C in E gredo skozi brez zavrnitev; A4 in D7 imata svoj vzorec.
 */
const KANON = `-- CreateTable
CREATE TABLE "KioskSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "openMinutes" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "KioskSession_code_key" ON "KioskSession"("code");
CREATE INDEX "KioskSession_status_idx" ON "KioskSession"("status");
CREATE TABLE "LoyaltyEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guestId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LoyaltyEntry_guestId_idx" ON "LoyaltyEntry"("guestId");
`

/**
 * Stanje baze, ki je ZA eno izdajo za shemo: manjka `note` in `openMinutes`,
 * manjka cela `LoyaltyEntry`, `KioskSession_status_idx` je izpisan, pa tudi
 * odvečni stolpec `oldFlag` ima. `amount` je POSTGRES okrašan
 * (`DECIMAL(65,30)`) — tisto, kar nabrane baze dejansko imajo.
 */
const STARA_BAZA = `CREATE TABLE "KioskSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "amount" DECIMAL(65,30),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "oldFlag" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "KioskSession_code_key" ON "KioskSession"("code");
`

/**
 * Postanek aplikacije, kakršen je v resnici: povezava se zapre IN se rep
 * pretaka (`drainWal`, kar `local-start` naredi ob Ctrl+C). Izmerjeno
 * 2026-10-27: kar samo zaprtje pusti `-wal` ALI prazen ALI z vsebino (20632 B)
 * — neodločeno, zato test ne sme staviti na posrečen tek: brez pretakanja bi
 * `isDatabaseInUse` v E razdelku lagala in migracije ne bi začela.
 */
function ustavi(db: DatabaseSync, pot: string): void {
  zapri(db)
  drainWal(pot)
}

function zgradiBazo(pot: string, ddl: string): void {
  const db = zgradiBazoOdpri(pot, ddl)
  ustavi(db, pot)
}

function zgradiBazoOdpri(pot: string, ddl: string): DatabaseSync {
  const db = new DatabaseSync(pot)
  db.exec('PRAGMA journal_mode=wal')
  db.exec(ddl)
  handles.add(db)
  return db
}

/**
 * Par s TUJIM ključem, ki je v bazi in v shemi ISTET — da E11 dokaže, za
 * zapisu stane guard nad podatki, ne zavrnitev zaradi samega ključa (D7).
 */
const KANON_FK = `-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "total" DECIMAL
);
CREATE TABLE "PayLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "note" TEXT,
    CONSTRAINT "PayLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PayLink_orderId_idx" ON "PayLink"("orderId");
`

const BAZA_FK = `CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "total" DECIMAL(65,30)
);
CREATE TABLE "PayLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    CONSTRAINT "PayLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PayLink_orderId_idx" ON "PayLink"("orderId");
`

describe('A — kanonični DDL je edini vir definicij', () => {
  it('A1 razčleni vsako CREATE TABLE tabelo in ohrani vrstni red', () => {
    const shema = parseCanonicalDdl(KANON)
    expect(shema.size).toBe(2)
    expect(shema.get('KioskSession')?.stolpci.map((s) => s.ime)).toEqual([
      'id',
      'code',
      'status',
      'note',
      'openMinutes',
      'amount',
      'createdAt',
    ])
  })

  it('A2 privzetek shrani DOBESNO, vključno z narekovaji in CURRENT_TIMESTAMP', () => {
    const kios = parseCanonicalDdl(KANON).get('KioskSession')
    expect(kios?.stolpci.find((s) => s.ime === 'status')?.privzetek).toBe("'active'")
    expect(kios?.stolpci.find((s) => s.ime === 'createdAt')?.privzetek).toBe('CURRENT_TIMESTAMP')
    expect(kios?.stolpci.find((s) => s.ime === 'note')?.privzetek).toBeNull()
  })

  it('A3 loči NOT NULL in stolpce v primarnem ključu', () => {
    const kios = parseCanonicalDdl(KANON).get('KioskSession')
    expect(kios?.stolpci.find((s) => s.ime === 'id')?.vPrimarnemKljuceu).toBe(true)
    expect(kios?.stolpci.find((s) => s.ime === 'id')?.niNull).toBe(true)
    expect(kios?.stolpci.find((s) => s.ime === 'note')?.niNull).toBe(false)
  })

  it('A4 tujega ključa ne prerine med stolpce, ampak ga prepozna kot omejitev tabeli', () => {
    const s = parseCanonicalDdl(
      `CREATE TABLE "PayLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    CONSTRAINT "PayLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`,
    )
    expect(s.get('PayLink')?.tujihKljucov).toEqual([{ stolpci: ['orderId'], naTabelo: 'Order', onDelete: 'CASCADE', onUpdate: 'CASCADE' }])
    expect(s.get('PayLink')?.stolpci.map((x) => x.ime)).toEqual(['id', 'orderId'])
  })

  it('A5 indeks pripne pravi tabeli, tudi unikaten', () => {
    const shema = parseCanonicalDdl(KANON)
    expect(
      shema
        .get('KioskSession')
        ?.indeksi.map((i) => `${i.unikaten ? 'UNIQUE ' : ''}${i.ime} ON ${i.tabela}(${i.stolpci.join(',')})`),
    ).toEqual(['UNIQUE KioskSession_code_key ON KioskSession(code)', 'KioskSession_status_idx ON KioskSession(status)'])
    expect(shema.get('LoyaltyEntry')?.indeksi.map((i) => i.ime)).toEqual(['LoyaltyEntry_guestId_idx'])
  })

  /**
   * Meritev 27. 10. 2026, ki je tega testa sploh bila vzrok: `Bun.spawnSync` na
   * tej napavi enkrat ni vrnil DDL-ja, ampak obvestilo druge različice orodja — in
   * to Z izhodno kodo 0, zato ga `canonicalDdlFromSchema` ne more odbiti. Tak
   * izpis se razčleni na nič tabel, `buildPlan` nad prazno shemo pa ne najde ne
   * razlike ne odvečnega stolpca: ukaz bi izpisal „Načrt — dodatki: 0 · zavrnitve:
   * 0 · odvečni stolpci: 0" in vrnil kodo 0, kar je najpomirjujoč napačen odgovor,
   * kar ga lahko da — „baza je usklajena", čeprav vira definicij sploh ni bilo.
   */
  it('A6 DDL brez tabel ni vir: planMigration zavrni in ne trdi, da je baza usklajena', () => {
    const brezVira = (schemaText: string) => () => planMigration({ schemaText, dbPath: join(tempDir(), 'kdaj-ni-bilo-poklicano.db') })
    for (const tekst of ['', '-- RedefineTables\n', 'Error: Command "migrate diff" has been replaced.\n', 'Reading schema... done\n']) {
      expect(brezVira(tekst)).toThrow(/ni bilo razčlenjene nobene tabele/)
      expect(brezVira(tekst)).toThrow(/NE trdi, da je baza usklajena/)
    }
    // Nasprotna stran: ena tabela JE vir, in takrat planMigration ne meče.
    expect(() => planMigration({ schemaText: KANON, dbPath: join(tempDir(), 'prazen-profil.db') })).not.toThrow()
  })
})

describe('B — primerjava tipa je po SQLite afiniteti, ne po črki', () => {
  it('B1 DECIMAL(65,30) in DECIMAL sta ISTA afiniteta (nabrana baza sme ostati)', () => {
    expect(columnAffinity('DECIMAL(65,30)')).toBe('NUMERIC')
    expect(columnAffinity('DECIMAL')).toBe('NUMERIC')
    expect(columnAffinity('DECIMAL(65,30)')).toBe(columnAffinity('DECIMAL'))
  })

  it('B2 TIMESTAMP(3) in DATETIME sta iste afinitete', () => {
    expect(columnAffinity('TIMESTAMP(3)')).toBe(columnAffinity('DATETIME'))
  })

  it('B3 TEXT, INTEGER, REAL in BLOB se med seboj ločijo', () => {
    expect(columnAffinity('TEXT')).toBe('TEXT')
    expect(columnAffinity('VARCHAR(255)')).toBe('TEXT')
    expect(columnAffinity('INTEGER')).toBe('INTEGER')
    expect(columnAffinity('BIGINT')).toBe('INTEGER')
    expect(columnAffinity('REAL')).toBe('REAL')
    expect(columnAffinity('DOUBLE PRECISION')).toBe('REAL')
    expect(columnAffinity('BLOB')).toBe('BLOB')
  })
})

describe('C — pogon samo dodaja', () => {
  it('C1 manjkajoč nullable stolpec → čist ALTER TABLE ADD COLUMN, brez zavrnitve', () => {
    const pot = join(tempDir(), 'c1.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.zavrnitve).toEqual([])
    expect(n.stavke.filter((s) => s.vrsta === 'dodaj-stolpec').map((s) => s.sql)).toEqual([
      'ALTER TABLE "KioskSession" ADD COLUMN "note" TEXT',
      'ALTER TABLE "KioskSession" ADD COLUMN "openMinutes" INTEGER NOT NULL DEFAULT 0',
    ])
  })

  it('C2 NOT NULL s privzetkom SE DODA z ADD COLUMN — tisto, kar Prisma preoblikuje', () => {
    const pot = join(tempDir(), 'c2.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    const dodani = n.stavke.filter((s) => s.vrsta === 'dodaj-stolpec').map((s) => s.sql)
    expect(dodani).toContain('ALTER TABLE "KioskSession" ADD COLUMN "openMinutes" INTEGER NOT NULL DEFAULT 0')
    expect(n.zavrnitve.filter((z) => z.stolpec === 'openMinutes')).toEqual([])
  })

  it('C3 cela manjkajoča tabela → USTVARI TABELO + njeni indeksi', () => {
    const pot = join(tempDir(), 'c3.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    const nove = n.stavke.filter((s) => s.vrsta === 'ustvari-tabelo')
    expect(nove.map((s) => s.tabela)).toEqual(['LoyaltyEntry'])
    expect(nove[0].sql).toContain('CREATE TABLE "LoyaltyEntry"')
    expect(n.stavke.filter((s) => s.vrsta === 'ustvari-indeks').map((s) => s.sql)).toContain(
      'CREATE INDEX IF NOT EXISTS "LoyaltyEntry_guestId_idx" ON "LoyaltyEntry"("guestId")',
    )
  })

  it('C4 usklajena baza → prazen načrt (drugi tek istega ukaza ne spremeni ničesar)', () => {
    const pot = join(tempDir(), 'c4.db')
    zgradiBazo(pot, KANON)
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.stavke).toEqual([])
    expect(n.zavrnitve).toEqual([])
    expect(n.jePrazen).toBe(true)
  })

  it('C5 manjkajoči stolpci se dodajo V VRSTNEM REDU sheme, ne po abecedi', () => {
    const pot = join(tempDir(), 'c5.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.stavke.filter((s) => s.tabela === 'KioskSession' && s.vrsta === 'dodaj-stolpec').map((s) => s.stolpec)).toEqual([
      'note',
      'openMinutes',
    ])
  })

  it('C6 manjkajoča indeksa (unikatnega in navadnega) → IF NOT EXISTS, brez preoblikovanja', () => {
    const pot = join(tempDir(), 'c6.db')
    // Bazi izpustimo OBÁ KioskSession indeksa; LoyaltyEntry je itak nova.
    zgradiBazo(pot, STARA_BAZA.replace('CREATE UNIQUE INDEX "KioskSession_code_key" ON "KioskSession"("code");\n', ''))
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.stavke.filter((s) => s.vrsta === 'ustvari-indeks').map((s) => s.sql)).toEqual([
      'CREATE UNIQUE INDEX IF NOT EXISTS "KioskSession_code_key" ON "KioskSession"("code")',
      'CREATE INDEX IF NOT EXISTS "KioskSession_status_idx" ON "KioskSession"("status")',
      'CREATE INDEX IF NOT EXISTS "LoyaltyEntry_guestId_idx" ON "LoyaltyEntry"("guestId")',
    ])
  })

  it('C6b obstoječega unikatnega indeksa ne ponovi (drug tek je prazen)', () => {
    const pot = join(tempDir(), 'c6b.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.stavke.filter((s) => s.vrsta === 'ustvari-indeks').map((s) => s.sql)).not.toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "KioskSession_code_key" ON "KioskSession"("code")',
    )
  })

  it('C6c stavka za indeks nosi IME indeksa, ker ga suhi tek izpiše', () => {
    const pot = join(tempDir(), 'c6c.db')
    zgradiBazo(pot, STARA_BAZA.replace('CREATE UNIQUE INDEX "KioskSession_code_key" ON "KioskSession"("code");\n', ''))
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.stavke.filter((s) => s.vrsta === 'ustvari-indeks').map((s) => s.indeks)).toEqual([
      'KioskSession_code_key',
      'KioskSession_status_idx',
      'LoyaltyEntry_guestId_idx',
    ])
  })

  it('C7 nobena stavka nikoli ne vsebuje brisanja ali preoblikovanja', () => {
    const pot = join(tempDir(), 'c7.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    const vsota = n.stavke.map((s) => s.sql).join('\n')
    expect(/DROP/i.test(vsota)).toBe(false)
    expect(/RedefineTables/i.test(vsota)).toBe(false)
    expect(/foreign_keys=OFF/i.test(vsota)).toBe(false)
    expect(/RENAME/i.test(vsota)).toBe(false)
    // Dodan stolpec sme biti NOT NULL SAMO skupaj s privzetkom.
    for (const s of n.stavke.filter((x) => x.vrsta === 'dodaj-stolpec')) {
      if (/NOT NULL/.test(s.sql)) expect(s.sql).toContain('DEFAULT')
    }
  })
})

describe('D — kar zahteva preoblikovanje, je zavrnjeno in razloženo', () => {
  it('D1 drugačna afiniteta obstoječega stolpca → zavrnjeno, in zanj ne nastane nobena stavka', () => {
    const pot = join(tempDir(), 'd1.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON.replace('"code" TEXT NOT NULL', '"code" INTEGER NOT NULL')), readLiveState(pot))
    expect(n.zavrnitve.map((z) => z.kod)).toContain('spremeni-tip')
    expect(n.stavke.some((s) => s.stolpec === 'code')).toBe(false)
  })

  it('D2 razširitev v NOT NULL (baza dopušča NULL) → zavrnjeno kot zatesnitev', () => {
    const pot = join(tempDir(), 'd2.db')
    zgradiBazo(pot, STARA_BAZA.replace('"code" TEXT NOT NULL', '"code" TEXT'))
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.zavrnitve.find((z) => z.stolpec === 'code')?.kod).toBe('zatesni-null')
  })

  it('D3 NOT NULL brez privzetka → zavrnjeno, ker bi ga SQLite zavrnil', () => {
    const pot = join(tempDir(), 'd3.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON.replace('"note" TEXT', '"note" TEXT NOT NULL')), readLiveState(pot))
    expect(n.zavrnitve.find((z) => z.stolpec === 'note')?.kod).toBe('manjka-privzetek')
    expect(n.stavke.some((s) => s.stolpec === 'note')).toBe(false)
  })

  it('D4 meritev: tak DDL na prazni tabeli SPREJME in pokaže šele ob vnosu — zato ga pogon ne sme nikoli izdati', () => {
    // Izmerjeno 2026-10-27 (treh dejstev, ki jih test pinne):
    //  a) PRAZNA tabela: `ADD COLUMN "sila" TEXT NOT NULL` brez privzetka je
    //     SQLite SPREJEL — torej "DDL bo pač padel" NI varovalka.
    //  b) prvi vnos brez vrednosti pa pade: "NOT NULL constraint failed".
    //  c) NEPRAZNA tabela: SQLite že sam DDL zavrne.
    const pot = join(tempDir(), 'd4.db')
    const db = zgradiBazoOdpri(pot, STARA_BAZA)
    let ddlNaPrazni = 'NI NAPAKE'
    try {
      db.exec('ALTER TABLE "KioskSession" ADD COLUMN "sila" TEXT NOT NULL')
    } catch (err) {
      ddlNaPrazni = (err as Error).message
    }
    expect(ddlNaPrazni).toBe('NI NAPAKE')

    let vnos = ''
    try {
      db.prepare('INSERT INTO "KioskSession" ("id","code") VALUES (?,?)').run('k1', 'A-1')
    } catch (err) {
      vnos = (err as Error).message
    }
    expect(vnos).toContain('NOT NULL constraint failed')

    db.prepare('INSERT INTO "KioskSession" ("id","code","sila") VALUES (?,?,?)').run('k2', 'A-2', 'v')
    let ddlNaPolni = 'NI NAPAKE'
    try {
      db.exec('ALTER TABLE "KioskSession" ADD COLUMN "sila2" TEXT NOT NULL')
    } catch (err) {
      ddlNaPolni = (err as Error).message
    }
    expect(ddlNaPolni).toContain('NOT NULL')
    ustavi(db, pot)

    // Ob obeh izidih je baza pokvarjena, zato nobena stavka pogona ne sme biti
    // NOT NULL brez privzetka.
    const pot2 = join(tempDir(), 'd4b.db')
    zgradiBazo(pot2, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON.replace('"note" TEXT', '"note" TEXT NOT NULL')), readLiveState(pot2))
    expect(n.stavke.filter((s) => s.vrsta === 'dodaj-stolpec').every((s) => !/NOT NULL/.test(s.sql) || /DEFAULT/.test(s.sql))).toBe(true)
  })

  it('D5 odvečni stolpec v bazi SE NE IZBIŠE, ampak je javljen', () => {
    const pot = join(tempDir(), 'd5.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.odvecni).toEqual([{ tabela: 'KioskSession', stolpec: 'oldFlag' }])
    expect(n.stavke.some((s) => /DROP/i.test(s.sql))).toBe(false)
  })

  it('D6 drugačen privzetek na obstoječem stolpcu → zavrnjeno, ker preoblikovanja ne storimo', () => {
    const pot = join(tempDir(), 'd6.db')
    zgradiBazo(pot, STARA_BAZA.replace("DEFAULT 'active'", "DEFAULT 'open'"))
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.zavrnitve.find((z) => z.stolpec === 'status')?.kod).toBe('spremeni-privzetek')
  })

  it('D7 nov tuj ključ na obstoječi tabeli → zavrnjeno, ker zahteva preoblikovanje tabele', () => {
    const pot = join(tempDir(), 'd7.db')
    zgradiBazo(pot, 'CREATE TABLE "KioskSession" (\n    "id" TEXT NOT NULL PRIMARY KEY,\n    "orderId" TEXT NOT NULL\n);\n')
    const n = buildPlan(
      parseCanonicalDdl(
        `CREATE TABLE "KioskSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    CONSTRAINT "KioskSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`,
      ),
      readLiveState(pot),
    )
    expect(n.zavrnitve.map((z) => z.kod)).toContain('nov-tuj-kljuc')
  })

  it('D8 zavrnitev je razčlenjen rezultat s slovensko razlago, ne izjema', () => {
    const pot = join(tempDir(), 'd8.db')
    zgradiBazo(pot, STARA_BAZA.replace('"code" TEXT NOT NULL', '"code" INTEGER NOT NULL'))
    const n = buildPlan(parseCanonicalDdl(KANON), readLiveState(pot))
    expect(n.lahkoUporabi).toBe(false)
    const z = n.zavrnitve.find((x) => x.stolpec === 'code')
    expect(z?.tabela).toBe('KioskSession')
    expect(z?.razlog).toContain('KioskSession')
    expect(z?.razlog).toContain('code')
    expect(z?.razlog.length).toBeGreaterThan(20)
  })
})

describe('E — zapis: kopija najprej, vse ali nič, vedno enaka števila vrstic', () => {
  it('E1 pred prvim zapisom nastane PREVERJENA kopija pred-migracijo-', () => {
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    const db = zgradiBazoOdpri(pot, STARA_BAZA)
    db.prepare('INSERT INTO "KioskSession" ("id","code","amount") VALUES (?,?,?)').run('k1', 'A-1', 12.5)
    ustavi(db, pot)
    const backups = backupsDirFor(pot)
    const r = applyMigration({ dbPath: pot, plan: planMigration({ schemaText: KANON, dbPath: pot }), backupsDir: backups, now: new Date('2026-10-27T09:00:00Z') })
    const kopije = listBackups(backups, LOCAL_PRE_MIGRATE_PREFIX)
    expect(kopije.length).toBe(1)
    expect(r.kopija).toContain(LOCAL_PRE_MIGRATE_PREFIX)
    expect(verifyBackup(join(backups, kopije[0])).integrity).toBe('ok')
    // Kopija sme vsebovati STARO stanje: nima novega stolpca, ima pa odvečnega.
    const k = odpri(join(backups, kopije[0]))
    try {
      const imena = k.prepare('PRAGMA table_info("KioskSession")').all().map((c) => String(c.name))
      expect(imena).not.toContain('note')
      expect(imena).toContain('oldFlag')
    } finally {
      zapri(k)
    }
  })

  it('E2 varni dodatki pridejo v bazo, zavrnjen stolpec pa ostane javljen', () => {
    // Meritev 2026-10-27 na `prisma/db/ci1.182.0.db`: `migrate diff` zahteva
    // 2796 B preoblikovanja z 2 `DROP TABLE`, naš načrt pa ima ENO samo
    // zavrnitev (`nov-tuj-kljuc PayLink.orderId`) in NIČ za dodati. Če bi
    // zavrnitev blokirala celo transakcijo, bi bil pogon prav na takšni,
    // z `db push` nabrani bazi vedno ničelni ukaz — lastnik pa prav takrat
    // potrebuje nov stolpec. Zavrnitev torej PRENEHA biti blokada in postane
    // obvezno javljeno stanje: varni dodatki se zapišejo, razlika pa ostane
    // zapisana v rezultatu in v izhodni kodi.
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    zgradiBazo(pot, STARA_BAZA)
    const n = planMigration({ schemaText: KANON.replace('"code" TEXT NOT NULL', '"code" INTEGER NOT NULL'), dbPath: pot })
    expect(n.zavrnitve.map((z) => z.kod)).toContain('spremeni-tip')
    expect(n.stavke.length).toBeGreaterThan(0)
    const r = applyMigration({ dbPath: pot, plan: n, backupsDir: backupsDirFor(pot), now: new Date('2026-10-27T09:00:00Z') })
    expect(r.napaka).toBeNull()
    expect(r.opravljene.length).toBe(n.stavke.length)
    expect(r.zavrnitve.map((z) => z.kod)).toContain('spremeni-tip')
    expect(listBackups(backupsDirFor(pot), LOCAL_PRE_MIGRATE_PREFIX).length).toBe(1)
    const po = odpri(pot)
    try {
      const stolpci = po.prepare('PRAGMA table_info("KioskSession")').all()
      const imena = stolpci.map((c) => String(c.name))
      expect(imena).toContain('note')
      expect(imena).toContain('openMinutes')
      expect(imena).toContain('oldFlag')
      // Zavrnjenega stolpca pogon NE dotakne: ostane TEXT, ne INTEGER.
      expect(String(stolpci.find((c) => String(c.name) === 'code')?.type)).toBe('TEXT')
      expect(() => po.prepare('SELECT COUNT(*) AS c FROM "LoyaltyEntry"')).not.toThrow()
    } finally {
      zapri(po)
    }
  })

  it('E8 niča za dodati + zavrnitev → napisano ni nič, kopije ni, razlika je javljena', () => {
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    zgradiBazo(pot, KANON)
    const n = planMigration({ schemaText: KANON.replace('"code" TEXT NOT NULL', '"code" INTEGER NOT NULL'), dbPath: pot })
    expect(n.stavke).toEqual([])
    expect(n.zavrnitve.map((z) => z.kod)).toContain('spremeni-tip')
    const r = applyMigration({ dbPath: pot, plan: n, backupsDir: backupsDirFor(pot), now: new Date('2026-10-27T09:00:00Z') })
    expect(r.opravljene).toEqual([])
    expect(r.kopija).toBeNull()
    expect(r.zavrnitve.length).toBe(1)
    expect(listBackups(backupsDirFor(pot), LOCAL_PRE_MIGRATE_PREFIX)).toEqual([])
  })

  it('E3 vrstice preživijo in dobijo privzeto vrednost', () => {
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    const db = zgradiBazoOdpri(pot, STARA_BAZA)
    const vnos = db.prepare('INSERT INTO "KioskSession" ("id","code","amount") VALUES (?,?,?)')
    vnos.run('k1', 'A-1', 1)
    vnos.run('k2', 'A-2', 2)
    vnos.run('k3', 'A-3', 3)
    ustavi(db, pot)
    const r = applyMigration({ dbPath: pot, plan: planMigration({ schemaText: KANON, dbPath: pot }), backupsDir: backupsDirFor(pot), now: new Date('2026-10-27T09:00:00Z') })
    expect(r.vrsticePred).toEqual(r.vrsticePo)
    expect(r.vrsticePred['KioskSession']).toBe(3)
    expect(Object.keys(r.vrsticePo).sort()).toEqual(['KioskSession', 'LoyaltyEntry'])
    const po = odpri(pot)
    try {
      expect(po.prepare('SELECT "note", "openMinutes", "status" FROM "KioskSession" WHERE "id" = ?').get('k2')).toEqual({
        note: null,
        openMinutes: 0,
        status: 'active',
      })
      expect(po.prepare('SELECT COUNT(*) AS c FROM "LoyaltyEntry"').get()).toEqual({ c: 0 })
    } finally {
      zapri(po)
    }
  })

  it('E4 stavka sredi batcha odpove → ROLLBACK, noben nov stolpec ne obstaja', () => {
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    const db = zgradiBazoOdpri(pot, STARA_BAZA)
    db.prepare('INSERT INTO "KioskSession" ("id","code") VALUES (?,?)').run('k1', 'A-1')
    ustavi(db, pot)
    const nacrt = planMigration({ schemaText: KANON, dbPath: pot })
    // Sabotaža: za pravo stavkom doda stolpec, ki ŽE obstaja.
    const pokvarjen = {
      ...nacrt,
      stavke: [
        ...nacrt.stavke.filter((s) => s.vrsta === 'dodaj-stolpec').slice(0, 1),
        { vrsta: 'dodaj-stolpec', tabela: 'KioskSession', stolpec: 'code', sql: 'ALTER TABLE "KioskSession" ADD COLUMN "code" TEXT' },
        ...nacrt.stavke.filter((s) => s.vrsta !== 'dodaj-stolpec'),
      ],
    }
    const r = applyMigration({ dbPath: pot, plan: pokvarjen, backupsDir: backupsDirFor(pot), now: new Date('2026-10-27T09:00:00Z') })
    expect(r.opravljene).toEqual([])
    expect(String(r.napaka)).toContain('code')
    const po = odpri(pot)
    try {
      const imena = po.prepare('PRAGMA table_info("KioskSession")').all().map((c) => String(c.name))
      expect(imena).not.toContain('note')
      expect(imena).not.toContain('openMinutes')
      expect(po.prepare('SELECT COUNT(*) AS c FROM "KioskSession"').get()).toEqual({ c: 1 })
      expect(po.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      expect(po.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='LoyaltyEntry'").get()).toBeUndefined()
    } finally {
      zapri(po)
    }
  })

  it('E5 po uspešni migraciji je načrt PRAZEN (idempotentnost) in baza zdrava', () => {
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    const db = zgradiBazoOdpri(pot, STARA_BAZA)
    db.prepare('INSERT INTO "KioskSession" ("id","code") VALUES (?,?)').run('k1', 'A-1')
    ustavi(db, pot)
    const backups = backupsDirFor(pot)
    applyMigration({ dbPath: pot, plan: planMigration({ schemaText: KANON, dbPath: pot }), backupsDir: backups, now: new Date('2026-10-27T09:00:00Z') })
    const drugi = planMigration({ schemaText: KANON, dbPath: pot })
    expect(drugi.stavke).toEqual([])
    expect(drugi.jePrazen).toBe(true)
    const r2 = applyMigration({ dbPath: pot, plan: drugi, backupsDir: backups, now: new Date('2026-10-27T09:05:00Z') })
    expect(r2.opravljene).toEqual([])
    // Nič za storiti = nobene nove kopije.
    expect(listBackups(backups, LOCAL_PRE_MIGRATE_PREFIX).length).toBe(1)
    const po = odpri(pot)
    try {
      expect(po.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(String((po.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toLowerCase()).toBe('wal')
      expect(po.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      zapri(po)
    }
  })

  it('E6 rep z neprečiščenimi zapisi pomeni, da aplikacija teče → migracija se NE začne', () => {
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    const db = zgradiBazoOdpri(pot, STARA_BAZA)
    db.exec('PRAGMA wal_autocheckpoint=0')
    db.prepare('INSERT INTO "KioskSession" ("id","code") VALUES (?,?)').run('k1', 'A-1')
    // Povezave ne zapremo: rep z vsebino je ravno dokaz, da je baza v rabi.
    const n = planMigration({ schemaText: KANON, dbPath: pot })
    let sporocilo = ''
    try {
      applyMigration({ dbPath: pot, plan: n, backupsDir: backupsDirFor(pot), now: new Date('2026-10-27T09:00:00Z') })
    } catch (err) {
      sporocilo = (err as Error).message
    }
    zapri(db)
    expect(sporocilo).toContain('teče')
    // Meritev 2026-10-27: pogon je bil na resnični kopiji baze zavrnjen zaradi
    // repa, aplikacija pa ni tekla — brez opozorila o začni-ustavi bi lastnik
    // ostal brez izhoda (ročno brisanje `-wal` je tisto, česar ne sme storiti).
    expect(sporocilo).toContain('bun run local')
    expect(listBackups(backupsDirFor(pot), LOCAL_PRE_MIGRATE_PREFIX)).toEqual([])
  })

  it('E7 baze ni → jasna napaka, kopije pa nič', () => {
    const dir = tempDir()
    const pot = join(dir, 'ni-baze.db')
    const n = planMigration({ schemaText: KANON, dbPath: pot })
    expect(() => applyMigration({ dbPath: pot, plan: n, backupsDir: backupsDirFor(pot), now: new Date('2026-10-27T09:00:00Z') })).toThrow(/baze/i)
    expect(existsSync(pot)).toBe(false)
    expect(listBackups(backupsDirFor(pot), LOCAL_PRE_MIGRATE_PREFIX)).toEqual([])
  })

  it('E9 kopije se zadržujejo enako kot pred-push: najstarejše odpadejo', () => {
    const dir = tempDir()
    const backups = join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    for (let i = 0; i < LOCAL_MAX_PRE_MIGRATE_SNAPSHOTS + 2; i++) {
      writeFileSync(join(backups, `${LOCAL_PRE_MIGRATE_PREFIX}2026-10-2${i}T00-00-00-000Z.db`), 'x')
    }
    const pot = join(dir, 'baza.db')
    zgradiBazo(pot, STARA_BAZA)
    applyMigration({ dbPath: pot, plan: planMigration({ schemaText: KANON, dbPath: pot }), backupsDir: backups, now: new Date('2026-10-27T09:00:00Z') })
    const ostale = listBackups(backups, LOCAL_PRE_MIGRATE_PREFIX)
    expect(ostale.length).toBe(LOCAL_MAX_PRE_MIGRATE_SNAPSHOTS)
    expect(ostale).toContain(`${LOCAL_PRE_MIGRATE_PREFIX}${ZIG('2026-10-27T09:00:00Z')}.db`)
    expect(ostale).not.toContain(`${LOCAL_PRE_MIGRATE_PREFIX}2026-10-20T00-00-00-000Z.db`)
  })

  /**
   * Obljuba „kopija PRED prvim zapisom" je brez te veze brez vsebine: če kopije
   * ni, se ne sme napisati NIČ. Realni vhod je `restaurantos.db`, ki je prišel z
   * USB-ja ali iz prekinjene obnove — datoteka obstaja, a ni SQLite baza
   * (izmerjeno 2026-10-27: `VACUUM INTO` na takšnem viru javi „file is not a
   * database", odpiranje datoteke pa NE faila, torej to zazna ravno kopija).
   */
  it('E10 kopije ni bilo mogoče narediti → migracija se NE začne, baza ostane isti bajti', () => {
    const dir = tempDir()
    const zdrava = join(dir, 'zdrava.db')
    zgradiBazo(zdrava, STARA_BAZA)
    const n = planMigration({ schemaText: KANON, dbPath: zdrava })
    expect(n.stavke.length).toBeGreaterThan(0)
    const pot = join(dir, 'iz-usb.db')
    const smeti = Buffer.from('to ni SQLite baza'.repeat(500))
    writeFileSync(pot, smeti)
    const backups = backupsDirFor(pot)
    let sporocilo = ''
    try {
      applyMigration({ dbPath: pot, plan: n, backupsDir: backups, now: new Date('2026-10-27T09:00:00Z') })
    } catch (err) {
      sporocilo = (err as Error).message
    }
    expect(sporocilo).toMatch(/varnostne kopije/i)
    expect(sporocilo).toContain('Baza NI bila spremenjena')
    // Parcialnega odseka ne sme ostati: ne kopije, ne njenih repov.
    const imeKopije = `${LOCAL_PRE_MIGRATE_PREFIX}${ZIG('2026-10-27T09:00:00Z')}.db`
    expect(existsSync(join(backups, imeKopije))).toBe(false)
    expect(listBackups(backups, LOCAL_PRE_MIGRATE_PREFIX)).toEqual([])
    expect(readFileSync(pot).equals(smeti)).toBe(true)
  })

  /**
   * Veljavna kopija NI dokaz, da je živa datoteka zdrava, in ravno zato guard
   * tik pred COMMIT-jem obstaja. Meritev 2026-10-27, korak za korakom: če
   * kazalec na prvo stran seznama prostih strani (offset 32 glave) kaže izven
   * datoteke, `BEGIN` in `ALTER TABLE … ADD COLUMN` USPEJATA,
   * `PRAGMA foreign_key_check` vrne 0 zadetkov, `PRAGMA integrity_check` pa
   * VRNE vrstico „Freelist: invalid page number 48" — in `VACUUM INTO` iz takega
   * vira naredi KOPİJO, ki je `integrity_check` preveri (proste strani vrže
   * stran). Edino, kar tak batch ustavi, je pregled žive datoteke; brez njega
   * bi COMMIT in obrat bi shemo vodil po poškodovani datoteki.
   */
  it('E12 živa datoteka je strukturno pokvarjena → kljub veljavni kopiji NE COMMIT-a', () => {
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    const db = zgradiBazoOdpri(pot, STARA_BAZA)
    const vnos = db.prepare('INSERT INTO "KioskSession" ("id","code") VALUES (?,?)')
    for (let i = 0; i < 600; i++) vnos.run(`k${i}`, `A-${i}`)
    db.exec("DELETE FROM \"KioskSession\" WHERE substr(id, -1) = '3'") // proste strani
    ustavi(db, pot)

    const glava = readFileSync(pot)
    const strani = Math.ceil(glava.length / glava.readUInt16BE(16))
    glava.writeUInt32BE(strani + 40, 32) // kazalec na stran, ki je ni
    writeFileSync(pot, glava)

    // PREDPogoj, ne domneva: če poškodba ne bi bila vidna, test ne bi dokazal niča.
    const pred = odpri(pot)
    let pregledVira = ''
    try {
      pregledVira = String((pred.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toLowerCase()
    } finally {
      zapri(pred)
    }
    expect(pregledVira).toContain('freelist')
    expect(pregledVira).not.toBe('ok')

    const n = planMigration({ schemaText: KANON, dbPath: pot })
    expect(n.zavrnitve).toEqual([])
    expect(n.stavke.length).toBeGreaterThan(0)
    const r = applyMigration({ dbPath: pot, plan: n, backupsDir: backupsDirFor(pot), now: new Date('2026-10-27T09:00:00Z') })
    expect(String(r.napaka)).toContain('integritetni pregled')
    expect(String(r.napaka)).toContain('freelist')
    expect(r.opravljene).toEqual([])
    // Kopija je bila narejena IN je veljavna — prav zato zapis ni dovolj:
    // varnost je v pregledu ŽIVE datoteke tik pred COMMIT-jem.
    const kopija = String(r.kopija)
    expect(kopija).toContain(LOCAL_PRE_MIGRATE_PREFIX)
    expect(verifyBackup(kopija).integrity).toBe('ok')
    const po = odpri(pot)
    try {
      const imena = po.prepare('PRAGMA table_info("KioskSession")').all().map((c) => String(c.name))
      expect(imena).not.toContain('note')
      expect(po.prepare('SELECT COUNT(*) AS c FROM "KioskSession"').get()).toEqual({ c: 540 })
    } finally {
      zapri(po)
    }
  })

  /**
   * Guard pred COMMIT-jem, ki ga doseže samo E11: SQLite SPREJME `ADD COLUMN`,
   * torej nobena stavka ne faila — ustavi lahko samo pregled tujih ključev nad
   * podatki. Realni primer je osiroteli otrokov zapis, ki ga je pustil `db push`
   * ali ročni poseg; brez guarda bi tak batch COMMIT-nil in obrat bi naslednji
   * zagon SQL-a sesul šele ob branju.
   */
  it('E11 tuj ključ je v nasprotju s podatki → ROLLBACK, napaka ga imenuje', () => {
    const dir = tempDir()
    const pot = join(dir, 'baza.db')
    const db = zgradiBazoOdpri(pot, BAZA_FK)
    // Izmerjeno 2026-10-27: `DatabaseSync` tujih ključev po privzetem NE vsiljuje,
    // a E11 jih vseeno izklopi eksplicitno — ravno tako nastane osiroteli zapis v
    // resnici (`db push`, obnovljena kopija, ročni poseg), ne zato, da bi test
    // lažje napisal.
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare('INSERT INTO "PayLink" ("id","orderId") VALUES (?,?)').run('p1', 'osirela')
    ustavi(db, pot)
    const n = planMigration({ schemaText: KANON_FK, dbPath: pot })
    // Načrt mora biti ČIST: sicer test ne ve, ali je zapis ustavil guard ali zavrnitev.
    expect(n.zavrnitve).toEqual([])
    expect(n.stavke.map((s) => `${s.tabela}.${s.stolpec}`)).toEqual(['PayLink.note'])
    const r = applyMigration({ dbPath: pot, plan: n, backupsDir: backupsDirFor(pot), now: new Date('2026-10-27T09:00:00Z') })
    expect(String(r.napaka)).toContain('foreign_key_check')
    expect(r.opravljene).toEqual([])
    // Kopija JE nastala — pred prvim zapisom; rollback pomeni, da je bila baza
    // obnova, ne žrtev: novi stolpec ne sme obstajati, vrstice pa morajo ostati.
    expect(String(r.kopija)).toContain(LOCAL_PRE_MIGRATE_PREFIX)
    const po = odpri(pot)
    try {
      const imena = po.prepare('PRAGMA table_info("PayLink")').all().map((c) => String(c.name))
      expect(imena).not.toContain('note')
      expect(po.prepare('SELECT COUNT(*) AS c FROM "PayLink"').get()).toEqual({ c: 1 })
      expect(po.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      zapri(po)
    }
  })
})

describe('F — prava zrcalna shema (135 tabel), ne le vzorec', () => {
  // F1 in F2 vzbudita resnično orodje `prisma migrate diff`; izmerjeno
  // 2026-10-27 na tej napravi: 4419 oziroma 5648 ms, kar je VEČ kot privzetih
  // 5000 ms. Brez svojega budgeta torej test na počasnejši napravi zrdeči iz
  // povsem napačnega razloga — isto napako je v1.181.0 že zapisala pri 20 s.
  const PRISMA_BUDGET = 30000

  it('F1 kanonični DDL prave sheme je razčlenljiv in ima vseh 135 modelov', () => {
    const sql = canonicalDdlFromSchema('prisma/schema.sqlite.prisma')
    const shema = parseCanonicalDdl(sql)
    expect(shema.size).toBe(135)
    expect(shema.get('Location')?.stolpci.map((s) => s.ime)).toContain('taxId')
    expect(shema.get('PayLink')?.tujihKljucov).toEqual([{ stolpci: ['orderId'], naTabelo: 'Order', onDelete: 'CASCADE', onUpdate: 'CASCADE' }])
    expect((sql.match(/DECIMAL\(65,30\)/g) || []).length).toBe(0)
  }, PRISMA_BUDGET)

  it('F2 baza, narejena IZ kanoničnega DDL-ja, je brez razlike do sheme', () => {
    const sql = canonicalDdlFromSchema('prisma/schema.sqlite.prisma')
    const pot = join(tempDir(), 'prava.db')
    const db = new DatabaseSync(pot)
    handles.add(db)
    try {
      db.exec('PRAGMA foreign_keys=OFF')
      db.exec(sql)
      const n = planMigration({ schemaText: sql, dbPath: pot })
      expect(n.stavke).toEqual([])
      expect(n.zavrnitve).toEqual([])
      expect(n.odvecni).toEqual([])
    } finally {
      zapri(db)
    }
  }, PRISMA_BUDGET)

  it('F3 POSTGRES okras nabranih baz (DECIMAL(65,30), TIMESTAMP(3), _pkey) NE sme biti zavrnitev', () => {
    // Izmerjeno 2026-10-27 v prisma/db/ci1.182.0.db: ta dva stolpca sta nastala
    // iz Postgres DDL-ja in Prisma v diffu ju vidi kot razliko.
    const shema = parseCanonicalDdl(
      `CREATE TABLE "X" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amount" DECIMAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`,
    )
    const pot = join(tempDir(), 'legacy.db')
    zgradiBazo(
      pot,
      `CREATE TABLE "X" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "X_pkey" PRIMARY KEY ("id")
);
`,
    )
    const n = buildPlan(shema, readLiveState(pot))
    expect(n.zavrnitve).toEqual([])
    expect(n.stavke).toEqual([])
    expect(n.jePrazen).toBe(true)
  })
})

describe('G — ukaz in dokumenta', () => {
  /** Živi CLI, enako kot v182 §F: pravi tekač, prava izhodna koda, pravi stdout. */
  function pozeniCLI(args: string[]) {
    const r = spawnSync(process.execPath, ['scripts/local-migrate.ts', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
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

  it('G1 package.json ima local:migrate in ne nosi --accept-data-loss', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['local:migrate']).toBe('bun scripts/local-migrate.ts')
    expect(pkg.scripts['local:migrate']).not.toContain('accept-data-loss')
  })

  it('G2 runbook §7 ne čaka več na pogon, ampak ga ukazuje', () => {
    const runbook = readFileSync('docs/LOKALNI-ZAGON.md', 'utf8')
    expect(runbook).not.toContain('počakajte na lokalni migracijski pogon')
    expect(runbook).toContain('bun run local:migrate')
    // Prepoved razvojnega ukaza mora OSTATI, sicer branec najde samo novo luknjo.
    expect(runbook).toContain('--accept-data-loss')
  })

  it('G3 PRD cesta ima vrsto za lokalni migracijski pogon z različico izdaje', () => {
    const prd = readFileSync('docs/PRD-LOKALNA-BAZA.md', 'utf8')
    expect(prd).toContain('lokalni migracijski pogon')
    expect(prd).toMatch(/v1\.183\.0/)
  })

  it('G4 CLI ima suhi tek kot privzetega in neznano zastavico vrne z izhodno kodo 2', () => {
    const izvor = readFileSync('scripts/local-migrate.ts', 'utf8')
    expect(izvor).toContain('--dry-run')
    expect(izvor).toContain('--apply')
    expect(izvor).toContain('process.exit(2)')
  })

  /**
   * Opozorilo je edini tekst, ki ga lastnik prebere, kadar pogon kaj zavrne, in
   * od E2 semantike naprej NE sme več trditi, da baza ni bila spremenjena:
   * aditivne stavke pridejo vanjo, zavrnjene pa ostanejo javljene.
   */
  it('G5 opozorilo našteje zavrnitve, a ne trdi, da baza ni bila spremenjena', () => {
    const nacrt: Nacrt = {
      stavke: [{ vrsta: 'dodaj-stolpec', tabela: 'Guest', stolpec: 'note', sql: 'ALTER TABLE "Guest" ADD COLUMN "note" TEXT' }],
      zavrnitve: [
        {
          tabela: 'PayLink',
          stolpec: 'orderId',
          kod: 'nov-tuj-kljuc',
          razlog: 'Tujega ključa SQLite na živo tabelo ne more dodati brez preoblikovanja.',
        },
      ],
      odvecni: [],
      jePrazen: false,
      lahkoUporabi: false,
    }
    const izpis = migracijskoOpozorilo(nacrt)
    expect(izpis).toContain('PayLink.orderId')
    expect(izpis).not.toMatch(/Baza NI bila spremenjena/)
    // Slovene: locativ je "v razvojni veji", ne "v razvoj veji".
    expect(izpis).toContain('razvojni veji')
    expect(izpis).not.toContain('razvoj veji')
    expect(migracijskoOpozorilo({ ...nacrt, zavrnitve: [], lahkoUporabi: true })).toBe('')
  })

  /**
   * Brez te vrstice bi bil izpis po `--apply` število zavrnitev, lastnik pa ne bi
   * vedel, KATERA razlika ostane — ukinjen blokadi je edini dokaz, da jo vidi.
   * Druga trditev je proti podvojitvi: isti razlog je bilo napisati dvakrat, ker
   * ga izpiše tudi veja, ki samo pokaže načrt (izmerjeno 2026-10-27: `--apply` je
   * izpisal blok dvakrat zapored).
   */
  it('G6 CLI izpiše razčlenjeno opozorilo tudi po --apply, a samo enkrat', () => {
    const izvor = readFileSync('scripts/local-migrate.ts', 'utf8')
    const applyVev = izvor.slice(izvor.indexOf('const result = applyMigration'))
    expect(applyVev).toContain('migracijskoOpozorilo')
    const nacrtVev = izvor.slice(izvor.indexOf('const opozorilo = migracijskoOpozorilo'), izvor.indexOf('const result = applyMigration'))
    expect(nacrtVev).toMatch(/!args\.apply\s*&&\s*opozorilo/)
  })

  /**
   * Meritev 27. 10. 2026, ki je tega testa sploh bila vzrok: `bun scripts/local-migrate.ts
   * --schema prisma/schema.sqlite.prisma --data-dir .` je izpisal
   * „Načrt — dodatki: 706" in izhodno kodo 0, ker `planMigration` nad manjkajočo
   * datoteko ne more vedeti, da je pot narobe — prazno stanje je zanj enak
   * prazni bazi, shema pa zahteva celoten DDL. `--apply` bi nato zavrnil v drugi
   * vrstici, izpisa načrta pa bi branec že imel za res. Zato ukaz preveri, da
   * baza je, PRINDEJ in pred katerimkoli načrtovanjem.
   *
   * Test je živi CLI, ne branje izvora: izvor bi pokazal zastavico, izpis pa ne
   * bi pokazal, da je refleksija napačna in da kodo 0 kljub temu vrne.
   */
  it('G7 CLI na manjkajoči bazi javi zavrnitev in NE načrtuje v prazno', () => {
    const ni = join(tempDir(), 'ni-te-baze.db')
    expect(existsSync(ni)).toBe(false)

    const tekst = pozeniCLI(['--db', ni])
    expect(tekst.code).toBe(1)
    expect(tekst.skupaj).toContain('ni, zato načrtovanja ni bilo mogoče začeti')
    expect(tekst.skupaj).toContain('bun run local')
    // Bistvo: nobenega načrta, nobene številke, ki bi jo lahko kdo vzal resno.
    expect(tekst.skupaj).not.toContain('Načrt')
    expect(tekst.skupaj).not.toContain('dodatki')

    const json = pozeniCLI(['--db', ni, '--json'])
    expect(json.code).toBe(1)
    const od = zadnjiJson(json.stdout)
    expect(od).not.toBeNull()
    expect(od!.ok).toBe(false)
    expect(String(od!.error)).toContain(ni.slice(0, 12))
    expect(od!.stavke).toBeUndefined()

    // Isti pogoj mora veljati za profilsko pot: --data-dir na mapo brez baze.
    const profil = pozeniCLI(['--data-dir', join(tempDir(), 'prazen-profil')])
    expect(profil.code).toBe(1)
    expect(profil.skupaj).toContain('ni, zato načrtovanja ni bilo mogoče začeti')
    expect(existsSync(ni)).toBe(false)
  })

  /**
   * Zavrnitev iz G7 sme biti samo takrat, kadar `--db` zares dela. Mini zrcalna
   * shema pokaže obe strani: `--db` premaga privzeto pot profila IN načrt nosi
   * dejansko razliko, ne 706. Izmerjeno 27. 10. 2026: 4850 ms (večinoma `prisma
   * migrate diff`), zato lastni budget.
   */
  it('G8 --db zares načrtuje po imenovani datoteki, ne po profilu', () => {
    const dir = tempDir()
    const baza = join(dir, 'mini.db')
    const db = new DatabaseSync(baza)
    handles.add(db)
    db.exec('CREATE TABLE "Store" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL)')
    db.exec(`INSERT INTO "Store" (id, name) VALUES ('a', 'A')`)
    zapri(db)

    const shema = join(dir, 'mini.prisma')
    writeFileSync(
      shema,
      `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n\nmodel Store {\n  id   String  @id\n  name String\n  note String?\n}\n`,
    )

    const r = pozeniCLI(['--db', baza, '--schema', shema, '--json'])
    expect(r.code).toBe(0)
    const od = zadnjiJson(r.stdout)
    expect(od).not.toBeNull()
    expect(od!.dbPath).toBe(baza)
    const stavke = od!.stavke as { tabela: string; stolpec: string; sql: string }[]
    expect(stavke).toEqual([{ vrsta: 'dodaj-stolpec', tabela: 'Store', stolpec: 'note', sql: 'ALTER TABLE "Store" ADD COLUMN "note" TEXT' }])
    expect((od!.zavrnitve as unknown[]).length).toBe(0)
  }, 30000)
})
