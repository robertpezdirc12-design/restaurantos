import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, r2, jparse, jstr, mapReceipt } from '@/lib/map'
import { nextSequence } from '@/lib/sequences'
import { publishEvent } from '@/lib/events'
import { OrderError } from '@/lib/ops'
import { fiscalAdapterFor } from '@/lib/fiscal'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Fiskalni storno (umnik/povračilo) računa — P1 točka 1 iz docs/RESTAURANTOS-AUDIT.md.
 *
 * Ustvari STORNO račun z negativnimi zneski (exactna negacija originala), nastavi
 * naročilo na paymentStatus='storno', povrne razknjiženo zalogo (StockTransaction
 * type='STORNO_RETURN' + povračilo serij po StockBatchAllocation) in zapiše revizijo
 * RECEIPT_STORNO — VSE v ENI transakciji (isti vzorec kot /api/furs POST).
 *
 * Pravila (fail-closed):
 *  - 404: originalni račun ne obstaja / pripadajoče naročilo ne obstaja.
 *  - 403: tuja lokacija (guardResource — lokacijska + org meja; centralne vloge prej bypass).
 *  - 409: storno računa (isStorno=true) — storna ni mogoče še enkrat stornirati.
 *  - 409: kopija računa (isCopy=true) — storno je mogoč SAMO za originalni račun
 *         (kopija je reprint brez lastnega življenja; storno kopije bi podvojil umik).
 *  - 409: naročilo ni 'paid' — samo plačana naročila se stornirajo (R10 vzorec).
 *  - 409: dvojni storno — preverba znotraj transakcije (race varna) + fail-fast zunaj.
 *
 * Fiskalna polja: replikacija vedenja /api/furs POST (simulacija → ZOI/EOR + 'verified',
 * produkcija brez certifikata → prazne kode + 'pending') — NIč ne izmišljujemo.
 * Številčenje: isti Counter (`receipt:<locationId>`) in isti format št. računa.
 */

/** Tip transakcije povračila zaloge ob stornu (pozitivna količina — vračilo na zalogo). */
const STORNO_RETURN_TX_TYPE = 'STORNO_RETURN'

