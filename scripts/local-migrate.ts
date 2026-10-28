#!/usr/bin/env bun
/**
 * v1.183.0 — lokalni migracijski pogon (PRD docs/PRD-LOKALNA-BAZA.md F3, A4,
 * R4b; docs/LOKALNI-ZAGON.md §7 je do te izdaje lastniku ukazoval, naj POČAKA
 * na pogon, ki ga ni, in naj NE uporablja `bun run db:push`).
 *
 * Zasnovo in meritve utemeljuje src/lib/local-migrate.ts: pogon SAMO DODAJA
 * (manjkajoči stolpec, manjkajoča tabela, manjkajoč indeks). Kar zahteva
 * preoblikovanje tabele ali brisanje, zavrne z razčlenjeno razlago in tega
 * NE stori — aditivnega dela načrta pa zavrnitev ne blokira, ker bi sicer
 * ukaz na nabrani bazi ostal večno brez učinka (meritev na ci1.182.0.db).
 * Pred prvim zapisom nastane preverjena kopija `pred-migracijo-`.
 *
 * Privzeti tek je SUH: pokaže načrt, baze ne dotakne se — niti kopije ne.
 *
 * Meritev 27. 10. 2026: `planMigration` nad manjkajočo datoteko je veljaven —
 * prazno stanje pomeni, da shema zahteva celoten DDL, zato na suhem teku izpade
 * kot 706 dodatkov. Zato ukaz najprej PREVERI, da baza je, in šele nato načrtuje.
 * Brez te prevere bi napačna pot javila načrt, ki ga ni, `--apply` pa bi ga zavrnil
 * šele v drugi vrstici — branec ne bi vedel, kateri od obeh izpisov drži.
 *
 * Uporaba: bun run local:migrate [--dry-run] [--apply] [--json] [--data-dir pot | --db pot] [--schema pot]
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { backupsDirFor } from '../src/lib/local-durability'
import { LOCAL_PRE_MIGRATE_PREFIX, applyMigration, migracijskoOpozorilo, planMigration } from '../src/lib/local-migrate'
import { databasePathFor, resolveDataDir } from '../src/lib/local-runtime'

const USAGE = `Uporaba: bun run local:migrate [možnosti]

  --dry-run          Prikaže načrt in nič ne naredi (privzeto).
  --apply            Izvede načrt: najprej preverjena kopija ${LOCAL_PRE_MIGRATE_PREFIX}, nato ena transakcija.
  --json             Strojno berljiv izpis (en sam JSON na stdout).
  --data-dir <pot>   Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS).
  --db <pot>         Datoteka baze sama (za vzdrževanje in preizkuse; preseže --data-dir).
  --schema <pot>     Zrcalna shema (privzeto prisma/schema.sqlite.prisma).
  -h, --help         Ta pomoč.

Pogon sme SAMO DODAJATI. Stolpec, ki zahteva NOT NULL brez privzetka, sprememba
tipa, zatesnitev NULL, nov primarni ali tuj ključ so ZAVRNJENI z razlago in jih
pogon ne stori; varni dodatki kljub njim pridejo v bazo, izpis pa našteje, kaj
ostane. Odvečnega stolpca ne izbriše nikoli — samo javi ga.
Ta ukaz je namenjen vsakodnevnemu vzdrževanju. Razvojni ukaz bun run db:push nosi
--accept-data-loss in za živo obrat NI namenjen.`

interface Args {
  apply: boolean
  json: boolean
  dataDir?: string
  db?: string
  schema: string
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { apply: false, json: false, schema: 'prisma/schema.sqlite.prisma', help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.\n\n${USAGE}`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--dry-run') args.apply = false
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--data-dir') args.dataDir = value(i++, a)
    else if (a === '--db') args.db = value(i++, a)
    else if (a === '--schema') args.schema = value(i++, a)
    else throw new Error(`[local] Neznana možnost: ${a}\n\n${USAGE}`)
  }
  return args
}

let args: Args
try {
  args = parse(process.argv.slice(2))
} catch (err) {
  console.error((err as Error).message)
  process.exit(2)
}

if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

const dataDir = args.dataDir ? resolveDataDir({ env: { RESTAURANTOS_DATA_DIR: args.dataDir } }) : resolveDataDir()
const dbPath = args.db ? path.resolve(args.db) : databasePathFor(dataDir)

if (!existsSync(dbPath)) {
  const napaka = `[local] Baze ${dbPath} ni, zato načrtovanja ni bilo mogoče začeti. Pokličite namestitev z ` +
    '`bun run local`, nato ponovite; ta ukaz ne ustvari nove baze in ne načrtuje v prazno.'
  if (args.json) console.log(JSON.stringify({ ok: false, error: napaka }))
  else console.error(`\n✖ ${napaka}\n`)
  process.exit(1)
}

try {
  const plan = planMigration({ schemaPath: args.schema, dbPath })
  if (args.json) {
    console.log(
      JSON.stringify({
        ok: plan.zavrnitve.length === 0,
        dryRun: !args.apply,
        dbPath,
        jePrazen: plan.jePrazen,
        lahkoUporabi: plan.lahkoUporabi,
        stavke: plan.stavke,
        zavrnitve: plan.zavrnitve,
        odvecni: plan.odvecni,
      }),
    )
  } else {
    console.log(`Baza: ${dbPath}`)
    console.log(`Načrt — dodatki: ${plan.stavke.length} · zavrnitve: ${plan.zavrnitve.length} · odvečni stolpci: ${plan.odvecni.length}.`)
    for (const s of plan.stavke) {
      const cilj = s.stolpec ? `${s.tabela}.${s.stolpec}` : s.indeks ? `${s.tabela} → ${s.indeks}` : s.tabela
      console.log(`  + [${s.vrsta}] ${cilj}`)
    }
    for (const o of plan.odvecni) console.log(`  ? ${o.tabela}.${o.stolpec} ga shema ne pozna več — OSTANE, pogon ne briše.`)
    // Pri suhem teku je to edini izpis razlogov; pri --apply jih izpiše rezultat
    // posega, da isti blok ne pride na zaslon dvakrat.
    const opozorilo = migracijskoOpozorilo(plan)
    if (!args.apply && opozorilo) console.log(`\n⚠ ${opozorilo}`)
  }

  if (!args.apply) {
    if (!args.json) console.log('\nSuhi tek: baza NI bila spremenjena. Z izvedbo: bun run local:migrate --apply')
    process.exit(plan.zavrnitve.length === 0 ? 0 : 1)
  }

  const result = applyMigration({ dbPath, plan, backupsDir: backupsDirFor(dbPath) })
  const ostane = result.zavrnitve.length
  if (args.json) {
    console.log(JSON.stringify({ ok: result.napaka === null && ostane === 0, ...result }))
  } else if (result.napaka) {
    console.error(`\n✖ Migracija ni uspela sredi batcha: ${result.napaka}`)
    console.error(`  Baza je bila POKLICANA nazaj (ROLLBACK) — preverjeno stanje je v ${result.kopija}.`)
  } else if (result.opravljene.length === 0) {
    console.log(ostane === 0 ? '\nNič ni bilo za dodati: baza je usklajena, kopije zato ni.' : '\nNič ni bilo za dodati: kopije zato ni.')
  } else {
    console.log(
      `\n✔ Dodanih stavkov: ${result.opravljene.length} (ena sama transakcija); kopija pred migracijo: ${path.basename(String(result.kopija))}.`,
    )
    for (const tabela of Object.keys(result.vrsticePo).sort()) {
      console.log(`  · ${tabela}: število vrstic ${result.vrsticePred[tabela]} → ${result.vrsticePo[tabela]}`)
    }
    console.log(`  · journal_mode: ${result.journalMode} · tuji ključi preverjeni · integrity_check ok`)
  }
  // Zavrnitev NI blokada (meritev na ci1.182.0.db), a mora se videti po imenu:
  // brez tega izpisa bi branec vedel samo, KOLIKO razlik ostaja, ne katerih.
  if (!args.json && result.napaka === null && ostane > 0) {
    console.log(`\n⚠ ${migracijskoOpozorilo(plan)}`)
    console.log('  → Ukaz zato vrne izhodno kodo 1: baza NI popolnoma usklajena.')
  }
  process.exit(result.napaka === null && ostane === 0 ? 0 : 1)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (args.json) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error(`\n✖ ${message}\n`)
  process.exit(1)
}
