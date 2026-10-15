import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje iz POS-a: DDL korak.
 *
 * NOVA tabela ManagerCall (življenjski cikel zahtev — statusi so PROSTE
 * vrednosti String stolpca, brez enum DDL): skalarne vezave brez FK
 * (EventLog/CashMovement/ReservationWidget vzorec), snapshot imen
 * (requestorName/acknowledgedByName/…), dostavna evidencа
 * (deliveryStatus/notifiedCount), eskalacijski krogi (escalatedCount/
 * lastEscalatedAt), idempotencyKey @unique.
 *
 * Idempotentno: preverba obstoja pred izvedbo (dev SQLite dobi tabelo prek
 * db push zrcala; produkcijski Neon čaka ta korak — konzola Enterprise →
 * Shema migracije → manager-call). Samo centralne vloge (requireCentralRole).
 * Do DDL: rute klica vodja odgovarjajo 503 (graceful — obstoječi POS tok
 * se ne dotakne).
 */

const CREATE_CALL_TABLE = `CREATE TABLE IF NOT EXISTS "ManagerCall" (
  "id" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "requestorId" TEXT NOT NULL,
  "requestorName" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "note" TEXT NOT NULL DEFAULT '',
  "orderId" TEXT,
  "orderNumber" TEXT,
  "tableNumber" INTEGER,
  "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
  "notifiedCount" INTEGER NOT NULL DEFAULT 0,
  "escalatedCount" INTEGER NOT NULL DEFAULT 0,
  "lastEscalatedAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedById" TEXT,
  "acknowledgedByName" TEXT,
  "inProgressAt" TIMESTAMP(3),
  "inProgressById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  "resolvedByName" TEXT,
  "resolutionNote" TEXT NOT NULL DEFAULT '',
  "cancelledAt" TIMESTAMP(3),
  "cancelledById" TEXT,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManagerCall_pkey" PRIMARY KEY ("id")
)`

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagerCall_idempotencyKey_key" ON "ManagerCall"("idempotencyKey")`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "ManagerCall_locationId_status_idx" ON "ManagerCall"("locationId", "status")`,
  `CREATE INDEX IF NOT EXISTS "ManagerCall_requestorId_createdAt_idx" ON "ManagerCall"("requestorId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ManagerCall_createdAt_idx" ON "ManagerCall"("createdAt")`,
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
    if (await tableExists('ManagerCall')) {
      skipped.push('ManagerCall')
    } else {
      await db.$executeRawUnsafe(CREATE_CALL_TABLE)
      applied.push('ManagerCall')
    }
    for (const ix of [...UNIQUE_INDEXES, ...INDEXES]) {
      await db.$executeRawUnsafe(ix)
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_MANAGER_CALL',
      entityType: 'SchemaMigration',
      entityId: 'manager-call',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-manager-call' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
