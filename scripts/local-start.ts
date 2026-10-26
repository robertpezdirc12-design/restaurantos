#!/usr/bin/env bun
/**
 * v1.165.0 — en ukaz za lokalni RestaurantOS (PRD R1, F6).
 * v1.169.0 — ob zagonu še dnevna varnostna kopija (PRD R2).
 * v1.175.0 — R2b2: `--https` vžene TLS front pred Nextom, da je obrat dosegljiv
 *            brez žice in z zaklenjeno sejo (pogoj za namestitev PWA na tablico).
 * v1.180.0 — R3: fronta dobi HMAC dokaz (`frontProof`), brez njega brskalnik ne
 *            more prevzeti namestitve; podatkovna mapa se izroči Nextu v okolju,
 *            sicer bi prevzem ustvaril obrat v privzeti mapi namesto v `--data-dir`.
 *
 * `bun run local` pripravi bazo (če je še ni), naredi dnevno kopijo, zgradi
 * aplikacijo (če je še ni) in jo zažene na 0.0.0.0, da je dostopna tudi na
 * tablicah v lokalnem omrežju. Ne seje demo podatkov in ne odpira nobene oblačne baze.
 *
 * Z `--https` je javni vnos SAMO front: Next se priveže na 127.0.0.1, sicer bi
 * v LAN ostal goli HTTP tik ob obljubljenem HTTPS naslovu.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backupsDirFor, backupDatabase, drainWal, listBackups, LOCAL_DAILY_BACKUP_PREFIX } from '../src/lib/local-durability'
import { lanUrls, servingPlan } from '../src/lib/local-runtime'
import { runLocalSetup } from '../src/lib/local-setup'
import { localFrontProof, provisionFromTerminal, validTaxIdByLength } from '../src/lib/setup-claim'
import { ensureLocalTls, identityFromNetwork } from '../src/lib/local-tls'
import { startLocalHttpsFront, type HttpsFrontHandle } from '../src/lib/local-https-front'

const ROOT = process.cwd()
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
const BUILD_ID = path.join(ROOT, '.next', 'BUILD_ID')
const STANDALONE_MARKER = path.join(ROOT, '.next', 'standalone', 'server.js')

const USAGE = `Uporaba: bun run local [možnosti]

  --port <številka>        Vrata (privzeto 3000 ali PORT iz okolja)
  --https                  HTTPS fronta v LAN, Next samo na zanki (za namestitev PWA)
  --https-port <številka>  Vrata fronte (privzeto 3443)
  --data-dir <pot>         Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  --owner-email <e-pošta>  Prijavni e-poštni naslov lastnika (prvi zagon)
  --owner-pin <PIN>        PIN lastnika (prvi zagon; sicer naključen)
  --restaurant-name <ime>  Ime obrata (prvi zagon)
  --tax-id <številka>      Davčna številka obrata (SI 8 števk / HR OIB 11)
  --business-id <številka> Matična številka obrata
  --build                  Prisili ponovno gradnjo
  -h, --help               Ta pomoč
`

interface Args {
  port: number
  https: boolean
  httpsPort?: string
  dataDir?: string
  ownerEmail?: string
  ownerPin?: string
  restaurantName?: string
  taxId?: string
  businessId?: string
  forceBuild: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const rawPort = process.env.PORT || '3000'
  const args: Args = { port: Number(rawPort), https: false, forceBuild: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--build') args.forceBuild = true
    else if (a === '--https') args.https = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--port') args.port = Number(value(i++, a))
    else if (a === '--https-port') args.httpsPort = value(i++, a)
    else if (a === '--data-dir') args.dataDir = value(i++, a)
    else if (a === '--owner-email') args.ownerEmail = value(i++, a)
    else if (a === '--owner-pin') args.ownerPin = value(i++, a)
    else if (a === '--restaurant-name') args.restaurantName = value(i++, a)
    else if (a === '--tax-id') args.taxId = value(i++, a)
    else if (a === '--business-id') args.businessId = value(i++, a)
    else throw new Error(`[local] Neznana možnost: ${a}\n\n${USAGE}`)
  }
  if (args.taxId && !validTaxIdByLength(args.taxId)) {
    throw new Error(`[local] Neveljavna davčna številka (taxId): ${args.taxId}. SI mora imeti 8 števk in pravilno kontrolno števko, HR OIB 11 števk.`)
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

let httpsPort: number | undefined
if (args.httpsPort !== undefined) {
  httpsPort = Number(args.httpsPort)
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) {
    console.error('[local] --https-port mora biti celo število med 1 in 65535.')
    process.exit(2)
  }
}

const nacrt = servingPlan({ port: args.port, https: args.https, httpsPort })

if (!existsSync(NEXT_BIN)) {
  console.error('[local] Manjka Next.js. Najprej zaženite: bun install')
  process.exit(1)
}

let setup: Awaited<ReturnType<typeof runLocalSetup>>
try {
  // Kdo določi identiteto obrata: `--https` pomeni, da je odprt brskalnik in da
  // LASTNIK vidi čarovnika. Če terminal ni povedal imena ali PIN-a, jih torej ne
  // izmišljamo — sicer bi bila baza takoj zasedena in prevzem bi vrnil 409.
  const identitetaPodana =
    args.restaurantName !== undefined ||
    args.ownerEmail !== undefined ||
    args.ownerPin !== undefined ||
    args.taxId !== undefined ||
    args.businessId !== undefined
  setup = await runLocalSetup({
    dataDir: args.dataDir,
    ownerEmail: args.ownerEmail,
    ownerPin: args.ownerPin,
    restaurantName: args.restaurantName,
    taxId: args.taxId,
    businessId: args.businessId,
    allowGenerate: true,
    provisionOwner: provisionFromTerminal({ https: args.https === true, identityGiven: identitetaPodana }),
  })
} catch (err) {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

console.log(`\nRestaurantOS — lokalni profil`)
console.log(`  Podatki: ${setup.dataDir}`)
console.log(`  Baza:    ${setup.dbPath} (${setup.journalMode})`)
if (setup.setupPending) {
  console.log('  Obrat:   še ni ustanovljen — ime, davčna številka in PIN lastnika se vpišejo v brskalniku')
} else if (setup.ownerCreated) {
  console.log(`  Lastnik: ${setup.ownerEmail}`)
  if (setup.pin) console.log(`  PIN:     ${setup.pin}`)
  console.log(`  Poverilnice so v ${path.join(setup.dataDir, 'PRVIC-ZAGON.txt')}`)
} else {
  console.log(`  Lastnik: ${setup.ownerEmail} (obstoječi račun)`)
}
// Brez fronte čarovnik ne more delovati (prevzem zavrne dokaz, §A4), zato mora
// launcher povedati, kaj manjka — sicer bi obrat ostal prazen in tiho.
if (setup.setupPending && args.https !== true) {
  console.log('  ⚠ Ustavitev: brez `--https` čarovnik /setup ne more prevzeti namestitve.')
  console.log('    Zaženi `bun run local --https` ALI dodaj --restaurant-name in --owner-pin.')
}

const backupsDir = backupsDirFor(setup.dbPath)
try {
  const kopija = await backupDatabase(setup.dbPath, backupsDir)
  console.log(
    kopija.created
      ? `  Kopija:  ${path.basename(kopija.file)} (integritetni pregled ok)`
      : `  Kopija:  ${path.basename(kopija.file)} je že današnja (integritetni pregled ok)`,
  )
} catch (err) {
  // Obrat mora odpreti tudi, če kopija ni uspela — a brez varnostne kopije ne
  // sme deliti tedne, zato je opozorilo izpostavljeno in se ob vsakem zagonu ponovi.
  console.error(`\n⚠ Dnevne kopije NI: ${(err as Error).message}`)
  console.error('  Podatki so varni, a brez kopije. Preverite prostor na disku in pravice do mape backups.')
}

// Dolgo stoječ računalnik v obratu ne sme ostati brez današnje kopije, ker je
// bil zagnan včeraj. Funkcija sama shrani največ eno kopijo na dan (UTC).
const SEJANJE_KOPIJE_MS = 6 * 60 * 60 * 1000
const kopijaUra = setInterval(() => {
  void backupDatabase(setup.dbPath, backupsDir).catch((err) => console.error(`⚠ Dnevna kopija ni uspela: ${(err as Error).message}`))
}, SEJANJE_KOPIJE_MS)
// Ura ne sme držati procesa živega — strežnik ga že.
kopijaUra.unref()

console.log(`  Kopij v ${backupsDir}: ${listBackups(backupsDir, LOCAL_DAILY_BACKUP_PREFIX).length} dnevnih`)

const needsBuild = args.forceBuild || !existsSync(BUILD_ID) || existsSync(STANDALONE_MARKER)
if (needsBuild) {
  console.log('\n[local] Gradim aplikacijo — prvi zagon traja nekaj minut ...')
  const build = spawnSync(process.execPath, [NEXT_BIN, 'build'], { cwd: ROOT, env: process.env, stdio: 'inherit' })
  if (build.status !== 0) {
    console.error(`\n✖ Gradnja ni uspela (izhod ${build.status ?? '?'}).`)
    process.exit(build.status ?? 1)
  }
}

let front: HttpsFrontHandle | null = null
if (nacrt.frontPort > 0) {
  const identiteta = identityFromNetwork({ hostname: os.hostname(), interfaces: os.networkInterfaces() })
  const tls = ensureLocalTls({ dataDir: setup.dataDir, identity: identiteta, nowMs: Date.now() })
  if (!tls.ok) {
    console.error(`\n✖ HTTPS certifikata ni bilo mogoče pripraviti (${tls.step ?? '?'}): ${tls.message}`)
    console.error('  Obrat lahko zaženete brez TLS: izpustite --https.')
    process.exit(1)
  }
  try {
    front = await startLocalHttpsFront({
      keyPem: readFileSync(tls.paths.leafKey, 'utf8'),
      certPem: readFileSync(tls.paths.leafCert, 'utf8'),
      targetPort: nacrt.nextPort,
      httpsPort: nacrt.frontPort,
      // Dokaz se računa iz ISTEGA vira kot pričakovanje rute (`APP_SECRET`, ki ga
      // `runLocalSetup` že zapiše v okolje); brez njega prevzem namestitve javi 403.
      frontProof: localFrontProof(process.env.APP_SECRET ?? ''),
    })
  } catch (err) {
    console.error(`\n✖ HTTPS front na vratih ${nacrt.frontPort} se ni mogel zagnati: ${(err as Error).message}`)
    console.error('  Vrata so morda zasedena — izberite druga z --https-port <številka>.')
    process.exit(1)
  }
  console.log(`  TLS:       ${tls.message}`)
  console.log(`  CA za zaupanje: ${tls.paths.caCert}`)
}

console.log('\nRestaurantOS teče:')
if (front) {
  console.log(`  ta računalnik: ${nacrt.scheme}://localhost:${front.port}`)
  for (const url of lanUrls(front.port, undefined, nacrt.scheme)) console.log(`  v omrežju:     ${url}`)
  console.log(`  čarovnik:      ${nacrt.scheme}://localhost:${front.port}/setup (samo ta računalnik)`)
  console.log(`  (Next sam je zaprt na ${nacrt.nextHost}:${nacrt.nextPort} — do njega vodi samo front)`)
} else {
  console.log(`  ta računalnik: http://localhost:${args.port}`)
  for (const url of lanUrls(args.port)) console.log(`  v omrežju:     ${url}`)
}
console.log('\n  Ustavi s Ctrl+C. Demo podatki niso naloženi.\n')

const child = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(nacrt.nextPort), '-H', nacrt.nextHost], {
  cwd: ROOT,
  // Next bere in -H in HOSTNAME; oba morata biti usklajena, sicer bi HOSTNAME 0.0.0.0 iz
  // localEnv() odprl goli HTTP tik ob fronti.
  env: { ...process.env, HOSTNAME: nacrt.nextHost },
  stdio: 'inherit',
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void front?.close()
    child.kill(signal)
  })
}

child.on('error', (err) => {
  console.error(`[local] Aplikacije ni bilo mogoče zagnati: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  // Front mora zapreti skupaj z virom: sicer bi brskalniku ostala živa TLS seja
  // na praznih vratih in tablica ne bi vedela, da obrat ni več dosegljiv.
  void front?.close()
  // Čist postanek mora počistiti rep: izmerjeno `-wal` po izhodu procesa ostane
  // poln, naslednja obnova pa bi zaradi tega javila, da aplikacija še teče.
  drainWal(setup.dbPath)
  if (signal) process.exit(0)
  process.exit(code ?? 0)
})
