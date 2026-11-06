import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * PRIMERJAVA §39 (v1.265.0) — EXPO POŽIG ZADRŽANIH TEČAJEV S KDS
 * (Square Vol 16, 5. 11. 2026 »Fire held courses from an Expo KDS«):
 * 1 nov stolpec na Location:
 *   - "kdsExpoFireEnabled" BOOLEAN NOT NULL DEFAULT FALSE
 *     (per-lokacijska nastavitev »Dovoli požig s KDS« — privzeto
 *     IZKLOPLJENO: požig ostane natakarjeva pristojnost v POS)
 *
 * Do DDL: GET /api/kitchen vrača prazno mapo expoFireLocations
 * (graceful — KDS nikjer ne pokaže tap tarč), PATCH /api/locations/[id]
 * s kdsExpoFireEnabled → 503 s potjo do te konzole (issue-13/
 * stroski-kategorije/exception-policy/receipt-display-policy/
 * kds-ticket-sequence vzorec: dev SQLite dobi stolpec prek mirror
 * sheme, produkcijski Neon Postgres čaka ta korak). Idempotentno.
 */
const DDL = [
  `ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "kdsExpoFireEnabled" BOOLEAN NOT NULL DEFAULT FALSE`,
]

async function expoFireColumnPresent(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "kdsExpoFireEnabled" FROM "Location" LIMIT 1`)
    return true
  } catch {
    return false
  }
}

async function locationTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "Location" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  if (await expoFireColumnPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await locationTableExists())) {
    return fail('Tabela Location ne obstaja — baza ni inicializirana.', 409)
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
        action: 'SCHEMA_MIGRATION_KDS_EXPO_FIRE',
        entityType: 'Schema',
        entityId: 'kds_expo_fire',
        details: JSON.stringify({ statements: DDL.length, default: false }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
