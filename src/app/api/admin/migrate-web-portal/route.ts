import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * P1 #8 (v1.190.0) — lastni spletni portal za naročila: DDL korak.
 *
 * NOVA tabela WebOrderPortal (ena vrstica na lokacijo, ReservationWidget vzorec):
 *  - token (32 hex skrivnost — javna povezava /s/<token>, rotacija = revokacija)
 *  - enabled (zastavica vklopa portala)
 *  - pickupEnabled/deliveryEnabled (načina prevzema)
 *  - deliveryFee/minOrder (denarni politiki EUR), prepMinutes (ocena priprave)
 *  - note (prosto besedilo za goste), trackSecret (HMAC javnega sledenja)
 *  - locationId je SKALAR brez FK (ReservationWidget/EventLog vzorec — brez
 *    FKConstraint driftov; brisanje lokacije počisti prek housekeeping)
 *
 * Idempotentno: preverba obstoja tabele pred izvedbo (SQLite dev dobi tabelo
 * prek db push mirrorja, produkcijski Neon čaka ta korak — konzola Enterprise
 * → Shema migracije → web-portal). Samo centralne vloge (requireCentralRole).
 * Dokler tabela ne obstaja, javne rute portala odgovarjajo 404 (graceful
 * degradacija) — obstoječi POS/QR/kiosk tok se ne dotakne.
 */

const CREATE_PORTAL_TABLE = `CREATE TABLE IF NOT EXISTS "WebOrderPortal" (
  "id" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "pickupEnabled" BOOLEAN NOT NULL DEFAULT true,
  "deliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
  "deliveryFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "minOrder" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "prepMinutes" INTEGER NOT NULL DEFAULT 20,
  "note" TEXT NOT NULL DEFAULT '',
  "trackSecret" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebOrderPortal_pkey" PRIMARY KEY ("id")
)`

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "WebOrderPortal_locationId_key" ON "WebOrderPortal"("locationId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "WebOrderPortal_token_key" ON "WebOrderPortal"("token")`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "WebOrderPortal_token_idx" ON "WebOrderPortal"("token")`,
  `CREATE INDEX IF NOT EXISTS "WebOrderPortal_enabled_idx" ON "WebOrderPortal"("enabled")`,
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
    if (await tableExists('WebOrderPortal')) {
      skipped.push('WebOrderPortal')
    } else {
      await db.$executeRawUnsafe(CREATE_PORTAL_TABLE)
      applied.push('WebOrderPortal')
    }
    for (const ix of [...UNIQUE_INDEXES, ...INDEXES]) {
      await db.$executeRawUnsafe(ix)
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_WEB_PORTAL',
      entityType: 'SchemaMigration',
      entityId: 'web-portal',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-web-portal' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
