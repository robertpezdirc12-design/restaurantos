import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid, jstr } from '@/lib/map'

/**
 * Issue #4 §2.2 — produkcijska shematska migracija (idempotentna).
 * Vzorec po obstoječih /api/admin/migrate-issue3 in migrate-issue1-s6:
 * enkratna administrativna pot, ki uskladi Neon Postgres s prisma/schema.prisma
 * (deploy prek files API ne izvaja `prisma db push`).
 *
 * Doda polja DeviceRegistry za ENKRATNE vpisne kode:
 *   enrollmentCode TEXT?, enrollmentExpiresAt TIMESTAMP(3)?, enrollmentClaimedAt TIMESTAMP(3)?,
 *   + index na enrollmentCode (claim lookup).
 * Ponovni klic je VAREN (IF NOT EXISTS).
 */
export async function POST(req: NextRequest) {
  // N4 (audit P1): DDL zahteva centralno vlogo (owner/admin na nivoju DB) —
  // dovoljenje employees.manage ima tudi MANAGER, kar je za $executeRawUnsafe premalo.
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const statements: string[] = [
    `ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "enrollmentCode" TEXT`,
    `ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "enrollmentExpiresAt" TIMESTAMP(3)`,
    `ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "enrollmentClaimedAt" TIMESTAMP(3)`,
    `CREATE INDEX IF NOT EXISTS "DeviceRegistry_enrollmentCode_idx" ON "DeviceRegistry"("enrollmentCode")`,
  ]
  const applied: string[] = []
  for (const sql of statements) {
    try {
      await db.$executeRawUnsafe(sql)
      applied.push(sql.slice(0, 72))
    } catch (e) {
      return fail(`Migracija ni uspela (${sql.slice(0, 40)}…): ${(e as Error).message.slice(0, 180)}`, 500)
    }
  }

  // preveri stanje po migraciji
  const cols = await db.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'DeviceRegistry' AND column_name LIKE 'enrollment%'`
  )
  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'MIGRATE_ISSUE4',
      entityType: 'DeviceRegistry',
      entityId: 'DeviceRegistry',
      details: jstr({ applied: applied.length, columns: cols.map((c) => c.column_name) }),
    },
  })
  return ok({ ok: true, applied: applied.length, columns: cols.map((c) => c.column_name) })
}
