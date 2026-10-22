#!/usr/bin/env bun
/**
 * v1.166.0 — ZAČASNI `bun run demo` (lastnikova zahteva: «demo dostop, da ne
 * vpisujem gesel za testiranje; potem odstranimo»).
 *
 * Naredi tri stvari, ki jih `bun run local` namenoma NE naredi:
 *  1. ustvari lastno demo bazo `prisma/db/demo.db` (testna `dev.db` se ne dotika),
 *  2. naloži demo podatke (lokacija, meni, postaje, mize, naročila po starosti
 *     in 7-dnevna zgodovina plačil + izmen za analitiki),
 *  3. zažene dev strežnik z odprtimi demo vrati, pripetimi na `admin@…`, z rokom.
 *
 * Uporabnik nato odpre http://localhost:3000 in klikne «Prijava v demo» — brez
 * e-pošte in brez PIN-a. Ostale zaslone (KDS, handheld, tloris) je mogoče
 * odpreti neposredno, seja je v piškotku.
 *
 * Odstranitev: `docs/DEMO-DOSTOP.md` §4.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DEMO_EMAIL, DEMO_GATE_DAYS, demoDbPath, demoEnv } from '../src/lib/demo-runtime'

const ROOT = process.cwd()
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
const PRISMA_CLI = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js')
const SQLITE_SCHEMA = path.join(ROOT, 'prisma', 'schema.sqlite.prisma')
const CLIENT_SCHEMA = path.join(ROOT, 'node_modules', '.prisma', 'client', 'schema.prisma')
const SEEDS = [
  'prisma/seed.ts',
  'scripts/seed-demo-menu.ts',
  'scripts/seed-demo-tables.ts',
  'scripts/seed-demo-orders.ts',
  'scripts/seed-demo-history.ts',
]

const USAGE = `Uporaba: bun run demo [možnosti]

  --port <številka>   Vrata (privzeto 3000 ali PORT iz okolja)
  --days <št. dni>    Rok demo vrat (privzeto ${DEMO_GATE_DAYS})
  --reset             Znova ustvari demo bazo (obstoječa se izbriše)
  -h, --help          Ta pomoč
`

interface Args {
  port: number
  days: number
  reset: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { port: Number(process.env.PORT || '3000'), days: DEMO_GATE_DAYS, reset: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[demo] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') args.help = true
    else if (a === '--reset') args.reset = true
    else if (a === '--port') args.port = Number(value(i++, a))
    else if (a === '--days') args.days = Number(value(i++, a))
    else throw new Error(`[demo] Neznana možnost: ${a}\n\n${USAGE}`)
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
  console.error('[demo] Vrata morajo biti celo število med 1 in 65535.')
  process.exit(2)
}

for (const [what, file] of [
  ['Next.js (zaženite `bun install`)', NEXT_BIN],
  ['Prisma CLI (zaženite `bun install`)', PRISMA_CLI],
  ['SQLite zrcalna shema', SQLITE_SCHEMA],
] as const) {
  if (!existsSync(file)) {
    console.error(`[demo] Manjka ${what}: ${file}`)
    process.exit(1)
  }
}

const env: NodeJS.ProcessEnv = { ...process.env, ...demoEnv({ days: args.days }) }
const dbPath = demoDbPath(ROOT)

function run(cmd: string[], label: string): void {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`\n✖ [demo] ${label} je prekinil ukaz (izhod ${r.status ?? '?'}).`)
    process.exit(r.status ?? 1)
  }
}

function prisma(argsList: string[], label: string): void {
  run([process.execPath, PRISMA_CLI, ...argsList], label)
}

mkdirSync(path.dirname(dbPath), { recursive: true })

if (args.reset && existsSync(dbPath)) {
  console.log('[demo] Brišem obstoječo demo bazo ...')
  rmSync(dbPath)
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix)
  }
}

// Odjemalec mora biti zgrajen iz SQLite zrcala — sicer npr. Postgres različica
// zavrne `file:` URL in `db push` pade šele v Prisma notranjosti.
function generatedIsSqlite(): boolean {
  if (!existsSync(CLIENT_SCHEMA)) return false
  return /provider\s*=\s*"sqlite"/.test(readFileSync(CLIENT_SCHEMA, 'utf8'))
}
if (!generatedIsSqlite()) {
  console.log('[demo] Gradim Prisma odjemalca iz SQLite zrcala ...')
  prisma(['generate', '--schema', SQLITE_SCHEMA], 'prisma generate')
}

console.log(`[demo] Baza: ${dbPath}`)
prisma(['db', 'push', '--schema', SQLITE_SCHEMA, '--skip-generate', '--accept-data-loss'], 'prisma db push')

console.log('[demo] Nalagam demo podatke (meni, mize, naročila, zgodovina 7 dni) ...')
for (const seed of SEEDS) {
  run([process.execPath, seed], `seed ${seed}`)
}

const gateExpiry = env.DEMO_LOGIN_EXPIRES_AT!.slice(0, 10)
console.log('\nRestaurantOS — ZAČASNI demo profil (ne zamenja `bun run local`)')
console.log(`  Naslov:    http://localhost:${args.port}`)
console.log(`  Prijava:   na uvodnem zaslonu klikni «Prijava v demo» — brez gesla in brez PIN-a`)
console.log(`             (pripeta na ${DEMO_EMAIL}; nadzorni PIN za potrdila je 1234)`)
console.log(`  Vrata:     odprta do ${gateExpiry} (vsak vstop je zabeležen v revizijski zapis)`)
console.log(`  Baza:      ${dbPath} — testna dev.db se ne dotika\n`)

const child = spawn(process.execPath, [NEXT_BIN, 'dev', '-p', String(args.port)], { cwd: ROOT, env, stdio: 'inherit' })

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    child.kill(signal)
  })
}

child.on('error', (err) => {
  console.error(`[demo] Strežnika ni bilo mogoče zagnati: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) process.exit(0)
  process.exit(code ?? 0)
})
