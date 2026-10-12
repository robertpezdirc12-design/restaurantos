import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, locationScope } from '@/lib/api'
import { num } from '@/lib/map'

/**
 * OPS-8 val 2 (v1.72.0) — Serije / rok uporabe (InventoryBatch FEFO seznam).
 *
 * GET /api/inventory/batches?take=50
 *   → { batches: [{ id, itemName, itemUnit, lotNumber, expiryDate, quantityRemaining,
 *        supplierName, locationId }] }
 *
 * Only active batches with quantity > 0 and a set expiry; FEFO order
 * (expiryDate asc, then receivedAt asc); default 50. Permission: requireAuth +
 * locationScope (same as /api/inventory GET). UI: card in Zaloge with badges
 * 'expires <= 7 days' (amber) / expired (rose).
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const take = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('take') || '50', 10) || 50, 1), 200)

  const rows = await db.inventoryBatch.findMany({
    where: {
      ...(await locationScope(user)),
      status: { in: ['active', 'ACTIVE'] },
      quantityRemaining: { gt: 0 },
      expiryDate: { not: null },
    },
    orderBy: [{ expiryDate: 'asc' }, { receivedAt: 'asc' }],
    take,
    include: { InventoryItem: { select: { name: true, unit: true } } },
  })

  return ok({
    batches: rows.map((b) => ({
      id: b.id,
      itemName: b.InventoryItem?.name || '',
      itemUnit: b.InventoryItem?.unit || b.unit,
      lotNumber: b.lotNumber,
      expiryDate: b.expiryDate,
      quantityRemaining: num(b.quantityRemaining),
      supplierName: b.supplierName,
      locationId: b.locationId,
    })),
  })
}
