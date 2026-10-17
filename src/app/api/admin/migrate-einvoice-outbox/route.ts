import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * v1.125.0 — issue #4 (P1 e-računi SI/HR): produkcijski DDL korak — tabela
 * EInvoiceOutbox (odhodni B2B e-računi: AR vezava, profil, XML + hash,
 * idempotencyKey, statusni življenjski cikel, externalRef, processedEvents).
 *
 * Issue-13 / migrate-paylink vzorec: dev SQLite dobi tabelo prek
 * `prisma db push`, produkcijski Neon Postgres pa čaka ta korak (rute
 * /api/einvoices* do takrat degradirajo — EInvoiceOutbox poizvedbe v
 * izvozu se tiho izpraznijo prek isMissingSchemaError, nove poizvedbe
 * vrnejo P2021/P2010 → 5xx z diagnostiko).
 *
 * Samo centralne vloge (requireCentralRole — N4 audit P1). Idempotentno:
 * preverba SELECT FROM "EInvoiceOutbox" → alreadyApplied brez DDL. Fiksne
 * DDL izjave (brez prostoformskega SQL), IDENTIČNE izhodu
 * `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma`
 * (preverjeno v validaciji vala: DECIMAL(65,30) / TIMESTAMP(3) / imena
 * indeksov / FK ON DELETE SET NULL ON UPDATE CASCADE).
 *
 * DIALEKT-ZAVEDNO (kot probe v schema-migrations.ts): SQLite (dev/test,
 * DATABASE_URL file:…) uporablja DATETIME namesto TIMESTAMP(3) — prisma
 * klient namreč SQLite stolpce z deklariranim tipom TIMESTAMP(3) NE ZNA
 * brati ("Conversion failed"), medtem ko db push isti model ustvari kot
 * DATETIME. Postgres (produkcija) ostaja PRIŠTEVNO identičen prisma diff.
 * DECIMAL(65,30) je v obeh dialektih enak prisma diff izhodu.
 */
const SQLITE_DDL = [
  `CREATE TABLE "EInvoiceOutbox" (
    "id" TEXT NOT NULL,
    "arId" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'outgoing',
    "country" TEXT NOT NULL DEFAULT 'SI',
    "documentType" TEXT NOT NULL DEFAULT 'invoice',
    "profile" TEXT NOT NULL DEFAULT 'eslog-2.0-si',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "invoiceNumber" TEXT NOT NULL DEFAULT '',
    "receiverName" TEXT NOT NULL DEFAULT '',
    "receiverTaxId" TEXT NOT NULL DEFAULT '',
    "receiverCountry" TEXT NOT NULL DEFAULT '',
    "subtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "xmlPayload" TEXT NOT NULL DEFAULT '',
    "xmlHash" TEXT NOT NULL DEFAULT '',
    "externalRef" TEXT NOT NULL DEFAULT '',
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "lastReason" TEXT NOT NULL DEFAULT '',
    "processedEvents" TEXT NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" DATETIME,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "locationId" TEXT,
    CONSTRAINT "EInvoiceOutbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EInvoiceOutbox_arId_fkey" FOREIGN KEY ("arId") REFERENCES "AccountsReceivable"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EInvoiceOutbox_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX "EInvoiceOutbox_idempotencyKey_key" ON "EInvoiceOutbox"("idempotencyKey")`,
  `CREATE INDEX "EInvoiceOutbox_arId_idx" ON "EInvoiceOutbox"("arId")`,
  `CREATE INDEX "EInvoiceOutbox_country_status_idx" ON "EInvoiceOutbox"("country", "status")`,
  `CREATE INDEX "EInvoiceOutbox_locationId_idx" ON "EInvoiceOutbox"("locationId")`,
  `CREATE INDEX "EInvoiceOutbox_status_idx" ON "EInvoiceOutbox"("status")`,
]
const PG_DDL = [
  `CREATE TABLE "EInvoiceOutbox" (
    "id" TEXT NOT NULL,
    "arId" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'outgoing',
    "country" TEXT NOT NULL DEFAULT 'SI',
    "documentType" TEXT NOT NULL DEFAULT 'invoice',
    "profile" TEXT NOT NULL DEFAULT 'eslog-2.0-si',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "invoiceNumber" TEXT NOT NULL DEFAULT '',
    "receiverName" TEXT NOT NULL DEFAULT '',
    "receiverTaxId" TEXT NOT NULL DEFAULT '',
    "receiverCountry" TEXT NOT NULL DEFAULT '',
    "subtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "xmlPayload" TEXT NOT NULL DEFAULT '',
    "xmlHash" TEXT NOT NULL DEFAULT '',
    "externalRef" TEXT NOT NULL DEFAULT '',
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "lastReason" TEXT NOT NULL DEFAULT '',
    "processedEvents" TEXT NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "locationId" TEXT,
    CONSTRAINT "EInvoiceOutbox_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX "EInvoiceOutbox_idempotencyKey_key" ON "EInvoiceOutbox"("idempotencyKey")`,
  `CREATE INDEX "EInvoiceOutbox_arId_idx" ON "EInvoiceOutbox"("arId")`,
  `CREATE INDEX "EInvoiceOutbox_country_status_idx" ON "EInvoiceOutbox"("country", "status")`,
  `CREATE INDEX "EInvoiceOutbox_locationId_idx" ON "EInvoiceOutbox"("locationId")`,
  `CREATE INDEX "EInvoiceOutbox_status_idx" ON "EInvoiceOutbox"("status")`,
  `ALTER TABLE "EInvoiceOutbox" ADD CONSTRAINT "EInvoiceOutbox_arId_fkey" FOREIGN KEY ("arId") REFERENCES "AccountsReceivable"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
  `ALTER TABLE "EInvoiceOutbox" ADD CONSTRAINT "EInvoiceOutbox_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
]

/** SQLite (dev/test) → DATETIME tipi; Postgres (produkcija) → prisma diff izhod. */
const DDL = (process.env.DATABASE_URL ?? '').startsWith('file:') ? SQLITE_DDL : PG_DDL

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  try {
    // Idempotenca: tabela že obstaja (ponovni klic / dev SQLite z db push).
    await db.$queryRawUnsafe('SELECT 1 FROM "EInvoiceOutbox" LIMIT 1')
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
    `SELECT count(*) AS cnt FROM "EInvoiceOutbox"`,
  )
  const outboxCount = Number(after[0]?.cnt ?? 0)

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_EINVOICE_OUTBOX',
        entityType: 'Schema',
        entityId: 'einvoice_outbox_create',
        details: JSON.stringify({ statements: DDL.length, outboxCountAfter: outboxCount }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied, outboxCountAfter: outboxCount })
}
