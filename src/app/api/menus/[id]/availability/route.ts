import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * OPS-4 (v1.67.0) — "86 / razprodano": STROGO ozek endpoint za toggle
 * razpoložljivosti artikla (MenuItem.isAvailable).
 *
 * ZAKAJ LOČENO od PATCH /api/menus/[id] (menu.manage): matrica dovoljenj
 * (docs/GAP-ANALIZA-funkcije-in-dovoljenja.md §4b) daje kuhinji in sanku
 * `menu.availability` (odvzem artikla, ko je zmanjka), NE pa `menu.manage`
 * (urejanje cen/imen). Endpoint zato dovoljuje IZKLJUČNO isAvailable toggle —
 * nobeno drugo polje ni dosegljivo (fail-closed: body.available je obvezen
 * boolean, vse ostalo ignoriramo).
 *
 * Audit: MENU_ITEM_AVAILABILITY (audit chain, enak vzorec kot MENU_ITEM_UPDATE).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'menu.availability')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (typeof body?.available !== 'boolean') {
    return fail('Polje "available" (boolean) je obvezno.')
  }
  const existing = await db.menuItem.findUnique({
    where: { id },
    select: { id: true, name: true, isAvailable: true, Category: { select: { Menu: { select: { locationId: true } } } } },
  })
  if (!existing) return fail('Artikel ne obstaja.', 404)
  const locRes = await guardResource(user, existing.Category?.Menu?.locationId)
  if (locRes) return locRes
  if (existing.isAvailable === body.available) {
    return ok({ id, available: body.available, unchanged: true })
  }
  await db.menuItem.update({ where: { id }, data: { isAvailable: body.available } })
  await writeAudit(db, { userId: user.sub, action: 'MENU_ITEM_AVAILABILITY', entityType: 'MenuItem', entityId: id, details: jstr({ name: existing.name, from: existing.isAvailable, to: body.available }), locationId: existing.Category?.Menu?.locationId ?? null }).catch(() => null)
  return ok({ id, available: body.available, unchanged: false })
}
