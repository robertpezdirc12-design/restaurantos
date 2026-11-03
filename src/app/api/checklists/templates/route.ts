import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation, locationScope, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import {
  OPS_CHECKLISTS_MARKER,
  parseChecklistTemplates,
  validateChecklistTemplates,
  type ChecklistTemplate,
} from '@/lib/ops-checklists'

/**
 * v1.246.0 (PRIMERJAVA-VMESNIKOV-2026 §20) — OPERATIVNI VAL: registr
 * PREDLOG seznamov (digitalni checklisti, Lightspeed Tasks marec 2026).
 *
 * GET  /api/checklists/templates?locationId= → { templates: [...] } (brez
 *      vrstice → prazno). Branje je defenzivno (jparse + filter neveljavnih).
 * PUT  /api/checklists/templates → { locationId?, templates: [...] } → upsert
 *      Integration vrstice ops-checklists-config (0 DDL, vzorec
 *      table-combos-config v1.245.0) + revizija CHECKLIST_TEMPLATES_CONFIG.
 *      Validacija je STROGA (validateChecklistTemplates — napaka je napaka,
 *      ne tiho popravljanje): ≤ 20 predlog, 1–40 postavk, ime ≤ 80, oznaka
 *      ≤ 160, odziv check|count|text, vseh sedem pogostosti Lightspeed
 *      (daily/weekly/biweekly/every4weeks/monthly/quarterly/semiannual),
 *      tedenske zahtevajo dan v tednu, mesečne dan v mesecu (1–28),
 *      večtedenske/kvartalne še prvi dan (anchorDate).
 *
 * Tenant: requireUserLocation + assertOrgScope + Issue #96 fallback (isti
 * vzorec kot combos/pacing rute — centralna vloga brez lokacije → edina
 * aktivna lokacija v obsegu). Pravice: settings.manage (kdor sme nastavitve,
 * sme predloge — izvedba plošče je ločena, /api/checklists/board).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const locationId = await resolveChecklistsLocation(user, req.nextUrl.searchParams.get('locationId') || undefined)
  if (isResponse(locationId)) return locationId

  const row = await db.integration.findFirst({
    where: { name: OPS_CHECKLISTS_MARKER, type: 'other', locationId },
    select: { config: true },
  })
  return ok({ templates: parseChecklistTemplates(row?.config) })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)
  const locationId = await resolveChecklistsLocation(user, body.locationId || undefined)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const { templates, error } = validateChecklistTemplates(body)
  if (error) return fail(error, 400)

  await upsertIntegration(templates, locationId)
  await writeAudit(db, {
    userId: user.sub,
    action: 'CHECKLIST_TEMPLATES_CONFIG',
    entityType: 'Integration',
    entityId: OPS_CHECKLISTS_MARKER,
    details: jstr({
      to: { count: templates.length, items: templates.reduce((n, t) => n + t.items.length, 0) },
      by: user.name,
      locationId,
    }),
    locationId,
  })

  return ok({ templates })
}

/** Upsert Integration vrstice z config JSON (vzorec combos rute v1.245.0). */
async function upsertIntegration(templates: ChecklistTemplate[], locationId: string): Promise<void> {
  const configJson = JSON.stringify({ templates })
  const existing = await db.integration.findFirst({
    where: { name: OPS_CHECKLISTS_MARKER, type: 'other', locationId },
    select: { id: true },
  })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: configJson } })
  } else {
    await db.integration.create({
      data: {
        id: `${OPS_CHECKLISTS_MARKER}-${Date.now().toString(36)}`,
        name: OPS_CHECKLISTS_MARKER,
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

/** Issue #96 (QA P1, isti vzorec kot combos/pacing rute): centralna vloga brez
 *  lastne lokacije in brez locationId → fallback na NATANČNO ENO aktivno lokacijo. */
async function resolveChecklistsLocation(
  user: Parameters<typeof requireUserLocation>[0],
  bodyLocationId?: unknown,
): Promise<string | NextResponse> {
  const loc = requireUserLocation(user, bodyLocationId)
  if (!isResponse(loc)) return loc
  if (isCentralRole(user) && !user.loc) {
    const scope = await locationScope(user)
    const rows = await db.location.findMany({
      where: {
        isActive: true,
        id: scope.locationId ? (typeof scope.locationId === 'string' ? scope.locationId : { in: scope.locationId.in }) : undefined,
      },
      select: { id: true },
      take: 2,
    })
    if (rows.length === 1) return rows[0].id
  }
  return loc
}
