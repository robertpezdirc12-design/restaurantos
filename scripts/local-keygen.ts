#!/usr/bin/env bun
/**
 * v1.217.0 — R4b del 2: GENERATOR PODPISNEGA KLJUČA (PRD §8 R4b).
 *
 * Enkratno dejanje lastnika NA GRADBENI NAPIRAVI: ustvari par Ed25519
 * (seme 32 B + javni ključ 32 B, oba base64). ZASEBNI ključ ostane na napravi,
 * ki gradi pakete (nikoli v git — .gitignore pokriva signing-keys/); JAVNI
 * ključ gre na vsako namestitev (v podatkovno mapo kot signing.pub ali okolje
 * RESTAURANTOS_SIGNING_PUBKEY).
 *
 * Rotacija ključa NI tehnična, ampak lastnikova odločitev: namestitve, ki
 * zaupajo staremu javnemu ključu, bodo pakete z novim ključem ZAVRGLE
 * (pošteno — natančno takrat, ko preverba res kaj ščiti). Zato keygen
 * obstoječega ključa NE prepiše; novo mapo ali premik starega naredi lastnik.
 *
 * Uporaba: bun run local:keygen [--out <mapa>]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  SIGNING_KEYS_DIR,
  SIGNING_KEY_FILE,
  SIGNING_PUB_FILE,
  generateSigningKeyPair,
  keyFingerprint,
} from '../src/lib/update-package'

const USAGE = `Uporaba: bun run local:keygen [možnosti]

  --out <mapa>   Ciljna mapa (privzeto ./${SIGNING_KEYS_DIR}/ v korenu repozitorija).
                 Nastaneta ${SIGNING_KEY_FILE} (0600, ZASEBNI — ostane tu) in
                 ${SIGNING_PUB_FILE} (javni — kopiraj na namestitve).
  -h, --help     Ta pomoč

Javni ključ namesti na vsako namestitev: kopiraj ${SIGNING_PUB_FILE} v njeno
podatkovno mapo (ime datoteke ohrani) ali ga nastavi v okolje
RESTAURANTOS_SIGNING_PUBKEY.
`

interface Args {
  out?: string
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') args.help = true
    else if (a === '--out') args.out = value(i++, a)
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

const outDir = path.resolve(args.out ?? SIGNING_KEYS_DIR)
const keyFile = path.join(outDir, SIGNING_KEY_FILE)
const pubFile = path.join(outDir, SIGNING_PUB_FILE)

if (existsSync(keyFile) || existsSync(pubFile)) {
  console.error(
    `[local] V mapi ${outDir} ključ že obstaja in ga ne prepišem. Rotacija ključa pomeni, da bodo vse namestitve s starim javnim ključem nove pakete zavrngle — če jo res želiš, premakni mapo stran in ponovi ukaz. Nobena datoteka ni bila spremenjena.`,
  )
  process.exit(1)
}

const { seedB64, pubB64, publicKey } = generateSigningKeyPair()

mkdirSync(outDir, { recursive: true, mode: 0o700 })
writeFileSync(keyFile, `${seedB64}\n`, { mode: 0o600 })
writeFileSync(pubFile, `${pubB64}\n`, { mode: 0o644 })

console.log(`Podpisni ključ Ed25519 je ustvarjen.
  zasebni (ostane TU, na gradbeni napravi): ${keyFile}
  javni   (kopiraj na vsako namestitev):     ${pubFile}
  namig ključa (prvih 8 bajtov sha256):      ${keyFingerprint(publicKey)}
Javni ključ na namestitev prenesi kot <podatkovna mapa>/signing.pub ali prek
okolja RESTAURANTOS_SIGNING_PUBKEY. Mapa ${outDir} je v .gitignore — ključ
nikoli ne shranjuj v repozitorij.`)
