import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import { aggregateStaffPerformance, type StaffPerfSample } from '@/lib/staff-performance'

/** Clamp `days` to 1..90 (default 7) — isti okvir kot sales-by-hour. */
function clampDays(raw: string | null): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 7
  return Math.min(90, Math.max(1, n))
}

/**
 * GET /api/reports/staff-performance?days=7
 *
 * v1.233.0 (PRIMERJAVA-VMESNIKOV-2026 §11; Lightspeed nov 2025 »staff
 * performance insights«, Toast »server scorecards«): prodaja po natakarju —
 * število naročil, prihodek, povprečno naročilo, napitnine, delež prihodka.
 * Vir: PLAČANA naročila (paidAt != null, paidAt >= since — enaka disciplina
 * kot sales-by-hour), po employeeId z imenom (relation). Lokacijski obseg
 * ogleda: centralne vloge = cela organizacija, osebje = lastna lokacija.
 * Čista agregacija v src/lib/staff-performance.ts (0 DDL, 0 odvisnosti).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = clampDays(url.searchParams.get('days'))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const locScope = await locationScope(user)
  const orders = await db.order.findMany({
    where: { paidAt: { gte: since }, ...locScope },
    select: {
      employeeId: true,
      total: true,
      tip: true,
      Employee_Order_employeeIdToEmployee: { select: { name: true } },
    },
    take: 50000,
  })

  const samples: StaffPerfSample[] = orders.map((o) => ({
    employeeId: o.employeeId,
    employeeName: o.Employee_Order_employeeIdToEmployee?.name ?? null,
    total: num(o.total),
    tip: num(o.tip),
  }))
  const res = aggregateStaffPerformance(samples)
  return ok({
    periodDays: days,
    since: since.toISOString(),
    generatedAt: new Date().toISOString(),
    rows: res.rows,
    totals: res.totals,
  })
}