const r3 = (n: number) => Math.round(n * 1000) / 1000

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'furs.issue')
  if (isResponse(user)) return user
  const { id } = await ctx.params

  // ── Predhodne preverbe (definitivni odgovori, ne transakcijski) ──
  const original = await db.receipt.findUnique({ where: { id } })
  if (!original) return fail('Račun ne obstaja.', 404)

  // Issue #4 §1 vzorec: storno tujega računa (druga lokacija) je ZAVRJENO
  const locGuard = await guardResource(user, original.locationId)
  if (locGuard) return locGuard

  if (original.isStorno) {
    return fail('Računa, ki je že storno, ni mogoče še enkrat stornirati.', 409)
  }
  if (original.isCopy) {
    return fail('Kopije računa ni mogoče stornirati — storno je mogoč samo za originalni račun.', 409)
  }

  // Fail-fast preverba dvojnega storna (race-varena preverba je še znotraj transakcije)
  const existingStorno = await db.receipt.findFirst({
    where: { stornoOf: original.id },
    select: { receiptNumber: true },
  })
  if (existingStorno) {
    return fail(`Račun je že storniran (storno račun ${existingStorno.receiptNumber}).`, 409)
  }

  const order = await db.order.findUnique({ where: { id: original.orderId } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  if (order.paymentStatus !== 'paid') {
    return fail('Storno je mogoč samo za plačano naročilo.', 409)
  }

  const location = await db.location.findUnique({ where: { id: original.locationId } })
  if (!location) return fail('Lokacija ne obstaja.', 400)

  // Isti fiskalni režim kot /api/furs POST (simulacija / produkcija pending do certifikata)
  const fursEnv = process.env.FURS_ENVIRONMENT || location.fursEnvironment || 'simulation'
  const simulation =
    process.env.FURS_ALLOW_SIMULATION === 'true' || ['simulation', 'test'].includes(fursEnv.toLowerCase())

  // ── Negacija originalnih zneskov (storno TOČNO uniči original — brez preračuna) ──
  const subtotal = r2(-num(original.subtotal))
  const totalVat = r2(-num(original.totalVat))
  const discount = r2(-num(original.discount))
  const total = r2(-num(original.total))
  const tip = r2(-num(original.tip))
  const totalWithTip = r2(-num(original.totalWithTip))
  const vatMapOrig = jparse<Record<string, { base?: unknown; vat?: unknown }>>(original.vatBreakdown, {})
  const vatMap: Record<string, { base: number; vat: number }> = {}
  for (const [rate, v] of Object.entries(vatMapOrig)) {
    if (!v || typeof v !== 'object') continue
    vatMap[rate] = { base: r2(-num(v.base)), vat: r2(-num(v.vat)) }
  }

  const now = new Date()

  try {
    const result = await db.$transaction(async (tx) => {
      // ── CAS zaščita (R10 vzorec): naročilo spremenimo SAMO če je še 'paid' —
      // sočasni/dvojni storno izgubi dirko (račun prejšnjega klicalca že obstaja) ──
      const cas = await tx.order.updateMany({
        where: { id: order.id, paymentStatus: 'paid' },
        data: { paymentStatus: 'storno' },
      })
      if (cas.count === 0) {
        const twin = await tx.receipt.findFirst({
          where: { stornoOf: original.id },
          select: { receiptNumber: true },
        })
        throw new OrderError(
          twin
            ? `Račun je že storniran (storno račun ${twin.receiptNumber}).`
            : 'Naročilo ni več v stanju "paid" — storno ni mogoč.',
          409,
        )
      }
      // Race varna preverba dvojnega storna (znotraj transakcije — zahteva naloge)
      const dup = await tx.receipt.findFirst({ where: { stornoOf: original.id }, select: { id: true } })
      if (dup) throw new OrderError('Račun je že storniran.', 409)

      // ── Številčenje: ISTI Counter vzorec kot /api/furs (location-scoped, atomaren) ──
      const seqFloor = await tx.receipt.count({ where: { locationId: location.id } })
      const seq = await nextSequence(tx, `receipt:${location.id}`, seqFloor + 1)
      const y = now.getFullYear()
      const m = now.getMonth() + 1
      const receiptNumber = `${y}-${m}-${seq}-${location.premisesId || 'BLG001'}`

      // ── Fiskalne kode: replikacija /api/furs (SI → ZOI/EOR, HR → ZKI/JIR v cis poljih) ──
      const fiscal = fiscalAdapterFor(location.country)
      const isHrFiscal = fiscal.country === 'HR'
      const codes = fiscal.computeCodes({
        taxId: location.taxId || '',
        issuedAt: now,
        receiptNumber,
        premisesId: location.premisesId || 'BLG001',
        total,
        simulation,
      })
      const zoi = isHrFiscal ? '' : codes.protective
      const eor = isHrFiscal ? '' : codes.verification

      const created = await tx.receipt.create({
        data: {
          id: nid(),
          receiptNumber,
          orderId: original.orderId,
          // poslovni podatki se KOPIRAJO iz originala (storno velja za ISTI dokument)
          businessName: original.businessName,
          businessAddress: original.businessAddress,
          businessId: original.businessId,
          taxId: original.taxId,
          registerId: original.registerId,
          zoi,
          eor,
          fiscalVerified: simulation,
          fiscalStatus: simulation ? 'verified' : 'pending',
          verificationDate: simulation ? now : null,
          subtotal,
          vatBreakdown: jstr(vatMap),
          totalVat,
          discount,
          total,
          tip,
          totalWithTip,
          paymentMethod: original.paymentMethod,
          isStorno: true,
          stornoOf: original.id,
          printedAt: now,
          locationId: original.locationId,
          cisStatus: isHrFiscal ? (simulation ? 'verified' : 'pending') : 'none',
          cisZki: isHrFiscal ? codes.protective : '',
          cisJir: isHrFiscal ? codes.verification : '',
        },
      })

      // ── Povračilo zaloge: vsi SALE odjemi tega naročila se vrnejo (ista transakcija
      // kot račun — če storno pade, se zaloga ne spremeni). Vzorec R2/R4: atomarni
      // increment + r3 normalizacija (SQLite REAL drift), previousQty/newQty iz sveže
      // vrednosti PO prirastu (vedno resničen par, tudi ob sočasnosti). ──
      const saleTxs = await tx.stockTransaction.findMany({
        where: { orderId: order.id, type: 'SALE' },
        select: { id: true, inventoryItemId: true, quantity: true, costPerUnit: true },
        orderBy: { createdAt: 'asc' },
      })
      let stockReversalCount = 0
      const restoredItems: { id: string; qty: number }[] = []

      for (const sale of saleTxs) {
        const restore = r3(-num(sale.quantity)) // SALE je negativen → povračilo pozitivno
        if (restore <= 0) continue

        // Glavna zaloga: atomarni prirast (fail-closed — napaka pade cela transakcija)
        await tx.inventoryItem.updateMany({
          where: { id: sale.inventoryItemId },
          data: { quantity: { increment: restore } },
        })
        const fresh = await tx.inventoryItem.findUnique({
          where: { id: sale.inventoryItemId },
          select: { quantity: true },
        })
        const rawQty = num(fresh?.quantity)
        const after = r3(rawQty)
        if (after !== rawQty) {
          await tx.inventoryItem.update({ where: { id: sale.inventoryItemId }, data: { quantity: after } })
        }
        const prevQty = r3(after - restore)

        // Serije (fail-open, kot zahteva spec): manjkajoča serija → opomba, ne blokira.
        // Glavna količina se VEDNO povrne; serija je samo FEFO sledljivost.
        const notes: string[] = []
        const allocs = await tx.stockBatchAllocation.findMany({
          where: { stockTransactionId: sale.id },
          select: { batchId: true, quantity: true },
        })
        for (const a of allocs) {
          const q = r3(num(a.quantity))
          if (q <= 0) continue
          const batch = await tx.inventoryBatch.findUnique({
            where: { id: a.batchId },
            select: { status: true, quantityRemaining: true },
          })
          if (!batch) {
            notes.push(`Serija ${a.batchId} ne obstaja več — povračilo na serijo preskočeno.`)
            continue
          }
          await tx.inventoryBatch.updateMany({
            where: { id: a.batchId },
            data: { quantityRemaining: { increment: q } },
          })
          const bfresh = await tx.inventoryBatch.findUnique({
            where: { id: a.batchId },
            select: { quantityRemaining: true, status: true },
          })
          const braw = num(bfresh?.quantityRemaining)
          const bAfter = r3(braw)
          if (bAfter !== braw) {
            await tx.inventoryBatch.update({ where: { id: a.batchId }, data: { quantityRemaining: bAfter } })
          }
          // serija je bila ob izprodaji označena EXHAUSTED → s povračilom spet ACTIVE
          if (bfresh?.status === 'EXHAUSTED' && bAfter > 0.0005) {
            await tx.inventoryBatch.updateMany({
              where: { id: a.batchId, status: 'EXHAUSTED' },
              data: { status: 'ACTIVE' },
            })
          }
        }

        await tx.stockTransaction.create({
          data: {
            id: nid(),
            inventoryItemId: sale.inventoryItemId,
            type: STORNO_RETURN_TX_TYPE,
            quantity: restore,
            previousQty: prevQty,
            newQty: after,
            costPerUnit: num(sale.costPerUnit),
            totalCost: r2(num(sale.costPerUnit) * restore),
            reason: `Storno računa ${receiptNumber} — povračilo razknjižbe`,
            note: notes.join(' '),
            employeeId: user.sub,
            employeeName: user.name,
            orderId: order.id,
          },
        })
        stockReversalCount += 1
        restoredItems.push({ id: sale.inventoryItemId, qty: restore })
      }

      // ── Revizija znotraj transakcije (isti vzorec kot INVOICE_ISSUE v /api/furs) ──
      await writeAudit(tx, { userId: user.sub, action: 'RECEIPT_STORNO', entityType: 'Receipt', entityId: created.id, details: jstr({
            originalReceiptId: original.id,
            originalReceiptNumber: original.receiptNumber,
            stornoReceiptId: created.id,
            stornoReceiptNumber: receiptNumber,
            orderId: order.id,
            total,
            stockReversalCount,
            simulation,
          }), locationId: original.locationId })

      return { created, stockReversalCount, restoredItems }
    })

    // Evidenca gibanja zaloge (fire-and-forget, isti vzorec kot reverzija odpada)
    for (const it of result.restoredItems) {
      void publishEvent('StockChanged', {
        entityType: 'InventoryItem',
        entityId: it.id,
        payload: {
          variance: it.qty,
          cause: 'receipt-storno',
          receiptNumber: result.created.receiptNumber,
          orderId: order.id,
          by: user.name,
          // 33-c: locationId v payloadu (lokacijsko vidni dogodki — audit §6)
          locationId: original.locationId,
        },
      }).catch(() => undefined)
    }

    return ok({
      invoice: {
        ...mapReceipt(result.created),
        isStorno: true,
        stornoOf: original.id,
        stornoOfReceiptNumber: original.receiptNumber,
      },
      storno: {
        originalReceiptId: original.id,
        originalReceiptNumber: original.receiptNumber,
        stornoReceiptNumber: result.created.receiptNumber,
        restoredStockItems: result.stockReversalCount,
        fiscalVerified: result.created.fiscalVerified,
        fiscalStatus: result.created.fiscalStatus,
        simulation,
      },
      order: { id: order.id, paymentStatus: 'storno' },
    }, 201)
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status)
    console.error('[receipt storno POST] transakcija ni uspela:', e)
    return fail('Storna ni bilo mogoče zaključiti. Stanje je nespremenjeno — poskusite znova.', 500)
  }
}
