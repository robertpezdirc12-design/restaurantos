import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { writeAudit } from '@/lib/audit-chain'
import { jstr } from '@/lib/map'
import { sanitizeAllergenCodeList, parseAllergenCodes } from '@/lib/allergen-catalog'
import { flagMenuItemsForAllergenReview } from '@/lib/allergen-profile'
import { VARIANT_NAME_MAX } from '@/lib/item-variants'

/**
 * Issue #7 (P1, v1.104.0) — alergeni OPCIJ MODIFIKATORJA (dodatek spremeni
 * profil NAROČENE postavke, ne baze jedi).
 *
 * PATCH /api/modifiers/[id]  { allergens: ["nuts"] }
 *
 *  -doseg: strežniški minimalni write (stolpec Modifier.allergens obstaja v shemi
 *    od začetka — zapisuje se JSON niz kanoničnih kod; nikjer ni bilo write poti,
 *    sedaj je ena, ozka in auditirana)
 *  - dovoljenje: menu.manage + guardResource (skupina → lokacija)
 *  - STRICT validacija kod (kanonične 14 EU — sicer 400)
 *  - sprememba vsebine → VSE jedi, povezane na skupino, dobijo
 *    allergenReviewFlag (ponovna preverba)
 *  - audit MODIFIER_ALLERGENS_SET (staro→novo + prizadete jedi)
 *  - zavrnitev 403 → audit ALLERGEN_ACCESS_DENIED brez vsebine
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const user = ctx.user

  if (!ctx.perms.includes('menu.manage')) {
    await writeAudit(db, {
      userId: user.sub,
      action: 'ALLERGEN_ACCESS_DENIED',
      entityType: 'Modifier',
      entityId: 'allergens',
      details: jstr({ op: 'modifier-allergens-set', reason: 'missing-menu.manage' }),
      locationId: user.loc || undefined,
    }).catch(() => {})
    return fail('Dostop zavrnjen — manjka dovoljenje: menu.manage.', 403)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail('Neveljavno telo zahteve.', 400)
  }

  const { id } = await params
  const modifier = await db.modifier.findUnique({
    where: { id },
    include: { ModifierGroup: { select: { id: true, locationId: true, name: true } } },
  })
  if (!modifier || !modifier.ModifierGroup) return fail('Opcija ne obstaja.', 404)

  const guard = await guardResource(user, modifier.ModifierGroup.locationId)
  if (guard) {
    await writeAudit(db, {
      userId: user.sub,
      action: 'ALLERGEN_ACCESS_DENIED',
      entityType: 'Modifier',
      entityId: id,
      details: jstr({ op: 'modifier-allergens-set', reason: 'cross-tenant' }),
      locationId: modifier.ModifierGroup.locationId || undefined,
    }).catch(() => {})
    return guard
  }

  // Issue #14 (v1.112.0): alergeni so zdaj OPCIJSKO polje tegea rute (usmeritev
  // na postajo se lahko spremeni brez dotikanja alergenov); brez body.allergens
  // se alergenski zapis NE spremeni (prej je bila napaka 400 — tu popravljeno).
  const hasAllergens = body?.allergens !== undefined
  let parsed = { codes: [] as ReturnType<typeof parseAllergenCodes>['codes'], invalid: [] as unknown[] }
  if (hasAllergens) {
    parsed = sanitizeAllergenCodeList(body?.allergens)
    if (parsed.invalid.length > 0) {
      return fail(
        `Neveljavne alergenske kode (dovoljene: kanonične kode 14 EU kataloga): ${jstr(parsed.invalid).slice(0, 120)}`,
        400,
      )
    }
  }

  // Issue #14 (v1.112.0): usmeritev opcije na postajo (Modifier.prepStationId).
  // Samo id postaje ISTE lokacije (skupina → lokacija) ali null (počisti).
  let prepStationId: string | null | undefined
  if (body?.prepStationId !== undefined) {
    if (body.prepStationId === null || body.prepStationId === '') prepStationId = null
    else if (typeof body.prepStationId === 'string') {
      const ps = await db.prepStation.findUnique({ where: { id: body.prepStationId.trim() }, select: { id: true, locationId: true } })
      if (!ps || ps.locationId !== modifier.ModifierGroup.locationId) {
        return fail('Postaja ne obstaja na lokaciji skupine opcij.', 400)
      }
      prepStationId = ps.id
    } else return fail('prepStationId mora biti id postaje ali null.', 400)
  }
  const stationRouting = prepStationId !== undefined && prepStationId !== (modifier.prepStationId ?? null)

  // OSS-10 (v1.209.0): vsebinska polja opcije — ime/doplačilo/razpoložljivost/vrstni
  // red (aditivno: brez teh polj se vsebina NE spremeni; alergensko ravnanje zgoraj
  // ostane nedotaknjeno). Doplačilo = število ali SI niz z vejico, 0..99999.99.
  const contentData: { name?: string; price?: number; isAvailable?: boolean; sortOrder?: number } = {}
  if (body?.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''
    if (!name) return fail('Ime opcije je obvezno.', 400)
    if (name.length > VARIANT_NAME_MAX) return fail(`Ime opcije je predolgo (največ ${VARIANT_NAME_MAX} znakov).`, 400)
    if (name !== modifier.name) contentData.name = name
  }
  if (body?.price !== undefined) {
    const raw = typeof body.price === 'number' ? body.price : Number(String(body.price).trim().replace(',', '.'))
    if (!Number.isFinite(raw) || raw < 0 || raw > 99999.99) return fail('Doplačilo mora biti število 0–99999.99.', 400)
    const price = Math.round(raw * 100) / 100
    if (price !== Number(modifier.price)) contentData.price = price
  }
  if (body?.isAvailable !== undefined) {
    const isAvailable = body.isAvailable === true
    if (isAvailable !== modifier.isAvailable) contentData.isAvailable = isAvailable
  }
  if (body?.sortOrder !== undefined) {
    const n = typeof body.sortOrder === 'number' ? body.sortOrder : Number(String(body.sortOrder).trim())
    if (!Number.isInteger(n) || n < 0 || n > 50) return fail('sortOrder mora biti celo število 0–50.', 400)
    if (n !== modifier.sortOrder) contentData.sortOrder = n
  }
  const updatedFields = Object.keys(contentData)

  const oldCodes = parseAllergenCodes(modifier.allergens).codes
  const newJson = jstr(hasAllergens ? parsed.codes : oldCodes)
  const contentChanged = hasAllergens && oldCodes.join('|') !== parsed.codes.join('|')

  const links = await db.menuItemModifierGroup.findMany({
    where: { modifierGroupId: modifier.modifierGroupId },
    select: { menuItemId: true },
  })
  const affectedMenuItems = [...new Set(links.map((l) => l.menuItemId))]

  await db.$transaction(async (tx) => {
    await tx.modifier.update({ where: { id }, data: { ...(hasAllergens ? { allergens: newJson } : {}), ...(prepStationId !== undefined ? { prepStationId } : {}), ...contentData } })
    if (contentChanged && affectedMenuItems.length > 0) {
      await flagMenuItemsForAllergenReview(tx, affectedMenuItems, 'sprememba alergenov dodatka')
    }
    await writeAudit(tx, {
      userId: user.sub,
      action: 'MODIFIER_ALLERGENS_SET',
      entityType: 'Modifier',
      entityId: id,
      details: jstr({
        modifier: modifier.name,
        group: modifier.ModifierGroup.name,
        old: oldCodes,
        new: parsed.codes,
        contentChanged,
        flaggedMenuItems: contentChanged ? affectedMenuItems.length : 0,
        ...(stationRouting ? { prepStationId } : {}),
      }),
      locationId: modifier.ModifierGroup.locationId || undefined,
    })
    if (updatedFields.length > 0) {
      await writeAudit(tx, {
        userId: user.sub,
        action: 'MODIFIER_UPDATED',
        entityType: 'Modifier',
        entityId: id,
        details: jstr({
          modifier: modifier.name,
          group: modifier.ModifierGroup.name,
          changed: updatedFields,
          ...contentData,
        }),
        locationId: modifier.ModifierGroup.locationId || undefined,
      })
    }
  })

  return ok({
    modifierId: id,
    allergens: parsed.codes,
    contentChanged,
    flaggedMenuItems: contentChanged ? affectedMenuItems.length : 0,
    ...(prepStationId !== undefined ? { prepStationId } : {}),
    ...(updatedFields.length > 0 ? { updated: updatedFields } : {}),
  })
}

/**
 * OSS-10 (v1.209.0) — brisanje opcije. Zgodovina naročil ostane čista:
 * OrderItemModifier nima tujega ključa na Modifier (le posnetek name/price/
 * modifierGroupName), brisanje opcije torej NE posega po naročilih. Skupina mora
 * biti v dosegu uporabnika (guardResource — lokacija skupine). Audit-chain:
 * MODIFIER_DELETED.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user

  const { id } = await params
  const modifier = await db.modifier.findUnique({
    where: { id },
    include: { ModifierGroup: { select: { id: true, locationId: true, name: true } } },
  })
  if (!modifier) return fail('Opcija ne obstaja.', 404)

  const guard = await guardResource(user, modifier.ModifierGroup.locationId)
  if (guard) return guard

  await db.$transaction(async (tx) => {
    await tx.modifier.delete({ where: { id } })
    await writeAudit(tx, {
      userId: user.sub,
      action: 'MODIFIER_DELETED',
      entityType: 'Modifier',
      entityId: id,
      details: jstr({ modifier: modifier.name, group: modifier.ModifierGroup.name }),
      locationId: modifier.ModifierGroup.locationId || undefined,
    })
  })

  return ok({ deleted: id })
}
