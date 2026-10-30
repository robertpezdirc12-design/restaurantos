import { db } from '@/lib/db'

/**
 * OSS-1 (v1.200.0) — shramba opreme (tabele Equipment/EquipmentMaintenancePlan).
 *
 * Vzorec payroll-rates-store.ts (N-27-3): vroče poti NIKOLI ne padajo na šemo —
 * pred DDL (produkcija čaka /api/admin/migrate-equipment-maintenance) rute
 * vračajo 503 (konfiguracija). Probe je memoizirana; test hooki omogočajo
 * deterministično simulacijo 503 brez rušenja sheme.
 */

let cache: boolean | null = null

/** Probe: tabela Equipment obstaja (memoizirano). */
export async function equipmentTableReady(): Promise<boolean> {
  if (cache !== null) return cache
  try {
    await db.$queryRawUnsafe('SELECT "id" FROM "Equipment" LIMIT 1')
    cache = true
  } catch {
    cache = false
  }
  return cache
}

/** test hook (vzorec __setSurchargeRatesCacheForTests) */
export function __setEquipmentTableReadyForTests(v: boolean | null): void {
  cache = v
}

export function __resetEquipmentTableReadyForTests(): void {
  cache = null
}
