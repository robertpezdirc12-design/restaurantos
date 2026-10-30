import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { VARIANT_NAME_MAX } from '@/lib/item-variants'

/**
 * OSS-10 (v1.209.0) — VARIANTE ARTIKLOV: nova opcija v skupini.
 *
 * POST /api/modifiers
 *   body: { modifierGroupId: string, name: string, price?: number,
 *           sortOrder?: number, isAvailable?: boolean }
 *
 * Prej ni bilo poti za ustvarjanje opcij (edina write ruta je bila PATCH
 * /api/modifiers/[id] za alergene/postajo) — brez tega admin CRUD ni imel
 * vsebine. Cena = DOPLOČILO na osnovno ceno artikla (0 = brez doplačila —
 * npr. »0,33 L« pred »0,5 L«), zlivanje v ceno vrstice poteka v ops.ts.
 * Dovoljenje: menu.manage + guardResource (lokacija skupine); audit-chain:
 * MODIFIER_CREATED.
 */

/** Doplačilo: število ali SI niz z vejico, 0..99999.99, zaokroženo na 2 decimalki. */
function parsePrice(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return 0
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'))
  if (!Number.isFinite(n) || n < 0 || n > 99999.99) return null
  return Math.round(n * 100) / 100
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Neveljavno telo zahteve.', 400)
  const b = body as Record<string, unknown>

  const modifierGroupId = typeof b?.modifierGroupId === 'string' ? b.modifierGroupId.trim() : ''
  if (!modifierGroupId) return fail('modifierGroupId je obvezen.', 400)

  const group = await db.modifierGroup.findUnique({ where: { id: modifierGroupId } })
  if (!group) return fail('Skupina opcij ne obstaja.', 404)

  const guard = await guardResource(user, group.locationId)
  if (guard) return guard

  const name = typeof b?.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : ''
  if (!name) return fail('Ime opcije je obvezno.', 400)
  if (name.length > VARIANT_NAME_MAX) return fail(`Ime opcije je predolgo (največ ${VARIANT_NAME_MAX} znakov).`, 400)
  const price = parsePrice(b?.price)
  if (price === null) return fail('Doplačilo mora biti število 0–99999.99.', 400)
  let sortOrder = 0
  if (b?.sortOrder !== undefined) {
    const n = typeof b.sortOrder === 'number' ? b.sortOrder : Number(String(b.sortOrder).trim())
    if (!Number.isInteger(n) || n < 0 || n > 50) return fail('sortOrder mora biti celo število 0–50.', 400)
    sortOrder = n
  }
  const isAvailable = b?.isAvailable === undefined ? true : b.isAvailable === true

  const modifier = await db.$transaction(async (tx) => {
    const m = await tx.modifier.create({
      data: { id: nid(), name, price, sortOrder, isAvailable, modifierGroupId },
    })
    await writeAudit(tx, {
      userId: user.sub,
      action: 'MODIFIER_CREATED',
      entityType: 'Modifier',
      entityId: m.id,
      details: jstr({ name, price, sortOrder, isAvailable, group: group.name, modifierGroupId }),
      locationId: group.locationId || undefined,
    })
    return m
  })

  return ok({ modifier })
}
