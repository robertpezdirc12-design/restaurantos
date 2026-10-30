import { db } from '@/lib/db'
import { num } from '@/lib/map'
import type { SurchargeRates } from './payroll-rates'

/**
 * N-27-3 (v1.197.0) — shramba NOG DOPLAČIL (tabela PayrollSurchargeRate).
 *
 * Vzorec payroll-schema.ts (issue #22): vroče poti NIKOLI ne padajo na šemo —
 * pred DDL (produkcija čaka /api/admin/migrate-payroll-surcharge-rates) rute
 * vračajo 503 (konfiguracija) oz. degradirajo (detail/izvoz: minute brez
 * zneskov, surchargeRates null — graceful).
 */

let cache: boolean | null = null

/** Probe: tabela PayrollSurchargeRate obstaja (memoizirano). */
export async function surchargeRatesTableReady(): Promise<boolean> {
  if (cache !== null) return cache
  try {
    await db.$queryRawUnsafe('SELECT "id" FROM "PayrollSurchargeRate" LIMIT 1')
    cache = true
  } catch {
    cache = false
  }
  return cache
}

/** test hook (vzorec __setPayrollTablesCacheForTests) */
export function __setSurchargeRatesCacheForTests(v: boolean | null): void {
  cache = v
}

export function __resetSurchargeRatesCacheForTests(): void {
  cache = null
}

/** Noge + vir ('location' = lokacija obdobja; 'default' = privzete/NULL vrstica). */
export interface LocatedRates extends SurchargeRates {
  locationId: string | null
  source: 'location' | 'default'
}

/**
 * Lookup nog za obdobje: najprej vrstica ZA LOKACIJO, sicer PRIVZETE (NULL).
 * Nič od tega → null (noge niso nastavljene — zneski se ne izračunajo;
 * izvoz nosi samo minute — NIČ ne izmišljujemo).
 */
export async function lookupSurchargeRates(locationId: string | null): Promise<LocatedRates | null> {
  if (!(await surchargeRatesTableReady())) return null
  const fromLocation = locationId
    ? await db.payrollSurchargeRate.findUnique({ where: { locationId } })
    : null
  // NULL fallback prek findFirst (findUnique z null vrednostjo unikatnega polja
  // Prisma zavrne — isti quirk, ki ga upsert obide s findFirst+create/update)
  const row = fromLocation ?? (await db.payrollSurchargeRate.findFirst({ where: { locationId: null } }))
  if (!row) return null
  return {
    locationId: fromLocation ? locationId : null,
    source: fromLocation ? 'location' : 'default',
    nightPct: num(row.nightPct),
    sundayPct: num(row.sundayPct),
    holidayPct: num(row.holidayPct),
    overtimePct: num(row.overtimePct),
  }
}

/** Upsert nog (findFirst + create/update — NULL locationId v SQLite/Postgres
 * unique indexu ne podpira prisma upsert) v transakciji; vrne LocatedRates. */
export async function saveSurchargeRates(
  locationId: string | null,
  rates: SurchargeRates,
  updatedById: string,
): Promise<LocatedRates> {
  return db.$transaction(async (tx) => {
    const existing = await tx.payrollSurchargeRate.findFirst({ where: { locationId: locationId ?? null } })
    const data = {
      nightPct: rates.nightPct,
      sundayPct: rates.sundayPct,
      holidayPct: rates.holidayPct,
      overtimePct: rates.overtimePct,
      updatedById,
    }
    if (existing) {
      await tx.payrollSurchargeRate.update({ where: { id: existing.id }, data })
    } else {
      await tx.payrollSurchargeRate.create({ data: { locationId: locationId ?? null, ...data } })
    }
    return {
      locationId,
      source: 'location' as const,
      nightPct: rates.nightPct,
      sundayPct: rates.sundayPct,
      holidayPct: rates.holidayPct,
      overtimePct: rates.overtimePct,
    }
  })
}
