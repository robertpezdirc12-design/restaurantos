import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #24 (P2, v1.114.0) — etikete za pripravljeno hrano in odprte serije: DDL korak.
 *
 * NOVI tabeli:
 *  - PrepLabel (zamrznjen posnetek etikete ob izdaji: naziv, količina, serija,
 *    lokacija/območje, priprava/odprtje, ROK, pravilo, alergeni, odgovorna
 *    oseba, QR token = skrivnost, printCount/lastPrintedAt, status ACTIVE/VOID);
 *  - LabelShelfRule (potrjeno pravilo roka po pripravi/odprtju PO ARTIKLU —
 *    shelfLifeHours, potrditelj, revizijska sled; @@unique inventoryItemId).
 *
 * Skalarne vezave BREZ FK (StationTask/PrintJob vzorec). Idempotentno:
 * tabele/indeksi IF NOT EXISTS (Postgres); SQLite (dev prek db push že
 * prisotno) duplikate tiho preskoči. Samo centralne vloge
 * (requireCentralRole). Do DDL: /api/labels rute vračajo 503 s prijaznim
 * sporočilom (graceful — lot-governance/Priprava/BatchesCard tokovi se ne
 * dotaknejo).
 */

const CREATE_LABEL_TABLE = `CREATE TABLE IF NOT EXISTS "PrepLabel" (
  "id" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'batch',
  "batchId" TEXT,
  "preparationId" TEXT,
  "inventoryItemId" TEXT NOT NULL,
  "itemName" TEXT NOT NULL DEFAULT '',
  "itemUnit" TEXT NOT NULL DEFAULT '',
  "lotNumber" TEXT NOT NULL DEFAULT '',
  "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "area" TEXT NOT NULL DEFAULT '',
  "preparedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "ruleSource" TEXT NOT NULL DEFAULT 'none',
  "ruleHours" INTEGER,
  "ruleConfirmedBy" TEXT NOT NULL DEFAULT '',
  "needsReview" BOOLEAN NOT NULL DEFAULT false,
  "allergens" TEXT NOT NULL DEFAULT '[]',
  "preparedById" TEXT NOT NULL DEFAULT '',
  "preparedByName" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "token" TEXT NOT NULL,
  "printCount" INTEGER NOT NULL DEFAULT 0,
  "lastPrintedAt" TIMESTAMP(3),
  "note" TEXT NOT NULL DEFAULT '',
  "voidReason" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrepLabel_pkey" PRIMARY KEY ("id")
)`

const CREATE_RULE_TABLE = `CREATE TABLE IF NOT EXISTS "LabelShelfRule" (
  "id" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "shelfLifeHours" INTEGER NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "confirmedById" TEXT NOT NULL DEFAULT '',
  "confirmedByName" TEXT NOT NULL DEFAULT '',
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LabelShelfRule_pkey" PRIMARY KEY ("id")
)`

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "PrepLabel_token_key" ON "PrepLabel"("token")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "LabelShelfRule_inventoryItemId_key" ON "LabelShelfRule"("inventoryItemId")`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "PrepLabel_locationId_createdAt_idx" ON "PrepLabel"("locationId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "PrepLabel_batchId_idx" ON "PrepLabel"("batchId")`,
  `CREATE INDEX IF NOT EXISTS "PrepLabel_preparationId_idx" ON "PrepLabel"("preparationId")`,
  `CREATE INDEX IF NOT EXISTS "PrepLabel_inventoryItemId_idx" ON "PrepLabel"("inventoryItemId")`,
  `CREATE INDEX IF NOT EXISTS "PrepLabel_status_idx" ON "PrepLabel"("status")`,
]

async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
      table,
    )
    return Array.isArray(rows) && rows.length > 0
  } catch {
    // SQLite (dev/CI): information_schema ne obstaja — tabele so že prek db push
    return true
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  try {
    for (const [label, ddl] of [
      ['PrepLabel', CREATE_LABEL_TABLE],
      ['LabelShelfRule', CREATE_RULE_TABLE],
    ] as const) {
      if (await tableExists(label)) {
        skipped.push(label)
      } else {
        await db.$executeRawUnsafe(ddl)
        applied.push(label)
      }
    }
    for (const ix of [...UNIQUE_INDEXES, ...INDEXES]) {
      await db.$executeRawUnsafe(ix)
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_PREP_LABELS',
      entityType: 'SchemaMigration',
      entityId: 'prep-labels',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-prep-labels' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
