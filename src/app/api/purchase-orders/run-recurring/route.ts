import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num, jstr } from '@/lib/map'
import { poNumberFor, computeTotalsCents, computeLineCents } from '@/lib/procurement'
import { isDue, parseRecurringConfig, RECURRING_PO_MARKER, computeNextRun, type RecurringRule } from '@/lib/recurring-po'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * OPS-9 val 2 (v1.75.0) — evalvacija pravil ponavljajočih naročilnic.
 *
 * POST /api/purchase-orders/run-recurring
 *   → naloži pravila (Integration 'recurring-po'), za vsako aktivno + zapadlo
 *     (isDue) ustvari OSNUTEK naročilnice (status 'draft', notes `Recurring #<id>`)
 *     s ceno iz SupplierItem (pricePerPack/packQty) oz. fallback costPerUnit, in
 *     pomakne schedule (lastRun=now, nextRun=computeNextRun). Ne-zapadla pravila
 *     se preskoče (idempotentno).
 *
 * Numeracija in vrstice: ISTI vzorec kot POST /api/purchase-orders (poNumberFor,
 * computeLineCents/computeTotalsCents, count-based seq + retry na unique,
 * aditivni SupplierItem katalog) — ni podvajanja sekvenc.
 *
 * Push: NAMERNO IZPUŠČENO — PUSH_EVENT_TYPES nima 'PO_CREATED' (osnutki so šum;
 * PO_APPROVED/PO_RECEIVED ostaneta za prave prehode).
 *
 * Pravica: inventory.manage. Audit: RECURRING_PO_CREATED per ustvarjen PO.
 * UI kliče ta endpoint ob mountu NabavaTab (lazy trigger, enkrat) + gumb "Zaženi zdaj".
 */

// light in-process guard against double-firing (UI mount + button in the same tick)
let running = false

/** Resolve unit price + vat for a rule item: SupplierItem first, inventory cost fallback. */
async function priceFor(supplierId: string, inventoryItemId: string): Promise<{ unitPrice: number; vatRate: number; name: string; unit: string } | null> {
  const inv = await db.inventoryItem.findUnique({
    where: { id: inventoryItemId },
    select: { name: true, unit: true, costPerUnit: true },
  })
  if (!inv) return null
  const si = await db.supplierItem.findUnique({
    where: { supplierId_inventoryItemId: { supplierId, inventoryItemId } },
    select: { pricePerPack: true, packQty: true, vatRate: true },
  })
  let unitPrice = Number(inv.costPerUnit)
  if (si) {
    const packQty = Number(si.packQty) || 1
    const perPack = Number(si.pricePerPack)
    if (perPack > 0 && packQty > 0) unitPrice = perPack / packQty
  }
  return {
    unitPrice: unitPrice > 0 ? unitPrice : 0,
    vatRate: si?.vatRate != null ? Number(si.vatRate) : 22,
    name: inv.name,
    unit: inv.unit,
  }
}

