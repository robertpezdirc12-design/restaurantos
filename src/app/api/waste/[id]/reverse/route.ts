import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { WASTE_REVERSAL_TX_TYPE, WASTE_REVERSAL_CLAIM_FAILED, canReverseWaste, wasteReversalReason } from '@/lib/waste'
import { writeAudit } from '@/lib/audit-chain'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Reverzija odpada (pomota pri vnosu) — v celoti vrne originalno količino na
 * zalogo (StockTransaction type='ADJUST', pozitiven), zapiše reversedAt +
 * reversalStockTransactionId. Audit WASTE_REVERSE.
 *
 * Issue #59 (P1) — ATOMARNA ENKRATNOST (CAS claim znotraj iste transakcije):
 * prej je bila edina "zaščita" unique na reversalStockTransactionId, ki pa je
 * unique referenca NA WasteRecord vrstico — dve sočasni zahtevi ustvarita
 * različna StockTransaction ID-ja in LAHKO OBÉ dvakrat povečata zalogo.
 * Zdaj: transakcija NAJPREJ atomarno prevzame pravico (updateMany z vejnim
 * pogojom reversedAt=null AND reversalStockTransactionId=null) — samo če se
 * spremeni NATANKO ena vrstica se nadaljuje vračilo + povratni ledger;
 * katerakoli napaka kasneje rollback-a tudi claim (ista transakcija).
 * Pred-transakcijska canReverseWaste preverba ostane samo kot UX hitra pot,
 * NE pa varovalka. Zunanja guardResource lokacijski/org obseg ostaja.
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
  const locRes = await guardResource(user, rec.locationId)
  if (locRes) return locRes

  const item = await db.inventoryItem.findUnique({ where: { id: rec.inventoryItemId }, select: { name: true, locationId: true } })
  const qty = num(rec.quantity)

  let reversalStockTransactionId: string | null = null
  let newQty = 0
  try {
    const done = await db.$transaction(async (tx) => {
      // ── Issue #59: ATOMIC CLAIM (CAS) — edina avtoriteta enkratnosti ──
      // Pogojni updateMany: natanko ena vrstica se sme spremeniti; če je zapis
      // vmes že povrnjen (sočasna zahteva), count=0 → celotna transakcija se
      // zavrne (rollback claim + zaloga + ledger) → 409 brez dvojnega vračila.
      const claim = await tx.wasteRecord.updateMany({
        where: { id: rec.id, reversedAt: null, reversalStockTransactionId: null },
        data: { reversedAt: new Date() },
      })
      if (claim.count !== 1) {
        throw new Error(WASTE_REVERSAL_CLAIM_FAILED)
      }
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
        data: { reversalStockTransactionId: revTx.id },
      })
      return { revTxId: revTx.id, newQty: after }
    })
    reversalStockTransactionId = done.revTxId
    newQty = done.newQty
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    // Issue #59: CAS claim ni uspel — vrstica je bila vmes že povrnjena (sočasna
    // zahteva). Rollback je že počistil claim/zalogo/ledger → varen 409 replay.
    if (msg === WASTE_REVERSAL_CLAIM_FAILED) {
      return fail('Odpad je že povrnjen.', 409)
    }
    // enkratnost reverzije zagotavlja unique reversalStockTransactionId;
    // če je zapis vmes že povrnjen (sočasno), unique pada → preveri stanje
    if (msg.includes('Unique constraint')) {
      const fresh = await db.wasteRecord.findUnique({ where: { id: rec.id }, select: { reversedAt: true, reversalStockTransactionId: true } })
      if (fresh?.reversedAt) return fail('Odpad je že povrnjen.', 409)
    }
    return fail(`Reverzija ni uspela: ${msg}`, 500)
  }

  await writeAudit(db, { userId: user.sub, action: 'WASTE_REVERSE', entityType: 'WasteRecord', entityId: rec.id, details: jstr({ item: item?.name ?? rec.inventoryItemId, quantity: qty, unit: rec.unit, totalCost: num(rec.totalCost), newQty, reversalStockTransactionId }) })
  await publishEvent('StockChanged', {
    entityType: 'InventoryItem',
    entityId: rec.inventoryItemId,
    // 33-c: locationId v payloadu (lokacijsko vidni dogodki — audit §6)
    payload: { name: item?.name ?? rec.inventoryItemId, variance: qty, newQty, by: user.name, cause: 'waste-reversal', locationId: item?.locationId ?? rec.locationId ?? null },
    // Issue #38: verifikovana lokacija (artikel zaloge oziroma zapis odpada)
    locationId: item?.locationId ?? rec.locationId ?? null,
  }).catch(() => undefined)

  const fresh = await db.wasteRecord.findUnique({ where: { id: rec.id }, select: { reversedAt: true, reversalStockTransactionId: true } })
  return ok({ record: { id: rec.id, reversedAt: fresh?.reversedAt, reversalStockTransactionId: fresh?.reversalStockTransactionId ?? reversalStockTransactionId }, newQty })
}
