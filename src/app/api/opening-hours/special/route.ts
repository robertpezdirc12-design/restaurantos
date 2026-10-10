import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { validateSpecialDayInput, isValidDateKey, toLocalDateKey } from '@/lib/openinghours'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Posebni dnevi/prazniki odpiralnega časa (issue #1 triage ⑦).
 *
 * GET    — seznam posebnih dni (lokacija + org, okno -7…+180 dni)
 * POST   — nov poseben dan (@@unique([locationId, date]) → 409 na podvojen datum;
 *          prazniki se dodajo posamezno ali kot predlogi iz slovenskiHolidays)
 * Pravica: settings.manage. Audit: OPENING_HOURS_SPECIAL.
 */

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const locRes = requireUserLocation(user, url.searchParams.get('locationId') ?? undefined)
  if (isResponse(locRes)) return locRes

  const from = toLocalDateKey(new Date(Date.now() - 7 * 86400_000))
  const to = toLocalDateKey(new Date(Date.now() + 180 * 86400_000))
  const rows = await db.specialOpeningDay.findMany({
    where: { date: { gte: from, lte: to }, ...(user.loc ? { locationId: user.loc } : { locationId: locRes }) },
    orderBy: { date: 'asc' },
    take: 200,
  })
  return ok({ specialDays: rows })
}

export async function POST(req: NextRequest) {
  const perm = await requirePermission(req, 'settings.manage')
  if (isResponse(perm)) return perm
  const body = await req.json().catch(() => null)
  const locRes = requireUserLocation(perm, body?.locationId)
  if (isResponse(locRes)) return locRes

  // množični vnos predlogov praznikov: { holidays: [{date, name}] } — obstoječi datumi se preskočijo
  if (Array.isArray(body?.holidays)) {
    let added = 0
    const skipped: string[] = []
    for (const h of body.holidays as { date?: unknown; name?: unknown }[]) {
      const date = String(h?.date ?? '')
      if (!isValidDateKey(date)) continue
      const dup = await db.specialOpeningDay.findUnique({
        where: { locationId_date: { locationId: locRes, date } },
      })
      if (dup) { skipped.push(date); continue }
      await db.specialOpeningDay.create({
        data: { id: nid(), locationId: locRes, date, isClosed: true, openTime: '', closeTime: '', note: String(h?.name ?? 'Praznik').slice(0, 200) },
      })
      added++
    }
    const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'OPENING_HOURS_SPECIAL', entityType: 'SpecialOpeningDay', entityId: locRes, details: jstr({ batch: 'slovenian-holidays', added, skipped: skipped.length, locationId: locRes }), id: __aId2 })
    await db.auditLog.create({
      data: { ...__chain2,
        id: __aId2, userId: perm.sub, action: 'OPENING_HOURS_SPECIAL', entityType: 'SpecialOpeningDay', entityId: locRes,
        details: jstr({ batch: 'slovenian-holidays', added, skipped: skipped.length, locationId: locRes }),
      },
    }).catch(() => {})
    return ok({ added, skipped }, 201)
  }

  const v = validateSpecialDayInput(body ?? {})
  if (!v.ok) return fail(v.error, 400)

  const dup = await db.specialOpeningDay.findUnique({
    where: { locationId_date: { locationId: locRes, date: v.day.date } },
  })
  if (dup) return fail(`Poseben dan za ${v.day.date} že obstaja — uporabi urejanje.`, 409)

  const row = await db.specialOpeningDay.create({
    data: {
      id: nid(), locationId: locRes, date: v.day.date, isClosed: v.day.isClosed,
      openTime: v.day.openTime, closeTime: v.day.closeTime, note: v.day.note,
    },
  })

  const __aId4 = nid(); const __chain4 = await auditChainFields(db, { action: 'OPENING_HOURS_SPECIAL', entityType: 'SpecialOpeningDay', entityId: row.id, details: jstr({ date: row.date, isClosed: row.isClosed, openTime: row.openTime, closeTime: row.closeTime, note: row.note, locationId: locRes }), id: __aId4 })
  await db.auditLog.create({
    data: { ...__chain4,
      id: __aId4, userId: perm.sub, action: 'OPENING_HOURS_SPECIAL', entityType: 'SpecialOpeningDay', entityId: row.id,
      details: jstr({ date: row.date, isClosed: row.isClosed, openTime: row.openTime, closeTime: row.closeTime, note: row.note, locationId: locRes }),
    },
  }).catch(() => {})

  return ok({ specialDay: row }, 201)
}

