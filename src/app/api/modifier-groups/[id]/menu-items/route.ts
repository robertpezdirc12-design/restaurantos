import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * OSS-10 (v1.209.0) — VARIANTE ARTIKLOV: povezava skupine opcij na artikle.
 *
 * POST /api/modifier-groups/[id]/menu-items
 *   body: { menuItemId: string, action?: 'attach' | 'detach' }  (privzeto attach)
 *
 * MenuItemModifierGroup je M:N povezovalna tabela (@@unique(menuItemId,
 * modifierGroupId)) — attach je idempotenten (upsert, ponovitev = brez spremembe),
 * detach pa deleteMany (ponovitev = brez spremembe). Artikel mora pripadati ISTI
 * lokaciji kot skupina (MenuItem nima locationId — veriga Category → Menu, isti
 * vzorec kot menus POST). Dovoljenje: menu.manage + guardResource; audit-chain:
 * MODIFIER_GROUP_LINKED / MODIFIER_GROUP_UNLINKED.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user

  const { id } = await params
  const group = await db.modifierGroup.findUnique({ where: { id } })
  if (!group) return fail('Skupina opcij ne obstaja.', 404)

  const guard = await guardResource(user, group.locationId)
  if (guard) return guard

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Neveljavno telo zahteve.', 400)
  const b = body as Record<string, unknown>

  const menuItemId = typeof b?.menuItemId === 'string' ? b.menuItemId.trim() : ''
  if (!menuItemId) return fail('menuItemId je obvezen.', 400)
  const action = b?.action === 'detach' ? 'detach' : 'attach'

  const menuItem = await db.menuItem.findUnique({
    where: { id: menuItemId },
    select: { id: true, name: true, Category: { select: { Menu: { select: { locationId: true } } } } },
  })
  if (!menuItem) return fail('Artikel ne obstaja.', 404)
  const itemLocationId = menuItem.Category?.Menu?.locationId ?? null
  if (!itemLocationId || itemLocationId !== group.locationId) {
    return fail('Artikel ne pripada lokaciji skupine opcij.', 400)
  }

  const link = await db.$transaction(async (tx) => {
    if (action === 'attach') {
      const l = await tx.menuItemModifierGroup.upsert({
        where: { menuItemId_modifierGroupId: { menuItemId, modifierGroupId: id } },
        create: { id: nid(), menuItemId, modifierGroupId: id },
        update: {},
      })
      await writeAudit(tx, {
        userId: user.sub,
        action: 'MODIFIER_GROUP_LINKED',
        entityType: 'ModifierGroup',
        entityId: id,
        details: jstr({ group: group.name, menuItem: menuItem.name, menuItemId }),
        locationId: group.locationId || undefined,
      })
      return l
    }
    const l = await tx.menuItemModifierGroup.deleteMany({ where: { menuItemId, modifierGroupId: id } })
    await writeAudit(tx, {
      userId: user.sub,
      action: 'MODIFIER_GROUP_UNLINKED',
      entityType: 'ModifierGroup',
      entityId: id,
      details: jstr({ group: group.name, menuItem: menuItem.name, menuItemId, removed: l.count }),
      locationId: group.locationId || undefined,
    })
    return null
  })

  const links = await db.menuItemModifierGroup.count({ where: { modifierGroupId: id } })
  return ok({ attached: action === 'attach', links, ...(link ? { linkId: link.id } : {}) })
}
