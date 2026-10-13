import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, requireUserLocation, isResponse, ok, fail, locationScope } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { num, nid, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Inventura (popis zaloge) — audit §7 "Zaloga: inventura PARTIAL (ni protokola)".
 * Shema (Stocktake + StocktakeItem) obstaja od začetka, a brez rute/UI — Task 57
 * jo aktivira BREZ DDL (117 modelov = 117 tabel v produkciji, drift zelen).
 *
 * Ciklus: DRAFT (odpri — snapshot) → SUBMITTED (oddaj) → APPROVED (potrdi —
 * inventurni popravek v transakciji) | CANCELLED; recount: SUBMITTED → DRAFT.
 * Branje = requireAuth, pisanje = 'inventory.manage' (N3). Org meja: POST prek
 * requireUserLocation + assertOrgScope (Task 52 CREATE vzorec), seznami prek
 * locationScope (Task 54), točkovne rute prek guardResource.
 * Semantika: expectedQuantity = snapshot ob odprtju; odobritev nastavi
 * quantity := countedQuantity (inventurni popravek, vzorec setQty R4);
 * varianceQuantity = counted − expected (analitika proti snapshotu).
 */

const OPEN_STATUSES = ['DRAFT', 'SUBMITTED'] as const

type StItem = {
  id: string; inventoryItemId: string; itemName: string; unit: string
  expectedQuantity: unknown; costPerUnit: unknown; countedQuantity: unknown
  varianceQuantity: unknown; varianceValue: unknown; lineNote: string
  countedAt: Date | null; countedByName: string; stockTransactionId: string | null
}

function mapItem(i: StItem) {
  return {
    id: i.id,
    inventoryItemId: i.inventoryItemId,
    name: i.itemName,
    unit: i.unit,
    expectedQty: num(i.expectedQuantity),
    costPerUnit: num(i.costPerUnit),
    countedQty: i.countedQuantity == null ? null : num(i.countedQuantity),
    varianceQty: i.varianceQuantity == null ? null : num(i.varianceQuantity),
    varianceValue: i.varianceValue == null ? null : num(i.varianceValue),
    note: i.lineNote,
    countedAt: i.countedAt,
    countedBy: i.countedByName || null,
    stockTransactionId: i.stockTransactionId,
  }
}

type StBase = {
  id: string; locationId: string; status: string; note: string
  createdByName: string; approvedByName: string
  submittedAt: Date | null; approvedAt: Date | null; cancelledAt: Date | null
  recountCount: number; createdAt: Date
  StocktakeItem: StItem[]
}

function mapStocktakeSummary(s: Omit<StBase, 'StocktakeItem'> & { StocktakeItem: Array<{ countedQuantity: unknown; varianceValue: unknown }> }) {
  const items = s.StocktakeItem ?? []
  const counted = items.filter((i) => i.countedQuantity != null).length
  const varianceValue = items.reduce((a, i) => a + (i.varianceValue == null ? 0 : num(i.varianceValue)), 0)
  return {
    id: s.id,
    locationId: s.locationId,
    status: s.status,
    note: s.note,
    createdByName: s.createdByName,
    approvedByName: s.approvedByName || null,
    submittedAt: s.submittedAt,
    approvedAt: s.approvedAt,
    cancelledAt: s.cancelledAt,
    recountCount: s.recountCount,
    createdAt: s.createdAt,
    counted,
    total: items.length,
    varianceValue,
  }
}

function mapStocktakeFull(s: StBase) {
  return { ...mapStocktakeSummary(s), items: s.StocktakeItem.map(mapItem) }
}

/** Seznam popisov (lokacijski + org obseg — Task 54 async locationScope). */
export async function GET(req: NextRequest) {
  // Issue #5 (P0, komentar #4): bralna pravica domene — inventory.manage (zaloge-tab),
  // prej requireAuth (vsak prijavljeni je videl varianceValue popisov)
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const rows = await db.stocktake.findMany({
    where: await locationScope(user),
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { StocktakeItem: { select: { countedQuantity: true, varianceValue: true } } },
  })
  return ok({ stocktakes: rows.map((r) => mapStocktakeSummary(r)) })
}

/** Odpri nov popis: snapshot artiklov lokacije. Največ EN odprt popis na lokacijo. */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const locRes = requireUserLocation(user, body?.locationId)
  if (isResponse(locRes)) return locRes
  const locationId = locRes
  const org = await assertOrgScope(user, locationId)
  if (org) return org

  const idempotencyKey = typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim().slice(0, 64) : null
  if (idempotencyKey) {
    const existing = await db.stocktake.findFirst({ where: { idempotencyKey }, include: { StocktakeItem: true } })
    if (existing) return ok({ stocktake: mapStocktakeFull(existing), replayed: true }, 200)
  }

  const open = await db.stocktake.findFirst({ where: { locationId, status: { in: [...OPEN_STATUSES] } }, select: { id: true } })
  if (open) return fail('Na tej lokaciji že poteka popis — najprej ga zaključi ali prekliči.', 409)

  const items = await db.inventoryItem.findMany({ where: { locationId }, orderBy: { name: 'asc' } })
  if (items.length === 0) return fail('Ni artiklov zaloge na tej lokaciji — popis ni mogoč.', 400)

  const id = nid()
  const created = await db.stocktake.create({
    data: {
      id,
      locationId,
      status: 'DRAFT',
      note: String(body?.note || '').slice(0, 500),
      createdByName: user.name,
      idempotencyKey,
      StocktakeItem: {
        create: items.map((it) => ({
          id: nid(),
          inventoryItemId: it.id,
          itemName: it.name,
          unit: it.unit,
          expectedQuantity: it.quantity,
          costPerUnit: it.costPerUnit,
          countedQuantity: null,
          lineNote: '',
        })),
      },
    },
    include: { StocktakeItem: true },
  })

  await writeAudit(db, { userId: user.sub, action: 'STOCKTAKE_OPEN', entityType: 'Stocktake', entityId: id, details: jstr({ locationId, lines: items.length, by: user.name }), locationId: locationId })
  await publishEvent('StocktakeOpened', { entityType: 'Stocktake', entityId: id, payload: { locationId, lines: items.length, by: user.name } }).catch(() => undefined)

  return ok({ stocktake: mapStocktakeFull(created) }, 201)
}
