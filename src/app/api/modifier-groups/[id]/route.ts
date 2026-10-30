import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { isVariantGroup, VARIANT_NAME_MAX } from '@/lib/item-variants'

/**
 * OSS-10 (v1.209.0) — VARIANTE ARTIKLOV: urejanje/brisanje skupine opcij.
 *
 * PATCH  /api/modifier-groups/[id]  — name / required / minSelect / maxSelect /
 *                                     sortOrder (delno: absent = nespremenjeno);
 *                                     maxSelect: null = neomejeno
 * DELETE /api/modifier-groups/[id]  — brisanje skupine: opcije in povezave na
 *                                     artikle kaskadirajo (shema), OrderItemModifier
 *                                     vrstice zgodovine NISO izgubljene — posnetek
 *                                     (name/modifierGroupName) ostane, tuji ključ
 *                                     gre na NULL (SetNull po shemi)
 * Dovoljenje: menu.manage + guardResource (lokacija skupine) — vzorec PATCH
 * /api/modifiers/[id]; audit-chain: MODIFIER_GROUP_UPDATED / MODIFIER_GROUP_DELETED.
 */

function selectInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isInteger(n) && n >= 0 && n <= 50 ? n : null
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const data: { name?: string; required?: boolean; minSelect?: number; maxSelect?: number | null; sortOrder?: number } = {}
  const changed: string[] = []

  if (b?.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : ''
    if (!name) return fail('Ime skupine je obvezno.', 400)
    if (name.length > VARIANT_NAME_MAX) return fail(`Ime skupine je predolgo (največ ${VARIANT_NAME_MAX} znakov).`, 400)
    if (name !== group.name) { data.name = name; changed.push('name') }
  }
  if (b?.required !== undefined) {
    const required = b.required === true
    if (required !== group.required) { data.required = required; changed.push('required') }
  }
  let nextMin = group.minSelect
  if (b?.minSelect !== undefined) {
    const min = selectInt(b.minSelect)
    if (min === null) return fail('minSelect mora biti celo število 0–50.', 400)
    if (min !== group.minSelect) { data.minSelect = min; changed.push('minSelect') }
    nextMin = min
  }
  let nextMax = group.maxSelect
  if (b?.maxSelect !== undefined) {
    if (b.maxSelect === null) {
      if (group.maxSelect !== null) { data.maxSelect = null; changed.push('maxSelect') }
      nextMax = null
    } else {
      const max = selectInt(b.maxSelect)
      if (max === null || max < 1) return fail('maxSelect mora biti celo število 1–50 ali null (neomejeno).', 400)
      if (max !== group.maxSelect) { data.maxSelect = max; changed.push('maxSelect') }
      nextMax = max
    }
  }
  if (nextMax !== null && nextMin > nextMax) return fail('minSelect ne sme presegati maxSelect.', 400)
  if (b?.sortOrder !== undefined) {
    const sortOrder = selectInt(b.sortOrder)
    if (sortOrder === null) return fail('sortOrder mora biti celo število 0–50.', 400)
    if (sortOrder !== group.sortOrder) { data.sortOrder = sortOrder; changed.push('sortOrder') }
  }

  if (changed.length === 0) return ok({ group: { ...group, variant: isVariantGroup(group) }, changed })

  const updated = await db.$transaction(async (tx) => {
    const g = await tx.modifierGroup.update({ where: { id }, data })
    await writeAudit(tx, {
      userId: user.sub,
      action: 'MODIFIER_GROUP_UPDATED',
      entityType: 'ModifierGroup',
      entityId: id,
      details: jstr({
        group: group.name,
        changed,
        old: { name: group.name, required: group.required, minSelect: group.minSelect, maxSelect: group.maxSelect, sortOrder: group.sortOrder },
        new: { name: g.name, required: g.required, minSelect: g.minSelect, maxSelect: g.maxSelect, sortOrder: g.sortOrder },
        variant: isVariantGroup(g),
      }),
      locationId: group.locationId || undefined,
    })
    return g
  })

  return ok({ group: { ...updated, variant: isVariantGroup(updated) }, changed })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user

  const { id } = await params
  const group = await db.modifierGroup.findUnique({
    where: { id },
    include: { _count: { select: { Modifier: true, MenuItemModifierGroup: true } } },
  })
  if (!group) return fail('Skupina opcij ne obstaja.', 404)

  const guard = await guardResource(user, group.locationId)
  if (guard) return guard

  await db.$transaction(async (tx) => {
    await tx.modifierGroup.delete({ where: { id } })
    await writeAudit(tx, {
      userId: user.sub,
      action: 'MODIFIER_GROUP_DELETED',
      entityType: 'ModifierGroup',
      entityId: id,
      details: jstr({
        group: group.name,
        deletedModifiers: group._count.Modifier,
        deletedLinks: group._count.MenuItemModifierGroup,
        // Zgodovina naročil ostane: OrderItemModifier nosi posnetek (name +
        // modifierGroupName), tuji ključ gre na NULL (SetNull po shemi).
        historyPreserved: true,
      }),
      locationId: group.locationId || undefined,
    })
  })

  return ok({ deleted: id, deletedModifiers: group._count.Modifier, deletedLinks: group._count.MenuItemModifierGroup })
}
