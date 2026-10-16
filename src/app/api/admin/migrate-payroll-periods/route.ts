import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #22 (P2, v1.115.0) — obračun plač pripravljeni podatki: DDL korak.
 *
 * NOVI tabeli:
 *  - PayrollPeriod (agregatni zaklep nad obstoječo evidenco časa — BREZ novega
 *    časovnega sistema: TimeEntry/StaffShift/TipPool/TipDistribution ostanejo
 *    edini vir ur; obdobje po lokaciji s časovnim pasom, UTC meji lokalne
 *    polnoči, periodEnd EKSKLUZIVEN, status draft/closed, zaklep/ponovno
 *    odprtje z razlogom (version = 1 + reopenCount), števci vnosi/potrjene
 *    ure/izjeme, centni zneski bruto plače in napitnin);
 *  - PayrollExport (zabeležka vsakega izvoza kot verzija/dokaz: zaporedna
 *    številka 1..N, format csv/json, contentHash sha256 kanonikalne vsebine,
 *    rowDigest za primerjavo različic BREZ shranjevanja vsebine — PII ostaja
 *    izven DB/audita; @@unique periodId+seq).
 *
 * Skalarne vezave brez FK (PrepLabel/PrintJob vzorec). Idempotentno:
 * tabele/indeksi IF NOT EXISTS (Postgres); SQLite (dev prek db push že
 * prisotno) duplikate tiho preskoči. Samo centralne vloge
 * (requireCentralRole). Do DDL: /api/payroll* rute vračajo 503 s prijaznim
 * sporočilom (graceful — timeclock/tips/urnik tokovi se ne dotaknejo).
 */

const CREATE_PERIOD_TABLE = `CREATE TABLE IF NOT EXISTS "PayrollPeriod" (
  "id" TEXT NOT NULL,
  "locationId" TEXT,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Europe/Ljubljana',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "closedAt" TIMESTAMP(3),
  "closedById" TEXT,
  "closeNote" TEXT NOT NULL DEFAULT '',
  "reopenCount" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "entryCount" INTEGER NOT NULL DEFAULT 0,
  "approvedCount" INTEGER NOT NULL DEFAULT 0,
  "exceptionCount" INTEGER NOT NULL DEFAULT 0,
  "netMinutesApproved" INTEGER NOT NULL DEFAULT 0,
  "grossPayCents" INTEGER NOT NULL DEFAULT 0,
  "cashTipsCents" INTEGER NOT NULL DEFAULT 0,
  "cardTipsCents" INTEGER NOT NULL DEFAULT 0,
  "tipsPendingCents" INTEGER NOT NULL DEFAULT 0,
  "tipsPaidCents" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
)`

const CREATE_EXPORT_TABLE = `CREATE TABLE IF NOT EXISTS "PayrollExport" (
  "id" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "format" TEXT NOT NULL DEFAULT 'csv',
  "contentHash" TEXT NOT NULL,
  "grossPayCents" INTEGER NOT NULL DEFAULT 0,
  "netMinutesTotal" INTEGER NOT NULL DEFAULT 0,
  "tipsCentsTotal" INTEGER NOT NULL DEFAULT 0,
  "entryCount" INTEGER NOT NULL DEFAULT 0,
  "changedEntries" INTEGER NOT NULL DEFAULT 0,
  "identicalToPrevious" BOOLEAN NOT NULL DEFAULT false,
  "rowDigest" TEXT NOT NULL DEFAULT '',
  "exportedById" TEXT,
  "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "PayrollExport_pkey" PRIMARY KEY ("id")
)`

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollExport_periodId_seq_key" ON "PayrollExport"("periodId", "seq")`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "PayrollPeriod_locationId_idx" ON "PayrollPeriod"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "PayrollPeriod_periodStart_periodEnd_idx" ON "PayrollPeriod"("periodStart", "periodEnd")`,
  `CREATE INDEX IF NOT EXISTS "PayrollPeriod_status_idx" ON "PayrollPeriod"("status")`,
  `CREATE INDEX IF NOT EXISTS "PayrollExport_periodId_idx" ON "PayrollExport"("periodId")`,
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
      ['PayrollPeriod', CREATE_PERIOD_TABLE],
      ['PayrollExport', CREATE_EXPORT_TABLE],
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
      action: 'SCHEMA_MIGRATION_PAYROLL_PERIODS',
      entityType: 'SchemaMigration',
      entityId: 'payroll-periods',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-payroll-periods' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
