import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * PRIMERJAVA §38 (v1.264.0) — ROČNO ZAPOREDJE LISTKOV NA KDS (Square
 * Vol 16, 5. 11. 2026 »Draggable ticket reordering on KDS«): 1 nov
 * stolpec na Order:
 *   - "ticketSequence" INTEGER NULL (ničen = brez ročnega mesta)
 *
 * Način vrstnega reda Manual/Default je per naprava (localStorage,
 * Issue #74 družina); sekvenca pa je ENA globalna resnica per
 * lokacija — shrani se ob vsakem vlečenju (PATCH /api/kitchen
 * {reorder}) in se sinhronizira na druge KDS naprave iste lokacije
 * z istim načinom Manual (15 s poll; SSE podpis se namerno NE dvigne
 * — reorder ni vsebinska sprememba listka in ne sme utripati »NOV«).
 *
 * Do DDL: GET /api/kitchen vrača prazno mapo sekvenc + DDL zastavico
 * false (graceful — vrsta enaka default), PATCH reorder → 503 s potjo
 * do te konzole (issue-13/stroski-kategorije/exception-policy/
 * receipt-display-policy vzorec: dev SQLite dobi stolpec prek mirror
 * sheme, produkcijski Neon Postgres čaka ta korak). Idempotentno.
 */
const DDL = [
  `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "ticketSequence" INTEGER`,
]

async function sequenceColumnPresent(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "ticketSequence" FROM "Order" LIMIT 1`)
    return true
  } catch {
    return false
  }
}

async function orderTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "Order" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  if (await sequenceColumnPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await orderTableExists())) {
    return fail('Tabela Order ne obstaja — baza ni inicializirana.', 409)
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.slice(0, 90) })
  }

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_KDS_TICKET_SEQUENCE',
        entityType: 'Schema',
        entityId: 'kds_ticket_sequence',
        details: JSON.stringify({ statements: DDL.length, nullable: true, default: null }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
