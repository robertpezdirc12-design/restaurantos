/**
 * v1.242.0 (PRIMERJAVA-VMESNIKOV-2026 §16 I C — založni val): SKUPNI MOTOR
 * SERIJSKIH ALOKACIJ ZA ODPAD IN INVENTURO.
 *
 * Najdba raziskave: FEFO razporeditev po serijah (InventoryBatch +
 * StockBatchAllocation) je živela SAMO v prodajni poti (deductStockForOrderTx,
 * izdaja računa). Odpad je odšteval AGREGAT (InventoryItem.quantity) brez da bi
 * se katera koli serija dekrementirala — serijski ledger je ostajal stale:
 * quantityRemaining je kazal fantomsko zalogo, FEFO je rezerviral serije, ki
 * fizično ni več bilo, sledljivost lot-a (HACCP / odpoklic) pa je imela luknjo
 * natanko pri odpadu — tam, kjer je najpomembnejša (pokvarjena pošiljka!).
 *
 * Ta lib je namensko LOČEN od prodajnega inline motorja (src/lib/inventory.ts):
 * prodajna pot je bit-za-bit preizkušena (Task 32-c CAS lekcije) in se je ne
 * dotikamo; odpad/inventura pa potrebujejo ista pravila v lažji obliki:
 *  - CAS dekrement po seriji (updateMany z gte guardom, 3 poskusi, fresh read);
 *  - EXHAUSTED status prek lte-guarda (race-varno, količino je že dekrementiral CAS);
 *  - alokacijske VRSTICE (StockBatchAllocation) piše KLICATELJ ŠELE PO tem, ko
 *    obstaja StockTransaction (FK vrstni red — Task 32-c kritični popravek).
 *
 * Čista pravila:
 *  - količina <= 0 → prazna alokacija (klicatelj ima svoje validacije);
 *  - eksplicitna serija (onlyBatchId): CELA količina iz ENE serije ali napaka
 *    (delne alokacije iz izbrane serije ne obstajajo — uporabnik je izbral lot);
 *  - FEFO način: uporabne serije (usableBatchWhere — brez karantene/odpoklica/
 *    pretečenih/odstranjenih), vrstni red dialekt-determinističen;
 *  - če serij ni (ali zmanjkajo): ostanek je "untracked" — vrne se klicatelju,
 *    ki ga Izrecno zapiše v note (vrzel je VIDNA, ne skrita — vzorec Issue #52).
 */

import type { Prisma } from '@prisma/client'
import { num } from '@/lib/map'
import {
  lotGovernanceColumnsReady,
  usableBatchWhere,
  usableBatchWhereLegacy,
  sortUsableFefo,
  BATCH_SELECT_FULL,
  BATCH_SELECT_LEGACY,
  BATCH_STATUS,
} from '@/lib/lot-governance'

type Tx = Prisma.TransactionClient

const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Toleranca za "količina je nič" (Decimal(12,3) domena — 0,0005). */
export const BATCH_QTY_EPSILON = 0.0005

export interface BatchAllocation {
  batchId: string
  /** količina, odvzeta iz serije (pozitivna, 3 decimalki) */
  alloc: number
  /** status serije PO dekrementu (EXHAUSTED pomeni, da je klicatelj dolžan zapisati flip) */
  statusAfter: string
}

export interface BatchAllocateResult {
  /** uspešne alokacije (batch dekrementiran); alokacijske vrstice piše klicatelj */
  allocations: BatchAllocation[]
  /** količina, ki je ostala BREZ serije (ni serij / zmanjkale so / CAS izpad) */
  untracked: number
}

export class ExplicitBatchError extends Error {
  status: number
  constructor(message: string, status = 409) {
    super(message)
    this.status = status
  }
}

/**
 * Alokcija količine po serijah artikla — FEFO ali izrecna serija.
 *
 * @param tx        transakcija klicatelja (vsa dekrementacija je v njej)
 * @param itemId    artikel zaloge
 * @param qty       količina > 0 (ža validirana na 3 decimalki)
 * @param opts.onlyBatchId izrecna serija: cela količina iz nje ali ExplicitBatchError
 *                  (409 premalo na seriji; 404 ne obstaja / ni od tega artikla /
 *                  blokirana ali pretekla)
 *
 * NE piše StockBatchAllocation vrstic (FK na StockTransaction, ki še ne obstaja —
 * klicatelj jih zapiše po create StockTransaction, glej planForTxIds spodaj).
 */
