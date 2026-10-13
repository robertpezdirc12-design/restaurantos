/**
 * v1.86.1 — prepoznavanje "tabela/stolpec ne obstaja" NAD VSEMI Prisma plastmi.
 *
 * LEKCIJA (produkcijski dokaz, 13. 10. 2026): isMissing preverbe so
 * primerjale SAMO Prisma cli kodе P2021/P2022 — a te nastopijo IZKLJUČNO
 * pri TIPIZIRANIH poizvedbah (db.model.findMany …). Za RAW poizvedbe
 * ($queryRawUnsafe/$executeRawUnsafe) Prisma vrača P2010 ("Raw query
 * failed"), prava koda driverja pa je v meta:
 *   - Postgres (Neon produkcija): meta.code 42P01 (undefined_table) /
 *     42703 (undefined_column) — dokazano na produkciji (stroski-kategorije
 *     preverba je 42703 obravnavala kot "infra napako" → 500 namesto DDL).
 *   - SQLite (dev/testi): meta.code "1", sporočilo "no such table/column:
 *     …" — dokazano empirično (bun + ci-fresh.db).
 * Posledica pred popravkom: probe je na produkciji javlal "ERROR" namesto
 * "pending", haccp/expenses capability probi pa sta se obnašali kot READY
 * (graceful degradacija se ni nikoli sprožila) — na dev je bila napaka
 * nevidna, ker db push vse tabele/stolpce vedno ima (error pot mrtva).
 *
 * Uporaba (4 mesta): src/lib/schema-migrations.ts (status konzola),
 * src/lib/haccp-plans.ts + src/lib/expenses-categories.ts (capability
 * probi), /api/admin/migrate-stroski-kategorije (idempotenca pre-check).
 * payLinkReady() ima namerno prazen catch (javna gostova ruta — prijazno
 * 503 tudi pri infra napaki) in NE uporablja tega helperja.
 */

/** PrismaClientKnownRequestError oblika (code + meta.code/message). */
interface RawPrismaError {
  code?: string
  meta?: { code?: string; message?: string }
  message?: string
}

/**
 * Ali napaka pomeni "tabela ali stolpec ne obstaja" (DDL pending)?
 * P2021/P2022 = tipizirane poizvedbe; P2010 + driver koda/sporočilo = raw.
 * VSE ostalo (P1001 unreachable, timeout, sintaksa …) → false — infra
 * resnica, ne lažni pending (ista politika kot prej).
 */
export function isMissingSchemaError(e: unknown): boolean {
  const err = (e ?? {}) as RawPrismaError
  const code = err.code
  if (code === 'P2021' || code === 'P2022') return true
  if (code === 'P2010') {
    const dbCode = String(err.meta?.code ?? '')
    // Postgres: undefined_table / undefined_column
    if (dbCode === '42P01' || dbCode === '42703') return true
    // SQLite: splošna koda "1" — odloča sporočilo
    const msg = String(err.meta?.message ?? err.message ?? '')
    if (/no such (table|column)/i.test(msg)) return true
  }
  return false
}
