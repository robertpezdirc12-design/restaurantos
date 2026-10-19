/**
 * Delivery operativa (issue #2): seznam dostavnih naročil (kanonični Order, type=delivery,
 * z DeliveryInfo/DeliveryTracking), statusne tranzicije, dodelitev voznika + cones.
 * Pravila: ne podvaja modelov; dostavna naročila so vidna tudi v KDS (isti statusni tok),
 * plačilo/račun teče po istem FURS toku kot POS; vsaka pomembna sprememba = AuditLog.
 */
import { NextRequest } from 'next/server'
import { ok, fail, requirePermission, isResponse, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { db } from '@/lib/db'
import { nid, jstr, mapOrder, mapDeliveryInfo, mapDeliveryZone, ORDER_ACTIVE_DB, DELIVERY_STATUS_DB, deliveryStatusToDB } from '@/lib/map'
import { maskPhone } from '@/lib/delivery'
import { claimMutableOrder } from '@/lib/ops'
import { pushEvent } from '@/lib/push'
import { writeAudit } from '@/lib/audit-chain'
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

/**
 * v1.148.0 (audit #10 razred): izguba dirke okoli preklica naročila. Razred se
 * VRŽE ZNOTRAJ $transaction, da rollback razveljavi že zapisan dostavni status in
 * tracking; zunanji rok ga pretvori v 409 (isti vzorec kot move/merge ruta).
 */
class DeliveryRejected extends Error {}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'delivery.manage')
  if (isResponse(user)) return user

  const [orders, zones, webhookErrors] = await Promise.all([
    db.order.findMany({
      // Issue #4 §1: dostavna naročila po lokaciji uporabnika (centralne = vse)
      where: { type: 'delivery', ...(await locationScope(user)) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        OrderItem: true,
        DeliveryInfo: true,
        Receipt: { orderBy: { createdAt: 'desc' as const } },
      },
    }),
    db.deliveryZone.findMany({ where: await locationScope(user), orderBy: { sortOrder: 'asc' } }),
    // Napake webhookov — IntegrationLog za glovo/wolt (za Dnevnik napak v UI)
    // Issue #5 (P0, komentar #2): prej brez lokacijskega filtra — manager ene lokacije
    // je videl integracije/dnevnike VSEH organizacij (Integration LOKACIJSKI stolpec ima)
    db.integration.findMany({
      where: { provider: { in: ['glovo', 'wolt'] }, ...(await locationScope(user)) },
      select: {
        id: true, name: true, provider: true, isActive: true, connectionStatus: true,
        IntegrationLog: { orderBy: { createdAt: 'desc' as const }, take: 20 },
      },
    }),
  ])
  // DeliveryTracking nima @relation na DeliveryInfo — ročno poveži po deliveryInfoId
  // OPS-8 val 3 (v1.73.0): include Employee → resolved driver name for the history list
  const trackings = await db.deliveryTracking.findMany({
    where: { deliveryInfoId: { in: orders.map((o) => o.DeliveryInfo?.id).filter(Boolean) as string[] } },
    include: { Employee: { select: { name: true } } },
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
  const user = await requirePermission(req, 'delivery.manage')
  if (isResponse(user)) return user

  const body = (await req.json().catch(() => null)) as {
    orderId?: string
    status?: string
    driverName?: string
    driverPhone?: string
    driverEmployeeId?: string
    note?: string
  } | null
  if (!body?.orderId || !body.status) return fail('Manjkata orderId ali status.', 400)

  const status = deliveryStatusToDB(body.status)
  if (!DELIVERY_STATUS_DB.includes(status as (typeof DELIVERY_STATUS_DB)[number])) {
    return fail(`Neznan status dostave: ${body.status}`, 400)
  }

  // OPS-8 val 3 (v1.73.0): driver may be assigned as an Employee (UI dropdown).
  // The employee name becomes the authoritative driverName/courierName.
  let driverEmployee: { id: string; name: string } | null = null
  if (body.driverEmployeeId) {
    const emp = await db.employee.findUnique({ where: { id: body.driverEmployeeId }, select: { id: true, name: true } })
    if (!emp) return fail('Voznik (zaposleni) ne obstaja.', 400)
    driverEmployee = { id: emp.id, name: emp.name }
  }

  const order = await db.order.findUnique({
    where: { id: body.orderId },
    include: { DeliveryInfo: true },
  })
  if (!order?.DeliveryInfo) return fail('Naročilo ni dostavno ali nima dostavnih podatkov.', 404)
  // Issue #4 §1: status dostave tujega naročila (druga lokacija) je zavrnjen (fail-closed)
  const locRes = await guardResource(user, order.locationId)
  if (locRes) return locRes
  // DeliveryTracking nima Prisma relacije na DeliveryInfo (samo deliveryInfoId @unique) — ročna poizvedba
  const tracking = await db.deliveryTracking.findUnique({ where: { deliveryInfoId: order.DeliveryInfo.id } })

  const current = order.DeliveryInfo.status
  const allowed = TRANSITIONS[current] || []
  if (status !== current && !allowed.includes(status)) {
    return fail(`Nedovoljena tranzicija: ${current} → ${status}.`, 400)
  }

  const settled = await db.$transaction(async (tx) => {
    const di = await tx.deliveryInfo.update({
      where: { id: order.DeliveryInfo!.id },
      data: {
        status,
        actualTime: status === 'delivered' ? new Date() : undefined,
        ...(body.driverName || driverEmployee ? { courierName: driverEmployee?.name || body.driverName } : {}),
        ...(body.driverPhone ? { courierPhone: body.driverPhone } : {}),
      },
    })
    // Voznik/tracking (DeliveryTracking: deliveryInfoId @unique brez @relation)
    const resolvedDriverName = driverEmployee?.name || body.driverName || ''
    if ((resolvedDriverName || body.driverPhone) && !tracking) {
      await tx.deliveryTracking.create({
        data: {
          id: nid(),
          deliveryInfoId: di.id,
          driverName: resolvedDriverName,
          driverPhone: body.driverPhone || '',
          ...(driverEmployee ? { driverEmployeeId: driverEmployee.id } : {}),
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
          ...(resolvedDriverName ? { driverName: resolvedDriverName } : {}),
          ...(driverEmployee ? { driverEmployeeId: driverEmployee.id } : {}),
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
      // v1.148.0 (isti razred napak kot audit #10/#12): zapis je bil prej
      // BREZPOGOJEN, prebrano stanje naročila pa sploh ni bilo overjeno. Posledica:
      // dostavni statusni tok je lahko PREKLICAL ŽE PLAČANO naročilo — EOR račun je
      // ostal sicer fiskaliziran, a na 'cancelled' naročilu (fiskalno neskladje, ki
      // ga mora lastnik ročno raziskati pri FURS), plačilno stanje 'paid' pa je
      // ostalo zapisano na preklicanem dokumentu.
      const claim = await claimMutableOrder(tx, order.id, {
        status: 'cancelled', cancelReason: body.note || 'Preklic dostave', cancelledAt: new Date(),
      }, order)
      // Izguba dirke: napaka se vrže ZNOTRAJ $transaction, da rollback razveljavi
      // že zapisan dostavni status in tracking (isti vzorec kot MergeRejected).
      if (!claim.ok) throw new DeliveryRejected('Naročilo je medtem zaključeno (plačano ali preklicano) — preklic dostave ni mogoč.')
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
    .then((di) => ({ di } as const))
    .catch((e: unknown) => (e instanceof DeliveryRejected ? { err: e.message } : Promise.reject(e)))
  if ('err' in settled) return fail(settled.err, 409)
  const t = settled.di

  await writeAudit(db, { userId: user.sub, action: 'DELIVERY_STATUS_UPDATE', entityType: 'DeliveryInfo', entityId: t.id, details: jstr({
        orderId: order.id, orderNumber: order.orderNumber,
        from: current, to: status,
        driver: (driverEmployee?.name || body.driverName) || undefined,
        driverEmployeeId: driverEmployee?.id,
        driverPhone: body.driverPhone ? maskPhone(body.driverPhone) : undefined,
      }) }).catch(() => null)

  // OPS-9 val 3 (v1.76.0): DRIVER_ASSIGNED push (notification matrix aware) when a driver
  // Employee is newly assigned or CHANGED on this delivery. Fire-and-forget — never blocks.
  if (driverEmployee && driverEmployee.id !== tracking?.driverEmployeeId) {
    void pushEvent('DRIVER_ASSIGNED', {
      title: 'Voznik dodeljen',
      body: `#${order.orderNumber ?? ''} — ${order.DeliveryInfo?.address || 'dostava'} · ${driverEmployee.name}`,
      url: '/dashboard?tab=dostava',
      tag: `driver-${order.DeliveryInfo!.id}`,
    }, { employeeIds: [driverEmployee.id] })
  }

  return ok({ ok: true, status })
}
