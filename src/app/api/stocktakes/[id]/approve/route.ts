import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Potrditev popisa: SUBMITTED → APPROVED — inventurni popravek v transakciji.
 * Vrstica z vnosom: quantity := countedQuantity (inventurni popravek — namenski
 * last-writer-wins, isti vzorec kot setQty R4), StockTransaction type STOCKTAKE
 * (previousQty = stanje ob odobritvi — sočasna prodaja med štetjem in odobritvijo
 * je vidna v evidence; newQty = prešteto), varianceQuantity := counted −
 * expectedQuantity (proti snapshotu — analitični pogled), varianceValue :=
 * variansa × costPerUnit. Vrstice brez vnosa ostanejo NESPREMENJENE.
 * Dvojni klik: updateMany CAS šteje 0 vrstic → 409.
 *
 * Issue #66: vrstice se preberejo SVEŽE ZNOTRAJ transakcije (prej so bile
 * prebrane pred njo — zastarelo štetje bi lahko odobrilo količine, ki jih
 * zadnji PATCH sploh ni zapisal). Po claimu SUBMITTED→APPROVED lahko PATCH
 * nič več ne zapiše (claim zaklep serializira), prebrana množica je torej
 * točno tista, ki jo je submit zaklenil.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(_req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const st = await db.stocktake.findUnique({ where: { id }, select: { id: true, locationId: true, status: true } })
  if (!st) return fail('Popis ne obstaja.', 404)
  const guard = await guardResource(user, st.locationId)
  if (guard) return guard

  const result = await db.$transaction(async (tx) => {
    const locked = await tx.stocktake.updateMany({
      where: { id, status: 'SUBMITTED' },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedByName: user.name },
    })
    if (locked.count === 0) return { error: fail('Popis ni več v oddanem stanju (že potrjen ali preklican).', 409) as NextResponse }
    // #66: SVEŽE vrstice po claimu (zastarelo pred-branje odstranjeno) — množica
    // je točno tista, ki jo je submit zaklenil; poznej PATCH na njo je nemogoč
    const lines = await tx.stocktakeItem.findMany({ where: { stocktakeId: id } })
    let adjusted = 0
    let varianceValue = 0
    for (const line of lines) {
      if (line.countedQuantity == null) continue
      const counted = num(line.countedQuantity)
      const inv = await tx.inventoryItem.findUnique({ where: { id: line.inventoryItemId } })
      if (!inv) continue
      const previousQty = num(inv.quantity)
      const varianceQty = counted - num(line.expectedQuantity)
      const value = varianceQty * num(line.costPerUnit)
      varianceValue += value
      if (counted !== previousQty) {
        const txId = nid()
        await tx.stockTransaction.create({
          data: {
            id: txId,
            inventoryItemId: inv.id,
            type: 'STOCKTAKE',
            quantity: counted - previousQty,
            previousQty,
            newQty: counted,
            costPerUnit: num(line.costPerUnit),
            totalCost: (counted - previousQty) * num(line.costPerUnit),
            reason: 'stocktake',
            note: jstr({ stocktakeId: id }),
            employeeName: user.name,
            employeeId: user.sub,
          },
        })
        await tx.inventoryItem.update({ where: { id: inv.id }, data: { quantity: counted } })
        await tx.stocktakeItem.update({ where: { id: line.id }, data: { varianceQuantity: varianceQty, varianceValue: value, stockTransactionId: txId, countedAt: line.countedAt ?? new Date() } })
      } else {
        await tx.stocktakeItem.update({ where: { id: line.id }, data: { varianceQuantity: varianceQty, varianceValue: value } })
      }
      if (counted !== previousQty) adjusted += 1
    }
    return { adjusted, varianceValue }
  })
  if ('error' in result) return result.error

  await writeAudit(db, { userId: user.sub, action: 'STOCKTAKE_APPROVE', entityType: 'Stocktake', entityId: id, details: jstr({ by: user.name, adjusted: result.adjusted, varianceValue: result.varianceValue }), locationId: st.locationId })
  await publishEvent('StocktakeApproved', { entityType: 'Stocktake', entityId: id, payload: { locationId: st.locationId, adjusted: result.adjusted, varianceValue: result.varianceValue, by: user.name }, locationId: st.locationId }).catch(() => undefined)

  return ok({ id, status: 'APPROVED', adjusted: result.adjusted, varianceValue: result.varianceValue })
}
