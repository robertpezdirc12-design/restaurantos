import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num, jstr } from '@/lib/map'
import {
  grnNumberFor,
  validateReceiveLines,
  itemStatusAfter,
  poStatusAfter,
  weightedAvgCostCents,
  priceHistoryRows,
  parsePaymentTermsDays,
  apNumberFor,
  apLineTotalGross,
  type PoStatus,
  type ReceiveLineInput,
} from '@/lib/procurement'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'

/**
 * Issue #1 (triage ②) — prevzem blaga (GRN) z avtomatskim vplivom na zalogo.
 *
 * POST /api/purchase-orders/[id]/receive
 *   { idempotencyKey?, supplierDocNumber?, notes?, lines:
 *     [{ purchaseOrderItemId, quantityAccepted, quantityRejected, rejectReason?, expiryDate? }] }
 *
 *   → v ENI transakciji:
 *     1. GoodsReceipt + GoodsReceiptItem (naročeno/prejeto po vrstici)
 *     2. zaloga: InventoryItem.quantity += sprejeto, costPerUnit = uteženo povprečje
 *     3. InventoryBatch (serija: lot = GRN-vrstica, dobavitelj, rok, enotna cena)
 *     4. StockTransaction (tip 'purchase' — sled vsake spremembe zaloge)
 *     5. SupplierPriceHistory (zgodovina nabavnih cen, source = goods_receipt)
 *     6. status postavk (pending/partial/received) in naročila (partial/received)
 *     7. audit GRN_RECEIVE (vključno z over-receipt opozorili)
 *
 *   Pravica: inventory.manage. Idempotentnost: idempotencyKey (unique na PO+key)
 *   → ponoven klic vrne obstoječi prevzem (200). Prejem samo zavrnitev brez
 *   sprejema ni prevzem (400). §18: obstoječi tokovi ostanejo nedotaknjeni.
 */

