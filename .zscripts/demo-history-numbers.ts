// v1.288.0: demo-history semena Z ŠTEVILKAMI (čist načrtovalnik, samo branje)
import { db } from '../src/lib/db'
import { DEMO_HISTORY_DAYS, DEMO_PAY_RATE_BY_ROLE, demoHistoryPlan } from '../src/lib/demo-history'
async function main() {
  const location = await db.location.findFirst({ where: { isActive: true }, select: { id: true, name: true } })
  const menu = await db.menu.findFirst({
    where: { locationId: location!.id, isActive: true },
    include: { Category: { include: { MenuItem: { where: { isAvailable: true }, select: { id: true, name: true, price: true, vatRate: true } } } } },
  })
  const rows = (menu?.Category ?? []).flatMap((c) => c.MenuItem).filter((m) => Number(m.price) > 0)
    .map((m) => ({ id: m.id, name: m.name, price: Number(m.price), vatRate: m.vatRate === null ? null : Number(m.vatRate) }))
  const tables = await db.table.findMany({ where: { locationId: location!.id }, select: { id: true }, orderBy: { number: 'asc' } })
  const employees = await db.employee.findMany({ where: { status: 'active' }, select: { id: true, role: true } })
  const startOrderNumber = (await db.order.findFirst({ orderBy: { orderNumber: 'desc' }, select: { orderNumber: true } }))?.orderNumber ?? 41000
  const now = new Date('2026-11-09T18:30:00.000Z')
  const plan = demoHistoryPlan({ now, locationId: location!.id, startOrderNumber, menu: rows, tables, employees })
  const plan2 = demoHistoryPlan({ now, locationId: location!.id, startOrderNumber, menu: rows, tables, employees })
  const items = plan.orders.reduce((s, o) => s + o.items.length, 0)
  const revenue = plan.orders.reduce((s, o) => s + o.total, 0)
  const hours = plan.entries.reduce((s, e) => s + e.totalMinutes / 60, 0)
  const pay = plan.entries.reduce((s, e) => s + e.totalPay, 0)
  const maxBack = Math.max(...plan.orders.map((o) => (now.getTime() - o.paidAt.getTime()) / 86_400_000))
  const future = plan.orders.filter((o) => o.paidAt.getTime() > now.getTime()).length + plan.entries.filter((e) => e.clockOut.getTime() > now.getTime()).length
  const st = JSON.stringify({ o: plan.orders.length, e: plan.entries.length }) === JSON.stringify({ o: plan2.orders.length, e: plan2.entries.length })
  const roles: Record<string, number> = {}
  for (const e of plan.entries) roles[e.type] = (roles[e.type] || 0) + 1
  console.log(`lokacija: ${location!.name}; menu: ${rows.length} artiklov; mize: ${tables.length}; zaposleni: ${employees.length} (${employees.map(e => e.role).join('/')})`)
  console.log(`startOrderNumber: ${startOrderNumber} → ${plan.orders[plan.orders.length-1]?.orderNumber}`)
  console.log(`DEMO_HISTORY_DAYS: ${DEMO_HISTORY_DAYS}; naročila: ${plan.orders.length} (postavk: ${items}); izmene: ${plan.entries.length}`)
  console.log(`promet: ${revenue.toFixed(2)} EUR; ur: ${hours.toFixed(1)}; plača: ${pay.toFixed(2)} EUR`)
  console.log(`okno nazaj (max dni): ${maxBack.toFixed(2)}; v prihodnosti: ${future}; determinizem (2 klica): ${st}`)
  console.log(`tipi izmen: ${JSON.stringify(roles)}; urne postavke: ${JSON.stringify(DEMO_PAY_RATE_BY_ROLE)}`)
  const perDay: Record<string, number> = {}
  for (const o of plan.orders) { const d = o.paidAt.toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1 }
  console.log('naročila po dnevih: ' + JSON.stringify(perDay))
}
main().finally(() => db.$disconnect())
