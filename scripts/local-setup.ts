#!/usr/bin/env bun
/**
 * v1.165.0 — CLI za pripravo lokalne baze (PRD R1).
 * Uporaba: bun run local:setup [--data-dir pot] [--owner-email e-pošta]
 *          [--owner-pin 123456] [--restaurant-name "Ime"] [--json] [--no-generate]
 */
import { runLocalSetup } from '../src/lib/local-setup'

interface Args {
  dataDir?: string
  ownerEmail?: string
  ownerPin?: string
  restaurantName?: string
  json: boolean
  noGenerate: boolean
  help: boolean
}

const USAGE = `Uporaba: bun run local:setup [možnosti]

  --data-dir <pot>        Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  --owner-email <e-pošta> Prijavni e-poštni naslov lastnika
  --owner-pin <PIN>       PIN lastnika (4–8 števk; sicer se ustvari naključen)
  --restaurant-name <ime> Ime obrata za prvo lokacijo
  --json                  Strojno berljiv izpis (en sam JSON na stdout)
  --no-generate           Ne regeneriraj Prisma odjemalca (mora biti že sqlite)
  -h, --help              Ta pomoč
`

function parse(argv: string[]): Args {
  const args: Args = { json: false, noGenerate: false, help: false }
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`[local] Možnost ${flag} zahteva vrednost.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--no-generate') args.noGenerate = true
    else if (a === '-h' || a === '--help') args.help = true
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

try {
  const result = await runLocalSetup({
    dataDir: args.dataDir,
    ownerEmail: args.ownerEmail,
    ownerPin: args.ownerPin,
    restaurantName: args.restaurantName,
    allowGenerate: !args.noGenerate,
  })

  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...result }))
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
