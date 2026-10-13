import { NextRequest } from 'next/server'
import type { HaccpCategory } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, jstr, jparse } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { haccpPlansAvailable } from '@/lib/haccp-plans'

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
}): PlanDTO {
  const rawSteps = jparse<string[] | unknown>(r.steps, [])
  const steps = Array.isArray(rawSteps) ? rawSteps.map((s) => String(s)).slice(0, 20) : []
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
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  if (!(await haccpPlansAvailable())) return ok({ plans: [], ddlPending: true })
  const rows = await db.haccpPlan.findMany({
    where: await locationScope(user),
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    take: 200,
  })
  return ok({ plans: rows.map(mapPlan), ddlPending: false })
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
    },
  })
  // 33-c konvencija: tamper-evidentna revizijska veriga
  await writeAudit(db, { userId: user.sub, action: 'HACCP_PLAN_CREATED', entityType: 'HaccpPlan', entityId: row.id, details: jstr({ name, category, frequency, target, threshold, responsible, steps: steps.length, active: row.active, locationId }), locationId: locationId })
  return ok({ plan: mapPlan(row) }, 201)
}
