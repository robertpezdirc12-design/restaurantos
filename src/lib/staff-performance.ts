/**
 * v1.233.0 (PRIMERJAVA-VMESNIKOV-2026 §11 — sveža raziskava oktober 2026;
 * Lightspeed november 2025 »staff performance insights« / Toast »server
 * scorecards«): ČISTA agregacija prodaje po natakarju iz PLAČANIH naročil.
 *
 * Konvencija cron-daily/kds-courses (0 odvisnosti, 0 DDL): vhod so vzorci
 * (employeeId, employeeName, total, tip), izhod pa vrstice po natakarju +
 * skupki. Poraba: src/app/api/reports/staff-performance/route.ts (poročilo
 * reports.sales) → StaffPerformanceCard v Analitiki. Brez stranskih
 * učinkov — testabilno brez baze.
 */

export interface StaffPerfSample {
  employeeId: string | null
  employeeName: string | null
  /** Order.total (z DDV) plačanega naročila */
  total: number
  /** Order.tip plačanega naročila */
  tip: number
}

export interface StaffPerfRow {
  employeeId: string | null
  /** prikazno ime (prvo znano); prazno = brez natakarja — klient odkodira */
  name: string
  orders: number
  revenue: number
  avgTicket: number
  tips: number
  /** delež prihodka (0–1) glede na skupni prihodek vzorcev */
  share: number
}

export interface StaffPerfTotals {
  orders: number
  revenue: number
  tips: number
  avgTicket: number
}

export interface StaffPerfResult {
  rows: StaffPerfRow[]
  totals: StaffPerfTotals
}

/**
 * Agregacija po natakarju: vrstice padajoče po prihodku (primer: dva natakarja
 * z enakim prihodkom po številu naročil — stabilno sortiranje). Ime nosi PRVI
 * znan vzorec (kasnejši null ne povozi znanega imena); naročila brez natakarja
 * (employeeId null — QR/kiosk/delivery) ostanejo v LASTNI vrstici — iskreno,
 * ne tiho zlita v skupno.
 */
export function aggregateStaffPerformance(samples: StaffPerfSample[]): StaffPerfResult {
  const byEmp = new Map<string | null, { name: string | null; orders: number; revenue: number; tips: number }>()
  let totalRevenue = 0
  for (const s of samples) {
    const agg = byEmp.get(s.employeeId) ?? { name: null, orders: 0, revenue: 0, tips: 0 }
    agg.orders += 1
    agg.revenue += s.total
    agg.tips += s.tip
    if (!agg.name && s.employeeName?.trim()) agg.name = s.employeeName
    byEmp.set(s.employeeId, agg)
    totalRevenue += s.total
  }
  const rows: StaffPerfRow[] = [...byEmp.entries()]
    .map(([employeeId, v]) => ({
      employeeId,
      name: v.name?.trim() ?? '',
      orders: v.orders,
      revenue: v.revenue,
      avgTicket: v.orders > 0 ? v.revenue / v.orders : 0,
      tips: v.tips,
      share: totalRevenue > 0 ? v.revenue / totalRevenue : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders || a.name.localeCompare(b.name, 'sl'))
  const orders = rows.reduce((s, r) => s + r.orders, 0)
  const revenue = rows.reduce((s, r) => s + r.revenue, 0)
  const tips = rows.reduce((s, r) => s + r.tips, 0)
  return { rows, totals: { orders, revenue, tips, avgTicket: orders > 0 ? revenue / orders : 0 } }
}
