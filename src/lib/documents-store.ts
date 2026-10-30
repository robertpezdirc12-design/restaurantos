import { db } from '@/lib/db'

/**
 * OSS-2 (v1.203.0) — shramba dokumentov (tabela Document).
 *
 * Vzorec equipment-store.ts (OSS-1): vroče poti NIKOLI ne padajo na šemo —
 * pred DDL (produkcija čaka /api/admin/migrate-documents) rute vračajo 503
 * (konfiguracija). Probe je memoizirana; test hooki omogočajo deterministično
 * simulacijo 503 brez rušenja sheme.
 */

let cache: boolean | null = null

/** Probe: tabela Document obstaja (memoizirano). */
export async function documentsTableReady(): Promise<boolean> {
  if (cache !== null) return cache
  try {
    await db.$queryRawUnsafe('SELECT "id" FROM "Document" LIMIT 1')
    cache = true
  } catch {
    cache = false
  }
  return cache
}

/** test hook (vzorec __setEquipmentTableReadyForTests) */
export function __setDocumentsTableReadyForTests(v: boolean | null): void {
  cache = v
}

export function __resetDocumentsTableReadyForTests(): void {
  cache = null
}
