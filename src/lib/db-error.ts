/**
 * Issue #76 — varna klasifikacija podatkovnih napak (server-only).
 *
 * Problem: produkcija je za /api/auth/locations in /api/auth/demo-login
 * vračala HTTP 500 s PRAZNIM telesom; /api/health je javljal le
 * `database: "disconnected"`, ne da bi kdorkoli videl VZROK (izjema je bila
 * tiho pogoltnjena). Vercel runtime logi brez console.error niso imeli kaj
 * pokazati, zato diagnostika ni bila mogoča.
 *
 * Rešitev (dva sloja):
 *  1. logDbError(scope, err)  — console.error s Prisma kodo + sporočilom +
 *     stackom → izjema je VIDLJIVA v Vercel runtime logih (issue #76:
 *     "errors are observable in server logs without exposing credentials").
 *     Prisma sporočila NE vsebujejo gesla (samo host/bazo), logi so interno.
 *  2. describeDbError(err)    — JAVNA, varna klasifikacija: vrne samo Prisma
 *     kodo + kategorijo + priporočilo. Brez sporočila, brez hosta, brez
 *     poverilnic — primerna za JSON odgovor (health, 503 telesa).
 *
 * Kategorije so naslonjene na Prisma P1xxx (initialization/connection) in
 * P2xxx (runtime/schema) kode ter tekstovne vzorce za env napake.
 */

import { appendErrorLog } from './local-log'
import { resolveDataDir } from './local-runtime'

export type DbErrorCategory =
  | 'env_missing' // DATABASE_URL (ali APP_SECRET) ni nastavljen v okolju
  | 'invalid_url' // povezovalni niz je neveljaven (P1013 in podobno)
  | 'unreachable' // strežnika ni mogoče doseči (P1001, P1017, DNS)
  | 'auth' // poverilnice zavrnjene (P1000, P1005, P1010)
  | 'tls' // TLS/SSL napaka (P1011)
  | 'timeout' // časovne omejitve (P1002, P1008, P1016)
  | 'not_found' // baza/datoteka ne obstaja (P1003, P1007, P1009)
  | 'schema' // shema zamuda (P1012, P1015, P2021, P2022)
  | 'unknown'

export interface DbErrorPublic {
  /** Prisma koda (npr. "P1001") ali oznaka (ENV_MISSING / UNKNOWN). */
  code: string
  /** Groba kategorija — varna za javni prikaz. */
  category: DbErrorCategory
}

/** Zemljevid Prisma kod → kategorija (P1xxx: inicializacija/povezava). */
const P1_MAP: Record<string, DbErrorCategory> = {
  P1000: 'auth',
  P1001: 'unreachable',
  P1002: 'timeout',
  P1003: 'not_found',
  P1005: 'auth',
  P1007: 'not_found',
  P1008: 'timeout',
  P1009: 'not_found',
  P1010: 'auth',
  P1011: 'tls',
  P1012: 'schema',
  P1013: 'invalid_url',
  P1014: 'schema',
  P1015: 'schema',
  P1016: 'timeout',
  P1017: 'unreachable',
}

/** P2xxx: zahteve čez povezavo (shema/protokol). */
const P2_MAP: Record<string, DbErrorCategory> = {
  P2021: 'schema',
  P2022: 'schema',
  P2023: 'schema',
  P2024: 'timeout',
  P2025: 'unknown', // "record not found" — aplikacijska napaka, ne DB izpad
}

const HINTS: Record<DbErrorCategory, string> = {
  env_missing:
    'V okolju manjka DATABASE_URL. Preverite Environment Variables na Vercelu za Production okolje (ime spremenljivke, ne vrednost).',
  invalid_url:
    'Povezovalni niz baze je neveljaven. Preverite obliko DATABASE_URL (protokol, host, ime baze, sslmode).',
  unreachable:
    'Podatkovnega strežnika ni mogoče doseči. Preverite, ali je baza zagnana/odpauzirana (npr. Neon) in omrežno dosegljiva.',
  auth: 'Strežnik je zavrnil poverilnice. Preverite uporabnika in geslo v DATABASE_URL (brez razkrivanja vrednosti).',
  tls: 'TLS pogajanja so spodletela. Preverite sslmode=require v DATABASE_URL in certifikat strežnika.',
  timeout: 'Povezava je potekla. Preverite obremenitev/dosegljivost strežnika baze.',
  not_found: 'Baza (ali sqlite datoteka) ne obstaja na cilju. Preverite ime baze/endpointa v DATABASE_URL.',
  schema: 'Povezava vzpostavljena, shema pa se ne ujema. Pognajte migracije/prisma db push proti isti bazi.',
  unknown: 'Nerazvrščena napaka — glejte strežniške loge (console.error) za podrobnosti.',
}

