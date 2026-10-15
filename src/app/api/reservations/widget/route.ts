import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr, nid } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { newWidgetToken, widgetPolicyOf } from '@/lib/reservation-widget'
import { WIDGET_POLICY_DEFAULTS } from '@/lib/reservation-slots'

/**
 * Issue #13 (P1/P2, v1.110.0) — NASTAVITEV javnega rezervacijskega widgeta.
 *
 * GET  /api/reservations/widget?locationId= → konfiguracija (brez tokena v
 *      odgovoru — token vračamo SAMO ob izdaji/rotaciji, ko ga UI pokaže
 *      osebju za kopiranje povezave)
 * PUT  /api/reservations/widget → { locationId, enabled?, slotMinutes?, ...,
 *      rotateToken? } → upsert + (ob rotateToken) NOV token = revokacija
 *      stare povezave (stari token takoj preneha delovati)
 * DELETE /api/reservations/widget → izklop (enabled=false; NE brišemo
 *      vrstice — revizijska sled nastavitev)
 *
 * RBAC: GET = reservations.manage (vidi konfiguracijo, ne tokena);
 * PUT/DELETE = settings.manage (konfiguracija platforme — enaka politika
 * kot exception-policy / cash-movements).
 * Tenant: requireUserLocation + assertOrgScope (enako kot ostale rute).
 * Audit: RESERVATION_WIDGET_UPDATED / _DISABLED (stare→nove vrednosti).
 */

const INT_FIELDS = ['slotMinutes', 'minParty', 'maxParty', 'leadMinutes', 'maxAdvanceDays', 'maxCoversPerSlot'] as const
const BOUNDS: Record<(typeof INT_FIELDS)[number], [number, number, number]> = {
  slotMinutes: [5, 240, WIDGET_POLICY_DEFAULTS.slotMinutes],
  minParty: [1, 40, WIDGET_POLICY_DEFAULTS.minParty],
  maxParty: [1, 40, WIDGET_POLICY_DEFAULTS.maxParty],
  leadMinutes: [0, 1440, WIDGET_POLICY_DEFAULTS.leadMinutes],
  maxAdvanceDays: [1, 365, WIDGET_POLICY_DEFAULTS.maxAdvanceDays],
  maxCoversPerSlot: [0, 500, WIDGET_POLICY_DEFAULTS.maxCoversPerSlot],
}

