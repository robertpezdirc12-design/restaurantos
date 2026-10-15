import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num, jstr, r2 } from '@/lib/map'
import { batchCostPerUnit } from '@/lib/batch'
import { weightedAvgCostCents } from '@/lib/procurement'
import { writeAudit } from '@/lib/audit-chain'
import {
  lotGovernanceColumnsReady,
  usableBatchWhere,
  usableBatchWhereLegacy,
  sortUsableFefo,
  BATCH_SELECT_FULL,
  BATCH_SELECT_LEGACY,
} from '@/lib/lot-governance'

/**
 * OPS-10 val 3 (v1.79.0) — batch lifecycle transitions.
 *
 * PATCH /api/batch-preparations/[id] { action: 'complete' | 'cancel' }
 *
 * complete (DRAFT → COMPLETED) — in ONE transaction:
 *   1. per line: CAS decrement of InventoryItem.quantity (never negative —
 *      any shortfall aborts the whole batch with 409 + missing item names);
 *   2. FEFO series allocation (InventoryBatch + StockBatchAllocation, earliest
 *      expiry first — the same pattern as the sales deduction in lib/inventory.ts);
 *   3. StockTransaction type 'BATCH_INPUT' per line (negative quantity — cannot
 *      falsely re-arm the low-stock inflow rule, which counts only positive rows);
 *   4. output item += outputQuantity with weighted-average cost + StockTransaction
 *      type 'BATCH_OUTPUT' (positive — correctly re-arms low-stock alerts);
 *   5. batch status/completedAt/outputCostPerUnit/transaction links.
 * cancel (DRAFT → CANCELLED) — status only, no stock movements.
 *
 * Pravica: inventory.manage. Audit: BATCH_COMPLETED / BATCH_CANCELLED.
 */

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Sentinel error — aborts the transaction when any input item is short. */
class BatchShortfallError extends Error {
  missing: { inventoryItemId: string; name: string; requested: number; available: number }[]
  constructor(missing: { inventoryItemId: string; name: string; requested: number; available: number }[]) {
    super('batch-shortfall')
    this.missing = missing
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params

  const body = await req.json().catch(() => null)
  const action = String((body as { action?: unknown } | null)?.action || '')
  if (action !== 'complete' && action !== 'cancel') return fail('Manjka akcija (complete | cancel).', 400)

  const batch = await db.batchPreparation.findUnique({
    where: { id },
    include: { BatchPreparationLine: true, InventoryItem: { select: { id: true, name: true } } },
  })
  if (!batch) return fail('Priprava ne obstaja.', 404)
  if (batch.status !== 'DRAFT') {
    return fail(`Samo osnutek (DRAFT) je mogoče ${action === 'complete' ? 'zaključiti' : 'preklicati'} — status je "${batch.status}".`, 409)
  }

  if (action === 'cancel') {
    const updated = await db.batchPreparation.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), completedByName: user.name || '' },
      include: { InventoryItem: { select: { name: true, unit: true } }, BatchPreparationLine: true },
    })
    await writeAudit(db, { userId: user.sub, action: 'BATCH_CANCELLED', entityType: 'BatchPreparation', entityId: id, details: jstr({ outputItemId: batch.outputItemId, outputQuantity: num(batch.outputQuantity) }) })
    return ok({ batch: { id: updated.id, status: updated.status, cancelledAt: updated.cancelledAt } })
  }

  // ── complete ──
  const outputQty = num(batch.outputQuantity)
  const totalInputCost = num(batch.totalInputCost)
  const outUnitCost = batchCostPerUnit(totalInputCost, outputQty)
  const now = new Date()
  const employeeId = user.sub || null
  const employeeName = user.name || ''

  let completed: { outputTxId: string; outNewQty: number }
  try {
    completed = await db.$transaction(async (tx) => {
      // 1.–3. input lines: CAS decrement + FEFO series + StockTransaction
      for (const line of batch.BatchPreparationLine) {
        const qty = num(line.quantity)
        if (!(qty > 0)) continue
        const inv = await tx.inventoryItem.findUnique({
          where: { id: line.inventoryItemId },
          select: { id: true, name: true, quantity: true, costPerUnit: true },
        })
        if (!inv) {
          throw new BatchShortfallError([{ inventoryItemId: line.inventoryItemId, name: line.itemName || line.inventoryItemId, requested: qty, available: 0 }])
        }
        const prev = Math.max(0, num(inv.quantity))
        const unitCost = num(line.costPerUnit) || num(inv.costPerUnit)

        // inventory must NEVER go negative — CAS guard, shortfall aborts the batch
        const cas = await tx.inventoryItem.updateMany({
          where: { id: inv.id, quantity: { gte: qty } },
          data: { quantity: { decrement: qty } },
        })
        if (cas.count !== 1) {
          throw new BatchShortfallError([{ inventoryItemId: inv.id, name: inv.name || line.itemName, requested: qty, available: prev }])
        }
        const newQty = r3(prev - qty)

        // FEFO series plan (issue #15: lot governance) — uporabne serije samo:
        // blokirane (karantena/odpoklic), pretekle in odstranjene so IZKLJUČENE
        // iz porabe pri pripravi; dialekt-determinističen vrstni red (nulls zadnji).
        const lotReady = await lotGovernanceColumnsReady()
        const now = new Date()
        const batchesRaw = await tx.inventoryBatch.findMany({
          where: {
            inventoryItemId: inv.id,
            ...(lotReady ? usableBatchWhere(now) : usableBatchWhereLegacy(now)),
          },
          select: lotReady ? BATCH_SELECT_FULL : BATCH_SELECT_LEGACY,
        })
        const batches = sortUsableFefo(batchesRaw).slice(0, 50)
        const batchStock = batches.reduce((s, b) => s + Math.max(0, num(b.quantityRemaining)), 0)
        const useBatches = batches.length > 0 && batchStock > 0
        let remaining = useBatches ? Math.min(qty, batchStock) : 0
        const plannedAllocations: { batchId: string; alloc: number; status: string }[] = []
        for (const b of batches) {
          if (remaining <= 0.0005) break
          let avail = Math.max(0, num(b.quantityRemaining))
          let alloc = Math.min(avail, remaining)
          let done = false
          for (let attempt = 0; attempt < 3 && alloc > 0.0005; attempt++) {
            const res = await tx.inventoryBatch.updateMany({
              where: { id: b.id, quantityRemaining: { gte: alloc } },
              data: { quantityRemaining: { decrement: alloc } },
            })
            done = res.count === 1
            if (done) break
            const fresh = await tx.inventoryBatch.findUnique({ where: { id: b.id }, select: { quantityRemaining: true } })
            avail = Math.max(0, num(fresh?.quantityRemaining))
            alloc = Math.min(avail, remaining)
          }
          if (!done || alloc <= 0.0005) continue
          const bNew = r3(avail - alloc)
          plannedAllocations.push({ batchId: b.id, alloc: r3(alloc), status: bNew <= 0.0005 ? 'EXHAUSTED' : b.status })
          remaining = r3(remaining - alloc)
        }

        // FK order: StockTransaction FIRST, then allocations (P2003-safe, 32-c lesson)
        const txId = nid()
        await tx.stockTransaction.create({
          data: {
            id: txId,
            inventoryItemId: inv.id,
            type: 'BATCH_INPUT',
            quantity: -qty,
            previousQty: prev,
            newQty,
            costPerUnit: unitCost,
            totalCost: r2(unitCost * qty),
            reason: 'Priprava po serijah — odjem sestavin',
            note: batch.note || batch.id,
            employeeId,
            employeeName,
          },
        })
        for (const p of plannedAllocations) {
          if (p.status === 'EXHAUSTED') {
            await tx.inventoryBatch.updateMany({ where: { id: p.batchId, quantityRemaining: { lte: 0.0005 } }, data: { status: 'EXHAUSTED' } })
          }
          await tx.stockBatchAllocation.create({
            data: { id: nid(), batchId: p.batchId, stockTransactionId: txId, inventoryItemId: inv.id, quantity: p.alloc },
          })
        }
        await tx.batchPreparationLine.update({ where: { id: line.id }, data: { inputStockTransactionId: txId } })
      }

      // 4. output receipt: qty += outputQuantity, weighted-average cost
      const output = await tx.inventoryItem.findUnique({
        where: { id: batch.outputItemId },
        select: { id: true, name: true, quantity: true, costPerUnit: true },
      })
      if (!output) throw new Error('Izhodni artikel ne obstaja več.')
      const outPrev = Math.max(0, num(output.quantity))
      const outNewQty = r3(outPrev + outputQty)
      const oldCostCents = Math.round(num(output.costPerUnit) * 100)
      const newCostCents = weightedAvgCostCents(outPrev, oldCostCents, outputQty, Math.round(outUnitCost * 100))
      await tx.inventoryItem.update({
        where: { id: output.id },
        data: { quantity: outNewQty, costPerUnit: newCostCents / 100, lastRestocked: now },
      })

      const outputTxId = nid()
      await tx.stockTransaction.create({
        data: {
          id: outputTxId,
          inventoryItemId: output.id,
          type: 'BATCH_OUTPUT',
          quantity: outputQty,
          previousQty: outPrev,
          newQty: outNewQty,
          costPerUnit: outUnitCost,
          totalCost: r2(outUnitCost * outputQty),
          reason: 'Priprava po serijah — prijem izdelka',
          note: batch.note || batch.id,
          employeeId,
          employeeName,
        },
      })

      // 5. batch record
      await tx.batchPreparation.update({
        where: { id: batch.id },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          completedByName: employeeName,
          outputCostPerUnit: outUnitCost,
          outputStockTransactionId: outputTxId,
        },
      })
      return { outputTxId, outNewQty }
    })
  } catch (e) {
    if (e instanceof BatchShortfallError) {
      return fail(
        `Zaloga ni dovolj za pripravo — manjka: ${e.missing.map((m) => `${m.name} (potrebno ${m.requested}, na zalogi ${m.available})`).join(', ')}.`,
        409,
        )
    }
    throw e
  }

  await writeAudit(db, { userId: user.sub, action: 'BATCH_COMPLETED', entityType: 'BatchPreparation', entityId: batch.id, details: jstr({ outputItemId: batch.outputItemId, outputQuantity: outputQty, outputCostPerUnit: outUnitCost, totalInputCost, outputStockTransactionId: completed.outputTxId, lines: batch.BatchPreparationLine.length }) })

  return ok({
    batch: {
      id: batch.id,
      status: 'COMPLETED',
      completedAt: now,
      outputQuantity: outputQty,
      outputCostPerUnit: outUnitCost,
      outputNewQty: completed.outNewQty,
      outputStockTransactionId: completed.outputTxId,
    },
  })
}
