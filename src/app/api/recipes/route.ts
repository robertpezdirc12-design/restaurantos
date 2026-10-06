import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { num } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.recipeItem.findMany({
    include: {
      MenuItem: { select: { id: true, name: true } },
      InventoryItem: { select: { id: true, name: true, unit: true } },
    },
    take: 500,
  })
  const byItem = new Map<string, { id: string; name: string; instructions: string; items: { inventoryItemId: string; name: string; unit: string; qty: number }[] }>()
  for (const r of rows) {
    const key = r.menuItemId
    if (!byItem.has(key)) {
      byItem.set(key, {
        id: key,
        name: r.MenuItem?.name || 'Artikel',
        instructions: '',
        items: [],
      })
    }
    byItem.get(key)!.items.push({
      inventoryItemId: r.inventoryItemId,
      name: r.InventoryItem?.name || 'Sestavina',
      unit: r.unit || r.InventoryItem?.unit || '',
      qty: num(r.quantityPerServing),
    })
  }
  return ok({ recipes: [...byItem.values()] })
}
