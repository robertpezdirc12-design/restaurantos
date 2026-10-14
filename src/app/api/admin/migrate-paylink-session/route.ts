import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'
import { resetPayLinkProbe } from '@/lib/paylink/core'

/**
 * v1.98.0 — Issue #37: produkcijski DDL korak nad obstoječo tabelo PayLink:
 * ADD COLUMN "sessionId" (Text, nullable) — KANONIČNA Stripe Checkout seja
 * povezave. Potrditev plačila (verifySession) sprejme SAMO sejo, ki je
 * atomarno prijavljena na povezavi (CAS) in strežniško vezana prek Stripe
 * metadata (payLinkId/orderId/locationId/znesek/valuta) — plačana seja z
 * istim zneskom iz druge povezave/naročila je ZAVRNJENA.
 *
 * Issue-13/paylink-split vzorec: dev SQLite dobi spremembo prek `prisma db push`
 * (+ regeneriran SQLite zrcalni dump), produkcijski Neon Postgres čaka ta korak
 * (konzola Enterprise → Shema migracije → paylink-session → Uporabi; payLinkReady
 * probe med čakanjem VRAČA 503 na javni pay ruti — prijazna degradacija). Samo
 * centralne vloge (requireCentralRole). Idempotentno: probe (stolpec obstaja?)
 * → alreadyApplied brez DDL; stavek sam nosi IF NOT EXISTS.
 */
const DDL = [
  `ALTER TABLE "PayLink" ADD COLUMN IF NOT EXISTS "sessionId" TEXT`,
]

async function paylinkSessionColumnPresent(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "sessionId" FROM "PayLink" LIMIT 1`)
    return true
  } catch {
    return false
  }
}

async function paylinkTableExists(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "PayLink" LIMIT 1')
    return true
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  // Idempotenca: stolpec že obstaja (ponovni klic / dev SQLite z db push).
  if (await paylinkSessionColumnPresent()) {
    resetPayLinkProbe()
    return ok({ alreadyApplied: true, applied: [] })
  }
  // tabela PayLink še čaka osnovno migracijo (paylink) — ta korak ni mogoč
  if (!(await paylinkTableExists())) {
    return fail('Tabela PayLink še ne obstaja — najprej aplicirajte migracijo paylink.', 409)
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.slice(0, 90) })
  }

  resetPayLinkProbe()

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_PAYLINK_SESSION',
        entityType: 'Schema',
        entityId: 'paylink_session',
        details: JSON.stringify({ statements: DDL.length }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied })
}
