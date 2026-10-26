#!/usr/bin/env bun
/**
 * v1.182.0 — šifrirana kopija lokalne baze IZVEN diska (PRD
 * docs/PRD-LOKALNA-BAZA.md, R5a).
 *
 * Razlika do `local:backup`: ta ukaz ne piše v mapo zraven baze, ampak na
 * medij, ki ga lastnik odnese (USB, zunanji disk, omrežna mapa), in sme
 * obstajati samo šifriran — kopija, ki zapusti obrat, je izročena svetu.
 *
 * Gesla NI v `argv`: ukaz ga vzame iz okolja
 * `RESTAURANTOS_OFFSITE_PASSPHRASE` ali iz datoteke (`--passphrase-file`),
 * ker seznam procesov in zgodovina lupine sicer ga izdasta.
 *
 * Uporaba: bun run local:offsite --to <pot> [--passphrase-file pot] [--data-dir pot]
 *          [--allow-same-volume] [--max <število>] [--json]
 */
import path from 'node:path'
import {
  LOCAL_MAX_OFFSITE_BUNDLES,
  LOCAL_OFFSITE_MIN_PASSPHRASE,
  LOCAL_OFFSITE_PASSPHRASE_ENV,
  createOffsiteBundle,
  offsiteWarning,
  readPassphraseFromEnv,
  readPassphraseFromFile,
} from '../src/lib/offsite-backup'
import { databasePathFor, resolveDataDir } from '../src/lib/local-runtime'
import { APP_VERSION } from '../src/lib/version'

const USAGE = `Uporaba: bun run local:offsite --to <pot> [možnosti]

  --to <pot>             Mapa na drugem mediju (USB, zunanji disk, omrežna mapa). Obvezen.
  --passphrase-file <p>  Datoteka z geslom (samo ena vrstica). Drug vir je okolje
                         ${LOCAL_OFFSITE_PASSPHRASE_ENV}. Geslo nikoli ne gre v ukazno vrstico.
  --data-dir <pot>       Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  --allow-same-volume    Dovoli kopijo na istem disku kot baza (za preizkus potu; sicer zavrnjeno)
  --max <število>        Koliko kopij zadržati na mediju (privzeto ${LOCAL_MAX_OFFSITE_BUNDLES})
  --json                 Strojno berljiv izpis (en sam JSON na stdout)
  -h, --help             Ta pomoč

Geslo mora imeti najmanj ${LOCAL_OFFSITE_MIN_PASSPHRASE} znakov. Brez njega kontejnerja ni
mogoče pozneje prebrati; izgubljeno geslo torej pomeni izgubljeno kopijo. Hrani ga
na varno mesto, NE v isto mapo kot kontejner in ne v ukazno vrsto.
Obnova: bun run local:restore --bundle <pot.rosbak> [--force]
`

interface Args {
  to?: string
  passphraseFile?: string
  dataDir?: string
  allowSameVolume: boolean
  max?: number
  json: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { allowSameVolume: false, json: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--allow-same-volume') args.allowSameVolume = true
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--to') args.to = value(i++, a)
    else if (a === '--data-dir') args.dataDir = value(i++, a)
    else if (a === '--passphrase-file') args.passphraseFile = value(i++, a)
    else if (a === '--max') {
      const max = Number(value(i++, a))
      if (!Number.isInteger(max) || max < 1) throw new Error('[local] --max mora biti pozitivno celo število.')
      args.max = max
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

if (!args.to) {
  console.error(`[local] Manjka --to: kopija ne sme tiho pristati v podatkovni mapi obrata.\n\n${USAGE}`)
  process.exit(2)
}

let passphrase: string | null = null
try {
  passphrase = args.passphraseFile ? readPassphraseFromFile(args.passphraseFile) : readPassphraseFromEnv()
} catch (err) {
  console.error((err as Error).message)
  process.exit(2)
}
if (!passphrase) {
  console.error(
    `[local] Gesla ni: nastavi ${LOCAL_OFFSITE_PASSPHRASE_ENV} ali podaj --passphrase-file <pot>. Kopije ni bilo mogoče narediti in podatki niso bili spremenjeni.`,
  )
  process.exit(2)
}

const dataDir = args.dataDir ? resolveDataDir({ env: { RESTAURANTOS_DATA_DIR: args.dataDir } }) : resolveDataDir()
const dbPath = databasePathFor(dataDir)

try {
  const result = createOffsiteBundle({
    dbPath,
    targetDir: args.to,
    passphrase,
    appVersion: APP_VERSION,
    allowSameVolume: args.allowSameVolume,
    ...(args.max ? { maxBundles: args.max } : {}),
  })
  const opozorilo = offsiteWarning(result)
  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...result, ...(opozorilo ? { opozorilo } : {}) }))
  } else {
    console.log(
      `✔ Šifrirana kopija ${path.basename(result.file)} je naredena, preverjena in brana nazaj (integrity_check ok, ${result.pageCount} strani, ${result.bytes} B).`,
    )
    console.log(`  Vir: ${dbPath}`)
    console.log(`  Medij: ${path.dirname(result.file)}`)
    console.log(`  Kontejnerjev na mediju je zadržanih največ ${args.max ?? LOCAL_MAX_OFFSITE_BUNDLES}, pobrisanih ${result.pruned}.`)
    if (opozorilo) console.log(`\n⚠ ${opozorilo}`)
    console.log('\nKopijo odnesi z naprave. Obnova na drugi napravi: bun run local:restore --bundle <pot.rosbak>')
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (args.json) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error(`\n✖ ${message}\n`)
  process.exit(1)
}
