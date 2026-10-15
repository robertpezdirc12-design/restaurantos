import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { writeAudit } from '@/lib/audit-chain'
import { jstr } from '@/lib/map'
import {
  sanitizeAllergenCodeList,
  parseAllergenCodes,
} from '@/lib/allergen-catalog'
import {
  flagMenuItemsForAllergenReview,
  menuItemIdsUsingInventoryItem,
} from '@/lib/allergen-profile'

/**
 * Issue #7 (P1, v1.104.0) — strukturirani alergeni SESTAVINE (InventoryItem).
 *
 * POST /api/inventory/allergens
 *   { inventoryItemId, allergens: ["gluten","milk"], crossContact: ["nuts"], confirm?: true }
 *
 *  - dovoljenje: inventory.manage + guardResource (tenant/lokacija sestavine)
 *  - STRICT validacija kod (kanonične 14 EU — sanitizeAllergenCodeList; ostalo → 400)
 *  - crossContact = "lahko vsebuje" (navzkrižna kontaminacija) — IZKLJUČNO ocena
 *    odgovorne osebe (issue #7: nikoli samodejno izpeljana); presek z allergens
 *    se odšteje (allergens je nadvsežnost)
 *  - confirm=true → allergensConfirmedAt/ById (kdaj + kdo); sprememba vsebine
 *    BREZ confirm → stara potrditev se Razveljavi (confirmedAt=null, zastarelo)
 *  - sprememba vsebine → VSE jedi s to sestavino dobijo allergenReviewFlag
 *    (ponovna preverba — vpliv na recepture, ne na zalogo)
 *  - audit INVENTORY_ALLERGENS_SET (staro→novo + potrditev)
 *  - zavrnitev 403 → audit ALLERGEN_ACCESS_DENIED BREZ vrednosti (samo vzrok)
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const user = ctx.user

  if (!ctx.perms.includes('inventory.manage')) {
    await writeAudit(db, {
      userId: user.sub,
      action: 'ALLERGEN_ACCESS_DENIED',
      entityType: 'InventoryItem',
      entityId: 'allergens',
      details: jstr({ op: 'inventory-allergens-set', reason: 'missing-inventory.manage' }),
      locationId: user.loc || undefined,
    }).catch(() => {})
    return fail('Dostop zavrnjen — manjka dovoljenje: inventory.manage.', 403)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail('Neveljavno telo zahteve.', 400)
  }

  const inventoryItemId = String(body?.inventoryItemId || '')
  if (!inventoryItemId) return fail('inventoryItemId je obvezen.', 400)

  const item = await db.inventoryItem.findUnique({ where: { id: inventoryItemId } })
  if (!item) return fail('Sestavina ne obstaja.', 404)

  const guard = await guardResource(user, item.locationId)
  if (guard) {
    await writeAudit(db, {
      userId: user.sub,
      action: 'ALLERGEN_ACCESS_DENIED',
      entityType: 'InventoryItem',
      entityId: inventoryItemId,
      details: jstr({ op: 'inventory-allergens-set', reason: 'cross-tenant' }),
      locationId: item.locationId || undefined,
    }).catch(() => {})
    return guard
  }

  const allergens = sanitizeAllergenCodeList(body?.allergens)
  if (allergens.invalid.length > 0) {
    return fail(
      `Neveljavne alergenske kode (dovoljene: kanonične kode 14 EU kataloga): ${jstr(allergens.invalid).slice(0, 120)}`,
      400,
    )
  }
  const crossRaw = sanitizeAllergenCodeList(body?.crossContact)
  if (crossRaw.invalid.length > 0) {
    return fail(`Neveljavne kode navzkrižne kontaminacije: ${jstr(crossRaw.invalid).slice(0, 120)}`, 400)
  }
  // allergens je nadvsežnost — presek se odšteje iz crossContact
  const crossContact = crossRaw.codes.filter((c) => !allergens.codes.includes(c))

  const oldCodes = parseAllergenCodes(item.allergens).codes
  const oldCross = parseAllergenCodes(item.allergensCrossContact).codes
  const contentChanged =
    oldCodes.join('|') !== allergens.codes.join('|') || oldCross.join('|') !== crossContact.join('|')
  const confirm = body?.confirm === true

  const data: Record<string, unknown> = {
    allergens: jstr(allergens.codes),
    allergensCrossContact: jstr(crossContact),
  }
  if (confirm) {
    data.allergensConfirmedAt = new Date()
    data.allergensConfirmedById = user.sub
  } else if (contentChanged) {
    // vsebina se je spremenila, potrditev ni podana → stara potrditev je ZASTARELA
    data.allergensConfirmedAt = null
    data.allergensConfirmedById = null
  }

  const affected = await menuItemIdsUsingInventoryItem(db, inventoryItemId)
  await db.$transaction(async (tx) => {
    await tx.inventoryItem.update({ where: { id: inventoryItemId }, data })
    if (contentChanged && affected.length > 0) {
      await flagMenuItemsForAllergenReview(tx, affected, 'sprememba alergenov sestavine')
    }
    await writeAudit(tx, {
      userId: user.sub,
      action: 'INVENTORY_ALLERGENS_SET',
      entityType: 'InventoryItem',
      entityId: inventoryItemId,
      details: jstr({
        item: item.name,
        old: { codes: oldCodes, crossContact: oldCross, confirmedAt: item.allergensConfirmedAt?.toISOString() ?? null },
        new: { codes: allergens.codes, crossContact, confirmed: confirm },
        contentChanged,
        flaggedMenuItems: contentChanged ? affected.length : 0,
      }),
      locationId: item.locationId || undefined,
    })
  })

  return ok({
    inventoryItemId,
    allergens: allergens.codes,
    crossContact,
    confirmed: confirm,
    contentChanged,
    flaggedMenuItems: contentChanged ? affected.length : 0,
  })
}
