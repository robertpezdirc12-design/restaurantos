#!/usr/bin/env bun
/**
 * v1.169.0 — obnova lokalne baze iz kopije (PRD docs/PRD-LOKALNA-BAZA.md, R2).
 *
 * Obnova je edini korak v lokalnem profilu, ki NAMERNO prepíše podatke, zato
 * zahteva zavedanje: kopija se najprej preveri (integrity_check), stanje,
 * ki ga bo prepisala, se shrani med kopije, aplikacija pa mora biti ustavljena.
 *
 * v1.182.0 (R5a) — `--bundle <pot.rosbak>`: ista obnova iz ŠIFRIRANEGA
 * kontejnerja na ključku, torej obnovitev na napravi, ki baze nikoli ni imela.
 * Tu ni druge poti do podatkov kot geslo, zato ga ukaz vzame iz okolja
 * `RESTAURANTOS_OFFSITE_PASSPHRASE` ali iz datoteke — nikoli iz `argv`.
 *
 * Uporaba: bun run local:restore --latest|--from <pot>|--bundle <pot> [--data-dir pot] [--force] [--list] [--json]
 */
import path from 'node:path'
import {
  LOCAL_DAILY_BACKUP_PREFIX,
  LOCAL_PRE_PUSH_BACKUP_PREFIX,
  LOCAL_PRE_RESTORE_PREFIX,
  backupsDirFor,
  listBackups,
  restoreDatabase,
} from '../src/lib/local-durability'
import {
  LOCAL_OFFSITE_PASSPHRASE_ENV,
  readPassphraseFromEnv,
  readPassphraseFromFile,
  restoreFromBundle,
} from '../src/lib/offsite-backup'
import { databasePathFor, resolveDataDir } from '../src/lib/local-runtime'

const USAGE = `Uporaba: bun run local:restore [možnosti]

  --latest             Obnovi iz najnovejše dnevne kopije
  --from <pot>         Obnovi iz točno določene (nešifrirane) kopije
  --bundle <pot>       Obnovi iz šifriranega kontejnerja \`dalec-*.rosbak\` (R5a)
  --passphrase-file <p> Datoteka z geslom za kontejner; drug vir je okolje
                        ${LOCAL_OFFSITE_PASSPHRASE_ENV}
  --list               Napiši razpoložljive kopije (dna nova najprej) in izstopi
  --data-dir <pot>     Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  --force              Potrdi prepis OBSTOJEČE baze (stanje prej shraniš med kopije)
  --json               Strojno berljiv izpis (en sam JSON na stdout)
  -h, --help           Ta pomoč

Najprej ustavite aplikacijo (Ctrl+C). Pred obnovo obstoječe baze je treba z
--force potrditi, da gre za nameren prepis.
`

