import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'

/**
 * Issue #5 (komentar #3): katalog razlogov preklica postavke (VoidReason — model
 * obstaja v shemi od N3, bil je mrtev). Seznam aktivnih razlogov za obseg
 * uporabnika (locationScope — razlogi so lokacijski). Branje potrebuje
 * orders.void (isti nabor kot sam preklic — UI izbirnik).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'orders.void')
  if (isResponse(user)) return user
  const rows = await db.voidReason.findMany({
    where: { isActive: true, ...(await locationScope(user)) },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 50,
    select: { id: true, name: true, sortOrder: true },
  })
  return ok({ voidReasons: rows })
}
