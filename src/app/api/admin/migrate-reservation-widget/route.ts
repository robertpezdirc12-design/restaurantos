import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #13 (P1/P2, v1.110.0) — javni rezervacijski widget: DDL korak.
 *
 * NOVA tabela ReservationWidget (ena vrstica na lokacijo):
 *  - token (32 hex skrivnost — javna povezava /r/<token>, rotacija = revokacija)
 *  - enabled (zastavica vklopa widgeta)
 *  - politika terminov: slotMinutes / minParty / maxParty / leadMinutes /
 *    maxAdvanceDays / maxCoversPerSlot (0 = dinamično iz sedežev miz)
 *  - locationId je SKALAR brez FK (EventLog/HaccpAction vzorec — brez
 *    FKConstraint driftov; @@unique na locationId + token)
 *
 * Idempotentno: preverba obstoja tabele pred izvedbo (SQLite dev dobi tabelo
 * prek db push mirrorja, produkcijski Neon čaka ta korak — konzola Enterprise
 * → Shema migracije → reservation-widget). Samo centralne vloge
 * (requireCentralRole). Dokler tabela ne obstaja, javne rute widgeta
 * odgovarjajo 404 (graceful degradacija) — obstoječi interni
 * rezervaacijski tok (POS) se ne dotakne.
 */

const CREATE_WIDGET_TABLE = `CREATE TABLE IF NOT EXISTS "ReservationWidget" (
  "id" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "slotMinutes" INTEGER NOT NULL DEFAULT 30,
  "minParty" INTEGER NOT NULL DEFAULT 1,
  "maxParty" INTEGER NOT NULL DEFAULT 12,
  "leadMinutes" INTEGER NOT NULL DEFAULT 60,
  "maxAdvanceDays" INTEGER NOT NULL DEFAULT 30,
  "maxCoversPerSlot" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReservationWidget_pkey" PRIMARY KEY ("id")
)`

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReservationWidget_locationId_key" ON "ReservationWidget"("locationId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReservationWidget_token_key" ON "ReservationWidget"("token")`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "ReservationWidget_token_idx" ON "ReservationWidget"("token")`,
  `CREATE INDEX IF NOT EXISTS "ReservationWidget_enabled_idx" ON "ReservationWidget"("enabled")`,
]

async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
      table,
    )
    return Array.isArray(rows) && rows.length > 0
  } catch {
    // SQLite (dev/CI): information_schema ne obstaja — tabela je že prek db push
    return true
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  try {
    if (await tableExists('ReservationWidget')) {
      skipped.push('ReservationWidget')
    } else {
      await db.$executeRawUnsafe(CREATE_WIDGET_TABLE)
      applied.push('ReservationWidget')
    }
    for (const ix of [...UNIQUE_INDEXES, ...INDEXES]) {
      await db.$executeRawUnsafe(ix)
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_RESERVATION_WIDGET',
      entityType: 'SchemaMigration',
      entityId: 'reservation-widget',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-reservation-widget' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
