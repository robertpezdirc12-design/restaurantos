/**
 * Dostavne cone (issue #2): seznam + ustvarjanje + urejanje (pristojbina, minimalni
 * znesek, aktivnost). Uporablja obstoječi DeliveryZone model — ne podvaja.
 */
import { NextRequest } from 'next/server'
import { ok, fail, requirePermission, isResponse } from '@/lib/api'
import { db } from '@/lib/db'
import { nid, num, mapDeliveryZone } from '@/lib/map'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const zones = await db.deliveryZone.findMany({ orderBy: { sortOrder: 'asc' } })
  return ok({ zones: zones.map(mapDeliveryZone) })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const b = (await req.json().catch(() => null)) as {
    name?: string
    deliveryFee?: number
    minOrderAmount?: number
    estimatedMinutes?: number
    postCodes?: string[]
  } | null
  if (!b?.name?.trim()) return fail('Ime cone je obvezno.', 400)

  const zone = await db.deliveryZone.create({
    data: {
      id: nid(),
      name: b.name.trim().slice(0, 80),
      deliveryFee: num(b.deliveryFee, 2.5),
      minOrderAmount: num(b.minOrderAmount, 10),
      estimatedMinutes: Math.max(5, Math.round(num(b.estimatedMinutes, 30))),
      postCodes: JSON.stringify((b.postCodes || []).slice(0, 50)),
      isActive: true,
      sortOrder: (await db.deliveryZone.count()) + 1,
    },
  })
  await db.auditLog.create({
    data: {
      id: nid(), userId: user.sub, action: 'DELIVERY_ZONE_CREATE',
      entityType: 'DeliveryZone', entityId: zone.id,
      details: JSON.stringify({ name: zone.name }),
    },
  }).catch(() => null)
  return ok({ zone: mapDeliveryZone(zone) }, 201)
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const b = (await req.json().catch(() => null)) as {
    id?: string
    deliveryFee?: number
    minOrderAmount?: number
    estimatedMinutes?: number
    isActive?: boolean
    name?: string
  } | null
  if (!b?.id) return fail('Manjka id cone.', 400)

  const existing = await db.deliveryZone.findUnique({ where: { id: b.id } })
  if (!existing) return fail('Cona ne obstaja.', 404)

  const zone = await db.deliveryZone.update({
    where: { id: b.id },
    data: {
      ...(b.deliveryFee !== undefined ? { deliveryFee: num(b.deliveryFee, num(existing.deliveryFee)) } : {}),
      ...(b.minOrderAmount !== undefined ? { minOrderAmount: num(b.minOrderAmount, num(existing.minOrderAmount)) } : {}),
      ...(b.estimatedMinutes !== undefined ? { estimatedMinutes: Math.max(5, Math.round(num(b.estimatedMinutes, existing.estimatedMinutes))) } : {}),
      ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
      ...(b.name?.trim() ? { name: b.name.trim().slice(0, 80) } : {}),
    },
  })
  await db.auditLog.create({
    data: {
      id: nid(), userId: user.sub, action: 'DELIVERY_ZONE_UPDATE',
      entityType: 'DeliveryZone', entityId: zone.id,
      details: JSON.stringify({ fee: num(zone.deliveryFee), active: zone.isActive }),
    },
  }).catch(() => null)
  return ok({ zone: mapDeliveryZone(zone) })
}
