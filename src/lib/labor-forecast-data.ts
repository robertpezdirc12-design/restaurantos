/**
 * P1-4 (v1.186.0) — skupni podatkovni loader za napoved dela.
 *
 * STREŽNIŠKI modul (uvozi db) — izključno za API plasti; čista aritmetika je
 * v src/lib/labor-forecast.ts (0 DB uvozov). Namen: obe ruti pokličeta ENAKO
 * nalaganje (ista vrata, isti obseg, isti viri), da izvoz vedno uporablja
 * ISTI obračun kot UI (vzorec labor-coverage-data.ts):
 *  - GET /api/reports/labor-forecast            (JSON za UI)
 *  - GET /api/reports/export?section=labor-forecast (CSV/JSON)
 *
 * Viri (isti konvenciji kot labor-cost / labor-coverage loaderji):
 *  - plačani Orderi: net = subtotal − discount (brez DDV), po dnevih × urah
 *    (paidAt je vir ure — lokalni koledar strežnika, dayKeyOf konvencija);
 *  - TimeEntry: zaprti vnosi (totalMinutes/totalPay) + odprti z live-minutes
 *    konvencijo (timeclock.ts) → tehtana urna postavka Σpay/Σmin×60; brez
 *    žigosanja → fallback 12 €/h (NIČ delitve z nič);
 *  - StaffShift: statusi SHIFT_FORECAST_STATUSES, horizont od jutri naprej;
 *    startTime/endTime so 'HH:MM' stringi (parseHMToMinutes), konec ≤ začetek
 *    pomeni prehod čez polnoč (+24 h — shiftDurationMinutes vzorec).
 */

import { db } from '@/lib/db'
import { locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import { dayKeyOf } from '@/lib/sales-by-hour'
import { liveMinutes, totalPayCents } from '@/lib/timeclock'
import { SHIFT_FORECAST_STATUSES } from '@/lib/labor-coverage'
import {
  addDaysISO, dowOfISO, parseHMToMinutes,
  type ForecastHistoryDay, type ScheduledShiftSample,
} from '@/lib/labor-forecast'
import type { AuthPayload } from '@/lib/auth'

/** Fallback urne postavke (centi/h) — ko v oknu ni niti ene minute žigosanja. */
export const LF_FALLBACK_WAGE_CENTS_PER_HOUR = 1200 // 12 €/h

export interface LaborForecastInputs {
  history: ForecastHistoryDay[]
  scheduled: ScheduledShiftSample[]
  wage: { centsPerHour: number; source: 'timeclock' | 'fallback' }
  counts: { orders: number; entries: number; shifts: number }
}

export async function loadLaborForecastInputs(
  user: AuthPayload,
  historyDays: number,
  horizonDays: number,
): Promise<LaborForecastInputs> {
  const now = new Date()
  const since = new Date(now.getTime() - historyDays * 24 * 60 * 60 * 1000)
  const locScope = await locationScope(user)

  const [paidOrders, entries, shifts] = await Promise.all([
    db.order.findMany({
      where: { paidAt: { gte: since }, paymentStatus: 'paid', ...locScope },
      select: { paidAt: true, subtotal: true, discount: true },
      take: 50000,
    }),
    db.timeEntry.findMany({
      where: { clockIn: { gte: since }, ...locScope },
      select: {
        clockIn: true, clockOut: true, breakMinutes: true,
        totalMinutes: true, totalPay: true, payRate: true,
      },
      take: 50000,
    }),
    db.staffShift.findMany({
      where: {
        shiftDate: {
          gte: new Date(`${addDaysISO(dayKeyOf(now), 1)}T00:00:00.000Z`),
          lte: new Date(`${addDaysISO(dayKeyOf(now), Math.max(1, horizonDays))}T23:59:59.999Z`),
        },
        status: { in: [...SHIFT_FORECAST_STATUSES] },
        ...locScope,
      },
      select: { shiftDate: true, startTime: true, endTime: true, breakMinutes: true, role: true },
      take: 10000,
    }),
  ])

  // 1) Zgodovina: neto centi po dnevih × urah (stornacije/0 brez pomena).
  const dayMap = new Map<string, { netCents: number; hours: number[] }>()
  for (const o of paidOrders) {
    const paidAt = o.paidAt
    if (!paidAt) continue
    const netCents = Math.round((num(o.subtotal) - num(o.discount)) * 100)
    if (!Number.isFinite(netCents) || netCents <= 0) continue
    const key = dayKeyOf(paidAt)
    const rec = dayMap.get(key) ?? { netCents: 0, hours: new Array<number>(24).fill(0) }
    rec.netCents += netCents
    rec.hours[paidAt.getHours()] += netCents
    dayMap.set(key, rec)
  }
  const history: ForecastHistoryDay[] = [...dayMap.entries()].map(([date, rec]) => ({
    date,
    dow: dowOfISO(date),
    netSalesCents: rec.netCents,
    hourRevenueCents: rec.hours.map((h) => Math.round(h)),
  }))

  // 2) Tehtana urna postavka (Σpay / Σmin × 60; live-minutes za odprte).
  let payCents = 0
  let minutes = 0
  for (const e of entries) {
    let m: number
    let pay: number
    if (e.clockOut) {
      m = e.totalMinutes
      pay = num(e.totalPay)
    } else {
      m = liveMinutes(e.clockIn.getTime(), now.getTime(), e.breakMinutes)
      pay = m > 0 ? num(totalPayCents(m, Math.round(num(e.payRate) * 100))) / 100 : 0
    }
    if (m > 0) {
      minutes += m
      payCents += Math.round(pay * 100)
    }
  }
  const wage = minutes > 0
    ? { centsPerHour: Math.max(100, Math.round((payCents / minutes) * 60)), source: 'timeclock' as const }
    : { centsPerHour: LF_FALLBACK_WAGE_CENTS_PER_HOUR, source: 'fallback' as const }

  // 3) Načrtovane izmene horizonta → vzorci čistega sloja.
  const scheduled: ScheduledShiftSample[] = shifts.map((s) => {
    const startMinute = parseHMToMinutes(s.startTime) ?? 0
    let endMinute = parseHMToMinutes(s.endTime) ?? startMinute
    if (endMinute <= startMinute) endMinute += 24 * 60
    return {
      date: dayKeyOf(s.shiftDate),
      startMinute,
      endMinute,
      breakMinutes: Math.max(0, s.breakMinutes || 0),
      role: s.role || 'staff',
    }
  })

  return {
    history,
    scheduled,
    wage,
    counts: { orders: paidOrders.length, entries: entries.length, shifts: shifts.length },
  }
}
