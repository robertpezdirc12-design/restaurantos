import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import {
  buildFoodCostVariance,
  type FcInput,
  type FcInvItem,
  type FcRecipeRow,
  type FcSoldRow,
  type FcStocktake,
  type FcTxRow,
} from '@/lib/food-cost-variance'

/**
 * Issue #17 (P1/P2) — GET /api/reports/food-cost?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv
 *
 * Poročilo dejanske (actual) proti teoretični (theoretical) porabi — food-cost
 * varianca. Formule in politike so DOKUMENTIRANE v src/lib/food-cost-variance.ts
 * (enaki v UI in CSV izvozu):
 *   - dejanska poraba = otvoritvena inventura + prejemi/proizvodnja − zaključna
 *     inventura (popis kot sidro; knjiga kot fallback z izrecno oznako);
 *   - teoretična = prodane postavke (paidAt okno, paid|partial, ne-voidane) ×
 *     receptura (flattenDeduction — ista matematika kot razknjižba);
 *   - vrednotenje po ZGODOVINSKI osnovi (uteženo povprečje prejemov v oknu →
 *     zadnja dobaviteljska cena → trenutna cena IZRECNO OZNAČENA → neznana);
 *   - razčlenitev variance: odpis / priprava / vračilo / primanjkljaj / inventurni
 *     popravek / nepojasnjeno (signal za preverbo, ne dokaz krivde);
 *   - nepopolni podatki so OZNAČENI (manjkajoči popis/cena/receptura/pretvorba),
 *     manjkajoče vrednosti ostanejo null — nič se ne izmisli v 0.
 *
 * Pravice: reports.view (enako kot menu-engineering / računovodski izvoz);
 * obseg: Order prek locationScope (centralne vloge = vse lokacije org),
 * zaloga prek InventoryItem relacije. CSV: UTF-8 BOM + `;` (hišni standard).
 *
 * Take cap-i: orderItem 50000 (kot menu-engineering), StockTransaction 200000,
 * StocktakeItem 100000 — ob presegu poročilo nosi transactionsTruncated zastavico
 * (poročilo je pošteno glede svojih meja).
 */

const TX_CAP = 200_000
const ITEM_CAP = 10_000
const SOLD_CAP = 50_000
const MAX_SPAN_DAYS = 366

const r2 = (n: number) => Math.round(n * 100) / 100

function parseDay(raw: string | null): Date | null {
  if (!raw) return null
  const d = new Date(`${raw}T00:00:00`)
  return isNaN(d.getTime()) ? null : d
}

