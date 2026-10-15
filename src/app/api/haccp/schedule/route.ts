import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { num, jparse } from '@/lib/map'
import { buildSchedule, ruleSnapshotOf, thresholdText, haccpOpsColumnsReady, type ScheduleItem, type PlanRule } from '@/lib/haccp-ops'

/**
 * Issue #20 (P1/P2, v1.109.0) — plošča terminov načrtovih kontrol.
 *
 * GET ?daysBack=&daysFwd=&locationId=(centralno) — zadnjih N dni + naslednjih M
 * dni po LOKALNEM koledarju lokacije (prelom dneva + DST po Location.timezone):
 * vsak termin ima stanje overdue/pending/upcoming/done/deviation/
 * awaiting_verification/closed (dnevi brez izvedbe so vidni kot zapadli —
 * issue Testi). Termin je ena izvedba (occurrenceKey dedup na vnosu).
 *
 * Dovoljenja: settings.manage ALI haccp.execute (isti pogled kot GET /api/haccp
 * — izvajalec vidi svojo dnevno ploščo). Centralne vloge podajo locationId.
 * DDL gate: dokler haccp-ops ni apliciran → 503 (prihaja plošča — nov tok).
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  if (!ctx.perms.includes('settings.manage') && !ctx.perms.includes('haccp.execute')) {
    return fail('Dostop zavrnjen — manjka dovoljenje: settings.manage | haccp.execute.', 403)
  }
  const user = ctx.user
  if (!(await haccpOpsColumnsReady())) {
    return fail('Plošča terminov še ni aktivirana — zahteva DDL korak na strežniku (/api/admin/migrate-haccp-ops).', 503)
  }

  // lokacija plošče: staff = svoja; centralna = eksplicitna locationId
  const url = new URL(req.url)
  const locationId = requireUserLocation(user, url.searchParams.get('locationId') ?? undefined)
  if (isResponse(locationId)) return locationId

  const daysBack = Math.min(Math.max(Number(url.searchParams.get('daysBack')) || 3, 0), 14)
  const daysFwd = Math.min(Math.max(Number(url.searchParams.get('daysFwd')) || 2, 0), 14)

  const loc = await db.location.findUnique({ where: { id: locationId }, select: { timezone: true } })
  const tz = loc?.timezone || 'Europe/Ljubljana'

  // aktivni načrti LOKACIJE (centralni brez-lokacijski načrti so predloge —
  // na ploščo pridejo šele, ko jih centralna vloga klonira na lokacijo)
  const plans = await db.haccpPlan.findMany({
    where: { active: true, locationId },
    orderBy: { name: 'asc' },
    take: 200,
  })

  // vnosi terminov v oknu (po dueAt; indeksiran) — zemljevid po occurrenceKey
  const now = new Date()
  const windowStart = new Date(now.getTime() - (daysBack + 1) * 24 * 3600 * 1000)
  const windowEnd = new Date(now.getTime() + (daysFwd + 1) * 24 * 3600 * 1000)
  const entries = await db.haccpEntry.findMany({
    where: { locationId, occurrenceKey: { not: '' }, dueAt: { gte: windowStart, lte: windowEnd } },
    select: { id: true, occurrenceKey: true, entryState: true, status: true, numericValue: true, unit: true, date: true },
  })
  const byOcc = new Map(
    entries.map((e) => [
      e.occurrenceKey,
      {
        id: e.id,
        occurrenceKey: e.occurrenceKey,
        entryState: e.entryState,
        status: e.status,
        numericValue: e.numericValue === null ? null : num(e.numericValue),
        unit: e.unit,
        measuredAt: e.date,
      },
    ]),
  )

  const items: ScheduleItem[] = buildSchedule(
    plans.map((p) => ({
      id: p.id,
      name: p.name,
      category: String(p.category),
      target: p.target,
      steps: Array.isArray(jparse<string[]>(p.steps, [])) ? (jparse<string[]>(p.steps, []) as string[]) : [],
      responsible: p.responsible,
      frequency: p.frequency,
      dueTime: p.dueTime,
      weekday: p.weekday,
      monthDay: p.monthDay,
      rule: ruleSnapshotOf(p),
    })),
    byOcc,
    tz,
    now,
    daysBack,
    daysFwd,
  )

  const summary = items.reduce<Record<string, number>>(
    (acc, it) => {
      acc[it.state] = (acc[it.state] ?? 0) + 1
      return acc
    },
    {},
  )

  return ok({
    occurrences: items.map((it) => ({
      ...it,
      plan: {
        ...it.plan,
        thresholdText: thresholdText(it.plan.rule as PlanRule),
      },
    })),
    summary,
    timezone: tz,
    locationId,
  })
}
