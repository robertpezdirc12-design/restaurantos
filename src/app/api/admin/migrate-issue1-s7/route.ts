import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #1 sklop ⑦ — enkratna produkcijska migracija sheme (Neon Postgres):
 * tabela SpecialOpeningDay (posebni dnevi/prazniki odpiralnega časa).
 * Samo za ADMIN (requirePermission settings.manage). Idempotentno (IF NOT EXISTS).
 * Brez prostoformskega SQL — izvajajo se IZKLJUČNO fiksne, aditivne DDL izjave
 * (politika migrate-issue3/#10/#11/#12). Audit: SCHEMA_MIGRATION_ISSUE1_S7.
 */
const MIGRATIONS: { id: string; ddl: string[] }[] = [
  {
    id: 'issue1_s7_special_opening_day',
    ddl: [
      `CREATE TABLE IF NOT EXISTS "SpecialOpeningDay" (
        "id" TEXT NOT NULL,
        "date" TEXT NOT NULL,
        "isClosed" BOOLEAN NOT NULL DEFAULT true,
        "openTime" TEXT NOT NULL DEFAULT '',
        "closeTime" TEXT NOT NULL DEFAULT '',
        "note" TEXT NOT NULL DEFAULT '',
        "locationId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "SpecialOpeningDay_pkey" PRIMARY KEY ("id")
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS "SpecialOpeningDay_locationId_date_key" ON "SpecialOpeningDay"("locationId", "date")',
      'CREATE INDEX IF NOT EXISTS "SpecialOpeningDay_date_idx" ON "SpecialOpeningDay"("date")',
      'CREATE INDEX IF NOT EXISTS "SpecialOpeningDay_locationId_idx" ON "SpecialOpeningDay"("locationId")',
      `DO $$ BEGIN
        ALTER TABLE "SpecialOpeningDay" ADD CONSTRAINT "SpecialOpeningDay_locationId_fkey"
        FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    ],
  },
]

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const applied: string[] = []
  for (const m of MIGRATIONS) {
    for (const ddl of m.ddl) {
      await db.$executeRawUnsafe(ddl)
      applied.push(ddl.replace(/\s+/g, ' ').slice(0, 72))
    }
  }

  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_ISSUE1_S7',
      entityType: 'SpecialOpeningDay',
      entityId: 'special-opening-days',
      details: `applied=${applied.length} (aditivno, idempotentno)`,
    },
  }).catch(() => {})

  const columns = await db.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'SpecialOpeningDay' ORDER BY ordinal_position`
  )
  const indexes = await db.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'SpecialOpeningDay' ORDER BY indexname`
  )

  return ok({
    applied: MIGRATIONS.map((m) => ({ id: m.id, statements: m.ddl.length })),
    columns: columns.map((c) => c.column_name),
    indexes: indexes.map((i) => i.indexname),
  }, 201)
}
