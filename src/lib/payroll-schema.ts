import { db } from '@/lib/db'

/**
 * Issue #22 — capability probe za obračunske (payroll) rute.
 *
 * Vzorec labelTablesReady (issue #24): vroče poti NIKOLI ne padajo na šemo —
 * pred DDL (produkcija čaka /api/admin/migrate-payroll-periods) rute vračajo
 * 503 s prijaznim sporočilom (graceful — evidence časa se ne dotakne).
 */

let cache: boolean | null = null

export async function payrollTablesReady(): Promise<boolean> {
  if (cache !== null) return cache
  try {
    await db.$queryRawUnsafe('SELECT "id" FROM "PayrollPeriod" LIMIT 1')
    await db.$queryRawUnsafe('SELECT "id" FROM "PayrollExport" LIMIT 1')
    cache = true
  } catch {
    cache = false
  }
  return cache
}

/** test hook (vzorec __setLabelTablesCacheForTests) */
export function __setPayrollTablesCacheForTests(v: boolean | null): void {
  cache = v
}

export function __resetPayrollTablesCacheForTests(): void {
  cache = null
}
