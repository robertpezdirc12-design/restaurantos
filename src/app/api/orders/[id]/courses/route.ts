import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * OPS-7 (v1.68.0) — COURSING (tečaji jedi, Toast/Lightspeed vzorec).
 *
 * POST /api/orders/[id]/courses  body: {itemIds?: string[], name?: string}
 *  - brez itemIds → ustvari naslednji tečaj (courseNumber = max+1, ime po vrsti jedi)
 *  - z itemIds    → ustvari tečaj in mu DODELI izbrane pending postavke
 *                   (postavke, ki so že fired/preparing/ready/served, NI mogoče dodeliti)
 *
 * PATCH /api/orders/[id]/courses body: {courseId, itemIds} → dodeli postavke OBSTOJEČEMU tečaju
 * GET   → tečaji + postavke (za urejevalnik naročila)
 *
 * Fire po tečaju gre prek obstoječega /api/orders/[id]/fire {courseId}.
 */
const COURSE_NAMES_DEFAULT = ['Predjed', 'Glavna jed', 'Sladica', 'Priloga', 'Skica']

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id }, include: { Course: true, OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  return ok({
    courses: order.Course
      .sort((a, b) => a.courseNumber - b.courseNumber)
      .map((c) => ({
        id: c.id,
        courseNumber: c.courseNumber,
        name: c.name,
        status: c.status,
        firedAt: c.firedAt,
        readyAt: c.readyAt,
      })),
    items: order.OrderItem.filter((it) => !it.voided).map((it) => ({
      id: it.id,
      name: it.menuItemName,
      quantity: it.quantity,
      status: it.status,
      courseId: it.courseId,
    })),
  })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const itemIds = Array.isArray(body?.itemIds)
    ? [...new Set((body.itemIds as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
    : []
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : ''

  const order = await db.order.findUnique({ where: { id }, include: { Course: true, OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  if (order.status === 'paid' || order.status === 'cancelled') {
    return fail('Zaključenemu naročilu ni mogoče dodati tečajev.', 409)
  }
  if (order.Course.length >= 8) return fail('Največ 8 tečajev na naročilo.', 400)

  const maxNumber = order.Course.reduce((m, c) => Math.max(m, c.courseNumber), 0)
  const nextNumber = maxNumber + 1

  if (itemIds.length > 0) {
    const selected = order.OrderItem.filter((it) => itemIds.includes(it.id) && !it.voided)
    if (selected.length === 0) return fail('Nobena izbrana postavka ni primerna (pending, ne-voided, to naročilo).', 400)
    const notPending = selected.filter((it) => it.status !== 'pending')
    if (notPending.length > 0) {
      return fail(`Postavke, ki so že poslane v pripravo, ni mogoče dodeliti tečaju (${notPending.length} kos).`, 409)
    }
  }

  const course = await db.$transaction(async (tx) => {
    const created = await tx.course.create({
      data: {
        id: nid(),
        orderId: id,
        courseNumber: nextNumber,
        name: name || COURSE_NAMES_DEFAULT[Math.min(nextNumber - 1, COURSE_NAMES_DEFAULT.length - 1)] || `Tečaj ${nextNumber}`,
        status: 'pending',
      },
    })
    if (itemIds.length > 0) {
      await tx.orderItem.updateMany({
        where: { id: { in: itemIds }, orderId: id, status: 'pending', voided: false },
        data: { courseId: created.id },
      })
    }
    await writeAudit(tx, { userId: user.sub, action: 'ORDER_COURSE_CREATE', entityType: 'Order', entityId: id, details: jstr({ courseId: created.id, courseNumber: nextNumber, name: created.name, items: itemIds.length, by: user.name }), locationId: order.locationId })
    return created
  })

  return ok({ course: { id: course.id, courseNumber: course.courseNumber, name: course.name } })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const courseId = typeof body?.courseId === 'string' ? body.courseId.trim() : ''
  const itemIds = Array.isArray(body?.itemIds)
    ? [...new Set((body.itemIds as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
    : []
  const newName = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : ''
  if (!courseId) return fail('courseId je obvezen.', 400)

  const order = await db.order.findUnique({ where: { id }, include: { Course: true, OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  const course = order.Course.find((c) => c.id === courseId)
  if (!course) return fail('Tečaj ne obstaja za to naročilo.', 404)
  if (course.status !== 'pending') return fail('Tečaj je že poslan v pripravo — postavk ni mogoče spreminjati.', 409)

  if (itemIds.length > 0) {
    const selected = order.OrderItem.filter((it) => itemIds.includes(it.id) && !it.voided)
    const notPending = selected.filter((it) => it.status !== 'pending')
    if (notPending.length > 0) {
      return fail(`Postavke, ki so že poslane v pripravo, ni mogoče dodeliti tečaju (${notPending.length} kos).`, 409)
    }
    await db.orderItem.updateMany({
      where: { id: { in: itemIds }, orderId: id, status: 'pending', voided: false },
      data: { courseId },
    })
  }
  if (newName && newName !== course.name) {
    await db.course.update({ where: { id: courseId }, data: { name: newName } })
  }

  return ok({ updated: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const courseId = typeof body?.courseId === 'string' ? body.courseId.trim() : ''
  if (!courseId) return fail('courseId je obvezen.', 400)

  const order = await db.order.findUnique({ where: { id }, include: { Course: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  const course = order.Course.find((c) => c.id === courseId)
  if (!course) return fail('Tečaj ne obstaja za to naročilo.', 404)
  if (course.status !== 'pending') return fail('Poslanega tečaja ni mogoče izbrisati.', 409)

  await db.$transaction(async (tx) => {
    await tx.orderItem.updateMany({ where: { courseId }, data: { courseId: null } })
    await tx.course.delete({ where: { id: courseId } })
  })
  return ok({ deleted: true })
}
