import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok } from '@/lib/api'
import { nid } from '@/lib/map'
import { resetPayLinkProbe } from '@/lib/paylink/core'

/**
 * v1.85.1 — P0-2 produkcijski DDL korak: tabela PayLink (javna plačilna
 * povezava /pay/<token>). Issue-13 / haccp-plans vzorec: dev SQLite dobi tabelo
 * prek `prisma db push`, produkcijski Neon Postgres pa čaka ta korak (rute
 * /api/orders/[id]/paylink in /api/public/pay/[token] do takrat vračajo 503
 * s prijaznim sporočilom — capability probe v src/lib/paylink/core.ts).
 *
 * Samo centralne vloge (requireCentralRole — N4 audit P1). Idempotentno:
 * preverba SELECT FROM "PayLink" → alreadyApplied brez DDL. Fiksne DDL izjave
 * (brez prostoformskega SQL), identične izhodu `prisma migrate diff
 * --from-empty --to-schema-datamodel prisma/schema.prisma`. Audit:
 * SCHEMA_MIGRATION_PAYLINK. Po apliciranju reset probe (druge lambda
 * instance najpozneje čez 60 s TTL).
 */
const DDL = [
  `CREATE TABLE "PayLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "phone" TEXT NOT NULL DEFAULT '',
    "smsDetail" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(65,30),
    "tip" DECIMAL(65,30),
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "receiptId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayLink_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX "PayLink_token_key" ON "PayLink"("token")`,
  `CREATE UNIQUE INDEX "PayLink_orderId_key" ON "PayLink"("orderId")`,
  `CREATE INDEX "PayLink_createdAt_idx" ON "PayLink"("createdAt")`,
  `CREATE INDEX "PayLink_locationId_idx" ON "PayLink"("locationId")`,
  `CREATE INDEX "PayLink_status_idx" ON "PayLink"("status")`,
  `ALTER TABLE "PayLink" ADD CONSTRAINT "PayLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
]

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  try {
    // Idempotenca: tabela že obstaja (ponovni klic / dev SQLite z db push).
    await db.$queryRawUnsafe('SELECT 1 FROM "PayLink" LIMIT 1')
    resetPayLinkProbe()
    return ok({ alreadyApplied: true, applied: [] })
  } catch {
    // tabela ne obstaja → apliciraj fiksni DDL
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.split('\n')[0].trim() + ' …' })
  }

  const after = await db.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT count(*) AS cnt FROM "PayLink"`,
  )
  const linkCount = Number(after[0]?.cnt ?? 0)

  resetPayLinkProbe()

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_PAYLINK',
        entityType: 'Schema',
        entityId: 'paylink_create',
        details: JSON.stringify({ statements: DDL.length, linkCountAfter: linkCount }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied, linkCountAfter: linkCount })
}
