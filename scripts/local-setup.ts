#!/usr/bin/env bun
/**
 * v1.165.0 — CLI za pripravo lokalne baze (PRD R1).
 * v1.180.0 — R3: identiteta obrata dobi svoji zastavici; veljavnost davčne
 *            številke se preveri PRED prvom posegom v bazo (enako pravilo kot v
 *            brskalniku — `parseClaim`).
 * Uporaba: bun run local:setup [--data-dir pot] [--owner-email e-pošta]
 *          [--owner-pin 123456] [--restaurant-name "Ime"] [--tax-id 8števk]
 *          [--business-id "SI-ZN-1234"] [--json] [--no-generate]
 */
import { runLocalSetup } from '../src/lib/local-setup'
import { validTaxIdByLength } from '../src/lib/setup-claim'

interface Args {
  dataDir?: string
  ownerEmail?: string
  ownerPin?: string
  restaurantName?: string
  taxId?: string
  businessId?: string
  json: boolean
  noGenerate: boolean
  waitForBrowser: boolean
  help: boolean
}

const USAGE = `Uporaba: bun run local:setup [možnosti]

  --data-dir <pot>        Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  --owner-email <e-pošta> Prijavni e-poštni naslov lastnika
  --owner-pin <PIN>       PIN lastnika (4–8 števk; sicer se ustvari naključen)
  --restaurant-name <ime> Ime obrata za prvo lokacijo
  --tax-id <številka>     Davčna številka obrata (SI 8 števk, HR OIB 11 števk)
  --business-id <številka> Matična številka obrata
  --json                  Strojno berljiv izpis (en sam JSON na stdout)
  --no-generate           Ne regeneriraj Prisma odjemalca (mora biti že sqlite)
  --wait-for-browser      Pripravi bazo, identiteto pa prepusti čarovniku /setup
  -h, --help              Ta pomoč
`

function parse(argv: string[]): Args {
  const args: Args = { json: false, noGenerate: false, waitForBrowser: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--no-generate') args.noGenerate = true
    else if (a === '--wait-for-browser') args.waitForBrowser = true
    else if (a === '-h' || a === '--help') args.help = true
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

try {
  const result = await runLocalSetup({
    dataDir: args.dataDir,
    ownerEmail: args.ownerEmail,
    ownerPin: args.ownerPin,
    restaurantName: args.restaurantName,
    taxId: args.taxId,
    businessId: args.businessId,
    allowGenerate: !args.noGenerate,
    provisionOwner: !args.waitForBrowser,
  })

  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...result }))
  } else if (result.setupPending) {
    console.log(`\n✔ Podatkovna mapa: ${result.dataDir}`)
    console.log(`✔ Baza pripravljena (${result.dbPath}) — obrat še NIMA imena, davčne številke ne lastnika.`)
    console.log('  Identiteto določi v brskalniku: odpri https://localhost:3443/setup, ko zaženeš')
    console.log('  `bun run local --https`. Do takrat tu ne piše ničesar, da prevzem ne naleti na 409.')
  } else {
    console.log(`\n✔ Podatkovna mapa: ${result.dataDir}`)
    console.log(`✔ Baza: ${result.dbPath}`)
    if (result.backupCreated) console.log(`✔ Kopija pred posodobitvijo: ${result.backupCreated}`)
    if (result.ownerCreated) {
      console.log(`✔ Lastnik: ${result.ownerEmail}`)
      if (result.pin) console.log(`  PIN: ${result.pin}`)
      console.log(`  Poverilnice so shranjene v ${result.dataDir}\\PRVIC-ZAGON.txt`)
    } else {
      console.log(`✔ Lastnik že obstaja (${result.existingEmployees} zaposlenih) — brez sprememb.`)
    }
    console.log('✔ Demo podatki niso naloženi.')
    console.log('\nZa zagon: bun run local\n')
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (args.json) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error(`\n✖ ${message}\n`)
  process.exit(1)
}
