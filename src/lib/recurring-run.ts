/**
 * OPS-11 val 3 (v1.82.0) — CORE evaluation of recurring purchase-order rules.
 *
 * Extracted verbatim from POST /api/purchase-orders/run-recurring (OPS-9 val 2,
 * v1.75.0) so BOTH the UI-triggered route and the new Vercel cron
 * (/api/cron/daily) share ONE implementation:
 *   - loads rules from the Integration marker 'recurring-po' (zero DDL),
 *   - for every active + due rule (isDue) creates a DRAFT purchase order
 *     (status 'draft', notes `Recurring #<id>`) priced from SupplierItem
 *     (pricePerPack/packQty) with inventory costPerUnit fallback,
 *   - same count-based numbering + unique retry as POST /api/purchase-orders,
 *   - advances the schedule (lastRun=now, nextRun=computeNextRun) and persists
 *     the config only when something changed (idempotent),
 *   - writes a RECURRING_PO_CREATED audit row per created PO.
 *
 * Differences vs. the old inline route logic (both intentional, documented):
 *   - per-rule try/catch: a failing rule is recorded in `errors[]` and the loop
 *     continues (the old route failed the whole request with a 500). Rules that
 *     errored are NOT advanced — they stay due and retry on the next run.
 *   - in-process double-fire guard moved here: concurrent callers get
 *     `{ busy: true }` (the route maps that to its back-compat busy response).
 * Push: NAMERNO IZPUŠČENO — PUSH_EVENT_TYPES has no 'PO_CREATED' (drafts are
 * noise; PO_APPROVED/PO_RECEIVED remain for real transitions).
 */
import { db } from '@/lib/db'
import { nid, num, jstr } from '@/lib/map'
import { poNumberFor, computeTotalsCents, computeLineCents } from '@/lib/procurement'
import { isDue, parseRecurringConfig, RECURRING_PO_MARKER, computeNextRun, type RecurringRule } from '@/lib/recurring-po'
import { auditChainFields } from '@/lib/audit-chain'

export interface RecurringRunCreated {
  ruleId: string
  poNumber: string
  supplierName: string
}

export interface RecurringRunResult {
  created: RecurringRunCreated[]
  skipped: number
  /** Collected per-rule failures (loop continues; errored rules stay due). */
  errors: string[]
  /** True when another evaluation is already running in this process. */
  busy?: boolean
}

export interface RunDueRecurringArgs {
  /** Location stamped onto created POs (cron: omit → null). */
  locationId?: string | null
  /** Human/actor label for PurchaseOrder.requestedBy (cron: 'cron'). */
  actor?: string
  /** Employee id for the audit row userId (route passes user.sub; cron: null). */
  actorId?: string | null
  /** Evaluation time (tests); default now. */
  now?: Date
}

// light in-process guard against double-firing (UI mount + button / cron overlap)
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

/** Move the rule forward after an evaluation: lastRun=now, nextRun recomputed. */
function advance(rule: RecurringRule, now: Date): RecurringRule {
  return {
    ...rule,
    lastRun: now.toISOString(),
    nextRun: computeNextRun(rule, now)?.toISOString() ?? null,
  }
}

/**
 * Evaluate every active + due recurring rule (all locations unless locationId
 * given). Never throws — failures land in `errors[]`; the schedule update is
 * persisted even when later rules fail (progress is kept, idempotent).
 */
export async function runDueRecurringRules(args: RunDueRecurringArgs = {}): Promise<RecurringRunResult> {
  if (running) return { created: [], skipped: 0, errors: [], busy: true }
  running = true
  try {
    const row = await db.integration.findFirst({ where: { name: RECURRING_PO_MARKER, type: 'other' } })
    const rules = row ? parseRecurringConfig(row.config) : []
    if (!row || rules.length === 0) return { created: [], skipped: 0, errors: [] }

    const now = args.now ?? new Date()
    const locationId = args.locationId ?? null
    const requestedBy = args.actor ?? ''
    const requestedById = args.actorId ?? null
    const created: RecurringRunCreated[] = []
    const errors: string[] = []
    let skipped = 0
    let rulesChanged = false
    const nextRules = [...rules]

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if (!isDue(rule, now)) { skipped++; continue }

      try {
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
              requestedBy,
              requestedById,
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
            userId: requestedById,
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
      } catch (e) {
        // cron resilience: one broken rule must not kill the run — record and continue
        errors.push(`rule ${rule.id}: ${String((e as Error).message || e).slice(0, 200)}`)
      }
    }

    if (rulesChanged && row) {
      await db.integration.update({ where: { id: row.id }, data: { config: JSON.stringify({ rules: nextRules }) } })
    }

    return { created, skipped, errors }
  } finally {
    running = false
  }
}
