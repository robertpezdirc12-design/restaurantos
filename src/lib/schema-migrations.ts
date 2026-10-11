import { db } from '@/lib/db'

/**
 * Task 65 (v1.63.0) — register shematskih migracij (DDL konzola).
 *
 * Projekt je po issue-13 vzorcu (Task 44) ob vsakem novem modelu/stolpcu dodal
 * idempotentno admin migrate rutо (/api/admin/migrate-*) z FIKSNO DDL — produkcija
 * (Neon Postgres) ne izvaja `prisma db push`, zato DDL korake izvaja centralna
 * vloga ročno. Do Task 65 je bilo takih rut 9 → uporabniško trenje (9 ročnih
 * POST klicev). Konzola (/api/admin/migrations) jih združi: status vsake
 * migracije (idempotentna preverba probe) + en klik "uporabi vse čakajoče"
 * z delegacijo na obstoječe rute (ENAK DDL vir, ENAK audit chain — konzola NE
 * podvaja DDL).
 *
 * Probe mora biti dialekt-agnostična (dev SQLite + produkcijski Postgres):
 *  - tableExists:  SELECT 1 FROM "T" LIMIT 1        → P2021 = manjka
 *  - columnExists: SELECT "c" FROM "T" LIMIT 1      → P2022 = manjka
 *  - columnNullable: Postgres information_schema, SQLite PRAGMA fallback
 * Infrastrukturne napake (P1001 unreachable, timeout …) NISO "pending" — probe
 * jih propagira (status error), da konzola pokaže resnico in ne lažnega DDL
 * stanja (isti politiki kot haccp capability probe, src/lib/haccp-plans.ts).
 *
 * Omejitev: PG enum vrednosti (ALTER TYPE … ADD VALUE, migrate-issue11) niso
 * dialekt-agnostično preverljive — probe issue11 preverja tabele + stolpce kot
 * zadosten proxy (vloge so priložene tabelam; drift-check na CI čuva ostalo).
 */

export interface SchemaMigration {
  /** stabilni id (UI + POST {id}) */
  id: string
  /** i18n ključ opisa (UI) */
  descKey: string
  /** vir DDL — obstoječa admin migrate ruta, ki ji konzola delegira izvedbo */
  endpoint: string
  /** idempotentna preverba "aplicirano" (true = DDL ni potreben) */
  probe: () => Promise<boolean>
}

/* ───────────────────────── probe pomožniki ───────────────────────── */

const isMissingCode = (e: unknown): boolean => {
  const code = (e as { code?: string }).code
  return code === 'P2021' || code === 'P2022'
}

/** Ali tabela obstaja? (SQLite + Postgres) */
async function tableExists(table: string): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`)
    return true
  } catch (e) {
    if (isMissingCode(e)) return false
    throw e // infra napaka → status error (brez maskiranja)
  }
}

/** Ali stolpec obstaja? (SQLite + Postgres) */
async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "${column}" FROM "${table}" LIMIT 1`)
    return true
  } catch (e) {
    if (isMissingCode(e)) return false
    throw e
  }
}

/** Ali so vsi pari (tabela, stolpec) prisotni? */
async function columnsAll(pairs: [string, string][]): Promise<boolean> {
  for (const [table, column] of pairs) {
    if (!(await columnExists(table, column))) return false
  }
  return true
}

/** Ali vse tabele obstajajo? */
async function tablesAll(tables: string[]): Promise<boolean> {
  for (const t of tables) {
    if (!(await tableExists(t))) return false
  }
  return true
}

/**
 * Ali je stolpec NULL-able? (migrate-issue13 preverja spremembo omejitve, ne prisotnosti)
 * Dialekt po DATABASE_URL (tiho, brez poizvedovnega šuma): SQLite (file:) →
 * PRAGMA table_info (notnull je BigInt → Number()), Postgres → information_schema.
 */
