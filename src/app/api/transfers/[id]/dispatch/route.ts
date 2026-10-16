import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr, r2 } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { pushEvent } from '@/lib/push'
import { writeAudit } from '@/lib/audit-chain'
import { transferTablesReady } from '@/lib/transfer-schema'
import { TransferError, TRF_TX_OUT, transferDto, r3, type TrfRow } from '@/lib/stock-transfer'

/**
 * Issue #8 (P2, v1.116.0) — ODPREMNICA medlokacijskega prenosa.
 *
 * POST /api/transfers/[id]/dispatch  { note? }
 *   DRAFT → DISPATCHED. V ENI transakciji ( rollback celote!):
 *     1. ANCHOR na vrstici IZVORNE lokacije (vzorec #63 — serializira sočasne
 *        odpremitve/zaloge za isto lokacijo);
 *     2. CAS na status (updateMany where status DRAFT) — dvojni klik/sočasnost
 *        → 409 'Prenos je medtem že odpremljen.', BREZ knjiženja;
 *     3. per vrstica: FRESH item read v TX (premik med branjem → 400 rollback),
 *        zaloga ≥ requested sicer 409 (ime + dejanska razpoložljivost),
 *        CAS dekrement (gte guard + retry ≤3 — inventory.ts 163-181 vzorec);
 *     4. serija: FRESH batch read, CAS dekrement quantityRemaining (STROGO —
 *        serija ne sme podpreti več, kot je njej na voljo; 409 rollback),
 *        izčrpana serija → EXHAUSTED (SAMO ACTIVE → nikoli karantena);
 *     5. StockTransaction TRF_TX_OUT (podpisana NEGATIVNA) — ledger ≡ DB:
 *        previousQty/newQty iz FRESH post-dekrement branj (issue #52),
 *        FK-varni vrstni red: StockTransaction NAJPREJ → šele nato
 *        StockBatchAllocation (Task 32-c lekcija);
 *     6. audit TRANSFER_DISPATCHED (števci, ne vrstice).
 *   Po TX (fail-soft, ne podre odpremnice): publishEvent StockChanged na
 *   IZVORNI lokaciji + push TRANSFER_DISPATCHED vodstvu/skladišču CILJNE
 *   lokacije (blago je v tranzitu — prejemnik ve, da ga čaka prevzem).
 *
 * Pravica: inventory.manage + guardResource(from). PRE-DDL: 503 (graceful).
 */

const DISPATCH_NOTE_MAX = 500

/** sočasna odpremitev (CAS izgubil) — 409, brez dvojnega knjiženja */
class ConcurrentDispatchError extends Error {
  constructor() {
    super('Prenos je medtem že odpremljen.')
  }
}

/** premalo zaloge (ime artikla + dejanska razpoložljivost) — 409 */
class InsufficientStockError extends Error {
  constructor(itemName: string, available: number) {
    super(`Premalo zaloge za "${itemName}" (na voljo ${r3(available)}).`)
  }
}

