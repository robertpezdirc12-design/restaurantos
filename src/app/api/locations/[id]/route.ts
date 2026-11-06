import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { describeLocationChanges, validateLocationInput } from '@/lib/multilocation'
import { writeAudit } from '@/lib/audit-chain'
import { guardResource } from '@/lib/tenant'
import { safeLocationDto } from '@/lib/secret-dto'
import { writeKdsExpoFire, expoFireEnabledFor } from '@/lib/kds-expo-fire'

/**
 * Več poslovalnic (triage ⑧) — urejanje lokacije (settings.manage).
 * PATCH sprejme izbirna polja; deaktivacija (isActive=false) NE izbriše
 * podatkov — zaposleni/mize/naročila ostanejo (FK integriteta), vidnost
 * pa ureja fail-closed avtorizacija. Brisanja ni (§18 — FK varnost).
 *
 * #23 §2: settings.manage sam po sebi ne upraviči poljubnega ID-ja — ciljna
 * lokacija mora biti v uporabnikovem tenant/lokacijskem obsegu (guardResource);
 * odgovor vrača varni DTO (fursCertPassword = indikator, ne surova vrednost).
 *
 * PRIMERJAVA §39 (v1.265.0): kdsExpoFireEnabled (boolean) — per-lokacijska
 * nastavitev »Dovoli požig s KDS« (raw UPDATE + probe; pre-DDL → 503 s potjo
 * konzole). Ločena veja od validiranih naslovnih polj — vzorec politika
 * stolpcev na PUT /api/settings.
 */

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const loc = await db.location.findUnique({ where: { id } })
  if (!loc) return fail('Lokacija ne obstaja.', 404)

  // #23 §2: tenant/lokacijska meja — patchanje tujih lokacij po znanem ID-ju ni mogoče
  const guard = await guardResource(user, loc.id)
  if (guard) return guard

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

  if (Object.keys(data).length === 0 && body?.kdsExpoFireEnabled === undefined) return fail('Ni podatkov za posodobitev.', 400)

  // §39: per-lokacijska nastavitev expo požiga — LOČENA veja (raw UPDATE;
  // pre-DDL → 503 s potjo konzole). Pisanje je nad settings.manage (UI
  // družina lokacijskega dialoga), NE central-only — ni denarna politika.
  let kdsExpoFireChanged: boolean | undefined
  if (body?.kdsExpoFireEnabled !== undefined) {
    if (typeof body.kdsExpoFireEnabled !== 'boolean') {
      return fail('kdsExpoFireEnabled mora biti true/false.', 400)
    }
    const err = await writeKdsExpoFire(id, body.kdsExpoFireEnabled)
    if (err) return fail(err, 503)
    kdsExpoFireChanged = body.kdsExpoFireEnabled
  }

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
    // §39: samo-nastavitev (brez naslovnih polj) ne potrebuje update klica —
    // raw UPDATE zgoraj je ŽE zapisal; Prisma update s praznim data bi bil no-op
    let updated = loc
    if (Object.keys(data).length > 0) {
      updated = await db.location.update({ where: { id }, data })
    }
    const changes = describeLocationChanges(loc as unknown as Record<string, unknown>, data)
    await writeAudit(db, { userId: user.sub, action: 'LOCATION_UPDATE', entityType: 'Location', entityId: id, details: jstr({ name: updated.name, changes, ...(kdsExpoFireChanged !== undefined ? { kdsExpoFireEnabled: kdsExpoFireChanged } : {}) }) }).catch(() => null)
    // §39: nastavitev živi v raw stolpcu (main schema je nima) — odgovor
    // ji priloži NAZIČNO vrednost iz baze, ne pa surovega modela
    let kdsExpoFireNow = false
    try {
      const m = await expoFireEnabledFor([id])
      kdsExpoFireNow = m[id] === true
    } catch { /* pre-DDL → privzetek */ }
    return ok({ location: { ...safeLocationDto(updated), kdsExpoFireEnabled: kdsExpoFireNow } })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail(`Posodobitev ni uspela: ${msg}`, 500)
  }
}
