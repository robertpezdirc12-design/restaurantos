import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * v1.94.0 — issue #31+#33+#35+#36: aditivni MFA stolpci nad tabelo Employee:
 *  1. ADD COLUMN "mfaLastTotpCounter" INTEGER (nullable) — RFC 6238 §5.2
 *     replay zaščita TOTP (zadnji uspešno sprejeti korak; null = neuporabljena);
 *  2. ADD COLUMN "mfaRecoveryVersion" INTEGER NOT NULL DEFAULT 0 — CAS žeton
 *     za atomarno porabo recovery kod (vsak zapis seznama poviša števec).
 *
 * Issue-13/paylink vzorec: dev SQLite dobi spremembe prek `prisma db push`,
 * produkcijski Neon Postgres čaka ta korak (konzola Enterprise → Shema
 * migracije → issue31-36-mfa → Uporabi). Samo centralne vloge
 * (requireCentralRole). Idempotentno: probe (stolpca obstajata?) →
 * alreadyApplied brez DDL; stavki sami nosijo IF NOT EXISTS.
 */
const DDL = [
  `ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "mfaLastTotpCounter" INTEGER`,
  `ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "mfaRecoveryVersion" INTEGER NOT NULL DEFAULT 0`,
]

async function mfaColumnsPresent(): Promise<boolean> {
  for (const col of ['mfaLastTotpCounter', 'mfaRecoveryVersion']) {
    try {
      await db.$queryRawUnsafe(`SELECT "${col}" FROM "Employee" LIMIT 1`)
    } catch {
      return false
    }
  }
  return true
}

async function employeeTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "Employee" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  // Idempotenca: stolpca že obstajata (ponovni klic / dev SQLite z db push).
  if (await mfaColumnsPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await employeeTableExists())) {
    return fail('Tabela Employee ne obstaja — baza ni inicializirana.', 409)
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
        action: 'SCHEMA_MIGRATION_ISSUE31_36_MFA',
        entityType: 'Schema',
        entityId: 'issue31_36_mfa',
        details: JSON.stringify({ statements: DDL.length }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
