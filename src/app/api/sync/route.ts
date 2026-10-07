import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { nid, itemStatusToDB, ORDER_ACTIVE_DB, jstr } from '@/lib/map'
import { createOrderCore, OrderError } from '@/lib/ops'

/**
 * Sinhronizacija offline operacij (issue #1: offline/local-first).
 * Klient pošlje serijo {clientOperationId, kind, payload}; strežnik vsako opravilo
 * uporabi NATANKO ENKRAT (DeviceSyncOperation @@unique[deviceId, clientOperationId])
 * in vrni rezultat per-op → klient s potrdjenimi počisti lokalno vrsto.
 * Replay istega id-ja → ack brez ponovnega izvajanja (idempotentno).
 */
interface SyncOp {
  clientOperationId?: string
  kind?: string
  payload?: Record<string, unknown>
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.slice(0, 64) : 'unknown'
  const ops: SyncOp[] = Array.isArray(body?.ops) ? body.ops.slice(0, 200) : []
  if (ops.length === 0) return fail('ops seznam je obvezen.')

  const results: { clientOperationId: string; ok: boolean; error?: string; orderId?: string; replayed?: boolean }[] = []

  for (const op of ops) {
    const clientOperationId = typeof op.clientOperationId === 'string' ? op.clientOperationId.slice(0, 64) : ''
    if (!clientOperationId || !op.kind) {
      results.push({ clientOperationId: clientOperationId || '?', ok: false, error: 'Manjka clientOperationId ali kind.' })
      continue
    }
    try {
      // Idempotencija: to operacijo smo že uporabili?
      const seen = await db.deviceSyncOperation.findUnique({
        where: { deviceId_clientOperationId: { deviceId, clientOperationId } },
      })
      if (seen && seen.status === 'applied') {
        results.push({ clientOperationId, ok: true, replayed: true, orderId: seen.orderId || undefined })
        continue
      }

      const orderId = await applyOp(user, op)

      const deviceLocation = user.loc || (await db.location.findFirst())?.id || null
      await db.deviceSyncOperation.upsert({
        where: { deviceId_clientOperationId: { deviceId, clientOperationId } },
        create: {
          id: nid(),
          deviceId,
          locationId: deviceLocation as string,
          clientOperationId,
          operationType: op.kind,
          payload: jstr(op.payload ?? {}),
          status: 'applied',
          orderId: orderId || null,
          ack: jstr({ ok: true }),
          employeeId: user.sub,
          processedAt: new Date(),
        },
        update: { status: 'applied', ack: jstr({ ok: true }), orderId: orderId || null, employeeId: user.sub, processedAt: new Date() },
      })
      results.push({ clientOperationId, ok: true, orderId: orderId || undefined, replayed: !!seen })
    } catch (e) {
      const message = e instanceof OrderError ? e.message : 'Operacija ni uspela.'
      // zapiši neuspel poskus (diagnostika), pri klientu ostane v vrsti
      try {
        const deviceLocation = user.loc || (await db.location.findFirst())?.id || ''
        await db.deviceSyncOperation.upsert({
          where: { deviceId_clientOperationId: { deviceId, clientOperationId } },
          create: {
            id: nid(),
            deviceId,
            locationId: deviceLocation,
            clientOperationId,
            operationType: op.kind || 'unknown',
            payload: jstr(op.payload ?? {}),
            status: 'failed',
            lastError: message,
            clientRetryCount: 1,
            employeeId: user.sub,
          },
          update: { status: 'failed', lastError: message, clientRetryCount: { increment: 1 } },
        })
      } catch { /* diagnostika ni kritična */ }
      results.push({ clientOperationId, ok: false, error: message })
    }
  }

  return ok({ results })
}

