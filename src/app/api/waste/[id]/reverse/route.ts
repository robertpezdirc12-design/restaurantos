import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, assertResourceLocation } from '@/lib/api'
import { nid, num, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { WASTE_REVERSAL_TX_TYPE, canReverseWaste, wasteReversalReason } from '@/lib/waste'
import { auditChainFields } from '@/lib/audit-chain'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Reverzija odpada (pomota pri vnosu) — v celoti vrne originalno količino na
 * zalogo (StockTransaction type='ADJUST', pozitiven), zapiše reversedAt +
 * reversalStockTransactionId (unique → reverzija je enkratna). Audit WASTE_REVERSE.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params

  const rec = await db.wasteRecord.findUnique({ where: { id } })
  if (!rec) return fail('Zapis odpada ne obstaja.', 404)

  const rev = canReverseWaste({ reversedAt: rec.reversedAt })
  if (!rev.ok) return fail(rev.reason ?? 'Odpad je že povrnjen.', 409)

  // Issue #4 §1 vzorec: reverzija tujega zapisa (druga lokacija) je zavrnjena (fail-closed)
  const locRes = assertResourceLocation(user, rec.locationId)
  if (locRes) return locRes

  const item = await db.inventoryItem.findUnique({ where: { id: rec.inventoryItemId }, select: { name: true, locationId: true } })
  const qty = num(rec.quantity)

  let reversalStockTransactionId: string | null = null
  let newQty = 0
  try {
    const done = await db.$transaction(async (tx) => {
      // Povratek na zalogo: brez gornje meje (vračamo fizično količino odpada)
      await tx.inventoryItem.updateMany({
        where: { id: rec.inventoryItemId },
        data: { quantity: { increment: qty } },
      })
      const fresh = await tx.inventoryItem.findUnique({ where: { id: rec.inventoryItemId }, select: { quantity: true } })
      // r3 normalizacija: SQLite REAL incrementi nabirajo float drift — shranimo čisto vrednost
      const rawQty = num(fresh?.quantity)
      const after = r3(rawQty)
      if (after !== rawQty) {
        await tx.inventoryItem.update({ where: { id: rec.inventoryItemId }, data: { quantity: after } })
      }
      const prevQty = r3(after - qty) // konsistenten par (previous → new)
      const revTx = await tx.stockTransaction.create({
        data: {
          id: nid(),
          inventoryItemId: rec.inventoryItemId,
          type: WASTE_REVERSAL_TX_TYPE,
          quantity: qty,
          previousQty: prevQty,
          newQty: after,
          costPerUnit: num(rec.costPerUnit),
          totalCost: num(rec.totalCost),
          reason: wasteReversalReason(rec.id),
          note: rec.note,
          employeeId: user.sub,
          employeeName: user.name,
        },
      })
      await tx.wasteRecord.update({
        where: { id: rec.id },
        data: { reversedAt: new Date(), reversalStockTransactionId: revTx.id },
      })
      return { revTxId: revTx.id, newQty: after }
    })
    reversalStockTransactionId = done.revTxId
    newQty = done.newQty
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    // enkratnost reverzije zagotavlja unique reversalStockTransactionId;
    // če je zapis vmes že povrnjen (sočasno), unique pada → preveri stanje
    if (msg.includes('Unique constraint')) {
      const fresh = await db.wasteRecord.findUnique({ where: { id: rec.id }, select: { reversedAt: true, reversalStockTransactionId: true } })
      if (fresh?.reversedAt) return fail('Odpad je že povrnjen.', 409)
    }
    return fail(`Reverzija ni uspela: ${msg}`, 500)
  }

  const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'WASTE_REVERSE', entityType: 'WasteRecord', entityId: rec.id, details: jstr({ item: item?.name ?? rec.inventoryItemId, quantity: qty, unit: rec.unit, totalCost: num(rec.totalCost), newQty, reversalStockTransactionId }), id: __aId2 })
  await db.auditLog.create({
    data: { ...__chain2,
      id: __aId2,
      userId: user.sub,
      action: 'WASTE_REVERSE',
      entityType: 'WasteRecord',
      entityId: rec.id,
      details: jstr({ item: item?.name ?? rec.inventoryItemId, quantity: qty, unit: rec.unit, totalCost: num(rec.totalCost), newQty, reversalStockTransactionId }),
    },
  })
  await publishEvent('StockChanged', {
    entityType: 'InventoryItem',
    entityId: rec.inventoryItemId,
    // 33-c: locationId v payloadu (lokacijsko vidni dogodki — audit §6)
    payload: { name: item?.name ?? rec.inventoryItemId, variance: qty, newQty, by: user.name, cause: 'waste-reversal', locationId: item?.locationId ?? rec.locationId ?? null },
  }).catch(() => undefined)

  const fresh = await db.wasteRecord.findUnique({ where: { id: rec.id }, select: { reversedAt: true, reversalStockTransactionId: true } })
  return ok({ record: { id: rec.id, reversedAt: fresh?.reversedAt, reversalStockTransactionId: fresh?.reversalStockTransactionId ?? reversalStockTransactionId }, newQty })
}
