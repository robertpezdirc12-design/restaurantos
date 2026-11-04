import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation, locationScope, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import {
  SAVED_REPORT_VIEWS_MARKER,
  loadSavedReportViews,
  validateSavedReportViews,
  type SavedReportView,
} from '@/lib/report-views'

/**
 * v1.247.0 (PRIMERJAVA-VMESNIKOV-2026 §21) — registr SHRANJENIH POGLEDOV
 * POROČIL (Lightspeed april 2026 »saved report views«).
 *
 * GET  /api/reports/views?locationId= → { views: [...] } (brez vrstice →
 *      prazno; neveljavni vnosi se pri branju tiho izpustijo — self-healing).
 * PUT  /api/reports/views → { locationId?, views: [...] } → upsert Integration
 *      vrstice 'saved-report-views-config' (0 DDL, vzorec resv-pacing-config
 *      v1.244.0 / table-combos-config v1.245.0): celoten seznam je kanonična
 *      oblika (dodajanje/brisanje poteka klient-side, strežnik preveri VSE).
 *      + revizija REPORT_VIEWS_CONFIG.
 *
 * Tenant: requireUserLocation + assertOrgScope + Issue #96 fallback (isti
 * vzorec kot combos/pacing rute — centralna vloga brez lokacije → edina
 * aktivna lokacija v obsegu). Pravice: reports.sales (kdor sme poganjati
 * izvoz, sme imeti shranjene poglede — isti lastnik kot /api/reports/export).
 *
 * Pogled poteže klient sam (GET /api/reports/export|food-cost z rešenim
 * obdobjem iz ČISTEGA resolveReportRange) — ta ruta je SAMO registr.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user
  const locationId = await resolveViewsLocation(user, req.nextUrl.searchParams.get('locationId') || undefined)
  if (isResponse(locationId)) return locationId

  const views = await loadSavedReportViews(db, locationId)
  return ok({ views })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)
  const locationId = await resolveViewsLocation(user, body.locationId || undefined)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const validated = validateSavedReportViews(body.views)
  if ('error' in validated) return fail(validated.error, 400)
  const views: SavedReportView[] = validated.views

  await upsertIntegration(SAVED_REPORT_VIEWS_MARKER, locationId, { views })
  await writeAudit(db, {
    userId: user.sub,
    action: 'REPORT_VIEWS_CONFIG',
    entityType: 'Integration',
    entityId: SAVED_REPORT_VIEWS_MARKER,
    details: jstr({ to: { count: views.length, names: views.map((v) => v.name).slice(0, 10) }, by: user.name, locationId }),
    locationId,
  })

  return ok({ views })
}

/** Upsert Integration vrstice z config JSON (vzorec pacing rute v1.244.0). */
async function upsertIntegration(marker: string, locationId: string, config: Record<string, unknown>): Promise<void> {
  const configJson = JSON.stringify(config)
  const existing = await db.integration.findFirst({ where: { name: marker, type: 'other', locationId }, select: { id: true } })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: configJson } })
  } else {
    await db.integration.create({
      data: {
        id: `${marker}-${Date.now().toString(36)}`,
        name: marker,
        type: 'other',
        provider: 'internal',
        config: configJson,
        isActive: true,
        syncEnabled: false,
        locationId,
      },
    })
  }
}

/** Issue #96 (QA P1, isti vzorec kot pacing/combos ruta): centralna vloga brez
 *  lastne lokacije in brez locationId → fallback na NATANČNO ENO aktivno lokacijo. */
async function resolveViewsLocation(user: Parameters<typeof requireUserLocation>[0], bodyLocationId?: unknown): Promise<string | NextResponse> {
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