export async function DELETE(req: NextRequest) {
  const perm = await requirePermission(req, 'settings.manage')
  if (isResponse(perm)) return perm
  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  if (!id) return fail('Manjka id posebnega dne.', 400)

  const row = await db.specialOpeningDay.findUnique({ where: { id } })
  if (!row) return fail('Poseben dan ne obstaja.', 404)
  const locRes = requireUserLocation(perm, row.locationId ?? undefined)
  if (isResponse(locRes)) return locRes
  if (row.locationId && row.locationId !== locRes) return fail('Poseben dan ne pripada tej lokaciji.', 403)

  await db.specialOpeningDay.delete({ where: { id } })
  const __aId6 = nid(); const __chain6 = await auditChainFields(db, { action: 'OPENING_HOURS_SPECIAL', entityType: 'SpecialOpeningDay', entityId: id, details: jstr({ deleted: true, date: row.date, note: row.note, locationId: locRes }), id: __aId6 })
  await db.auditLog.create({
    data: { ...__chain6,
      id: __aId6, userId: perm.sub, action: 'OPENING_HOURS_SPECIAL', entityType: 'SpecialOpeningDay', entityId: id,
      details: jstr({ deleted: true, date: row.date, note: row.note, locationId: locRes }),
    },
  }).catch(() => {})

  return ok({ deleted: true, id })
}

export async function PATCH(req: NextRequest) {
  const perm = await requirePermission(req, 'settings.manage')
  if (isResponse(perm)) return perm
  const body = await req.json().catch(() => null)
  const id = String(body?.id ?? '')
  if (!id) return fail('Manjka id posebnega dne.', 400)

  const row = await db.specialOpeningDay.findUnique({ where: { id } })
  if (!row) return fail('Poseben dan ne obstaja.', 404)
  const locRes = requireUserLocation(perm, row.locationId ?? undefined)
  if (isResponse(locRes)) return locRes
  if (row.locationId && row.locationId !== locRes) return fail('Poseben dan ne pripada tej lokaciji.', 403)

  const v = validateSpecialDayInput({
    date: body?.date ?? row.date,
    isClosed: body?.isClosed ?? row.isClosed,
    openTime: body?.openTime ?? row.openTime,
    closeTime: body?.closeTime ?? row.closeTime,
    note: body?.note ?? row.note,
  })
  if (!v.ok) return fail(v.error, 400)

  if (v.day.date !== row.date) {
    const dup = await db.specialOpeningDay.findUnique({
      where: { locationId_date: { locationId: locRes, date: v.day.date } },
    })
    if (dup) return fail(`Poseben dan za ${v.day.date} že obstaja.`, 409)
  }

  const updated = await db.specialOpeningDay.update({
    where: { id },
    data: {
      date: v.day.date, isClosed: v.day.isClosed,
      openTime: v.day.openTime, closeTime: v.day.closeTime, note: v.day.note,
    },
  })

  const __aId8 = nid(); const __chain8 = await auditChainFields(db, { action: 'OPENING_HOURS_SPECIAL', entityType: 'SpecialOpeningDay', entityId: id, details: jstr({ before: { date: row.date, isClosed: row.isClosed, openTime: row.openTime, closeTime: row.closeTime, note: row.note }, after: { date: updated.date, isClosed: updated.isClosed, openTime: updated.openTime, closeTime: updated.closeTime, note: updated.note } }), id: __aId8 })
  await db.auditLog.create({
    data: { ...__chain8,
      id: __aId8, userId: perm.sub, action: 'OPENING_HOURS_SPECIAL', entityType: 'SpecialOpeningDay', entityId: id,
      details: jstr({ before: { date: row.date, isClosed: row.isClosed, openTime: row.openTime, closeTime: row.closeTime, note: row.note }, after: { date: updated.date, isClosed: updated.isClosed, openTime: updated.openTime, closeTime: updated.closeTime, note: updated.note } }),
    },
  }).catch(() => {})

  return ok({ specialDay: updated })
}
