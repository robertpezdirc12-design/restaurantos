import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { num } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.inventoryItem.findMany({ orderBy: { name: 'asc' }, take: 100 })
  return ok({
    inventory: rows.map((r) => ({
      id: r.id,
      name: r.name,
      unit: r.unit,
      qty: num(r.quantity),
      minQty: num(r.minQuantity),
      cost: num(r.costPerUnit),
      supplierId: r.supplier || null,
      locationId: r.locationId,
    })),
  })
}
