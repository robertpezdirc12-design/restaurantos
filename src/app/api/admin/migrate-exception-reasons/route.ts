import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #19 (P1/P2, v1.107.0) — katalog razlogov izjem (exception-reasons):
 *  2 nova stolpca na obstoječem modelu VoidReason (PONOVNA UPORABA — issue:
 *  »ne uvajaj vzporednega sistema razlogov«):
 *   - "kind"           VARCHAR(20) NOT NULL DEFAULT 'void'
 *   - "requireComment" BOOLEAN     NOT NULL DEFAULT FALSE
 *
 * kind: 'void' | 'discount' | 'cancel' | 'storno' | 'any' — vrsta izjeme
 * sprejema svoj kind + 'any'. Obstoječe vrstice ostanejo 'void' (dosedanja
 * semantika preklica postavke). 'any' razlogi so veljavni za vse vrste.
 * requireComment: obvezen komentar za posamezen razlog (npr. »Drugo«).
 *
 * Do DDL: katalog je uporabljiv SAMO za void; discount/cancel/storno
 * uporabijo prosto besedilo (graceful). Idempotentno (IF NOT EXISTS + probe).
 */
const DDL = [
  `ALTER TABLE "VoidReason" ADD COLUMN IF NOT EXISTS "kind" VARCHAR(20) NOT NULL DEFAULT 'void'`,
  `ALTER TABLE "VoidReason" ADD COLUMN IF NOT EXISTS "requireComment" BOOLEAN NOT NULL DEFAULT FALSE`,
]

async function reasonColumnsPresent(): Promise<boolean> {
  for (const col of ['kind', 'requireComment']) {
    try {
      await db.$queryRawUnsafe(`SELECT "${col}" FROM "VoidReason" LIMIT 1`)
    } catch {
      return false
    }
  }
  return true
}

async function reasonTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "VoidReason" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  if (await reasonColumnsPresent()) {
    return ok({ alreadyApplied: true, applied: [] })
  }
  if (!(await reasonTableExists())) {
    return fail('Tabela VoidReason ne obstaja — baza ni inicializirana.', 409)
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
        action: 'SCHEMA_MIGRATION_EXCEPTION_REASONS',
        entityType: 'Schema',
        entityId: 'exception_reasons',
        details: JSON.stringify({ statements: DDL.length, defaults: { kind: 'void', requireComment: false } }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