function endOfDay(raw: string | null, fallback: Date): Date {
  if (!raw) return fallback
  const d = new Date(`${raw}T23:59:59.999`)
  return isNaN(d.getTime()) ? fallback : d
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const now = new Date()
  // privzeto obdobje: tekoči koledarski mesec (kot računovodski izvoz)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  const from = parseDay(url.searchParams.get('from')) || monthStart
  let to = endOfDay(url.searchParams.get('to'), now)
  if (from > to) return fail('Datum "from" je za datumom "to".', 400)
  if (to > now) to = now
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_SPAN_DAYS) {
    return fail(`Obdobje je predolgo (največ ${MAX_SPAN_DAYS} dni).`, 400)
  }
  const format = (url.searchParams.get('format') || 'json').toLowerCase()

  const locScope = await locationScope(user)

  // ── 1) artikli v obsegu (lokacijsko/tenant omejitev strogo na InventoryItem) ──
  const invItems = await db.inventoryItem.findMany({
    where: locScope,
    select: {
      id: true, name: true, unit: true, category: true, costPerUnit: true, quantity: true,
      locationId: true, Location: { select: { name: true } },
    },
    take: ITEM_CAP,
  })
  if (invItems.length === 0) {
    return ok({
      from: from.toISOString(), to: to.toISOString(), generatedAt: now.toISOString(), currency: 'EUR',
      salesBasis: 'paid_at', recipeBasis: 'current', netSales: 0,
      kpi: {
        actualFoodCostValue: null, theoreticalFoodCostValue: null, varianceValue: null,
        actualFoodCostPct: null, theoreticalFoodCostPct: null, variancePctOfTheoretical: null,
        variancePctOfSales: null, wasteValue: null, wasteSharePct: null,
      },
      totals: {
        theoreticalQty: 0, actualUsageQty: 0, varianceQty: 0, receiptsQty: 0, productionQty: 0,
        wasteQty: 0, prepQty: 0, returnsQty: 0, shortfallQty: 0, correctionQty: 0,
        unexplainedQty: 0, purchaseValue: null,
      },
      items: [], byCategory: [], byLocation: [],
      soldWithoutRecipe: [],
      dataQuality: {
        incompleteData: true, reasons: ['no_items_in_scope'], openingBasis: 'ledger', closingBasis: 'ledger',
        hasOpeningStocktake: false, hasClosingStocktake: false, itemsWithUnknownPrice: 0,
        itemsWithUnitMismatch: 0, soldMenuItemsWithoutRecipe: 0, recipesPossiblyChanged: 0,
        transactionsTruncated: false,
      },
      notes: ['signal_not_proof', 'recipe_basis_current', 'unexplained_ledger_caveat'],
    })
  }
  const itemIds = invItems.map((i) => i.id)

  // ── 2) transakcije (VSE — balanceAt potrebuje živo stanje − prihodnje premike;
  //       prior okno za cenovni vpliv) ──
  const txRows = await db.stockTransaction.findMany({
    where: { inventoryItemId: { in: itemIds } },
    select: {
      id: true, inventoryItemId: true, type: true, quantity: true, createdAt: true,
      costPerUnit: true, orderId: true, supplierDoc: true, reason: true,
    },
    orderBy: { createdAt: 'asc' },
    take: TX_CAP,
  })
  const transactionsTruncated = txRows.length >= TX_CAP

  // ── 3) prodane postavke: paidAt okno + paid|partial + ne-voidane (issue §1) ──
  const soldRows = await db.orderItem.findMany({
    where: {
      voided: false,
      Order: { paidAt: { gte: from, lte: to }, paymentStatus: { in: ['paid', 'partial'] }, ...locScope },
    },
    select: { menuItemId: true, quantity: true, price: true, discountAmount: true, orderId: true },
    take: SOLD_CAP,
  })
  const soldOrderIds = [...new Set(soldRows.map((s) => s.orderId))]
  const orderNoRows = soldOrderIds.length
    ? await db.order.findMany({ where: { id: { in: soldOrderIds } }, select: { id: true, orderNumber: true } })
    : []
  const orderNumbers: Record<string, number> = {}
  for (const o of orderNoRows) orderNumbers[o.id] = o.orderNumber

  const soldItemIds = [...new Set(soldRows.map((s) => s.menuItemId))]
  const menuItemNames = soldItemIds.length
    ? await db.menuItem.findMany({ where: { id: { in: soldItemIds } }, select: { id: true, name: true } })
    : []
  const soldItemNames: Record<string, string> = {}
  for (const m of menuItemNames) soldItemNames[m.id] = m.name

  // ── 4) recepture prodanih jedi (z updatedAt — zastavica spremembe po from) ──
  const recipeRows = soldItemIds.length
    ? await db.recipeItem.findMany({
        where: { menuItemId: { in: soldItemIds } },
        select: {
          id: true, menuItemId: true, inventoryItemId: true, quantityPerServing: true,
          yieldPercent: true, unit: true, parentRecipeItemId: true, updatedAt: true,
        },
      })
    : []

  // ── 5) potrjene inventure ≤ to (sidra za opening/closing + dokazi) ──
  const stocktakesDb = await db.stocktake.findMany({
    where: { status: 'APPROVED', cancelledAt: null, approvedAt: { lte: to }, ...locScope },
    select: { id: true, approvedAt: true, StocktakeItem: { select: { inventoryItemId: true, countedQuantity: true } } },
    take: 500,
  })
  const stocktakes: FcStocktake[] = stocktakesDb.map((s) => ({
    id: s.id,
    approvedAt: (s.approvedAt || new Date(0)) as Date,
    items: s.StocktakeItem.map((i) => ({
      inventoryItemId: i.inventoryItemId,
      countedQuantity: i.countedQuantity == null ? null : num(i.countedQuantity),
    })),
  }))

  // STOCKTAKE transakcije → stocktakeId (dokazi popisa v oknu)
  const stocktakeTxIds = txRows.filter((t) => (t.type || '').toLowerCase() === 'stocktake').map((t) => t.id)
  const stItemLinks = stocktakeTxIds.length
    ? await db.stocktakeItem.findMany({
        where: { stockTransactionId: { in: stocktakeTxIds } },
        select: { stockTransactionId: true, stocktakeId: true },
        take: 100_000,
      })
    : []
  const stocktakeIdByTxId: Record<string, string> = {}
  for (const l of stItemLinks) if (l.stockTransactionId) stocktakeIdByTxId[l.stockTransactionId] = l.stocktakeId

  // ── 6) zgodovinske cene (zadnja ≤ to per artikel) ──
  const histRows = await db.supplierPriceHistory.findMany({
    where: { inventoryItemId: { in: itemIds }, observedAt: { lte: to } },
    select: { inventoryItemId: true, unitPrice: true, observedAt: true },
    orderBy: { observedAt: 'desc' },
    take: 50_000,
  })
  const priceHistory: Record<string, { unitPrice: number; observedAt: Date }> = {}
  for (const h of histRows) {
    if (!priceHistory[h.inventoryItemId]) {
      priceHistory[h.inventoryItemId] = { unitPrice: num(h.unitPrice), observedAt: h.observedAt }
    }
  }

  // ── sestava vhoda za čisti motor ──
  const items: FcInvItem[] = invItems.map((i) => ({
    id: i.id, name: i.name, unit: i.unit, category: i.category,
    costPerUnit: num(i.costPerUnit), quantity: num(i.quantity),
    locationId: i.locationId, locationName: i.Location?.name || i.locationId || '—',
  }))
  const transactions: FcTxRow[] = txRows.map((t) => ({
    id: t.id, inventoryItemId: t.inventoryItemId, type: t.type, quantity: num(t.quantity),
    createdAt: t.createdAt, costPerUnit: num(t.costPerUnit), orderId: t.orderId,
    supplierDoc: t.supplierDoc, reason: t.reason,
  }))
  const recipes: FcRecipeRow[] = recipeRows.map((r) => ({
    id: r.id, menuItemId: r.menuItemId, inventoryItemId: r.inventoryItemId,
    quantityPerServing: num(r.quantityPerServing), yieldPercent: num(r.yieldPercent, 100),
    unit: r.unit, parentRecipeItemId: r.parentRecipeItemId, updatedAt: r.updatedAt,
  }))
  const sold: FcSoldRow[] = soldRows.map((s) => ({
    menuItemId: s.menuItemId, quantity: s.quantity, price: num(s.price),
    discountAmount: num(s.discountAmount), orderNumber: orderNumbers[s.orderId] || 0,
  }))

  const input: FcInput = {
    from, to, items, transactions, recipes, sold, soldItemNames,
    stocktakes, priceHistory, orderNumbers, stocktakeIdByTxId, currency: 'EUR',
  }
  const report = buildFoodCostVariance(input)
  if (transactionsTruncated) {
    report.dataQuality.transactionsTruncated = true
    if (!report.dataQuality.reasons.includes('transactions_truncated')) {
      report.dataQuality.reasons.push('transactions_truncated')
      report.dataQuality.incompleteData = true
    }
  }

  // ── CSV izvoz (ISTE formule/številke kot JSON/UI — hišni standard: BOM + `;`) ──
  if (format === 'csv') {
    const esc = (v: string | number | null | undefined) => {
      const s = String(v ?? '')
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines: (string | number | null)[][] = []
    lines.push(['Food-cost varianca (dejanska proti teoretični porabi)'])
    lines.push(['Od', from.toISOString().slice(0, 10), 'Do', to.toISOString().slice(0, 10)])
    lines.push(['Nastalo', report.generatedAt, 'Valuta', report.currency])
    lines.push(['Neto prodaja (paidAt okno)', r2(report.netSales)])
    lines.push(['Dejanski food cost EUR', report.kpi.actualFoodCostValue, '%', report.kpi.actualFoodCostPct])
    lines.push(['Teoretični food cost EUR', report.kpi.theoreticalFoodCostValue, '%', report.kpi.theoreticalFoodCostPct])
    lines.push(['Varianca EUR', report.kpi.varianceValue, '% nad teoretičnim', report.kpi.variancePctOfTheoretical, '% prodaje', report.kpi.variancePctOfSales])
    lines.push(['Odpisi EUR', report.kpi.wasteValue, 'delež dejanskega', report.kpi.wasteSharePct])
    lines.push(['Nepopolni podatki', report.dataQuality.incompleteData ? 'DA' : 'NE', report.dataQuality.reasons.join(' ')])
    lines.push([])
    lines.push([
      'Artikel', 'Kategorija', 'Lokacija', 'Enota',
      'Otvoritev', 'Osnova otvoritve', 'Zaključek', 'Osnova zaključka',
      'Prejemi', 'Proizvodnja', 'Teoretično', 'Dejansko', 'Varianca',
      'Odpis', 'Priprava', 'Vračila', 'Primanjkljaj', 'Popravek', 'Nepojasnjeno',
      'Cena', 'Osnova cene', 'Teoretično EUR', 'Dejansko EUR', 'Varianca EUR', 'Cenovni vpliv (inf.)',
      'Naročila (vzorec)', 'Prejemni dokumenti', 'Razlogi odpisa', 'Inventure', 'Zastavice',
    ])
    for (const r of report.items) {
      lines.push([
        r.name, r.category, r.locationName, r.unit,
        r.openingQty, r.openingBasis, r.closingQty, r.closingBasis,
        r.receiptsQty, r.productionQty, r.theoreticalQty, r.actualUsageQty, r.varianceQty,
        r.waste.qty, r.prepConsumption.qty, r.returns.qty, r.saleShortfall.qty, r.inventoryCorrection.qty, r.unexplained.qty,
        r.price, r.priceBasis, r.theoreticalValue, r.actualValue, r.varianceValue, r.priceChangeImpact,
        r.saleOrderNumbers.join(' '), r.receiptDocs.join(' '), r.wasteReasons.join(' '), r.stocktakeIds.join(' '),
        [
          r.unitMismatch ? 'unit_mismatch' : '',
          r.recipeChangedSinceFrom ? 'recipe_changed' : '',
          r.priceBasis === 'unknown' ? 'price_unknown' : '',
        ].filter(Boolean).join(' ') || '',
      ])
    }
    const csv = lines.map((l) => l.map(esc).join(';')).join('\r\n')
    return new NextResponse('\uFEFF' + csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv;charset=utf-8',
        'content-disposition': `attachment; filename="food-cost-varianca-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    })
  }

  return ok(report)
}
