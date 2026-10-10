import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'

/**
 * Issue #13 P2 — premisesId nullable (Task 44).
 *
 * Location.premisesId je bil `String @unique @default("")` — latentni kolizijski
 * bug: 2. lokacija brez FURS oznake poskuša vstaviti drugo '' in trči na P2002
 * (multi-lokacija = osnovni use case). Fix: stolpec postane NULL-able, prazne
 * vrednosti se očistijo v NULL (unique indeks dovoljuje več NULL vrednosti,
 * tako v Postgresu kot SQLite).
 *
 * Samo za centralne vloge (requireCentralRole — DB vloga owner/admin; N4 audit P1).
 * Idempotentno (DROP DEFAULT/DROP NOT NULL sta neškodljiva, UPDATE se ujema z ''
 * samo dokler take obstajajo). Brez prostoformskega SQL — izvajajo se izključno
 * fiksne DDL izjave (enaka politika kot migrate-issue3/issue10). DDL je Postgres
 * (Neon prod); dev SQLite gredo iste spremembe prek `prisma db push`.
 * Audit: SCHEMA_MIGRATION_ISSUE13.
 */
const DDL = [
  'ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP DEFAULT',
  'ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL',
  'UPDATE "Location" SET "premisesId" = NULL WHERE "premisesId" = \'\'',
]

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  try {
    const before = await db.$queryRawUnsafe<{ cnt: bigint }[]>(
      `SELECT count(*) AS cnt FROM "Location" WHERE "premisesId" = ''`,
    )
    const clearedBefore = Number(before[0]?.cnt ?? 0)

    const applied: { ddl: string; affected: number }[] = []
    for (const ddl of DDL) {
      const affected = await db.$executeRawUnsafe(ddl)
      applied.push({ ddl, affected: Number(affected) })
    }

    const after = await db.$queryRawUnsafe<{ cnt: bigint; nulls: bigint }[]>(
      `SELECT count(*) FILTER (WHERE "premisesId" = '') AS cnt, count(*) FILTER (WHERE "premisesId" IS NULL) AS nulls FROM "Location"`,
    )

    await db.auditLog
      .create({
        data: {
          id: nid(),
          userId: user.sub,
          action: 'SCHEMA_MIGRATION_ISSUE13',
          entityType: 'Schema',
          entityId: 'location_premises_nullable',
          details: JSON.stringify({ clearedBefore, after: { empty: Number(after[0]?.cnt ?? 0), nulls: Number(after[0]?.nulls ?? 0) } }),
        },
      })
      .catch(() => null)

    return ok({
      migrated: true,
      clearedBefore,
      steps: applied,
      after: { empty: Number(after[0]?.cnt ?? 0), nulls: Number(after[0]?.nulls ?? 0) },
    })
  } catch (e) {
    return fail(`Migracija ni uspela: ${(e as Error).message}`, 500)
  }
}
