import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { isMissingSchemaError } from '@/lib/prisma-missing'

/**
 * OSS-9 (v1.202.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — EAN pri
 * nabavi: DDL korak.
 *
 * Aditivni stolpec `InventoryItem."ean" TEXT NOT NULL DEFAULT ''` (prazno =
 * artikel brez kode). Koda dobavitelja se vpisuje v zalogi (nov artikel /
 * urejanje EAN) in se skenira pri prevzemu (PO vrstica z vezanim
 * inventoryItemId). Čisti sloj src/lib/ean.ts (normalizacija, GS1 kontrolni
 * modul-10); duplikat check 409 v aplikačnem sloju.
 *
 * Idempotentno: preverba obstoja stolpca PRED izvedbo (dialekt-agnostična
 * probe — SELECT z manjkajočim stolpcem vrne P2010/P2022 na PG in
 * "no such column" na SQLite, oboje prek isMissingSchemaError; infrastrukturne
 * napake se propagirajo — konzola pokaže resnico, ne lažnega stanja). Dev
 * SQLite dobi stolpec prek db push mirrorja, produkcijski Neon čaka ta korak
 * (konzola Enterprise → Shema migracije → EAN). Samo centralne vloge
 * (requireCentralRole). Fiksna aditivna DDL — brez prostoformskega SQL.
 */

const ADD_EAN_COLUMN = `ALTER TABLE "InventoryItem" ADD COLUMN "ean" TEXT NOT NULL DEFAULT ''`

async function eanColumnExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "ean" FROM "InventoryItem" LIMIT 1`)
    return true
  } catch (e) {
    if (isMissingSchemaError(e)) return false
    throw e // infra napaka (P1001 unreachable, timeout …) → status error, brez maskiranja
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  try {
    if (await eanColumnExists()) {
      skipped.push('InventoryItem.ean')
    } else {
      await db.$executeRawUnsafe(ADD_EAN_COLUMN)
      applied.push('InventoryItem.ean')
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_INVENTORY_EAN',
      entityType: 'SchemaMigration',
      entityId: 'inventory-ean',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-inventory-ean' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
