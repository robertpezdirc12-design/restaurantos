import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { labelTablesReady } from '@/lib/label-schema'
import { LABEL_RULE_HOURS_MAX } from '@/lib/label'

/**
 * Issue #24 — POTRDENA pravila roka po pripravi/odprtju (LabelShelfRule, po
 * artiklu). Filozofija #15: IZRECNOST — sistem NIKOLI ne izmisli števila dni;
 * pravilo potrdi oseba z inventory.manage (revizijska sled LABEL_RULE_CONFIRMED).
 *
 * GET /api/labels/rules — seznam pravil (+ imena artiklov).
 * PUT /api/labels/rules { inventoryItemId, shelfLifeHours: number | null, note? }
 *   - shelfLifeHours: 0..8760 (0 = IZRECNO "rok ni določen");
 *   - null = IZBRIŠI pravilo (LABEL_RULE_REMOVED);
 *   - upsert + confirmedBy/confirmedAt (potrditev).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await labelTablesReady())) {
    return fail('Etikete čakajo na shemsko migracijo (Enterprise → Shema migracije → prep-labels).', 503)
  }
  const rules = await db.labelShelfRule.findMany({ orderBy: { updatedAt: 'desc' }, take: 500 })
  const itemIds = [...new Set(rules.map((r) => r.inventoryItemId))]
  const items = itemIds.length
    ? await db.inventoryItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, name: true, unit: true },
      })
    : []
  const itemById = new Map(items.map((i) => [i.id, i]))
  return ok({
    rules: rules.map((r) => ({
      id: r.id,
      inventoryItemId: r.inventoryItemId,
      itemName: itemById.get(r.inventoryItemId)?.name ?? '',
      itemUnit: itemById.get(r.inventoryItemId)?.unit ?? '',
      shelfLifeHours: r.shelfLifeHours,
      note: r.note,
      confirmedByName: r.confirmedByName,
      confirmedAt: r.confirmedAt,
    })),
  })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await labelTablesReady())) {
    return fail('Etikete čakajo na shemsko migracijo (Enterprise → Shema migracije → prep-labels).', 503)
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Neveljavno telo zahtevka.', 400)
  const itemId = typeof body.inventoryItemId === 'string' ? body.inventoryItemId.trim() : ''
  if (!itemId) return fail('Manjka inventoryItemId.', 400)
  const item = await db.inventoryItem.findUnique({
    where: { id: itemId },
    select: { id: true, name: true, locationId: true },
  })
  if (!item) return fail('Artikel ne obstaja.', 404)
  const locErr = await guardResource(user, item.locationId)
  if (locErr) return locErr
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''

  if (body.shelfLifeHours === null || body.shelfLifeHours === undefined) {
    const existing = await db.labelShelfRule.findUnique({ where: { inventoryItemId: itemId } })
    if (!existing) return ok({ removed: false, inventoryItemId: itemId })
    await db.labelShelfRule.delete({ where: { id: existing.id } })
    await writeAudit(db, {
      userId: user.sub,
      action: 'LABEL_RULE_REMOVED',
      entityType: 'LabelShelfRule',
      entityId: existing.id,
      details: jstr({ inventoryItemId: itemId, itemName: item.name, formerHours: existing.shelfLifeHours }),
      locationId: user.loc ?? null,
    })
    return ok({ removed: true, inventoryItemId: itemId })
  }

  const hours = Number(body.shelfLifeHours)
  if (!Number.isInteger(hours) || hours < 0 || hours > LABEL_RULE_HOURS_MAX) {
    return fail(`Ure roka morajo biti celo število med 0 in ${LABEL_RULE_HOURS_MAX}.`, 400)
  }
  const now = new Date()
  const saved = await db.labelShelfRule.upsert({
    where: { inventoryItemId: itemId },
    create: {
      id: nid(),
      inventoryItemId: itemId,
      shelfLifeHours: hours,
      note,
      confirmedById: user.sub,
      confirmedByName: user.name,
      confirmedAt: now,
    },
    update: {
      shelfLifeHours: hours,
      note,
      confirmedById: user.sub,
      confirmedByName: user.name,
      confirmedAt: now,
    },
  })
  await writeAudit(db, {
    userId: user.sub,
    action: 'LABEL_RULE_CONFIRMED',
    entityType: 'LabelShelfRule',
    entityId: saved.id,
    details: jstr({ inventoryItemId: itemId, itemName: item.name, shelfLifeHours: hours, note }),
    locationId: user.loc ?? null,
  })
  return ok({
    rule: {
      id: saved.id,
      inventoryItemId: itemId,
      itemName: item.name,
      shelfLifeHours: hours,
      note,
      confirmedByName: user.name,
      confirmedAt: saved.confirmedAt,
    },
  })
}
