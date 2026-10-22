/**
 * v1.166.0 — ZAČASNI demo dostop brez gesla (lastnikova zahteva 21. 10. 2026).
 *
 * Čisto okolje za `scripts/demo-start.ts`: namenska SQLite baza + demo vrata
 * z nujnim rokom. Nič tu ne sme poseči v `prisma/db/dev.db` (testna baza,
 * deljen vir — pravilo P-10) ali v izdani lokalni profil (`localEnv()`,
 * ki mora ostati zaprt, ker `bun run local` posluša na 0.0.0.0).
 *
 * Odstranitev: `docs/DEMO-DOSTOP.md` §4.
 */
import path from 'node:path'
import { sqliteUrlFor } from './local-runtime'

/** Račun iz `prisma/seed.ts`: vloga admin, brez MFA — edini, ki ga demo vrata spustijo. */
export const DEMO_EMAIL = 'admin@restaurantos.app'

/** Lokacija, meni, mize in dnevni promet (KDS listki, tloris, handheld) so v `prisma/seed.ts`. */
export const DEMO_DB_FILENAME = 'demo.db'

/** Privzeti rok vrat. Namenoma kratek: dostop je za čas dela na zaslonih. */
export const DEMO_GATE_DAYS = 14

export function demoDbPath(root: string = process.cwd()): string {
  return path.join(root, 'prisma', 'db', DEMO_DB_FILENAME)
}

export interface DemoEnvOptions {
  now?: Date
  days?: number
}

/**
 * Okolje demo zagona. Rok je obvezen: `demoGate()` je sicer fail-open, kadar
 * `DEMO_LOGIN_EXPIRES_AT` ni nastavljen, začasni dostop pa ne sme preživeti
 * zamujenega brisanja kode.
 */
export function demoEnv({ now = new Date(), days = DEMO_GATE_DAYS }: DemoEnvOptions = {}): Record<string, string> {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`[demo] Rok demo vrat mora biti število dni večji od 0 (dobeno: ${days}).`)
  }
  const expiresAt = new Date(now.getTime() + days * 86_400_000)
  return {
    DATABASE_URL: sqliteUrlFor(demoDbPath()),
    DEMO_LOGIN_ENABLED: '1',
    DEMO_LOGIN_EMAIL: DEMO_EMAIL,
    DEMO_LOGIN_EXPIRES_AT: expiresAt.toISOString(),
  }
}
