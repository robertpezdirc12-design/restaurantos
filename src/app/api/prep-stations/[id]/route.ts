import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * OPS-10 val 1 (v1.77.0) — PATCH /api/prep-stations/[id]
 *
 * Minimal zero-DDL CRUD for PrepStation: the KDS "Po postajah" breakdown
 * edits only avgPrepTime (target prep minutes, clamped 1..60). Gated by
 * settings.manage (manager-level: the KDS board itself only needs
 * kitchen.update, changing targets is a settings action).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (body?.avgPrepTime === undefined) return fail('Manjka avgPrepTime.')
  const raw = Math.round(Number(body.avgPrepTime))
  if (!Number.isFinite(raw)) return fail('avgPrepTime mora biti število (minut).')
  // clamp 1..60 — 0/negative targets would classify everything late; >60 min is not a prep target
  const avgPrepTime = Math.min(60, Math.max(1, raw))
  const existing = await db.prepStation.findUnique({ where: { id }, select: { name: true, locationId: true } })
  if (!existing) return fail('Postaja ne obstaja.', 404)
  const locRes = await guardResource(user, existing.locationId)
  if (locRes) return locRes
  const station = await db.prepStation.update({ where: { id }, data: { avgPrepTime }, select: { id: true, name: true, type: true, avgPrepTime: true } })
  await writeAudit(db, { userId: user.sub, action: 'PREP_STATION_UPDATED', entityType: 'PrepStation', entityId: id, details: jstr({ name: station.name, avgPrepTime }), locationId: existing.locationId })
  return ok({ station })
}
