import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #11 — enkratna produkcijska migracija sheme (Neon Postgres: enterprise
 * entitete + EventLog + nove vloge). Samo za ADMIN (requirePermission employees.manage).
 * Idempotentno (IF NOT EXISTS / ADD VALUE IF NOT EXISTS). Brez prostoformskega SQL —
 * izvajajo se IZKLJUČNO fiksne, aditivne DDL izjave (politika migrate-issue3/#10).
 * Audit: SCHEMA_MIGRATION_ISSUE11.
 */
const MIGRATIONS: { id: string; ddl: string[] }[] = [
  {
    id: 'issue11_enterprise_tables',
    ddl: [
      `CREATE TABLE IF NOT EXISTS "Organization" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "slug" TEXT NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS "Organization_slug_key" ON "Organization"("slug")',
      `CREATE TABLE IF NOT EXISTS "Brand" (
        "id" TEXT NOT NULL,
        "organizationId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
      )`,
      'CREATE INDEX IF NOT EXISTS "Brand_organizationId_idx" ON "Brand"("organizationId")',
      `CREATE TABLE IF NOT EXISTS "Property" (
        "id" TEXT NOT NULL,
        "brandId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "address" TEXT NOT NULL DEFAULT '',
        "city" TEXT NOT NULL DEFAULT '',
        "country" TEXT NOT NULL DEFAULT 'SI',
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
      )`,
      'CREATE INDEX IF NOT EXISTS "Property_brandId_idx" ON "Property"("brandId")',
      `CREATE TABLE IF NOT EXISTS "Workstation" (
        "id" TEXT NOT NULL,
        "propertyId" TEXT NOT NULL,
        "locationId" TEXT,
        "name" TEXT NOT NULL,
        "kind" TEXT NOT NULL DEFAULT 'pos',
        "stationKey" TEXT NOT NULL DEFAULT '',
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "lastSeenAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Workstation_pkey" PRIMARY KEY ("id")
      )`,
      'CREATE INDEX IF NOT EXISTS "Workstation_propertyId_idx" ON "Workstation"("propertyId")',
      'CREATE INDEX IF NOT EXISTS "Workstation_locationId_idx" ON "Workstation"("locationId")',
      `CREATE TABLE IF NOT EXISTS "EventLog" (
        "id" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "entityType" TEXT NOT NULL DEFAULT '',
        "entityId" TEXT NOT NULL DEFAULT '',
        "payload" TEXT NOT NULL DEFAULT '{}',
        "status" TEXT NOT NULL DEFAULT 'pending',
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "error" TEXT NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "processedAt" TIMESTAMP(3),
        CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
      )`,
      'CREATE INDEX IF NOT EXISTS "EventLog_type_idx" ON "EventLog"("type")',
      'CREATE INDEX IF NOT EXISTS "EventLog_status_idx" ON "EventLog"("status")',
      'CREATE INDEX IF NOT EXISTS "EventLog_createdAt_idx" ON "EventLog"("createdAt")',
    ],
  },
  {
    id: 'issue11_location_revenuecenter_property',
    ddl: [
      'ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "propertyId" TEXT',
      'CREATE INDEX IF NOT EXISTS "Location_propertyId_idx" ON "Location"("propertyId")',
      'ALTER TABLE "RevenueCenter" ADD COLUMN IF NOT EXISTS "propertyId" TEXT',
      'CREATE INDEX IF NOT EXISTS "RevenueCenter_propertyId_idx" ON "RevenueCenter"("propertyId")',
    ],
  },
  {
    id: 'issue11_new_roles_enum',
    ddl: [
      "ALTER TYPE \"EmployeeRole\" ADD VALUE IF NOT EXISTS 'group_owner'",
      "ALTER TYPE \"EmployeeRole\" ADD VALUE IF NOT EXISTS 'org_admin'",
      "ALTER TYPE \"EmployeeRole\" ADD VALUE IF NOT EXISTS 'property_manager'",
      "ALTER TYPE \"EmployeeRole\" ADD VALUE IF NOT EXISTS 'warehouse'",
      "ALTER TYPE \"EmployeeRole\" ADD VALUE IF NOT EXISTS 'accounting'",
    ],
  },
]

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user

  const results: { id: string; applied: string[]; skipped: boolean }[] = []
  try {
    for (const m of MIGRATIONS) {
      const applied: string[] = []
      for (const ddl of m.ddl) {
        try {
          await db.$executeRawUnsafe(ddl)
          applied.push(ddl.replace(/\s+/g, ' ').slice(0, 60))
        } catch (e) {
          const msg = (e as Error).message || ''
          if (msg.includes('already exists')) continue // idempotentno — preskoči
          throw e
        }
      }
      results.push({ id: m.id, applied, skipped: applied.length === 0 })
    }
  } catch (e) {
    return fail(`Migracija ni uspela: ${(e as Error).message}`, 500)
  }

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_ISSUE11',
        entityType: 'Schema',
        entityId: 'enterprise_foundation',
        details: JSON.stringify({ results: results.map((r) => ({ id: r.id, count: r.applied.length })) }),
      },
    })
    .catch(() => null)

  return ok({ migrated: true, results: results.map((r) => ({ id: r.id, appliedCount: r.applied.length, skipped: r.skipped })) })
}
