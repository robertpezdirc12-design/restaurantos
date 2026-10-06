import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, forbidden } from '@/lib/api'
import { canAccessModule } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const tables = await db.table.findMany({
    include: {
      orders: {
        where: { status: { in: ['OPEN', 'SENT', 'PREPARED'] } },
        include: { items: true },
      },
    },
    orderBy: [{ zone: 'asc' }, { name: 'asc' }],
  })
  return ok({
    tables: tables.map((t) => ({
      id: t.id,
      name: t.name,
      zone: t.zone,
      seats: t.seats,
      posX: t.posX,
      posY: t.posY,
      status: t.orders.length > 0 ? 'OCCUPIED' : t.status,
      activeOrder: t.orders.length
        ? {
            id: t.orders[0].id,
            total: t.orders[0].total,
            guests: t.orders[0].guests,
            itemCount: t.orders[0].items.length,
          }
        : null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!canAccessModule(user, 'tables', true) && user.role !== 'MANAGER') return forbidden()
  const body = await req.json().catch(() => null)
  if (!body?.name) return fail('Ime mize je obvezno.')
  const table = await db.table.create({
    data: {
      name: String(body.name),
      zone: String(body.zone || 'Glavna dvorana'),
      seats: Number(body.seats) || 4,
      posX: Number(body.posX) || 40,
      posY: Number(body.posY) || 40,
      locationId: user.loc || (await db.location.findFirst())?.id || '',
    },
  })
  return ok({ table }, 201)
}
