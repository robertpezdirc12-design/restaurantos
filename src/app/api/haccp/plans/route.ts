import { NextRequest } from 'next/server'
import type { HaccpCategory } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, jstr, jparse, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { haccpPlansAvailable } from '@/lib/haccp-plans'
import { haccpOpsColumnsReady, validatePlanRuleInput, numStrict, type MeasureKind, type ThresholdDirection } from '@/lib/haccp-ops'

/**
 * Task 64 (v1.62.0) — HACCP načrti kontrol (audit §7 vrstica 125: "vnosi+seznam;
 * brez načrtov kontrol"). Načrt = periodična kontrolna predloga, iz katere
 * operaterji izvajajo vnose (HaccpEntry prek /api/haccp).
 *
 * Dovoljenja: `settings.manage` — enaka presoja kot GET /api/haccp (N5: UI zavihek
 * HACCP je vezan na settings.manage; načrti so administrativne predloge, še strožje
 * kot vnosi, ki jih ustvari vsak avtenticiran uporabnik).
 *
 * Issue-13 vzorec: produkcija čaka DDL (/api/admin/migrate-haccp-plans) — capability
 * probe graceful degradacija (src/lib/haccp-plans.ts). GET vrača ddlPending: true,
 * POST 503 — UI prikaže passiven pas, nobena živa funkcionalnost se ne zlomi.
 */

export const PLAN_CATEGORIES = ['temperature', 'cleaning', 'delivery', 'cooling', 'training'] as const
export const PLAN_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const

export interface PlanDTO {
  id: string
  name: string
  category: string
  frequency: string
  target: string
  threshold: string
  steps: string[]
  responsible: string
  active: boolean
  locationId: string | null
  createdAt: string | Date
  // Issue #20 (v1.109.0) — operativna pravila (DDL-gated; null = produkcija
  // še čaka haccp-ops korak → UI prikaže pasivna polja)
  measureKind: string | null
  unit: string | null
  direction: string | null
  okLimit: number | null
  warnLimit: number | null
  rangeMin: number | null
  rangeMax: number | null
  critical: boolean | null
  requiresVerification: boolean | null
  dueTime: string | null
  weekday: number | null
  monthDay: number | null
  version: number | null
}

/** Normaliziraj steps telo → seznam nizov (ali null = neveljavno). */
export function normalizeSteps(input: unknown): string[] | null {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) return null
  if (input.length > 20) return null
  const steps: string[] = []
  for (const s of input) {
    const v = String(s ?? '').trim()
    if (!v) continue
    if (v.length > 200) return null
    steps.push(v)
  }
  return steps
}

