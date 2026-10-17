import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * v1.126.0 — issue #11 (P2 CRM gostov): produkcijski DDL korak — NOVE tabele
 * GuestConsent (append-only sled marketing soglasja: kanal, namen, vir,
 * različica besedila, dokaz izrecnega dejanja), Campaign (življenjski cikel
 * kampanje: osnutek → odobritev → načrt → pošiljanje → zaključek + števci
 * IZ vrstic) in CampaignSend (pošiljanje po naslovniku: idempotenca
 * @@unique(campaignId, guestId), enkratni žeton za odjavo, statusi samo z
 * dokazom — SMTP sprejem = sent_to_provider, NE dostava).
 *
 * Issue-13 / migrate-einvoice-outbox vzorec: dev SQLite dobi tabele prek
 * `prisma db push`, produkcijski Neon Postgres pa čaka ta korak (rute
 * /api/crm* do takrat degradirajo — P2021 → 5xx z diagnostiko). Skalarne
 * vezave BREZ FK na Guest/Location (EventLog vzorec — nobena sprememba na
 * obstoječih tabelah, 0 tveganja za obstoječe tokove).
 *
 * Samo centralne vloge (requireCentralRole). Idempotentno: preverba
 * SELECT FROM "Campaign" → alreadyApplied brez DDL. Fiksne DDL izjave,
 * IDENTIČNE izhodu prisma diff. DIALEKT-ZAVEDNO: SQLite (dev/test,
 * DATABASE_URL file:…) uporablja DATETIME, Postgres TIMESTAMP(3). IF NOT
 * EXISTS na vseh CREATE stavkih (vzporedna invokacija = no-op, ne napaka).
 */
const SQLITE_DDL = [
  `CREATE TABLE IF NOT EXISTS "GuestConsent" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "purpose" TEXT NOT NULL DEFAULT 'marketing',
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "textVersion" TEXT NOT NULL DEFAULT 'crm-consent-v1',
    "proof" TEXT NOT NULL DEFAULT '',
    "recordedBy" TEXT,
    "locationId" TEXT,
    "actedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuestConsent_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "GuestConsent_guestId_channel_purpose_createdAt_idx" ON "GuestConsent"("guestId", "channel", "purpose", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "GuestConsent_locationId_idx" ON "GuestConsent"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "GuestConsent_status_idx" ON "GuestConsent"("status")`,
  `CREATE TABLE IF NOT EXISTS "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "segmentType" TEXT NOT NULL DEFAULT 'all',
    "segmentPeriodDays" INTEGER NOT NULL DEFAULT 90,
    "subject" TEXT NOT NULL DEFAULT '',
    "bodySl" TEXT NOT NULL DEFAULT '',
    "bodyHr" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledAt" DATETIME,
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    "sentAt" DATETIME,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribedCount" INTEGER NOT NULL DEFAULT 0,
    "testRecipient" TEXT NOT NULL DEFAULT '',
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "locationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "Campaign_locationId_idx" ON "Campaign"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "Campaign_status_scheduledAt_idx" ON "Campaign"("status", "scheduledAt")`,
  `CREATE TABLE IF NOT EXISTS "CampaignSend" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "recipient" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "unsubscribeToken" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL DEFAULT '',
    "sentAt" DATETIME,
    "failedAt" DATETIME,
    "errorMessage" TEXT NOT NULL DEFAULT '',
    "unsubscribedAt" DATETIME,
    "locationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignSend_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSend_campaignId_guestId_key" ON "CampaignSend"("campaignId", "guestId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSend_unsubscribeToken_key" ON "CampaignSend"("unsubscribeToken")`,
  `CREATE INDEX IF NOT EXISTS "CampaignSend_campaignId_status_idx" ON "CampaignSend"("campaignId", "status")`,
  `CREATE INDEX IF NOT EXISTS "CampaignSend_guestId_idx" ON "CampaignSend"("guestId")`,
  `CREATE INDEX IF NOT EXISTS "CampaignSend_locationId_idx" ON "CampaignSend"("locationId")`,
]
const PG_DDL = [
  `CREATE TABLE IF NOT EXISTS "GuestConsent" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "purpose" TEXT NOT NULL DEFAULT 'marketing',
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "textVersion" TEXT NOT NULL DEFAULT 'crm-consent-v1',
    "proof" TEXT NOT NULL DEFAULT '',
    "recordedBy" TEXT,
    "locationId" TEXT,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GuestConsent_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "GuestConsent_guestId_channel_purpose_createdAt_idx" ON "GuestConsent"("guestId", "channel", "purpose", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "GuestConsent_locationId_idx" ON "GuestConsent"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "GuestConsent_status_idx" ON "GuestConsent"("status")`,
  `CREATE TABLE IF NOT EXISTS "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "segmentType" TEXT NOT NULL DEFAULT 'all',
    "segmentPeriodDays" INTEGER NOT NULL DEFAULT 90,
    "subject" TEXT NOT NULL DEFAULT '',
    "bodySl" TEXT NOT NULL DEFAULT '',
    "bodyHr" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribedCount" INTEGER NOT NULL DEFAULT 0,
    "testRecipient" TEXT NOT NULL DEFAULT '',
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT,
    "locationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "Campaign_locationId_idx" ON "Campaign"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "Campaign_status_scheduledAt_idx" ON "Campaign"("status", "scheduledAt")`,
  `CREATE TABLE IF NOT EXISTS "CampaignSend" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "recipient" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "unsubscribeToken" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT NOT NULL DEFAULT '',
    "unsubscribedAt" TIMESTAMP(3),
    "locationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignSend_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSend_campaignId_guestId_key" ON "CampaignSend"("campaignId", "guestId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSend_unsubscribeToken_key" ON "CampaignSend"("unsubscribeToken")`,
  `CREATE INDEX IF NOT EXISTS "CampaignSend_campaignId_status_idx" ON "CampaignSend"("campaignId", "status")`,
  `CREATE INDEX IF NOT EXISTS "CampaignSend_guestId_idx" ON "CampaignSend"("guestId")`,
  `CREATE INDEX IF NOT EXISTS "CampaignSend_locationId_idx" ON "CampaignSend"("locationId")`,
]

/** SQLite (dev/test) → DATETIME tipi; Postgres (produkcija) → prisma diff izhod. */
const DDL = (process.env.DATABASE_URL ?? '').startsWith('file:') ? SQLITE_DDL : PG_DDL

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  try {
    // Idempotenca: tabele že obstajajo (ponovni klic / dev SQLite z db push).
    await db.$queryRawUnsafe('SELECT 1 FROM "Campaign" LIMIT 1')
    return ok({ alreadyApplied: true, applied: [] })
  } catch {
    // tabele ne obstajajo → apliciraj fiksni DDL
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.split('\n')[0].trim() + ' …' })
  }

  const after = await db.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT count(*) AS cnt FROM "CampaignSend"`,
  )
  const sendCount = Number(after[0]?.cnt ?? 0)

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_CRM_CAMPAIGNS',
        entityType: 'Schema',
        entityId: 'crm_campaigns_create',
        details: JSON.stringify({ statements: DDL.length, campaignSendCountAfter: sendCount }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied, campaignSendCountAfter: sendCount })
}
