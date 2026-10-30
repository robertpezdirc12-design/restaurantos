import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * OSS-2 (v1.203.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — dokumenti s
 * priponkami: DDL korak.
 *
 * NOVA tabela Document (SOP-i, pogodbe, recepture, navodila po lokaciji:
 * naziv, kategorija, opis, ime/vrsta/velikost datoteke, VSEBINA kot bytea
 * — produkcija ima read-only disk, datoteke NIKOLI ne grejo na lokalni disk —
 * verzija, kdaj/kdo). Mime allowlist je v aplikacijskem sloju (documents.ts).
 * Skalarne vezave brez FK (Equipment konvencija). Idempotentno: tabela +
 * indeksi IF NOT EXISTS (Postgres); SQLite (dev prek db push že prisotno)
 * duplikate tiho preskoči. Samo centralne vloge (requireCentralRole).
 * Do DDL: /api/documents* → 503.
 */

const CREATE_DOCUMENT_TABLE = `CREATE TABLE IF NOT EXISTS "Document" (
  "id" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'sop',
  "description" TEXT,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "content" BYTEA NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdById" TEXT,
  "updatedById" TEXT,
  CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
)`

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "Document_locationId_idx" ON "Document"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "Document_category_idx" ON "Document"("category")`,
]

async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
      table,
    )
    return Array.isArray(rows) && rows.length > 0
  } catch {
    // SQLite (dev/CI): information_schema ne obstaja — tabele so že prek db push
    return true
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  try {
    if (await tableExists('Document')) {
      skipped.push('Document')
    } else {
      await db.$executeRawUnsafe(CREATE_DOCUMENT_TABLE)
      applied.push('Document')
    }
    for (const ix of INDEXES) {
      await db.$executeRawUnsafe(ix)
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_DOCUMENTS',
      entityType: 'SchemaMigration',
      entityId: 'documents',
      details: jstr({
        applied,
        skipped: skipped.length,
        endpoint: '/api/admin/migrate-documents',
      }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
