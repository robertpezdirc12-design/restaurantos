import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, requireUserLocation, locationScope, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import {
  buildChecklistBoard,
  checklistRunsAvailable,
  coverageOf,
  loadChecklistTemplates,
  occurrenceKeysForWindow,
  parseItemResults,
  runCompletedFromCoverage,
  type ChecklistRunView,
} from '@/lib/ops-checklists'
import { isValidDateKey, localDateFromKey, checklistOccurrenceForDate } from '@/lib/ops-checklists'

/**
 * v1.246.0 (PRIMERJAVA-VMESNIKOV-2026 §20) — OPERATIVNI VAL: PLOŠČA
 * digitalnih checklistov (Lightspeed Tasks marec 2026).
 *
 * GET  /api/checklists/board?daysBack=&daysFwd=&locationId= → plošča terminov
 *      (zadnjih N dni + naslednjih M po LOKALNEM koledarju lokacije — prelom
 *      dneva + DST po Location.timezone; vzorec HACCP plošče v1.109.0): vsak
 *      termin ima stanje overdue/pending/upcoming/completed + pokritost
 *      n/N + izvedbo (itemResults PO POSTAVKI { kind, value, at, byId, byName }
 *      — »who completed what«). Dnevi brez izvedbe z zapadlim rokom so
 *      ZAPADLI (ista poštenost kot HACCP). DDL gate: dokler ChecklistRun ni
 *      apliciran → { checklists: [], ddlPending: true } (graceful — haccp-plans
 *      vzorec; predloge se preberejo vseeno, da UI pokaže urejevalnik).
 *
 * POST /api/checklists/board → { templateId, date (YYYY-MM-DD), itemId,
 *      value } — odziv na ENO postavko (check: boolean | count: število |
 *      text: niz ≤ 500; null = POČISTI odziv). Upsert ChecklistRun po
 *      @@unique [locationId, templateId, occurrenceKey]; datum MORA biti
 *      dejanski termin predloge (motor preveri — brez fantomskih izvedb).
 *      Zaključek izpelje STREŽNIK iz pokritosti (runCompletedFromCoverage —
 *      klient ne more prijaviti "completed"); čiščenje postavke znova odpre.
 *      Reviziji CHECKLIST_RUN_ITEM / CHECKLIST_RUN_COMPLETED.
 *
 * Pravice: requireAuth — odpiralni seznam izpolni kdor odpira (isti prag kot
 * delovnica/urnik); predloge (PUT templates) ostanejo settings.manage.
 * Tenant: requireUserLocation + assertOrgScope + Issue #96 fallback.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const locationId = await resolveBoardLocation(user, url.searchParams.get('locationId') ?? undefined)
  if (isResponse(locationId)) return locationId

  const daysBack = Math.min(Math.max(Number(url.searchParams.get('daysBack')) || 3, 0), 14)
  const daysFwd = Math.min(Math.max(Number(url.searchParams.get('daysFwd')) || 2, 0), 14)

  const [loc, templates, runsReady] = await Promise.all([
    db.location.findUnique({ where: { id: locationId }, select: { timezone: true } }),
    loadChecklistTemplates(db, locationId),
    checklistRunsAvailable(),
  ])
  const tz = loc?.timezone || 'Europe/Ljubljana'

  // DDL gate: brez tabele izvedb je plošča prazna (graceful), predloge vseeno
  // pridejo — urejevalnik zanje dela takoj (0 DDL plast).
  if (!runsReady) {
    return ok({ checklists: [], runs: [], templates, summary: {}, timezone: tz, locationId, ddlPending: true })
  }

  const now = new Date()
  const keys = occurrenceKeysForWindow(templates, tz, now, daysBack, daysFwd)
  const runs = keys.length
    ? await db.checklistRun.findMany({ where: { locationId, occurrenceKey: { in: keys } } })
    : []
  const byOcc = new Map<string, ChecklistRunView>(
    runs.map((r) => [
      r.occurrenceKey,
      {
        id: r.id,
        templateId: r.templateId,
        templateName: r.templateName,
        occurrenceKey: r.occurrenceKey,
        state: r.state,
        itemResults: parseItemResults(r.itemResults),
        completedById: r.completedById,
        completedByName: r.completedByName,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      },
    ]),
  )

  const board = buildChecklistBoard(templates, byOcc, tz, now, daysBack, daysFwd)
  const summary = board.reduce<Record<string, number>>((acc, it) => {
    acc[it.state] = (acc[it.state] ?? 0) + 1
    return acc
  }, {})

  return ok({ checklists: board, summary, templates, timezone: tz, locationId, ddlPending: false })
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Manjkajoči ali neveljaven JSON.', 400)
  const locationId = await resolveBoardLocation(user, (body as { locationId?: unknown }).locationId || undefined)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  if (!(await checklistRunsAvailable())) {
    return fail('Plošča seznamov še ni aktivirana — zahteva DDL korak (/api/admin/migrate-checklist-runs).', 503)
  }

  const templateId = String((body as { templateId?: unknown }).templateId ?? '').trim()
  const dateKey = String((body as { date?: unknown }).date ?? '').trim()
  const itemId = String((body as { itemId?: unknown }).itemId ?? '').trim()
  const value = (body as { value?: unknown }).value
  if (!templateId || !itemId || !isValidDateKey(dateKey)) {
    return fail('Podajte templateId, date (YYYY-MM-DD) in itemId.', 400)
  }

  // veljavnost vrednosti PO odzivnem tipu postavke (strežnik odloča)
  if (value !== null && typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') {
    return fail('Vrednost mora biti boolean, število, niz ali null (počisti).', 400)
  }
  if (typeof value === 'string' && value.length > 500) {
    return fail('Opomba je predolga (največ 500 znakov).', 400)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return fail('Vrednost mora biti končno število.', 400)
  }

  const [loc, templates] = await Promise.all([
    db.location.findUnique({ where: { id: locationId }, select: { timezone: true } }),
    loadChecklistTemplates(db, locationId),
  ])
  const tz = loc?.timezone || 'Europe/Ljubljana'
  const template = templates.find((t) => t.id === templateId)
  if (!template) return fail('Predloga ne obstaja (ali ni več aktivna na tej lokaciji).', 404)
  const item = template.items.find((it) => it.id === itemId)
  if (!item) return fail('Postavka ne obstaja v predlogi.', 404)

  // datum MORA biti dejanski termin predloge (brez fantomskih izvedb)
  const date = localDateFromKey(dateKey)
  if (!date) return fail('Neveljaven datum termina.', 400)
  const occ = checklistOccurrenceForDate(template, date, tz)
  if (!occ) return fail('Ta datum ni termin te predloge.', 400)

  // veljavnost vrednosti po odzivnem tipu postavke
  if (value !== null) {
    if (item.response === 'check' && typeof value !== 'boolean') return fail('Postavka pričakuje potrditev (boolean).', 400)
    if (item.response === 'count' && typeof value !== 'number') return fail('Postavka pričakuje število.', 400)
    if (item.response === 'text' && typeof value !== 'string') return fail('Postavka pričakuje besedilo.', 400)
  }

  const at = new Date()
  const result = await db.$transaction(async (tx) => {
    let run = await tx.checklistRun.findUnique({
      where: { locationId_templateId_occurrenceKey: { locationId, templateId, occurrenceKey: occ.key } },
    })
    if (!run) {
      try {
        run = await tx.checklistRun.create({
          data: {
            id: `clr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            locationId,
            templateId,
            templateName: template.name,
            occurrenceKey: occ.key,
            state: 'open',
            itemResults: '{}',
          },
        })
      } catch (e) {
        const msg = String((e as Error).message || e)
        if (msg.includes('Unique constraint') || msg.includes('P2002')) {
          // sočasni ustvarjalec — branje po ključku (upsert teče naprej)
          run = await tx.checklistRun.findUnique({
            where: { locationId_templateId_occurrenceKey: { locationId, templateId, occurrenceKey: occ.key } },
          })
        }
        if (!run) throw e
      }
    }
    if (!run) throw new Error('Izvedba seznama ni bila ustvarjena.')

    const results = parseItemResults(run.itemResults)
    let removed = false
    if (value === null) {
      removed = delete results[itemId]
    } else {
      results[itemId] = { kind: item.response, value, at: at.toISOString(), byId: user.sub, byName: user.name || '' }
    }

    const completed = runCompletedFromCoverage(template, results)
    const wasCompleted = run.state === 'completed'
    const updated = await tx.checklistRun.update({
      where: { id: run.id },
      data: {
        itemResults: jstr(results),
        state: completed ? 'completed' : 'open',
        completedById: completed ? user.sub : '',
        completedByName: completed ? (user.name || '') : '',
        completedAt: completed ? at : null,
      },
    })
    return { run: updated, results, completed, wasCompleted, removed }
  })

  await writeAudit(db, {
    userId: user.sub,
    action: 'CHECKLIST_RUN_ITEM',
    entityType: 'ChecklistRun',
    entityId: result.run.id,
    details: jstr({
      templateId,
      templateName: template.name,
      itemId,
      kind: item.response,
      value: value === null ? null : typeof value === 'boolean' ? value : String(value).slice(0, 100),
      cleared: result.removed,
      occurrenceKey: occ.key,
      by: user.name,
      locationId,
    }),
    locationId,
  })

  if (result.completed && !result.wasCompleted) {
    await writeAudit(db, {
      userId: user.sub,
      action: 'CHECKLIST_RUN_COMPLETED',
      entityType: 'ChecklistRun',
      entityId: result.run.id,
      details: jstr({
        templateId,
        templateName: template.name,
        occurrenceKey: occ.key,
        items: template.items.length,
        by: user.name,
        locationId,
      }),
      locationId,
    })
  }

  return ok({
    run: {
      id: result.run.id,
      templateId: result.run.templateId,
      templateName: result.run.templateName,
      occurrenceKey: result.run.occurrenceKey,
      state: result.run.state,
      itemResults: result.results,
      completedById: result.run.completedById,
      completedByName: result.run.completedByName,
      completedAt: result.run.completedAt ? result.run.completedAt.toISOString() : null,
    },
    progress: coverageOf(template, result.results),
    completed: result.completed,
  })
}

/** Issue #96 (QA P1, isti vzorec kot combos/pacing rute): centralna vloga brez
 *  lastne lokacije in brez locationId → fallback na NATANČNO ENO aktivno lokacijo. */
async function resolveBoardLocation(
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
