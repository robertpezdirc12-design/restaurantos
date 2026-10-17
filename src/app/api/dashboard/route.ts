import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, isCentralRole, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num, ORDER_ACTIVE_DB } from '@/lib/map'
import { assertOrgScope } from '@/lib/tenant'

/**
 * Issue #5 (P0 §C + komentar #6): trije popravki —
 *  1. ?locationId centralne vloge: DODAN assertOrgScope (prej je centralna vloga
 *     lahko potegnila žive statistike TUJE organizacije z ugibanjem ID-ja);
 *  2. centralna vloga BREZ izbire: 'danes' agregati tečejo po org allow-listi
 *     (locationScope) — prej BREZ filtra = globalni cross-org promet;
 *  3. non-central BREZ lokacije: fail-closed '__no_location__' (prej findFirst()
 *     fallback na prvo lokacijo v DB = tuj promet).
 * + Issue #5 §C (dashboard): finančni kazalniki (todayRevenue, paidToday) samo za
 *   reports.view; operativni števci (aktivna naročila, mize, danes števec) ostanejo
 *   vsem — stats.financialPerm pove UI-ju, ali sme kartice sploh pokazati.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const user = ctx.user
  const showFinancial = ctx.perms.includes('reports.sales')

  // Triage ⑧ — lokacijski preklopnik (pogledi): centralna vloga sme izbrati
  // lokacijo (?locationId=) — sedaj Z org preverbo; brez parametra = org allow-lista.
  // Non-central je vedno vezan na svojo lokacijo (fail-closed).
  const requested = new URL(req.url).searchParams.get('locationId')?.trim() || ''
  let selectedLocation: string | null = null
  if (requested) {
    if (!isCentralRole(user)) return fail('Samo centralne vloge smejo preklapljati med lokacijami.', 403)
    const orgGuard = await assertOrgScope(user, requested)
    if (orgGuard) return orgGuard
    const loc = await db.location.findUnique({ where: { id: requested }, select: { id: true, name: true } })
    if (!loc) return fail('Lokacija ne obstaja.', 404)
    selectedLocation = loc.id
  }

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  // izbrana lokacija ALI org allow-lista (nikoli več globalno / findFirst fallback)
  const counterScope = selectedLocation ? { locationId: selectedLocation } : await locationScope(user)
  const startOfYesterday = new Date(startOfDay)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const yesterdayWhere = {
    createdAt: { gte: startOfYesterday, lt: startOfDay },
    status: { not: 'cancelled' as const },
    ...counterScope,
  }
  const todayWhere = {
    createdAt: { gte: startOfDay },
    status: { not: 'cancelled' as const },
    ...counterScope,
  }

  // Issue #4 §1: globalni števci se zožijo na lokacijo uporabnika;
  // selectedLocation dodatno zoži tudi centralno vlogo (preklopnik)
  const [activeOrders, openTables, menuCount, employees, todayOrders, paidToday, topItemsRaw, yesterdayAgg] = await Promise.all([
    db.order.count({ where: { status: { in: ORDER_ACTIVE_DB }, ...counterScope } }),
    // Issue #71 audit-3: KPI »Zasedene mize« šteje IZPELJANO stanje (miza z AKTIVNIM naročilom),
    // ne surovega DB statusa 'occupied' — DB occupied brez aktivnega naročila se v tlorisu
    // prikaže kot DIRTY (map.ts: Issue #70 §1) in je povzročal protislovje: KPI 5 zasedenih,
    // tloris 1 zasedena + 5 za pospraviti. EN vir resnice za obe plošči.
    db.table.count({ where: { Order: { some: { status: { in: ORDER_ACTIVE_DB }, ...counterScope } }, ...counterScope } }),
    // MenuItem nima locationId (globalen meni prek Menu) — brez scopinga
    db.menuItem.count({ where: { isAvailable: true } }),
    db.employee.count({ where: { status: 'active', ...counterScope } }),
    db.order.findMany({
      where: todayWhere,
      select: { total: true, status: true },
    }),
    showFinancial
      ? db.order.aggregate({
          where: { ...todayWhere, paymentStatus: 'paid', paidAt: { gte: startOfDay } },
          _sum: { total: true },
          _count: true,
        })
      : Promise.resolve({ _sum: { total: null as number | null }, _count: 0 }),
    db.orderItem.groupBy({
      by: ['menuItemName'],
      where: { Order: { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) }, status: { not: 'cancelled' }, ...counterScope } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    }),
    // v1.129.0 (Toast/Square benchmark): včerajšnji promet — Δ% na KPI kartici prometa
    showFinancial
      ? db.order.aggregate({ where: yesterdayWhere, _sum: { total: true } })
      : Promise.resolve({ _sum: { total: null as number | null } }),
  ])

  const todayRevenue = showFinancial ? todayOrders.reduce((s, o) => s + num(o.total), 0) : 0
  // v1.129.0: včerajšnji promet (cel dan, enak obseg) — null pomeni »ni podatka za Δ«
  const yesterdayRevenue = showFinancial && yesterdayAgg._sum.total !== null ? num(yesterdayAgg._sum.total) : null

  return ok({
    stats: {
      activeOrders,
      openTables,
      menuItems: menuCount,
      employees,
      todayOrders: todayOrders.length,
      todayRevenue,
      yesterdayRevenue,
      paidToday: { count: paidToday._count, total: showFinancial && paidToday._sum.total ? num(paidToday._sum.total) : 0 },
      financialPerm: showFinancial,
    },
    topItems: topItemsRaw.map((t) => ({ name: t.menuItemName, qty: t._sum.quantity || 0 })),
    // preklopnik (pogledi): odgovor jasno pove, na katero lokacijo se nanaša
    locationScope: selectedLocation ?? null,
    locationName: selectedLocation
      ? (await db.location.findUnique({ where: { id: selectedLocation }, select: { name: true } }))?.name ?? null
      : null,
  })
}
