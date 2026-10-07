import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, jstr } from '@/lib/map'

/**
 * Issue #1 §6 — enkratna produkcijska migracija sheme (Neon Postgres nima teh stolpcev).
 * Samo za ADMIN (requirePermission employees.manage). Idempotentno (ADD COLUMN IF NOT EXISTS).
 * Brez prostoformskega SQL — izvajajo se IZKLJUČNO fiksne, aditivne ALTER izjave.
 * (Vzorec iz issue #3: /api/admin/migrate-issue3)
 */
const MIGRATIONS: { id: string; ddl: string[] }[] = [
  {
    id: 'issue1_s6_discount_happy_hour',
    ddl: [
      'ALTER TABLE "Discount" ADD COLUMN IF NOT EXISTS "happyDays" TEXT NOT NULL DEFAULT \'\'',
      'ALTER TABLE "Discount" ADD COLUMN IF NOT EXISTS "happyFromHour" INTEGER',
      'ALTER TABLE "Discount" ADD COLUMN IF NOT EXISTS "happyToHour" INTEGER',
      'ALTER TABLE "Discount" ADD COLUMN IF NOT EXISTS "targetCategoryIds" TEXT NOT NULL DEFAULT \'\'',
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
          applied.push(ddl.slice(0, 60))
        } catch (e) {
          const msg = (e as Error).message || ''
          if (msg.includes('already exists')) continue // idempotentno — preskoči
          throw e
        }
      }
      results.push({ id: m.id, applied, skipped: applied.length === 0 })
    }
    await db.auditLog.create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_ISSUE1_S6',
        entityType: 'Schema',
        entityId: 'issue1_s6_discount_happy_hour',
        details: jstr({ results }),
      },
    })
    return ok({ results })
  } catch (e) {
    console.error('[migrate-issue1-s6] napaka:', e)
    return fail('Migracija ni uspela — preveri strežniški log.', 500)
  }
}
