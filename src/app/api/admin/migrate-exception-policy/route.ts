import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #19 (P1/P2, v1.107.0) — politika finančnih izjem (exception-policy):
 *  9 novih stolpcev na RestaurantSettings (globalna poslovna politika):
 *   - "excDiscountApprovalPct"         DECIMAL(5,2) NOT NULL DEFAULT 15
 *   - "excDiscountApprovalAmountCents" INTEGER     NOT NULL DEFAULT 0
 *   - "excVoidApprovalAmountCents"     INTEGER     NOT NULL DEFAULT 0
 *   - "excStornoApprovalAmountCents"   INTEGER     NOT NULL DEFAULT 0
 *   - "excCancelApprovalAmountCents"   INTEGER     NOT NULL DEFAULT 0
 *   - "excRequireReasonDiscount"       BOOLEAN     NOT NULL DEFAULT FALSE
 *   - "excRequireReasonCancel"         BOOLEAN     NOT NULL DEFAULT TRUE
 *   - "excRequireReasonStorno"         BOOLEAN     NOT NULL DEFAULT TRUE
 *   - "excRequireReasonVoid"           BOOLEAN     NOT NULL DEFAULT TRUE
 *
 * Privzeti % prag ohranja dosedanjo 15-% vlogo politiko; zneskovni pragovi so
 * privzeto IZKLOPLJENI (0 = nadzor po vlogi/permission, kot doslej) — njihov
 * vklop je izrecna odločitev upravljavca prek PUT /api/settings (settings.manage).
 * Do DDL: rute tečejo na varnih privzetkih (graceful), pisanje → 503.
 * Issue-13/stroski-kategorije vzorec: dev SQLite dobi stolpce prek mirror
 * sheme, produkcijski Neon Postgres čaka ta korak (konzola). Idempotentno.
 */
const DDL = [
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excDiscountApprovalPct" DECIMAL(5,2) NOT NULL DEFAULT 15`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excDiscountApprovalAmountCents" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excVoidApprovalAmountCents" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excStornoApprovalAmountCents" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excCancelApprovalAmountCents" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excRequireReasonDiscount" BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excRequireReasonCancel" BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excRequireReasonStorno" BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "excRequireReasonVoid" BOOLEAN NOT NULL DEFAULT TRUE`,
]

async function policyColumnsPresent(): Promise<boolean> {
  for (const col of [
    'excDiscountApprovalPct', 'excDiscountApprovalAmountCents', 'excVoidApprovalAmountCents',
    'excStornoApprovalAmountCents', 'excCancelApprovalAmountCents', 'excRequireReasonDiscount',
    'excRequireReasonCancel', 'excRequireReasonStorno', 'excRequireReasonVoid',
  ]) {
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

  if (await policyColumnsPresent()) {
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
        action: 'SCHEMA_MIGRATION_EXCEPTION_POLICY',
        entityType: 'Schema',
        entityId: 'exception_policy',
        details: JSON.stringify({ statements: DDL.length, defaults: { pct: 15, amountCents: 0, requireReason: { cancel: true, storno: true, void: true } } }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
