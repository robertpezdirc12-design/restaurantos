import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * v1.245.0 (PRIMERJAVA-VMESNIKOV-2026 §19): KOMBINACIJSKI VAL — DDL korak.
 *
 * Stolpec Reservation."comboTableIds" (TEXT NOT NULL DEFAULT '') nosi vse
 * mize kombinacijske rezervacije kot ',id1,id2,' (vključno s primarno iz
 * tableId). Prazno = enostavna rezervacija ene mize — obstoječe vrstice
 * nespremenjene (čisto aditivno, isti varnostni profil kot receipt-snapshot
 * v1.239.1).
 *
 * VROČA POT: main shema (PG) je stolpec prevzela v tej verziji — Prisma
 * klient ga bere pri vsakem findMany/findUnique na Reservation, zato na
 * produkciji brez tega koraka PADAJO VSE rezervacijske rute (P2022), ne
 * samo kombinacijska. Korak apliciramo TAKOJ po deployu (vzorec
 * issue31-36/38 + receipt-snapshot).
 *
 * Idempotentno: probe obstoja stolpca PRED izvedbo (P2022 na PG, "no such
 * column" na SQLite); dev/CI SQLite ima stolpec prek db push zrcala
 * (preskok). Samo centralne vloge (requireCentralRole).
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
      if (msg.includes('no such column') || msg.includes('does not exist') || msg.includes('P2022')) return false
      throw e // infra napaka (P1001 unreachable, timeout …) → brez maskiranja
    }
  }

  try {
    if (await columnExists(`SELECT "comboTableIds" FROM "Reservation" LIMIT 1`)) {
      skipped.push('Reservation.comboTableIds')
    } else {
      await db.$executeRawUnsafe(`ALTER TABLE "Reservation" ADD COLUMN "comboTableIds" TEXT NOT NULL DEFAULT ''`)
      applied.push('Reservation.comboTableIds')
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_RESERVATION_COMBO',
      entityType: 'SchemaMigration',
      entityId: 'reservation-combo',
      details: jstr({ applied, skipped, by: user.name, at: new Date().toISOString() }),
    })
    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak reservation-combo ni uspel: ${String((e as Error).message || e).slice(0, 200)}`, 500)
  }
}