/** Konservativna javna predstavitev (brez skrivnostnega tokena). */
function publicView(row: { id: string; locationId: string; enabled: boolean; slotMinutes: number; minParty: number; maxParty: number; leadMinutes: number; maxAdvanceDays: number; maxCoversPerSlot: number; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    locationId: row.locationId,
    enabled: row.enabled,
    policy: widgetPolicyOf(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = Object.fromEntries(req.nextUrl.searchParams.entries())
  const locationId = requireUserLocation(user, body.locationId || undefined)
  if (isResponse(locationId)) return locationId

  const row = await db.reservationWidget.findUnique({ where: { locationId } })
  if (!row) {
    // še ni konfiguracije — pošten prazen odgovor (UI ponudi inicializacijo)
    return ok({ widget: null })
  }
  // Token je skrivnost javne povezave: razkrijemo SAMO imetnikom settings.manage
  // (ista oseba, ki povezavo izda/rotira — vzorec QR mize: tiskanje zahteva
  // menu.manage). Gledalec z reservations.manage vidi samo konfiguracijo.
  const canSeeToken = await requirePermission(req, 'settings.manage')
  const reveal = !isResponse(canSeeToken) && row.enabled
  return ok({
    widget: publicView(row),
    ...(reveal ? { token: row.token, publicUrl: `/r/${row.token}` } : {}),
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

  // validacija politike (meje — enake kot widgetPolicyOf clampa)
  const next: Record<string, number | boolean | string> = {}
  for (const f of INT_FIELDS) {
    if (body[f] !== undefined && body[f] !== null && body[f] !== '') {
      const [lo, hi] = BOUNDS[f]
      const n = Math.round(Number(body[f]))
      if (!Number.isFinite(n) || n < lo || n > hi) {
        return fail(`Neveljavna vrednost za ${f} (dovoljeno ${lo}–${hi}).`, 400)
      }
      next[f] = n
    }
  }
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled)
  // minParty <= maxParty
  const minP = Number(next.minParty ?? 0)
  const maxP = Number(next.maxParty ?? 0)
  if (minP && maxP && minP > maxP) return fail('Najmanjše število oseb ne sme presegati največjega.', 400)

  const rotateToken = Boolean(body.rotateToken)

  const existing = await db.reservationWidget.findUnique({ where: { locationId } })
  let row
  if (!existing) {
    row = await db.reservationWidget.create({
      data: {
        id: nid(),
        locationId,
        token: newWidgetToken(),
        enabled: next.enabled !== undefined ? (next.enabled as boolean) : false,
        ...(next.slotMinutes !== undefined ? { slotMinutes: Number(next.slotMinutes) } : {}),
        ...(next.minParty !== undefined ? { minParty: Number(next.minParty) } : {}),
        ...(next.maxParty !== undefined ? { maxParty: Number(next.maxParty) } : {}),
        ...(next.leadMinutes !== undefined ? { leadMinutes: Number(next.leadMinutes) } : {}),
        ...(next.maxAdvanceDays !== undefined ? { maxAdvanceDays: Number(next.maxAdvanceDays) } : {}),
        ...(next.maxCoversPerSlot !== undefined ? { maxCoversPerSlot: Number(next.maxCoversPerSlot) } : {}),
      },
    })
  } else {
    if (rotateToken) next.token = newWidgetToken()
    row = await db.reservationWidget.update({ where: { id: existing.id }, data: next })
  }

  await writeAudit(db, {
    userId: user.sub,
    action: 'RESERVATION_WIDGET_UPDATED',
    entityType: 'ReservationWidget',
    entityId: row.id,
    details: jstr({
      locationId,
      spremembe: {
        ...(existing ? {
          enabled: [existing.enabled, row.enabled],
          ...(next.slotMinutes !== undefined ? { slotMinutes: [existing.slotMinutes, row.slotMinutes] } : {}),
          ...(next.minParty !== undefined ? { minParty: [existing.minParty, row.minParty] } : {}),
          ...(next.maxParty !== undefined ? { maxParty: [existing.maxParty, row.maxParty] } : {}),
          ...(next.leadMinutes !== undefined ? { leadMinutes: [existing.leadMinutes, row.leadMinutes] } : {}),
          ...(next.maxAdvanceDays !== undefined ? { maxAdvanceDays: [existing.maxAdvanceDays, row.maxAdvanceDays] } : {}),
          ...(next.maxCoversPerSlot !== undefined ? { maxCoversPerSlot: [existing.maxCoversPerSlot, row.maxCoversPerSlot] } : {}),
        } : { inicializacija: true }),
      },
      rotacija: rotateToken ? 'DA (stara povezava preneha veljati)' : 'NE',
    }),
    locationId,
  }).catch(() => {})

  return ok({
    widget: publicView(row),
    // token vračamo SAMO tu (izdaja/rotacija) — UI ga pokaže za kopiranje
    token: rotateToken || !existing ? row.token : undefined,
    publicUrl: `/r/${row.token}`,
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

  const existing = await db.reservationWidget.findUnique({ where: { locationId } })
  if (!existing) return fail('Widget ni konfiguriran.', 404)
  const row = await db.reservationWidget.update({ where: { id: existing.id }, data: { enabled: false } })
  await writeAudit(db, {
    userId: user.sub,
    action: 'RESERVATION_WIDGET_DISABLED',
    entityType: 'ReservationWidget',
    entityId: row.id,
    details: jstr({ locationId }),
    locationId,
  }).catch(() => {})
  return ok({ widget: publicView(row) })
}
