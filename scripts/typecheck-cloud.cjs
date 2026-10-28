#!/usr/bin/env node
// v1.184.0 — produkcijski tipi se preverjajo z lokalno nameščenim orodjem in ne z
// ugradnim pognalnikom.
//
// `postinstall` izbere shemo glede na DATABASE_URL (scripts/prisma-postinstall.cjs):
// lokalno je to `prisma/schema.sqlite.prisma`, kjer enumov ni (SQLite jih ne pozna),
// zato `status: 'approved'` dobi tip `string` in `tsc` nikoli ne opozori, da v
// produkcijski shemi tak člen ni. Vercel generira `prisma/schema.prisma` — tam je
// `TimeEntryStatus` unija `'active' | 'approved' | 'disputed'`, build pa pade šele
// na objavi (v1.166.0: 'completed' v scripts/seed-demo-history.ts).
//
// CI job `typecheck-prod` (`.github/workflows/ci.yml`) gleda isti razred napak, a
// teče na self-hosted runnerju, ki je zaradi kvote ure lahko v čakanju — zato ga
// izdajni ritual ne more čakati. Ta skript je lokalni par tistemu jobu.
//
// ZAKAJ NE VEČ `npx`/`bunx`: pognalnik se je doslej izbral glede na
// `npm_config_user_agent`. Pod `bun run typecheck:cloud` agent res začne z `bun/`,
// zato vrata dela; klic `node scripts/typecheck-cloud.cjs` (ali `npm run …`) agenta
// nima ali pa ima `npm/` in izbere `npx`. Ta v `node_modules/.bin` išče `tsc` ali
// `tsc.cmd`, bun pa tja zapiše samo `tsc.exe` in `tsc.bunx`; ko nobenega ne najde,
// ne javi manjkajočega orodja, ampak posegne v svoj predpomnik
// `_npx/<zgošček>/node_modules/tsc`, kjer je paket istega imena, ki ni TypeScript:
// izpiše „This is not the tsc command you are looking for" in stopi z izhodno kodo
// 1. Vrata so bila torej rdeča zaradi pripone, ki ni nastala, in ne zaradi kode.
//
// Skript sedaj obe orodji razreši v istem procesu (`require.resolve` glede na
// korensko mapo projekta) in ju požene z `process.execPath`. Brez PATH-a, brez
// `.bin` pripone, brez predpomnika.
//
// Klient na koncu VEDNO ostane SQLite, da testni suite (`bun test`) ne dobi lažnih
// padcev, kakor v v1.112.0.
const { spawnSync } = require('child_process')
const path = require('path')

const KOREN = path.resolve(__dirname, '..')

// Izstopne kode so del pogodbe: obrat jih razlikuje brez branja izpisa.
const KODA = {
  zelena: 0,
  tscRdec: 1,
  generatePadlo: 2,
  obnovitevNuspelo: 3,
  orodjeNiNamesceno: 4,
  neznanaMoznost: 64,
}

const ORODJE = {
  tsc: 'typescript/bin/tsc',
  prisma: 'prisma/build/index.js',
}

/**
 * Razreši orodje glede na korensko mapo. `cwd` je parametr namenoma: brez njega
 * razreda „orodje ni nameščeno" ne bi bilo mogoče preizkusiti brez rušenja
 * dejanskih `node_modules`.
 */
function razresi(cwd, ime) {
  const pot = ORODJE[ime]
  if (!pot) {
    throw new Error(`[typecheck-cloud] Neznano orodje "${ime}". Znani: ${Object.keys(ORODJE).join(', ')}.`)
  }
  let najdena
  try {
    najdena = require.resolve(pot, { paths: [cwd] })
  } catch {
    throw new Error(
      `[typecheck-cloud] Orodje "${ime}" (${pot}) ni nameščeno glede na ${cwd}. Zaženite \`bun install\`. ` +
        'Vratovi namenoma NE padajo nazaj na `npx`: takrat npm v predpomniku `_npx` najde paket istega imena, ' +
        'ki ni TypeScript, in izpiše „This is not the tsc command you are looking for" namesto jasne napake.',
    )
  }
  return najdena
}