/** Uporabi eno offline operacijo — ISTA logika kot online poti */
async function applyOp(
  user: { sub: string; loc: string | null },
  op: SyncOp
): Promise<string | null> {
  const payload = (op.payload || {}) as Record<string, unknown>

  switch (op.kind) {
    case 'order.create': {
      const { order } = await createOrderCore({
        employeeId: user.sub,
        locationId: user.loc,
        items: payload.items as { menuItemId: string; qty?: number; note?: string }[],
        tableId: (payload.tableId as string) || null,
        type: (payload.type as string) || 'DINE_IN',
        note: payload.note as string | undefined,
        guests: payload.guests as number | undefined,
        clientOperationId: (op.clientOperationId as string) || null,
      })
      return order.id
    }
    case 'order.addItems': {
      const orderId = String(payload.orderId || '')
      const addItems = (payload.addItems || payload.items) as { menuItemId: string; qty?: number; note?: string }[] | undefined
      if (!orderId || !Array.isArray(addItems) || addItems.length === 0) {
        throw new OrderError('order.addItems: manjka orderId ali addItems.')
      }
      const order = await db.order.findUnique({ where: { id: orderId } })
      if (!order) throw new OrderError('Naročilo ne obstaja več.', 404)
      if (!ORDER_ACTIVE_DB.includes(order.status)) throw new OrderError('Naročilo ni več odprto.', 409)
      const menuItems = await db.menuItem.findMany({
        where: { id: { in: addItems.map((i) => i.menuItemId) } },
      })
      const rows = addItems.map((i) => {
        const mi = menuItems.find((m) => m.id === i.menuItemId)
        if (!mi) throw new OrderError('Artikel ne obstaja.')
        const qty = Math.max(1, Math.round(Number(i.qty) || 1))
        const price = Number(mi.price)
        const vatRate = Number(mi.vatRate) || 22
        return {
          id: nid(),
          orderId,
          menuItemId: mi.id,
          quantity: qty,
          price,
          vatRate,
          vatAmount: (price * qty * vatRate) / 100,
          menuItemName: mi.name,
          status: itemStatusToDB('PENDING'),
          notes: i.note || '',
        }
      })
      await db.orderItem.createMany({ data: rows })
      await recalcTotals(orderId)
      return orderId
    }
    case 'kitchen.status': {
      const itemId = String(payload.itemId || '')
      const status = String(payload.status || '')
      if (!itemId || !['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(status)) {
        throw new OrderError('kitchen.status: manjka itemId ali veljaven status.')
      }
      const item = await db.orderItem.update({
        where: { id: itemId },
        data: { status: itemStatusToDB(status) },
      })
      const remaining = await db.orderItem.count({
        where: { orderId: item.orderId, status: { in: ['pending', 'fired', 'preparing'] } },
      })
      if (remaining === 0) {
        await db.order.update({ where: { id: item.orderId }, data: { status: 'prepared' } })
      } else {
        await db.order.updateMany({ where: { id: item.orderId, status: 'open' }, data: { status: 'sent' } })
      }
      return item.orderId
    }
    default:
      throw new OrderError(`Neznana vrsta operacije: ${op.kind}`)
  }
}

async function recalcTotals(orderId: string) {
  const items = await db.orderItem.findMany({ where: { orderId, voided: false } })
  let subtotal = 0
  let tax = 0
  for (const it of items) {
    subtotal += Number(it.price) * (it.quantity || 0)
    tax += Number(it.vatAmount)
  }
  await db.order.update({
    where: { id: orderId },
    data: {
      subtotal: Math.round(subtotal * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      total: Math.round((subtotal + tax) * 100) / 100,
    },
  })
}

/** GET — zadnje operacije naprave (diagnostika sinhronizacije) */
export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const deviceId = req.nextUrl.searchParams.get('deviceId') || 'unknown'
  const operations = await db.deviceSyncOperation.findMany({
    where: { deviceId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return ok({
    operations: operations.map((o) => ({
      clientOperationId: o.clientOperationId,
      kind: o.kind,
      status: o.status,
      orderId: o.orderId,
      lastError: o.lastError,
      retryCount: o.clientRetryCount,
      createdAt: o.createdAt,
    })),
  })
}
