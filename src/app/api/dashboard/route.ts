import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isCentralRole, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num, ORDER_ACTIVE_DB } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  // Triage ⑧ — lokacijski preklopnik (pogledi): centralna vloga sme izbrati
  // lokacijo (?locationId=); brez parametra = VSE lokacije (prej: findFirst
  // omejitev je prikazala "danes" samo prve lokacije — nekonsistentno).
  // Non-central je vedno vezan na svojo lokacijo (fail-closed).
  const requested = new URL(req.url).searchParams.get('locationId')?.trim() || ''
  let selectedLocation: string | null = null
  if (requested) {
    if (!isCentralRole(user)) return fail('Samo centralne vloge smejo preklapljati med lokacijami.', 403)
    const loc = await db.location.findUnique({ where: { id: requested }, select: { id: true, name: true } })
    if (!loc) return fail('Lokacija ne obstaja.', 404)
    selectedLocation = loc.id
  }
  const todayLoc = selectedLocation
    ?? (isCentralRole(user) ? null : (user.loc || (await db.location.findFirst())?.id || null))

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const counterScope = selectedLocation ? { locationId: selectedLocation } : await locationScope(user)
  const todayWhere = {
    createdAt: { gte: startOfDay },
    status: { not: 'cancelled' as const },
    ...(todayLoc ? { locationId: todayLoc } : {}),
  }

  // Issue #4 §1: globalni števci se zožijo na lokacijo uporabnika;
  // selectedLocation dodatno zoži tudi centralno vlogo (preklopnik)
  const [activeOrders, openTables, menuCount, employees, todayOrders, paidToday, topItemsRaw] = await Promise.all([
    db.order.count({ where: { status: { in: ORDER_ACTIVE_DB }, ...counterScope } }),
    db.table.count({ where: { status: 'occupied', ...counterScope } }),
    // MenuItem nima locationId (globalen meni prek Menu) — brez scopinga
    db.menuItem.count({ where: { isAvailable: true } }),
    db.employee.count({ where: { status: 'active', ...counterScope } }),
    db.order.findMany({
      where: todayWhere,
      select: { total: true, status: true },
    }),
    db.order.aggregate({
      where: { ...todayWhere, paymentStatus: 'paid', paidAt: { gte: startOfDay } },
      _sum: { total: true },
      _count: true,
    }),
    db.orderItem.groupBy({
      by: ['menuItemName'],
      where: { Order: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) }, status: { not: 'cancelled' }, ...counterScope } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    }),
  ])

  const todayRevenue = todayOrders.reduce((s, o) => s + num(o.total), 0)

  return ok({
    stats: {
      activeOrders,
      openTables,
      menuItems: menuCount,
      employees,
      todayOrders: todayOrders.length,
      todayRevenue,
      paidToday: { count: paidToday._count, total: paidToday._sum.total ? num(paidToday._sum.total) : 0 },
    },
    topItems: topItemsRaw.map((t) => ({ name: t.menuItemName, qty: t._sum.quantity || 0 })),
    // preklopnik (pogledi): odgovor jasno pove, na katero lokacijo se nanaša
    locationScope: selectedLocation ?? null,
    locationName: selectedLocation
      ? (await db.location.findUnique({ where: { id: selectedLocation }, select: { name: true } }))?.name ?? null
      : null,
  })
}
