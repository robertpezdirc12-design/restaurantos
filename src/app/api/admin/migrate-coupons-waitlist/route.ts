import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Kuponi P2-10b (v1.187.0) + opomniki čakalne vrste (v1.188.0) — ZAMASKIRANI
 * DDL korak (hotfix v1.219.1).
 *
 * ZAKAJ ZDAJ (izmerjeno 1. 11. 2026, CI run 41286990715 @ dfba184): neon-smoke
 * drift vrata so po odpavziranju Neona (B-4, reset kvote 1. 11.) PRVIČ od
 * v1.215.0 prišla do preverbe sheme in odkrila 8 NEPRIČAKOVANIH stavkov —
 * produkcija NIMA tabele Coupon (celoten Kuponi tok: rojstnodnevni cron + ročna
 * izdaja + POS unovčenje) niti stolpca WaitlistEntry.notifyStatus (SMS/e-pošta
 * opomnikov čakalne vrste). Vsa obdobje B-4 je drift-check padal GLEDE na
 * kvoto (endpoint se ni uspel ustvariti) — vrzel je bila nevidna, ne odpravljena.
 * Ta val (v1.219.0) je 0 DDL — vrzel je PREDOBSTOJEČA in le izmerjena zdaj.
 *
 * DDL je ČISTO ADITIVEN (nova tabela + novi indeksi + nov stolpec z privzeto
 * vrednostjo '') — brez spremembe obstoječih podatkov (isti vzorec kot
 * ManagerCall/kds-stations/cash-movements valovi).
 *
 * Idempotentno: preverba obstoja pred vsakim stavkom; dev/CI SQLite ima tabelo
 * prek db push zrcala (preskok). Produkcija čaka ta korak — konzola Enterprise
 * → Shema migracije → coupons-waitlist (en klik).
 *
 * Do DDL: /api/coupons** vrne 500 (P2021) — Kuponi tab v produkciji je prazen
 * z napako; POS osnovni tok se ne dotakne (kuponi so dodatna plast popustov).
 */
export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  /** Ali entiteta (tabela/stolpec) obstaja? SQLite + Postgres (probe iz schema-migrations vzorca). */
  async function exists(sql: string): Promise<boolean> {
    try {
      await db.$queryRawUnsafe(sql)
      return true
    } catch (e) {
      const msg = String((e as Error).message || e)
      // P2021 (tabela manjka) / P2022 (stolpec manjka) / sqlite no such table/column
      if (msg.includes('does not exist') || msg.includes('no such table') || msg.includes('no such column') || msg.includes('P2021') || msg.includes('P2022')) return false
      throw e
    }
  }

  try {
    // 1) NOVA tabela Coupon (zrcali prisma/schema.prisma model P2-10b)
    if (await exists(`SELECT 1 FROM "Coupon" LIMIT 1`)) {
      skipped.push('Coupon')
    } else {
      await db.$executeRawUnsafe(`CREATE TABLE "Coupon" (
        "id" TEXT NOT NULL,
        "code" TEXT NOT NULL,
        "guestId" TEXT NOT NULL,
        "reason" TEXT NOT NULL DEFAULT 'birthday',
        "year" INTEGER,
        "percent" INTEGER,
        "fixedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
        "status" TEXT NOT NULL DEFAULT 'issued',
        "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "expiresAt" TIMESTAMP(3) NOT NULL,
        "redeemedAt" TIMESTAMP(3),
        "orderId" TEXT,
        "note" TEXT NOT NULL DEFAULT '',
        "notifiedAt" TIMESTAMP(3),
        "notifyStatus" TEXT NOT NULL DEFAULT '',
        "issuedBy" TEXT,
        "locationId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
      )`)
      applied.push('Coupon')
    }

    // 2) indeksi + unikatne omejitve (idempotentno z IF NOT EXISTS)
    for (const ix of [
      `CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_code_key" ON "Coupon"("code")`,
      `CREATE INDEX IF NOT EXISTS "Coupon_guestId_idx" ON "Coupon"("guestId")`,
      `CREATE INDEX IF NOT EXISTS "Coupon_locationId_idx" ON "Coupon"("locationId")`,
      `CREATE INDEX IF NOT EXISTS "Coupon_status_expiresAt_idx" ON "Coupon"("status", "expiresAt")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_guestId_reason_year_key" ON "Coupon"("guestId", "reason", "year")`,
    ]) {
      await db.$executeRawUnsafe(ix)
    }

    // 3) FK na Guest (Postgres nima ADD CONSTRAINT IF NOT EXISTS — probe posamično;
    //    SQLite ne podpira ADD CONSTRAINT in tabela ionakao pride iz db push zrcala
    //    s FK že vključenim → na SQLite se korak cele preskoči)
    const isSqlite = String(process.env.DATABASE_URL || '').startsWith('file:')
    if (isSqlite) {
      skipped.push('Coupon_guestId_fkey (sqlite: db push zrcalo)')
    } else if (!(await exists(`SELECT 1 FROM pg_constraint WHERE conname = 'Coupon_guestId_fkey'`))) {
      await db.$executeRawUnsafe(`ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE`)
      applied.push('Coupon_guestId_fkey')
    } else {
      skipped.push('Coupon_guestId_fkey')
    }

    // 4) STOLPEC WaitlistEntry.notifyStatus (v1.188.0 — sledenje opomnikom)
    if (await exists(`SELECT "notifyStatus" FROM "WaitlistEntry" LIMIT 1`)) {
      skipped.push('WaitlistEntry.notifyStatus')
    } else {
      await db.$executeRawUnsafe(`ALTER TABLE "WaitlistEntry" ADD COLUMN "notifyStatus" TEXT NOT NULL DEFAULT ''`)
      applied.push('WaitlistEntry.notifyStatus')
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_COUPONS_WAITLIST',
      entityType: 'SchemaMigration',
      entityId: 'coupons-waitlist',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-coupons-waitlist' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
