#!/usr/bin/env bun
/**
 * v1.181.0 — podporni paket za lokalni profil (PRD docs/PRD-LOKALNA-BAZA.md, R4:
 * "support bundle brez skrivnosti"). Velja zanj tests/v181-support-bundle.test.ts §I.
 *
 * Kdaj se uporabi: ko obrat javi napako in lastnik nima odprte konzole — od
 * v1.175.0 dalje teče `bun run local` ob prijavi, torej stdout nima bralca.
 * Paket sme iti na pošto; baza, `config.json`, `PRVIC-ZAGON.txt` in `tls/` ne.
 *
 * Zakaj ne kar `GET /api/health`: paket ga potrebuje tudi takrat, ko strežnik NE
 * teče (ravno takrat je podpora potrebna), zato sondira SQLite datoteko neposredno.
 *
 * Paket opisuje LOKALNO namestitev: `mode` in `databaseEngine` sta zapisana
 * neposredno in ne iz `DATABASE_URL`, ker `bun` samodejno naloži `.env` in bi
 * lahko javil oblačni profil medtem ko se v resnici bere lokalna baza.
 *
 * Uporaba: bun run local:support [--data-dir pot] [--json]
 */
import { spawnSync } from 'node:child_process'
import { rmSync, statfsSync } from 'node:fs'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { APP_VERSION } from '../src/lib/version'
import { databasePathFor, resolveDataDir } from '../src/lib/local-runtime'
import { LOCAL_BUSY_TIMEOUT_MS, LOCAL_SYNCHRONOUS, readDurabilityState } from '../src/lib/local-durability'
import {
  assertBundleClean,
  buildBundle,
  collectSecretValues,
  countTables,
  readSnapshot,
  writeBundle,
  type BundleEnvironment,
} from '../src/lib/support-bundle'

const USAGE = `Uporaba: bun run local:support [možnosti]

  --data-dir <pot>   Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  --json             Strojno berljiv izpis (en sam JSON na stdout)
  -h, --help         Ta pomoč

Paket se zapiše v <podatkovna mapa>\\support\\<casovna-zatrditev> in TAKOJ
preveri, da v njem ni nobene znane skrivnosti. Če se preveri ne uspe, se mapa
izbriše in paket ne sme na pošto.
`

interface Args {
  dataDir?: string
  json: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--data-dir') {
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) throw new Error('[local] Možnost --data-dir zahteva vrednost.')
      args.dataDir = v
      i++
    } else throw new Error(`[local] Neznana možnost: ${a}\n\n${USAGE}`)
  }
  return args
}

/** V pakiranem izvozu `git` ni nujno nameščen — paket se mora sestaviti tudi brez njega. */
function commitPovzetek(): string {
  const got = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  if (got.status !== 0) return 'neznano'
  return (got.stdout || '').trim() || 'neznano'
}

function prostoMb(dir: string): number | undefined {
  try {
    const s = statfsSync(dir)
    return Math.round((Number(s.bavail) * Number(s.bsize)) / 1024 / 1024)
  } catch {
    return undefined
  }
}

interface Sonda {
  health: Record<string, unknown>
  durability: Record<string, unknown> | null
  warnings: string[]
}

/**
 * Isti dvostopenjski preizkus kot `GET /api/health` (issue #76), a brez HTTP-ja:
 * 1) baza se odpre in `SELECT 1` gre skozi; 2) tabela `"Location"` obstaja.
 * Odprto je SAMO BRALNO — podpora ne sme popravljati stanja, ki ga opisuje
 * (npr. z `applyDurability`, ki vklopi WAL).
 *
 * Izmerjeno 2026-10-26: `busy_timeout` in `synchronous` veljata SAMO za povezavo, na
 * sveži povezavi torej vrnetta 0 oziroma 2 — nikoli tega, kar je nastavila
 * aplikacija. Trajno je samo `journal_mode` (zapisano v glavi datoteke). Paket
 * zato meri journal_mode, za pragmi pa navaja VREDNOSTI, KI JU APLIKACIJA NASTAVI.
 * Prvo vrstico sporočila izjeme pobere redaktura, znane skrivnosti pa še
 * `assertBundleClean`.
 */
