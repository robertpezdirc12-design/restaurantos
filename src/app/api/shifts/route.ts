import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { mapShift, nid, num } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const shifts = await db.cashRegisterShift.findMany({
    include: { Employee: { select: { name: true, role: true } } },
    orderBy: { openedAt: 'desc' },
    take: 30,
  })
  return ok({ shifts: shifts.map((s) => mapShift({ ...s, employee: s.Employee ?? null })) })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)

  if (body?.action === 'stop') {
    const open = await db.cashRegisterShift.findFirst({
      where: { employeeId: user.sub, status: 'open' },
      orderBy: { openedAt: 'desc' },
    })
    if (!open) return fail('Ni odprte izmene.')
    const closingCash = num(body.closingCash)
    const shift = await db.cashRegisterShift.update({
      where: { id: open.id },
      data: {
        status: 'closed',
        closedAt: new Date(),
        closingCash,
        expectedCash: closingCash,
      },
    })
    return ok({ shift: mapShift({ ...shift, employee: null }) })
  }

  const open = await db.cashRegisterShift.findFirst({ where: { employeeId: user.sub, status: 'open' } })
  if (open) return fail('Izmena že teče.')
  const locationId = user.loc || (await db.location.findFirst())?.id || null
  const shift = await db.cashRegisterShift.create({
    data: {
      id: nid(),
      employeeId: user.sub,
      employeeName: user.name,
      status: 'open',
      startingCash: num(body?.openingCash),
      locationId,
    },
  })
  return ok({ shift: mapShift({ ...shift, employee: null }) }, 201)
}
