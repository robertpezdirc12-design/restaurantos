import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { payrollTablesReady } from '@/lib/payroll-schema'
import { localDateKey, periodDto, periodBounds, validatePeriodRange } from '@/lib/payroll'

/**
 * Issue #22 (P2, v1.115.0) — obračunska obdobja (zgornji nivo obstoječe evidence).
 *
 * GET /api/payroll
 *   → seznam obdobj v obsegu uporabnika (locationScope — manager = lastna
 *     lokacija, centralne vloge = org allow-lista), najnovejših 100, z
 *     številom izvozov (PayrollExport nima Prisma relacije — skalar periodId —
 *     zato groupBy po periodId). Pravica: employees.manage (plačni pogled).
 *
 * POST /api/payroll  { locationId?, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
 *   → novo DRAFT obdobje. Lokacija: requireUserLocation (non-central = lastna,
 *     centralna podaja locationId) + guardResource (org meja — tujega
 *     obdobja ne moremo odpreti). Validacija: validatePeriodRange (≤ 62 dni,
 *     konec v preteklosti) po Location.timezone. Prekrivanje (draft ALI
 *     zaključeno — OBA blokirata) → 409; TX z ANCHOR zapisom na vrstici
 *     LOKACIJE (vzorec #63 tips) + FRESH re-check znotraj TX + audit.
 *
 * PRE-DDL: probe payrollTablesReady → 503 (graceful — evidence časa nedotaknjena,
 * dokler produkcija ne aplicira /api/admin/migrate-payroll-periods).
 */

/** #63-vzorec: tekmovalno (sočasno) ustvarjanje istega obsega — 409, brez duplikata. */
class PeriodOverlapError extends Error {
  constructor() {
    super('Obračunsko obdobje se prekriva z že obstoječim obdobjem.')
  }
}

/** #63-vzorec: ciljna lokacija med TX izginila (anchor P2025) → 404. */
class LocationMissingError extends Error {
  constructor() {
    super('Lokacija ne obstaja.')
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await payrollTablesReady())) {
    return fail('Obračunsko obdobje čaka na shemsko migracijo (Enterprise → Shema migracije → payroll-periods).', 503)
  }

  const locScope = await locationScope(user)
  const periods = await db.payrollPeriod.findMany({
    where: locScope,
    orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
    take: 100,
  })

  // PayrollExport ↔ PayrollPeriod NIMA Prisma relacije (skalar periodId,
  // vzorec PrepLabel/PrintJob) — števci izvozov ločeno, po periodId.
  const periodIds = periods.map((p) => p.id)
  const exportAgg = periodIds.length
    ? await db.payrollExport.groupBy({
        by: ['periodId'],
        where: { periodId: { in: periodIds } },
        _count: { _all: true },
        _max: { exportedAt: true },
      })
    : []
  const exportsBy = new Map(exportAgg.map((g) => [g.periodId, { count: g._count._all, last: g._max.exportedAt ?? null }]))

  return ok({
    periods: periods.map((p) => {
      const agg = exportsBy.get(p.id)
      return { ...periodDto(p), exportCount: agg?.count ?? 0, lastExportAt: agg?.last ? agg.last.toISOString() : null }
    }),
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await payrollTablesReady())) {
    return fail('Obračunsko obdobje čaka na shemsko migracijo (Enterprise → Shema migracije → payroll-periods).', 503)
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Neveljavno telo zahtevka.', 400)

  // Lokacija: non-central VEDNO lastna (fail-closed), centralna podaja
  // locationId (ali pade na svojo). requireUserLocation vrača string ali 4xx.
  const locOrErr = requireUserLocation(user, body.locationId)
  if (typeof locOrErr !== 'string') return locOrErr
  const locationId = locOrErr

  const location = await db.location.findUnique({
    where: { id: locationId },
    select: { id: true, name: true, timezone: true },
  })
  if (!location) return fail('Lokacija ne obstaja.', 404)
  // org meja za centralne vloge (issue #5 §B): lokacija tuje org → 403
  const guard = await guardResource(user, location.id)
  if (guard) return guard

  const startISO = typeof body.start === 'string' ? body.start.trim() : ''
  const endISO = typeof body.end === 'string' ? body.end.trim() : ''
  const tz = location.timezone || 'Europe/Ljubljana'

  // danes po LOKALNI coni lokacije (konec obdobja ne sme biti v prihodnosti)
  const todayKey = localDateKey(new Date(), tz)
  const validated = validatePeriodRange(startISO, endISO, todayKey)
  if (!validated.ok) return fail(validated.error, 400)

  const { start: periodStart, end: periodEnd } = periodBounds(startISO, endISO, tz)

  // hitra preverba (UX) — avtoritativna je FRESH re-check znotraj TX
  const overlapFast = await db.payrollPeriod.findFirst({
    where: {
      locationId,
      // draft ALI closed — OBA blokirata novo obdobje (prekrivanje plačne osnove)
      periodStart: { lt: periodEnd },
      periodEnd: { gt: periodStart },
    },
    select: { id: true },
  })
  if (overlapFast) return fail('Obračunsko obdobje se prekriva z že obstoječim obdobjem.', 409)

  const id = nid()
  try {
    const created = await db.$transaction(async (tx) => {
      // ANCHOR zapis na vrstici LOKACIJE (vzorec #63): SQLite pridabi izključni
      // pisljivi zaklep, PostgreSQL vrstični zaklep — serializira sočasna
      // ustvarjanja obdobij ZA ISTO LOKACIJO.
      const anchor = await tx.location.updateMany({ where: { id: locationId }, data: { updatedAt: new Date() } })
      if (anchor.count === 0) throw new LocationMissingError()
      // FRESH re-check ZNOTRAJ TX — zahtevek, sprožen pred tekmečevim commitom,
      // zdaj vidi njegovo obdobje in se ustavi (rollback, brez duplikata).
      const dupe = await tx.payrollPeriod.findFirst({
        where: { locationId, periodStart: { lt: periodEnd }, periodEnd: { gt: periodStart } },
        select: { id: true },
      })
      if (dupe) throw new PeriodOverlapError()
      const period = await tx.payrollPeriod.create({
        data: { id, locationId, periodStart, periodEnd, timezone: tz },
      })
      await writeAudit(tx, {
        userId: user.sub,
        action: 'PAYROLL_PERIOD_CREATED',
        entityType: 'PayrollPeriod',
        entityId: id,
        details: jstr({ locationId, start: startISO, end: endISO, timezone: tz }),
        locationId,
      })
      return period
    })
    return ok({ period: periodDto(created) }, 201)
  } catch (e) {
    if (e instanceof PeriodOverlapError) return fail(e.message, 409)
    if (e instanceof LocationMissingError) return fail(e.message, 404)
    throw e
  }
}
