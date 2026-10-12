import { nid, num } from '@/lib/map'
import type { Prisma } from '@prisma/client'
import { auditChainFields } from '@/lib/audit-chain'
import { flattenDeduction, type RecipeNode } from '@/lib/recipe-cost'

type Tx = Prisma.TransactionClient

export interface StockShortfall {
  inventoryItemId: string
  name: string
  requested: number
  available: number
}

export interface StockDeduction {
  inventoryItemId: string
  name: string
  /** post-deduction quantity (rounded 3) — input for low-stock alerts (OPS-8 val 2) */
  newQty: number
}

export interface StockDeductionResult {
  /** false = replay (ta naročilo je že razknjiženo) — nič se ne odšteje dvakrat */
  deducted: boolean
  lines: number
  totalCost: number
  shortfalls: StockShortfall[]
  /** OPS-8 val 2: items with new quantities (for maybeNotifyLowStock after the tx) */
  deductions: StockDeduction[]
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
 * OPS-9 val 1 (recipe BOM maturity): quantities come from flattenDeduction() —
 * effective raw = quantityPerServing / (yieldPercent/100), sub-recipe nodes
 * (parentRecipeItemId children) included; identical to the legacy flat math for
 * yieldPercent=100 rows without children.
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
  employeeName: string,
  /** OPS-7 split po izstavkih: odštej SAMO te postavke (Check plačilo); brez = celo naročilo. */
  onlyItemIds?: string[]
): Promise<StockDeductionResult> {
  const empty: StockDeductionResult = { deducted: false, lines: 0, totalCost: 0, shortfalls: [], deductions: [] }
  const subsetMode = Array.isArray(onlyItemIds) && onlyItemIds.length > 0

  // ── Replay zaščita 1: flag na naročilu ──
  // (v subset načinu flag nastavimo šele pri plačilu ZADNJEGA izstavka — glej repliki 2)
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, inventoryDeducted: true, locationId: true } })
  if (order?.inventoryDeducted) return empty

  // ── Replay zaščita 2: StockTransaction (orderId, type='SALE') ──
  // Subset način: SALE transakcije so per izstavek (dovoljeno več); replika je pokrita s
  // CAS na Check (že plačan izstavek nikoli ne pride sem). Celo naročilo: enaka pravila kot doslej.
  if (!subsetMode) {
    const existing = await tx.stockTransaction.findFirst({ where: { orderId, type: 'SALE' }, select: { id: true } })
    if (existing) return empty
  }

  const items = await tx.orderItem.findMany({
    where: { orderId, voided: false, ...(subsetMode ? { id: { in: onlyItemIds } } : {}) },
    select: { id: true, menuItemId: true, quantity: true },
  })
  if (items.length === 0) return empty

  const menuItemIds = [...new Set(items.map((i) => i.menuItemId))]
  // OPS-9 val 1: fetch ALL rows incl. sub-recipe nodes (a child row still carries its own
  // menuItemId — the same menu item — plus parentRecipeItemId pointing at the parent row),
  // so this single fetch already returns the whole tree; parenting is rebuilt in memory.
  // NOTE (@@unique(menuItemId, inventoryItemId)): a child row with the same inventory item
  // as its parent would violate the constraint — duplicate (menuItemId, inventoryItemId)
  // pairs cannot coexist; flattenDeduction still sums defensively if dirty data appears.
  const recipes = await tx.recipeItem.findMany({
    where: { menuItemId: { in: menuItemIds } },
    select: {
      id: true,
      menuItemId: true,
      inventoryItemId: true,
      quantityPerServing: true,
      unit: true,
      parentRecipeItemId: true,
      yieldPercent: true,
    },
  })
  if (recipes.length === 0) return empty

  // Map DB rows to pure RecipeNode shape (Decimal -> number via num).
  const recipeNodes: RecipeNode[] = recipes.map((r) => ({
    id: r.id,
    menuItemId: r.menuItemId,
    inventoryItemId: r.inventoryItemId,
    quantityPerServing: num(r.quantityPerServing),
    yieldPercent: num(r.yieldPercent, 100),
    unit: r.unit,
    parentRecipeItemId: r.parentRecipeItemId,
  }))

  // ── Agregacija potrebščin po sestavinah (OPS-9: yield + pod-recepture aware) ──
  // Per order line: recursive BOM flatten — effective raw = quantityPerServing/(yield/100),
  // children of top-level lines included. BACKWARD COMPATIBILITY: for yieldPercent=100 and
  // no child rows effectiveRawQty is the identity (r3 of an already 3-decimal Decimal value)
  // and the tree is flat, so the result is IDENTICAL to the previous flat math
  // (q = r3(quantityPerServing * quantity) accumulated with r3).
  const needed = new Map<string, number>()
  for (const oi of items) {
    const flat = flattenDeduction(recipeNodes, oi.menuItemId, oi.quantity)
    for (const [inventoryItemId, q] of flat) {
      if (q > 0) needed.set(inventoryItemId, r3((needed.get(inventoryItemId) || 0) + q))
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
  const deductions: StockDeduction[] = []

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
        // R2 popravek (P0 audit): CAS po seriji (decrement z gte guard + retry).
        // KRITIČNO (bug odkrit s testi 32-c): ob USPEHU takoj prekini — brez breaka
        // zanka ponovi poskus (serija je že dekrementirana), drugi poskus nato
        // faila (ok=false) → `continue` zavže uspešno delo (brez alokacije in
        // EXHAUSTED), pri večji seriji pa bi dekrementiral VEČKRAT!
        for (let attempt = 0; attempt < 3 && alloc > 0.0005; attempt++) {
          const res = await tx.inventoryBatch.updateMany({
            where: { id: b.id, quantityRemaining: { gte: alloc } },
            data: { quantityRemaining: { decrement: alloc } },
          })
          ok = res.count === 1
          if (ok) break
          const fresh = await tx.inventoryBatch.findUnique({ where: { id: b.id }, select: { quantityRemaining: true } })
          avail = Math.max(0, num(fresh?.quantityRemaining))
          alloc = Math.min(avail, remaining)
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

    deductions.push({ inventoryItemId: item.id, name: item.name, newQty })

    lines += 1
    totalCost = r2(totalCost + lineCost)
  }

  // OPS-7 split: flag nastavimo šele, ko so odštete VSE ne-voided postavke naročila
  // (v subset načinu šele pri plačilu zadnjega izstavka) — zaščita replike ostane veljavna.
  if (subsetMode) {
    const remaining = await tx.orderItem.count({
      where: { orderId, voided: false, id: { notIn: onlyItemIds as string[] } },
    })
    if (remaining > 0) {
      return { deducted: true, lines, totalCost, shortfalls, deductions }
    }
  }
  await tx.order.update({ where: { id: orderId }, data: { inventoryDeducted: true } })

  // 33-c: chain polja (tamper-evidentna veriga) + locationId naročila (audit §6)
  const __aId = nid(); const __chain = await auditChainFields(tx, {
    id: __aId,
    action: 'STOCK_DEDUCTED',
    entityType: 'Order',
    entityId: orderId,
    details: JSON.stringify({ lines, totalCost, shortfalls: shortfalls.map((s) => ({ item: s.name, requested: s.requested, available: s.available })) }),
    locationId: order?.locationId ?? null,
  })
  await tx.auditLog.create({
    data: {
      ...__chain,
      id: __aId,
      userId: employeeId,
      action: 'STOCK_DEDUCTED',
      entityType: 'Order',
      entityId: orderId,
      details: JSON.stringify({ lines, totalCost, shortfalls: shortfalls.map((s) => ({ item: s.name, requested: s.requested, available: s.available })) }),
      // 33-c (audit §6): STOCK_DEDUCTED dobi locationId naročila (prej neviden location-scoped uporabnikom)
      locationId: order?.locationId ?? null,
    },
  })

  return { deducted: true, lines, totalCost, shortfalls, deductions }
}

/** Zaokroži na 2 decimalki (pomožnik za izvoz). */
export const round2 = r2
