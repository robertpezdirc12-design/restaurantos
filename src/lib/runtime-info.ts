/**
 * v1.165.0 — kateri profil teče (PRD docs/PRD-LOKALNA-BAZA.md).
 *
 * Profil se izbere izključno po `DATABASE_URL`: `file:` pomeni lokalno SQLite,
 * vse drugo oblačni Postgres. Health to poroča, da podpora loči namestitev
 * brez razkritja poti ali poverilnic.
 */
export type RuntimeMode = 'local' | 'cloud'
export type DatabaseEngine = 'sqlite' | 'postgresql'

export function isLocalDatabaseUrl(url: string | undefined | null): boolean {
  return typeof url === 'string' && url.trim().toLowerCase().startsWith('file:')
}

export function runtimeMode(env: Record<string, string | undefined> = process.env): RuntimeMode {
  return isLocalDatabaseUrl(env.DATABASE_URL) ? 'local' : 'cloud'
}

export function databaseEngine(env: Record<string, string | undefined> = process.env): DatabaseEngine {
  return isLocalDatabaseUrl(env.DATABASE_URL) ? 'sqlite' : 'postgresql'
}
