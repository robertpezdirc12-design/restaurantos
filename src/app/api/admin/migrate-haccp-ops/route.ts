import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { resetHaccpOpsProbe } from '@/lib/haccp-ops'

/**
 * Issue #20 (P1/P2, v1.109.0) — operativni HACCP tok: DDL korak.
 *
 * 1) HaccpEntry: 12 aditivnih stolpcev (planId/planName/planVersion/
 *    ruleSnapshot/measureKind/numericValue/unit/occurrenceKey/dueAt/
 *    entryState/source/closedAt) + 3 indeksi — vezava na načrt,
 *    strukturirana meritev, življenjski cikel odstopanja.
 * 2) HaccpPlan: 13 aditivnih stolpcev (measureKind/unit/direction/okLimit/
 *    warnLimit/rangeMin/rangeMax/critical/requiresVerification/dueTime/
 *    weekday/monthDay/version) — operativna pravila + različica.
 * 3) NOVA tabela HaccpAction (revizijski dogodki: korektivni ukrep /
 *    verifikacija — append-only) + 3 indeksi.
 *
 * Idempotentno: preverba obstoja (stolpci/tabela) pred izvedbo; SQLite dev
 * dobi vse prek db push (mirror), produkcijski Neon čaka ta korak (konzola
 * Enterprise → Shema migracije → haccp-ops). Samo centralne vloge
 * (requireCentralRole). Stare vrstice ostanejo 'legacy' — obstoječi tokovi
 * se ne dotaknejo (graceful degradacija prek haccpOpsColumnsReady probe).
 */

const ENTRY_DDL: { col: string; stmt: string }[] = [
  { col: 'planId', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "planId" TEXT NOT NULL DEFAULT ''` },
  { col: 'planName', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "planName" TEXT NOT NULL DEFAULT ''` },
  { col: 'planVersion', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "planVersion" INTEGER NOT NULL DEFAULT 0` },
  { col: 'ruleSnapshot', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "ruleSnapshot" JSONB NOT NULL DEFAULT '{}'` },
  { col: 'measureKind', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "measureKind" TEXT NOT NULL DEFAULT ''` },
  { col: 'numericValue', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "numericValue" DECIMAL(10,2)` },
  { col: 'unit', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "unit" TEXT NOT NULL DEFAULT ''` },
  { col: 'occurrenceKey', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "occurrenceKey" TEXT NOT NULL DEFAULT ''` },
  { col: 'dueAt', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3)` },
  { col: 'entryState', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "entryState" TEXT NOT NULL DEFAULT 'legacy'` },
  { col: 'source', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual'` },
  { col: 'closedAt', stmt: `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3)` },
]

const ENTRY_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "HaccpEntry_planId_idx" ON "HaccpEntry"("planId")`,
  `CREATE INDEX IF NOT EXISTS "HaccpEntry_occurrenceKey_idx" ON "HaccpEntry"("occurrenceKey")`,
  `CREATE INDEX IF NOT EXISTS "HaccpEntry_entryState_idx" ON "HaccpEntry"("entryState")`,
]

const PLAN_DDL: { col: string; stmt: string }[] = [
  { col: 'measureKind', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "measureKind" TEXT NOT NULL DEFAULT 'confirm'` },
  { col: 'unit', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "unit" TEXT NOT NULL DEFAULT ''` },
  { col: 'direction', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "direction" TEXT NOT NULL DEFAULT 'none'` },
  { col: 'okLimit', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "okLimit" DECIMAL(10,2)` },
  { col: 'warnLimit', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "warnLimit" DECIMAL(10,2)` },
  { col: 'rangeMin', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "rangeMin" DECIMAL(10,2)` },
  { col: 'rangeMax', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "rangeMax" DECIMAL(10,2)` },
  { col: 'critical', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "critical" BOOLEAN NOT NULL DEFAULT false` },
  { col: 'requiresVerification', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "requiresVerification" BOOLEAN NOT NULL DEFAULT true` },
  { col: 'dueTime', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "dueTime" TEXT NOT NULL DEFAULT '10:00'` },
  { col: 'weekday', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "weekday" INTEGER` },
  { col: 'monthDay', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "monthDay" INTEGER` },
  { col: 'version', stmt: `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1` },
]

const CREATE_ACTION_TABLE = `CREATE TABLE IF NOT EXISTS "HaccpAction" (
  "id" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "locationId" TEXT,
  "kind" TEXT NOT NULL,
  "method" TEXT NOT NULL DEFAULT '',
  "note" TEXT NOT NULL DEFAULT '',
  "outcome" TEXT NOT NULL DEFAULT '',
  "recheckValue" DECIMAL(10,2),
  "performedById" TEXT NOT NULL DEFAULT '',
  "performedByName" TEXT NOT NULL DEFAULT '',
  "managerial" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HaccpAction_pkey" PRIMARY KEY ("id")
)`

const ACTION_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "HaccpAction_entryId_idx" ON "HaccpAction"("entryId")`,
  `CREATE INDEX IF NOT EXISTS "HaccpAction_locationId_idx" ON "HaccpAction"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "HaccpAction_kind_idx" ON "HaccpAction"("kind")`,
]

async function columnExists(table: string, col: string): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      table,
      col,
    )
    return Array.isArray(rows) && rows.length > 0
  } catch {
    // SQLite (dev/CI): information_schema ne obstaja — tabela je že prek db push
    return true
  }
}

async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
      table,
    )
    return Array.isArray(rows) && rows.length > 0
  } catch {
    return true
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  try {
    // 1) HaccpEntry stolpci + indeksi
    for (const d of ENTRY_DDL) {
      if (await columnExists('HaccpEntry', d.col)) {
        skipped.push(`HaccpEntry.${d.col}`)
      } else {
        await db.$executeRawUnsafe(d.stmt)
        applied.push(`HaccpEntry.${d.col}`)
      }
    }
    for (const ix of ENTRY_INDEXES) {
      await db.$executeRawUnsafe(ix)
    }

    // 2) HaccpPlan stolpci
    for (const d of PLAN_DDL) {
      if (await columnExists('HaccpPlan', d.col)) {
        skipped.push(`HaccpPlan.${d.col}`)
      } else {
        await db.$executeRawUnsafe(d.stmt)
        applied.push(`HaccpPlan.${d.col}`)
      }
    }

    // 3) HaccpAction tabela + indeksi
    if (await tableExists('HaccpAction')) {
      skipped.push('HaccpAction')
    } else {
      await db.$executeRawUnsafe(CREATE_ACTION_TABLE)
      applied.push('HaccpAction')
    }
    for (const ix of ACTION_INDEXES) {
      await db.$executeRawUnsafe(ix)
    }

    // DDL aplikacija v istem procesu takoj vsili novo stanje probe
    resetHaccpOpsProbe(true)

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_HACCP_OPS',
      entityType: 'SchemaMigration',
      entityId: 'haccp-ops',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-haccp-ops' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    resetHaccpOpsProbe() // naslednji klic naj si ponovno izmeri stanje
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
