/**
 * v1.180.0 — R3: `POST /api/setup/claim` — prevzem prve namestitve iz brskalnika.
 *
 * RUTA JE NAMENOMA JAVNA (brez seje): poziva se na stroju, kjer še ni nobenega
 * uporabnika — seja torej ne more obstajati. Varovalka ni prijava ampak petpogojna
 * ograja iz `setup-claim.ts` (lokalni profil + dokaz fronte + naslov v zanki +
 * limit + prazna baza). Izrecno je vpisana v register javnih endpointov
 * (`tests/route-coverage.test.ts`), da naslednji pregled rute ne razglasi za
 * pozabljeno.
 *
 * Pot VEDNO zavrne generiranje Prisma odjemalca (`allowGenerate: false`): aplikacija
 * ob prevzemu že teče, odjemalec je torej nujno sqlite — generiranje sredi zahteve
 * bi pisalo v `node_modules` in podrlo trenutni proces.
 *
 * `claimWith` je šiv za teste: odvisnosti (število zaposlenih, profil, limit,
 * zapis) prejme kot argument, zato lahko vsako vejo ograje preizkusimo brez baze.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { timingSafeEqualStr } from '@/lib/auth'
import { runLocalSetup } from '@/lib/local-setup'
import { rateLimitBool } from '@/lib/rate-limit'
import { runtimeMode } from '@/lib/runtime-info'
import {
  claimDecision,
  CLIENT_IP_HEADER,
  credentialsSheet,
  FRONT_PROOF_HEADER,
  localFrontProof,
  parseClaim,
  type ClaimDecision,
} from '@/lib/setup-claim'

export interface ClaimSetupCall {
  restaurantName: string
  ownerEmail: string
  ownerPin: string
  taxId: string
  businessId: string
  allowGenerate: false
}

/** Only the fields this route reads — `runLocalSetup` vrne več. */
export interface ClaimSetupResult {
  dataDir: string
  dbPath: string
  ownerEmail: string
}

export interface ClaimDeps {
  employees: () => Promise<number>
  isLocalProfile: () => boolean
  rateLimit: (key: string) => boolean
  complete: (opts: ClaimSetupCall) => Promise<ClaimSetupResult>
}

function zavrnitev(odlocba: ClaimDecision): Response {
  return NextResponse.json({ ok: false, razlog: odlocba.razlog, error: odlocba.sporocilo }, { status: odlocba.status })
}

export async function claimWith(deps: ClaimDeps, req: Request, expectedProof: string | null): Promise<Response> {
  let telo: unknown
  try {
    telo = await req.json()
  } catch {
    return NextResponse.json({ ok: false, errors: { telo: 'Zahteva ni veljaven JSON.' } }, { status: 400 })
  }

  const vhod = parseClaim(telo)
  if (!vhod.ok || !vhod.value) {
    return NextResponse.json({ ok: false, errors: vhod.errors }, { status: 400 })
  }
  const v = vhod.value

  const dokaz = req.headers.get(FRONT_PROOF_HEADER) ?? ''
  const frontTrusted = expectedProof !== null && dokaz.length > 0 && timingSafeEqualStr(dokaz, expectedProof)
  const clientIp = (req.headers.get(CLIENT_IP_HEADER) ?? '').split(',')[0]?.trim() ?? ''

  // Zaporedje: najprej pogoji brez stranskih učinkov — tuji klient ne sme izzvati
  // poizvedbe, iz razlike med kodami pa ne more razbrati, ali je namestitev že prevzeta.
  const stanje = { localProfile: deps.isLocalProfile(), employees: 0, clientIp, frontTrusted, rateAllowed: true }
  const ograja = claimDecision(stanje)
  if (!ograja.allowed) return zavrnitev(ograja)

  const rateAllowed = deps.rateLimit(`setup-claim:${clientIp}`)
  const zaposleni = rateAllowed ? await deps.employees() : 0
  const odlocba = claimDecision({ ...stanje, employees: zaposleni, rateAllowed })
  if (!odlocba.allowed) return zavrnitev(odlocba)

  let rezultat: ClaimSetupResult
  try {
    rezultat = await deps.complete({
      restaurantName: v.restaurantName,
      ownerEmail: v.email,
      ownerPin: v.pin,
      taxId: v.taxId,
      businessId: v.businessId,
      allowGenerate: false,
    })
  } catch (err) {
    // Notranjost (Pot, Prisma, SQLite kodi) ostane v strežniškem logu: odgovor
    // mora povedati, KAJ naj lastnik stori, ne kaj se je zlomilo v kodi.
    console.error(`[setup/claim] prevzem namestitve ni uspel: ${(err as Error).message}`)
    return NextResponse.json(
      {
        ok: false,
        error: 'Namestitev v brskalniku ni uspela. Preveri, da ima uporabnik pravice do podatkovne mape, in poskusi znova.',
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    restaurantName: v.restaurantName,
    ownerEmail: rezultat.ownerEmail,
    dataDir: rezultat.dataDir,
    // Zaslonska sled je seznam ZA PRIJAVA: obrat, davčna številka, pot do baze.
    // Matična številka tja ne spada (je podatek registra, ne poverilnica) — je
    // zapisana v bazi in v datoteki PRVIC-ZAGON.txt.
    sheet: credentialsSheet({
      restaurantName: v.restaurantName,
      ownerEmail: rezultat.ownerEmail,
      dataDir: rezultat.dataDir,
      dbPath: rezultat.dbPath,
      taxId: v.taxId,
    }),
  })
}

export async function POST(req: Request): Promise<Response> {
  const appSecret = (process.env.APP_SECRET ?? '').trim()
  const deps: ClaimDeps = {
    employees: () => db.employee.count(),
    isLocalProfile: () => runtimeMode() === 'local',
    rateLimit: (key) => rateLimitBool(key, 5, 60_000),
    complete: (opts) => runLocalSetup(opts),
  }
  return claimWith(deps, req, appSecret ? localFrontProof(appSecret) : null)
}
