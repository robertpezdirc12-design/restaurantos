import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { haccpPlansAvailable } from '@/lib/haccp-plans'
import { haccpOpsColumnsReady, validatePlanRuleInput, numStrict, type MeasureKind, type ThresholdDirection } from '@/lib/haccp-ops'
import { PLAN_CATEGORIES, PLAN_FREQUENCIES, normalizeSteps, mapPlan } from '../route'

/**
 * Task 64 (v1.62.0) — HACCP načrti kontrol, točkovne rute (PATCH/DELETE).
 * Konvencija Task 52/61: guardResource (lokacijski + org sloj) na vsaki točkovni
 * ruti; audit HACCP_PLAN_UPDATED / HACCP_PLAN_DELETED z chain polji.
 * Issue-13 vzorec: capability probe → 503 dokler produkcija čaka DDL.
 */

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  if (!(await haccpPlansAvailable())) {
    return fail('Načrti kontrol še niso aktivirani — zahtevajo DDL korak na strežniku (/api/admin/migrate-haccp-plans).', 503)
  }
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const existing = await db.haccpPlan.findUnique({ where: { id } })
  if (!existing) return fail('Načrt ne obstaja.', 404)
  // lokacijski + org sloj (Task 52 konvencija)
  const guard = await guardResource(user, existing.locationId)
  if (guard) return guard

  const data: Record<string, unknown> = {}
  const changed: string[] = []
  // Issue #20: SEMANTIČNA polja povišajo različico (version) — zgodovinski
  // zapisi so zaščiteni s posnetkom (ruleSnapshot), spremembe so VIDNE
  const SEMANTIC = ['category', 'frequency', 'target', 'threshold', 'steps', 'measureKind', 'unit', 'direction', 'okLimit', 'warnLimit', 'rangeMin', 'rangeMax', 'critical', 'requiresVerification', 'dueTime', 'weekday', 'monthDay']
  let semantic = false

  if (body?.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) return fail('Ime načrta je obvezno.', 400)
    data.name = name.slice(0, 120)
    changed.push('name')
  }
  if (body?.category !== undefined) {
    const category = String(body.category).toLowerCase()
    if (!(PLAN_CATEGORIES as readonly string[]).includes(category)) return fail('Neznana kategorija načrta.', 400)
    data.category = category
    changed.push('category')
  }
  if (body?.frequency !== undefined) {
    const frequency = String(body.frequency).toLowerCase()
    if (!(PLAN_FREQUENCIES as readonly string[]).includes(frequency)) return fail('Neznana frekvenca (daily/weekly/monthly).', 400)
    data.frequency = frequency
    changed.push('frequency')
  }
  if (body?.target !== undefined) { data.target = String(body.target).trim().slice(0, 120); changed.push('target') }
  if (body?.threshold !== undefined) { data.threshold = String(body.threshold).trim().slice(0, 120); changed.push('threshold') }
  if (body?.responsible !== undefined) { data.responsible = String(body.responsible).trim().slice(0, 80); changed.push('responsible') }
  if (body?.steps !== undefined) {
    const steps = normalizeSteps(body.steps)
    if (steps === null) return fail('Koraki morajo biti seznam nizov (največ 20, vsak do 200 znakov).', 400)
    data.steps = jstr(steps)
    changed.push('steps')
  }
  if (body?.active !== undefined) { data.active = Boolean(body.active); changed.push('active') }

  /* ─────────── Issue #20: operativna pravila (DDL-gated + version bump) ─────────── */
  const RULE_FIELDS = ['measureKind', 'unit', 'direction', 'okLimit', 'warnLimit', 'rangeMin', 'rangeMax', 'critical', 'requiresVerification', 'dueTime', 'weekday', 'monthDay'] as const
  const hasRuleFields = RULE_FIELDS.some((k) => body?.[k] !== undefined)
  if (hasRuleFields && !(await haccpOpsColumnsReady())) {
    return fail('Operativna pravila načrta še niso aktivirana — zahtevajo DDL korak na strežniku (/api/admin/migrate-haccp-ops).', 503)
  }
  if (hasRuleFields) {
    const measureKind = body?.measureKind !== undefined ? String(body.measureKind).toLowerCase() : (existing.measureKind || 'confirm')
    if (measureKind !== 'number' && measureKind !== 'confirm') return fail('measureKind je "number" ali "confirm".', 400)
    const direction = body?.direction !== undefined ? String(body.direction).toLowerCase() : (existing.direction || 'none')
    if (!['below', 'above', 'between', 'none'].includes(direction)) return fail('direction je below/above/between/none.', 400)
    const getNum = (k: 'okLimit' | 'warnLimit' | 'rangeMin' | 'rangeMax' | 'weekday' | 'monthDay'): number | null => {
      if (body?.[k] === undefined) return (existing[k] === null || existing[k] === undefined) ? null : numStrict(existing[k])
      if (body[k] === null) return null
      return numStrict(body[k])
    }
    for (const k of ['okLimit', 'warnLimit', 'rangeMin', 'rangeMax', 'weekday', 'monthDay'] as const) {
      if (body?.[k] !== undefined && body[k] !== null && numStrict(body[k]) === null) {
        return fail(`Polje ${k} mora biti številka.`, 400)
      }
    }
    const newFrequency = body?.frequency !== undefined ? String(body.frequency).toLowerCase() : existing.frequency
    const newDueTime = body?.dueTime !== undefined ? String(body.dueTime) : (existing.dueTime || '10:00')
    const ruleErr = validatePlanRuleInput(
      {
        measureKind: measureKind as MeasureKind,
        unit: body?.unit !== undefined ? String(body.unit).trim().slice(0, 8) : (existing.unit || ''),
        direction: direction as ThresholdDirection,
        okLimit: getNum('okLimit'),
        warnLimit: getNum('warnLimit'),
        rangeMin: getNum('rangeMin'),
        rangeMax: getNum('rangeMax'),
        critical: body?.critical !== undefined ? Boolean(body.critical) : (existing.critical ?? false),
        requiresVerification: body?.requiresVerification !== undefined ? Boolean(body.requiresVerification) : (existing.requiresVerification ?? true),
      },
      {
        frequency: newFrequency,
        dueTime: newDueTime,
        weekday: getNum('weekday'),
        monthDay: getNum('monthDay'),
      },
    )
    if (ruleErr) return fail(ruleErr, 400)

    if (body?.measureKind !== undefined) { data.measureKind = measureKind; changed.push('measureKind') }
    if (body?.unit !== undefined) { data.unit = String(body.unit).trim().slice(0, 8); changed.push('unit') }
    if (body?.direction !== undefined) { data.direction = direction; changed.push('direction') }
    if (body?.okLimit !== undefined) { data.okLimit = body.okLimit === null ? null : numStrict(body.okLimit); changed.push('okLimit') }
    if (body?.warnLimit !== undefined) { data.warnLimit = body.warnLimit === null ? null : numStrict(body.warnLimit); changed.push('warnLimit') }
    if (body?.rangeMin !== undefined) { data.rangeMin = body.rangeMin === null ? null : numStrict(body.rangeMin); changed.push('rangeMin') }
    if (body?.rangeMax !== undefined) { data.rangeMax = body.rangeMax === null ? null : numStrict(body.rangeMax); changed.push('rangeMax') }
    if (body?.critical !== undefined) { data.critical = Boolean(body.critical); changed.push('critical') }
    if (body?.requiresVerification !== undefined) { data.requiresVerification = Boolean(body.requiresVerification); changed.push('requiresVerification') }
    if (body?.dueTime !== undefined) { data.dueTime = newDueTime; changed.push('dueTime') }
    if (body?.weekday !== undefined) { data.weekday = body.weekday === null ? null : numStrict(body.weekday); changed.push('weekday') }
    if (body?.monthDay !== undefined) { data.monthDay = body.monthDay === null ? null : numStrict(body.monthDay); changed.push('monthDay') }
  }

  if (changed.length === 0) return fail('Ni sprememb.', 400)
  semantic = changed.some((c) => SEMANTIC.includes(c))
  if (semantic) {
    data.version = (existing.version ?? 1) + 1 // nova različica pomeni nov pomen meritev
  }

  const row = await db.haccpPlan.update({ where: { id }, data })

  await writeAudit(db, { userId: user.sub, action: 'HACCP_PLAN_UPDATED', entityType: 'HaccpPlan', entityId: id, details: jstr({ name: row.name, changed, active: row.active, version: semantic ? (row.version ?? 1) : undefined, locationId: existing.locationId }), locationId: existing.locationId })
  return ok({ plan: mapPlan(row) })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  if (!(await haccpPlansAvailable())) {
    return fail('Načrti kontrol še niso aktivirani — zahtevajo DDL korak na strežniku (/api/admin/migrate-haccp-plans).', 503)
  }
  const { id } = await params

  const existing = await db.haccpPlan.findUnique({ where: { id } })
  if (!existing) return fail('Načrt ne obstaja.', 404)
  const guard = await guardResource(user, existing.locationId)
  if (guard) return guard

  // Načrt je predloga brez FK otrok (vnosi HaccpEntry so samostojni zapisi) —
  // trdo brisanje je varno; revizija ohrani zgodovino.
  await db.haccpPlan.delete({ where: { id } })

  await writeAudit(db, { userId: user.sub, action: 'HACCP_PLAN_DELETED', entityType: 'HaccpPlan', entityId: id, details: jstr({ name: existing.name, category: existing.category, frequency: existing.frequency, locationId: existing.locationId }), locationId: existing.locationId })
  return ok({ ok: true })
}
