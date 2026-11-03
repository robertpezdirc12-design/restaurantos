import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Detail + vnos popisa. Branje = requireAuth (isti sloj kot GET /api/inventory),
 * pisanje = 'inventory.manage'. Org meja: guardResource (Task 52 točkovna ruta).
 * Vnosi samo v DRAFT (oddan popis je zaklenjen → 409; recount ga ponovno odpre).
 * countedQuantity == null pomeni "počisti vnos" (recount primer — reset vrstice).
 * Map funkciji sta LOKALNI (Next route handlerji niso modul za medsebojni import;
 * zavestna duplikacija z route.ts — varnost čistih datotek pred refaktorjem).
 *
 * Issue #66 (P1) — SERIALIZACIJA z submit/cancel/recount (prej: status je bil
 * preverjen ZUNAJ transakcije, vrstice pa posodobljene znotraj nje — submit,
 * ki je zmagal med PATCH-validacijo in PATCH-zapisom, bi pustil ODDAN popis z
 * novimi količinami). Zdaj: claim + zapisi v ENI transakciji —
 *  - claim: updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'DRAFT' } })
 *    pridobi zaklep vrstice Stocktake (PG: row lock do commita; SQLite: en sam
 *    pisatelj) in hkrati preveri, da je status ŠE VEDNO DRAFT → 0 vrstic = 409
 *    brez kakršnega koli zapisa;
 *  - submit/cancel/recount se serializirajo z istim zaklepom: če PATCH zmagá,
    submit zaklene TOČNO shranjene količine; če submit zmagá prej, PATCH dobi
 *    409 in ne zapiše NIČ (fail-closed);
 *  - vrstice se posodabljajo z VEZAVO stocktakeId v sami mutaciji (updateMany,
 *    count 0 = napad/premik → rollback);
 *  - audit STOCKTAKE_ITEMS_SAVED šele PO uspešnem commitu (zavrnjen pozni PATCH
 *    se ne predstavi kot uspešno štetje).
 */

/** #66: zaklenjen popis (SUBMITTED/CANCELLED/APPROVED) → 409, rollback. */
class StocktakeLockedError extends Error {}

type StItem = {
  id: string; inventoryItemId: string; itemName: string; unit: string
  expectedQuantity: unknown; costPerUnit: unknown; countedQuantity: unknown
  varianceQuantity: unknown; varianceValue: unknown; lineNote: string
  countedAt: Date | null; countedByName: string; stockTransactionId: string | null
}

/** v1.242.0: serijski kontekst vrstice (samo za branje — šteje se AGREGAT,
 * lot-i so informacija števca: kateri rok, koliko katere serije). */
interface StItemBatches {
  id: string
  lotNumber: string
  expiryDate: Date | string | null
  quantityRemaining: number
  status: string
}

function mapItem(i: StItem, batchesByItem?: Map<string, StItemBatches[]>) {
  const countedQty = i.countedQuantity == null ? null : num(i.countedQuantity)
  return {
    id: i.id,
    inventoryItemId: i.inventoryItemId,
    name: i.itemName,
    unit: i.unit,
    expectedQty: num(i.expectedQuantity),
    costPerUnit: num(i.costPerUnit),
    countedQty,
    // v1.242.0: shranjena variansa je TEORETIČNA (counted − expected − neto
    // gibanja med štetjem — glej approve); proti-snapshot variansa je iz
    // shranjenih številcev izračunljiva TUKAJ (oba števca obstaneta za vedno).
    varianceQty: i.varianceQuantity == null ? null : num(i.varianceQuantity),
    varianceVsSnapshotQty: countedQty == null ? null : Math.round((countedQty - num(i.expectedQuantity)) * 1000) / 1000,
    varianceValue: i.varianceValue == null ? null : num(i.varianceValue),
    note: i.lineNote,
    countedAt: i.countedAt,
    countedBy: i.countedByName || null,
    stockTransactionId: i.stockTransactionId,
    // v1.242.0: serije artikla (lot, rok, ostanek) — kontekst štetja
    batches: batchesByItem?.get(i.inventoryItemId) ?? [],
  }
}

