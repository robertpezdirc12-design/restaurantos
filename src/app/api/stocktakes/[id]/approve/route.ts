import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { restoreAuto86ForInventory } from '@/lib/auto-86'
import { allocateBatchesTx, writeBatchAllocations } from '@/lib/batch-allocate'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Potrditev popisa: SUBMITTED → APPROVED — inventurni popravek v transakciji.
 * Vrstica z vnosom: quantity := countedQuantity (inventurni popravek — namenski
 * last-writer-wins, isti vzorec kot setQty R4), StockTransaction type STOCKTAKE
 * (previousQty = stanje ob odobritvi — sočasna prodaja med štetjem in odobritvijo
 * je vidna v evidence; newQty = prešteto). Vrstice brez vnosa ostanejo
 * NESPREMENJENE. Dvojni klik: updateMany CAS šteje 0 vrstic → 409.
 *
 * Issue #66: vrstice se preberejo SVEŽE ZNOTRAJ transakcije (prej so bile
 * prebrane pred njo — zastarelo štetje bi lahko odobrilo količine, ki jih je
 * zadnji PATCH sploh ni zapisal). Po claimu SUBMITTED→APPROVED lahko PATCH
 * nič več ne zapiše (claim zaklep serializira), prebrana množica je torej
 * točno tista, ki jo je submit zaklenil.
 *
 * v1.242.0 (PRIMERJAVA §16 I D — založni val), dve novini:
 *
 * (1) VARIANCA PROTI NETO GIBANJEM (ne proti staremu snapshotu). Prej:
 * varianceQuantity = counted − expected, kjer je expected = snapshot OB ODRTIU
 * popisa. Popis, odprt ob 8:00 in odobren ob 14:00, je med tem videl prodajo,
 * prejeme, odpad — vsa ta gibanja so se štela kot »manjko« števca. Vodilni
 * (Marketman/Toast inventory variance) primerjajo preštetega proti TEORETIČNEMU
 * stanju = snapshot + neto gibanja med štetjem — variansa je potem NEPOJASNJENA
 * razlika (kraja/izguba/nenatančen vnos), ne časovna posledica.
 * Zdaj: varianceQuantity = counted − (expected + Σ StockTransaction.quantity
 * od odprtja popisa do odobritve; pre-pass PRED zapisom lastnih popravkov).
 * Pogled [id] izračuna še variantso proti snapshotu (oba števca sta shranjena),
 * neto gibanja pa so v odgovoru odobritve per vrstica (dokaz).
 *
 * (2) REBALANCA SERIJ. Prej: popravek je nastavil SAMO agregat — serije
 * (InventoryBatch) so ostale stare, FEFO je rezerviral fantomsko zalogo. Zdaj:
 * če je prešteto MANJ kot stanje ob odobritvi, se razlika odstrani iz uporabnih
 * serij (FEFO — isti vrstni red kot prodaja/odpad), z alokacijskimi vrsticami
 * vezanimi na STOCKTAKE transakcijo. Presežek (prešteto VEČ) ne ustvarja
 * fantomskih serij — priliv je brez serije (naslednji prejem ustvari lot).
 * Blokirane serije (karantena/odpoklic) se NE tikajo — njihova usoda je
 * izrecna odločitev (hold/release), ne inventurna aritmetika.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(_req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const st = await db.stocktake.findUnique({ where: { id }, select: { id: true, locationId: true, status: true, createdAt: true } })
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
    // je točno tista, ki jo je submit zaklenil; poznejši PATCH na njo je nemogoč
    const lines = await tx.stocktakeItem.findMany({ where: { stocktakeId: id } })

    // ── v1.242.0 (1): neto gibanja od odprtja popisa (PRE-PASS — pred zapisom
    // lastnih STOCKTAKE popravkov, da se lastna korekcija ne šteje kot gibanje;
    // prejšnji odobreni popisi padejo PRED createdAt tega popisa — en odprt na
    // lokacijo hkrati ciklus pa pomeni, da njihove korekcije ne morejo biti
    // znotraj tega okna).
    const countedLines = lines.filter((l) => l.countedQuantity != null)
    const countedItemIds = [...new Set(countedLines.map((l) => l.inventoryItemId))]
    const movementRows = countedItemIds.length
      ? await tx.stockTransaction.findMany({
          where: { inventoryItemId: { in: countedItemIds }, createdAt: { gte: st.createdAt } },
          select: { inventoryItemId: true, quantity: true },
        })
      : []
    const netMovements = new Map<string, number>()
    for (const m of movementRows) {
      netMovements.set(m.inventoryItemId, r3((netMovements.get(m.inventoryItemId) || 0) + num(m.quantity)))
    }

    let adjusted = 0
    let varianceValue = 0
    const auto86RestoreIds: string[] = []
    const lineProofs: { inventoryItemId: string; expectedQty: number; netMovements: number; theoreticalQty: number; countedQty: number; varianceQty: number }[] = []
    for (const line of lines) {
      if (line.countedQuantity == null) continue
      const counted = num(line.countedQuantity)
      const inv = await tx.inventoryItem.findUnique({ where: { id: line.inventoryItemId } })
      if (!inv) continue
      const previousQty = num(inv.quantity)
      // v1.242.0 (1): variansa proti TEORETIČNEMU stanju (snapshot + neto gibanja);
      // stara »counted − expected« ostane izračunljiva v [id] (oba števca shranjena).
      const nm = netMovements.get(inv.id) || 0
      const theoreticalQty = r3(num(line.expectedQuantity) + nm)
      const varianceQty = r3(counted - theoreticalQty)
      const value = varianceQty * num(line.costPerUnit)
      varianceValue += value
      lineProofs.push({ inventoryItemId: inv.id, expectedQty: num(line.expectedQuantity), netMovements: nm, theoreticalQty, countedQty: counted, varianceQty })
      if (counted !== previousQty) {
        const txId = nid()
        // v1.242.0 (2): rebalanca serij — manjko se odstrani iz uporabnih lot-ov
        // (FEFO), da serijski ledger ne obljublja zaloge, ki je fizično ni več.
        const shrink = Math.max(0, r3(previousQty - counted))
        const batchRes = shrink > 0
          ? await allocateBatchesTx(tx, inv.id, shrink)
          : { allocations: [], untracked: 0 }
        const noteParts = [`stocktakeId: ${id}`]
        if (batchRes.allocations.length > 0) {
          noteParts.push(`rebalanca serij: ${r3(batchRes.allocations.reduce((s, a) => s + a.alloc, 0))} ${inv.unit} FEFO`)
        }
        if (batchRes.untracked > 0) {
          noteParts.push(`brez serije: ${batchRes.untracked} ${inv.unit}`)
        }
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
            note: jstr({ stocktakeId: id, note: noteParts.join(' · ') }),
            employeeName: user.name,
            employeeId: user.sub,
          },
        })
        // FK-varni vrstni red: alokacije rebalance ŠELE PO StockTransaction
        await writeBatchAllocations(tx, txId, inv.id, batchRes.allocations)
        await tx.inventoryItem.update({ where: { id: inv.id }, data: { quantity: counted } })
        await tx.stocktakeItem.update({ where: { id: line.id }, data: { varianceQuantity: varianceQty, varianceValue: value, stockTransactionId: txId, countedAt: line.countedAt ?? new Date() } })
      } else {
        await tx.stocktakeItem.update({ where: { id: line.id }, data: { varianceQuantity: varianceQty, varianceValue: value } })
      }
      if (counted !== previousQty) adjusted += 1
      // v1.230.0 — priliv po popisu (prešteto VEČ kot je bilo) je kandidat za
      // obnovitev samodejno razprodanih menu artiklov
      if (counted > previousQty && counted > 0) auto86RestoreIds.push(inv.id)
    }
    return { adjusted, varianceValue, auto86RestoreIds, lines: lineProofs }
  })
  if ('error' in result) return result.error

  await writeAudit(db, { userId: user.sub, action: 'STOCKTAKE_APPROVE', entityType: 'Stocktake', entityId: id, details: jstr({ by: user.name, adjusted: result.adjusted, varianceValue: result.varianceValue, varianceBasis: 'theoretical_snapshot_plus_net_movements' }), locationId: st.locationId })
  await publishEvent('StocktakeApproved', { entityType: 'Stocktake', entityId: id, payload: { locationId: st.locationId, adjusted: result.adjusted, varianceValue: result.varianceValue, by: user.name }, locationId: st.locationId }).catch(() => undefined)

  // v1.230.0 — samodejni 86: priliv po popisu obnovi avtomatsko razprodane (fire-and-forget)
  if (result.auto86RestoreIds.length > 0) void restoreAuto86ForInventory(result.auto86RestoreIds, user.sub)

  return ok({ id, status: 'APPROVED', adjusted: result.adjusted, varianceValue: result.varianceValue, varianceBasis: 'theoretical', lines: result.lines })
}
