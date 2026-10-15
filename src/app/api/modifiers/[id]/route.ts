import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { writeAudit } from '@/lib/audit-chain'
import { jstr } from '@/lib/map'
import { sanitizeAllergenCodeList, parseAllergenCodes } from '@/lib/allergen-catalog'
import { flagMenuItemsForAllergenReview } from '@/lib/allergen-profile'

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

  const oldCodes = parseAllergenCodes(modifier.allergens).codes
  const newJson = jstr(hasAllergens ? parsed.codes : oldCodes)
  const contentChanged = hasAllergens && oldCodes.join('|') !== parsed.codes.join('|')

  const links = await db.menuItemModifierGroup.findMany({
    where: { modifierGroupId: modifier.modifierGroupId },
    select: { menuItemId: true },
  })
  const affectedMenuItems = [...new Set(links.map((l) => l.menuItemId))]

  await db.$transaction(async (tx) => {
    await tx.modifier.update({ where: { id }, data: { ...(hasAllergens ? { allergens: newJson } : {}), ...(prepStationId !== undefined ? { prepStationId } : {}) } })
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
  })

  return ok({
    modifierId: id,
    allergens: parsed.codes,
    contentChanged,
    flaggedMenuItems: contentChanged ? affectedMenuItems.length : 0,
    ...(prepStationId !== undefined ? { prepStationId } : {}),
  })
}
