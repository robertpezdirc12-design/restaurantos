import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * PRIMERJAVA §37 (v1.263.0) — prikazovna politika računa
 * (receipt-display-policy): 1 nov stolpec na RestaurantSettings:
 *   - "hideZeroReceiptItems" BOOLEAN NOT NULL DEFAULT FALSE
 *
 * Skrivanje ničelnih postavk na natisnjenem odjemalskem računu (Square
 * Vol 16, 5. 11. 2026 »Hide $0 items from printed customer receipts«):
 * postavke DODANE po ceni 0 (kruh na hišni račun, kozarec vode) se ob
 * vklopu ne izrisujejo — SAMO v izrisu (posnetek itemsJson, kuhinjski
 * listki, poročila in izvozi ostanejo popolni). Plačane postavke, popust-
 * do-0 in 0-postavke s plačano opcijo PIŠEJO avtomatsko (matematika
 * posnetka); §23 priceOverride-do-0 (comp natakarja) prav tako PIŠE.
 *
 * Privzeto IZKLOPLJENO — vsak obstoječi izpis ostane byte-identičen.
 * Do DDL: politika bere varni privzetek (graceful), pisanje prek PUT
 * /api/settings → 503 s potjo do te konzole. Issue-13/stroski-kategorije/
 * exception-policy vzorec: dev SQLite dobi stolpec prek mirror sheme,
 * produkcijski Neon Postgres čaka ta korak. Idempotentno.
 */
const DDL = [
  `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "hideZeroReceiptItems" BOOLEAN NOT NULL DEFAULT FALSE`,
]

async function policyColumnPresent(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "hideZeroReceiptItems" FROM "RestaurantSettings" LIMIT 1`)
    return true
  } catch {
    return false
  }
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

  if (await policyColumnPresent()) {
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
        action: 'SCHEMA_MIGRATION_RECEIPT_DISPLAY_POLICY',
        entityType: 'Schema',
        entityId: 'receipt_display_policy',
        details: JSON.stringify({ statements: DDL.length, defaults: { hideZeroReceiptItems: false } }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
