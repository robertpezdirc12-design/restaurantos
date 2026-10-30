import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * OSS-1 (v1.200.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — vzdrževanje
 * opreme: DDL korak.
 *
 * NOVI tabeli Equipment (register naprav po lokaciji: vrsta, serijska,
 * namestitev, status active/broken/retired) in EquipmentMaintenancePlan
 * (servisni načrt: naslov, interval dni, zadnji/naslednji servis, pavza).
 * Overdue zastavice so izpeljane ob branju (nextDueAt < danes) — brez cron
 * stanja. Skalarne vezave brez FK (PayrollSurchargeRate konvencija).
 * Idempotentno: tabela/indeksi IF NOT EXISTS (Postgres); SQLite (dev prek
 * db push že prisotno) duplikate tiho preskoči. Samo centralne vloge
 * (requireCentralRole). Do DDL: /api/equipment* → 503.
 */

const CREATE_EQUIPMENT_TABLE = `CREATE TABLE IF NOT EXISTS "Equipment" (
  "id" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'other',
  "serialNumber" TEXT,
  "installedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'active',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdById" TEXT,
  CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
)`

const CREATE_PLAN_TABLE = `CREATE TABLE IF NOT EXISTS "EquipmentMaintenancePlan" (
  "id" TEXT NOT NULL,
  "equipmentId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "intervalDays" INTEGER NOT NULL DEFAULT 90,
  "lastServicedAt" TIMESTAMP(3),
  "nextDueAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedById" TEXT,
  CONSTRAINT "EquipmentMaintenancePlan_pkey" PRIMARY KEY ("id")
)`

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "Equipment_locationId_idx" ON "Equipment"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "Equipment_status_idx" ON "Equipment"("status")`,
  `CREATE INDEX IF NOT EXISTS "EquipmentMaintenancePlan_equipmentId_idx" ON "EquipmentMaintenancePlan"("equipmentId")`,
  `CREATE INDEX IF NOT EXISTS "EquipmentMaintenancePlan_nextDueAt_idx" ON "EquipmentMaintenancePlan"("nextDueAt")`,
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
    if (await tableExists('Equipment')) {
      skipped.push('Equipment')
    } else {
      await db.$executeRawUnsafe(CREATE_EQUIPMENT_TABLE)
      applied.push('Equipment')
    }
    if (await tableExists('EquipmentMaintenancePlan')) {
      skipped.push('EquipmentMaintenancePlan')
    } else {
      await db.$executeRawUnsafe(CREATE_PLAN_TABLE)
      applied.push('EquipmentMaintenancePlan')
    }
    for (const ix of INDEXES) {
      await db.$executeRawUnsafe(ix)
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_EQUIPMENT_MAINTENANCE',
      entityType: 'SchemaMigration',
      entityId: 'equipment-maintenance',
      details: jstr({
        applied,
        skipped: skipped.length,
        endpoint: '/api/admin/migrate-equipment-maintenance',
      }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
