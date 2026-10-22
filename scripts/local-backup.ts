#!/usr/bin/env bun
/**
 * v1.169.0 — ročna dnevna kopija lokalne baze (PRD docs/PRD-LOKALNA-BAZA.md, R2).
 *
 * `bun run local` kopijo naredi sam; ta ukaz je za dan, ko hoče lastnik kopijo
 * takoj (pred posegom v bazo, pred oddajo diska na servis). Isti dan ne ustvari
 * druge kopije, jo pa preveri — torej je varno ukaz ponoviti.
 *
 * Uporaba: bun run local:backup [--data-dir pot] [--kind dnevno|pred-pushom] [--json]
 */
import path from 'node:path'
import {
  LOCAL_DAILY_BACKUP_PREFIX,
  LOCAL_MAX_DAILY_BACKUPS,
  backupsDirFor,
  backupDatabase,
  listBackups,
} from '../src/lib/local-durability'
import { databasePathFor, resolveDataDir } from '../src/lib/local-runtime'

const USAGE = `Uporaba: bun run local:backup [možnosti]

  --data-dir <pot>   Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  --kind <vrsta>     dnevno (privzeto) ali pred-pushom
  --json             Strojno berljiv izpis (en sam JSON na stdout)
  -h, --help         Ta pomoč
`

interface Args {
  dataDir?: string
  kind: 'dnevno' | 'pred-pushom'
  json: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { kind: 'dnevno', json: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--data-dir') args.dataDir = value(i++, a)
    else if (a === '--kind') {
      const kind = value(i++, a)
      if (kind !== 'dnevno' && kind !== 'pred-pushom') throw new Error('[local] --kind je lahko dnevno ali pred-pushom.')
      args.kind = kind
    } else throw new Error(`[local] Neznana možnost: ${a}\n\n${USAGE}`)
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

try {
  const result = await backupDatabase(dbPath, backupsDir, { kind: args.kind })
  const dnevne = listBackups(backupsDir, LOCAL_DAILY_BACKUP_PREFIX)
  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...result, dnevnihKopij: dnevne.length, zadrzanih: LOCAL_MAX_DAILY_BACKUPS }))
  } else {
    console.log(
      result.created
        ? `✔ Kopija ${path.basename(result.file)} je naredena in preverjena (integrity_check ok, ${result.pageCount} strani).`
        : `✔ Današnja kopija ${path.basename(result.file)} je že obstala in je preverjena (integrity_check ok).`,
    )
    console.log(`  Mapa kopij: ${backupsDir}`)
    console.log(`  Dnevnih kopij: ${dnevne.length} od dovoljenih ${LOCAL_MAX_DAILY_BACKUPS}.`)
    console.log('\nPrenesite jo na USB ali omrežno mapo — kopija na istem disku ne zavaruje pred okvaro diska.')
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (args.json) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error(`\n✖ ${message}\n`)
  process.exit(1)
}
