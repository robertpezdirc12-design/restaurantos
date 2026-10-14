import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * v1.100.0 — issue #38 (P1): aditivni tenant ključ dogodkovne vrste:
 *  1. ADD COLUMN "locationId" TEXT (nullable) — kanonična lokacija dogodka,
 *     STREŽNIŠKO izpeljana iz preverjene entitete ob publishEvent (nikoli iz
 *     klientovega payload-a). NULL = legacy/sistemski dogodek → viden samo
 *     bootstrap platformnemu operaterju (fail-closed, gl. /api/events).
 *  2. CREATE INDEX "EventLog_locationId_idx" — filter obsega seznama/števcev.
 *
 * Brez FK na Location (namenoma): izbrisana/prevezana lokacija pusti
 * locationId, ki ne pripada nobeni živi organizaciji → dogodek samodejno
 * pade v fail-closed (ne vidi ga noben org-bound uporabnik) — enaka
 * disciplina kot legacy NULL, brez obremenitve DDL s constraintom.
 *
 * Legacy zgodovina: obstoječi zapisi OSTANEJO locationId NULL (migracija
 * si ne izmišljuje tenant povezav — zahteva issue #38); vidni so samo
 * bootstrap operaterju.
 *
 * Issue-13/paylink/issue31-36 vzorec: dev SQLite dobi spremembe prek
 * `prisma db push`, produkcijski Neon Postgres čaka ta korak (konzola
 * Enterprise → Shema migracije → issue38 → Uporabi). Samo centralne
 * vloge (requireCentralRole). Idempotentno: probe → alreadyApplied brez
 * DDL; stavka sami nosijo IF NOT EXISTS.
 */
const DDL = [
  `ALTER TABLE "EventLog" ADD COLUMN IF NOT EXISTS "locationId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "EventLog_locationId_idx" ON "EventLog" ("locationId")`,
]

async function locationIdColumnPresent(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "locationId" FROM "EventLog" LIMIT 1`)
    return true
  } catch {
    return false
  }
}

async function eventLogTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "EventLog" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  // Idempotenca: stolpec že obstaja (ponovni klic / dev SQLite z db push).
  if (await locationIdColumnPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await eventLogTableExists())) {
    return fail('Tabela EventLog ne obstaja — baza ni inicializirana.', 409)
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.slice(0, 90) })
  }

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_ISSUE38_EVENT_TENANT',
        entityType: 'Schema',
        entityId: 'issue38_event_tenant',
        details: JSON.stringify({ statements: DDL.length }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
