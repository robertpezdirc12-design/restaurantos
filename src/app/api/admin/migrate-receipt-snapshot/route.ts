import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * HOTFIX v1.239.1: RAČUNSKA CELICA (v1.239.0, PRIMERJAVA §16 C) — DDL korak.
 *
 * VZROK (izmerjeno, CI run 41596980960 @ c0f8b13): val v1.239.0 je dodal
 * 1 aditivno DDL (Receipt.checkId + Receipt.itemsJson), a ZABIL vpis v
 * KNOWN_DRIFTS allowlist — vsak prejšnji DDL val ga je dodal (vzorec
 * coupons-waitlist hotfix v1.219.1). neon-smoke drift vrata so odkrila 2
 * nepričakovana stavka (produkcija stolpcev še nima) → CI rdeč, Vercel
 * deploy blokiran.
 *
 * VROČA POT (razlika od večine pending DDL valov): izdaja računa
 * (src/lib/furs/issue.ts) piše oba stolpca ob VSAKEM fiskalnem računu —
 * po deployu v1.239.0 brez tega koraka BI izdaja na produkciji padala na
 * P2022 (Unknown argument checkId). Korak apliciramo TAKOJ po deployu
 * (vzorec issue31-36/38 — "produkcija nima živega prometa v tem oknu").
 *
 * DDL je ČISTO ADITIVEN (2 nova stolpca z varnima privzetkoma — vsi
 * obstoječi računi dobijo checkId='' in itemsJson='[]', kar točno
 * ustreza legacy padalu pri branju /api/furs/[id]).
 *
 * Idempotentno: probe obstoja stolpcev PRED izvedbo (P2022 na PG,
 * "no such column" na SQLite); dev/CI SQLite ima stolpca prek db push
 * zrcala (preskok). Dialektna ločitev za itemsJson: PG JSONB (prisma
 * Json preslikava), SQLite TEXT (mirror shema ima String, kot
 * vatBreakdown). Samo centralne vloge (requireCentralRole).
 */
export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  /** Ali stolpec obstaja? SQLite + Postgres (probe iz coupons-waitlist vzorca). */
  async function columnExists(sql: string): Promise<boolean> {
    try {
      await db.$queryRawUnsafe(sql)
      return true
    } catch (e) {
      const msg = String((e as Error).message || e)
      // P2022 (stolpec manjka na PG) / sqlite no such column
      if (msg.includes('no such column') || msg.includes('does not exist') || msg.includes('P2022')) return false
      throw e // infra napaka (P1001 unreachable, timeout …) → brez maskiranja
    }
  }

  try {
    const isSqlite = String(process.env.DATABASE_URL || '').startsWith('file:')

    // 1) STOLPEC Receipt.checkId (mehka referenca na izstavek — TEXT na obeh dialektih)
    if (await columnExists(`SELECT "checkId" FROM "Receipt" LIMIT 1`)) {
      skipped.push('Receipt.checkId')
    } else {
      await db.$executeRawUnsafe(`ALTER TABLE "Receipt" ADD COLUMN "checkId" TEXT NOT NULL DEFAULT ''`)
      applied.push('Receipt.checkId')
    }

    // 2) STOLPEC Receipt.itemsJson (posnetek postavk — PG JSONB / SQLite TEXT)
    if (await columnExists(`SELECT "itemsJson" FROM "Receipt" LIMIT 1`)) {
      skipped.push('Receipt.itemsJson')
    } else {
      await db.$executeRawUnsafe(
        isSqlite
          ? `ALTER TABLE "Receipt" ADD COLUMN "itemsJson" TEXT NOT NULL DEFAULT '[]'`
          : `ALTER TABLE "Receipt" ADD COLUMN "itemsJson" JSONB NOT NULL DEFAULT '[]'`,
      )
      applied.push('Receipt.itemsJson')
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_RECEIPT_SNAPSHOT',
      entityType: 'SchemaMigration',
      entityId: 'receipt-snapshot',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-receipt-snapshot' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