interface Args {
  latest: boolean
  from?: string
  bundle?: string
  passphraseFile?: string
  list: boolean
  dataDir?: string
  force: boolean
  json: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { latest: false, list: false, force: false, json: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--latest') args.latest = true
    else if (a === '--list') args.list = true
    else if (a === '--force') args.force = true
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--from') args.from = value(i++, a)
    else if (a === '--bundle') args.bundle = value(i++, a)
    else if (a === '--passphrase-file') args.passphraseFile = value(i++, a)
    else if (a === '--data-dir') args.dataDir = value(i++, a)
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
const dbPath = databasePathFor(dataDir)
const backupsDir = backupsDirFor(dbPath)
const vrstniRed = [LOCAL_DAILY_BACKUP_PREFIX, LOCAL_PRE_PUSH_BACKUP_PREFIX, LOCAL_PRE_RESTORE_PREFIX]

/** `listBackups` vrne IMENA; obnova hoče absolutne poti, sicer jo SQLite ne najde. */
function poStarosti(prefix: string): string[] {
  return listBackups(backupsDir, prefix)
    .map((name) => path.join(backupsDir, name))
    .sort()
    .reverse()
}

/** seznam za --list: vse vrste skupaj, nazadnje naredena najprej */
function vseKopije(): string[] {
  return vrstniRed.flatMap(poStarosti).sort().reverse()
}

if (args.bundle && (args.latest || args.from)) {
  console.error(`[local] --bundle je izključujoč z --latest in --from: kontejner JE izbrana kopija.\n\n${USAGE}`)
  process.exit(2)
}

// R5a: kontejner nosi samo šifriran odsek, zato JE geslo del kopije. Brez njega
// ukaz konča z 2 — ne poskusi "morda pa je kar baza", ker bi bila taka obnova
// tiho napačna.
if (args.bundle) {
  let geslo: string | null = null
  try {
    geslo = args.passphraseFile ? readPassphraseFromFile(args.passphraseFile) : readPassphraseFromEnv()
  } catch (err) {
    console.error((err as Error).message)
    process.exit(2)
  }
  if (!geslo) {
    console.error(
      `[local] Gesla za kontejner ni: nastavi ${LOCAL_OFFSITE_PASSPHRASE_ENV} ali podaj --passphrase-file <pot>. Obnova se ni začela in baza ni bila spremenjena.`,
    )
    process.exit(2)
  }
  try {
    const result = restoreFromBundle({ bundlePath: path.resolve(args.bundle), passphrase: geslo, dbPath, force: args.force })
    if (args.json) console.log(JSON.stringify({ ok: true, ...result }))
    else {
      console.log(`✔ Baza je obnovljena iz šifriranega kontejnerja ${path.basename(result.fromBundle)} (integrity_check ok, ${result.pageCount} strani).`)
      if (result.safetyCopy) console.log(`✔ Stanje pred obnovo je shranjeno kot ${path.basename(result.safetyCopy)}.`)
      console.log(`  Baza: ${result.dbPath} (replica: ${result.journalMode})`)
      console.log('\nGeslo hrani ločeno od ključka: brez njega je kontejner nerazumljiv.')
      console.log('Zaženite `bun run local` in preverite /api/health, da je schema ok.')
    }
    process.exit(0)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (args.json) console.log(JSON.stringify({ ok: false, error: message }))
    else console.error(`\n✖ ${message}\n`)
    process.exit(1)
  }
}

if (args.list) {
  const files = vseKopije()
  if (args.json) console.log(JSON.stringify({ ok: true, backupsDir, dbPath, kopije: files }))
  else if (files.length === 0) console.log(`V mapi ${backupsDir} ni kopij. Za prvo: bun run local:backup`)
  else {
    console.log(`Kopije v ${backupsDir} (nazadnje naredena je prva):`)
    for (const file of files) console.log(`  ${path.basename(file)}`)
    console.log(`\nBaza: ${dbPath}`)
    console.log('Obnova: bun run local:restore --latest --force   (ali --from <pot>)')
  }
  process.exit(0)
}

// `--latest` je recovery point, ne najmlajša datoteka: varnostna kopija iz
// prejšnje obnove je lahko mlajša in vsebuje ravno tisto stanje, ki smo ga prav
// takrat zavrnili.
const najnovejsaDnevna = poStarosti(LOCAL_DAILY_BACKUP_PREFIX)[0]
if (args.latest && !najnovejsaDnevna) {
  console.error(`[local] Dnevne kopije ni v ${backupsDir}. Obnova se ni začela; izberi kopijo z --from <pot> (seznam: --list).`)
  process.exit(1)
}
const backupPath = args.from ? path.resolve(args.from) : najnovejsaDnevna
if (!backupPath) {
  console.error(`[local] Katero kopijo? Uporabite --latest ali --from <pot>.\n\n${USAGE}`)
  process.exit(2)
}

try {
  const result = await restoreDatabase({ backupPath, dbPath, force: args.force })
  if (args.json) console.log(JSON.stringify({ ok: true, ...result }))
  else {
    console.log(`✔ Baza je obnovljena iz ${path.basename(backupPath)} (integrity_check ok, ${result.pageCount} strani).`)
    if (result.safetyCopy) console.log(`✔ Stanje pred obnovo je shranjeno kot ${path.basename(result.safetyCopy)}.`)
    console.log(`  Baza: ${result.dbPath} (replica: ${result.journalMode})`)
    console.log('\nZaženite `bun run local` in preverite /api/health, da je schema ok.')
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (args.json) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error(`\n✖ ${message}\n`)
  process.exit(1)
}
