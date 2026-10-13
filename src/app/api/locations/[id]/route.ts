import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { describeLocationChanges, validateLocationInput } from '@/lib/multilocation'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Več poslovalnic (triage ⑧) — urejanje lokacije (settings.manage).
 * PATCH sprejme izbirna polja; deaktivacija (isActive=false) NE izbriše
 * podatkov — zaposleni/mize/naročila ostanejo (FK integriteta), vidnost
 * pa ureja fail-closed avtorizacija. Brisanja ni (§18 — FK varnost).
 */

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const loc = await db.location.findUnique({ where: { id } })
  if (!loc) return fail('Lokacija ne obstaja.', 404)

  // validira se ZDAJŠNJA vsebina (obstoječa + povozene vrednosti iz telesa)
  const merged: Record<string, unknown> = {
    name: loc.name, code: loc.code, address: loc.address, city: loc.city, postCode: loc.postCode,
    country: loc.country, phone: loc.phone, email: loc.email, premisesId: loc.premisesId,
    timezone: loc.timezone, currency: loc.currency,
  }
  for (const k of ['name', 'code', 'address', 'city', 'postCode', 'country', 'phone', 'email', 'premisesId', 'timezone', 'currency'] as const) {
    if (body?.[k] !== undefined) merged[k] = body[k]
  }
  const v = validateLocationInput(merged)
  if (!v.ok) return fail(v.error, 400)

  const data: Record<string, unknown> = {}
  if (body?.name !== undefined) data.name = v.value.name
  if (body?.code !== undefined) data.code = v.value.code || loc.code
  if (body?.address !== undefined) data.address = v.value.address
  if (body?.city !== undefined) data.city = v.value.city
  if (body?.postCode !== undefined) data.postCode = v.value.postCode
  if (body?.country !== undefined) data.country = v.value.country
  if (body?.phone !== undefined) data.phone = v.value.phone
  if (body?.email !== undefined) data.email = v.value.email
  if (body?.premisesId !== undefined) data.premisesId = v.value.premisesId || null // Task 44: nullable — prazno briše oznako
  if (body?.timezone !== undefined) data.timezone = v.value.timezone
  if (body?.currency !== undefined) data.currency = v.value.currency
  if (body?.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean' && typeof body.isActive !== 'string') {
      return fail('isActive mora biti true/false.', 400)
    }
    data.isActive = body.isActive === true || body.isActive === 'true'
  }

  if (Object.keys(data).length === 0) return fail('Ni podatkov za posodobitev.', 400)

  // unikatnost (razen same nase)
  if (data.code && data.code !== loc.code) {
    const dup = await db.location.findFirst({ where: { code: String(data.code), NOT: { id } }, select: { id: true } })
    if (dup) return fail('Koda lokacije že obstaja.', 409)
  }
  if (data.premisesId && data.premisesId !== loc.premisesId) {
    const dup = await db.location.findFirst({ where: { premisesId: String(data.premisesId), NOT: { id } }, select: { id: true } })
    if (dup) return fail('FURS poslovni prostor s to oznako že obstaja.', 409)
  }

  try {
    const updated = await db.location.update({ where: { id }, data })
    const changes = describeLocationChanges(loc as unknown as Record<string, unknown>, data)
    await writeAudit(db, { userId: user.sub, action: 'LOCATION_UPDATE', entityType: 'Location', entityId: id, details: jstr({ name: updated.name, changes }) }).catch(() => null)
    return ok({ location: updated })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail(`Posodobitev ni uspela: ${msg}`, 500)
  }
}
