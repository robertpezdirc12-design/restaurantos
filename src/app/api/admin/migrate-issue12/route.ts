import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #12 §3 — enkratna produkcijska migracija sheme (Neon Postgres): MFA polja
 * na Employee (mfaSecret, mfaEnabled, mfaRecoveryCodes, mfaEnrolledAt).
 * Samo za centralne vloge (requireCentralRole — DB vloga owner/admin; N4 audit P1).
 * Idempotentno (IF NOT EXISTS).
 * Brez prostoformskega SQL — izvajajo se IZKLJUČNO fiksne, aditivne DDL izjave
 * (politika migrate-issue3/#10/#11). Audit: SCHEMA_MIGRATION_ISSUE12.
 */
const MIGRATIONS: { id: string; ddl: string[] }[] = [
  {
    id: 'issue12_employee_mfa_fields',
    ddl: [
      'ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT',
      'ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "mfaEnabled" BOOLEAN NOT NULL DEFAULT false',
      "ALTER TABLE \"Employee\" ADD COLUMN IF NOT EXISTS \"mfaRecoveryCodes\" JSONB NOT NULL DEFAULT '[]'",
      'ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "mfaEnrolledAt" TIMESTAMP(3)',
    ],
  },
]

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const results: { id: string; statements: number }[] = []
  for (const m of MIGRATIONS) {
    for (const ddl of m.ddl) {
      await db.$executeRawUnsafe(ddl)
      applied.push(ddl.slice(0, 72))
    }
    results.push({ id: m.id, statements: m.ddl.length })
  }

  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_ISSUE12',
      entityType: 'Employee',
      entityId: 'mfa-fields',
      details: `applied=${results.reduce((a, r) => a + r.statements, 0)} (aditivno, idempotentno)`,
    },
  }).catch(() => {})

  const columns = await db.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Employee' AND column_name LIKE 'mfa%'`
  )

  return ok({ applied: results, columns: columns.map((c) => c.column_name) }, 201)
}
