import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #15 (P1, v1.105.0) — sledljivost serij: lot-governance DDL.
 *
 * 9 novih stolpcev na OBSTOJEČI tabeli InventoryBatch (ni nove evidence —
 * issue zahteva ponovno uporabo modelov; status QUARANTINE/RECALLED je prosta
 * vrednost obstoječega String stolpca status):
 *   - "alertDate"    TIMESTAMP  — opozorilni datum (izrecna vrednost, NI privzeta)
 *   - "removalDate"  TIMESTAMP  — datum odstranitve iz zaloge (≤ rok uporabe)
 *   - "holdReason"   TEXT       — razlog karantene/odpoklica
 *   - "holdAt"       TIMESTAMP  — kdaj je bila blokada postavljena
 *   - "holdById"     TEXT       — kdo (Employee id)
 *   - "holdRef"      TEXT       — referenca (obvestilo dobavitelja / uradni odpoklic)
 *   - "releaseAt"    TIMESTAMP  — kdaj izrecna sprostitev
 *   - "releaseById"  TEXT       — kdo je sprostil
 *   - "releaseNote"  TEXT       — zakaj (karantena)
 *
 * + PODATKOVNA POPRAVLJENOST: receive pot je (v1.72–v1.104) pisala
 *   status='active' (male črke), FEFO pa sprašuje 'ACTIVE' — SQLite je
 *   case-sensitive → te serije NIKOLI niso bile FEFO razporejene. DDL
 *   normalizira obstoječe vrstice (UPDATE ... WHERE status='active').
 *
 * Vzorec allergen-truth: dev SQLite dobi stolpce prek db push (mirror schema),
 * produkcijski Neon čeka ta korak (konzola Enterprise → Shema migracije →
 * lot-governance). Idempotentno (probe + IF NOT EXISTS + UPDATE je naravno
 * idempotenten).
 */
const DDL: { table: string; col: string; stmt: string }[] = [
  { table: 'InventoryBatch', col: 'alertDate', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "alertDate" TIMESTAMP` },
  { table: 'InventoryBatch', col: 'removalDate', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "removalDate" TIMESTAMP` },
  { table: 'InventoryBatch', col: 'holdReason', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "holdReason" TEXT NOT NULL DEFAULT ''` },
  { table: 'InventoryBatch', col: 'holdAt', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "holdAt" TIMESTAMP` },
  { table: 'InventoryBatch', col: 'holdById', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "holdById" TEXT` },
  { table: 'InventoryBatch', col: 'holdRef', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "holdRef" TEXT NOT NULL DEFAULT ''` },
  { table: 'InventoryBatch', col: 'releaseAt', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "releaseAt" TIMESTAMP` },
  { table: 'InventoryBatch', col: 'releaseById', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "releaseById" TEXT` },
  { table: 'InventoryBatch', col: 'releaseNote', stmt: `ALTER TABLE "InventoryBatch" ADD COLUMN IF NOT EXISTS "releaseNote" TEXT NOT NULL DEFAULT ''` },
]

const TABLE = 'InventoryBatch'

async function columnsPresent(): Promise<boolean> {
  for (const d of DDL) {
    try {
      await db.$queryRawUnsafe(`SELECT "${d.col}" FROM "${d.table}" LIMIT 1`)
    } catch {
      return false
    }
  }
  return true
}

async function tableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT 1 FROM "${TABLE}" LIMIT 1`)
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  if (await columnsPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await tableExists())) {
    return fail('Tabela InventoryBatch ne obstaja — baza ni inicializirana.', 409)
  }

  const applied: { ddl: string }[] = []
  for (const d of DDL) {
    await db.$executeRawUnsafe(d.stmt)
    applied.push({ ddl: d.stmt.slice(0, 90) })
  }

  // Podatkovna normalizacija statusa (legacy 'active' → 'ACTIVE'; idempotentno).
  const normalized = await db.$executeRawUnsafe(
    `UPDATE "InventoryBatch" SET "status" = 'ACTIVE' WHERE "status" = 'active'`,
  )

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_LOT_GOVERNANCE',
        entityType: 'Schema',
        entityId: 'lot_governance',
        details: JSON.stringify({
          statements: DDL.length,
          columns: DDL.map((d) => `${d.table}.${d.col}`),
          statusNormalized: Number(normalized),
        }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied, statusNormalized: Number(normalized) })
}
