import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isCentralRole, isResponse, ok, fail, forbidden, assertResourceLocation } from '@/lib/api'
import { mapOrder, mapOrderItem, nid, num, r2, itemStatusToDB, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { auditChainFields } from '@/lib/audit-chain'
import type { Prisma } from '@prisma/client'

const orderInclude = {
  OrderItem: { include: { MenuItem: { include: { PrepStation: true } } } },
  Table: true,
  Employee_Order_employeeIdToEmployee: { select: { id: true, name: true, role: true } },
  Receipt: { orderBy: { createdAt: 'desc' as const } },
} as const

function normalize(o: Record<string, unknown>) {
  return {
    ...o,
    items: o.OrderItem,
    table: o.Table,
    employee: o.Employee_Order_employeeIdToEmployee,
  } as Parameters<typeof mapOrder>[0]
}

async function recalcTotals(orderId: string, tx?: Prisma.TransactionClient) {
  const dbx = tx ?? db
  const items = await dbx.orderItem.findMany({ where: { orderId, voided: false } })
  let subtotal = 0
  let tax = 0
  for (const it of items) {
    subtotal += num(it.price) * (it.quantity || 0)
    tax += num(it.vatAmount)
  }
  return { subtotal: r2(subtotal), tax: r2(tax), total: r2(subtotal + tax) }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: location gate (prej: katerikoli staff je mogel brati naročilo katerekoli lokacije)
  const guard = assertResourceLocation(user, order.locationId)
  if (guard) return guard
  return ok({ order: mapOrder(normalize(order)) })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)

  // Granularne pravice (issue #1) — glede na vrsto spremembe:
  if (Array.isArray(body?.addItems) && body.addItems.length > 0) {
    const gate = await requirePermission(req, 'orders.create')
    if (isResponse(gate)) return gate
  } else if (body?.status) {
    if (body.status === 'PAID' || body.status === 'CANCELLED') {
      // plačilo/veljavnost mimo plačilnega poteka = samo vodstvo
      // P2 audit N2: OWNER je centralna vloga — sme tudi ročno override (prej samo ADMIN/MANAGER)
      if (!isCentralRole(user) && user.role !== 'MANAGER') return forbidden()
    } else {
      const gate = await requirePermission(req, 'kitchen.update')
      if (isResponse(gate)) return gate
    }
  }

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: location gate na VSAKO spremembo (prej: PATCH brez body akcije je bil prazen gate)
  const locGuard = assertResourceLocation(user, order.locationId)
  if (locGuard) return locGuard
  const recognized = Array.isArray(body?.addItems) || body?.status !== undefined || body?.note !== undefined || body?.customerName !== undefined
  if (!recognized) return fail('Ni prepoznane akcije (addItems | status | note | customerName).', 400)

  const data: Record<string, unknown> = {}
  if (body?.status && ['OPEN', 'SENT', 'PREPARED', 'PAID', 'CANCELLED'].includes(body.status)) {
    // R10 popravek (P0 audit): plačanega naročila ni mogoče ročno stornirati (prej: možno
    // brez razknjižbe zalog, brez fiskalnega storna in brez audita — tveganje pregreška evidence)
    if (body.status === 'CANCELLED' && order.paymentStatus === 'paid') {
      return fail('Plačanega naročila ni mogoče stornirati prek statusa — fiskalni storno/vračilo je v pripravi.', 409)
    }
    data.status = body.status.toLowerCase()
    if (body.status === 'PAID') {
      data.paidAt = new Date()
      data.paymentStatus = 'paid'
    }
    if (body.status === 'PAID' || body.status === 'CANCELLED') {
      if (order.tableId) {
        await db.table.update({ where: { id: order.tableId }, data: { status: 'cleaning' } })
      }
    }
    if (body.status === 'CANCELLED') {
      data.cancelledAt = new Date()
      data.cancelledBy = user.name
      data.cancelledById = user.sub
    }
    // P0 audit (C2): ročni override statusa PAID/CANCELLED = finančna akcija → obvezen audit
    if (body.status === 'PAID' || body.status === 'CANCELLED') {
      const __aIdO = nid()
      const __chainO = await auditChainFields(db, { action: body.status === 'PAID' ? 'ORDER_STATUS_PAID_OVERRIDE' : 'ORDER_STATUS_CANCELLED_OVERRIDE', entityType: 'Order', entityId: id, details: jstr({ orderNumber: order.orderNumber, previousStatus: order.status, previousPaymentStatus: order.paymentStatus, by: user.name }), locationId: order.locationId, id: __aIdO })
      await db.auditLog.create({
        data: {
          ...__chainO,
          id: __aIdO,
          userId: user.sub,
          action: body.status === 'PAID' ? 'ORDER_STATUS_PAID_OVERRIDE' : 'ORDER_STATUS_CANCELLED_OVERRIDE',
          entityType: 'Order',
          entityId: id,
          details: jstr({ orderNumber: order.orderNumber, previousStatus: order.status, previousPaymentStatus: order.paymentStatus, by: user.name }),
          locationId: order.locationId,
        },
      })
    }
  }
  if (body?.note !== undefined) data.notes = body.note
  if (body?.customerName !== undefined) data.customerName = body.customerName

  // dodajanje artiklov v odprto naročilo
  if (Array.isArray(body?.addItems) && body.addItems.length > 0) {
    const menuItems = await db.menuItem.findMany({
      where: {
        id: { in: body.addItems.map((i: { menuItemId: string }) => i.menuItemId) },
        isAvailable: true,
        // Issue #4 §1: artikel mora pripadati lokaciji naročila (prek Category→Menu)
        Category: { Menu: { locationId: order.locationId } },
      },
    })
    const rows = body.addItems.map((i: { menuItemId: string; qty?: number; note?: string }) => {
      const mi = menuItems.find((m) => m.id === i.menuItemId)
      if (!mi) throw new Error(`Artikel ni na voljo na tej lokaciji (${i.menuItemId}).`)
      const qty = Math.max(1, Math.round(Number(i.qty) || 1))
      const price = num(mi.price)
      const vatRate = num(mi.vatRate, 22)
      const line = price * qty
      return {
        id: nid(),
        orderId: id,
        menuItemId: mi.id,
        quantity: qty,
        price,
        vatRate,
        vatAmount: (line * vatRate) / 100,
        menuItemName: mi.name,
        status: itemStatusToDB('PENDING'),
        notes: i.note || '',
      }
    })
    // R5 popravek (P0 audit): createMany + recalcTotals + update v ISTI transakciji s CAS
    // gate (paymentStatus !== 'paid') — prej: trije ločeni klici brez plačilne preverbe
    // (postavke na plačano naročilo bi spremenile total, račun pa ostal star).
    try {
      await db.$transaction(async (tx) => {
        await tx.orderItem.createMany({ data: rows })
        const totals = await recalcTotals(id, tx)
        const patch: Record<string, unknown> = { ...totals, ...data }
        if (data.status === undefined && order.status === 'open') patch.status = 'sent'
        const claim = await tx.order.updateMany({
          where: { id, paymentStatus: { not: 'paid' } },
          data: patch,
        })
        if (claim.count === 0) throw new Error('ORDER_PAID_GATE')
      })
    } catch (e) {
      if (e instanceof Error && e.message === 'ORDER_PAID_GATE') {
        return fail('Naročilo je že plačano — postavk ni mogoče dodati.', 409)
      }
      return fail('Artikel ni na voljo na lokaciji naročila.', 400)
    }
    const updatedAfterAdd = await db.order.findUnique({ where: { id }, include: orderInclude })
    if (!updatedAfterAdd) return fail('Naročilo ne obstaja.', 404)
    if (updatedAfterAdd.status === 'paid') {
      await publishEvent('PaymentCompleted', { entityType: 'Order', entityId: updatedAfterAdd.id, payload: { total: updatedAfterAdd.total, locationId: updatedAfterAdd.locationId } }).catch(() => undefined)
    }
    if (updatedAfterAdd.status === 'cancelled') {
      await publishEvent('OrderCancelled', { entityType: 'Order', entityId: updatedAfterAdd.id, payload: { by: user.name, locationId: updatedAfterAdd.locationId } }).catch(() => undefined)
    }
    return ok({ order: mapOrder(normalize(updatedAfterAdd)) })
  }

  const updated = await db.order.update({ where: { id }, data, include: orderInclude })
  // Issue #11 §3 — plačilo/storno dogodki (fire-and-forget, nikoli ne vplivata na odgovor)
  if (updated.status === 'paid') {
    await publishEvent('PaymentCompleted', { entityType: 'Order', entityId: updated.id, payload: { total: updated.total, locationId: updated.locationId } }).catch(() => undefined)
  }
  if (updated.status === 'cancelled') {
    await publishEvent('OrderCancelled', { entityType: 'Order', entityId: updated.id, payload: { by: user.name, locationId: updated.locationId } }).catch(() => undefined)
  }
  return ok({ order: mapOrder(normalize(updated)) })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  // storno naročila = samo vodstvo (issue #1: pravice na kritičnih operacijah)
  // P2 audit N2: OWNER je centralna vloga — sme tudi storno (prej samo ADMIN/MANAGER)
  if (!isCentralRole(user) && user.role !== 'MANAGER') return forbidden()
  const { id } = await params
  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: lokacijski gate na storno
  const delGuard = assertResourceLocation(user, order.locationId)
  if (delGuard) return delGuard
  // R10 popravek (P0 audit): storno plačanega naročila brez razknjižbe/fiskalnega storna je zavrnjen
  if (order.paymentStatus === 'paid') {
    return fail('Plačanega naročila ni mogoče stornirati — fiskalni storno/vračilo je v pripravi.', 409)
  }
  await db.order.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: user.name, cancelledById: user.sub },
  })
  // P0 audit (C2): storno naročila je finančna akcija → obvezen revizijski zapis
  {
    const __aIdC = nid()
    const __chainC = await auditChainFields(db, { action: 'ORDER_CANCELLED', entityType: 'Order', entityId: id, details: jstr({ orderNumber: order.orderNumber, total: num(order.total), storno: true, by: user.name }), locationId: order.locationId, id: __aIdC })
    await db.auditLog.create({
      data: {
        ...__chainC,
        id: __aIdC,
        userId: user.sub,
        action: 'ORDER_CANCELLED',
        entityType: 'Order',
        entityId: id,
        details: jstr({ orderNumber: order.orderNumber, total: num(order.total), storno: true, by: user.name }),
        locationId: order.locationId,
      },
    })
  }
  // Issue #11 §3 — storno dogodek
  await publishEvent('OrderCancelled', { entityType: 'Order', entityId: order.id, payload: { by: user.name, locationId: order.locationId, storno: true } }).catch(() => undefined)
  if (order.tableId) {
    await db.table.update({ where: { id: order.tableId }, data: { status: 'cleaning' } })
  }
  return ok({ cancelled: true })
}
