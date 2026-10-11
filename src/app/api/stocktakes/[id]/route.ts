import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num } from '@/lib/map'

/**
 * Detail + vnos popisa. Branje = requireAuth (isti sloj kot GET /api/inventory),
 * pisanje = 'inventory.manage'. Org meja: guardResource (Task 52 točkovna ruta).
 * Vnosi samo v DRAFT (oddan popis je zaklenjen → 409; recount ga ponovno odpre).
 * countedQuantity == null pomeni "počisti vnos" (recount primer — reset vrstice).
 * Map funkciji sta LOKALNI (Next route handlerji niso modul za medsebojni import;
 * zavestna duplikacija z route.ts — varnost čistih datotek pred refaktorjem).
 */

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

function mapFull(s: {
  id: string; locationId: string; status: string; note: string
  createdByName: string; approvedByName: string
  submittedAt: Date | null; approvedAt: Date | null; cancelledAt: Date | null
  recountCount: number; createdAt: Date
  StocktakeItem: StItem[]
}) {
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
    items: items.map(mapItem),
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(_req)
  if (isResponse(user)) return user
  const { id } = await params
  const st = await db.stocktake.findUnique({ where: { id }, include: { StocktakeItem: { orderBy: { itemName: 'asc' } } } })
  if (!st) return fail('Popis ne obstaja.', 404)
  const guard = await guardResource(user, st.locationId)
  if (guard) return guard
  return ok({ stocktake: mapFull(st) })
}

/** Shrani vnose (samo DRAFT). countedQuantity == null = počisti vnos vrstice. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const st = await db.stocktake.findUnique({ where: { id }, select: { id: true, locationId: true, status: true } })
  if (!st) return fail('Popis ne obstaja.', 404)
  const guard = await guardResource(user, st.locationId)
  if (guard) return guard
  if (st.status !== 'DRAFT') return fail('Vnosi so mogoči samo v osnutku — popis je oddan ali zaključen.', 409)

  const body = await req.json().catch(() => null)
  const items = Array.isArray(body?.items) ? body.items.slice(0, 300) : []
  if (items.length === 0) return fail('Ni vnosov za shraniti.', 400)

  const lineIds = items.map((it) => String(it?.id || ''))
  const lines = await db.stocktakeItem.findMany({ where: { id: { in: lineIds }, stocktakeId: id }, select: { id: true } })
  if (new Set(lines.map((l) => l.id)).size !== new Set(lineIds).size) {
    return fail('Ena ali več vrstic ne pripada temu popisu.', 400)
  }

  for (const it of items) {
    const raw = it?.countedQuantity
    const counted = raw == null ? null : Number(String(raw).replace(',', '.'))
    if (counted != null && (!Number.isFinite(counted) || counted < 0)) {
      return fail('Prešteta količina ne sme biti negativna ali neštevilčna.', 400)
    }
  }

  const ops = items.map((it) => {
    const raw = it?.countedQuantity
    const counted = raw == null ? null : Number(String(raw).replace(',', '.'))
    return db.stocktakeItem.update({
      where: { id: String(it.id) },
      data: {
        countedQuantity: counted,
        countedAt: counted == null ? null : new Date(),
        countedByName: counted == null ? '' : user.name,
        lineNote: String(it?.lineNote ?? '').slice(0, 200),
      },
    })
  })
  await db.$transaction(ops)

  return ok({ id, saved: items.length })
}
