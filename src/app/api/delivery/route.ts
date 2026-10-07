/**
 * Delivery operativa (issue #2): seznam dostavnih naročil (kanonični Order, type=delivery,
 * z DeliveryInfo/DeliveryTracking), statusne tranzicije, dodelitev voznika + cones.
 * Pravila: ne podvaja modelov; dostavna naročila so vidna tudi v KDS (isti statusni tok),
 * plačilo/račun teče po istem FURS toku kot POS; vsaka pomembna sprememba = AuditLog.
 */
import { NextRequest } from 'next/server'
import { ok, fail, requirePermission, isResponse } from '@/lib/api'
import { db } from '@/lib/db'
import { nid, jstr, mapOrder, mapDeliveryInfo, mapDeliveryZone, ORDER_ACTIVE_DB, DELIVERY_STATUS_DB, deliveryStatusToDB } from '@/lib/map'
import { maskPhone } from '@/lib/delivery'
export const dynamic = 'force-dynamic'

/** Dovoljene tranzicije dostave (naprej po toku; preklic kadarkoli pred dostavo). */
const TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['assigned', 'cancelled'],
  assigned: ['picked_up', 'cancelled'],
  picked_up: ['on_the_way', 'cancelled'],
  on_the_way: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user

  const [orders, zones, webhookErrors] = await Promise.all([
    db.order.findMany({
      where: { type: 'delivery' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        OrderItem: true,
        DeliveryInfo: true,
        Receipt: { orderBy: { createdAt: 'desc' as const } },
      },
    }),
    db.deliveryZone.findMany({ orderBy: { sortOrder: 'asc' } }),
    // Napake webhookov — IntegrationLog za glovo/wolt (za Dnevnik napak v UI)
    db.integration.findMany({
      where: { provider: { in: ['glovo', 'wolt'] } },
      select: {
        id: true, name: true, provider: true, isActive: true, connectionStatus: true,
        IntegrationLog: { orderBy: { createdAt: 'desc' as const }, take: 20 },
      },
    }),
  ])
  // DeliveryTracking nima @relation na DeliveryInfo — ročno poveži po deliveryInfoId
  const trackings = await db.deliveryTracking.findMany({
    where: { deliveryInfoId: { in: orders.map((o) => o.DeliveryInfo?.id).filter(Boolean) as string[] } },
  })
  const trackingByInfo = new Map(trackings.map((t) => [t.deliveryInfoId, t]))

  return ok({
    orders: orders.map((o) => ({
      ...mapOrder({
        ...o,
        items: o.OrderItem,
        table: null,
        employee: null,
        receipts: o.Receipt,
      }),
      delivery: o.DeliveryInfo ? mapDeliveryInfo(o.DeliveryInfo, trackingByInfo.get(o.DeliveryInfo.id) ?? null) : null,
    })),
    zones: zones.map(mapDeliveryZone),
    platformIntegrations: webhookErrors.map((i) => ({
      id: i.id, name: i.name, provider: i.provider, isActive: i.isActive,
      connectionStatus: i.connectionStatus,
      logs: i.IntegrationLog.map((l) => ({
        id: l.id, action: l.action, direction: l.direction, status: l.status,
        statusCode: l.statusCode, errorMessage: l.errorMessage || null,
        createdAt: l.createdAt as unknown as string,
      })),
    })),
  })
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user

  const body = (await req.json().catch(() => null)) as {
    orderId?: string
    status?: string
    driverName?: string
    driverPhone?: string
    note?: string
  } | null
  if (!body?.orderId || !body.status) return fail('Manjkata orderId ali status.', 400)

  const status = deliveryStatusToDB(body.status)
  if (!DELIVERY_STATUS_DB.includes(status as (typeof DELIVERY_STATUS_DB)[number])) {
    return fail(`Neznan status dostave: ${body.status}`, 400)
  }

  const order = await db.order.findUnique({
    where: { id: body.orderId },
    include: { DeliveryInfo: true },
  })
  if (!order?.DeliveryInfo) return fail('Naročilo ni dostavno ali nima dostavnih podatkov.', 404)
  // DeliveryTracking nima Prisma relacije na DeliveryInfo (samo deliveryInfoId @unique) — ročna poizvedba
  const tracking = await db.deliveryTracking.findUnique({ where: { deliveryInfoId: order.DeliveryInfo.id } })

  const current = order.DeliveryInfo.status
  const allowed = TRANSITIONS[current] || []
  if (status !== current && !allowed.includes(status)) {
    return fail(`Nedovoljena tranzicija: ${current} → ${status}.`, 400)
  }

  const t = await db.$transaction(async (tx) => {
    const di = await tx.deliveryInfo.update({
      where: { id: order.DeliveryInfo!.id },
      data: {
        status,
        actualTime: status === 'delivered' ? new Date() : undefined,
        ...(body.driverName ? { courierName: body.driverName } : {}),
        ...(body.driverPhone ? { courierPhone: body.driverPhone } : {}),
      },
    })
    // Voznik/tracking (DeliveryTracking: deliveryInfoId @unique brez @relation)
    if ((body.driverName || body.driverPhone) && !tracking) {
      await tx.deliveryTracking.create({
        data: {
          id: nid(),
          deliveryInfoId: di.id,
          driverName: body.driverName || '',
          driverPhone: body.driverPhone || '',
          status: status === 'delivered' ? 'delivered' : 'assigned',
          assignedAt: new Date(),
          locationId: order.locationId,
        },
      })
    } else if (tracking) {
      await tx.deliveryTracking.update({
        where: { id: tracking.id },
        data: {
          status: status === 'delivered' ? 'delivered' : status,
          ...(body.driverName ? { driverName: body.driverName } : {}),
          ...(body.driverPhone ? { driverPhone: body.driverPhone } : {}),
          ...(status === 'picked_up' ? { pickedUpAt: new Date() } : {}),
          ...(status === 'on_the_way' ? { onTheWayAt: new Date() } : {}),
          ...(status === 'delivered' ? { deliveredAt: new Date() } : {}),
          lastUpdateAt: new Date(),
        },
      })
    }
    // Preklic dostave → tudi naročilo (isti kanonični tok)
    if (status === 'cancelled') {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'cancelled', cancelReason: body.note || 'Preklic dostave', cancelledAt: new Date() },
      })
    }
    if (status === 'delivered') {
      // Dostavljeno in še neplačano → označi plačilo po obroku (fizično plačilo pri prevzemu)
      await tx.order.updateMany({
        where: { id: order.id, status: { in: ORDER_ACTIVE_DB } },
        data: { status: 'prepared' },
      })
    }
    return di
  })

  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'DELIVERY_STATUS_UPDATE',
      entityType: 'DeliveryInfo',
      entityId: t.id,
      details: jstr({
        orderId: order.id, orderNumber: order.orderNumber,
        from: current, to: status,
        driver: body.driverName || undefined,
        driverPhone: body.driverPhone ? maskPhone(body.driverPhone) : undefined,
      }),
    },
  }).catch(() => null)

  return ok({ ok: true, status })
}
