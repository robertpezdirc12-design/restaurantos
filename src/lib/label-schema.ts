import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { num } from '@/lib/map'
import { parseAllergenCodes } from '@/lib/allergen-catalog'
import { labelScanStatus, type LabelScanBatchInfo } from '@/lib/label'

/**
 * Issue #24 — capability probe + skupni DTO pomočniki za etiketne rute.
 *
 * Vzorec lotGovernanceColumnsReady: vroče poti NIKOLI ne padajo na šemo —
 * pred DDL (produkcija čaka /api/admin/migrate-prep-labels) rute vračajo
 * 503 s prijaznim sporočilom (graceful — serije/priprava/tisk se ne dotaknejo).
 */

let cache: boolean | null = null

export async function labelTablesReady(): Promise<boolean> {
  if (cache !== null) return cache
  try {
    await db.$queryRawUnsafe('SELECT "id" FROM "PrepLabel" LIMIT 1')
    await db.$queryRawUnsafe('SELECT "id" FROM "LabelShelfRule" LIMIT 1')
    cache = true
  } catch {
    cache = false
  }
  return cache
}

/** test hook (vzorec __setLotGovernanceCacheForTests) */
export function __setLabelTablesCacheForTests(v: boolean | null): void {
  cache = v
}

export function __resetLabelTablesCacheForTests(): void {
  cache = null
}

/** URL javne statusne strani etikete (request izvorno gostiteljstvo). */
export function labelUrl(req: NextRequest, token: string): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000'
  return `${proto}://${host}/label/${token}`
}

/** Strukturni tip vrstice PrepLabel (skalarne vezave, delegirani Prisma model). */
export interface PrepLabelRow {
  id: string
  locationId: string
  source: string
  batchId: string | null
  preparationId: string | null
  inventoryItemId: string
  itemName: string
  itemUnit: string
  lotNumber: string
  quantity: unknown
  area: string
  preparedAt: Date | null
  expiresAt: Date | null
  ruleSource: string
  ruleHours: number | null
  ruleConfirmedBy: string
  needsReview: boolean
  allergens: string
  preparedById: string
  preparedByName: string
  status: string
  printCount: number
  lastPrintedAt: Date | null
  note: string
  voidReason: string
  createdAt: Date
}

/** DTO za API odgovore (alergenske kode razpakirane + scan status). */
export function labelOut(
  l: PrepLabelRow,
  bucket: { bucket: string | null } | null,
  now: Date = new Date(),
) {
  return {
    id: l.id,
    source: l.source,
    batchId: l.batchId,
    preparationId: l.preparationId,
    inventoryItemId: l.inventoryItemId,
    itemName: l.itemName,
    itemUnit: l.itemUnit,
    lotNumber: l.lotNumber,
    quantity: num(l.quantity),
    area: l.area,
    preparedAt: l.preparedAt,
    expiresAt: l.expiresAt,
    ruleSource: l.ruleSource,
    ruleHours: l.ruleHours,
    ruleConfirmedBy: l.ruleConfirmedBy,
    needsReview: l.needsReview,
    allergens: parseAllergenCodes(l.allergens).codes,
    preparedById: l.preparedById,
    preparedByName: l.preparedByName,
    status: l.status,
    printCount: l.printCount,
    lastPrintedAt: l.lastPrintedAt,
    note: l.note,
    createdAt: l.createdAt,
    scanStatus: labelScanStatus(
      { status: l.status, needsReview: l.needsReview, expiresAt: l.expiresAt, batch: bucket as LabelScanBatchInfo | null },
      now,
    ),
  }
}
