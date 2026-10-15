import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #7 (P1, v1.104.0) — alergeni: en vir resnice (allergen-truth).
 * 10 novih stolpcev na 3 obstoječih tabelah (ni novih evidenc — issue zahteva
 * ponovno uporabo obstoječih modelov):
 *
 *  InventoryItem (SESTAVINA — izvir resnice):
 *   - "allergens"             TEXT NOT NULL DEFAULT '[]'   (JSON niz kanoničnih kod)
 *   - "allergensCrossContact" TEXT NOT NULL DEFAULT '[]'   ("lahko vsebuje" — ocena osebja)
 *   - "allergensConfirmedAt"  TIMESTAMP                   (potrditev odgovorne osebe)
 *   - "allergensConfirmedById" TEXT                       (kdaj + kdo)
 *
 *  MenuItem (JED — izračun profila + ročni popravek):
 *   - "allergensOverride"     TEXT                        (JSON {add,remove,reason,by,at} — izvor+razlog)
 *   - "allergensConfirmedAt"  TIMESTAMP
 *   - "allergensConfirmedById" TEXT
 *   - "allergenReviewFlag"    BOOLEAN NOT NULL DEFAULT false (označi za ponovno preverbo)
 *   - "allergenReviewReason"  TEXT NOT NULL DEFAULT ''
 *
 *  OrderItem (NAROČILO — zgodovinski posnetek):
 *   - "allergenSnapshot"      TEXT NOT NULL DEFAULT '{}'   (kode/status OB NASTANKU — recept se kasneje lahko spremeni)
 *   - "allergenWarning"       TEXT NOT NULL DEFAULT ''     (izrecno opozorilo: gost/osebje → KDS + kuhinjski list)
 *
 * Vzorec issue-13/ap-tolerance: dev SQLite dobi stolpce prek prisma db push
 * (mirror schema jih ima), produkcijski Neon Postgres čaka ta korak (konzola
 * Enterprise → Shema migracije → allergen-truth). Idempotentno (probe +
 * IF NOT EXISTS). Pred DDL nove rute SLABO degradirajo: pisanje 503, branje
 * z manjkajočimi podatki pade nazaj na legacy prosto besedilo (parse toleranten).
 */
const DDL: { table: string; col: string; stmt: string }[] = [
  { table: 'InventoryItem', col: 'allergens', stmt: `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "allergens" TEXT NOT NULL DEFAULT '[]'` },
  { table: 'InventoryItem', col: 'allergensCrossContact', stmt: `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "allergensCrossContact" TEXT NOT NULL DEFAULT '[]'` },
  { table: 'InventoryItem', col: 'allergensConfirmedAt', stmt: `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "allergensConfirmedAt" TIMESTAMP` },
  { table: 'InventoryItem', col: 'allergensConfirmedById', stmt: `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "allergensConfirmedById" TEXT` },
  { table: 'MenuItem', col: 'allergensOverride', stmt: `ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "allergensOverride" TEXT` },
  { table: 'MenuItem', col: 'allergensConfirmedAt', stmt: `ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "allergensConfirmedAt" TIMESTAMP` },
  { table: 'MenuItem', col: 'allergensConfirmedById', stmt: `ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "allergensConfirmedById" TEXT` },
  { table: 'MenuItem', col: 'allergenReviewFlag', stmt: `ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "allergenReviewFlag" BOOLEAN NOT NULL DEFAULT false` },
  { table: 'MenuItem', col: 'allergenReviewReason', stmt: `ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "allergenReviewReason" TEXT NOT NULL DEFAULT ''` },
  { table: 'OrderItem', col: 'allergenSnapshot', stmt: `ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "allergenSnapshot" TEXT NOT NULL DEFAULT '{}'` },
  { table: 'OrderItem', col: 'allergenWarning', stmt: `ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "allergenWarning" TEXT NOT NULL DEFAULT ''` },
]

const TABLES = ['InventoryItem', 'MenuItem', 'OrderItem']

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

async function tablesExist(): Promise<boolean> {
  for (const t of TABLES) {
    try {
      await db.$queryRawUnsafe(`SELECT 1 FROM "${t}" LIMIT 1`)
    } catch {
      return false
    }
  }
  return true
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  if (await columnsPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await tablesExist())) {
    return fail('Tabele InventoryItem/MenuItem/OrderItem ne obstajajo — baza ni inicializirana.', 409)
  }

  const applied: { ddl: string }[] = []
  for (const d of DDL) {
    await db.$executeRawUnsafe(d.stmt)
    applied.push({ ddl: d.stmt.slice(0, 90) })
  }

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_ALLERGEN_TRUTH',
        entityType: 'Schema',
        entityId: 'allergen_truth',
        details: JSON.stringify({
          statements: DDL.length,
          tables: TABLES,
          columns: DDL.map((d) => `${d.table}.${d.col}`),
        }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
