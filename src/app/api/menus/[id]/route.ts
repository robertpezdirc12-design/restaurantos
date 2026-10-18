import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapMenuItem, num, jstr, nid } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { validateStationsForLocation } from '@/lib/station-task-service'
import { findDuplicateDisplayName, dupItemNameMessage } from '@/lib/menu-dup'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Issue #4 §1: inline role check → kanonično dovoljenje menu.manage
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const data: Record<string, unknown> = {}
  if (body?.available !== undefined) data.isAvailable = Boolean(body.available)
  if (body?.price !== undefined) data.price = Number(body.price)
  if (body?.name) data.name = String(body.name)
  if (body?.vatRate !== undefined) data.vatRate = Number(body.vatRate)
  // Issue #14 (v1.112.0): usmerjanje artikla — primarna postaja (id, strežniško
  // preverjena na lokacijo artikla) + dodatne postaje (stationIds — ZAMENJA celoten nabor)
  const routingChange = body?.prepStationId !== undefined || body?.stationIds !== undefined
  if (body?.prepStationId !== undefined) {
    if (body.prepStationId === null || body.prepStationId === '') data.prepStationId = null
    else if (typeof body.prepStationId === 'string') data.prepStationId = body.prepStationId.trim()
    else return fail('prepStationId mora biti id postaje ali null.')
  }
  if (Object.keys(data).length === 0 && !routingChange) return fail('Ni sprememb.')
  // Issue #4 §1: artikel menija je location-scoped prek lanca do Menu.locationId
  const existing = await db.menuItem.findUnique({
    where: { id },
    select: { categoryId: true, Category: { select: { Menu: { select: { locationId: true } } } } },
  })
  if (!existing) return fail('Artikel ne obstaja.', 404)
  const locRes = await guardResource(user, existing.Category?.Menu?.locationId)
  if (locRes) return locRes
  // ISSUE #73 audit-15: preimenovanje na podvojeno prikazno ime V ISTI kategoriji
  // je zavrnjeno (409) — isti varovalki kot pri ustvarjanju, normalizacija enaka.
  if (typeof data.name === 'string' && data.name.trim()) {
    const siblings = await db.menuItem.findMany({
      where: { categoryId: existing.categoryId },
      select: { id: true, name: true, price: true },
    })
    const dupe = findDuplicateDisplayName(
      siblings.map((s) => ({ id: s.id, name: s.name, price: Number(s.price) })),
      data.name,
      id,
    )
    if (dupe) return fail(dupItemNameMessage(dupe), 409)
  }
  const itemLocationId = existing.Category?.Menu?.locationId ?? null
  if (itemLocationId && typeof data.prepStationId === 'string' && data.prepStationId) {
    const ps = await db.prepStation.findUnique({ where: { id: data.prepStationId }, select: { id: true, locationId: true } })
    if (!ps || ps.locationId !== itemLocationId) return fail('Postaja ne obstaja na tej lokaciji.', 400)
  }
  let newStationIds: string[] | null = null
  if (body?.stationIds !== undefined) {
    if (!itemLocationId) return fail('Lokacija artikla ni znana — usmerjanje ni mogoče.', 400)
    const check = await validateStationsForLocation(body.stationIds, itemLocationId)
    if (!check.ok) return fail(check.error, check.status)
    newStationIds = check.ids.filter((sid) => sid !== (data.prepStationId ?? undefined))
  }
  const item = await db.menuItem.update({ where: { id }, data, include: { PrepStation: true, Category: true } })
  // zamenjava nabora dodatnih postaj (replace-set semantika; idempotentna)
  if (newStationIds !== null && itemLocationId) {
    try {
      await db.$transaction(async (tx) => {
        await tx.menuItemStation.deleteMany({ where: { menuItemId: id } })
        if (newStationIds && newStationIds.length > 0) {
          await tx.menuItemStation.createMany({
            data: (newStationIds as string[]).map((sid) => ({ id: nid(), menuItemId: id, stationId: sid, locationId: itemLocationId as string })),
          })
        }
      })
    } catch {
      // DDL pending — usmeritev se aktivira po migrate-kds-stations
    }
  }
  // 33-c (audit §6): urejanje artikla menija je zdaj revidirano (prej brez revizije)
  await writeAudit(db, { userId: user.sub, action: 'MENU_ITEM_UPDATE', entityType: 'MenuItem', entityId: id, details: jstr({ changed: Object.keys(data), name: item.name, ...(routingChange ? { prepStationId: data.prepStationId ?? item.prepStationId, stationIds: newStationIds } : {}) }), locationId: itemLocationId })
  let stationIds: string[] = []
  try {
    stationIds = (await db.menuItemStation.findMany({ where: { menuItemId: id }, select: { stationId: true } })).map((r) => r.stationId)
  } catch {
    // DDL pending
  }
  return ok({ item: mapMenuItem({ ...item, prepStation: item.PrepStation }), prepStationId: item.prepStationId, stationIds })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Issue #4 §1: inline role check → kanonično dovoljenje menu.manage
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const { id } = await params
  // Issue #4 §1: brisanje samo artiklov lastne lokacije (lanec do Menu.locationId)
  const existing = await db.menuItem.findUnique({
    where: { id },
    select: { name: true, Category: { select: { Menu: { select: { locationId: true } } } } },
  })
  if (!existing) return fail('Artikel ne obstaja.', 404)
  const locRes = await guardResource(user, existing.Category?.Menu?.locationId)
  if (locRes) return locRes
  const inUse = await db.orderItem.count({ where: { menuItemId: id } })
  if (inUse > 0) return fail('Artikel je že uporabljen v naročilih — nastavi kot "Ni na voljo".', 409)
  await db.menuItem.delete({ where: { id } })
  // 33-c (audit §6): brisanje artikla menija je zdaj revidirano (prej brez revizije)
  await writeAudit(db, { userId: user.sub, action: 'MENU_ITEM_DELETE', entityType: 'MenuItem', entityId: id, details: jstr({ name: existing.name }), locationId: existing.Category?.Menu?.locationId ?? null })
  return ok({ deleted: true })
}
