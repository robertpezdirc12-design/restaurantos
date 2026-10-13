import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { haccpPlansAvailable } from '@/lib/haccp-plans'
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

  if (changed.length === 0) return fail('Ni sprememb.', 400)

  const row = await db.haccpPlan.update({ where: { id }, data })

  await writeAudit(db, { userId: user.sub, action: 'HACCP_PLAN_UPDATED', entityType: 'HaccpPlan', entityId: id, details: jstr({ name: row.name, changed, active: row.active, locationId: existing.locationId }), locationId: existing.locationId })
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
