import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation, locationScope, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import {
  TABLE_COMBOS_MARKER,
  RESV_BOOKABLE_MARKER,
  parseCombos,
  parseBookableExcluded,
  type TableCombo,
} from '@/lib/table-combos'

/**
 * v1.245.0 (PRIMERJAVA-VMESNIKOV-2026 §19) — registr KOMBINACIJ MIZ +
 * REZERVABILNIH MIZ (walk-in rezerva).
 *
 * GET  /api/tables/combos?locationId= → { combos: [{ id, tableIds }],
 *      excludedTableIds: [] } (brez vrstic → prazno; resers kombinacij z
 *      IZBRISANIMI mizami se tiho izpustijo — self-healing, naslednja
 *      shranitev jih počisti).
 * PUT  /api/tables/combos → { locationId?, combos?: [...], excludedTableIds?: [] }
 *      → upsert Integration vrstic (0 DDL, vzorec resv-pacing-config v1.244.0):
 *        - 'table-combos-config' — kombinacije (≥ 2 mize, vse iz iste lokacije,
 *          brez podvajanj znotraj kombinacije; prekrivanje med kombinacijami
 *          je DOVOLJENO — ista miza v več parih);
 *        - 'resv-bookable-config' — mize, ki se NE štejejo v spletno kapaciteto
 *          (walk-in rezerva; interna telefon pot NI omejena).
 *      + reviziji TABLE_COMBOS_CONFIG / TABLE_BOOKABLE_CONFIG.
 *
 * Tenant: requireUserLocation + assertOrgScope + Issue #96 fallback (isti
 * vzorec kot pacing ruta — centralna vloga brez lokacije → edina aktivna
 * lokacija v obsegu). Pravice: reservations.manage (isti lastnik kot widget
 * + ritem — kdor sme rezervacije, sme njihovo orodje).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const locationId = await resolveCombosLocation(user, req.nextUrl.searchParams.get('locationId') || undefined)
  if (isResponse(locationId)) return locationId

  const [combosRow, bookableRow, tables] = await Promise.all([
    db.integration.findFirst({ where: { name: TABLE_COMBOS_MARKER, type: 'other', locationId }, select: { config: true } }),
    db.integration.findFirst({ where: { name: RESV_BOOKABLE_MARKER, type: 'other', locationId }, select: { config: true } }),
    db.table.findMany({ where: { locationId }, select: { id: true } }),
  ])
  const tableIds = new Set(tables.map((t) => t.id))
  // zamujene kombinacije (izbrisana miza) se tiho izpustijo — iskreno stanje
  const combos = parseCombos(combosRow?.config).filter((c) => c.tableIds.every((id) => tableIds.has(id)))
  return ok({ combos, excludedTableIds: parseBookableExcluded(bookableRow?.config) })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)
  const locationId = await resolveCombosLocation(user, body.locationId || undefined)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const hasCombos = Array.isArray(body.combos)
  const hasExcluded = Array.isArray(body.excludedTableIds)
  if (!hasCombos && !hasExcluded) {
    return fail('Podajte "combos" in/ali "excludedTableIds".', 400)
  }

  let combos: TableCombo[] | null = null
  if (hasCombos) {
    const raw = body.combos as unknown[]
    if (raw.length > 20) return fail('Največ 20 kombinacij na lokacijo.', 400)
    const seen = new Set<string>()
    combos = []
    for (const c of raw) {
      if (!c || typeof c !== 'object') return fail('Neveljavna kombinacija.', 400)
      const row = c as { id?: unknown; tableIds?: unknown }
      const tableIds = [...new Set((Array.isArray(row.tableIds) ? row.tableIds : []).map((x: unknown) => String(x ?? '').trim()).filter(Boolean))]
      if (tableIds.length < 2) return fail('Kombinacija potrebuje vsaj dve mizi.', 400)
      if (tableIds.length > 5) return fail('Kombinacija lahko zajema največ 5 miz.', 400)
      const id = String(row.id ?? '').trim() || `combo-${tableIds.join('-').slice(0, 40)}`
      if (seen.has(id)) return fail(`Podvojen id kombinacije: ${id}.`, 400)
      seen.add(id)
      combos.push({ id, tableIds })
    }
    // vse mize obstajajo in so iz iste lokacije
    const allIds = [...new Set(combos.flatMap((c) => c.tableIds))]
    const members = await db.table.findMany({ where: { id: { in: allIds } }, select: { id: true, locationId: true, number: true } })
    const memberMap = new Map(members.map((m) => [m.id, m]))
    for (const id of allIds) {
      const m = memberMap.get(id)
      if (!m) return fail('Ena od miz v kombinaciji ne obstaja.', 400)
      if (m.locationId !== locationId) return fail(`Miza ${m.number} ne pripada tej lokaciji.`, 400)
    }
  }

  let excluded: string[] | null = null
  if (hasExcluded) {
    const rawEx = (body.excludedTableIds as unknown[]).map((x: unknown) => String(x ?? '').trim()).filter(Boolean)
    excluded = [...new Set(rawEx)]
    if (excluded.length > 0) {
      const rows = await db.table.findMany({ where: { id: { in: excluded } }, select: { id: true, locationId: true, number: true } })
      const rowMap = new Map(rows.map((r) => [r.id, r]))
      for (const id of excluded) {
        const r = rowMap.get(id)
        if (!r) return fail('Izključena miza ne obstaja.', 400)
        if (r.locationId !== locationId) return fail(`Miza ${r.number} ne pripada tej lokaciji.`, 400)
      }
    }
  }

  if (combos) {
    await upsertIntegration(TABLE_COMBOS_MARKER, locationId, { combos })
    await writeAudit(db, {
      userId: user.sub,
      action: 'TABLE_COMBOS_CONFIG',
      entityType: 'Integration',
      entityId: TABLE_COMBOS_MARKER,
      details: jstr({ to: { count: combos.length }, by: user.name, locationId }),
      locationId,
    })
  }
  if (excluded) {
    await upsertIntegration(RESV_BOOKABLE_MARKER, locationId, { excludedTableIds: excluded })
    await writeAudit(db, {
      userId: user.sub,
      action: 'TABLE_BOOKABLE_CONFIG',
      entityType: 'Integration',
      entityId: RESV_BOOKABLE_MARKER,
      details: jstr({ to: { excluded: excluded.length }, by: user.name, locationId }),
      locationId,
    })
  }

  return ok({
    ...(combos ? { combos } : {}),
    ...(excluded ? { excludedTableIds: excluded } : {}),
  })
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

/** Issue #96 (QA P1, isti vzorec kot pacing ruta): centralna vloga brez lastne
 *  lokacije in brez locationId → fallback na NATANČNO ENO aktivno lokacijo. */
async function resolveCombosLocation(user: Parameters<typeof requireUserLocation>[0], bodyLocationId?: unknown): Promise<string | NextResponse> {
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
