#!/usr/bin/env bun
/**
 * v1.165.0 — en ukaz za lokalni RestaurantOS (PRD R1, F6).
 *
 * `bun run local` pripravi bazo (če je še ni), zgradi aplikacijo (če je še ni)
 * in jo zažene na 0.0.0.0, da je dostopna tudi na tablicah v lokalnem omrežju.
 * Ne seje demo podatkov in ne odpira nobene oblačne baze.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { lanUrls } from '../src/lib/local-runtime'
import { runLocalSetup } from '../src/lib/local-setup'

const ROOT = process.cwd()
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
const BUILD_ID = path.join(ROOT, '.next', 'BUILD_ID')
const STANDALONE_MARKER = path.join(ROOT, '.next', 'standalone', 'server.js')

const USAGE = `Uporaba: bun run local [možnosti]

  --port <številka>        Vrata (privzeto 3000 ali PORT iz okolja)
  --data-dir <pot>         Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  --owner-email <e-pošta>  Prijavni e-poštni naslov lastnika (prvi zagon)
  --owner-pin <PIN>        PIN lastnika (prvi zagon; sicer naključen)
  --restaurant-name <ime>  Ime obrata (prvi zagon)
  --build                  Prisili ponovno gradnjo
  -h, --help               Ta pomoč
`

interface Args {
  port: number
  dataDir?: string
  ownerEmail?: string
  ownerPin?: string
  restaurantName?: string
  forceBuild: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const rawPort = process.env.PORT || '3000'
  const args: Args = { port: Number(rawPort), forceBuild: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--build') args.forceBuild = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--port') args.port = Number(value(i++, a))
    else if (a === '--data-dir') args.dataDir = value(i++, a)
    else if (a === '--owner-email') args.ownerEmail = value(i++, a)
    else if (a === '--owner-pin') args.ownerPin = value(i++, a)
    else if (a === '--restaurant-name') args.restaurantName = value(i++, a)
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

if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
  console.error('[local] Vrata morajo biti celo število med 1 in 65535.')
  process.exit(2)
}

if (!existsSync(NEXT_BIN)) {
  console.error('[local] Manjka Next.js. Najprej zaženite: bun install')
  process.exit(1)
}

let setup: Awaited<ReturnType<typeof runLocalSetup>>
try {
  setup = await runLocalSetup({
    dataDir: args.dataDir,
    ownerEmail: args.ownerEmail,
    ownerPin: args.ownerPin,
    restaurantName: args.restaurantName,
    allowGenerate: true,
  })
} catch (err) {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

console.log(`\nRestaurantOS — lokalni profil`)
console.log(`  Podatki: ${setup.dataDir}`)
console.log(`  Baza:    ${setup.dbPath}`)
if (setup.ownerCreated) {
  console.log(`  Lastnik: ${setup.ownerEmail}`)
  if (setup.pin) console.log(`  PIN:     ${setup.pin}`)
  console.log(`  Poverilnice so v ${path.join(setup.dataDir, 'PRVIC-ZAGON.txt')}`)
} else {
  console.log(`  Lastnik: ${setup.ownerEmail} (obstoječi račun)`)
}

const needsBuild = args.forceBuild || !existsSync(BUILD_ID) || existsSync(STANDALONE_MARKER)
if (needsBuild) {
  console.log('\n[local] Gradim aplikacijo — prvi zagon traja nekaj minut ...')
  const build = spawnSync(process.execPath, [NEXT_BIN, 'build'], { cwd: ROOT, env: process.env, stdio: 'inherit' })
  if (build.status !== 0) {
    console.error(`\n✖ Gradnja ni uspela (izhod ${build.status ?? '?'}).`)
    process.exit(build.status ?? 1)
  }
}

console.log('\nRestaurantOS teče:')
console.log(`  ta računalnik: http://localhost:${args.port}`)
for (const url of lanUrls(args.port)) console.log(`  v omrežju:     ${url}`)
console.log('\n  Ustavi s Ctrl+C. Demo podatki niso naloženi.\n')

const child = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(args.port), '-H', '0.0.0.0'], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    child.kill(signal)
  })
}

child.on('error', (err) => {
  console.error(`[local] Aplikacije ni bilo mogoče zagnati: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) process.exit(0)
  process.exit(code ?? 0)
})
