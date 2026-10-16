import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, isCentralRole, ok, fail, locationScope } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { num } from '@/lib/map'
import { OPEN_PO_STATUSES } from '@/lib/reorder'
import {
  recommendAll, groupRecommendationsBySupplier, CONSUMPTION_TX_TYPES,
  DEFAULT_HISTORY_DAYS, DEFAULT_REVIEW_DAYS,
  type RecommendItemInput, type RecommendSupplier, type Recommendation, type RecSupplierGroup,
} from '@/lib/reorder-recommend'

/**
 * Issue #12 (P2) — GET /api/purchase-orders/recommendations
 *
 * Priporočeni nabavni nalogi iz DEJANSKE porabe (knjiga StockTransaction),
 * dobavnih rokov, varnostne zaloge in pakiranj dobavitelja:
 *   target  = avgDailyUse × (leadTime + reviewDays) + safetyStock
 *   need    = target − onHand − incoming (potrjene dobave v teku)
 *   paketi  = max(minOrderPacks, ceil(need / packQty)) → qty = paketi × packQty
 *
 * Parametri (neobvezni):
 *   days        — okno zgodovine porabe (privzeto 28, 7–120)
 *   reviewDays  — pregledni cikel med naročili (privzeto 7, 1–30)
 *   locationId  — SAMO centralne vloge (assertOrgScope; lokalna vloga ga
 *                 ignorira — vedno svoja lokacija, fail-closed kot GET PO)
 *
 * Odgovor: { recommendations, groupedBySupplier, watch, summary } —
 * RECOMMEND (naroči, združeno po dobavitelju) + WATCH (pod pragom, a pokrito —
 * odprta naročila že pokrivajo primanjkljaj) + povzetek s kakovostjo podatkov.
 *
 * Pravica: requireAuth (enako GET /api/purchase-orders/suggestions —
 * branje za vse prijavljene; obseg prek locationScope/org allow-liste).
 * Nepopolni podatki so VIDNI: flags.noHistory / noLeadTime / noSupplier.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const daysRaw = url.searchParams.get('days')
  const reviewRaw = url.searchParams.get('reviewDays')
  const rawLocationId = url.searchParams.get('locationId')

  const days = daysRaw == null ? DEFAULT_HISTORY_DAYS : parseInt(daysRaw, 10)
  if (!Number.isFinite(days) || days < 7 || days > 120) return fail('Okno zgodovine mora biti med 7 in 120 dnevi.', 400)
  const reviewDays = reviewRaw == null ? DEFAULT_REVIEW_DAYS : parseInt(reviewRaw, 10)
  if (!Number.isFinite(reviewDays) || reviewDays < 1 || reviewDays > 30) return fail('Pregledni cikel mora biti med 1 in 30 dnevi.', 400)

  // obseg: centralna vloga z locationId parametrom (org varovalka!), sicer
  // locationScope (org allow-lista centralnih / uporabnikova lokacija za
  // lokalne vloge — locationId param se v tem primeru IGNORIRA, fail-closed)
  let scope: { locationId?: string | { in: string[] } }
  if (rawLocationId && isCentralRole(user)) {
    const orgGuard = await assertOrgScope(user, rawLocationId)
    if (orgGuard) return orgGuard
    scope = { locationId: rawLocationId }
  } else {
    scope = await locationScope(user)
  }

  const now = new Date()
  const items = await db.inventoryItem.findMany({
    where: scope,
    orderBy: { name: 'asc' },
    take: 500,
    select: {
      id: true, name: true, unit: true, quantity: true, minQuantity: true,
      reorderPoint: true, safetyStock: true, leadTimeDays: true, costPerUnit: true, supplier: true,
    },
  })

  if (items.length === 0) {
    return ok({
      recommendations: [] as Recommendation[],
      groupedBySupplier: [] as RecSupplierGroup[],
      watch: [] as Recommendation[],
      summary: {
        windowDays: days, reviewDays, computedAt: now.toISOString(),
        itemsConsidered: 0, recommend: 0, watch: 0, estTotal: 0, skipped: 0,
      },
    })
  }

  const ids = items.map((i) => i.id)

  // 1) neto poraba po artiklih (podpisane količine — STORNO_RETURN in
  //    BATCH_OUTPUT sta pozitivna in ZMANJŠATA neto odtok; isto količino
  //    nikoli ne odštejemo dvakrat)
  const since = new Date(now.getTime() - days * 86_400_000)
  const txs = await db.stockTransaction.findMany({
    where: { inventoryItemId: { in: ids }, createdAt: { gte: since } },
    select: { inventoryItemId: true, type: true, quantity: true },
    take: 50_000,
  })
  const consumptionTypes = new Set<string>(CONSUMPTION_TX_TYPES.map((t) => t.toLowerCase()))
  const netByItem = new Map<string, number>()
  const countByItem = new Map<string, number>()
  for (const t of txs) {
    if (!t.inventoryItemId) continue
    if (!consumptionTypes.has(String(t.type || '').toLowerCase())) continue
    countByItem.set(t.inventoryItemId, (countByItem.get(t.inventoryItemId) || 0) + 1)
    netByItem.set(t.inventoryItemId, (netByItem.get(t.inventoryItemId) || 0) + num(t.quantity))
  }

  // 2) potrjene dobave v teku (submitted/approved/partial — OSNUTEK ni
  //    potrjena dobava; človek ga mora najprej oddati)
  const openLines = await db.purchaseOrderItem.findMany({
    where: { inventoryItemId: { in: ids }, PurchaseOrder: { status: { in: [...OPEN_PO_STATUSES] } } },
    select: { inventoryItemId: true, quantityOrdered: true, quantityReceived: true },
  })
  const incomingByItem = new Map<string, number>()
  for (const l of openLines) {
    if (!l.inventoryItemId) continue
    const remaining = Math.max(0, num(l.quantityOrdered) - num(l.quantityReceived))
    if (remaining <= 0) continue
    incomingByItem.set(l.inventoryItemId, (incomingByItem.get(l.inventoryItemId) || 0) + remaining)
  }

  // 3) dobaviteljski katalog: najcenejša AKTIVNA SupplierItem vezava s
  //    pakiranjem (cena 0 = neznana → raje kandidata s pozitivno ceno)
  const catalog = await db.supplierItem.findMany({
    where: { inventoryItemId: { in: ids }, isActive: true },
    include: { Supplier: { select: { id: true, name: true, isActive: true } } },
  })
  const supplierByItem = new Map<string, RecommendSupplier>()
  for (const c of catalog) {
    if (!c.Supplier?.isActive) continue
    const price = num(c.pricePerPack)
    const prev = supplierByItem.get(c.inventoryItemId)
    if (!prev) {
      supplierByItem.set(c.inventoryItemId, {
        supplierId: c.Supplier.id, supplierName: c.Supplier.name,
        packQty: num(c.packQty) || 1, packUnit: c.packUnit || '',
        minOrderPacks: c.minOrderPacks, pricePerPack: price,
        vatRate: c.vatRate == null ? null : num(c.vatRate),
      })
      continue
    }
    const better = price > 0 && (prev.pricePerPack <= 0 || price < prev.pricePerPack)
    if (better) {
      supplierByItem.set(c.inventoryItemId, {
        supplierId: c.Supplier.id, supplierName: c.Supplier.name,
        packQty: num(c.packQty) || 1, packUnit: c.packUnit || '',
        minOrderPacks: c.minOrderPacks, pricePerPack: price,
        vatRate: c.vatRate == null ? null : num(c.vatRate),
      })
    }
  }

  // legacy fallback: InventoryItem.supplier (prosti niz) ↔ Supplier.name —
  // brez pakiranja (količina = need, ocena po costPerUnit)
  const suppliers = await db.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true } })
  const supplierByName = new Map(suppliers.map((s) => [s.name.trim().toLowerCase(), s]))

  const inputs: RecommendItemInput[] = items.map((i) => {
    const net = netByItem.get(i.id) || 0
    const avgDailyUse = Math.max(0, Math.round((-net / days) * 1000) / 1000)
    let supplier: RecommendSupplier | null = supplierByItem.get(i.id) ?? null
    if (!supplier && i.supplier) {
      const legacy = supplierByName.get(String(i.supplier).trim().toLowerCase())
      if (legacy) {
        supplier = {
          supplierId: legacy.id, supplierName: legacy.name,
          packQty: 1, packUnit: '', minOrderPacks: 1,
          pricePerPack: 0, vatRate: null,
        }
      }
    }
    return {
      id: i.id, name: i.name, unit: i.unit,
      quantity: num(i.quantity), minQuantity: num(i.minQuantity),
      reorderPoint: num(i.reorderPoint), safetyStock: num(i.safetyStock),
      leadTimeDays: i.leadTimeDays == null ? 0 : num(i.leadTimeDays),
      avgDailyUse, historyCount: countByItem.get(i.id) || 0,
      incoming: incomingByItem.get(i.id) || 0,
      costPerUnit: num(i.costPerUnit),
      supplier,
    }
  })

  const { recommendations, watch, skipped } = recommendAll(inputs, { reviewDays, now })
  const groupedBySupplier = groupRecommendationsBySupplier(recommendations)
  const estTotal = groupedBySupplier.reduce((s, g) => Math.round((s + g.total) * 100) / 100, 0)

  return ok({
    recommendations,
    groupedBySupplier,
    watch,
    summary: {
      windowDays: days,
      reviewDays,
      computedAt: now.toISOString(),
      itemsConsidered: items.length,
      recommend: recommendations.length,
      watch: watch.length,
      estTotal,
      skipped,
    },
  })
}
