import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'
import { resetCashMovementsProbe, resetCashPolicyProbe, resetZReportCashColumnsProbe } from '@/lib/cash-movements'

/**
 * Issue #16 (P1/P2, v1.108.0) — blagajniški premiki denarja: DDL korak.
 *
 * 1) NOVA tabela CashMovement (main + mirror schema — vzorec HaccpPlan):
 *    knjiga neprodajnih premikov predala, scalar shiftId/locationId brez FK
 *    (EventLog vzorec #38 — fail-closed nad orphan ključi).
 * 2) 2 politika stolpca na RestaurantSettings (mirror-only do zdaj):
 *    cashVarianceThresholdCents INT / cashBlindCount BOOLEAN.
 * 3) 3 povzetek stolpca na ZReport (mirror-only do zdaj):
 *    cashPaidIn / cashPaidOut / cashGuestRefund (obstoječi typed cashDrops
 *    = odvod v sef — ujema se z definicijo, brez dvojnega polja).
 *
 * Idempotentno: preverba obstoja (tabela + stolpci) pred izvedbo; SQLite dev
 * dobi vse prek db push (mirror), produkcijski Neon čaka ta korak (konzola
 * Enterprise → Shema migracije → cash-movements). Samo centralne vloge.
 */
const CREATE_TABLE = `CREATE TABLE "CashMovement" (
  "id" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'paid_out',
  "direction" TEXT NOT NULL DEFAULT 'out',
  "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'EUR',
  "reasonId" TEXT,
  "reasonName" TEXT NOT NULL DEFAULT '',
  "reasonText" TEXT NOT NULL DEFAULT '',
  "note" TEXT NOT NULL DEFAULT '',
  "userId" TEXT NOT NULL,
  "userName" TEXT NOT NULL DEFAULT '',
  "deviceId" TEXT NOT NULL DEFAULT '',
  "receiptRef" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'confirmed',
  "voidedById" TEXT,
  "voidedByName" TEXT NOT NULL DEFAULT '',
  "voidedAt" TIMESTAMP,
  "voidReason" TEXT NOT NULL DEFAULT '',
  "reversalOfId" TEXT,
  "idempotencyKey" TEXT,
  "expectedAfter" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
)`

const DDL_INDEXES = [
  `CREATE UNIQUE INDEX "CashMovement_idempotencyKey_key" ON "CashMovement"("idempotencyKey")`,
  `CREATE INDEX "CashMovement_shiftId_idx" ON "CashMovement"("shiftId")`,
  `CREATE INDEX "CashMovement_locationId_idx" ON "CashMovement"("locationId")`,
  `CREATE INDEX "CashMovement_type_idx" ON "CashMovement"("type")`,
  `CREATE INDEX "CashMovement_status_idx" ON "CashMovement"("status")`,
  `CREATE INDEX "CashMovement_createdAt_idx" ON "CashMovement"("createdAt")`,
]

const SETTINGS_DDL: { col: string; stmt: string }[] = [
  {
    col: 'cashVarianceThresholdCents',
    stmt: `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "cashVarianceThresholdCents" INTEGER NOT NULL DEFAULT 0`,
  },
  {
    col: 'cashBlindCount',
    stmt: `ALTER TABLE "RestaurantSettings" ADD COLUMN IF NOT EXISTS "cashBlindCount" BOOLEAN NOT NULL DEFAULT false`,
  },
]

const ZREPORT_DDL: { col: string; stmt: string }[] = [
  {
    col: 'cashPaidIn',
    stmt: `ALTER TABLE "ZReport" ADD COLUMN IF NOT EXISTS "cashPaidIn" DECIMAL(12,2) NOT NULL DEFAULT 0`,
  },
  {
    col: 'cashPaidOut',
    stmt: `ALTER TABLE "ZReport" ADD COLUMN IF NOT EXISTS "cashPaidOut" DECIMAL(12,2) NOT NULL DEFAULT 0`,
  },
  {
    col: 'cashGuestRefund',
    stmt: `ALTER TABLE "ZReport" ADD COLUMN IF NOT EXISTS "cashGuestRefund" DECIMAL(12,2) NOT NULL DEFAULT 0`,
  },
]

async function tableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT 1 FROM "CashMovement" LIMIT 1`)
    return true
  } catch {
    return false
  }
}

async function columnsPresent(table: string, cols: string[]): Promise<boolean> {
  for (const col of cols) {
    try {
      await db.$queryRawUnsafe(`SELECT "${col}" FROM "${table}" LIMIT 1`)
    } catch {
      return false
    }
  }
  return true
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const tableReady = await tableExists()
  const settingsReady = await columnsPresent('RestaurantSettings', SETTINGS_DDL.map((d) => d.col))
  const zreportReady = await columnsPresent('ZReport', ZREPORT_DDL.map((d) => d.col))

  if (tableReady && settingsReady && zreportReady) {
    return ok({ alreadyApplied: true, applied: [] })
  }

  const applied: string[] = []
  if (!tableReady) {
    await db.$executeRawUnsafe(CREATE_TABLE)
    applied.push('CREATE TABLE CashMovement')
    for (const idx of DDL_INDEXES) {
      await db.$executeRawUnsafe(idx)
      applied.push(idx.slice(0, 60))
    }
  }
  if (!settingsReady) {
    for (const d of SETTINGS_DDL) {
      try {
        await db.$executeRawUnsafe(d.stmt)
        applied.push(`RestaurantSettings.${d.col}`)
      } catch (e) {
        // SQLite ne pozna IF NOT EXISTS na ADD COLUMN — a stolpec je morda
        // že prisoten (db push mirror). Preveri in nadaljuj (idempotenca).
        const present = await columnsPresent('RestaurantSettings', [d.col]).catch(() => false)
        if (!present) throw e
      }
    }
  }
  if (!zreportReady) {
    for (const d of ZREPORT_DDL) {
      try {
        await db.$executeRawUnsafe(d.stmt)
        applied.push(`ZReport.${d.col}`)
      } catch (e) {
        const present = await columnsPresent('ZReport', [d.col]).catch(() => false)
        if (!present) throw e
      }
    }
  }

  // po uspešnem DDL takoj razveljavi probe (brez čakanja na TTL)
  resetCashMovementsProbe(true)
  resetCashPolicyProbe(true)
  resetZReportCashColumnsProbe(true)

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_CASH_MOVEMENTS',
        entityType: 'Schema',
        entityId: 'cash_movements',
        details: JSON.stringify({
          statements: applied.length,
          table: !tableReady,
          settingsColumns: SETTINGS_DDL.filter((d) => applied.includes(`RestaurantSettings.${d.col}`)).map((d) => d.col),
          zreportColumns: ZREPORT_DDL.filter((d) => applied.includes(`ZReport.${d.col}`)).map((d) => d.col),
        }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
