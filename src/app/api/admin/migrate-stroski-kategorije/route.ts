import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'
import { isMissingSchemaError } from '@/lib/prisma-missing'

/**
 * Task 66 (v1.64.0) — Stroški kategorije: produkcijski DDL korak.
 *
 * Zadnja preostala postavka audit §7 (stroški kategorije na AccountsPayable —
 * docs/RESTAURANTOS-AUDIT.md vrstica 122: "kategorije ostajajo izven v1 —
 * zahtevajo DDL"). Issue-13 vzorec (Task 44 / migrate-haccp-plans): fiksna DDL,
 * requireCentralRole, idempotentna pre-aplicirna preverba, audit SCHEMA_MIGRATION_*.
 *
 * RAZLIKA od HaccpPlan: to je NOV STOLPEC na ŽIVEČI tabeli, ne nova tabela —
 * zato main schema.prisma polja (še) NIMA. Prisma client na produkciji (build iz
 * main schema) ne pozná stolpca → dodaten stolpec v Neonu je za clienta neviden
 * (Prisma SELECT-a samo deklarirana polja) → aditivno-varno, NI zastrupitve
 * poizvedb. Dev SQLite: polje je v zrcalni shemi (schema.sqlite.prisma) →
 * `db push` ga ima; probe je tam aplicirana.
 *
 * Naslednja naloga (koda/UI kategorij) doda polje v main schema.prisma — VREDNOST
 * NA PRODUKCIJI je varna ŠELE, ko je ta DDL apliciran (probe applied=true je
 * izrecen predpogoj za tisti deploy).
 *
 * Idempotentno: preverba `SELECT "category" FROM "AccountsPayable" LIMIT 1` —
 * "stolpec manjka" → apliciraj (v1.86.1: P2021/P2022 + P2010/raw s kodo driverja
 * v meta — src/lib/prisma-missing.ts; prej P2022 samo, kar se pri $queryRawUnsafe
 * NIKOLI ne zgodi → produkcija je ob manjkajočem stolpcu napačno vračala 500
 * "Infrastrukturna napaka" namesto DDL — to je bilo razlog, da uporabnikov klik
 * ni uspel); uspeh → alreadyApplied; druge napake (P1001 unreachable …) → 500
 * (infra resnica, ne lažen pending — isti politiki kot probe v
 * src/lib/schema-migrations.ts).
 * DDL je dialekt-kompatibilen (SQLite + Postgres): ADD COLUMN z NOT NULL DEFAULT
 * konstanto (PG 11+ instant, brez rewrite-a).
 * Audit: SCHEMA_MIGRATION_STROSKI_KATEGORIJE.
 */
const DDL = [
  `ALTER TABLE "AccountsPayable" ADD COLUMN "category" TEXT NOT NULL DEFAULT ''`,
]

/** v1.86.1: skupni helper (prisma-missing.ts) — tipizirana + raw plast. */
const isMissingSchema = isMissingSchemaError

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  try {
    // Idempotenca: stolpec že obstaja (dev SQLite po db push / ponovni klic)
    // → nič ne izvajaj, vrni enako obliko odgovora.
    await db.$queryRawUnsafe('SELECT "category" FROM "AccountsPayable" LIMIT 1')
    return ok({ alreadyApplied: true, applied: [] })
  } catch (e) {
    if (!isMissingSchema(e)) {
      // infra napaka (P1001 unreachable, timeout …) → ne laži z DDL stanjem
      return fail(`Infrastrukturna napaka pri preverbi sheme: ${String((e as Error).message).slice(0, 200)}`, 500)
    }
    // P2022 (stolpec manjka; P2021 → tabela manjka — tudi takrat poskusi DDL,
    // ki bo iskren failal, če tabela res ne obstaja) → apliciraj fiksni DDL
  }

  const applied: { ddl: string }[] = []
  for (const ddl of DDL) {
    await db.$executeRawUnsafe(ddl)
    applied.push({ ddl: ddl.split(' ADD COLUMN')[0].trim() + ' ADD COLUMN "category" …' })
  }

  const after = await db.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT count(*) AS cnt FROM "AccountsPayable"`,
  )
  const apCountAfter = Number(after[0]?.cnt ?? 0)

  await db.auditLog
    .create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'SCHEMA_MIGRATION_STROSKI_KATEGORIJE',
        entityType: 'Schema',
        entityId: 'accounts_payable_category',
        details: JSON.stringify({ statements: DDL.length, apCountAfter }),
      },
    })
    .catch(() => null)

  return ok({ alreadyApplied: false, applied, apCountAfter })
}
