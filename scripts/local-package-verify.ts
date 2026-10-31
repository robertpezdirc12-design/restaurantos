#!/usr/bin/env bun
/**
 * v1.217.0 — R4b del 2: PREVERBA NADGRADNEGA PAKETA (PRD §8 R4b).
 *
 * Teče NA NAMESTITVI (računalo, ki bo paket sprejelo): prebere paket, preveri
 * podpis Ed25519 z javnim ključem in sprehodi manifest (vsaka datoteka
 * razširjena in primerjana po sha256). Disk se NE dotakne — preverba je
 * čisto branje, zato je varno jo pognati kadar koli.
 *
 * Vir javnega ključa (po prednosti):
 *  1. --pub <pot>   (datoteka z base64 javnim ključem, npr. signing.pub),
 *  2. okolje RESTAURANTOS_SIGNING_PUBKEY,
 *  3. <podatkovna mapa>/signing.pub (--data-dir izbere mapo).
 *
 * --inspect pogleda glavo BREZ ključa (triža ob prenosu) — izpis vedno
 * povedano pošteno: "ni preverjen" ni "preverjen".
 *
 * Uporaba: bun run local:package-verify <pot> [--pub <pot>] [--data-dir <mapa>] [--inspect] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { databasePathFor, resolveDataDir } from '../src/lib/local-runtime'
import {
  SIGNING_PUB_FILE,
  inspectUpdatePackage,
  keyFingerprint,
  parseSigningPublicKey,
  readKeyFile,
  readSigningPubEnv,
  verifyUpdatePackage,
} from '../src/lib/update-package'

const USAGE = `Uporaba: bun run local:package-verify <pot-paketa> [možnosti]

  --pub <pot>       Datoteka z javnim ključem (base64). Drugi viri: okolje
                    RESTAURANTOS_SIGNING_PUBKEY, <podatkovna mapa>/signing.pub.
  --data-dir <mapa> Podatkovna mapa namestitve (privzeto profilna mapa).
  --inspect         Samo glava, BREZ preverbe podpisa (izpis javno pove, da
                    ni preverjen).
  --json            Strojno berljiv izpis.
  -h, --help        Ta pomoč

Izhod: 0 = podpis in vse datoteke preverjene; 1 = zavrnjeno (razlog v izpisu);
2 = napaka v uporabi.
`

interface Args {
  pkg?: string
  pub?: string
  dataDir?: string
  inspect: boolean
  json: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { inspect: false, json: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--inspect') args.inspect = true
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--pub') args.pub = value(i++, a)
    else if (a === '--data-dir') args.dataDir = value(i++, a)
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
  console.error(`[local] Paketa ${args.pkg} ni. Preverjanje se ni začelo.`)
  process.exit(1)
}

const buffer = readFileSync(args.pkg)

// ── način --inspect: samo glava, BREZ ključa ─────────────────────────────────
if (args.inspect) {
  try {
    const header = inspectUpdatePackage(buffer)
    if (args.json) {
      console.log(JSON.stringify({ ok: true, inspected: true, verified: false, version: header.version, createdAt: header.createdAt, fileCount: header.fileCount, contentBytes: header.contentBytes, keyHint: header.keyHint }))
    } else {
      console.log(`Paket (SAMO PREGLED, podpis NI preverjen):
  različica:  ${header.version}
  nastanek:   ${header.createdAt}
  datotek:    ${header.fileCount}
  vsebina:    ${header.contentBytes.toLocaleString('sl-SI')} B
  namig ključa: ${header.keyHint}
Za preverbo podpisa podaj javni ključ (--pub, okolje ali signing.pub v podatkovni mapi).`)
    }
    process.exit(0)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}

// ── polna preverba: javni ključ ──────────────────────────────────────────────
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
        `[local] Javnega ključa ni: podaj --pub <pot>, nastavi RESTAURANTOS_SIGNING_PUBKEY ali kopiraj signing.pub v ${dataDir}. Paket NI bil preverjen (in ne bo — neznan ključ ni zavrnjen podpis, je neznanost).`,
      )
      process.exit(1)
    }
    pubRaw = readKeyFile(privzeta)
    virKljuca = privzeta
  }
}
const publicKey = parseSigningPublicKey(pubRaw)
if (!publicKey) {
  console.error(`[local] Javni ključ iz vira (${virKljuca}) ni veljaven (base64, 32 bajtov). Paket NI bil preverjen.`)
  process.exit(1)
}

try {
  const preverjen = verifyUpdatePackage(buffer, publicKey)
  if (args.json) {
    console.log(JSON.stringify({ ok: true, verified: true, version: preverjen.header.version, createdAt: preverjen.header.createdAt, fileCount: preverjen.header.fileCount, contentBytes: preverjen.header.contentBytes, packageBytes: preverjen.totalBytes, sha256: preverjen.sha256, keyHint: preverjen.header.keyHint }))
  } else {
    console.log(`Paket je PREVERJEN (podpis Ed25519 + vse ${preverjen.header.fileCount} datotek po sha256):
  različica:  ${preverjen.header.version}
  nastanek:   ${preverjen.header.createdAt}
  vsebina:    ${preverjen.header.contentBytes.toLocaleString('sl-SI')} B (paket ${preverjen.totalBytes.toLocaleString('sl-SI')} B)
  sha256:     ${preverjen.sha256}
  namig ključa: ${preverjen.header.keyHint} (kraj: ${keyFingerprint(publicKey)})
Nadgradnja: bun run local:package-apply ${args.pkg}${args.dataDir ? ` --data-dir ${args.dataDir}` : ''}`)
  }
  process.exit(0)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
