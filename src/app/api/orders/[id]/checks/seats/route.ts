import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { buildSeatSplitPlan } from '@/lib/seat-assignments'
import { seatsColumnAvailable } from '@/lib/seat-db'

/**
 * P3 #20 (v1.193.0) — SPLIT IZSTAVKOV PO SEDEŽIH (Square seat-level).
 *
 * POST /api/orders/[id]/checks/seats → vsak ZASEDEN sedež dobi svoj izstavek;
 *                                      postavke brez sedeža ostanejo na baznem
 *                                      izstavku #1.
 *
 * Zakaj ločena ruta in ne odjemalec: razdelitev mora biti ATOMSKA (vsi izstavki
 * ali noben), PONOVLJIVA (ponoven klic PREBALANSIRA — ne dodaja izstavkov) in
 * deterministična (sedeži naraščajoče, postavke znotraj sedeža po id — čisti sloj
 * src/lib/seat-assignments.ts). Dopolnjuje (NE nadomešča) split po gostih
 * (v1.185.0, samodejna poštena LPT porazdelitev) in split po izstavkih (OPS-7,
 * ročno oklepjanje): tukaj razdelitev določa SEDEŽ (dejanski izvor postavke),
 * ne ugibanje po znesku.
 *
 * Pravila (isti konservativni okvir kot split po gostih):
 *  - dovoljenje `orders.pay`;
 *  - SAMO dokler ni plačan še noben izstavek IN noben izstavek nima plačila;
 *  - samo dokler je naročilo odprto;
 *  - samo ne-voided postavke;
 *  - ZAHTEVANA vsaj DVA zasedena sedeža (z enim ni ničesar razdeliti — 409, ne
 *    lažnega uspeha);
 *  - rebalans: prejšnji dodatni NEplačani izstavki se izbrišejo, postavke se
 *    razporedijo znova po sedežih (bazni izstavek #1 ohrani id).
 */

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  if (!(await seatsColumnAvailable())) {
    return fail('Sedeži niso na voljo: shematska migracija »sedeži« še ni aplicirana (konzola Enterprise → Shema migracije).', 503)
  }

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    return fail('Zaključenega naročila ni mogoče razdeliti.', 409)
  }

  const checks = await db.check.findMany({
    where: { orderId: id },
    orderBy: { checkNumber: 'asc' },
    include: { _count: { select: { Payment: true } } },
  })
  if (checks.some((c) => c.paymentStatus === 'paid')) {
    return fail('Razdelitev po sedežih je dovoljena samo dokler ni plačan še noben izstavek.', 409)
  }
  if (checks.some((c) => c._count.Payment > 0)) {
    return fail('Izstavek s plačilom ni mogoče prebalansirati.', 409)
  }

  const live = order.OrderItem.filter((it) => !it.voided)
  const plan = buildSeatSplitPlan(live.map((it) => ({
    id: it.id,
    quantity: it.quantity,
    price: Number(it.price),
    seat: it.seat ?? null,
    voided: it.voided,
  })))
  if (!plan.ok) return fail(plan.error, 409)

  // vsota postavk brez sedeža (bazni izstavek) — za pregled v odgovoru
  const unassignedSet = new Set(plan.unassignedItemIds)
  const baseTotal = live
    .filter((it) => unassignedSet.has(it.id))
    .reduce((s, it) => s + it.quantity * Number(it.price), 0)

  const result = await db.$transaction(async (tx) => {
    // Bazni izstavek #1 nosi SAMO postavke brez sedeža. Če jih ni, baza NE nastane
    // (prazen plačljiv izstavek za 0 € je zmeda — nihče ne sme plačati nič).
    const hasUnassigned = plan.unassignedItemIds.length > 0

    if (!hasUnassigned) {
      // vse postavke imajo sedež: obstoječi (neplačani, brez plačil) izstavki se
      // izbrišejo in zgradijo znova od številke 1 po sedežih
      if (checks.length > 0) await tx.check.deleteMany({ where: { orderId: id } })
      await tx.orderItem.updateMany({ where: { orderId: id, voided: false }, data: { checkId: null } })
      const seatsOut: { id: string; checkNumber: number; seat: number; items: number; total: number }[] = []
      let n = 0
      for (const g of plan.groups) {
        n += 1
        const created = await tx.check.create({
          data: { id: nid(), checkNumber: n, orderId: id, paymentStatus: 'unpaid' },
        })
        await tx.orderItem.updateMany({ where: { id: { in: g.itemIds } }, data: { checkId: created.id } })
        seatsOut.push({ id: created.id, checkNumber: n, seat: g.seat, items: g.itemIds.length, total: g.total })
      }
      await writeAudit(tx, {
        userId: user.sub,
        action: 'ORDER_CHECK_SEAT_SPLIT',
        entityType: 'Order',
        entityId: id,
        details: jstr({ by: user.name, checks: seatsOut, unassigned: 0 }),
        locationId: order.locationId,
      })
      return { checks: seatsOut }
    }

    // bazni izstavek #1 (ustvari, če še ne obstaja) — ohrani id (baza)
    let baseCheck: { id: string; checkNumber: number } | null = checks[0] ?? null
    if (!baseCheck) {
      baseCheck = await tx.check.create({
        data: { id: nid(), checkNumber: 1, orderId: id, paymentStatus: 'unpaid' },
      })
    }
    // rebalans: vse ne-voided postavke za trenutek nazaj v bazo, dodatni neplačani izstavki proč
    await tx.orderItem.updateMany({ where: { orderId: id, voided: false }, data: { checkId: baseCheck.id } })
    const extraIds = checks.slice(1).map((c) => c.id)
    if (extraIds.length > 0) await tx.check.deleteMany({ where: { id: { in: extraIds }, orderId: id } })

    const seatsOut: { id: string; checkNumber: number; seat: number; items: number; total: number }[] = []
    let nextNumber = baseCheck.checkNumber
    for (const g of plan.groups) {
      nextNumber += 1
      const created = await tx.check.create({
        data: { id: nid(), checkNumber: nextNumber, orderId: id, paymentStatus: 'unpaid' },
      })
      await tx.orderItem.updateMany({ where: { id: { in: g.itemIds } }, data: { checkId: created.id } })
      seatsOut.push({ id: created.id, checkNumber: nextNumber, seat: g.seat, items: g.itemIds.length, total: g.total })
    }
    // postavke brez sedeža ostanejo na baznem izstavku #1 (updateMany zgoraj jih je že vrnil)

    await writeAudit(tx, {
      userId: user.sub,
      action: 'ORDER_CHECK_SEAT_SPLIT',
      entityType: 'Order',
      entityId: id,
      details: jstr({ by: user.name, checks: seatsOut, unassigned: plan.unassignedItemIds.length }),
      locationId: order.locationId,
    })
    return {
      checks: [
        { id: baseCheck.id, checkNumber: baseCheck.checkNumber, seat: null, items: plan.unassignedItemIds.length, total: Math.round((baseTotal + Number.EPSILON) * 100) / 100 },
        ...seatsOut,
      ],
    }
  })

  return ok({ checks: result.checks })
}