async function columnNullable(table: string, column: string): Promise<boolean> {
  if ((process.env.DATABASE_URL ?? '').startsWith('file:')) {
    try {
      const rows = await db.$queryRawUnsafe<{ name: string; notnull: bigint | number }[]>(
        `PRAGMA table_info("${table}")`,
      )
      const col = rows.find((c) => c.name === column)
      return col ? Number(col.notnull) === 0 : false
    } catch (e) {
      if (isMissingCode(e)) return false
      throw e
    }
  }
  const rows = await db.$queryRawUnsafe<{ is_nullable: string }[]>(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`,
  )
  // 0 vrstic = tabela/stolpec manjka → migracija ni aplicirana
  return rows.length > 0 ? rows[0].is_nullable === 'YES' : false
}

/* ───────────────────────── register ───────────────────────── */

export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'issue3',
    descKey: 'mig.issue3.desc',
    endpoint: '/api/admin/migrate-issue3',
    probe: () => columnsAll([
      ['Table', 'qrToken'], ['Table', 'qrEnabled'], ['Table', 'qrRotatedAt'],
      ['DeviceRegistry', 'pairingCode'], ['DeviceRegistry', 'pairingExpiresAt'],
      ['DeviceRegistry', 'pairedToDeviceId'], ['DeviceRegistry', 'displayPayload'],
      ['DeviceRegistry', 'displayUpdatedAt'], ['DeviceRegistry', 'revokedAt'],
      ['Order', 'orderSource'],
    ]),
  },
  {
    id: 'issue4',
    descKey: 'mig.issue4.desc',
    endpoint: '/api/admin/migrate-issue4',
    probe: () => columnsAll([
      ['DeviceRegistry', 'enrollmentCode'],
      ['DeviceRegistry', 'enrollmentExpiresAt'],
      ['DeviceRegistry', 'enrollmentClaimedAt'],
    ]),
  },
  {
    id: 'issue1-s6',
    descKey: 'mig.issue1s6.desc',
    endpoint: '/api/admin/migrate-issue1-s6',
    probe: () => columnsAll([
      ['Discount', 'happyDays'], ['Discount', 'happyFromHour'],
      ['Discount', 'happyToHour'], ['Discount', 'targetCategoryIds'],
    ]),
  },
  {
    id: 'issue1-s7',
    descKey: 'mig.issue1s7.desc',
    endpoint: '/api/admin/migrate-issue1-s7',
    probe: () => tableExists('SpecialOpeningDay'),
  },
  {
    id: 'issue10',
    descKey: 'mig.issue10.desc',
    endpoint: '/api/admin/migrate-issue10',
    probe: () => tableExists('PrintJob'),
  },
  {
    id: 'issue11',
    descKey: 'mig.issue11.desc',
    endpoint: '/api/admin/migrate-issue11',
    // proxy za enum vrednosti (glej opis modula): tabele + propertyId stolpci
    // (obe podpreverbi eksplicitno await — brez lebdečih promise-ov)
    probe: async () =>
      (await tablesAll(['Organization', 'Brand', 'Property', 'Workstation', 'EventLog']))
      && (await columnsAll([['Location', 'propertyId'], ['RevenueCenter', 'propertyId']])),
  },
  {
    id: 'issue12',
    descKey: 'mig.issue12.desc',
    endpoint: '/api/admin/migrate-issue12',
    probe: () => columnsAll([
      ['Employee', 'mfaSecret'], ['Employee', 'mfaEnabled'],
      ['Employee', 'mfaRecoveryCodes'], ['Employee', 'mfaEnrolledAt'],
    ]),
  },
  {
    id: 'issue13',
    descKey: 'mig.issue13.desc',
    endpoint: '/api/admin/migrate-issue13',
    probe: () => columnNullable('Location', 'premisesId'),
  },
  {
    id: 'haccp-plans',
    descKey: 'mig.haccpPlans.desc',
    endpoint: '/api/admin/migrate-haccp-plans',
    probe: () => tableExists('HaccpPlan'),
  },
]

/* ───────────────────────── status ───────────────────────── */

export interface MigrationStatus {
  id: string
  applied: boolean
  /** infra napaka probe — ni "pending", konzola pokaže resnico */
  error?: string
}

/** test hook: vsili probe rezultat (simulacija DDL pending brez rušenja sheme) */
const probeOverrides = new Map<string, boolean>()

export function setMigrationProbeOverride(id: string, applied: boolean): void {
  probeOverrides.set(id, applied)
}

export function clearMigrationProbeOverrides(): void {
  probeOverrides.clear()
}

/** Status vseh migracij v register rednem vrstnem redu. */
export async function schemaMigrationsStatus(): Promise<MigrationStatus[]> {
  const out: MigrationStatus[] = []
  for (const m of SCHEMA_MIGRATIONS) {
    const override = probeOverrides.get(m.id)
    if (override !== undefined) {
      out.push({ id: m.id, applied: override })
      continue
    }
    try {
      out.push({ id: m.id, applied: await m.probe() })
    } catch (e) {
      out.push({ id: m.id, applied: false, error: (e as Error).message })
    }
  }
  return out
}
