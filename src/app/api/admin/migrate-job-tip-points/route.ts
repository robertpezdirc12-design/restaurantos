import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * PRIMERJAVA §40 (v1.266.0) — NAPITNINSKE TOČKE PO VLOGI
 * (Square Vol 16, 5. 11. 2026 »Split pooled tips by points assigned to
 * each role«): 1 nov stolpec na Job:
 *   - "tipPoints" INTEGER NOT NULL DEFAULT 0
 *     (privzete točke VLOGI za delitev napitnin — 0 = vloga nima
 *     predpolnitve, vnos ostane ročen; zaposleni sledita svoji vlogi
 *     tega dne (TimeEntry.jobId → primarna EmployeeJob), vnos je vedno
 *     prilagodljiv per oseba pred zaključkom dneva)
 *
 * Do DDL: GET /api/jobs vrača tipPointsDdlActive false (JobsCard ne
 * pokaže urejanja točk, graceful), GET /api/tips predpolni prazne
 * vrednosti (ročen vnos deluje naprej), PATCH /api/jobs/[id] s tipPoints
 * → 503 s potjo do te konzole (issue-13/exception-policy/
 * receipt-display-policy/kds-expo-fire vzorec: dev SQLite dobi stolpec
 * prek mirror sheme, produkcijski Neon Postgres čaka ta korak).
 * Idempotentno.
 */
const DDL = [
  `ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "tipPoints" INTEGER NOT NULL DEFAULT 0`,
]

async function tipPointsColumnPresent(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "tipPoints" FROM "Job" LIMIT 1`)
    return true
  } catch {
    return false
  }
}

async function jobTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "Job" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  if (await tipPointsColumnPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await jobTableExists())) {
    return fail('Tabela Job ne obstaja — baza ni inicializirana.', 409)
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.slice(0, 90) })
  }

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_JOB_TIP_POINTS',
        entityType: 'Schema',
        entityId: 'job_tip_points',
        details: JSON.stringify({ statements: DDL.length, default: 0 }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
