import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * N-27-3 (v1.197.0, docs/TRZNA-VRZELI-2027.md) — noge doplačil obračuna: DDL korak.
 *
 * NOVA tabela PayrollSurchargeRate — ena vrstica na lokacijo (@@unique(locationId);
 * NULL = privzete noge za obdobja brez lokacije), odstotki doplačil noč/nedelja/
 * praznik/nadure Decimal(5,2). Noge so UPORABNIŠKI vhod po kolektivni pogodbi
 * lastnika (sistem NIKOLI ne trdi, da je noga »zakonska« — zakonitost potrdi
 * biro); čisti sloj payroll-rates.ts + payroll-surcharges.ts iz minut in
 * posnetkov postavk izračuna ZNESKE (payroll-export/3 nosi zneske ob minutah).
 *
 * Skalarna vezava brez FK (PrepLabel/PayrollPeriod vzorec). Idempotentno:
 * tabela/indeks IF NOT EXISTS (Postgres); SQLite (dev prek db push že
 * prisotno) duplikate tiho preskoči. Samo centralne vloge (requireCentralRole).
 * Do DDL: /api/payroll/surcharge-rates → 503; detail/izvoz degradirata
 * (minute brez zneskov, surchargeRates null — graceful).
 */

const CREATE_RATES_TABLE = `CREATE TABLE IF NOT EXISTS "PayrollSurchargeRate" (
  "id" TEXT NOT NULL,
  "locationId" TEXT,
  "nightPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "sundayPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "holidayPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "overtimePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedById" TEXT,
  CONSTRAINT "PayrollSurchargeRate_pkey" PRIMARY KEY ("id")
)`

const UNIQUE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "PayrollSurchargeRate_locationId_key" ON "PayrollSurchargeRate"("locationId")`,
]

async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
      table,
    )
    return Array.isArray(rows) && rows.length > 0
  } catch {
    // SQLite (dev/CI): information_schema ne obstaja — tabele so že prek db push
    return true
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []

  try {
    if (await tableExists('PayrollSurchargeRate')) {
      skipped.push('PayrollSurchargeRate')
    } else {
      await db.$executeRawUnsafe(CREATE_RATES_TABLE)
      applied.push('PayrollSurchargeRate')
    }
    for (const ix of UNIQUE_INDEXES) {
      await db.$executeRawUnsafe(ix)
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_PAYROLL_SURCHARGE_RATES',
      entityType: 'SchemaMigration',
      entityId: 'payroll-surcharge-rates',
      details: jstr({
        applied,
        skipped: skipped.length,
        endpoint: '/api/admin/migrate-payroll-surcharge-rates',
      }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, skipped, alreadyApplied: applied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
