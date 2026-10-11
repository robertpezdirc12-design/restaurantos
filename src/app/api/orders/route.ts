import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { mapOrder, ORDER_ACTIVE_DB } from '@/lib/map'
import { createOrderCore, orderInclude, normalizeOrder, OrderError } from '@/lib/ops'

/** Normalizacija produkcijske vrstice -> mapper pričakovana oblika */
function normalize(o: Record<string, unknown>) {
  return {
    ...o,
    items: o.OrderItem,
    table: o.Table,
    employee: o.Employee_Order_employeeIdToEmployee,
  } as Parameters<typeof mapOrder>[0]
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const status = req.nextUrl.searchParams.get('status')
  const base = status
    ? { status: status.toLowerCase() }
    : { status: { in: ORDER_ACTIVE_DB } }
  // Issue #4 §1: lokacijski scope (prej: vsak staff je videl naročila VSEH lokacij)
  const where = { ...base, ...locationScope(user) }
  const orders = await db.order.findMany({
    where,
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({ orders: orders.map((o) => mapOrder(normalize(o))) })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
    return fail('Naročilo mora vsebovati vsaj en artikel.')
  }
  try {
    // Issue #4 §10: brez findFirst() fallbacka — staff MORA imeti lokacijo (admin lahko poda body.locationId)
    const loc = requireUserLocation(user, body?.locationId)
    if (typeof loc !== 'string') return loc
    const orgGuard = await assertOrgScope(user, loc)
    if (orgGuard) return orgGuard
    const { order, replayed } = await createOrderCore({
      employeeId: user.sub,
      locationId: loc,
      items: body.items,
      tableId: body.tableId || null,
      type: body.type || 'DINE_IN',
      note: body.note,
      guests: body.guests,
      clientOperationId: body.clientOperationId || body.idempotencyKey || null,
    })
    return ok({ order, replayed }, replayed ? 200 : 201)
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status)
    return fail('Naročila ni bilo mogoče ustvariti.', 500)
  }
}
