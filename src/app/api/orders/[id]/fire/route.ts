import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, jstr } from '@/lib/map'
import { orderInclude, normalizeOrder, OrderError } from '@/lib/ops'
import { publishEvent } from '@/lib/events'
import { pushEvent } from '@/lib/push'
import { writeAudit } from '@/lib/audit-chain'
import { createStationTasksForItems } from '@/lib/station-task-service'

/**
 * P2 audit §57 — ekspliciten "fire" na kuhinjo (draft → fire korak).
 * POST /api/orders/[id]/fire  body (OPCIJSKO): {courseId: string}
 * Pravila:
 *  - dovoljenje `orders.create`; naročilo odprto
 *  - idempotentno: order.firedAt ??= now — če je firedAt že nastavljen, vrne 200 BREZ sprememb
 *    (izbira dokumentirana: ponoven fire obstoječega toka ni mogoč; postavke, dodane PO fire-u,
 *     pokrije naslednji klic, ker se vrste pri novih postavkah posodabljajo ločeno — v tej iteraciji
 *     pa fire = enkratna akcija celotnega odprtega naročila)
 *  - OPS-7 (v1.68.0) COURSING: z body.courseId → fire SAMO pending postavk TEGA tečaja
 *    (tečaj status pending → fired + firedAt); ostale postavke/tečaji ostanejo nedotaknjeni.
 *    Brez courseId → vse pending postavke (obstoječe vedenje).
 *  - vsi ciljni OrderItem z statusom 'pending' (ne-voided) → status 'fired' + firedAt = now;
 *    že fired/preparing/ready/served ostanejo nedotaknjeni
 *  - revizija ORDER_FIRED + dogodek OrderFired (fire-and-forget)
 *  - če ni pending postavk → 200 s firedCount 0 (idempotentna prijaznost; UI gumb vseeno skrije)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const fireCourseId = typeof body?.courseId === 'string' && body.courseId.trim() ? body.courseId.trim() : null

  const order = await db.order.findUnique({ where: { id }, include: fireCourseId ? { Course: true } : undefined })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    return fail('Zaključenega (plačanega/storniranega) naročila ni mogoče poslati na kuhinjo.', 409)
  }
  // OPS-7 coursing: validacija tečaja (pripada naročilu, ni že poslan)
  let courseRow: { id: string; courseNumber: number; name: string; status: string } | null = null
  if (fireCourseId) {
    const c = (order as { Course?: { id: string; courseNumber: number; name: string; status: string }[] }).Course?.find((cc) => cc.id === fireCourseId)
    if (!c) return fail('Tečaj ne obstaja za to naročilo.', 404)
    if (c.status !== 'pending') return fail('Tečaj je že poslan v pripravo.', 409)
    courseRow = c
  }

  // idempotentnost: drugi klic ne sme spremeniti firedAt niti statusov postavk
  // (OPS-7: fire po tečaju je dovoljen tudi, če je order.firedAt že nastavljen —
  //  vsak tečaj ima svoj fire; skupni firedAt ostane prvi)
  if (order.firedAt && !fireCourseId) {
    const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
    if (!fresh) return fail('Naročilo ne obstaja.', 404)
    return ok({ order: mapOrder(normalizeOrder(fresh)), firedCount: 0, alreadyFired: true })
  }

  const now = new Date()
  let firedCount = 0
  let taskCount = 0
  await db.$transaction(async (tx) => {
    // Issue #14 (v1.112.0): postavke, ki gredo v pripravo, zajamemo PRED
    // updateMany (isti pogoj) — usmerjanje na postaje (StationTask) se razreši
    // OB FIRE-u: posnetek imen postaj + zaporedje; idempotentno (re-fire tečaja
    // obstoječih (postavka × postaja) ne podvoji). DDL pending → 0 (legacy tok).
    const fireWhere = { orderId: id, status: 'pending' as const, voided: false, ...(fireCourseId ? { courseId: fireCourseId } : {}) }
    const firingItems = await tx.orderItem.findMany({
      where: fireWhere,
      select: {
        id: true, orderId: true, menuItemId: true, menuItemName: true, quantity: true, notes: true,
        OrderItemModifier: { select: { name: true, modifierGroupId: true } },
      },
    })
    const res = await tx.orderItem.updateMany({
      where: fireWhere,
      data: { status: 'fired', firedAt: now },
    })
    firedCount = res.count
    if (firedCount > 0) {
      taskCount = await createStationTasksForItems(tx, {
        locationId: order.locationId,
        orderId: id,
        items: firingItems,
        firedAt: now,
      })
    }
    if (fireCourseId) {
      if (firedCount === 0) throw new OrderError('Tečaj nima postavk za pošiljanje v pripravo.', 400)
      await tx.course.update({ where: { id: fireCourseId }, data: { status: 'fired', firedAt: now } })
    }
    if (!order.firedAt) {
      await tx.order.update({ where: { id }, data: { firedAt: now } })
    }
    await writeAudit(tx, { userId: user.sub, action: 'ORDER_FIRED', entityType: 'Order', entityId: id, details: jstr({ firedItems: firedCount, stationTasks: taskCount, orderNumber: order.orderNumber, by: user.name, ...(fireCourseId ? { courseId: fireCourseId, courseNumber: courseRow?.courseNumber } : {}) }), locationId: order.locationId })
  })

  await publishEvent('OrderFired', {
    entityType: 'Order',
    entityId: id,
    payload: { orderId: id, count: firedCount, locationId: order.locationId },
    locationId: order.locationId,
  }).catch(() => undefined)

  // OPS-8 val 2 (v1.72.0): push to kitchen/bar on course fire (via notification matrix,
  // fire-and-forget — no rules = base targets kitchen/bar/chef)
  if (firedCount > 0) {
    void pushEvent('ORDER_FIRE', {
      title: 'Tečaj poslan',
      body: `${courseRow ? courseRow.name : 'Postavke'}${order.orderNumber ? ` · #${order.orderNumber}` : ''} · ${firedCount} kos`,
      url: '/dashboard?tab=kuhinja',
      tag: `fire-${id}`,
    }, { roles: ['kitchen', 'bar', 'chef'], locationId: order.locationId })
  }

  const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!fresh) return fail('Naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalizeOrder(fresh)), firedCount, stationTasks: taskCount, alreadyFired: false })
}
