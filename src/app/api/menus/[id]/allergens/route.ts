import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { writeAudit } from '@/lib/audit-chain'
import { jstr } from '@/lib/map'
import { sanitizeAllergenCodeList } from '@/lib/allergen-catalog'
import { getMenuItemAllergenProfiles } from '@/lib/allergen-profile'

/**
 * Issue #7 (P1, v1.104.0) — alergenski profil JEDI (MenuItem).
 *
 * GET  /api/menus/[id]/allergens
 *   → izračunani profil (kode/viri/sestavine/status/zastavica/override)
 *     — vir resnice za urejanje menija in potrditev.
 *
 * POST /api/menus/[id]/allergens
 *   { action: 'confirm' }
 *     → allergensConfirmedAt/By (kdaj+kdo) + POČISTI zastavico ponovne preverbe.
 *       Potrditev je izjava odgovorne osebe, da so izračunani alergeni skladni
 *       z dejanskimi sestavinami in postopki (ne dokaz skladnosti).
 *   { action: 'override', add: [kode], remove: [kode], reason: '≥10 znakov' }
 *     → ročni popravek z IZVOROM+RAZLOGOM+KDRO+KDaj (allergensOverride JSON).
 *       remove sme odstraniti SAMO trenutno prisotne kode (400 sicer);
 *       odstranjene izpeljane kode ostanejo vidne (removedByOverride — tiho
 *       izničenje je prepovedano). add=[]+remove=[] = počisti popravek
 *       (razlog vseeno obvezen — audit sled).
 *
 * Dovoljenje: menu.manage + guardResource (Category → Menu → locationId).
 * Audit: MENU_ALLERGENS_CONFIRMED / MENU_ALLERGENS_OVERRIDE (staro→novo).
 * Zavrnitev 403 → audit ALLERGEN_ACCESS_DENIED brez vsebine.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const user = ctx.user

  if (!ctx.perms.includes('menu.manage')) {
    return fail('Dostop zavrnjen — manjka dovoljenje: menu.manage.', 403)
  }
  const { id } = await params
  const item = await db.menuItem.findUnique({
    where: { id },
    include: { Category: { include: { Menu: { select: { locationId: true } } } } },
  })
  if (!item) return fail('Artikel ne obstaja.', 404)
  const guard = await guardResource(user, item.Category?.Menu?.locationId)
  if (guard) return guard

  const profiles = await getMenuItemAllergenProfiles([id])
  const profile = profiles.get(id)
  if (!profile) return fail('Profil ni izračunljiv.', 500)
  return ok({ profile })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const user = ctx.user

  if (!ctx.perms.includes('menu.manage')) {
    await writeAudit(db, {
      userId: user.sub,
      action: 'ALLERGEN_ACCESS_DENIED',
      entityType: 'MenuItem',
      entityId: 'allergens',
      details: jstr({ op: 'menu-allergens-post', reason: 'missing-menu.manage' }),
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
  const action = String(body?.action || '')
  if (action !== 'confirm' && action !== 'override') {
    return fail("action mora biti 'confirm' ali 'override'.", 400)
  }

  const { id } = await params
  const item = await db.menuItem.findUnique({
    where: { id },
    include: { Category: { include: { Menu: { select: { locationId: true } } } } },
  })
  if (!item) return fail('Artikel ne obstaja.', 404)
  const guard = await guardResource(user, item.Category?.Menu?.locationId)
  if (guard) {
    await writeAudit(db, {
      userId: user.sub,
      action: 'ALLERGEN_ACCESS_DENIED',
      entityType: 'MenuItem',
      entityId: id,
      details: jstr({ op: `menu-allergens-${action}`, reason: 'cross-tenant' }),
      locationId: item.Category?.Menu?.locationId || undefined,
    }).catch(() => {})
    return guard
  }

  const profiles = await getMenuItemAllergenProfiles([id])
  const profile = profiles.get(id)
  if (!profile) return fail('Profil ni izračunljiv.', 500)

  if (action === 'confirm') {
    await db.menuItem.update({
      where: { id },
      data: {
        allergensConfirmedAt: new Date(),
        allergensConfirmedById: user.sub,
        allergenReviewFlag: false,
        allergenReviewReason: '',
      },
    })
    await writeAudit(db, {
      userId: user.sub,
      action: 'MENU_ALLERGENS_CONFIRMED',
      entityType: 'MenuItem',
      entityId: id,
      details: jstr({
        item: item.name,
        codes: profile.codes,
        crossContact: profile.crossContact,
        unconfirmedIngredients: profile.unconfirmedIngredients,
        unknownLabels: profile.unknownLabels,
        clearedReviewReason: profile.reviewReason || null,
      }),
      locationId: item.Category?.Menu?.locationId || undefined,
    })
    const refreshed = await getMenuItemAllergenProfiles([id])
    return ok({ action: 'confirm', profile: refreshed.get(id) ?? null })
  }

  // action === 'override'
  const add = sanitizeAllergenCodeList(body?.add)
  const remove = sanitizeAllergenCodeList(body?.remove)
  if (add.invalid.length > 0 || remove.invalid.length > 0) {
    return fail('add/remove sprejemata samo kanonične alergenske kode (14 EU katalog).', 400)
  }
  const reason = String(body?.reason || '').trim()
  if (reason.length < 10) {
    return fail('Razlog ročnega popravka je obvezen (najmanj 10 znakov).', 400)
  }
  const notPresent = remove.codes.filter((c) => !profile.codes.includes(c))
  if (notPresent.length > 0) {
    return fail(
      `Odstraniti ni mogoče kode, ki niso v trenutnem profilu: ${notPresent.join(', ')}.`,
      400,
    )
  }
  const clearing = add.codes.length === 0 && remove.codes.length === 0
  const overrideJson = clearing
    ? null
    : jstr({
        add: add.codes,
        remove: remove.codes,
        reason,
        confirmedById: user.sub,
        confirmedByName: user.name,
        confirmedAt: new Date().toISOString(),
      })

  await db.menuItem.update({
    where: { id },
    data: {
      allergensOverride: overrideJson,
      // popravek JE potrditvena odločitev (kdo/kdaj/zakaj zapisano znotraj override)
      allergensConfirmedAt: new Date(),
      allergensConfirmedById: user.sub,
    },
  })
  await writeAudit(db, {
    userId: user.sub,
    action: 'MENU_ALLERGENS_OVERRIDE',
    entityType: 'MenuItem',
    entityId: id,
    details: jstr({
      item: item.name,
      old: profile.override,
      new: clearing ? null : { add: add.codes, remove: remove.codes, reason },
      removedVisible: profile.codes.filter((c) => (remove.codes as string[]).includes(c)),
      clearing,
    }),
    locationId: item.Category?.Menu?.locationId || undefined,
  })
  const refreshed = await getMenuItemAllergenProfiles([id])
  return ok({ action: 'override', profile: refreshed.get(id) ?? null })
}
