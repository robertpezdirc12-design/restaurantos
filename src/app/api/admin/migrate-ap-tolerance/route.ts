import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #18 (P1) — tolerance tristranskega ujemanja (ap-tolerance):
 *  4 novi stolpci na RestaurantSettings (globalna računovodska politika):
 *   - "apMatchQtyTolerancePct"    DECIMAL(5,2) NOT NULL DEFAULT 0
 *   - "apMatchPriceTolerancePct"  DECIMAL(5,2) NOT NULL DEFAULT 0
 *   - "apMatchVatTolerancePct"    DECIMAL(5,2) NOT NULL DEFAULT 0
 *   - "apMatchAmountToleranceCents" INTEGER   NOT NULL DEFAULT 2
 *
 * Privzete vrednosti so NAJSTROŽJE (0 % / 2 centa) — ohlapitev je izrecna
 * odločitev pooblaščene osebe prek PUT /api/settings (settings.manage).
 * Do DDL motor uporablja stroge privzetke (graceful degradacija — pisanje
 * tolerance vrne 503, branje vrne privzetke).
 *
 * Issue-13/stroski-kategorije vzorec: dev SQLite dobi stolpce prek prisma db
 * push (mirror schema jih ima), produkcijski Neon Postgres čaka ta korak
 * (konzola Enterprise → Shema migracije → ap-tolerance). Samo centralne
 * vloge (requireCentralRole). Idempotentno: probe → alreadyApplied brez DDL;
 * stavke same nosijo IF NOT EXISTS.
 */
const DDL = [
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "apMatchQtyTolerancePct" DECIMAL(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "apMatchPriceTolerancePct" DECIMAL(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "apMatchVatTolerancePct" DECIMAL(5,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "apMatchAmountToleranceCents" INTEGER NOT NULL DEFAULT 2`,
]

async function toleranceColumnsPresent(): Promise<boolean> {
  for (const col of ['apMatchQtyTolerancePct', 'apMatchPriceTolerancePct', 'apMatchVatTolerancePct', 'apMatchAmountToleranceCents']) {
    try {
      await db.$queryRawUnsafe(`SELECT "${col}" FROM "RestaurantSettings" LIMIT 1`)
    } catch {
      return false
    }
  }
  return true
}

async function settingsTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "RestaurantSettings" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  if (await toleranceColumnsPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await settingsTableExists())) {
    return fail('Tabela RestaurantSettings ne obstaja — baza ni inicializirana.', 409)
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
        action: 'SCHEMA_MIGRATION_AP_TOLERANCE',
        entityType: 'Schema',
        entityId: 'ap_tolerance',
        details: JSON.stringify({ statements: DDL.length, defaults: { qty: 0, price: 0, vat: 0, cents: 2 } }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
