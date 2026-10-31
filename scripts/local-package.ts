#!/usr/bin/env bun
/**
 * v1.217.0 — R4b del 2: IZGRADNJA IN PODPIS NADGRADNEGA PAKETA (PRD §8 R4b).
 *
 * Teče NA GRADBENI NAPIRAVI (tam, kjer je izvorna koda in ZASEBNI ključ):
 * zbere vir (ogledalo Dockerfile COPY seznama + deploy/), ga zgosti, podpiše z
 * Ed25519 in zapiše restaurantos-<različica>.rospkg. Po zapisu se paket
 * NAJPREJ prebere z diska in preveri (R5a disciplina: šifriranje, ki ga ni
 * mogoče obrniti, ni varnostna kopija — podpis, ki ga po zapisu nismo prebrali
 * in preverili, ni podpis) — šele nato se začasno ime preimenuje v končno.
 *
 * ZASEBNI ključ NIKOLI ne gre v argv (seznam procesov + zgodovina lupine):
 *  1. --key-file <pot> (privzeto ./signing-keys/signing.key iz local:keygen),
 *  2. okolje RESTAURANTOS_SIGNING_KEY (base64 semena).
 *
 * Uporaba: bun run local:package [--out <mapa>] [--key-file <pot>] [--json]
 */
import { createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { APP_VERSION } from '../src/lib/version'
import {
  DIST_PACKAGES_DIR,
  SIGNING_KEYS_DIR,
  SIGNING_KEY_FILE,
  buildUpdatePackage,
  collectUpdateSource,
  readKeyFile,
  readSigningKeyEnv,
  parseSigningSeed,
  updatePackageNameFor,
  verifyUpdatePackage,
} from '../src/lib/update-package'

const USAGE = `Uporaba: bun run local:package [možnosti]

  --out <mapa>      Izhodna mapa (privzeto ./${DIST_PACKAGES_DIR}/).
  --key-file <pot>  Datoteka zasebnega ključa (base64 semena). Privzeto
                    ./${SIGNING_KEYS_DIR}/${SIGNING_KEY_FILE} (iz local:keygen).
                    Drugi vir: okolje RESTAURANTOS_SIGNING_KEY.
  --json            Strojno berljiv izpis (en sam JSON na stdout).
  -h, --help        Ta pomoč

Paketi se gradijo IZ KORENA REPOZITORIJA (mapa z package.json in src/).
`

interface Args {
  out?: string
  keyFile?: string
  json: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { json: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--out') args.out = value(i++, a)
    else if (a === '--key-file') args.keyFile = value(i++, a)
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

// Ključ: datoteka > okolje > privzeta pot keygena. Nikoli argv.
let keyRaw: string | null = null
let keyVir: string
if (args.keyFile) {
  keyRaw = readKeyFile(args.keyFile)
  keyVir = args.keyFile
} else {
  const izOkolja = readSigningKeyEnv()
  if (izOkolja !== null) {
    keyRaw = izOkolja
    keyVir = 'okolje RESTAURANTOS_SIGNING_KEY'
  } else {
    const privzeta = path.join(SIGNING_KEYS_DIR, SIGNING_KEY_FILE)
    if (!existsSync(privzeta)) {
      console.error(
        `[local] Zasebnega ključa ni: podaj --key-file <pot>, nastavi RESTAURANTOS_SIGNING_KEY ali najprej poženi bun run local:keygen. Paketa ni bilo mogoče zgraditi.`,
      )
      process.exit(1)
    }
    keyRaw = readKeyFile(privzeta)
    keyVir = privzeta
  }
}
const privateKey = parseSigningSeed(keyRaw)
if (!privateKey) {
  console.error(`[local] Ključ iz vira (${keyVir}) ni veljavno Ed25519 seme (base64, 32 bajtov). Paketa ni bilo mogoče zgraditi.`)
  process.exit(1)
}

const root = process.cwd()
try {
  const files = collectUpdateSource(root)
  const zgrajen = buildUpdatePackage({ files, version: APP_VERSION, privateKey })

  const outDir = path.resolve(args.out ?? DIST_PACKAGES_DIR)
  const ime = updatePackageNameFor(APP_VERSION)
  const koncna = path.join(outDir, ime)
  const zacasna = path.join(outDir, `.delni-${ime}`)
  if (existsSync(koncna)) {
    console.error(`[local] Paket ${koncna} že obstaja in ga ne prepišem. Paket NI bil ponovno zapisan.`)
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(zacasna, zgrajen.buffer, { mode: 0o644 })

  // Roundtrip čez disk: preberi, preveri podpis z javnim ključem, ki ga
  // izpeljemo iz istega zasebnega, in sprehodi manifest. To je edini pošteni
  // trenutek za "✔" — vse prej je bila samo namerevanje.
  const nazaj = readFileSync(zacasna)
  const preverjen = verifyUpdatePackage(nazaj, createPublicKey(privateKey))
  if (preverjen.header.version !== APP_VERSION || preverjen.header.fileCount !== zgrajen.header.fileCount) {
    throw new Error('[local] Paket se po zapisu na disk ne ujema z gradnjo; ni bil shranjen.')
  }
  renameSync(zacasna, koncna)

  if (args.json) {
    console.log(
      JSON.stringify({
        ok: true,
        file: koncna,
        version: APP_VERSION,
        files: preverjen.header.fileCount,
        contentBytes: preverjen.header.contentBytes,
        packageBytes: preverjen.totalBytes,
        sha256: preverjen.sha256,
        keyHint: preverjen.header.keyHint,
        createdAt: preverjen.header.createdAt,
      }),
    )
  } else {
    console.log(`Nadgradni paket ${preverjen.header.version} je podpisan in preverjen.
  datoteka:   ${koncna}
  datotek:    ${preverjen.header.fileCount}
  vsebina:    ${preverjen.header.contentBytes.toLocaleString('sl-SI')} B (zgostitev ${preverjen.totalBytes.toLocaleString('sl-SI')} B)
  sha256:     ${preverjen.sha256}
  namig ključa: ${preverjen.header.keyHint}
Preveri ga na namestitvi: bun run local:package-verify <pot> (javni ključ iz
<podatkovna mapa>/signing.pub ali RESTAURANTOS_SIGNING_PUBKEY).`)
  }
} catch (err) {
  const sporočilo = (err as Error).message
  console.error(sporočilo.startsWith('[local]') ? sporočilo : `[local] Paketa ni bilo mogoče zgraditi (${sporočilo}).`)
  process.exit(1)
}