export async function allocateBatchesTx(
  tx: Tx,
  itemId: string,
  qty: number,
  opts?: { onlyBatchId?: string },
): Promise<BatchAllocateResult> {
  const want = r3(qty)
  if (!(want > BATCH_QTY_EPSILON)) return { allocations: [], untracked: 0 }

  // ── izrecna serija: celotna količina iz ene ──
  if (opts?.onlyBatchId) {
    const lotReady = await lotGovernanceColumnsReady()
    const batch = await tx.inventoryBatch.findUnique({
      where: { id: opts.onlyBatchId },
      // pre-DDL degradacija: brez removalDate stolpca teče legacy select (prodaja
      // NIKOLI ne pade na šemo — isti vzorec kot BATCH_SELECT_LEGACY)
      select: {
        id: true, inventoryItemId: true, lotNumber: true, status: true,
        quantityRemaining: true, expiryDate: true,
        ...(lotReady ? { removalDate: true } : {}),
      },
    })
    if (!batch || batch.inventoryItemId !== itemId) {
      throw new ExplicitBatchError('Izbrana serija ne obstaja ali ne pripada temu artiklu.', 404)
    }
    const now = new Date()
    const expired = batch.expiryDate !== null && (batch.expiryDate as Date).getTime() <= now.getTime()
    const removed = lotReady && batch.removalDate !== null && (batch.removalDate as Date).getTime() <= now.getTime()
    const blocked = (batch.status || '').toUpperCase() === BATCH_STATUS.QUARANTINE
      || (batch.status || '').toUpperCase() === BATCH_STATUS.RECALLED
    // status mora biti uporaben (ACTIVE / legacy 'active' — isti tolerantni match kot usableBatchWhere)
    const wrongStatus = !['ACTIVE', 'active'].includes(batch.status || '')
    if (blocked || expired || removed || wrongStatus) {
      throw new ExplicitBatchError(`Serija ${batch.lotNumber} je blokirana (karantena/odpoklic) ali pretekla — odpad iz nje ni mogoč.`, 409)
    }
    const avail = Math.max(0, num(batch.quantityRemaining))
    if (avail + BATCH_QTY_EPSILON < want) {
      throw new ExplicitBatchError(
        `Na seriji ${batch.lotNumber} je samo ${r3(avail)} — odpad ${want} iz te serije ni mogoč. Izberi manjšo količino ali FEFO razporeditev.`,
        409,
      )
    }
    // CAS dekrement cele količine (retry ob sočasnem odjemu — zmanjša se avail)
    let allocated = false
    let take = want
    for (let attempt = 0; attempt < 3 && !allocated; attempt++) {
      const res = await tx.inventoryBatch.updateMany({
        where: { id: batch.id, quantityRemaining: { gte: take } },
        data: { quantityRemaining: { decrement: take } },
      })
      allocated = res.count === 1
      if (!allocated) {
        const fresh = await tx.inventoryBatch.findUnique({ where: { id: batch.id }, select: { quantityRemaining: true } })
        const fa = Math.max(0, num(fresh?.quantityRemaining))
        if (fa + BATCH_QTY_EPSILON < want) {
          throw new ExplicitBatchError(
            `Serija ${batch.lotNumber} je bila sočasno izčrpana — na njej je ostalo ${r3(fa)}. Osveži in poskusi znova.`,
            409,
          )
        }
        take = want // cela količina ali nič
      }
    }
    if (!allocated) {
      throw new ExplicitBatchError(`Serija ${batch.lotNumber} ni mogla biti rezervirana (sočasen odjem) — poskusi znova.`, 409)
    }
    const bNew = r3(avail - want)
    return {
      allocations: [{ batchId: batch.id, alloc: want, statusAfter: bNew <= BATCH_QTY_EPSILON ? BATCH_STATUS.EXHAUSTED : batch.status }],
      untracked: 0,
    }
  }

  // ── FEFO čez uporabne serije (isti vir kot prodajna pot) ──
  const now = new Date()
  const lotReady = await lotGovernanceColumnsReady()
  const batchesRaw = await tx.inventoryBatch.findMany({
    where: {
      inventoryItemId: itemId,
      ...(lotReady ? usableBatchWhere(now) : usableBatchWhereLegacy(now)),
    },
    select: lotReady ? BATCH_SELECT_FULL : BATCH_SELECT_LEGACY,
  })
  const batches = sortUsableFefo(batchesRaw).slice(0, 50)

  const allocations: BatchAllocation[] = []
  let remaining = want
  let untracked = 0

  for (const b of batches) {
    if (remaining <= BATCH_QTY_EPSILON) break
    let avail = Math.max(0, num(b.quantityRemaining))
    let alloc = Math.min(avail, remaining)
    if (alloc <= BATCH_QTY_EPSILON) continue
    let ok = false
    // CAS po seriji (vzorec Task 32-c: ob uspehu TAKOJ prekini)
    for (let attempt = 0; attempt < 3 && alloc > BATCH_QTY_EPSILON; attempt++) {
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
    if (!ok) {
      // Issue #52 vzorec: izpadla serija ne sme tiho izginiti
      untracked = r3(untracked + Math.max(0, alloc))
      continue
    }
    if (alloc <= BATCH_QTY_EPSILON) continue
    const bNew = r3(avail - alloc)
    allocations.push({ batchId: b.id, alloc: r3(alloc), statusAfter: bNew <= BATCH_QTY_EPSILON ? BATCH_STATUS.EXHAUSTED : b.status })
    remaining = r3(remaining - alloc)
  }

  if (remaining > BATCH_QTY_EPSILON) untracked = r3(untracked + remaining)
  return { allocations, untracked }
}

/**
 * Zapis alokacijskih vrstic PO tem, ko obstaja StockTransaction (FK vrstni red).
 * EXHAUSTED flip je lte-guardan (race-varno — količino je že dekrementiral CAS).
 */
export async function writeBatchAllocations(
  tx: Tx,
  stockTransactionId: string,
  itemId: string,
  allocations: readonly BatchAllocation[],
): Promise<number> {
  let written = 0
  for (const a of allocations) {
    if (a.statusAfter === BATCH_STATUS.EXHAUSTED) {
      await tx.inventoryBatch.updateMany({
        where: { id: a.batchId, quantityRemaining: { lte: BATCH_QTY_EPSILON } },
        data: { status: BATCH_STATUS.EXHAUSTED },
      })
    }
    await tx.stockBatchAllocation.create({
      data: {
        id: `${stockTransactionId}-ba${written + 1}`,
        batchId: a.batchId,
        stockTransactionId,
        inventoryItemId: itemId,
        quantity: a.alloc,
      },
    })
    written += 1
  }
  return written
}

/**
 * Povratek količine na serije (reverzija odpada / priliv popisa nazaj v lot):
 *  - inkrement quantityRemaining po alokaciji (ISTI batch, ISTA količina);
 *  - EXHAUSTED → ACTIVE flip, ko lot spet zaživi (status z lte guardom — samo
 *    lot, ki ga JE ta odpad izčrpal);
 *  - blokirane serije (karantena/odpoklic) ohranijo svoj status — fizična
 *    vračila ne spreminjajo odločitve o zadržanju.
 */
export async function restoreBatchAllocations(
  tx: Tx,
  stockTransactionId: string,
): Promise<{ restored: number; batches: number }> {
  const allocs = await tx.stockBatchAllocation.findMany({
    where: { stockTransactionId },
    select: { batchId: true, quantity: true },
  })
  let restored = 0
  for (const a of allocs) {
    const q = r3(num(a.quantity))
    if (!(q > BATCH_QTY_EPSILON)) continue
    await tx.inventoryBatch.updateMany({
      where: { id: a.batchId },
      data: { quantityRemaining: { increment: q } },
    })
    // lot, ki je bil izčrpan z odvzemom, ob povratku spet zaživi
    await tx.inventoryBatch.updateMany({
      where: { id: a.batchId, status: BATCH_STATUS.EXHAUSTED, quantityRemaining: { gt: BATCH_QTY_EPSILON } },
      data: { status: BATCH_STATUS.ACTIVE },
    })
    restored = r3(restored + q)
  }
  return { restored, batches: allocs.length }
}
