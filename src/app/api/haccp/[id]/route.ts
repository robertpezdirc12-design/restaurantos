import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import { parseRuleSnapshot, thresholdText } from '@/lib/haccp-ops'

/**
 * Issue #20 (P1/P2, v1.109.0) — podrobnost HACCP zapisa + revizijska časovnica.
 *
 * GET /api/haccp/:id — zapis (meritev, posnetek pravil, stanje) + vsi
 * revizijski dogodki (HaccpAction, kronološko): korektivni ukrepi in
 * verifikacije. Izvedenega zapisa NI mogoče brisati/prepisati — zgodovina
 * meritve je nespremenljiva (popravki so NOVI dogodki z referenco).
 *
 * Dovoljenja: settings.manage ALI haccp.execute; tenant sloj locationScope
 * (zapisi druge lokacije → 404, fail-closed).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuthWithPerms(_req)
  if (isResponse(ctx)) return ctx
  if (!ctx.perms.includes('settings.manage') && !ctx.perms.includes('haccp.execute')) {
    return fail('Dostop zavrnjen — manjka dovoljenje: settings.manage | haccp.execute.', 403)
  }
  const user = ctx.user
  const { id } = await params

  const entry = await db.haccpEntry.findFirst({ where: { id, ...(await locationScope(user)) } })
  if (!entry) return fail('Zapis ne obstaja.', 404)

  const actions = await db.haccpAction.findMany({ where: { entryId: entry.id }, orderBy: { createdAt: 'asc' } })
  const rule = parseRuleSnapshot(entry.ruleSnapshot)

  return ok({
    check: {
      id: entry.id,
      type: entry.category.toUpperCase(),
      target: entry.title,
      value: entry.numericValue !== null && entry.numericValue !== undefined ? num(entry.numericValue) : entry.value ? num(entry.value) : null,
      ok: entry.status === 'ok',
      note: entry.description || null,
      employeeId: entry.employeeName || null,
      checkedAt: entry.date,
      locationId: entry.locationId,
      planId: entry.planId || null,
      planName: entry.planName || null,
      planVersion: entry.planVersion || null,
      entryState: entry.entryState || 'legacy',
      status: entry.status,
      measureKind: entry.measureKind || null,
      unit: entry.unit || null,
      dueAt: entry.dueAt ?? null,
      occurrenceKey: entry.occurrenceKey || null,
      closedAt: entry.closedAt ?? null,
      source: entry.source || 'manual',
      correctiveAction: entry.correctiveAction || null,
      thresholdText: rule ? thresholdText(rule) : null,
      ruleSnapshot: rule,
    },
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      method: a.method,
      note: a.note,
      outcome: a.outcome,
      recheckValue: a.recheckValue === null ? null : num(a.recheckValue),
      performedByName: a.performedByName,
      managerial: a.managerial,
      createdAt: a.createdAt,
    })),
  })
}
