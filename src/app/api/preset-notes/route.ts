import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, requireAuth, isResponse, ok, fail, requireUserLocation, locationScope, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { PRESET_NOTES_MARKER, parsePresetNotes, validatePresetNotes } from '@/lib/preset-notes'

/**
 * STREŽNI VAL v1.248.0 (PRIMERJAVA-VMESNIKOV-2026 §22 B — Lightspeed maj
 * 2026 »preset notes«) — REGISTAR PREDNASTAVLJENIH OPOMB ZA KUHINJO.
 *
 * GET  /api/preset-notes?locationId= → { notes: [...] } (brez vrstice →
 *      prazno). Branje = VSA prijavljena osebja (vatare jih izbirajo v
 *      košaricah — ni razloga za vratarja nad javno znanim besedilom).
 * PUT  /api/preset-notes → { locationId?, notes: [...] } → upsert
 *      Integration vrstice preset-notes-config (0 DDL, vzorec
 *      ops-checklists-config v1.246.0) + revizija PRESET_NOTES_CONFIG.
 *      Validacija STROGA (validatePresetNotes): ≤ 20 opomb, oznaka ≤ 60,
 *      duplikati zavrnjeni. Pravice: menu.manage (kuhinjska navodila so
 *      domena upravitelja menija — Lightspeed Back Office > Menu >
 *      Production instructions).
 *
 * Tenant: requireUserLocation + assertOrgScope + Issue #96 fallback (isti
 * vzorec kot combos/pacing/templates rute — centralna vloga brez lokacije →
 * edina aktivna lokacija v obsegu).
 */
export async function GET(req: NextRequest) {
  // branje: vsa prijavljena osebja (izbira v košaricah POS)
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const locationId = await resolveNotesLocation(user, req.nextUrl.searchParams.get('locationId') || undefined)
  if (isResponse(locationId)) return locationId

  const row = await db.integration.findFirst({
    where: { name: PRESET_NOTES_MARKER, type: 'other', locationId },
    select: { config: true },
  })
  return ok({ notes: parsePresetNotes(row?.config) })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)
  const locationId = await resolveNotesLocation(user, body.locationId || undefined)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const { notes, error } = validatePresetNotes(body)
  if (error) return fail(error, 400)

  await upsertNotesIntegration(locationId, notes)
  await writeAudit(db, {
    userId: user.sub,
    action: 'PRESET_NOTES_CONFIG',
    entityType: 'Integration',
    entityId: PRESET_NOTES_MARKER,
    details: jstr({ to: { count: notes.length, labels: notes.map((n) => n.label).slice(0, 10) }, by: user.name, locationId }),
    locationId,
  })

  return ok({ notes })
}

/** Upsert Integration vrstice z config JSON (vzorec templates rute). */
async function upsertNotesIntegration(locationId: string, notes: unknown[]): Promise<void> {
  const configJson = JSON.stringify({ notes })
  const existing = await db.integration.findFirst({
    where: { name: PRESET_NOTES_MARKER, type: 'other', locationId },
    select: { id: true },
  })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: configJson } })
  } else {
    await db.integration.create({
      data: {
        id: `${PRESET_NOTES_MARKER}-${Date.now().toString(36)}`,
        name: PRESET_NOTES_MARKER,
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

/**
 * Issue #96 fallback (isti vzorec kot templates/combos/pacing rute):
 * centralna vloga brez lastne lokacije in brez locationId → fallback na
 * NATANČNO ENO aktivno lokacijo v obsegu.
 */
async function resolveNotesLocation(
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
