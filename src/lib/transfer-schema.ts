import { db } from '@/lib/db'

/**
 * Issue #8 (v1.116.0 — medlokacijski prenosi) — capability probe za /api/transfers*.
 *
 * Vzorec payrollTablesReady (issue #22) / labelTablesReady (issue #24): vroče
 * poti NIKOLI ne padajo na šemo — pred DDL (produkcija čaka
 * /api/admin/migrate-stock-transfers prek konzole) rute vračajo 503 s
 * prijaznim sporočilom (graceful — zaloga/serije/nabava tokovi se ne dotaknejo).
 *
 * Za razliko od payroll probe ima ta cache 60 s TTL: po DDL koraku (konzola
 * "Enterprise → Shema migracije") rute preidejo iz 503 na 200 najpozneje v
 * minuti — tudi znotraj iste lambde (migrate ruta pokliče resetTransferProbe).
 */

let cache: boolean | null = null
let cacheAt = 0
const TTL_MS = 60_000

export async function transferTablesReady(): Promise<boolean> {
  const now = Date.now()
  if (cache !== null && now - cacheAt < TTL_MS) return cache
  try {
    await db.$queryRawUnsafe('SELECT "id" FROM "StockTransfer" LIMIT 1')
    await db.$queryRawUnsafe('SELECT "id" FROM "StockTransferItem" LIMIT 1')
    cache = true
  } catch {
    cache = false
  }
  cacheAt = now
  return cache
}

/** takojšnja ponastavitev (klic jo uporablja po uspešnem DDL koraku). */
export function resetTransferTablesProbe(): void {
  cache = null
  cacheAt = 0
}

/** test hook (vzorec __setPayrollTablesCacheForTests) */
export function __setTransferTablesCacheForTests(v: boolean | null): void {
  cache = v
  cacheAt = v === null ? 0 : Date.now()
}

export function __resetTransferTablesCacheForTests(): void {
  cache = null
  cacheAt = 0
}
