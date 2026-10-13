import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'

import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #3 — enkratna produkcijska migracija sheme (Neon Postgres nima teh stolpcev).
 * Samo za centralne vloge (requireCentralRole — DB vloga owner/admin; N4 audit P1).
 * Idempotentno (ADD COLUMN IF NOT EXISTS).
 * Brez prostoformskega SQL — izvajajo se IZKLJUČNO fiksné, aditivne ALTER izjave.
 */
const MIGRATIONS: { id: string; ddl: string[] }[] = [
  {
    id: 'issue3_table_qr',
    ddl: [
      'ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS "qrToken" TEXT',
      'ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS "qrEnabled" BOOLEAN NOT NULL DEFAULT true',
      'ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS "qrRotatedAt" TIMESTAMP(3)',
      'CREATE UNIQUE INDEX IF NOT EXISTS "Table_qrToken_key" ON "Table"("qrToken")',
    ],
  },
  {
    id: 'issue3_device_registry_cfd',
    ddl: [
      'ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "pairingCode" TEXT',
      'ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "pairingExpiresAt" TIMESTAMP(3)',
      'ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "pairedToDeviceId" TEXT',
      'ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "displayPayload" TEXT',
      'ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "displayUpdatedAt" TIMESTAMP(3)',
      'ALTER TABLE "DeviceRegistry" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3)',
    ],
  },
  {
    id: 'issue3_order_source',
    ddl: [
      "ALTER TABLE \"Order\" ADD COLUMN IF NOT EXISTS \"orderSource\" TEXT NOT NULL DEFAULT 'pos'",
    ],
  },
]

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
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
  } catch (e) {
    return fail(`Migracija ni uspela: ${(e as Error).message}`, 500)
  }

  await writeAudit(db, { userId: user.sub, action: 'SCHEMA_MIGRATION_ISSUE3', entityType: 'Database', entityId: 'production', details: `izvedenih migracij: ${results.filter((r) => !r.skipped).length}/${results.length}` })

  return ok({ results })
}
