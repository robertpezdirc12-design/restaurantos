import { nid, num } from '@/lib/map'
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

export interface StockShortfall {
  inventoryItemId: string
  name: string
  requested: number
  available: number
}

export interface StockDeductionResult {
  /** false = replay (ta naročilo je že razknjiženo) — nič se ne odšteje dvakrat */
  deducted: boolean
  lines: number
  totalCost: number
  shortfalls: StockShortfall[]
}

const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Razknjiževanje zalog po recepturah (GitLab issue #1 — "ostalo odprto": zaloge/razknjiževanje).
 *
 * Pokliče se znotraj FURS transakcije ob izdaji računa: za vsak prodani artikel
 * odšteje sestavine po RecipeItem (quantityPerServing × količina) iz agregirane
 * zaloge (InventoryItem.quantity), zapisuje StockTransaction (type='SALE') in
 * po FEFO načelu razporedi odjem tudi na serije (InventoryBatch + StockBatchAllocation).
 *
 * Pravila:
 * - IDEMPOTENTNO: če za orderId že obstaja StockTransaction type='SALE', je replay → brez dvojnega odšteta.
 * - Primanjkljaj NE ustavi prodaje (račun mora iti ven); zapise se kot shortfall + opomba.
 * - voided postavke se izpustijo.
 * - Brez recepture za artikel → nič ne odšteje za ta artikel (receptura ni definirana).
 * - Serije (batches): če za artikel NE obstajajo aktivne serije, se odjem zapiše samo
 *   na agregiran model; če obstajajo, se razporedi FEFO (najzgodnejši datum poteka, nato najstarejši sprejem).
 */
export async function deductStockForOrderTx(
  tx: Tx,
  orderId: string,
  employeeId: string | null,
  employeeName: string
): Promise<StockDeductionResult> {
  const empty: StockDeductionResult = { deducted: false, lines: 0, totalCost: 0, shortfalls: [] }

  // ── Replay zaščita 1: flag na naročilu ──
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, inventoryDeducted: true } })
  if (order?.inventoryDeducted) return empty

  // ── Replay zaščita 2: StockTransaction (orderId, type='SALE') ──
  const existing = await tx.stockTransaction.findFirst({ where: { orderId, type: 'SALE' }, select: { id: true } })
  if (existing) return empty

  const items = await tx.orderItem.findMany({
    where: { orderId, voided: false },
    select: { menuItemId: true, quantity: true },
  })
  if (items.length === 0) return empty

  const menuItemIds = [...new Set(items.map((i) => i.menuItemId))]
  const recipes = await tx.recipeItem.findMany({
    where: { menuItemId: { in: menuItemIds } },
    select: { menuItemId: true, inventoryItemId: true, quantityPerServing: true, unit: true },
  })
  if (recipes.length === 0) return empty

  // ── Agregacija potrebščin po sestavinah ──
  const needed = new Map<string, number>()
  for (const oi of items) {
    for (const r of recipes.filter((x) => x.menuItemId === oi.menuItemId)) {
      const q = r3(num(r.quantityPerServing) * oi.quantity)
      if (q > 0) needed.set(r.inventoryItemId, r3((needed.get(r.inventoryItemId) || 0) + q))
    }
  }
  if (needed.size === 0) return empty

  const invItems = await tx.inventoryItem.findMany({
    where: { id: { in: [...needed.keys()] } },
    select: { id: true, name: true, unit: true, quantity: true, costPerUnit: true },
  })

  let lines = 0
  let totalCost = 0
  const shortfalls: StockShortfall[] = []

  for (const item of invItems) {
    const req = needed.get(item.id) || 0
    const prev = Math.max(0, num(item.quantity))
    const requested = Math.min(req, prev) // ciljani odjem (primanjkljaj ne blokira prodaje)
    const unitCost = num(item.costPerUnit)

    // ── R2 popravek (P0 audit): CAS odštevek — atomarno (quantity >= x → decrement),
    // brez lost update pod sočasnimi računi (prej: read-then-write z absolutno vrednostjo) ──
    let deducted = 0
    const full = await tx.inventoryItem.updateMany({
      where: { id: item.id, quantity: { gte: requested } },
      data: { quantity: { decrement: requested } },
    })
    if (full.count === 1) {
      deducted = requested
    } else {
      // talni odštevek: toliko, kolikor je dejansko na voljo (retry ob sočasnosti)
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await tx.inventoryItem.findUnique({ where: { id: item.id }, select: { quantity: true } })
        const avail = Math.max(0, num(cur?.quantity))
        const take = Math.min(requested, avail)
        if (take <= 0) break
        const res = await tx.inventoryItem.updateMany({
          where: { id: item.id, quantity: { gte: take } },
          data: { quantity: { decrement: take } },
        })
        if (res.count === 1) { deducted = take; break }
      }
    }
    const actual = deducted
    const newQty = r3(prev - actual)
    const shortfall = r3(req - actual)
    const lineCost = r2(unitCost * actual)

    if (shortfall > 0) {
      shortfalls.push({ inventoryItemId: item.id, name: item.name, requested: req, available: prev })
    }

    // ── FEFO serije: razporedi `actual` po serijah (najprej najzgodnejši datum poteka) ──
    const batches = await tx.inventoryBatch.findMany({
      where: { inventoryItemId: item.id, status: 'ACTIVE', quantityRemaining: { gt: 0 } },
      orderBy: [{ expiryDate: 'asc' }, { receivedAt: 'asc' }],
      take: 50,
    })
    const batchStock = batches.reduce((s, b) => s + Math.max(0, num(b.quantityRemaining)), 0)
    const txId = nid()
    const useBatches = batches.length > 0 && batchStock > 0
    const toAllocateFromBatches = useBatches ? Math.min(actual, batchStock) : 0

    // KRITIČEN popravek vrstnega reda (bug odkrit z testi, Task 32-c): alokacije
    // (StockBatchAllocation, FK → StockTransaction) se NE smejo zapisovati, preden
    // obstaja StockTransaction vrstica — sicer P2003 pada CELO plačilno transakcijo
    // (500) za vsak artikel z aktivnimi serijami. Zato: NAČRT alokacij (čista
    // matematika) → zapis StockTransaction → ŠELE nato batch update + alokacije.
    const plannedAllocations: { batchId: string; alloc: number; bNew: number; status: string }[] = []
    if (useBatches) {
      let remaining = toAllocateFromBatches
      for (const b of batches) {
        if (remaining <= 0.0005) break
        let avail = Math.max(0, num(b.quantityRemaining))
        let alloc = Math.min(avail, remaining)
        let ok = false
        // R2 popravek (P0 audit): CAS po seriji (decrement z gte guard + retry)
        for (let attempt = 0; attempt < 3 && alloc > 0.0005; attempt++) {
          const res = await tx.inventoryBatch.updateMany({
            where: { id: b.id, quantityRemaining: { gte: alloc } },
            data: { quantityRemaining: { decrement: alloc } },
          })
          ok = res.count === 1
          if (!ok) {
            const fresh = await tx.inventoryBatch.findUnique({ where: { id: b.id }, select: { quantityRemaining: true } })
            avail = Math.max(0, num(fresh?.quantityRemaining))
            alloc = Math.min(avail, remaining)
          }
        }
        if (!ok || alloc <= 0.0005) continue
        const bNew = r3(avail - alloc)
        plannedAllocations.push({ batchId: b.id, alloc: r3(alloc), bNew, status: bNew <= 0.0005 ? 'EXHAUSTED' : b.status })
        remaining = r3(remaining - alloc)
      }
    }

    const noteParts: string[] = []
    if (shortfall > 0) noteParts.push(`Primanjkljaj: zahtevano ${req} ${item.unit}, na zalogi ${prev} ${item.unit} — odšteto ${actual}`)
    if (useBatches && toAllocateFromBatches < actual - 0.0005) noteParts.push(`Serije pokrijejo ${toAllocateFromBatches} ${item.unit} od ${actual}`)

    await tx.stockTransaction.create({
      data: {
        id: txId,
        inventoryItemId: item.id,
        type: 'SALE',
        quantity: -actual,
        previousQty: prev,
        newQty,
        costPerUnit: unitCost,
        totalCost: lineCost,
        reason: 'Razknjiževanje po recepturi (izdaja računa)',
        note: noteParts.join('; '),
        employeeId,
        employeeName,
        orderId,
      },
    })

    // FK-varni vrstni red: StockTransaction obstaja → zdaj so alokacije veljavne.
    // EXHAUSTED status z lte guard-om (R2 semantika — race-varno); količino je že
    // dekrementiral CAS updateMany v zanki (tu je NE prepisujemo).
    for (const p of plannedAllocations) {
      if (p.status === 'EXHAUSTED') {
        await tx.inventoryBatch.updateMany({ where: { id: p.batchId, quantityRemaining: { lte: 0.0005 } }, data: { status: 'EXHAUSTED' } })
      }
      await tx.stockBatchAllocation.create({
        data: { id: nid(), batchId: p.batchId, stockTransactionId: txId, inventoryItemId: item.id, quantity: p.alloc },
      })
    }

    lines += 1
    totalCost = r2(totalCost + lineCost)
  }

  await tx.order.update({ where: { id: orderId }, data: { inventoryDeducted: true } })

  await tx.auditLog.create({
    data: {
      id: nid(),
      userId: employeeId,
      action: 'STOCK_DEDUCTED',
      entityType: 'Order',
      entityId: orderId,
      details: JSON.stringify({ lines, totalCost, shortfalls: shortfalls.map((s) => ({ item: s.name, requested: s.requested, available: s.available })) }),
    },
  })

  return { deducted: true, lines, totalCost, shortfalls }
}

/** Zaokroži na 2 decimalki (pomožnik za izvoz). */
export const round2 = r2
