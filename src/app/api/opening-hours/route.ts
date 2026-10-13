import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import {
  validateOpeningHoursRows,
  currentStatus,
  upcomingSpecialDays,
  slovenianHolidays,
  type SpecialDay,
} from '@/lib/openinghours'

/**
 * Odpiralni čas restavracije (GitLab issue #1, triage ⑦).
 *
 * GET  — tedenske vrstice (lokacijske ali org privzete) + posebni dnevi (okno -1…+60 dni)
 *        + izračunan trenutni status (odprto/zaprto/odmor/poseben dan) + slovenski prazniki
 *        tekoče leto (predlogi za UI). requireAuth — status koristni vsem zaposlenim.
 * PUT  — shranjevanje vseh 7 tedenskih vrstic (upsert po @@unique([locationId, dayOfWeek])).
 *        Pravica: settings.manage. Audit: OPENING_HOURS_UPDATE (before/after).
 */

/** Tedenske vrstice za lokacijo; če lokacija nima svojih, org privzete (locationId null).
 *  Delni niz (< 7 vrstic) se normalizira: manjkajoči dnevi = izrecno zaprto (id ''),
 *  da urejevalnik in status prikazujeta resnico, ne privzetih 08:00–22:00. */
async function weeklyRows(locationId: string): Promise<{ rows: (OpeningRow & { id: string })[]; inherited: boolean }> {
  let rows = await db.openingHours.findMany({ where: { locationId }, orderBy: { dayOfWeek: 'asc' } })
  let inherited = false
  if (rows.length === 0) {
    rows = await db.openingHours.findMany({ where: { locationId: null }, orderBy: { dayOfWeek: 'asc' } })
    inherited = rows.length > 0
  }
  if (rows.length > 0 && rows.length < 7) {
    const have = new Set(rows.map((r) => r.dayOfWeek))
    for (let dow = 0; dow < 7; dow++) {
      if (!have.has(dow)) {
        rows.push({ id: '', dayOfWeek: dow, openTime: '', closeTime: '', breakStart: '', breakEnd: '', isClosed: true, locationId, createdAt: new Date(), updatedAt: new Date() } as (typeof rows)[number])
      }
    }
    rows.sort((a, b) => a.dayOfWeek - b.dayOfWeek)
  }
  return {
    rows: rows.map((r) => ({
      id: r.id, dayOfWeek: r.dayOfWeek, openTime: r.openTime, closeTime: r.closeTime,
      breakStart: r.breakStart, breakEnd: r.breakEnd, isClosed: r.isClosed,
    })),
    inherited,
  }
}

import type { OpeningRow } from '@/lib/openinghours'
import { writeAudit } from '@/lib/audit-chain'

interface SpecialDayRow extends SpecialDay { id: string; locationId: string | null }

/** Posebni dnevi; lokacijski vnos prevlada nad org vnosom (locationId null) za isti datum. */
async function specialDays(locationId: string | undefined): Promise<SpecialDayRow[]> {
  const where = locationId ? { OR: [{ locationId }, { locationId: null }] } : { locationId: null }
  const rows = await db.specialOpeningDay.findMany({ where, orderBy: { date: 'asc' } })
  const byDate = new Map<string, SpecialDayRow>()
  for (const r of rows) {
    const prev = byDate.get(r.date)
    if (!prev || (prev.locationId === null && r.locationId !== null)) {
      byDate.set(r.date, {
        id: r.id, locationId: r.locationId, date: r.date, isClosed: r.isClosed,
        openTime: r.openTime, closeTime: r.closeTime, note: r.note,
      })
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** SpecialDayRow vsebuje vse polja SpecialDay (+id/locationId) — za izračun statusa se podaja neposredno. */
function toPlainSpecials(rows: SpecialDayRow[]): SpecialDay[] {
  return rows
}

function computeStatus(rows: (OpeningRow & { id: string })[], specials: SpecialDay[]) {
  const src = rows.length > 0
    ? rows
    : Array.from({ length: 7 }, (_, dayOfWeek) => ({ id: 'default', dayOfWeek, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false }))
  const v = validateOpeningHoursRows(src)
  return currentStatus(v.ok ? v.rows : [], specials)
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const locRes = requireUserLocation(user, url.searchParams.get('locationId') ?? undefined)
  if (isResponse(locRes)) return locRes
  const orgGuard = await assertOrgScope(user, locRes)
  if (orgGuard) return orgGuard

  const [{ rows: weekly, inherited }, specialsRaw] = await Promise.all([
    weeklyRows(locRes),
    // locRes = efektivna lokacija (requireUserLocation) — prikaži lokacijske + org vnose
    specialDays(locRes),
  ])

  const year = new Date().getFullYear()
  return ok({
    locationId: locRes,
    inherited,
    rows: weekly,
    specialDays: upcomingSpecialDays(toPlainSpecials(specialsRaw), new Date(), 60),
    status: computeStatus(weekly, toPlainSpecials(specialsRaw)),
    holidays: slovenianHolidays(year),
    holidaysYear: year,
  })
}

export async function PUT(req: NextRequest) {
  const perm = await requirePermission(req, 'settings.manage')
  if (isResponse(perm)) return perm
  const body = await req.json().catch(() => null)
  if (!Array.isArray(body?.rows)) return fail('Manjkajo vrstice odpiralnega časa.', 400)
  const locRes = requireUserLocation(perm, body?.locationId)
  if (isResponse(locRes)) return locRes
  const orgGuard = await assertOrgScope(perm, locRes)
  if (orgGuard) return orgGuard

  const v = validateOpeningHoursRows(body.rows)
  if (!v.ok) return fail(v.error, 400)

  const before = (await weeklyRows(locRes)).rows

  for (const r of v.rows) {
    await db.openingHours.upsert({
      where: { locationId_dayOfWeek: { locationId: locRes, dayOfWeek: r.dayOfWeek } },
      create: {
        id: nid(), locationId: locRes, dayOfWeek: r.dayOfWeek,
        openTime: r.openTime, closeTime: r.closeTime,
        breakStart: r.breakStart, breakEnd: r.breakEnd, isClosed: r.isClosed,
      },
      update: {
        openTime: r.openTime, closeTime: r.closeTime,
        breakStart: r.breakStart, breakEnd: r.breakEnd, isClosed: r.isClosed,
      },
    })
  }

  const after = (await weeklyRows(locRes)).rows
  await writeAudit(db, { userId: perm.sub, action: 'OPENING_HOURS_UPDATE', entityType: 'OpeningHours', entityId: locRes, details: jstr({ locationId: locRes, before, after }) }).catch(() => {})

  const specialsRaw = await specialDays(locRes)
  return ok({ rows: after, status: computeStatus(after, toPlainSpecials(specialsRaw)) }, 200)
}
