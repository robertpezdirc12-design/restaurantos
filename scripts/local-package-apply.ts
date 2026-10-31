#!/usr/bin/env bun
/**
 * v1.217.0 — R4b del 2: NADGRADNJA NAMESTITVE IZ PODPISANEGA PAKETA (PRD §8 R4b).
 *
 * Teče NA NAMESTITVI, v korenu namestitve (mapa z package.json in src/).
 * Vrstni red varovalk (podroben seznam v src/lib/update-package.ts):
 *   1. podpis + manifest paketa (brez veljavnega podpisa se disk ne dotakne),
 *   2. vrata različice — enaka/starejša se brez --force zavrne (vračanje kode
 *      je nalašč dejanje),
 *   3. aplikacija mora stati (poln -wal pomeni, da nekdo piše v bazo),
 *   4. varnostna kopija ZAMENJANIH datotek (.ros-update-backup-*, zadnje 3),
 *   5. po zapisu se vsaka datoteka na disku ponovno prežge,
 *   6. napaka sredi = VSE ALI NIČ (razveljavitev iz kopije).
 * Datoteke, ki jih paket ne nosi, se ne dotakne. Baza ostane pri miru —
 * uskladitev sheme je naslednji korak recepta in ima SVOJO varnostno kopijo.
 *
 * Po zamenjani kodi izpiše recept (install → migrate → build), ki je isti kot
 * pri git pull (LOKALNI-ZAGON §7) — paket zamenja VIR, ne postopka.
 *
 * Uporaba: bun run local:package-apply <pot-paketa> [--data-dir <mapa>] [--pub <pot>] [--force] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { databasePathFor, resolveDataDir } from '../src/lib/local-runtime'
import {
  SIGNING_PUB_FILE,
  applyUpdatePackage,
  parseSigningPublicKey,
  readKeyFile,
  readSigningPubEnv,
} from '../src/lib/update-package'

const USAGE = `Uporaba: bun run local:package-apply <pot-paketa> [možnosti]

  --data-dir <mapa> Podatkovna mapa namestitve (privzeto profilna mapa) — tu
                    se išče signing.pub in tu je baza za varovalko tečeče
                    aplikacije.
  --pub <pot>       Datoteka javnega ključa (preseže podatkovno mapo/okolje).
  --force           Dovoli tudi enako/starejšo različico (vračanje kode).
  --json            Strojno berljiv izpis.
  -h, --help        Ta pomoč

Izhod: 0 = koda zamenjana; 1 = zavrnjeno (razlog v izpisu); 2 = napaka v uporabi.
`

interface Args {
  pkg?: string
  dataDir?: string
  pub?: string
  force: boolean
  json: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { force: false, json: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force') args.force = true
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--data-dir') args.dataDir = value(i++, a)
    else if (a === '--pub') args.pub = value(i++, a)
    else if (!args.pkg && !a.startsWith('--')) args.pkg = a
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
if (!args.pkg) {
  console.error(`[local] Podaj pot do paketa (restaurantos-*.rospkg).\n\n${USAGE}`)
  process.exit(2)
}
if (!existsSync(args.pkg)) {
  console.error(`[local] Paketa ${args.pkg} ni. Nadgradnja se ni začela in namestitev ni bila spremenjena.`)
  process.exit(1)
}

// Javni ključ: --pub > okolje > <podatkovna mapa>/signing.pub.
let pubRaw: string | null = null
let virKljuca: string
if (args.pub) {
  pubRaw = readKeyFile(args.pub)
  virKljuca = args.pub
} else {
  const izOkolja = readSigningPubEnv()
  if (izOkolja !== null) {
    pubRaw = izOkolja
    virKljuca = 'okolje RESTAURANTOS_SIGNING_PUBKEY'
  } else {
    const dataDir = args.dataDir ? resolveDataDir({ env: { RESTAURANTOS_DATA_DIR: args.dataDir } }) : resolveDataDir()
    const privzeta = path.join(dataDir, SIGNING_PUB_FILE)
    if (!existsSync(privzeta)) {
      console.error(
        `[local] Javnega ključa ni: podaj --pub <pot>, nastavi RESTAURANTOS_SIGNING_PUBKEY ali kopiraj signing.pub v ${dataDir}. Nadgradnja se ni začela in namestitev ni bila spremenjena.`,
      )
      process.exit(1)
    }
    pubRaw = readKeyFile(privzeta)
    virKljuca = privzeta
  }
}
const publicKey = parseSigningPublicKey(pubRaw)
if (!publicKey) {
  console.error(`[local] Javni ključ iz vira (${virKljuca}) ni veljaven (base64, 32 bajtov). Nadgradnja se ni začela in namestitev ni bila spremenjena.`)
  process.exit(1)
}

const dataDir = args.dataDir ? resolveDataDir({ env: { RESTAURANTOS_DATA_DIR: args.dataDir } }) : resolveDataDir()
const dbPath = databasePathFor(dataDir)
const buffer = readFileSync(args.pkg)

try {
  const rezultat = applyUpdatePackage({
    buffer,
    root: process.cwd(),
    dbPath,
    publicKey,
    force: args.force,
  })
  if (args.json) {
    console.log(
      JSON.stringify({
        ok: true,
        from: rezultat.previousVersion,
        to: rezultat.header.version,
        replaced: rezultat.replaced,
        created: rezultat.created,
        backupDir: rezultat.backupDir,
        pruned: rezultat.pruned.length,
      }),
    )
  } else {
    console.log(`Koda je zamenjana: ${rezultat.previousVersion} → ${rezultat.header.version}
  zamenjanih datotek: ${rezultat.replaced} · novih: ${rezultat.created}
  stara koda:          ${rezultat.backupDir}${rezultat.pruned.length > 0 ? ` (počiščenih starih kopij: ${rezultat.pruned.length})` : ''}

DOKONČAJ NADGRADNJO (isti recept kot pri git pull, LOKALNI-ZAGON §7):
${rezultat.recipe.map((r) => `  ${r}`).join('\n')}
Zatem: bun run local --build že vsebuje prisilno gradnjo — brez nje bi strežnik
postregel STAR grad (izmerjena past v1.169.0).`)
  }
  process.exit(0)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
