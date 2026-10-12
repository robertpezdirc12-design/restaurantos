import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * OPS-4 (v1.67.0) — migracija 'cleaner-role': nova DB vloga čistilke.
 *
 * Postgres (produkcija, Neon): ALTER TYPE "EmployeeRole" ADD VALUE IF NOT EXISTS
 * 'cleaner' — enak vzorec kot migrate-issue11 (issue11_new_roles_enum). PG 12+
 * dovoli ADD VALUE v transakciji, dokler nova vrednost ni rabljena v isti
 * transakciji — tu je izjava osamljena ($executeRawUnsafe, en klic).
 *
 * SQLite (dev zrcalo): Employee.role je String — vrednost 'cleaner' deluje
 * brez DDL (schema.sqlite.prisma je pushana prek `bun run db:push`). Zato je
 * klic na file: bazi eksplicitno no-op OK (konzola pokaže aplicirano).
 *
 * Idempotentno (IF NOT EXISTS). Samo centralne vloge (requireCentralRole, N4).
 * Audit: SCHEMA_MIGRATION_CLEANER_ROLE.
 */
export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const url = process.env.DATABASE_URL || ''
  if (url.startsWith('file:')) {
    // Dev SQLite — String stolpec, DDL ni potreben (glej glavo).
    return ok({ migrated: true, skipped: true, applied: [] })
  }

  const ddl = `ALTER TYPE "EmployeeRole" ADD VALUE IF NOT EXISTS 'cleaner'`
  try {
    await db.$executeRawUnsafe(ddl)
  } catch (e) {
    return fail(`Migracija cleaner-role ni uspela: ${(e as Error).message}`, 500)
  }

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_CLEANER_ROLE',
        entityType: 'Schema',
        entityId: 'cleaner-role',
        details: JSON.stringify({ ddl: 'ADD VALUE cleaner' }),
      },
    })
    .catch(() => null)

  return ok({ migrated: true, skipped: false, applied: ['ADD VALUE cleaner'] })
}
