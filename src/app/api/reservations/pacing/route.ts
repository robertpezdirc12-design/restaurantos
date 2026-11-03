import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation, locationScope, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { PACING_CONFIG_MARKER, parsePacingConfig, DEFAULT_PACING_CONFIG, type PacingConfig } from '@/lib/reservation-pacing'

/**
 * v1.244.0 (PRIMERJAVA-VMESNIKOV-2026 §18 A) — konfiguracija RITMA PRIHODOV.
 *
 * GET  /api/reservations/pacing?locationId= → trenutna konfiguracija lokacije
 *      ({ enabled, windowMin, maxGuests }); brez vrstice → privzeta
 *      (izklopljeno, 30 min) — odgovor vedno v kanonični obliki.
 * PUT  /api/reservations/pacing → { locationId?, enabled: boolean,
 *      windowMin: number, maxGuests: number } → upsert Integration vrstice
 *      (0 DDL, isti vzorec kot auto86-config v1.230.0 — razlika: PER LOKACIJA)
 *      + revizija RESERVATION_PACING_CONFIG.
 *
 * Tenant: requireUserLocation + assertOrgScope (enako kot widget ruta).
 * Pravice: reservations.manage (isti lastnik kot ustvarjanje rezervacij —
 * kdor sme rezervacije, sme tudi njihov ritem).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const locationId = await resolvePacingLocation(user, req.nextUrl.searchParams.get('locationId') || undefined)
  if (isResponse(locationId)) return locationId
  const config = await loadConfig(locationId)
  return ok({ config })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)
  const locationId = await resolvePacingLocation(user, body.locationId || undefined)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  // validacija: enabled boolean, števila pa normalizira parsePacingConfig
  // (isti obrambni klemi kot widgetPolicyOf — razlog: vrstica je JSON, ki ga
  // lahko kdajkoli piše kdo drug).
  if (typeof body?.enabled !== 'boolean') return fail('Polje "enabled" (boolean) je obvezno.', 400)
  const windowMin = Math.round(Number(body?.windowMin))
  const maxGuests = Math.round(Number(body?.maxGuests))
  if (!Number.isFinite(windowMin) || windowMin < 10 || windowMin > 120) {
    return fail('Okno ritma mora biti med 10 in 120 minutami.', 400)
  }
  if (!Number.isFinite(maxGuests) || maxGuests < 0 || maxGuests > 500) {
    return fail('Največje število gostov na okno mora biti med 0 in 500 (0 = brez omejitve).', 400)
  }
  if (body.enabled && maxGuests === 0) {
    return fail('Vklopljeno varovalo potrebuje omejitev gostov (vsaj 1).', 400)
  }
  const config: PacingConfig = parsePacingConfig({ enabled: body.enabled, windowMin, maxGuests })
  const configJson = JSON.stringify(config)

  const existing = await db.integration.findFirst({
    where: { name: PACING_CONFIG_MARKER, type: 'other', locationId },
    select: { id: true, config: true },
  })
  const prev = existing ? parsePacingConfig(existing.config) : DEFAULT_PACING_CONFIG

  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: configJson } })
  } else {
    await db.integration.create({
      data: {
        id: `resv-pacing-${Date.now().toString(36)}`,
        name: PACING_CONFIG_MARKER,
        type: 'other',
        provider: 'internal',
        config: configJson,
        isActive: true,
        syncEnabled: false,
        locationId,
      },
    })
  }

  await writeAudit(db, {
    userId: user.sub,
    action: 'RESERVATION_PACING_CONFIG',
    entityType: 'Integration',
    entityId: existing?.id || PACING_CONFIG_MARKER,
    details: jstr({ from: prev, to: config, by: user.name, locationId }),
    locationId,
  })
  return ok({ config })
}

/** Lokalno branje konfiguracije (isti pogoji kot loadPacingConfig iz lib-a). */
async function loadConfig(locationId: string): Promise<PacingConfig> {
  const row = await db.integration.findFirst({
    where: { name: PACING_CONFIG_MARKER, type: 'other', locationId },
    select: { config: true },
  })
  return parsePacingConfig(row?.config)
}

/** Issue #96 (QA P1, isti vzorec kot POST /api/reservations): centralna vloga brez
 *  lastne lokacije in brez locationId v telesu → FAIL-CLOSED fallback na NATANČNO
 *  ENO aktivno lokacijo v obsegu organizacije (ni ugibanja; pri več lokacijah
 *  400 ostane). Demo/admin brez lokacije tako lahko ritem nastavi na edini lokali. */
async function resolvePacingLocation(user: Parameters<typeof requireUserLocation>[0], bodyLocationId?: unknown): Promise<string | NextResponse> {
  const loc = requireUserLocation(user, bodyLocationId)
  if (!isResponse(loc)) return loc
  if (isCentralRole(user) && !user.loc) {
    const scope = await locationScope(user)
    const rows = await db.location.findMany({
      where: { isActive: true, id: scope.locationId ? (typeof scope.locationId === 'string' ? scope.locationId : { in: scope.locationId.in }) : undefined },
      select: { id: true },
      take: 2,
    })
    if (rows.length === 1) return rows[0].id
  }
  return loc
}
