import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #10 P2-3 — enkratna produkcijska migracija sheme (Neon Postgres nima PrintJob tabele).
 * Samo za ADMIN (requirePermission employees.manage). Idempotentno (IF NOT EXISTS).
 * Brez prostoformskega SQL — izvajajo se IZKLJUČNO fiksné, aditivne DDL izjave
 * (enaka politika kot migrate-issue3). Audit: SCHEMA_MIGRATION_ISSUE10.
 */
const MIGRATIONS: { id: string; ddl: string[] }[] = [
  {
    id: 'issue10_print_job_table',
    ddl: [
      `CREATE TABLE IF NOT EXISTS "PrintJob" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL DEFAULT '',
        "locationId" TEXT,
        "kind" TEXT NOT NULL DEFAULT 'other',
        "refId" TEXT NOT NULL DEFAULT '',
        "target" TEXT NOT NULL DEFAULT 'agent',
        "status" TEXT NOT NULL DEFAULT 'printed',
        "error" TEXT NOT NULL DEFAULT '',
        "attempts" INTEGER NOT NULL DEFAULT 1,
        "device" TEXT NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
      )`,
      'CREATE INDEX IF NOT EXISTS "PrintJob_status_idx" ON "PrintJob"("status")',
      'CREATE INDEX IF NOT EXISTS "PrintJob_refId_idx" ON "PrintJob"("refId")',
      'CREATE INDEX IF NOT EXISTS "PrintJob_kind_idx" ON "PrintJob"("kind")',
      'CREATE INDEX IF NOT EXISTS "PrintJob_createdAt_idx" ON "PrintJob"("createdAt")',
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
        action: 'SCHEMA_MIGRATION_ISSUE10',
        entityType: 'Schema',
        entityId: 'print_job_table',
        details: JSON.stringify({ results }),
      },
    })
    .catch(() => null)

  return ok({ migrated: true, results })
}