const RECEIVABLE: readonly string[] = ['approved', 'partial']

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: { Supplier: { select: { id: true, name: true, paymentTerms: true } }, PurchaseOrderItem: true },
  })
  if (!po) return fail('Naročilo ne obstaja.', 404)
  if (!RECEIVABLE.includes(po.status)) {
    return fail(`Prevzem je mogoč samo na odobrenem naročilu (approved/partial) — to je "${po.status}".`, 409)
  }

  // idempotentnost: obstoječi prevzem za isti ključ → vrni ga (ne podvojuj)
  const idempotencyKey = body?.idempotencyKey ? String(body.idempotencyKey) : null
  if (idempotencyKey) {
    const existing = await db.goodsReceipt.findUnique({
      where: { purchaseOrderId_idempotencyKey: { purchaseOrderId: id, idempotencyKey } },
      include: { GoodsReceiptItem: true },
    })
    if (existing) {
      return ok({
        receipt: { id: existing.id, grnNumber: existing.grnNumber, status: existing.status, idempotentReplay: true },
      })
    }
  }

  const itemById = new Map(po.PurchaseOrderItem.map((i) => [i.id, i]))
  // expiryDate potuje s vrstico (rok trajanja serije) — receptura ReceiveLineInput je ožja,
  // zato nosimo rok po stranskem kanalu (map itemId → expiryDate) za InventoryBatch
  const expiryByItem = new Map<string, string>()
  const rawLines: ReceiveLineInput[] = (Array.isArray(body.lines) ? body.lines : []).map((l: Record<string, unknown>) => {
    if (l?.purchaseOrderItemId && l?.expiryDate) expiryByItem.set(String(l.purchaseOrderItemId), String(l.expiryDate))
    return {
      purchaseOrderItemId: String(l?.purchaseOrderItemId || ''),
      quantityAccepted: num(l?.quantityAccepted),
      quantityRejected: num(l?.quantityRejected),
      rejectReason: l?.rejectReason ? String(l.rejectReason) : undefined,
    }
  })

  const v = validateReceiveLines(
    po.PurchaseOrderItem.map((i) => ({
      id: i.id,
      description: i.description,
      quantityOrdered: Number(i.quantityOrdered),
      quantityReceivedSoFar: Number(i.quantityReceived),
    })),
    rawLines
  )
  if (v.errors.length) return fail(v.errors.join(' '), 400)

  // enotna lokacija prevzema: body.locationId, sicer naročilo, sicer uporabnik
  const locationId = (body?.locationId ? String(body.locationId) : '') || po.locationId || user.loc || null

  const receiptId = nid()
  const now = new Date()
  const dayPrefix = grnNumberFor(now, 1).slice(0, 13)

  // številčenje GRN znotraj dneva
  const seq = (await db.goodsReceipt.count({ where: { grnNumber: { startsWith: dayPrefix } } })) + 1
  const grnNumber = grnNumberFor(now, seq)

  // per-item določitev statusa (za odgovor in audit)
  const itemStatuses: ('pending' | 'partial' | 'received')[] = po.PurchaseOrderItem.map((i) => {
    const line = v.lines.find((l) => l.input.purchaseOrderItemId === i.id)
    return itemStatusAfter(Number(i.quantityOrdered), Number(i.quantityReceived), line?.input.quantityAccepted ?? 0, line?.input.quantityRejected ?? 0)
  })
  const nextPoStatus = poStatusAfter(itemStatuses)

  const result = await db
    .$transaction(async (tx) => {
      // 1. prevzemni dokument + vrstice
      const receipt = await tx.goodsReceipt.create({
        data: {
          id: receiptId,
          grnNumber,
          purchaseOrderId: id,
          supplierId: po.supplierId,
          status: 'confirmed',
          supplierDocNumber: String(body?.supplierDocNumber || ''),
          notes: String(body?.notes || ''),
          receivedById: user.sub || null,
          receivedByName: user.name || '',
          receivedAt: now,
          locationId,
          idempotencyKey,
        },
      })

      for (const l of v.lines) {
        const acc = l.input.quantityAccepted
        const rej = l.input.quantityRejected
        if (acc === 0 && rej === 0) continue
        const poItem = itemById.get(l.input.purchaseOrderItemId)!
        await tx.goodsReceiptItem.create({
          data: {
            id: nid(),
            goodsReceiptId: receiptId,
            purchaseOrderItemId: poItem.id,
            inventoryItemId: poItem.inventoryItemId,
            description: poItem.description,
            unit: poItem.unit,
            quantityAccepted: acc,
            quantityRejected: rej,
            rejectReason: rej > 0 ? String(l.input.rejectReason || '') : '',
            packQty: poItem.packQty,
            packUnit: poItem.packUnit,
            unitPriceOrdered: poItem.unitPrice,
          },
        })
      }

      // 2.–5. zaloga, serije, sled in cene — samo sprejete postavke z artikel povezavo
      for (const l of v.lines) {
        const acc = l.input.quantityAccepted
        if (acc <= 0) continue
        const poItem = itemById.get(l.input.purchaseOrderItemId)!
        if (!poItem.inventoryItemId) continue

        const inv = await tx.inventoryItem.findUnique({ where: { id: poItem.inventoryItemId } })
        if (!inv) continue

        const oldQty = Number(inv.quantity)
        const oldCostCents = Math.round(Number(inv.costPerUnit) * 100)
        const unitPrice = Number(poItem.unitPrice)
        const addCostCents = Math.round(unitPrice * 100)
        const newQty = oldQty + acc
        const newCost = weightedAvgCostCents(oldQty, oldCostCents, acc, addCostCents)

        // 2. zaloga + utežena povprečna cena
        await tx.inventoryItem.update({
          where: { id: inv.id },
          data: { quantity: newQty, costPerUnit: newCost / 100, lastRestocked: now },
        })

        // 3. serija (sledljivost: dobavitelj, rok, cena)
        const expiryRaw = expiryByItem.get(l.input.purchaseOrderItemId)
        const expiryDate = expiryRaw ? new Date(expiryRaw) : null
        await tx.inventoryBatch.create({
          data: {
            id: nid(),
            inventoryItemId: inv.id,
            locationId,
            lotNumber: `${grnNumber}-${l.index + 1}`,
            supplierId: po.supplierId,
            supplierName: po.Supplier?.name || '',
            receivedAt: now,
            expiryDate: expiryDate && !isNaN(expiryDate.getTime()) ? expiryDate : null,
            quantityInitial: acc,
            quantityRemaining: acc,
            unit: inv.unit,
            unitCost: newCost / 100,
            status: 'active',
          },
        })

        // 4. StockTransaction — sled vsake spremembe zaloge
        await tx.stockTransaction.create({
          data: {
            id: nid(),
            inventoryItemId: inv.id,
            type: 'purchase',
            quantity: acc,
            previousQty: oldQty,
            newQty,
            costPerUnit: newCost / 100,
            totalCost: (addCostCents * acc) / 100,
            reason: `Prevzem ${grnNumber}`,
            note: poItem.description,
            supplierDoc: grnNumber,
            employeeId: user.sub || null,
            employeeName: user.name || '',
          },
        })
      }

      // 5. zgodovina nabavnih cen
      const historyRows = priceHistoryRows({
        supplierId: po.supplierId,
        purchaseOrderId: id,
        locationId,
        observedAt: now,
        lines: v.lines.map((l) => {
          const poItem = itemById.get(l.input.purchaseOrderItemId)!
          return {
            inventoryItemId: poItem.inventoryItemId,
            quantityAccepted: l.input.quantityAccepted,
            unitPrice: Number(poItem.unitPrice),
            unit: poItem.unit,
            vatRate: Number(poItem.vatRate),
          }
        }),
      })
      if (historyRows.length) {
        await tx.supplierPriceHistory.createMany({
          data: historyRows.map((h) => ({ ...h, id: nid(), note: grnNumber })),
        })
      }

      // 6. statusi postavk + naročila
      for (const l of v.lines) {
        const acc = l.input.quantityAccepted
        const rej = l.input.quantityRejected
        if (acc === 0 && rej === 0) continue
        const poItem = itemById.get(l.input.purchaseOrderItemId)!
        const status = itemStatusAfter(Number(poItem.quantityOrdered), Number(poItem.quantityReceived), acc, rej)
        await tx.purchaseOrderItem.update({
          where: { id: poItem.id },
          data: {
            quantityReceived: Number(poItem.quantityReceived) + acc,
            quantityRejected: Number(poItem.quantityRejected) + rej,
            status,
          },
        })
      }
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status: nextPoStatus,
          receivedDate: nextPoStatus === 'received' ? now : po.receivedDate,
        },
      })

      // 6b. OPS-8 val 2 (v1.72.0) — PO→AccountsPayable bridge (idempotent, fail-safe):
      // a GRN creates the AP liability (due date = supplier payment terms).
      // An AP insert failure MUST NOT break the receipt (GRN is the critical path) → try/catch.
      try {
        const invoiceNumber = String(body?.supplierDocNumber || '') || grnNumber
        const apExists = await tx.accountsPayable.findFirst({
          where: { purchaseOrderId: id, invoiceNumber },
          select: { id: true },
        })
        if (!apExists) {
          const acceptedLines = v.lines.filter((l) => l.input.quantityAccepted > 0)
          if (acceptedLines.length > 0) {
            let subtotal = 0
            let vatAmount = 0
            const apLines = acceptedLines.map((l) => {
              const poItem = itemById.get(l.input.purchaseOrderItemId)!
              const qty = l.input.quantityAccepted
              const unitPrice = Number(poItem.unitPrice)
              const vatRate = Number(poItem.vatRate) || 22
              const net = Math.round(qty * unitPrice * 100) / 100
              const gross = apLineTotalGross(qty, unitPrice, vatRate)
              subtotal += net
              vatAmount += Math.round((gross - net) * 100) / 100
              return {
                purchaseOrderItemId: poItem.id,
                description: poItem.description,
                quantityInvoiced: qty,
                unitPriceInvoiced: unitPrice,
                vatRateInvoiced: vatRate,
                lineTotal: gross,
              }
            })
            subtotal = Math.round(subtotal * 100) / 100
            vatAmount = Math.round(vatAmount * 100) / 100
            const termsDays = parsePaymentTermsDays(po.Supplier?.paymentTerms)
            const dueDate = new Date(now.getTime() + termsDays * 86400000)
            const year = now.getFullYear()
            let apId: string | null = null
            for (let attempt = 0; attempt < 5 && !apId; attempt++) {
              const seq = (await tx.accountsPayable.count({ where: { apNumber: { startsWith: `AP-${year}-` } } })) + 1 + attempt
              try {
                const ap = await tx.accountsPayable.create({
                  data: {
                    id: nid(),
                    apNumber: apNumberFor(year, seq),
                    supplierId: po.supplierId,
                    purchaseOrderId: id,
                    invoiceNumber,
                    invoiceDate: now,
                    dueDate,
                    subtotal,
                    vatAmount,
                    totalAmount: Math.round((subtotal + vatAmount) * 100) / 100,
                    status: 'open',
                    matchStatus: 'matched',
                    notes: `GRN ${grnNumber} (${po.poNumber})`,
                    locationId,
                    AccountsPayableLine: {
                      create: apLines.map((l) => ({ id: nid(), ...l })),
                    },
                  },
                })
                apId = ap.id
              } catch (e) {
                const emsg = String((e as Error).message || '')
                if (emsg.includes('apNumber') && attempt < 4) continue // sočasno številčenje — retry
                throw e
              }
            }
            if (apId) {
              await tx.purchaseOrder.update({
                where: { id },
                data: { invoiceStatus: 'invoiced', accountsPayableId: apId },
              })
            }
          }
        }
      } catch (apErr) {
        // fail-safe: the liability bridge must not break stock receipting
        console.error('[grn] AccountsPayable most ni uspel (prevzem ostaja veljaven):', apErr)
      }

      // 7. audit
      await writeAudit(tx, { userId: user.sub, action: 'GRN_RECEIVE', entityType: 'GoodsReceipt', entityId: receiptId, details: jstr({
            grnNumber,
            poNumber: po.poNumber,
            supplierId: po.supplierId,
            supplierName: po.Supplier?.name || '',
            lines: v.lines.length,
            accepted: v.lines.reduce((a, l) => a + l.input.quantityAccepted, 0),
            rejected: v.lines.reduce((a, l) => a + l.input.quantityRejected, 0),
            overReceipt: v.overReceipt,
            warnings: v.warnings,
            poStatus: `${po.status} → ${nextPoStatus}`,
            stockItemsTouched: v.lines.filter((l) => l.input.quantityAccepted > 0 && itemById.get(l.input.purchaseOrderItemId)?.inventoryItemId).length,
            locationId,
          }) })

      return receipt
    })
    .catch((e: unknown) => {
      const msg = String((e as Error).message || '')
      if (idempotencyKey && msg.includes('purchaseOrderId_idempotencyKey')) return null // sočasni ponovljen klic
      throw e
    })

  if (!result && idempotencyKey) {
    const existing = await db.goodsReceipt.findUnique({
      where: { purchaseOrderId_idempotencyKey: { purchaseOrderId: id, idempotencyKey } },
    })
    return ok({ receipt: { id: existing?.id, grnNumber: existing?.grnNumber, status: existing?.status, idempotentReplay: true } })
  }
  if (!result) return fail('Prevzem ni bil ustvarjen.', 500)

  // OPS-8 val 2 (v1.72.0): push to warehouse/management on receipt (via notification matrix;
  // fire-and-forget)
  void pushEvent('PO_RECEIVED', {
    title: 'Prevzem zaključen',
    body: `${result.grnNumber} · ${po.poNumber} · ${po.Supplier?.name || ''}`,
    url: '/dashboard?tab=nabava',
    tag: `po-received-${id}`,
  }, { roles: ['warehouse', 'manager'], locationId })

  return ok(
    {
      receipt: {
        id: result.id,
        grnNumber: result.grnNumber,
        status: result.status,
        poStatus: nextPoStatus,
        warnings: v.warnings,
      },
    },
    201
  )
}
