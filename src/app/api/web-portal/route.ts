import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr, nid, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { newPortalToken, newTrackSecret, portalPolicyOf } from '@/lib/web-portal'

/**
 * P1 #8 (v1.190.0) — NASTAVITVE lastnega spletnega portala za naročila.
 *
 * GET    /api/web-portal?locationId= → konfiguracija (BREZ stranskih učinkov;
 *        brez vrstice → { portal: null }, UI ponudi inicializacijo)
 * PUT    /api/web-portal → { locationId, enabled?, pickupEnabled?,
 *        deliveryEnabled?, deliveryFee?, minOrder?, prepMinutes?, note?,
 *        rotateToken? } → upsert (ustvari vrstico, če je manjkal) + (ob
 *        rotateToken) NOV token = revokacija stare povezave; trackSecret
 *        ostane — gostovo sledenje tekočega naročila preživi rotacijo
 * DELETE /api/web-portal → izklop (enabled=false; NE brišemo vrstice —
 *        revizijska sled nastavitev)
 *
 * RBAC: vse operacije settings.manage (konfiguracija platforme — enaka
 * politika kot /api/reservations/widget PUT in exception-policy).
 * Tenant: requireUserLocation + assertOrgScope (enako kot ostale rute).
 * Audit: WEB_PORTAL_UPDATED / WEB_PORTAL_DISABLED (stare→nove vrednosti).
 */

const BOUNDS = {
  prepMinutes: [5, 180] as const,
  deliveryFee: [0, 50] as const,
  minOrder: [0, 500] as const,
}

