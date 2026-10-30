import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, requireUserLocation, isCentralRole, isResponse, ok, fail } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { parseAllergenCodes } from '@/lib/allergen-catalog'
import { isVariantGroup, VARIANT_NAME_MAX } from '@/lib/item-variants'

/**
 * OSS-10 (v1.209.0) — VARIANTE ARTIKLOV: admin CRUD za skupine opcij.
 *
 * Prej NIKOLI ni obstajala write pot za ModifierGroup (edina ruta je bila PATCH
 * /api/modifiers/[id] za alergene/postajo) — skupine so nastajale le v testnih
 * fiksturah, zato »velikost/nivo« (obvezna enoizbirna skupina) NI šla nastavit
 * v produkciji. Ta ruta je manjkajoči temelj variant — 0 DDL (stolpci že v shemi).
 *
 * GET  /api/modifier-groups           — seznam skupin z opcijami + števecem pripetih
 *                                       artiklov (staff = svoja lokacija, centralna =
 *                                       ?locationId= ali vse — vzorec /api/menus GET)
 * POST /api/modifier-groups           — nova skupina; body.template = 'variant' →
 *                                       predloga variante (required=true, minSelect=1,
 *                                       maxSelect=1); izrecna polja imajo prednost
 * Dovoljenje: branje requireAuth, pisanje menu.manage (isto kot ostali menijski
 * zapisi). Lokacijski dosegg: requireUserLocation + assertOrgScope (vzorec menus
 * POST); audit-chain na vsak zapis.
 */

/** Celoštevilska validacija izbir (minSelect/maxSelect/sortOrder) — int 0..50. */
function selectInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isInteger(n) && n >= 0 && n <= 50 ? n : null
}

/** Validacija in normalizacija telesa za ustvarjanje skupine. */
function parseCreateBody(body: Record<string, unknown>):
  | { ok: true; value: { name: string; required: boolean; minSelect: number; maxSelect: number | null; sortOrder: number; template: boolean } }
  | { ok: false; error: string } {
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''
  if (!name) return { ok: false, error: 'Ime skupine je obvezno.' }
  if (name.length > VARIANT_NAME_MAX) return { ok: false, error: `Ime skupine je predolgo (največ ${VARIANT_NAME_MAX} znakov).` }

  // OSS-10: predloga 'variant' = velikost/nivo (obvezno, NATANČNO en izbor) —
  // izrecna polja iz telesa imajo prednost (predloga je le pametni privzeti).
  const template = body?.template === 'variant'
  const requiredDefault = template
  const minDefault = template ? 1 : 0
  const maxDefault: number | null = template ? 1 : null

  const required = body?.required === undefined ? requiredDefault : body.required === true
  const minSelect = body?.minSelect === undefined ? minDefault : selectInt(body.minSelect)
  if (body?.minSelect !== undefined && minSelect === null) return { ok: false, error: 'minSelect mora biti celo število 0–50.' }
  let maxSelect: number | null = maxDefault
  if (body?.maxSelect !== undefined && body.maxSelect !== null) {
    const parsed = selectInt(body.maxSelect)
    if (parsed === null || parsed < 1) return { ok: false, error: 'maxSelect mora biti celo število 1–50 ali null (neomejeno).' }
    maxSelect = parsed
  } else if (body?.maxSelect === null) {
    maxSelect = null
  }
  if (maxSelect !== null && (minSelect as number) > maxSelect) return { ok: false, error: 'minSelect ne sme presegati maxSelect.' }
  const sortOrder = body?.sortOrder === undefined ? 0 : selectInt(body.sortOrder)
  if (sortOrder === null) return { ok: false, error: 'sortOrder mora biti celo število 0–50.' }

  return { ok: true, value: { name, required, minSelect: minSelect as number, maxSelect, sortOrder, template } }
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  // Lokacijski dosegg (vzorec /api/menus GET): staff = VEDNO svoja lokacija;
  // centralna vloga = ?locationId= ali vse.
  let locFilter: string | null = null
  if (!isCentralRole(user)) {
    locFilter = user.loc ?? null
  } else {
    const q = req.nextUrl.searchParams.get('locationId')
    if (q && q.trim()) locFilter = q.trim()
  }
  const groups = await db.modifierGroup.findMany({
    where: locFilter ? { locationId: locFilter } : undefined,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      Modifier: {
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, price: true, isAvailable: true, sortOrder: true, allergens: true },
      },
      _count: { select: { MenuItemModifierGroup: true } },
      MenuItemModifierGroup: { select: { menuItemId: true } },
    },
  })
  return ok({
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      required: g.required,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      sortOrder: g.sortOrder,
      // OSS-10: izpeljani razred — varianta (velikost/nivo) vs prosta skupina
      variant: isVariantGroup(g),
      links: g._count.MenuItemModifierGroup,
      // id-ji pripetih artiklov — predizbor v admin kartici (pripni/odpni)
      linkedMenuItemIds: g.MenuItemModifierGroup.map((l) => l.menuItemId),
      modifiers: g.Modifier.map((m) => ({
        id: m.id,
        name: m.name,
        price: num(m.price),
        isAvailable: m.isAvailable,
        sortOrder: m.sortOrder,
        allergens: parseAllergenCodes(m.allergens).codes,
      })),
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Neveljavno telo zahteve.', 400)

  // Issue #4 §10 vzorec: forsiraj lokacijo — staff = svoja, centralna lahko poda body.locationId
  const locId = requireUserLocation(user, (body as Record<string, unknown>)?.locationId)
  if (isResponse(locId)) return locId
  const orgGuard = await assertOrgScope(user, locId)
  if (orgGuard) return orgGuard

  const parsed = parseCreateBody(body as Record<string, unknown>)
  if (!parsed.ok) return fail(parsed.error, 400)
  const { name, required, minSelect, maxSelect, sortOrder, template } = parsed.value

  const group = await db.modifierGroup.create({
    data: {
      id: nid(),
      name,
      required,
      minSelect,
      maxSelect,
      sortOrder,
      locationId: locId,
    },
  })

  await writeAudit(db, {
    userId: user.sub,
    action: 'MODIFIER_GROUP_CREATED',
    entityType: 'ModifierGroup',
    entityId: group.id,
    details: jstr({
      name,
      required,
      minSelect,
      maxSelect,
      sortOrder,
      variant: isVariantGroup(group),
      ...(template ? { template: 'variant' } : {}),
      locationId: locId,
    }),
    locationId: locId,
  }).catch(() => {})

  return ok({ group: { ...group, variant: isVariantGroup(group), links: 0 } })
}