/**
 * Izpis orodja glede na korensko mapo: `node_modules/prisma/build/index.js` pove
 * več kot `index.js`, absolutna pot pa ostane zadnja možnost (tuji `--cwd`).
 */
function oznaci(cwd, skript) {
  const rel = path.relative(cwd, skript)
  if (rel && !rel.startsWith('..')) return rel.split(path.sep).join('/')
  return skript
}

/**
 * Iz rezultata `spawnSync` izvleče izhodno kodo. `status === null` pomeni, da
 * otroka ni končal izstopni klic, ampak signal (POSIX: ubit `tsc`, timeout). Na
 * Windows te veje ni mogoče izzvati — izmerjeno 28. 10. 2026: samoubitje s
 * SIGKILL in timeout oba vrneta `status = 1, signal = null` — zato jo testuje
 * neposredno `izKod` in ne poskusni otrok.
 */
function izKod(rezultat) {
  return rezultat.status === null ? 1 : rezultat.status
}

/**
 * Požene orodje z izvršljivo potjo tega procesa (node ali bun). `izvršljiva` je
 * parametr samo zato, da je veja »programa ni mogoče zagnati« sploh dosegljiva
 * testu: `spawnSync` uspe tudi, ko manjka ciljna datoteka — takrat vrne kodo
 * otroka in ne `error`.
 */
function izvedi(cwd, skript, argumenti, label, izvršljiva = process.execPath) {
  console.log(`[typecheck-cloud] ${label}: ${oznaci(cwd, skript)} ${argumenti.join(' ')}`)
  const rezultat = spawnSync(izvršljiva, [skript, ...argumenti], { cwd, stdio: 'inherit' })
  if (rezultat.error) {
    throw new Error(`[typecheck-cloud] ${label} ni bilo mogoče zagnati: ${rezultat.error.message}`)
  }
  return izKod(rezultat)
}

function razcleni(argv) {
  const args = { probe: false, json: false, pomoc: false, cwd: KOREN, shema: 'prisma/schema.prisma', zrcalo: 'prisma/schema.sqlite.prisma' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--probe') args.probe = true
    else if (a === '--json') args.json = true
    else if (a === '--help' || a === '-h') args.pomoc = true
    else if (a === '--cwd') args.cwd = path.resolve(vrednost(argv, ++i, a))
    else if (a === '--schema') args.shema = vrednost(argv, ++i, a)
    else if (a === '--mirror') args.zrcalo = vrednost(argv, ++i, a)
    else return { napaka: `Neznana možnost "${a}".` }
  }
  return { args }
}

function vrednost(argv, i, zastavica) {
  const v = argv[i]
  if (!v) throw new Error(`[typecheck-cloud] Možnost ${zastavica} rabi vrednost.`)
  return v
}

const USAGE = [
  'Uporaba: bun run typecheck:cloud [--probe] [--json] [--cwd <mapa>] [--schema <pot>] [--mirror <pot>]',
  '',
  '  --probe       razreši obe orodji in ju izpiše; ne generira klienta in ne piše ničesar',
  '  --json        strojni izpis',
  '  --cwd <mapa>  korenska mapa, glede na katero se orodja razrešijo (privzeto koren projekta)',
  '  --schema <pot>    produkcijska shema (privzeto prisma/schema.prisma)',
  '  --mirror <pot>    zrcalna shema, ki jo skript vedno obnovi (privzeto prisma/schema.sqlite.prisma)',
  '',
  `Izstopne kode: ${KODA.zelena} tipi so usklajeni · ${KODA.tscRdec} tsc je rdeč · ${KODA.generatePadlo} produkcijski klient ni nastal · ${KODA.obnovitevNuspelo} SQLite klienta ni bilo mogoče vrniti · ${KODA.orodjeNiNamesceno} orodje ni nameščeno · ${KODA.neznanaMoznost} neznana možnost`,
].join('\n')