/**
 * JAVNA klasifikacija (varna za odgovor API-ja): samo koda + kategorija +
 * priporočilo. Izvirno sporočilo izjeme se NE vrača (lahko vsebuje host).
 */
export function describeDbError(err: unknown): DbErrorPublic {
  const e = err as { code?: unknown; message?: unknown }
  const code = String(e?.code ?? '')
  const msg = String(e?.message ?? '')

  // 1. eksplicitna Prisma koda (P1xxx / P2xxx)
  const known = P1_MAP[code] ?? P2_MAP[code]
  if (known) return { code, category: known }

  // 2. tekstovni vzorci (env / url napake pridejo brez P kode pri generaciji klienta)
  if (/Environment variable[\s\S]*not found/i.test(msg) || /DATABASE_URL.*not set/i.test(msg)) {
    return { code: 'ENV_MISSING', category: 'env_missing' }
  }
  if (/must use sqlite|Invalid datasource url|Error validating url|the URL must start with/i.test(msg)) {
    return { code: 'INVALID_URL', category: 'invalid_url' }
  }
  // raw SQLite/PG runtime napake brez P kode (npr. Prisma avto-ustvari prazno bazo)
  if (/no such table|no such column|does not exist in the current database/i.test(msg)) {
    return { code: 'RAW_SCHEMA', category: 'schema' }
  }
  if (/Database file does not exist|Error opening (a )?database/i.test(msg)) {
    return { code: 'RAW_NOT_FOUND', category: 'not_found' }
  }
  if (/Server has closed the connection|Can't reach|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
    return { code: 'NO_CODE', category: 'unreachable' }
  }
  if (/Timed out|timeout/i.test(msg)) {
    return { code: 'NO_CODE', category: 'timeout' }
  }
  if (/SSL|TLS|certificate/i.test(msg)) {
    return { code: 'NO_CODE', category: 'tls' }
  }

  return { code: code || 'UNKNOWN', category: 'unknown' }
}

/** Priporočilo po kategoriji (javno varno, brez skrivnosti). */
export function dbErrorHint(category: DbErrorCategory): string {
  return HINTS[category]
}

/**
 * STREŽNIŠKI log (Vercel runtime logi): izpiše obseg, Prisma kodo, sporočilo
 * in stack. Prisma sporočila ne izpisujejo gesla (samo host/bazo) — logi so
 * interno vidni le ekipi, javni API pa NE vrača teh podrobnosti.
 *
 * v1.181.0: lokalni profil piše ISTE napake V DATOTEKO (`logs/errors-<dan>.log`),
 * ker od kar aplikacijo zaganja opravilo ob prijavi (v1.175.0) `console.error`
 * nima bralca. V oblaku se ne piše na disk — produkcijski disk ni naš za
 * hrambo, in pisati podatkovne datoteke iz funkcije je nova napadalna ploskev.
 */
export function logDbError(scope: string, err: unknown, at: Date = new Date()): void {
  const e = err as { code?: unknown; message?: unknown; stack?: unknown }
  const code = e?.code ? ` code=${e.code}` : ''
  console.error(`[db-error] ${scope}${code}: ${e?.message ?? String(err)}`)
  if (typeof e?.stack === 'string' && e.stack) {
    console.error(e.stack)
  }
  if (process.env.RESTAURANTOS_LOCAL === '1') {
    appendErrorLog(
      resolveDataDir(),
      {
        scope,
        message: String(e?.message ?? err),
        code: e?.code ? String(e.code) : undefined,
        stack: typeof e?.stack === 'string' ? e.stack : undefined,
        at,
      },
      at,
    )
  }
}