/** Mapiraj DB vrstico → DTO (steps: Json na PG, String na SQLite zrcalu). */
export function mapPlan(r: {
  id: string; name: string; category: string; frequency: string; target: string
  threshold: string; steps: unknown; responsible: string; active: boolean
  locationId: string | null; createdAt: Date
  measureKind?: string | null; unit?: string | null; direction?: string | null
  okLimit?: unknown; warnLimit?: unknown; rangeMin?: unknown; rangeMax?: unknown
  critical?: boolean | null; requiresVerification?: boolean | null
  dueTime?: string | null; weekday?: number | null; monthDay?: number | null; version?: number | null
}): PlanDTO {
  const rawSteps = jparse<string[] | unknown>(r.steps, [])
  const steps = Array.isArray(rawSteps) ? rawSteps.map((s) => String(s)).slice(0, 20) : []
  const numo = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null
    const n = numStrict(v)
    return n
  }
  return {
    id: r.id,
    name: r.name,
    category: String(r.category).toUpperCase(),
    frequency: r.frequency,
    target: r.target,
    threshold: r.threshold,
    steps,
    responsible: r.responsible,
    active: r.active,
    locationId: r.locationId,
    createdAt: r.createdAt,
    measureKind: r.measureKind ?? null,
    unit: r.unit ?? null,
    direction: r.direction ?? null,
    okLimit: numo(r.okLimit),
    warnLimit: numo(r.warnLimit),
    rangeMin: numo(r.rangeMin),
    rangeMax: numo(r.rangeMax),
    critical: r.critical ?? null,
    requiresVerification: r.requiresVerification ?? null,
    dueTime: r.dueTime ?? null,
    weekday: r.weekday ?? null,
    monthDay: r.monthDay ?? null,
    version: r.version ?? null,
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  if (!(await haccpPlansAvailable())) return ok({ plans: [], ddlPending: true })
  // Issue #20: operativna pravila (novo polja) so pasivna, dokler haccp-ops
  // DDL ni apliciran → UI skrije novo sekcijo (vzorec graceful degradacije)
  const opsReady = await haccpOpsColumnsReady()
  const rows = await db.haccpPlan.findMany({
    where: await locationScope(user),
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    take: 200,
  })
  return ok({ plans: rows.map(mapPlan), ddlPending: false, ddlOpsPending: !opsReady })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  if (!(await haccpPlansAvailable())) {
    return fail('Načrti kontrol še niso aktivirani — zahtevajo DDL korak na strežniku (/api/admin/migrate-haccp-plans).', 503)
  }
  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim()
  if (!name) return fail('Ime načrta je obvezno.', 400)
  if (name.length > 120) return fail('Ime načrta je predolgo (največ 120 znakov).', 400)
  const category = String(body?.category || '').toLowerCase()
  if (!(PLAN_CATEGORIES as readonly string[]).includes(category)) return fail('Neznana kategorija načrta.', 400)
  const frequency = String(body?.frequency || 'daily').toLowerCase()
  if (!(PLAN_FREQUENCIES as readonly string[]).includes(frequency)) return fail('Neznana frekvenca (daily/weekly/monthly).', 400)
  const target = String(body?.target || '').trim().slice(0, 120)
  const threshold = String(body?.threshold || '').trim().slice(0, 120)
  const responsible = String(body?.responsible || '').trim().slice(0, 80)
  const steps = normalizeSteps(body?.steps)
  if (steps === null) return fail('Koraki morajo biti seznam nizov (največ 20, vsak do 200 znakov).', 400)

  /* ─────────── Issue #20: operativna pravila (DDL-gated) ─────────── */
  const hasRuleFields =
    body?.measureKind !== undefined || body?.unit !== undefined || body?.direction !== undefined ||
    body?.okLimit !== undefined || body?.warnLimit !== undefined || body?.rangeMin !== undefined ||
    body?.rangeMax !== undefined || body?.critical !== undefined || body?.requiresVerification !== undefined ||
    body?.dueTime !== undefined || body?.weekday !== undefined || body?.monthDay !== undefined
  if (hasRuleFields && !(await haccpOpsColumnsReady())) {
    return fail('Operativna pravila načrta še niso aktivirana — zahtevajo DDL korak na strežniku (/api/admin/migrate-haccp-ops).', 503)
  }
  const measureKind = body?.measureKind !== undefined ? String(body.measureKind).toLowerCase() : 'confirm'
  if (measureKind !== 'number' && measureKind !== 'confirm') return fail('measureKind je "number" ali "confirm".', 400)
  const direction = body?.direction !== undefined ? String(body.direction).toLowerCase() : 'none'
  if (!['below', 'above', 'between', 'none'].includes(direction)) return fail('direction je below/above/between/none.', 400)
  const ruleErr = validatePlanRuleInput(
    {
      measureKind: measureKind as MeasureKind,
      unit: body?.unit !== undefined ? String(body.unit).trim().slice(0, 8) : '',
      direction: direction as ThresholdDirection,
      okLimit: body?.okLimit !== undefined ? numStrict(body.okLimit) : null,
      warnLimit: body?.warnLimit !== undefined ? numStrict(body.warnLimit) : null,
      rangeMin: body?.rangeMin !== undefined ? numStrict(body.rangeMin) : null,
      rangeMax: body?.rangeMax !== undefined ? numStrict(body.rangeMax) : null,
      critical: body?.critical !== undefined ? Boolean(body.critical) : false,
      requiresVerification: body?.requiresVerification !== undefined ? Boolean(body.requiresVerification) : true,
    },
    {
      frequency,
      dueTime: body?.dueTime !== undefined ? String(body.dueTime) : '10:00',
      weekday: body?.weekday !== undefined ? numStrict(body.weekday) : null,
      monthDay: body?.monthDay !== undefined ? numStrict(body.monthDay) : null,
    },
  )
  if (ruleErr) return fail(ruleErr, 400)
  // numerične meje: niz pač neveljaven (numStrict null pri podani vrednosti)
  for (const k of ['okLimit', 'warnLimit', 'rangeMin', 'rangeMax'] as const) {
    if (body?.[k] !== undefined && body[k] !== null && numStrict(body[k]) === null) {
      return fail(`Polje ${k} mora biti številka.`, 400)
    }
  }

  // Issue #4 §10 konvencija: staff = svoja lokacija, centralna poda body.locationId
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const row = await db.haccpPlan.create({
    data: {
      id: nid(),
      name,
      category: category as HaccpCategory,
      frequency,
      target,
      threshold,
      steps: jstr(steps),
      responsible,
      active: body?.active === undefined ? true : Boolean(body.active),
      locationId,
      // Issue #20 — operativna pravila (privzeto: confirm + brez terminske
      // omejitve = vedenje enako starem toku, dokler upravljalec ne določi)
      measureKind,
      unit: body?.unit !== undefined ? String(body.unit).trim().slice(0, 8) : '',
      direction,
      okLimit: body?.okLimit !== undefined ? numStrict(body.okLimit) : null,
      warnLimit: body?.warnLimit !== undefined ? numStrict(body.warnLimit) : null,
      rangeMin: body?.rangeMin !== undefined ? numStrict(body.rangeMin) : null,
      rangeMax: body?.rangeMax !== undefined ? numStrict(body.rangeMax) : null,
      critical: body?.critical !== undefined ? Boolean(body.critical) : false,
      requiresVerification: body?.requiresVerification !== undefined ? Boolean(body.requiresVerification) : true,
      dueTime: body?.dueTime !== undefined ? String(body.dueTime) : '10:00',
      weekday: body?.weekday !== undefined ? numStrict(body.weekday) : null,
      monthDay: body?.monthDay !== undefined ? numStrict(body.monthDay) : null,
      version: 1,
    },
  })
  // 33-c konvencija: tamper-evidentna revizijska veriga
  await writeAudit(db, { userId: user.sub, action: 'HACCP_PLAN_CREATED', entityType: 'HaccpPlan', entityId: row.id, details: jstr({ name, category, frequency, target, threshold, responsible, steps: steps.length, active: row.active, locationId }), locationId: locationId })
  return ok({ plan: mapPlan(row) }, 201)
}
