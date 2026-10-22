/**
 * v1.166.0 — ZAČASNI demo seed (del `bun run demo`; odstranitev: docs/DEMO-DOSTOP.md §4).
 *
 * Naloži plačana naročila in zaključene delovne vnose za zadnjih 7 dni, da
 * analitiki na Pregledu («Prodaja in delo po urah», «Labor stroški») in kartica
 * «Prihodek danes» nista prazni. Razpored naredi čist načrtovalnik
 * `src/lib/demo-history.ts`; ta datoteka samo bere in piše v bazo.
 *
 * Z piščjo topo bazo: `DATABASE_URL` mora kazet na demo.db — to preveri pred
 * prvim zapisom, da zgodovina nikoli ne pristane v testni `dev.db` (P-10).
 */
import { db } from '../src/lib/db'
import { DEMO_DB_FILENAME } from '../src/lib/demo-runtime'
import { DEMO_HISTORY_DAYS, demoHistoryPlan } from '../src/lib/demo-history'

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!url.includes(DEMO_DB_FILENAME)) {
    throw new Error('[demo] Zgodovina se sme pisati samo v demo bazo (DATABASE_URL mora kazet na prisma/db/demo.db).')
  }

  const since = new Date(Date.now() - DEMO_HISTORY_DAYS * 86_400_000)
  const alreadyPaid = await db.order.count({ where: { paidAt: { gte: since }, paymentStatus: 'paid' } })
  if (alreadyPaid > 0) {
    console.log(`⏭️  Demo zgodovina že naložena (${alreadyPaid} plačanih) — preskok.`)
    return
  }

  const location = await db.location.findFirst({ where: { isActive: true }, select: { id: true, name: true } })
  if (!location) {
    console.log('⏭️  Ni aktivne lokacije — zgodovine ni kaj napisati.')
    return
  }
  const menu = await db.menu.findFirst({
    where: { locationId: location.id, isActive: true },
    include: { Category: { include: { MenuItem: { where: { isAvailable: true }, select: { id: true, name: true, price: true, vatRate: true } } } } },
  })
  const rows = (menu?.Category ?? [])
    .flatMap((c) => c.MenuItem)
    .filter((m) => Number(m.price) > 0)
    .map((m) => ({ id: m.id, name: m.name, price: Number(m.price), vatRate: m.vatRate === null ? null : Number(m.vatRate) }))
  const tables = await db.table.findMany({ where: { locationId: location.id }, select: { id: true }, orderBy: { number: 'asc' } })
  const employees = await db.employee.findMany({ where: { status: 'active' }, select: { id: true, role: true } })
  const startOrderNumber = (await db.order.findFirst({ orderBy: { orderNumber: 'desc' }, select: { orderNumber: true } }))?.orderNumber ?? 41000

  const plan = demoHistoryPlan({
    now: new Date(),
    locationId: location.id,
    startOrderNumber,
    menu: rows,
    tables,
    employees,
  })

  for (const o of plan.orders) {
    await db.order.create({
      data: {
        id: o.id,
        orderNumber: o.orderNumber,
        type: o.type,
        status: o.status,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        orderSource: o.orderSource,
        tableId: o.tableId,
        employeeId: o.employeeId,
        locationId: o.locationId,
        subtotal: o.subtotal,
        tax: o.tax,
        total: o.total,
        totalWithTip: o.total,
        createdAt: o.createdAt,
        updatedAt: o.paidAt,
        firedAt: o.firedAt,
        paidAt: o.paidAt,
        OrderItem: { create: o.items.map(({ id, menuItemId, menuItemName, quantity, price, vatRate, status }) => ({ id, menuItemId, menuItemName, quantity, price, vatRate, status })) },
      },
    })
  }
  for (const e of plan.entries) {
    await db.timeEntry.create({
      data: {
        id: e.id,
        employeeId: e.employeeId,
        locationId: e.locationId,
        clockIn: e.clockIn,
        clockOut: e.clockOut,
        breakMinutes: e.breakMinutes,
        totalMinutes: e.totalMinutes,
        payRate: e.payRate,
        totalPay: e.totalPay,
        type: e.type,
        status: e.status,
      },
    })
  }
  console.log(`✅ Demo zgodovina: ${plan.orders.length} plačanih naročil, ${plan.entries.length} izmen (${location.name})`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => { return (db as unknown as { $disconnect: () => Promise<void> }).$disconnect() })