/** serija ne pokrije količine (STROGO — ne podpremo čez serijo) — 409 */
class InsufficientBatchError extends Error {
  constructor(itemName: string, lotNumber: string, available: number) {
    super(`Serija ${lotNumber} za "${itemName}" ne pokrije prenosa (na voljo ${r3(available)}).`)
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await transferTablesReady())) {
    return fail('Prenosi čakajo na shemsko migracijo (Enterprise → Shema migracije → stock-transfers).', 503)
  }
  const { id } = await ctx.params

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Neveljavno telo zahtevka.', 400)
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, DISPATCH_NOTE_MAX) : ''

  const transfer = await db.stockTransfer.findUnique({
    where: { id },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  })
  if (!transfer) return fail('Prenos ne obstaja.', 404)

  // odpošilja SAMO izvorna lokacija (prejemnik ne more dvigniti tuje zaloge)
  const guarded = await guardResource(user, transfer.fromLocationId)
  if (guarded) return guarded

  // dvojni klik / napačno stanje → 409 BREZ mutacije (termin DRAFT velja)
  if (transfer.status !== 'DRAFT') {
    return fail('Prenos ni v stanju osnutka.', 409)
  }

  const now = new Date()
  let totalQty = 0
  let totalCost = 0

  try {
    const updated = await db.$transaction(async (tx) => {
      // 1. ANCHOR na vrstici IZVORNE lokacije (#63): SQLite pridabi izključni
      //    pisljivi zaklep, PostgreSQL vrstični zaklep — serializira sočasne
      //    odpremitve prodaje/odpisa za isto lokacijo.
      const anchor = await tx.location.updateMany({ where: { id: transfer.fromLocationId }, data: { updatedAt: now } })
      if (anchor.count === 0) throw new TransferError('Izvorna lokacija ne obstaja.', 404)

      // 2. CAS na status: uspe samo iz DRAFT — sočasni dvojni klik izgubi,
      //    nič se NE knjiži dvakrat (rollback celote)
      const cas = await tx.stockTransfer.updateMany({
        where: { id: transfer.id, status: 'DRAFT' },
        data: { status: 'DISPATCHED', dispatchedAt: now, dispatchedById: user.sub },
      })
      if (cas.count === 0) throw new ConcurrentDispatchError()

      for (const line of transfer.items) {
        const requested = r3(num(line.requestedQty))
        if (requested <= 0) continue

        // 3. FRESH item read ZNOTRAJ TX — artikel je lahko premaknjen/pobrisan
        const item = await tx.inventoryItem.findUnique({ where: { id: line.inventoryItemId } })
        if (!item) throw new TransferError('Artikel ne obstaja.', 404)
        if (item.locationId !== transfer.fromLocationId) {
          throw new TransferError('Artikel ni več na izvorni lokaciji.', 400)
        }

        const available = r3(num(item.quantity))
        if (requested > available + 0.0005) {
          throw new InsufficientStockError(item.name, available)
        }

        // CAS dekrement (gte guard) + retry ≤3 z svežim branjem (inventory.ts
        // 163-181 vzorec — sočasen odjem med branjem in zapisom)
        let decremented = false
        for (let attempt = 0; attempt < 3 && !decremented; attempt++) {
          const res = await tx.inventoryItem.updateMany({
            where: { id: item.id, quantity: { gte: requested } },
            data: { quantity: { decrement: requested } },
          })
          decremented = res.count === 1
          if (decremented) break
          const fresh = await tx.inventoryItem.findUnique({ where: { id: item.id }, select: { quantity: true } })
          const avail = r3(num(fresh?.quantity))
          if (requested > avail + 0.0005) throw new InsufficientStockError(item.name, avail)
        }
        if (!decremented) throw new InsufficientStockError(item.name, 0)

        // 5. StockTransaction — LEDGER ≡ DB (issue #52): previousQty/newQty iz
        // FRESH post-dekrement stanja (dva sočasna prenosa pišeta
        // 100→90 in 90→80, ne oba 100→90)
        const freshQty = await tx.inventoryItem.findUnique({ where: { id: item.id }, select: { quantity: true } })
        const newQty = r3(Math.max(0, num(freshQty?.quantity)))
        const prevQty = r3(newQty + requested)
        const unitCost = line.unitCost != null ? r2(num(line.unitCost)) : r2(num(item.costPerUnit))
        const lineCost = r2(unitCost * requested)
        totalQty = r3(totalQty + requested)
        totalCost = r2(totalCost + lineCost)

        // FK-varni vrstni red (Task 32-c): StockTransaction NAJPREJ —
        // alokacija ima FK nase in bi brez nje padla CELA transakcija
        const txId = nid()
        await tx.stockTransaction.create({
          data: {
            id: txId,
            inventoryItemId: item.id,
            type: TRF_TX_OUT,
            quantity: -requested,
            previousQty: prevQty,
            newQty,
            costPerUnit: unitCost,
            totalCost: lineCost,
            reason: `Medlokacijski prenos ${transfer.transferNumber}`,
            note: line.note || item.name,
            supplierDoc: transfer.transferNumber,
            employeeId: user.sub,
            employeeName: user.name,
          },
        })

        // 4. serija izvora: STROGI CAS dekrement (serija ne sme podpreti več,
        //    kot je na voljo — dokumentirana odločitev: vrednostna celovitost
        //    prenosa; vrzel se vidi kot 409, ne pa kot serija v minusu)
        if (line.batchId) {
          const batch = await tx.inventoryBatch.findUnique({ where: { id: line.batchId } })
          if (!batch) throw new TransferError('Serija ne obstaja več.', 400)
          if (batch.inventoryItemId !== line.inventoryItemId) {
            throw new TransferError('Serija ne pripada več artiklu postavke.', 400)
          }

          let batchOk = false
          let batchAvail = 0
          for (let attempt = 0; attempt < 3 && !batchOk; attempt++) {
            const res = await tx.inventoryBatch.updateMany({
              where: { id: batch.id, quantityRemaining: { gte: requested } },
              data: { quantityRemaining: { decrement: requested } },
            })
            batchOk = res.count === 1
            if (batchOk) break
            const fresh = await tx.inventoryBatch.findUnique({
              where: { id: batch.id },
              select: { quantityRemaining: true },
            })
            batchAvail = r3(num(fresh?.quantityRemaining))
            if (requested > batchAvail + 0.0005) {
              throw new InsufficientBatchError(item.name, batch.lotNumber, batchAvail)
            }
          }
          if (!batchOk) {
            throw new InsufficientBatchError(item.name, batch.lotNumber, batchAvail)
          }

          // izčrpana serija → EXHAUSTED (SAMO iz ACTIVE/legacy 'active' —
          // karantena/odpoklic NISTA nikoli prekinjena; inventory.ts 328-334)
          await tx.inventoryBatch.updateMany({
            where: { id: batch.id, quantityRemaining: { lte: 0.0005 }, status: { in: ['ACTIVE', 'active'] } },
            data: { status: 'EXHAUSTED' },
          })

          // FK-varno: alokacija ZA StockTransaction
          await tx.stockBatchAllocation.create({
            data: { id: nid(), batchId: batch.id, stockTransactionId: txId, inventoryItemId: item.id, quantity: requested },
          })
        }

        // vrstica: odpremljena količina (opomba ostane — dodamo tisto iz telesa)
        await tx.stockTransferItem.update({
          where: { id: line.id },
          data: {
            dispatchedQty: requested,
            ...(note ? { note: line.note ? `${line.note} · ${note}` : note } : {}),
          },
        })
      }

      // 6. audit (števci — brez vrstic/PII)
      await writeAudit(tx, {
        userId: user.sub,
        action: 'TRANSFER_DISPATCHED',
        entityType: 'StockTransfer',
        entityId: transfer.id,
        details: jstr({
          transferNumber: transfer.transferNumber,
          lines: transfer.items.length,
          totalQty,
          totalCost,
          toLocationId: transfer.toLocationId,
          note,
        }),
        locationId: transfer.fromLocationId,
      })

      return tx.stockTransfer.findUnique({
        where: { id: transfer.id },
        include: { items: { orderBy: { createdAt: 'asc' } }, _count: { select: { items: true } } },
      })
    })

    if (!updated) return fail('Prenos ne obstaja.', 404)

    // fail-soft dogodki (NE podrejo odpremnice)
    await publishEvent('StockChanged', {
      entityType: 'StockTransfer',
      entityId: transfer.id,
      payload: {
        transferNumber: transfer.transferNumber,
        fromLocationId: transfer.fromLocationId,
        toLocationId: transfer.toLocationId,
        totalQty,
        by: user.name,
        cause: 'transfer_dispatch',
        locationId: transfer.fromLocationId,
      },
      locationId: transfer.fromLocationId,
    }).catch(() => undefined)

    // push: vodstvo/skladišče CILJNE lokacije (blago je v tranzitu)
    void pushEvent(
      'TRANSFER_DISPATCHED',
      {
        title: 'Prenos odpremljen',
        body: `${transfer.transferNumber} · ${transfer.items.length} postavk · skupaj ${totalQty}`,
        url: '/dashboard?tab=prenosi',
        tag: `transfer-dispatched-${transfer.id}`,
      },
      { roles: ['manager', 'warehouse'], locationId: transfer.toLocationId },
    )

    return ok({ transfer: transferDto(updated as TrfRow) })
  } catch (e) {
    if (e instanceof ConcurrentDispatchError) return fail(e.message, 409)
    if (e instanceof InsufficientStockError) return fail(e.message, 409)
    if (e instanceof InsufficientBatchError) return fail(e.message, 409)
    if (e instanceof TransferError) return fail(e.message, e.status)
    throw e
  }
}
