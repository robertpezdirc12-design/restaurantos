import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { resetTransferTablesProbe } from '@/lib/transfer-schema'

/**
 * Issue #8 (P2, v1.116.0) — medlokacijski prenosi zalog: DDL korak.
 *
 * NOVI tabeli:
 *  - StockTransfer (glava: številka TRF-dan-zaporedna @unique, izvorna/ciljna
 *    lokacija kot SKALAR brez FK, status DRAFT/DISPATCHED/RECEIVED/PARTIAL/
 *    CANCELLED prosti niz, idempotencyKey @@unique(from+key), odprem/prevzem/
 *    preklic timestamps+ById, note/cancelReason);
 *  - StockTransferItem (transferId FK Cascade — EDINA prava relacija,
 *    inventoryItemId skalar, snapshot itemName/unit, requested/dispatched/
 *    received/damaged Decimal(12,3), unitCost Decimal(12,2)?, izvorna serija
 *    batchId/lotNumber/expiryDate, targetItemId razrešen ob prevzemu).
 *
 * Skalarne vezave brez FK na Location/InventoryItem (PrepLabel/PayrollPeriod
 * vzorec). Idempotentno: tabele/indeksi IF NOT EXISTS (Postgres); SQLite
 * (dev prek db push že prisotno) duplikate tiho preskoči. FK (Cascade) se
 * dodá SAMO ob prvi izdelavi tabele postavk (ponovni klic preskoči — paylink
 * vzorec). Samo centralne vloge (requireCentralRole). Do DDL: /api/transfers*
 * rute vračajo 503 s prijaznim sporočilom (graceful — zaloga/serije/nabava
 * tokovi se ne dotaknejo).
 */

const CREATE_TRANSFER_TABLE = `CREATE TABLE IF NOT EXISTS "StockTransfer" (
  "id" TEXT NOT NULL,
  "transferNumber" TEXT NOT NULL,
  "fromLocationId" TEXT NOT NULL,
  "toLocationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "note" TEXT NOT NULL DEFAULT '',
  "idempotencyKey" TEXT,
  "createdById" TEXT,
  "dispatchedById" TEXT,
  "dispatchedAt" TIMESTAMP(3),
  "receivedById" TEXT,
  "receivedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "cancelReason" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
)`

const CREATE_ITEM_TABLE = `CREATE TABLE IF NOT EXISTS "StockTransferItem" (
  "id" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "itemName" TEXT NOT NULL DEFAULT '',
  "unit" TEXT NOT NULL DEFAULT '',
  "requestedQty" DECIMAL(12,3) NOT NULL,
  "dispatchedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "receivedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "damagedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "unitCost" DECIMAL(12,2),
  "batchId" TEXT,
  "lotNumber" TEXT,
  "expiryDate" TIMESTAMP(3),
  "targetItemId" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockTransferItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE
)`

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "StockTransfer_transferNumber_key" ON "StockTransfer"("transferNumber")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "StockTransfer_fromLocationId_idempotencyKey_key" ON "StockTransfer"("fromLocationId", "idempotencyKey")`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "StockTransfer_fromLocationId_status_idx" ON "StockTransfer"("fromLocationId", "status")`,
  `CREATE INDEX IF NOT EXISTS "StockTransfer_toLocationId_status_idx" ON "StockTransfer"("toLocationId", "status")`,
  `CREATE INDEX IF NOT EXISTS "StockTransfer_status_createdAt_idx" ON "StockTransfer"("status", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "StockTransfer_createdAt_idx" ON "StockTransfer"("createdAt")`,
  `CREATE INDEX IF NOT EXISTS "StockTransferItem_transferId_idx" ON "StockTransferItem"("transferId")`,
  `CREATE INDEX IF NOT EXISTS "StockTransferItem_inventoryItemId_idx" ON "StockTransferItem"("inventoryItemId")`,
  `CREATE INDEX IF NOT EXISTS "StockTransferItem_targetItemId_idx" ON "StockTransferItem"("targetItemId")`,
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
      ['StockTransfer', CREATE_TRANSFER_TABLE],
      ['StockTransferItem', CREATE_ITEM_TABLE],
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

    // capability probe takoj izklopi 503 (ista lamba v minuto TTL sicer čakala)
    resetTransferTablesProbe()

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_STOCK_TRANSFERS',
      entityType: 'SchemaMigration',
      entityId: 'stock-transfers',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-stock-transfers' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
