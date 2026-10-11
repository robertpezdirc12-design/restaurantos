import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok } from '@/lib/api'
import { nid } from '@/lib/map'
import { resetHaccpPlansProbe } from '@/lib/haccp-plans'

/**
 * Task 64 (v1.62.0) — HACCP načrti kontrol: produkcijski DDL korak.
 *
 * Issue-13 vzorec (Task 44 / migrate-issue13): datamodel vsebuje HaccpPlan (dev
 * SQLite prek `prisma db push`), produkcijski Neon Postgres pa čaka ta korak.
 * Rute /api/haccp/plans** graceful degradirajo (capability probe, 503/ddlPending)
 * dokler centralna vloga ne izvede tukajšnjih fiksnih DDL izjav.
 *
 * Samo za centralne vloge (requireCentralRole — DB vloga owner/admin; N4 audit P1).
 * Idempotentno: pred-aplicirna preverba (SELECT FROM "HaccpPlan") — ko tabela že
 * obstaja, se DDL NE izvede (alreadyApplied: true). Brez prostoformskega SQL —
 * izvajajo se izključno fiksne DDL izjave (enaka politika kot migrate-issue3/10/13).
 * DDL je identičen izhodu `prisma migrate diff --from-empty --to-schema-datamodel
 * prisma/schema.prisma` (obešena v worklogu Task 64) — po apliciranju drift izgine
 * in allowlist vnos 'haccp-plans' v scripts/drift-check.ts postane mrtva koda.
 * Audit: SCHEMA_MIGRATION_HACCP_PLANS.
 */
const DDL = [
  `CREATE TABLE "HaccpPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "HaccpCategory" NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "target" TEXT NOT NULL DEFAULT '',
    "threshold" TEXT NOT NULL DEFAULT '',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "responsible" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "locationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HaccpPlan_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX "HaccpPlan_locationId_idx" ON "HaccpPlan"("locationId")`,
  `CREATE INDEX "HaccpPlan_active_idx" ON "HaccpPlan"("active")`,
  `ALTER TABLE "HaccpPlan" ADD CONSTRAINT "HaccpPlan_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE SET NULL`,
]

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  try {
    // Idempotenca: tabela že obstaja (ponovni klic / dev SQLite, kjer je db push
    // tabelo že ustvaril) → nič ne izvajaj. Občasna klicu vrne enak obliko odgovora.
    await db.$queryRawUnsafe('SELECT 1 FROM "HaccpPlan" LIMIT 1')
    resetHaccpPlansProbe()
    return ok({ alreadyApplied: true, applied: [] })
  } catch {
    // tabela ne obstaja → apliciraj fiksni DDL
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.split('\n')[0].trim() + ' …' })
  }

  const after = await db.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT count(*) AS cnt FROM "HaccpPlan"`,
  )
  const planCount = Number(after[0]?.cnt ?? 0)

  // Probe reset — ista instanca takoj vidi capability (druge lambda instance
  // najpozneje čez 60 s TTL, brez redeploya).
  resetHaccpPlansProbe()

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_HACCP_PLANS',
        entityType: 'Schema',
        entityId: 'haccp_plan_create',
        details: JSON.stringify({ statements: DDL.length, planCountAfter: planCount }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied, planCountAfter: planCount })
}