function sonda(dbPath: string): Sonda {
  const warnings: string[] = []
  let handle: DatabaseSync | undefined
  try {
    handle = new DatabaseSync(dbPath, { readOnly: true })
    handle.prepare('SELECT 1').get()
    let schema: 'ok' | 'drift' = 'ok'
    try {
      handle.prepare('SELECT 1 FROM "Location" LIMIT 1').get()
    } catch {
      schema = 'drift'
    }
    const journalMode = readDurabilityState(handle).journalMode
    if (journalMode !== 'wal') {
      warnings.push(`lokalna baza teče v journal_mode=${journalMode}, obljubljen je WAL — kopija lahko izgubi zadnje potrjene transakcije`)
    }
    return {
      health: { database: 'connected', schema },
      durability: { journalMode, configuredBusyTimeoutMs: LOCAL_BUSY_TIMEOUT_MS, configuredSynchronous: LOCAL_SYNCHRONOUS },
      warnings,
    }
  } catch (err) {
    return {
      health: { database: 'disconnected', schema: 'skipped', error: (err as Error).message.split('\n')[0] },
      durability: null,
      warnings: ['baze ni bilo mogoče odpreti (brez baze paket ne čaka)'],
    }
  } finally {
    try {
      handle?.close()
    } catch {
      // Pod bunom ročaj sprosti šele GC (enako kot v tests/v169-local-durability.test.ts).
    }
  }
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

const now = new Date()
const dataDir = args.dataDir ? resolveDataDir({ env: { RESTAURANTOS_DATA_DIR: args.dataDir } }) : resolveDataDir()
const dbPath = databasePathFor(dataDir)

const secrets = collectSecretValues(dataDir)
const snapshot = readSnapshot({ dataDir, now })
const counted = countTables(dbPath)
const zaznano = sonda(dbPath)
const warnings = [...snapshot.warnings, ...zaznano.warnings]
if (counted.error) warnings.push(`števčkov rel ni bilo mogoče narediti: ${counted.error.split('\n')[0]}`)

const environment: BundleEnvironment = {
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
  runtime: (process.versions as Record<string, string | undefined>).bun
    ? `bun ${process.versions.bun}`
    : process.version,
  home: os.homedir(),
  dataDir,
  freeDiskMb: prostoMb(dataDir),
}

const bundle = buildBundle({
  now,
  appVersion: APP_VERSION,
  commit: commitPovzetek(),
  mode: 'local',
  databaseEngine: 'sqlite',
  environment,
  health: zaznano.health,
  durability: zaznano.durability,
  backups: snapshot.backups,
  logs: snapshot.logs,
  counts: counted.counts,
  secrets,
  warnings,
})

const zapisan = writeBundle({ dataDir, now, bundle })

try {
  assertBundleClean(zapisan.files, secrets)
} catch (err) {
  const sporočilo = `Podporni paket je bil ZAVRNJEN in mapa je izbrisana: ${(err as Error).message}`
  rmSync(zapisan.dir, { recursive: true, force: true })
  if (args.json) console.log(JSON.stringify({ ok: false, error: sporočilo }))
  else console.error(`\n✖ ${sporočilo}\n`)
  process.exit(1)
}

if (args.json) {
  console.log(
    JSON.stringify({
      ok: true,
      dir: zapisan.dir,
      bytes: zapisan.bytes,
      files: Object.keys(zapisan.files).sort(),
      redactions: bundle.redactions,
      warnings,
    }),
  )
} else {
  console.log(`✔ Podporni paket je nareden: ${zapisan.dir}`)
  console.log(`  Datotek: ${Object.keys(zapisan.files).length}, skupaj ${(zapisan.bytes / 1024).toFixed(1)} KiB.`)
  console.log(`  Maskirano je bilo ${bundle.redactions} posegov; nobena znana skrivnost v paketu ni ostala.`)
  for (const w of warnings) console.log(`  Opozorilo: ${w}`)
  console.log('\nMapo zapakiraj (desni klik → Pošlji v → stisnjena mapa) in pošlji podpori.')
  console.log('Pred oddajo še sam poglej dnevnik.log — maskiranje je samodejno, zadnji pregled pa stori človek.')
}
