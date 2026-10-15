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
 *
 * Issue #14 (P1/P2, v1.112.0) — razširjen urejevalni nabor postaje:
 *  - avgPrepTime (zgodovinsko, nespremenjeno)
 *  - name (1..60; enolično na lokaciji → 409)
 *  - type (slug; 'bar'/'kitchen' = legacy vedri, ostalo = poimenovana postaja)
 *  - sortOrder (zaporedje korakov — zaporedna pot Grill → Sestava → Expo)
 *  - isExpo (izdajna postaja — sestava/izdaja po končani pripravi)
 *  - isActive (deaktivacija brez brisanja — zgodovina nalog ostane)
 * Prav tako DELETE: izbris postaje (skalarne naloge ostanejo kot posnetki,
 * MenuItem.prepStationId se izprazni prek SetNull,MenuItemStation počistimo
 * eksplicitno — skalar brez FK).
 */
const TYPE_RE = /^[a-z0-9_-]{1,30}$/

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Neveljavno telo zahteve.')

  const data: Record<string, unknown> = {}
  if (body.avgPrepTime !== undefined) {
    if (body.avgPrepTime === null) return fail('avgPrepTime mora biti število (minut).')
    const raw = Math.round(Number(body.avgPrepTime))
    if (!Number.isFinite(raw)) return fail('avgPrepTime mora biti število (minut).')
    // clamp 1..60 — 0/negative targets would classify everything late; >60 min is not a prep target
    data.avgPrepTime = Math.min(60, Math.max(1, raw))
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return fail('Ime postaje mora biti besedilo.')
    const name = body.name.trim().slice(0, 60)
    if (!name) return fail('Ime postaje je obvezno (1–60 znakov).')
    data.name = name
  }
  if (body.type !== undefined) {
    if (typeof body.type !== 'string') return fail('Tip postaje mora biti besedilo.')
    const type = body.type.trim().toLowerCase()
    if (!TYPE_RE.test(type)) return fail('Tip postaje: male črke/številke/-/_ (največ 30).')
    data.type = type
  }
  if (body.sortOrder !== undefined) {
    const raw = Math.round(Number(body.sortOrder))
    if (!Number.isFinite(raw)) return fail('sortOrder mora biti število.')
    data.sortOrder = Math.min(999, Math.max(0, raw))
  }
  if (body.isExpo !== undefined) data.isExpo = body.isExpo === true
  if (body.isActive !== undefined) data.isActive = body.isActive === true
  if (Object.keys(data).length === 0) return fail('Ni sprememb (avgPrepTime, name, type, sortOrder, isExpo, isActive).')

  const existing = await db.prepStation.findUnique({ where: { id }, select: { name: true, locationId: true } })
  if (!existing) return fail('Postaja ne obstaja.', 404)
  const locRes = await guardResource(user, existing.locationId)
  if (locRes) return locRes
  // enoličnost imena na lokaciji (izvzemajoč sebe)
  if (typeof data.name === 'string' && data.name !== existing.name) {
    const dupe = await db.prepStation.findFirst({ where: { locationId: existing.locationId, name: data.name, NOT: { id } }, select: { id: true } })
    if (dupe) return fail('Postaja s tem imenom že obstaja na tej lokaciji.', 409)
  }

  const station = await db.prepStation.update({
    where: { id },
    data,
    select: { id: true, name: true, type: true, avgPrepTime: true, sortOrder: true, isExpo: true, isActive: true },
  })
  await writeAudit(db, { userId: user.sub, action: 'PREP_STATION_UPDATED', entityType: 'PrepStation', entityId: id, details: jstr({ changed: Object.keys(data), name: station.name, ...data }), locationId: existing.locationId })
  return ok({ station })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const existing = await db.prepStation.findUnique({ where: { id }, select: { name: true, locationId: true, type: true } })
  if (!existing) return fail('Postaja ne obstaja.', 404)
  const locRes = await guardResource(user, existing.locationId)
  if (locRes) return locRes

  // aktivne naloge te postaje → zavrnjaj (delo v teku ne sme izgubiti postaje)
  try {
    const activeTasks = await db.stationTask.count({ where: { stationId: id, status: { in: ['waiting', 'pending', 'preparing'] } } })
    if (activeTasks > 0) return fail('Postaja ima aktivne naloge — najprej jih zaključi ali deaktiviraj postajo.', 409)
  } catch {
    // DDL pending (StationTask še ne obstaja) → brez nalog, nadaljuj
  }

  await db.$transaction(async (tx) => {
    // skalarne vezave: eksplicitno počistimo usmeritve artiklov (M:N);
    // MenuItem.prepStationId se izprazni prek FK SetNull samodejno
    await tx.menuItemStation.deleteMany({ where: { stationId: id } }).catch(() => undefined)
    await tx.modifier.updateMany({ where: { prepStationId: id }, data: { prepStationId: null } }).catch(() => undefined)
    await tx.prepStation.delete({ where: { id } })
    await writeAudit(tx, { userId: user.sub, action: 'PREP_STATION_DELETE', entityType: 'PrepStation', entityId: id, details: jstr({ name: existing.name, type: existing.type }), locationId: existing.locationId })
  })
  return ok({ deleted: true })
}