function mapFull(
  s: {
    id: string; locationId: string; status: string; note: string
    createdByName: string; approvedByName: string
    submittedAt: Date | null; approvedAt: Date | null; cancelledAt: Date | null
    recountCount: number; createdAt: Date
    StocktakeItem: StItem[]
  },
  batchesByItem?: Map<string, StItemBatches[]>,
) {
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
    // v1.242.0: osnova variance v odgovoru (approve zapiše TEORETIČNO variantso —
    // proti snapshotu + neto gibanjem; starejši popisi pred valom so proti
    // snapshotu — razliko med njima pokaže varianceVsSnapshotQty per vrstica)
    varianceBasis: 'theoretical',
    items: items.map((i) => mapItem(i, batchesByItem)),
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

  // v1.242.0: serijski kontekst vrstic — ne-izčrpane serije artikelov popisa
  // (lot, rok, ostanek, status). Šteje se agregat; lot-i so priročnost števca
  // (FEFO kontekst ob štetju, HACCP sledljivost). En poizvedek, grupirano.
  const itemIds = [...new Set(st.StocktakeItem.map((i) => i.inventoryItemId))]
  const batchRows = itemIds.length
    ? await db.inventoryBatch.findMany({
        where: { inventoryItemId: { in: itemIds }, status: { not: 'EXHAUSTED' } },
        select: { id: true, inventoryItemId: true, lotNumber: true, expiryDate: true, quantityRemaining: true, status: true },
        orderBy: [{ expiryDate: 'asc' }, { receivedAt: 'asc' }],
        take: 500,
      })
    : []
  const batchesByItem = new Map<string, StItemBatches[]>()
  for (const b of batchRows) {
    const list = batchesByItem.get(b.inventoryItemId) || []
    list.push({ id: b.id, lotNumber: b.lotNumber, expiryDate: b.expiryDate, quantityRemaining: num(b.quantityRemaining), status: b.status })
    batchesByItem.set(b.inventoryItemId, list)
  }

  return ok({ stocktake: mapFull(st, batchesByItem) })
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

  // #66: claim DRAFT + zapisi vrstic v ENI transakciji (serializacija s submit/
  // cancel/recount — glej glavo datoteke). Padec katerega koli koraka → rollback,
  // oddan popis ne dobi poznilh sprememb.
  try {
    const saved = await db.$transaction(async (tx) => {
      // claim: UPDATE pridobi zaklep vrstice Stocktake (updatedAt se osveži;
      // namerno istovetna vrednost statusa) — 0 vrstic = status se je spremenil
      const claim = await tx.stocktake.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'DRAFT' },
      })
      if (claim.count === 0) throw new StocktakeLockedError()
      for (const it of items) {
        const raw = it?.countedQuantity
        const counted = raw == null ? null : Number(String(raw).replace(',', '.'))
        // vezava stocktakeId v SAMI mutaciji (count 0 → fail-closed rollback)
        const upd = await tx.stocktakeItem.updateMany({
          where: { id: String(it.id), stocktakeId: id },
          data: {
            countedQuantity: counted,
            countedAt: counted == null ? null : new Date(),
            countedByName: counted == null ? '' : user.name,
            lineNote: String(it?.lineNote ?? '').slice(0, 200),
          },
        })
        if (upd.count === 0) throw new StocktakeLockedError()
      }
      return items.length
    })
    // #66: audit odraža SAMO dovoljene spremembe — zapis po uspešnem commitu
    await writeAudit(db, {
      userId: user.sub,
      action: 'STOCKTAKE_ITEMS_SAVED',
      entityType: 'Stocktake',
      entityId: id,
      details: jstr({ saved, by: user.name }),
      locationId: st.locationId,
    })
    return ok({ id, saved })
  } catch (e) {
    if (e instanceof StocktakeLockedError) {
      return fail('Popis ni več v osnutku (že oddan, potrjen ali preklican) — sprememba zavrnjena.', 409)
    }
    throw e
  }
}