async function createRecurringPo(args: {
  supplierId: string
  lines: {
    description: string
    inventoryItemId: string
    quantityOrdered: number
    unit: string
    unitPrice: number
    vatRate: number
    totalPrice: number
  }[]
  totals: { subtotalCents: number; vatCents: number; totalCents: number }
  ruleId: string
  locationId: string | null
  requestedBy: string
  requestedById: string | null
  seq: number
}) {
  const { supplierId, lines, totals, ruleId, locationId, requestedBy, requestedById, seq } = args
  return db.$transaction(async (tx) => {
    const created = await tx.purchaseOrder.create({
      data: {
        id: nid(),
        poNumber: poNumberFor(new Date(), seq),
        supplierId,
        status: 'draft',
        subtotal: totals.subtotalCents / 100,
        vatAmount: totals.vatCents / 100,
        totalAmount: totals.totalCents / 100,
        notes: `Recurring #${ruleId}`,
        locationId,
        requestedBy,
        requestedById,
        PurchaseOrderItem: {
          create: lines.map((l) => ({
            id: nid(),
            description: l.description,
            inventoryItemId: l.inventoryItemId,
            quantityOrdered: l.quantityOrdered,
            unit: l.unit,
            unitPrice: l.unitPrice,
            vatRate: l.vatRate,
            totalPrice: l.totalPrice,
            status: 'pending',
          })),
        },
      },
      include: { PurchaseOrderItem: true, Supplier: { select: { name: true } } },
    })

    // supplier catalogue (SupplierItem) — additive, same as the manual PO creator
    for (const l of lines) {
      const existing = await tx.supplierItem.findUnique({
        where: { supplierId_inventoryItemId: { supplierId, inventoryItemId: l.inventoryItemId } },
      })
      if (!existing) {
        await tx.supplierItem.create({
          data: { id: nid(), supplierId, inventoryItemId: l.inventoryItemId, pricePerPack: l.unitPrice, packQty: 1, packUnit: l.unit, vatRate: l.vatRate },
        })
      }
    }
    return created
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  if (running) return ok({ created: [], skipped: 0, busy: true })
  running = true
  try {
    const row = await db.integration.findFirst({ where: { name: RECURRING_PO_MARKER, type: 'other' } })
    const rules = row ? parseRecurringConfig(row.config) : []
    if (!row || rules.length === 0) return ok({ created: [], skipped: 0 })

    const now = new Date()
    const created: { ruleId: string; poNumber: string; supplierName: string }[] = []
    let skipped = 0
    let rulesChanged = false
    const nextRules = [...rules]

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if (!isDue(rule, now)) { skipped++; continue }

      const supplier = await db.supplier.findUnique({
        where: { id: rule.supplierId },
        select: { id: true, name: true },
      })
      if (!supplier) {
        // dangling supplier — advance the schedule anyway (avoid a hot loop), count as skipped
        nextRules[i] = advance(rule, now)
        rulesChanged = true
        skipped++
        continue
      }

      // resolve lines; missing inventory items are dropped, an empty result skips the rule
      const lines: {
        description: string
        inventoryItemId: string
        quantityOrdered: number
        unit: string
        unitPrice: number
        vatRate: number
        totalPrice: number
      }[] = []
      for (const it of rule.items) {
        const info = await priceFor(rule.supplierId, it.inventoryItemId)
        if (!info) continue
        const qty = num(it.qty)
        if (!(qty > 0)) continue
        const unitPriceCents = Math.round(info.unitPrice * 100)
        const t = computeLineCents({ quantity: qty, unitPriceCents, vatRate: info.vatRate })
        lines.push({
          description: info.name,
          inventoryItemId: it.inventoryItemId,
          quantityOrdered: qty,
          unit: info.unit,
          unitPrice: info.unitPrice,
          vatRate: info.vatRate,
          totalPrice: t.totalCents / 100,
        })
      }
      if (lines.length === 0) {
        nextRules[i] = advance(rule, now)
        rulesChanged = true
        skipped++
        continue
      }

      const totals = computeTotalsCents(lines.map((l) => ({ quantity: l.quantityOrdered, unitPriceCents: Math.round(l.unitPrice * 100), vatRate: l.vatRate })))
      const locationId = user.loc || null

      // numbering: same count-based seq + unique retry as POST /api/purchase-orders
      let po: Awaited<ReturnType<typeof createRecurringPo>> | null = null
      for (let attempt = 0; attempt < 5 && !po; attempt++) {
        const seq = (await db.purchaseOrder.count({ where: { poNumber: { startsWith: poNumberFor(new Date(), 1).slice(0, 13) } } })) + 1 + attempt
        try {
          po = await createRecurringPo({
            supplierId: rule.supplierId,
            lines,
            totals,
            ruleId: rule.id,
            locationId,
            requestedBy: user.name || '',
            requestedById: user.sub || null,
            seq,
          })
        } catch (e) {
          const msg = String((e as Error).message || '')
          if (msg.includes('poNumber') && attempt < 4) continue // concurrent numbering — retry
          throw e
        }
      }
      if (!po) { skipped++; continue }

      nextRules[i] = advance(rule, now)
      rulesChanged = true
      created.push({ ruleId: rule.id, poNumber: po.poNumber, supplierName: supplier.name })

      const __aId = nid(); const __chain = await auditChainFields(db, { action: 'RECURRING_PO_CREATED', entityType: 'PurchaseOrder', entityId: po.id, details: jstr({ ruleId: rule.id, poNumber: po.poNumber, supplierId: rule.supplierId, supplierName: supplier.name, lines: lines.length, totalCents: totals.totalCents, nextRun: nextRules[i].nextRun, }), id: __aId })
      await db.auditLog.create({
        data: { ...__chain,
          id: __aId,
          userId: user.sub,
          action: 'RECURRING_PO_CREATED',
          entityType: 'PurchaseOrder',
          entityId: po.id,
          details: jstr({
            ruleId: rule.id,
            poNumber: po.poNumber,
            supplierId: rule.supplierId,
            supplierName: supplier.name,
            lines: lines.length,
            totalCents: totals.totalCents,
            nextRun: nextRules[i].nextRun,
          }),
        },
      })
    }

    if (rulesChanged && row) {
      await db.integration.update({ where: { id: row.id }, data: { config: JSON.stringify({ rules: nextRules }) } })
    }

    return ok({ created, skipped })
  } finally {
    running = false
  }
}

/** Move the rule forward after an evaluation: lastRun=now, nextRun recomputed. */
function advance(rule: RecurringRule, now: Date): RecurringRule {
  return {
    ...rule,
    lastRun: now.toISOString(),
    nextRun: computeNextRun(rule, now)?.toISOString() ?? null,
  }
}