/** Konservativna javna predstavitev (brez skrivnosti: token + trackSecret). */
function publicView(row: {
  id: string
  locationId: string
  enabled: boolean
  pickupEnabled: boolean
  deliveryEnabled: boolean
  deliveryFee: number | bigint | { toNumber: () => number } | null
  minOrder: number | bigint | { toNumber: () => number } | null
  prepMinutes: number
  note: string
  createdAt: Date
  updatedAt: Date
}) {
  const policy = portalPolicyOf(row)
  return {
    id: row.id,
    locationId: row.locationId,
    enabled: row.enabled,
    pickupEnabled: policy.pickupEnabled,
    deliveryEnabled: policy.deliveryEnabled,
    deliveryFee: policy.deliveryFee,
    minOrder: policy.minOrder,
    prepMinutes: policy.prepMinutes,
    note: policy.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = Object.fromEntries(req.nextUrl.searchParams.entries())
  const locationId = requireUserLocation(user, body.locationId || undefined)
  if (isResponse(locationId)) return locationId

  const row = await db.webOrderPortal.findUnique({ where: { locationId } })
  if (!row) return ok({ portal: null })
  // Token je skrivnost javne povezave: razkrijemo ga imetniku settings.manage
  // (ista oseba, ki povezavo izda/rotira — vzorec rezervacijskega widgeta).
  return ok({
    portal: publicView(row),
    ...(row.enabled ? { token: row.token, publicUrl: `/s/${row.token}` } : {}),
  })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Neveljavno telo zahteve.', 400)

  const locationId = requireUserLocation(user, body.locationId)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const existing = await db.webOrderPortal.findUnique({ where: { locationId } })

  const next: Record<string, number | boolean | string> = {}
  for (const [field, [lo, hi]] of Object.entries(BOUNDS)) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== '') {
      const n = Number(body[field])
      if (!Number.isFinite(n) || n < lo || n > hi) {
        return fail(`Neveljavna vrednost za ${field} (dovoljeno ${lo}–${hi}).`, 400)
      }
      next[field] = field === 'prepMinutes' ? Math.round(n) : Math.round(n * 100) / 100
    }
  }
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled)
  if (body.pickupEnabled !== undefined) next.pickupEnabled = Boolean(body.pickupEnabled)
  if (body.deliveryEnabled !== undefined) next.deliveryEnabled = Boolean(body.deliveryEnabled)
  if (body.note !== undefined) next.note = String(body.note || '').trim().slice(0, 300)

  // enotni izračun rezultirajočih načinov (ob upoštevanju obstoječih vrednosti)
  const base = existing ?? { enabled: false, pickupEnabled: true, deliveryEnabled: false }
  const nextPickup = next.pickupEnabled !== undefined ? Boolean(next.pickupEnabled) : base.pickupEnabled
  const nextDelivery = next.deliveryEnabled !== undefined ? Boolean(next.deliveryEnabled) : base.deliveryEnabled
  const nextEnabled = next.enabled !== undefined ? Boolean(next.enabled) : base.enabled
  if (nextEnabled && !nextPickup && !nextDelivery) {
    return fail('Portala ne moreš vklopiti brez načina prevzema (vklopi prevzem ali dostavo).', 400)
  }

  const rotateToken = Boolean(body.rotateToken)

  let row
  if (!existing) {
    row = await db.webOrderPortal.create({
      data: {
        id: nid(),
        locationId,
        token: newPortalToken(),
        trackSecret: newTrackSecret(),
        ...(next.enabled !== undefined ? { enabled: next.enabled as boolean } : {}),
        ...(next.pickupEnabled !== undefined ? { pickupEnabled: next.pickupEnabled as boolean } : {}),
        ...(next.deliveryEnabled !== undefined ? { deliveryEnabled: next.deliveryEnabled as boolean } : {}),
        ...(next.deliveryFee !== undefined ? { deliveryFee: next.deliveryFee as number } : {}),
        ...(next.minOrder !== undefined ? { minOrder: next.minOrder as number } : {}),
        ...(next.prepMinutes !== undefined ? { prepMinutes: next.prepMinutes as number } : {}),
        ...(next.note !== undefined ? { note: next.note as string } : {}),
      },
    })
  } else {
    if (rotateToken) next.token = newPortalToken()
    row = await db.webOrderPortal.update({ where: { id: existing.id }, data: next })
  }

  await writeAudit(db, {
    userId: user.sub,
    action: 'WEB_PORTAL_UPDATED',
    entityType: 'WebOrderPortal',
    entityId: row.id,
    details: jstr({
      locationId,
      spremembe: {
        ...(existing ? {
          enabled: [existing.enabled, row.enabled],
          pickupEnabled: [existing.pickupEnabled, row.pickupEnabled],
          deliveryEnabled: [existing.deliveryEnabled, row.deliveryEnabled],
          ...(existing.deliveryFee !== row.deliveryFee ? { deliveryFee: [num(existing.deliveryFee), num(row.deliveryFee)] } : {}),
          ...(existing.minOrder !== row.minOrder ? { minOrder: [num(existing.minOrder), num(row.minOrder)] } : {}),
          ...(existing.prepMinutes !== row.prepMinutes ? { prepMinutes: [existing.prepMinutes, row.prepMinutes] } : {}),
          ...(existing.note !== row.note ? { note: true } : {}),
        } : { inicializacija: true }),
      },
      rotacija: rotateToken ? 'DA (stara povezava preneha veljati)' : 'NE',
    }),
    locationId,
  }).catch(() => {})

  return ok({
    portal: publicView(row),
    // token vračamo SAMO tu (izdaja/rotacija/prva izdaja) — UI ga pokaže za kopiranje
    ...(rotateToken || !existing ? { token: row.token, publicUrl: `/s/${row.token}` } : {}),
  })
}

export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const existing = await db.webOrderPortal.findUnique({ where: { locationId } })
  if (!existing) return fail('Portal ni konfiguriran.', 404)
  const row = await db.webOrderPortal.update({ where: { id: existing.id }, data: { enabled: false } })
  await writeAudit(db, {
    userId: user.sub,
    action: 'WEB_PORTAL_DISABLED',
    entityType: 'WebOrderPortal',
    entityId: row.id,
    details: jstr({ locationId }),
    locationId,
  }).catch(() => {})
  return ok({ portal: publicView(row) })
}
