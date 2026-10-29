import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { isMissingSchemaError } from '@/lib/prisma-missing'

/**
 * P3 #20 (v1.193.0) — SEAT-LEVEL management: DDL korak.
 *
 * Aditivni stolpec `OrderItem."seat" INTEGER` (ničen — postavka brez sedeža).
 * Sedež je oznaka IZVORA postavke (kdo jo je naročil), ortogonalna checkId
 * (izstavek = plačilna skupina) — split po sedežih (POST /api/orders/[id]/checks/seats)
 * iz obstoječih sedežev zgradi izstavke po istem rebalans vzorcu kot split po gostih.
 *
 * Idempotentno: preverba obstoja stolpca PRED izvedbo (dialekt-agnostična probe —
 * SELECT z manjkajočim stolpcem vrne P2010/P2022 na PG in "no such column" na SQLite,
 * oboje prek isMissingSchemaError; infrastrukturne napake se propagirajo — konzola
 * pokaže resnico, ne lažnega stanja). Dev SQLite dobi stolpec prek db push mirrorja,
 * produkcijski Neon čaka ta korak (konzola Enterprise → Shema migracije → sedeži).
 * Samo centralne vloge (requireCentralRole). Fiksna aditivna DDL — brez prostoformskega SQL.
 */

const ADD_SEAT_COLUMN = 'ALTER TABLE "OrderItem" ADD COLUMN "seat" INTEGER'

async function seatColumnExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "seat" FROM "OrderItem" LIMIT 1`)
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
    if (await seatColumnExists()) {
      skipped.push('OrderItem.seat')
    } else {
      await db.$executeRawUnsafe(ADD_SEAT_COLUMN)
      applied.push('OrderItem.seat')
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_ORDER_ITEM_SEATS',
      entityType: 'SchemaMigration',
      entityId: 'order-item-seats',
      details: jstr({ applied, skipped: skipped.length, endpoint: '/api/admin/migrate-order-item-seats' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