function main(argv) {
  let razclen
  try {
    razclen = razcleni(argv)
  } catch (e) {
    console.error(e.message)
    return KODA.neznanaMoznost
  }
  if (razclen.napaka) {
    console.error(`[typecheck-cloud] ${razclen.napaka}\n\n${USAGE}`)
    return KODA.neznanaMoznost
  }
  const args = razclen.args
  if (args.pomoc) {
    console.log(USAGE)
    return KODA.zelena
  }

  let orodja
  try {
    orodja = { tsc: razresi(args.cwd, 'tsc'), prisma: razresi(args.cwd, 'prisma') }
  } catch (e) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: e.message }))
    else console.error(e.message)
    return KODA.orodjeNiNamesceno
  }

  if (args.probe) {
    const rezultat = { ok: true, cwd: args.cwd, tsc: orodja.tsc, prisma: orodja.prisma }
    if (args.json) console.log(JSON.stringify(rezultat))
    else console.log(`[typecheck-cloud] orodji: tsc=${rezultat.tsc} prisma=${rezultat.prisma}`)
    return KODA.zelena
  }

  let izhodnaKoda = KODA.zelena
  let pripravljen = false
  try {
    const koda = izvedi(args.cwd, orodja.prisma, ['generate', '--schema', args.shema], 'produkcijski klient')
    if (koda === KODA.zelena) pripravljen = true
    else {
      izhodnaKoda = KODA.generatePadlo
      console.error(`[typecheck-cloud] \`prisma generate\` proti produkcijski shemi ni uspel (koda ${koda}).`)
    }
  } catch (e) {
    izhodnaKoda = KODA.generatePadlo
    console.error(`[typecheck-cloud] \`prisma generate\` proti produkcijski shemi ni uspel: ${e.message}`)
  }

  if (pripravljen) {
    try {
      const koda = izvedi(args.cwd, orodja.tsc, ['--noEmit'], 'tsc proti Postgres klientu')
      if (koda !== KODA.zelena) {
        izhodnaKoda = koda
        console.error(`[typecheck-cloud] RDEČE — produkcijski tipi se ne ujemajo (koda ${koda}).`)
        console.error('[typecheck-cloud] Popravi kodo, ne sheme (pravilo izpada v1.129.0).')
      }
    } catch (e) {
      izhodnaKoda = KODA.tscRdec
      console.error(`[typecheck-cloud] tsc ni bilo mogoče zagnati: ${e.message}`)
    }
  }

  // Obnova je VEDNO obvezna — tudi ko je prvi generate padel sredi kopiranja
  // (EPERM na query_engine dll, ker ga drži zagnan dev server). Delno zamenjan
  // klient ostane Postgres in naslednji `bun test` zruši z "URL must start with
  // postgresql://" — v1.167.0: 255 lažnih padcev, ker je process.exit(2) v catch
  // bloku preskočil to vejo.
  try {
    const koda = izvedi(args.cwd, orodja.prisma, ['generate', '--schema', args.zrcalo], 'vrni SQLite klient')
    if (koda !== KODA.zelena) {
      console.error(`[typecheck-cloud] OPOZORILO: SQLite klienta ni bilo mogoče obnoviti (koda ${koda}).`)
      console.error('[typecheck-cloud] Ročno: bun run db:generate')
      if (izhodnaKoda === KODA.zelena) izhodnaKoda = KODA.obnovitevNuspelo
    }
  } catch (e) {
    console.error('[typecheck-cloud] OPOZORILO: SQLite klienta ni bilo mogoče obnoviti:', e.message)
    console.error('[typecheck-cloud] Ročno: bun run db:generate')
    if (izhodnaKoda === KODA.zelena) izhodnaKoda = KODA.obnovitevNuspelo
  }

  return izhodnaKoda
}

module.exports = { KODA, ORODJE, KOREN, USAGE, razresi, oznaci, izKod, izvedi, razcleni, main }

if (require.main === module) process.exit(main(process.argv.slice(2)))
