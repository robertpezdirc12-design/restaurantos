import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const shifts = await db.shift.findMany({
    include: { employee: { select: { name: true, role: true } } },
    orderBy: { startedAt: 'desc' },
    take: 30,
  })
  return ok({ shifts })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)

  if (body?.action === 'stop') {
    const open = await db.shift.findFirst({
      where: { employeeId: user.sub, endedAt: null },
      orderBy: { startedAt: 'desc' },
    })
    if (!open) return fail('Ni odprte izmene.')
    const shift = await db.shift.update({
      where: { id: open.id },
      data: { endedAt: new Date(), closingCash: Number(body.closingCash) || 0 },
    })
    return ok({ shift })
  }

  const open = await db.shift.findFirst({ where: { employeeId: user.sub, endedAt: null } })
  if (open) return fail('Izmena že teče.')
  const shift = await db.shift.create({
    data: {
      employeeId: user.sub,
      locationId: user.loc || (await db.location.findFirst())?.id || '',
      openingCash: Number(body?.openingCash) || 0,
    },
  })
  return ok({ shift }, 201)
}
