import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'
import { resetPayLinkProbe } from '@/lib/paylink/core'

/**
 * v1.87.0 — P1-6 SPLIT PO GOSTIH: produkcijski DDL korak nad obstoječo tabelo
 * PayLink (aplicirana v1.85.0 z migrate-paylink):
 *  1. DROP INDEX "PayLink_orderId_key" — orderId ni več unikaten (N povezav
 *     na naročilo — vsak gost svoj QR/delež);
 *  2. ADD COLUMN "splitIndex"/"splitCount" (Int, default 1 — snapshot splita);
 *  3. ADD COLUMN "approvalCode" (Text, default '' — odobritev terminala za
 *     vmesna plačila deležev, dokler končni račun ni izdan).
 *
 * Issue-13 vzorec: dev SQLite dobi spremembe prek `prisma db push`, produkcijski
 * Neon Postgres čaka ta korak (konzola Enterprise → Shema migracije → paylink-split
 * → Uporabi). Samo centralne vloge (requireCentralRole). Idempotentno: probe
 * (stolpci obstajajo?) → alreadyApplied brez DDL; stavki sami nosijo IF NOT
 * EXISTS/IF EXISTS (varnost ob delnem porivu). Po apliciranju reset probe.
 */
const DDL = [
  `DROP INDEX IF EXISTS "PayLink_orderId_key"`,
  `ALTER TABLE "PayLink" ADD COLUMN IF NOT EXISTS "splitIndex" INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE "PayLink" ADD COLUMN IF NOT EXISTS "splitCount" INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE "PayLink" ADD COLUMN IF NOT EXISTS "approvalCode" TEXT NOT NULL DEFAULT ''`,
]

async function paylinkSplitColumnsPresent(): Promise<boolean> {
  for (const col of ['splitIndex', 'splitCount', 'approvalCode']) {
    try {
      await db.$queryRawUnsafe(`SELECT "${col}" FROM "PayLink" LIMIT 1`)
    } catch {
      return false
    }
  }
  return true
}

async function paylinkTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "PayLink" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  // Idempotenca: novi stolpci že obstajajo (ponovni klic / dev SQLite z db push).
  if (await paylinkSplitColumnsPresent()) {
    resetPayLinkProbe()
    return ok({ alreadyApplied: true, applied: [] })
  }
  // tabela PayLink še čaka osnovno migracijo (paylink) — ta korak ni mogoč
  if (!(await paylinkTableExists())) {
    return fail('Tabela PayLink še ne obstaja — najprej aplicirajte migracijo paylink.', 409)
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.slice(0, 90) })
  }

  resetPayLinkProbe()

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_PAYLINK_SPLIT',
        entityType: 'Schema',
        entityId: 'paylink_split',
        details: JSON.stringify({ statements: DDL.length }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
