import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, assertResourceLocation, locationScope, requireUserLocation } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import {
  WAITLIST_ACTIVE_STATUSES,
  actualWaitMinutes,
  canTransition,
  isTerminalWaitlistStatus,
  validateEntryInput,
  waitlistStats,
} from '@/lib/waitlist'

/**
 * Čakalna lista (GitLab issue #1, triage ⑤).
 *
 * GET    — aktivni seznam (waiting/notified, FIFO po prijavi) + zaključeni + statistika
 * POST   — nova prijava gosta (status 'waiting')
 * PATCH  — prehodi stanj (notified/seated/left) + urejanje aktivnega vnosa; usaditev zaklene mizo
 * DELETE — brisanje le še aktivnega vnosa (pomota pri vnosu; usajenih ni mogoče brisati)
 */

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') ?? 1) || 1))
  const since = new Date(Date.now() - days * 86400_000)

  const rows = await db.waitlistEntry.findMany({
    where: { checkedInAt: { gte: since }, ...locationScope(user) },
    orderBy: { checkedInAt: 'desc' },
    take: 300,
    include: { Table: { select: { number: true, area: true } } },
  })

  const mapRow = (r: (typeof rows)[number]) => ({
    id: r.id,
    guestName: r.guestName,
    guestPhone: r.guestPhone,
    partySize: r.partySize,
    quotedWaitMinutes: r.quotedWaitMinutes,
    actualWaitMinutes: r.actualWaitMinutes,
    preferredArea: r.preferredArea,
    specialNeeds: r.specialNeeds,
    notes: r.notes,
    status: r.status,
    checkedInAt: r.checkedInAt,
    notifiedAt: r.notifiedAt,
    seatedAt: r.seatedAt,
    leftAt: r.leftAt,
    tableId: r.tableId,
    tableNumber: r.Table?.number ?? null,
    locationId: r.locationId,
  })

  const active = rows
    .filter((r) => (WAITLIST_ACTIVE_STATUSES as readonly string[]).includes(r.status))
    .sort((a, b) => +new Date(a.checkedInAt) - +new Date(b.checkedInAt)) // FIFO
    .map(mapRow)
  const finished = rows.filter((r) => isTerminalWaitlistStatus(r.status)).map(mapRow)

  return ok({
    active,
    finished,
    stats: waitlistStats(rows.map((r) => ({ status: r.status, partySize: r.partySize, actualWaitMinutes: r.actualWaitMinutes }))),
    days,
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const v = validateEntryInput({
    guestName: body?.guestName,
    guestPhone: body?.guestPhone,
    partySize: body?.partySize,
    quotedWaitMinutes: body?.quotedWaitMinutes,
    preferredArea: body?.preferredArea,
    specialNeeds: body?.specialNeeds,
    notes: body?.notes,
  })
  if (!v.ok) return fail(v.error, 400)

  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId

  const row = await db.waitlistEntry.create({
    data: {
      id: nid(),
      guestName: v.value.guestName,
      guestPhone: v.value.guestPhone,
      partySize: v.value.partySize,
      quotedWaitMinutes: v.value.quotedWaitMinutes,
      preferredArea: v.value.preferredArea,
      specialNeeds: v.value.specialNeeds,
      notes: v.value.notes,
      status: 'waiting',
      checkedInAt: new Date(),
      employeeId: user.sub,
      locationId,
    },
  })

  await db.auditLog.create({
    data: { id: nid(), userId: user.sub, action: 'WAITLIST_ADD', entityType: 'WaitlistEntry', entityId: row.id, details: jstr({ guestName: row.guestName, partySize: row.partySize, quotedWaitMinutes: row.quotedWaitMinutes, locationId }), locationId },
  })
  await publishEvent('ReservationCreated', {
    entityType: 'WaitlistEntry',
    entityId: row.id,
    payload: { guestName: row.guestName, partySize: row.partySize, kind: 'waitlist', by: user.name },
  }).catch(() => undefined)

  return ok({ entry: { id: row.id, guestName: row.guestName, status: row.status, checkedInAt: row.checkedInAt } }, 201)
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)
  const id = String(body?.id || '')
  if (!id) return fail('ID vnosa je obvezen.', 400)

  const rec = await db.waitlistEntry.findUnique({ where: { id } })
  if (!rec) return fail('Vnos ne obstaja.', 404)
  const locRes = assertResourceLocation(user, rec.locationId)
  if (locRes) return locRes

  const to = body?.status !== undefined && body?.status !== null && String(body.status) !== '' ? String(body.status).toLowerCase() : null

  // ── Urejanje aktivnega vnosa (brez prehoda) ──
  if (!to) {
    if (isTerminalWaitlistStatus(rec.status)) return fail(`Vnos je že zaključen (${rec.status}) — urejanje ni mogoče.`, 409)
    const data: Record<string, unknown> = {}
    if (body?.guestPhone !== undefined) data.guestPhone = String(body.guestPhone || '').trim().slice(0, 40)
    if (body?.preferredArea !== undefined) data.preferredArea = String(body.preferredArea || '').trim().slice(0, 60)
    if (body?.specialNeeds !== undefined) data.specialNeeds = String(body.specialNeeds || '').trim().slice(0, 300)
    if (body?.notes !== undefined) data.notes = String(body.notes || '').trim().slice(0, 300)
    if (body?.quotedWaitMinutes !== undefined) {
      const q = Math.round(Number(body.quotedWaitMinutes))
      if (!Number.isFinite(q) || q < 0 || q > 600) return fail('Napovedani čas mora biti med 0 in 600 minutami.', 400)
      data.quotedWaitMinutes = q
    }
    if (Object.keys(data).length === 0) return fail('Ni podatkov za posodobitev.', 400)
    const updated = await db.waitlistEntry.update({ where: { id }, data })
    await db.auditLog.create({
      data: { id: nid(), userId: user.sub, action: 'WAITLIST_UPDATE', entityType: 'WaitlistEntry', entityId: id, details: jstr({ guestName: rec.guestName, ...data }), locationId: rec.locationId },
    })
    return ok({ entry: { id: updated.id, status: updated.status, quotedWaitMinutes: updated.quotedWaitMinutes } })
  }

  // ── Prehod stanja ──
  if (!canTransition(rec.status, to)) {
    const err = rec.status === to
      ? `Vnos je že v stanju ${rec.status}.`
      : `Prehod ${rec.status} → ${to} ni dovoljen.`
    return fail(err, 409)
  }

  const now = new Date()
  const data: Record<string, unknown> = { status: to }

  if (to === 'notified') {
    data.notifiedAt = now
  } else if (to === 'seated') {
    data.seatedAt = now
    data.actualWaitMinutes = actualWaitMinutes(rec.checkedInAt, now)
    if (body?.tableId) {
      const tableId = String(body.tableId)
      const table = await db.table.findUnique({ where: { id: tableId }, select: { id: true, number: true, locationId: true, status: true } })
      if (!table) return fail('Miza ne obstaja.', 404)
      if (rec.locationId && table.locationId !== rec.locationId) return fail('Miza ne pripada lokaciji vnosa.', 400)
      if (table.status === 'occupied') return fail(`Miza ${table.number} je že zasedena — izberi drugo mizo.`, 409)
      data.tableId = tableId
    }
  } else if (to === 'left') {
    data.leftAt = now
  }

  try {
    const updated = await db.$transaction(async (tx) => {
      // Usaditev: miza zaklenjena v isti transakciji (pogojno — samo če ni vmes zasedena)
      if (data.tableId) {
        const lock = await tx.table.updateMany({
          where: { id: String(data.tableId), status: { not: 'occupied' } },
          data: { status: 'occupied' },
        })
        if (lock.count === 0) return null
      }
      return tx.waitlistEntry.update({ where: { id }, data })
    })
    if (!updated) return fail('Miza je bila vmes zasedena — osveži in poskusi znova.', 409)

    const auditAction = to === 'seated' ? 'WAITLIST_SEAT' : to === 'left' ? 'WAITLIST_LEFT' : 'WAITLIST_NOTIFY'
    await db.auditLog.create({
      data: {
        id: nid(), userId: user.sub, action: auditAction, entityType: 'WaitlistEntry', entityId: id,
        details: jstr({
          guestName: rec.guestName, partySize: rec.partySize, status: to,
          tableId: data.tableId ?? null, actualWaitMinutes: data.actualWaitMinutes ?? null,
        }),
        locationId: rec.locationId,
      },
    })
    if (to === 'seated') {
      await publishEvent('ReservationSeated', {
        entityType: 'WaitlistEntry',
        entityId: id,
        payload: { guestName: rec.guestName, partySize: rec.partySize, tableId: data.tableId ?? null, actualWaitMinutes: data.actualWaitMinutes ?? null, by: user.name },
      }).catch(() => undefined)
    }
    return ok({ entry: { id: updated.id, status: updated.status, seatedAt: updated.seatedAt, actualWaitMinutes: updated.actualWaitMinutes, tableId: updated.tableId } })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail(`Prehod ni uspel: ${msg}`, 500)
  }
}

export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'reservations.manage')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const id = String(url.searchParams.get('id') || '')
  if (!id) return fail('ID vnosa je obvezen.', 400)

  const rec = await db.waitlistEntry.findUnique({ where: { id } })
  if (!rec) return fail('Vnos ne obstaja.', 404)
  const locRes = assertResourceLocation(user, rec.locationId)
  if (locRes) return locRes

  if (isTerminalWaitlistStatus(rec.status)) {
    return fail('Zaključenega vnosa (usajen/odhod) ni mogoče brisati — ostane v zgodovini.', 409)
  }

  await db.waitlistEntry.delete({ where: { id } })
  await db.auditLog.create({
    data: { id: nid(), userId: user.sub, action: 'WAITLIST_DELETE', entityType: 'WaitlistEntry', entityId: id, details: jstr({ guestName: rec.guestName, partySize: rec.partySize, status: rec.status }), locationId: rec.locationId },
  })
  return ok({ deleted: id })
}
