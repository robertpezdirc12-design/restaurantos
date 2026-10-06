import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

/** Kuhinjski prikaz (KDS) — vrsta artikel-predmetov po naročilih */
export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const orders = await db.order.findMany({
    where: { status: { in: ['OPEN', 'SENT', 'PREPARED'] }, items: { some: { status: { in: ['PENDING', 'PREPARING', 'READY'] } } } },
    include: {
      table: { select: { name: true, zone: true } },
      items: { where: { status: { in: ['PENDING', 'PREPARING', 'READY'] } }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return ok({ queue: orders })
}

export async function PATCH(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.itemId || !['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(body.status)) {
    return fail('itemId in veljaven status sta obvezna.')
  }
  const item = await db.orderItem.update({
    where: { id: body.itemId },
    data: { status: body.status },
  })
  // če so vsi artikli naročila pripravljeni → naročilo PREPARED
  const remaining = await db.orderItem.count({
    where: { orderId: item.orderId, status: { in: ['PENDING', 'PREPARING'] } },
  })
  if (remaining === 0) {
    await db.order.update({ where: { id: item.orderId }, data: { status: 'PREPARED' } })
  } else {
    await db.order.updateMany({ where: { id: item.orderId, status: 'OPEN' }, data: { status: 'SENT' } })
  }
  return ok({ item })
}
