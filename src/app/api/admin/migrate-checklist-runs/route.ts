import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * v1.246.0 (PRIMERJAVA-VMESNIKOV-2026 §20): OPERATIVNI VAL — DDL korak.
 *
 * NOVA tabela ChecklistRun (digitalni checklisti, Lightspeed Tasks marec
 * 2026): ena vrstica na pojavitev predloge (occurrenceKey
 * `${templateId}|YYYY-MM-DD`, dedup @@unique [locationId, templateId,
 * occurrenceKey]); itemResults Json nosi odziv PO POSTAVKI { kind, value,
 * at, byId, byName } — »who completed what«. Stanje open/completed izpelje
 * STREŽNIK iz pokritosti postavk (klient ne more prijaviti zaključka).
 *
 * ČISTO ADITIVNO (ista varnostna slika kot coupons-waitlist/documents):
 * nova tabela + novi indeksi, brez spremembe obstoječih podatkov. NI vroče
 * poti: /api/checklists/** probajo tabelo (haccp-plans vzorec) — dokler
 * DDL ni apliciran, plošča vrne { checklists: [], ddlPending: true } in
 * pisanja 503; nobena živa funkcionalnost se ne zlomi.
 *
 * Idempotentno: probe obstoja PRED izvedbo (P2021 na PG, "no such table"
 * na SQLite); dev/CI SQLite ima tabelo prek db push zrcala (preskok).
 * Samo centralne vloge (requireCentralRole).
 */
export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  /** Ali tabela obstaja? SQLite + Postgres (probe iz coupons-waitlist vzorca). */
  async function tableExists(sql: string): Promise<boolean> {
    try {
      await db.$queryRawUnsafe(sql)
      return true
    } catch (e) {
      const msg = String((e as Error).message || e)
      if (msg.includes('does not exist') || msg.includes('no such table') || msg.includes('P2021')) return false
      throw e // infra napaka (P1001 unreachable, timeout …) → brez maskiranja
    }
  }

  try {
    // SQLite (dev zrcalo) potrebuje TEXT za Json->String preslikavo; Postgres
    // (produkcija) JSONB — migrations-console "apply vse" delegacija sicer
    // ustvari JSONB stolpec na SQLite, ki ga Prisma klient ne zna prebrati
    // (Inconsistent column data — izmerjeno v živi suiti).
    const isSqlite = String(process.env.DATABASE_URL || '').startsWith('file:')
    const jsonType = isSqlite ? 'TEXT' : 'JSONB'

    // 1) NOVA tabela ChecklistRun (zrcali prisma/schema.prisma model §20)
    if (await tableExists(`SELECT 1 FROM "ChecklistRun" LIMIT 1`)) {
      skipped.push('ChecklistRun')
    } else {
      await db.$executeRawUnsafe(`CREATE TABLE "ChecklistRun" (
        "id" TEXT NOT NULL,
        "locationId" TEXT NOT NULL,
        "templateId" TEXT NOT NULL,
        "templateName" TEXT NOT NULL DEFAULT '',
        "occurrenceKey" TEXT NOT NULL DEFAULT '',
        "state" TEXT NOT NULL DEFAULT 'open',
        "itemResults" ${jsonType} NOT NULL DEFAULT '{}',
        "completedById" TEXT NOT NULL DEFAULT '',
        "completedByName" TEXT NOT NULL DEFAULT '',
        "completedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "ChecklistRun_pkey" PRIMARY KEY ("id")
      )`)
      applied.push('ChecklistRun')
    }

    // 2) dedup + indeksi (idempotentno z IF NOT EXISTS; brez FK — scalar
    //    locationId je zavestna odločitev, HaccpAction/EventLog vzorec)
    for (const ix of [
      `CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistRun_locationId_templateId_occurrenceKey_key" ON "ChecklistRun"("locationId", "templateId", "occurrenceKey")`,
      `CREATE INDEX IF NOT EXISTS "ChecklistRun_locationId_idx" ON "ChecklistRun"("locationId")`,
      `CREATE INDEX IF NOT EXISTS "ChecklistRun_templateId_idx" ON "ChecklistRun"("templateId")`,
      `CREATE INDEX IF NOT EXISTS "ChecklistRun_state_idx" ON "ChecklistRun"("state")`,
    ]) {
      await db.$executeRawUnsafe(ix)
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_CHECKLIST_RUNS',
      entityType: 'SchemaMigration',
      entityId: 'checklist-runs',
      details: jstr({ applied, skipped, by: user.name, at: new Date().toISOString() }),
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak checklist-runs ni uspel: ${String((e as Error).message || e).slice(0, 200)}`, 500)
  }
}
