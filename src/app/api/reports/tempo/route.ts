import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import {
  serviceSpansInWindow,
  aggregateTableTempo,
  aggregateServiceGaps,
  type TempoOpeningRow,
  type TempoSpecialDay,
  type TempoTableSample,
  type TempoGapOrder,
  type TempoServiceSpan,
} from '@/lib/tempo-insights'

/** Clamp `days` to 1..90 (default 7) — isti okvir kot sales-by-hour/staff-performance. */
function clampDays(raw: string | null): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 7
  return Math.min(90, Math.max(1, n))
}

/** locScope (stolpec locationId drugih modelov) → where na Location.id
 *  (dovbesedni prevod obsega — isto kot labor-coverage-data). */
function scopeLocationIds(scope: { locationId?: string | { in: string[] } }): { id?: string | { in: string[] } } {
  if (typeof scope.locationId === 'string') return { id: scope.locationId }
  if (scope.locationId && typeof scope.locationId === 'object' && 'in' in scope.locationId) {
    return { id: { in: scope.locationId.in ?? [] } }
  }
  return {} // centralna vloga brez meje = vse lokacije
}

/**
 * GET /api/reports/tempo?days=7
 *
 * v1.250.0 (PRIMERJAVA-VMESNIKOV-2026 §24 — TEMPO INSIGHTS VAL; Lightspeed
 * junij 2026 Tempo »service insights«: »tables with the most empty time and
 * orders with the longest service gaps«): dve merili nad OBSTOJEČIMI
 * podatki (0 DDL, 0 odvisnosti), čista agregacija v src/lib/tempo-insights.
 *
 *  1. MIZE: prazni čas = odprte ure okna (tedenske vrstice + posebni dnevi
 *     lokacije, lokalni pas lokacije, DST-varno; odmik kosila ni odprta ura)
 *     − fizična zasedenost (unija naročil na mizi). Vir naročila: vsa, ki
 *     PRESEKAJO okno [since, now] (plačano po paidAt, odprto še teče,
 *     preklicano do cancelledAt — blokiralo je mizo). Naročila brez mize
 *     (dostava/ponos) v tem delu NE sodelujejo (mize ne zasedejo).
 *  2. LUKNJE: PLAČANA naročila (paidAt >= since — disciplina
 *     staff-performance/sales-by-hour) po metrikah vnos→pošiljanje, prvi
 *     krožnik, celotna strežba (max readyAt), obrat mize.
 *
 * Pravica: reports.sales (ista kot ostala prodajna poročila). Obseg:
 * centralne vloge = cela organizacija, osebje = lastna lokacija.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = clampDays(url.searchParams.get('days'))
  const now = new Date()
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const nowMs = now.getTime()
  const sinceMs = since.getTime()

  const locScope = await locationScope(user)
  const locations = await db.location.findMany({
    where: scopeLocationIds(locScope),
    select: { id: true, name: true, timezone: true },
    take: 500,
  })
  const locById = new Map(locations.map((l) => [l.id, l]))

  /* ——— odpiralne ure: tedenske vrstice + posebni dnevi (prednost lokacije,
   *     isti padec na org vrstice locationId null kot rezervacijski widget) ——— */
  const [weeklyRows, specialRows, tables] = await Promise.all([
    db.openingHours.findMany({
      where: { OR: [{ locationId: { in: locations.map((l) => l.id) } }, { locationId: null }] },
      select: {
        locationId: true, dayOfWeek: true, openTime: true, closeTime: true,
        breakStart: true, breakEnd: true, isClosed: true,
      },
      take: 1000,
    }),
    db.specialOpeningDay.findMany({
      where: { date: { gte: since.toISOString().slice(0, 10), lte: now.toISOString().slice(0, 10) } },
      select: { locationId: true, date: true, isClosed: true, openTime: true, closeTime: true },
      take: 1000,
    }),
    db.table.findMany({
      where: { locationId: { in: locations.map((l) => l.id) } },
      select: { id: true, number: true, locationId: true },
      take: 5000,
    }),
  ])

  /** tedenske vrstice ENE lokacije (lastne; padec na org null-vrstice). */
  const weeklyByLoc = (locId: string): TempoOpeningRow[] => {
    const own = weeklyRows.filter((r) => r.locationId === locId)
    const rows = own.length > 0 ? own : weeklyRows.filter((r) => r.locationId === null)
    return rows.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      openTime: r.openTime,
      closeTime: r.closeTime,
      breakStart: r.breakStart,
      breakEnd: r.breakEnd,
      isClosed: r.isClosed,
    }))
  }
  /** posebni dnevi: lokacija ima prednost pred org null (widget vzorec). */
  const specialsByLoc = (locId: string): TempoSpecialDay[] => {
    const out = new Map<string, TempoSpecialDay & { loc: string | null }>()
    for (const r of specialRows) {
      if (r.locationId !== null && r.locationId !== locId) continue
      const prev = out.get(r.date)
      if (!prev || (prev.loc === null && r.locationId !== null)) {
        out.set(r.date, { date: r.date, isClosed: r.isClosed, openTime: r.openTime, closeTime: r.closeTime, loc: r.locationId })
      }
    }
    return [...out.values()].map(({ loc: _loc, ...s }) => s)
  }

  /* ——— spani odprtih ur po lokaciji (lokalni pas, DST-varno, prirez na okno) ——— */
  const spansByLoc = new Map<string, TempoServiceSpan[]>()
  for (const loc of locations) {
    const tz = loc.timezone || 'Europe/Ljubljana' // prazna cona (garbage) → hišni default (labor-coverage vzorec)
    spansByLoc.set(loc.id, serviceSpansInWindow(weeklyByLoc(loc.id), specialsByLoc(loc.id), tz, sinceMs, nowMs))
  }
  const spansByTable: Record<string, TempoServiceSpan[]> = {}
  for (const t of tables) spansByTable[t.id] = spansByLoc.get(t.locationId) ?? []

  /* ——— naročila, ki presekajo okno (za zasedenost miz) ——— */
  const occupancyOrders = await db.order.findMany({
    where: {
      createdAt: { lte: now },
      OR: [{ paidAt: null }, { paidAt: { gte: since } }],
      tableId: { not: null },
      ...locScope,
    },
    select: {
      id: true, tableId: true, status: true, paymentStatus: true,
      createdAt: true, paidAt: true, cancelledAt: true, total: true,
    },
    take: 50000,
  })
  const tableLabelById = new Map(tables.map((t) => [t.id, `Miza ${t.number}`]))
  const samples: TempoTableSample[] = []
  for (const o of occupancyOrders) {
    if (!o.tableId || !tableLabelById.has(o.tableId)) continue // miza izven obsega (odrasla lokacija) — praznega časa ne moreš meriti
    const cancelled = o.status === 'cancelled'
    const paid = o.paymentStatus === 'paid' && o.paidAt != null
    const endDate = cancelled ? (o.cancelledAt ?? now) : paid ? (o.paidAt as Date) : now
    samples.push({
      tableId: o.tableId,
      start: o.createdAt.getTime(),
      end: endDate.getTime(),
      cancelled,
      paid,
      revenue: paid ? num(o.total) : 0,
    })
  }

  /* ——— plačana naročila (za servisne luknje) + njihove postavke ——— */
  const paidOrders = await db.order.findMany({
    where: { paidAt: { gte: since }, ...locScope },
    select: {
      id: true, orderNumber: true, paidAt: true, createdAt: true,
      tableId: true,
      Employee_Order_employeeIdToEmployee: { select: { name: true } },
    },
    take: 50000,
  })
  const paidIds = paidOrders.map((o) => o.id)
  const items = paidIds.length > 0
    ? await db.orderItem.findMany({
        where: { orderId: { in: paidIds } },
        select: { orderId: true, firedAt: true, readyAt: true, voided: true },
        take: 200000,
      })
    : []
  const itemsByOrder = new Map<string, { firedAt: number | null; readyAt: number | null; voided: boolean }[]>()
  for (const it of items) {
    const row = { firedAt: it.firedAt?.getTime() ?? null, readyAt: it.readyAt?.getTime() ?? null, voided: it.voided }
    const arr = itemsByOrder.get(it.orderId)
    if (arr) arr.push(row)
    else itemsByOrder.set(it.orderId, [row])
  }
  const gapOrders: TempoGapOrder[] = paidOrders.map((o) => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    tableLabel: o.tableId ? tableLabelById.get(o.tableId) ?? null : null,
    waiter: o.Employee_Order_employeeIdToEmployee?.name ?? '',
    createdAt: o.createdAt.getTime(),
    paidAt: o.paidAt ? o.paidAt.getTime() : null,
    items: itemsByOrder.get(o.id) ?? [],
  }))

  const tableRows = aggregateTableTempo(
    tables.map((t) => ({
      tableId: t.id,
      label: `Miza ${t.number}`,
      locationName: locById.get(t.locationId)?.name ?? '',
    })),
    samples,
    spansByTable
  )
  const gaps = aggregateServiceGaps(gapOrders, 10)

  return ok({
    periodDays: days,
    since: since.toISOString(),
    generatedAt: now.toISOString(),
    tables: tableRows,
    gaps,
  })
}
