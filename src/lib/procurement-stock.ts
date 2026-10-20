/**
 * v1.156.0 — prevzem blaga na zalogo: compare-and-set (CAS) z ponovnim branjem.
 *
 * PREJ (v ruti receive): read-modify-write brez primerjave različice. Dva
 * sočasna prevzema istega artikla prebereta 10, oba zapišeta 11 — na Postgresu
 * READ COMMITTED en prirastek izgine, utežena cena pa se izračuna iz zastarele
 * količine. Serija in StockTransaction ostaneta v neskladju z dejansko zalogo.
 *
 * ZDAJ: zapis uspe samo, če je količina še enaka prebrani (WHERE quantity =
 * prebrana). Ob trku (count 0) se ponovno prebere in izračuna; po MAX_ATTEMPTS
 * trkih helper vrne 'contended' (ruta to preslika v 409 in transakcija se
 * razveljavi v celoti). Vrnjeni podatki so SVEŽI — serija in sled se ustvarita
 * šele po uspešnem CAS, zato nikoli ne opisujeta izgubljenega zapisa.
 */
import type { Prisma } from '@prisma/client'
import { nid } from '@/lib/map'
import { weightedAvgCostCents } from '@/lib/procurement'

/** Decimal v produkciji (Prisma), število v testih. */
export type StockQuantity = Prisma.Decimal | number

export interface StockInventoryRow {
  id: string
  name: string
  unit: string
  quantity: StockQuantity
  costPerUnit: StockQuantity
  locationId: string | null
}

export interface StockBatchData {
  id: string
  inventoryItemId: string
  locationId: string | null
  lotNumber: string
  supplierId: string
  supplierName: string
  receivedAt: Date
  expiryDate: Date | null
  quantityInitial: number
  quantityRemaining: number
  unit: string
  unitCost: number
  status: 'ACTIVE'
}

export interface StockMovementData {
  id: string
  inventoryItemId: string
  type: 'purchase'
  quantity: number
  previousQty: number
  newQty: number
  costPerUnit: number
  totalCost: number
  reason: string
  note: string
  supplierDoc: string
  employeeId: string | null
  employeeName: string
}

export interface StockTx {
  inventoryItem: {
    findUnique(args: { where: { id: string } }): Promise<StockInventoryRow | null>
    updateMany(args: {
      where: { id: string; quantity: StockQuantity }
      data: { quantity: number; costPerUnit: number; lastRestocked: Date }
    }): Promise<{ count: number }>
  }
  inventoryBatch: {
    create(args: { data: StockBatchData }): Promise<unknown>
  }
  stockTransaction: {
    create(args: { data: StockMovementData }): Promise<unknown>
  }
}

export interface ReceiveStockInput {
  inventoryItemId: string
  quantityAccepted: number
  unitPrice: number
  description: string
  locationId: string | null
  grnNumber: string
  lotNumber: string
  supplierId: string
  supplierName: string
  expiryDate: Date | null
  receivedAt: Date
  userId: string | null
  userName: string
}

export type ReceiveStockResult =
  | { kind: 'applied'; previousQty: number; newQty: number; costPerUnit: number }
  | { kind: 'missing' }
  | { kind: 'foreign_location'; inventoryName: string }
  | { kind: 'contended' }

/** Največ poskusov ob zaporednih sočasnih piscih. */
const MAX_ATTEMPTS = 5

export async function applyReceiveToStock(tx: StockTx, input: ReceiveStockInput): Promise<ReceiveStockResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const inv = await tx.inventoryItem.findUnique({ where: { id: input.inventoryItemId } })
    if (!inv) return { kind: 'missing' }
    if (inv.locationId && input.locationId && inv.locationId !== input.locationId) {
      return { kind: 'foreign_location', inventoryName: inv.name }
    }

    const oldQty = Number(inv.quantity)
    const oldCostCents = Math.round(Number(inv.costPerUnit) * 100)
    const addCostCents = Math.round(input.unitPrice * 100)
    const newQty = oldQty + input.quantityAccepted
    const newCost = weightedAvgCostCents(oldQty, oldCostCents, input.quantityAccepted, addCostCents)

    const cas = await tx.inventoryItem.updateMany({
      where: { id: inv.id, quantity: inv.quantity },
      data: { quantity: newQty, costPerUnit: newCost / 100, lastRestocked: input.receivedAt },
    })
    if (cas.count !== 1) continue // sočasni pisec — preberi in izračunaj znova

    await tx.inventoryBatch.create({
      data: {
        id: nid(),
        inventoryItemId: inv.id,
        locationId: input.locationId,
        lotNumber: input.lotNumber,
        supplierId: input.supplierId,
        supplierName: input.supplierName,
        receivedAt: input.receivedAt,
        expiryDate: input.expiryDate,
        quantityInitial: input.quantityAccepted,
        quantityRemaining: input.quantityAccepted,
        unit: inv.unit,
        unitCost: newCost / 100,
        // v1.105.0 (#15): velike črke — FEFO sprašuje 'ACTIVE'
        status: 'ACTIVE',
      },
    })

    await tx.stockTransaction.create({
      data: {
        id: nid(),
        inventoryItemId: inv.id,
        type: 'purchase',
        quantity: input.quantityAccepted,
        previousQty: oldQty,
        newQty,
        costPerUnit: newCost / 100,
        totalCost: (addCostCents * input.quantityAccepted) / 100,
        reason: `Prevzem ${input.grnNumber}`,
        note: input.description,
        supplierDoc: input.grnNumber,
        employeeId: input.userId,
        employeeName: input.userName,
      },
    })

    return { kind: 'applied', previousQty: oldQty, newQty, costPerUnit: newCost / 100 }
  }

  return { kind: 'contended' }
}
