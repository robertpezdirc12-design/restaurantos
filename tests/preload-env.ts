/**
 * Testni PRELOAD (bunfig.toml → [test] preload) — določi DATABASE_URL za `bun test`.
 *
 * PROBLEM (dokazano v peskovniku 2026-10-29, izdaja v1.188.x): peskovnik/CI-host
 * izvaža GLOBALNI `DATABASE_URL=file:/home/z/my-project/db/custom.db` (baza
 * scaffoldskega projekta, BREZ sheme RestaurantOS). Pravilna vrednost iz
 * `.env` NE ZMAGA — procesno okolje vedno preglasi `.env` (bun tukaj sledi
 * standardnemu vedenju: obstoječe env spremenljivke imajo prednost).
 * Rezultat: pred testi ustvarjena PrismaClient instanca gleda v tujo bazo →
 * beforeAll pada z "table does not exist" ali tiho ustvari prazno datoteko →
 * skupine testov lažno rdeče (izmerjeno: tests/issue19-exception-governance
 * 0 pass / 1 fail BREZ izrecnega izvoza; s pravilnim URL-jem 35/35).
 *
 * PRAVILO (konservativno, deterministično — CI/Windows obnašanje NESPREMENJENO):
 *  1. DATABASE_URL manjka               → pripni na <repo>/db/dev.db (absolutno).
 *  2. `file:` URL, ki kaže IZVEN repozitorija → pripni na <repo>/db/dev.db.
 *  3. `file:` URL ZNOTRAJ repozitorija (CI: `file:./db/ci-fresh.db`, GitLab:
 *     `file:./db/ci-gitlab.db`, .env: `file:./db/dev.db`, demodbski preklopi)
 *     → OSTANE TOČNO TAKO, KOT JE. Relativne poti Prisma (CLI IN klient,
 *     izmerjeno 6.11) razreši glede na imenik SHAME (prisma/) — par CLI↔klient
 *     je notranje skladen, zato vsaka naša pretvorba usmeri CI/lastnika na
 *     napačno datoteko (poskušano in povrnjeno v isti seji).
 *  4. Oddaljen URL (postgresql:// …) → OSTANE (izrecna namera operatorja;
 *     fixture-sweep assertDevDatabase vseeno zavrne take teke).
 *
 * Če pripeta baza NE OBSTAJA, napišemo glasno OPOZORILO s točnim ukazom
 * (`bun run db:push`) in NADALJUJEMO — prisma sicer ustvari prazno datoteko,
 * testi padejo z razumljivejšimi napakami; trdo metanje bi tveganilo CI
 * variante, ki bazo pripravijo na drugačen način.
 *
 * ČIST: brez odvisnosti od src/** (preload teče PREJ kot katerikoli testni
 * uvoz), brez stranskih učinkov razen pisanja process.env.DATABASE_URL in
 * ene stderr vrstice ob manjkajoči datoteki.
 */
import { resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Čista jedro pravila (izvoženo za guard test tests/harness-env-pin.test.ts).
 * @param current trenutna vrednost process.env.DATABASE_URL (lahko undefined)
 * @param repoRoot absolutna pot repozitorija (za test vbrizgana)
 * @param cwd trenutni imenik (za razrešitev relativnih `file:` URL-jev)
 * @returns { url, pinned } — pinned=true pomeni, da je pravilo prijelo in je
 *   vrednost zamenjana s pripeto repo bazo
 */
export function resolveTestDatabaseUrl(
  current: string | undefined,
  repoRoot: string,
  cwd: string,
): { url: string; pinned: boolean } {
  const repoDb = `file:${resolve(repoRoot, 'db', 'dev.db')}`
  const url = (current ?? '').trim()

  // Pravilo 1: manjka → pripni.
  if (!url) return { url: repoDb, pinned: true }

  // Pravilo 4: oddaljen URL (postgres/mysql/…) → ostane.
  if (!url.startsWith('file:')) return { url, pinned: false }

  // `file:` URL — loči pot od morebitnih query parametrov
  // (prisma SQLite URL: file:./db/dev.db?connection_limit=1&…).
  const qIdx = url.indexOf('?')
  const rawPath = qIdx >= 0 ? url.slice(5, qIdx) : url.slice(5)
  const query = qIdx >= 0 ? url.slice(qIdx) : ''

  // Relativno → razreši glede na CWD; absolutno (vključno z Windows `C:\…`)
  // → path.resolve ve, kdaj je že absolutno.
  const abs = resolve(cwd, rawPath)
  const insideRepo = abs === repoRoot || abs.startsWith(repoRoot + sep)

  // Pravilo 2: izven repozitorija (peskovniški scaffold, drug projekt) → pripni
  // (query parametri ohranjeni).
  if (!insideRepo) return { url: repoDb + query, pinned: true }

  // Pravilo 3: znotraj repozitorija → OSTANE TOČNO TAKO, KOT JE.
  // ZAKAJ NE NORMALIZIRATI relativnega URL-ja na absolutnega (poskušano in
  // POVRNJENO): Prisma (CLI in generirani klient, izmerjeno z prisma 6.11)
  // razreši RELATIVNO SQLite pot glede na IMENIK SHAME (prisma/), ne CWD —
  // `file:./db/ci-fresh.db` pomeni prisma/db/ci-fresh.db. CLI ga tudi TAM
  // ustvari (dokaz: probe `file:./probe-db/ci-probe.db` je pristal v
  // prisma/probe-db/), zato je par CLI↔klient notranje skladen in kakršna koli
  // naša pretvorba bi CI (ci-fresh.db) in lastnikov Windows (.env) usmerila na
  // NAPAČNO datoteko. Pravilo se dotika izključno URL-jev izven repozitorija.
  return { url, pinned: false }
}

// ZAPIS: samo kadar je pravilo prijelo (pripnitev manjkajoče/tuje vrednosti);
// ohranjene vrednosti (repo-notranji in oddaljeni URL-ji) se ne dotikamo.
const resolved = resolveTestDatabaseUrl(process.env.DATABASE_URL, REPO_ROOT, process.cwd())
if (resolved.pinned) {
  process.env.DATABASE_URL = resolved.url
}

// Glasno opozorilo, če izbrana lokalna baza ne obstaja — testi sicer padejo z
// nepreglednim "table does not exist" brez konteksta. Pokrijemo obe svetove:
//  - pripet absoluten URL (<repo>/db/dev.db) → preveri direktno,
//  - ohranjen RELATIVEN URL (.env: file:./db/dev.db) → Prisma ga razreši
//    shemsko-relativno (<repo>/prisma/…), zato preverimo tisto datoteko.
if (resolved.url.startsWith('file:')) {
  const dbPath = resolved.url.slice(5).split('?')[0]
  const { existsSync } = await import('node:fs')
  const candidates = dbPath.startsWith(REPO_ROOT + sep)
    ? [dbPath]
    : dbPath.startsWith('.')
      ? [resolve(REPO_ROOT, 'prisma', dbPath)]
      : []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      console.error(
        `[preload-env] OPOZORILO: baza ne obstaja: ${candidate}\n` +
          `[preload-env] (Prisma relativne file: poti razreši glede na imenik shame prisma/.)\n` +
          `[preload-env] Zaženi: bun run db:push  (nato ponovno bun test)`,
      )
    }
  }
}
