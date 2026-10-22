#!/usr/bin/env node
// v1.166.0 — tipe produkcijskega Prisma klienta mora preverjati ALSO lokalno.
//
// `postinstall` izbere shemo glede na DATABASE_URL (scripts/prisma-postinstall.cjs):
// lokalno je to `prisma/schema.sqlite.prisma`, kjer enumov ni (SQLite jih ne pozna),
// zato `status: 'approved'` dobi tip `string` in `tsc` nikoli ne opozori, da v
// produkcijski shemi tak člen ni. Vercel generira `prisma/schema.prisma` — tam je
// `TimeEntryStatus` unija `'active' | 'approved' | 'disputed'`, build pa pade šele
// na objavi (v1.166.0: 'completed' v scripts/seed-demo-history.ts).
//
// CI job `typecheck-prod` (`.github/workflows/ci.yml`) gleda isto razred napak, a
// teče na self-hosted runnerju, ki je zaradi kvote ure lahko v čakanju — zato ga
// izdajni ritual ne more čakati. Ta skript je lokalni par tistemu jobu.
//
// Klient na koncu VEDNO ostane SQLite, da testni suite (`bun test`) ne dobi 29
// lažnih padcev, kakor v v1.112.0.
const { execSync } = require('child_process')

const isBun = (process.env.npm_config_user_agent || '').startsWith('bun/')
const runner = isBun ? 'bunx' : 'npx'

function run(command, label) {
  console.log(`[typecheck-cloud] ${label}: ${command}`)
  execSync(command, { stdio: 'inherit' })
}

let exitCode = 0
let cloudReady = false
try {
  run(`${runner} prisma generate --schema prisma/schema.prisma`, 'produkcijski klient')
  cloudReady = true
} catch (e) {
  console.error('[typecheck-cloud] `prisma generate` proti Postgres shemi ni uspel:', e.message)
  exitCode = 2
}

if (cloudReady) {
  try {
    run(`${runner} tsc --noEmit`, 'tsc proti Postgres klientu')
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : 1
    console.error(`[typecheck-cloud] RDEČE — produkcijski tipi se ne ujemata (koda ${exitCode}).`)
    console.error('[typecheck-cloud] Popravi kodo, ne sheme (pravilo izpada v1.129.0).')
  }
}

// Obnova je VEDNO obvezna — tudi ko je prvi generate padel sredi kopiranja
// (EPERM na query_engine dll, ker ga drži zagnan dev server). Delno zamenjan
// klient ostane Postgres in naslednji `bun test` zruši z "URL must start with
// postgresql://" — v1.167.0: 255 lažnih padcev, ker je process.exit(2) v catch
// bloku preskočil to vejo.
try {
  run(`${runner} prisma generate --schema prisma/schema.sqlite.prisma`, 'vrni SQLite klient')
} catch (e) {
  console.error('[typecheck-cloud] OPOZORILO: SQLite klienta ni bilo mogoče obnoviti:', e.message)
  console.error('[typecheck-cloud] Ročno: bun run db:generate')
  // Zelena vrata z razbitim klientom so laž: brez SQLite klienta naslednji
  // `bun test` pade iz napačnega razloga. Koda se ne sme povrniti na 0.
  if (exitCode === 0) exitCode = 3
}

process.exit(exitCode)
