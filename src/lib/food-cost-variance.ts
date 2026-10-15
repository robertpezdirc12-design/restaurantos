/**
 * Issue #17 (P1/P2) — Actual vs Theoretical food-cost variance engine (PURE, no db).
 *
 * DOKUMENTIRANE FORMULE (enake v UI, API in CSV izvozu — issue §1):
 *
 *   DEJANSKA PORABA (qty, per inventory item, period [from, to]):
 *     actualUsage = openingQty + receiptsQty + productionQty − closingQty
 *
 *     - openingQty  = stanje OB `from` = (živo stanje sedaj) − Σ podpisanih
 *                     količin transakcij z createdAt > from  (točno tudi če je
 *                     inventura medtem absolutno nastavila količino);
 *                     sidro = zadnja POTRJENA inventura ≤ from (če obstaja →
 *                     openingBasis='stocktake', sicer 'ledger').
 *     - closingQty  = stanje OB `to` (enak izračun; sidro = zadnja potrjena
 *                     inventura z approvedAt ∈ (from, to] → 'stocktake').
 *     - receiptsQty = Σ(prilivi tipa 'purchase' (GRN) in 'RECEIVE' (ročni
 *                     prejem / začetno stanje)) v oknu — NAKUP/prejem.
 *     - productionQty = Σ('BATCH_OUTPUT') — pripravljeni izdelek je proizvodnja,
 *                     ne nakup (enaka vloga kot prejem za porabo).
 *     - VRAČILA (STORNO_RETURN) in POPRAVKI (STOCKTAKE/ADJUST) NISO v prilivih:
 *       vračilo je razveljavitev odjema (isto blago se vrne na zalogo), popravek
 *       pa je ponovno odkritje resnice — OBA pristaneta v porabi prek closingQty
 *       in sta prikazana kot ločena RAZLOŽENA komponenta variance.
 *
 *   TEORETIČNA PORABA:
 *     theoretical = Σ po prodanih postavkah (ne-voidane, Order.paidAt ∈ okno,
 *                   paymentStatus paid|partial) flattenDeduction(receptura) —
 *                   ISTA čista matematika kot deductStockForOrderTx (yield +
 *                   podrecepture + dedupe), z enotno normalizacijo recipe.unit →
 *                   inventory.unit (SAMO izrecne pretvorbe kg↔g, l↔ml).
 *     Obseg po paidAt (ne createdAt): razknjižba SALE se zgodi ob plačilu —
 *                   teoretični obseg je poravnan z glavno knjigo (issue §2).
 *
 *   VARIANCA in razčlenitev:
 *     varianceQty  = actualUsage − theoretical
 *     shortfallQty = theoretical − saleDeducted        (primanjkljaj ob razknjižbi)
 *     Komponente (podpisani prispevek k varianci):
 *       waste      = +wasteQty            (dokumentiran odpis)
 *       prep       = +prepQty             (BATCH_INPUT — poraba za pripravo)
 *       returns    = −returnsQty          (storno povrne zalogo)
 *       shortfall  = −shortfallQty        (zaloga ni zadostovala → manj odšteto)
 *       correction = −correctionQty       (± inventurni/ročni popravek)
 *     unexplainedQty = variance − (vsota komponent)   ← SIGNAL ZA PREVERBO
 *
 *     POŠTENOST (issue §1): "nepojasnjeno" NI dokaz kraje ali krivde — lahko je
 *     napačna mera, nepopolna receptura, knjiženje, pokvarjenost ali procesna
 *     odstopanja. Poročilo izrecno nosi to opombo + podatkovne zastavice.
 *
 *     STRUKTURNA OMEJITEV (izrecno prikazana): če odprtje/zaključek temeljita na
 *     glavni knjigi (brez fizičnega popisa), se identiteta zapre — nepojasnjena
 *     varianca je zato strukturno 0/nizka. NEPONOVLJIVA vrednost poročila je
 *     ravno PRI fizičnih sidrih (popis na obeh koncih).
 *
 *   VREDNOTENJE (issue §2 — zgodovinska cena, nikoli trenutna brez oznake):
 *     priceBasis per sestavina (prioriteta):
 *       1. 'period_avg'      — uteženo povprečje nabavnih cen PREJEMOV v oknu
 *       2. 'last_supplier_price' — zadnja SupplierPriceHistory ≤ to
 *       3. 'current_cost'    — InventoryItem.costPerUnit (IZRECNO označeno)
 *       4. 'unknown'         — vrednosti so null (NIČ se NE izmisli v 0)
 *     Dejansko in teoretično vrednotimo z ISTO osnovo → varianca je ČISTO
 *     količinska; sprememba nabavne cene je ločena informativna komponenta
 *     priceChangeImpact = (basis − priorBasis) × theoreticalQty (nikoli del
 *     vsote variance).
 *
 *   KPI:
 *     actualFoodCostPct     = actualValue / netSales × 100
 *     theoreticalFoodCostPct= theoreticalValue / netSales × 100
 *     variancePct           = varianceValue / theoreticalValue × 100 (če > 0)
 *     wasteSharePct         = wasteValue / actualValue × 100 (če > 0)
 */
import { flattenDeduction, r2, r3, type RecipeNode } from './recipe-cost'

// ─────────────────────────── Vhodni tipi (čisti podatki) ───────────────────────────

export interface FcTxRow {
  id: string
  inventoryItemId: string
  /** Tip iz DB (klasifikacija je case-insensitive: 'purchase' GRN, 'SALE', …). */
  type: string
  /** Podpisana količina TOČNO kot v DB (odjemi negativni, prilivi pozitivni). */
  quantity: number
  createdAt: Date
  costPerUnit: number
  orderId?: string | null
  supplierDoc?: string | null
  reason?: string | null
}

export interface FcInvItem {
  id: string
  name: string
  unit: string
  category: string
  costPerUnit: number
  /** ŽIVO trenutno stanje (InventoryItem.quantity) — sidro za balanceAt(). */
  quantity: number
  locationId: string | null
  locationName?: string
}

export interface FcRecipeRow {
  id: string
  menuItemId: string
  inventoryItemId: string
  quantityPerServing: number
  yieldPercent: number
  unit: string
  parentRecipeItemId: string | null
  updatedAt: Date
}

export interface FcSoldRow {
  menuItemId: string
  quantity: number
  price: number
  discountAmount: number
  orderNumber: number
}

export interface FcStocktake {
  id: string
  approvedAt: Date
  items: { inventoryItemId: string; countedQuantity: number | null }[]
}

export interface FcPricePoint {
  unitPrice: number
  observedAt: Date
}

export interface FcInput {
  from: Date
  to: Date
  items: FcInvItem[]
  /** VSE transakcije artiklov v obsegu (tudi pred oknom — prior cena + balance). */
  transactions: FcTxRow[]
  recipes: FcRecipeRow[]
  /** Prodane postavke (pred- filtrirane: ne-voidane, paidAt ∈ [from,to], paid|partial). */
  sold: FcSoldRow[]
  /** menuItemId → ime (za sezname brez recepture). */
  soldItemNames: Record<string, string>
  /** POTRDJENE inventure v/ob obsegu (approvedAt ≤ to). */
  stocktakes: FcStocktake[]
  /** inventoryItemId → zadnja dobaviteljska cena ≤ to. */
  priceHistory: Record<string, FcPricePoint>
  /** orderId → številka naročila (dokazi SALE). */
  orderNumbers?: Record<string, number>
  /** stockTransactionId (tip STOCKTAKE) → stocktakeId (dokazi popisa). */
  stocktakeIdByTxId?: Record<string, string>
  currency?: string
}

// ─────────────────────────── Izhodni tipi ───────────────────────────

export type FcAnchorBasis = 'stocktake' | 'ledger'
export type FcPriceBasis = 'period_avg' | 'last_supplier_price' | 'current_cost' | 'unknown'

export interface FcComponent {
  qty: number
  value: number | null
}

export interface FcItemRow {
  inventoryItemId: string
  name: string
  category: string
  unit: string
  locationId: string | null
  locationName: string
  // − osnovna identiteta −
  openingQty: number
  openingBasis: FcAnchorBasis
  openingStocktakeId: string | null
  closingQty: number
  closingBasis: FcAnchorBasis
  closingStocktakeId: string | null
  receiptsQty: number
  productionQty: number
  // − primerjava −
  theoreticalQty: number
  actualUsageQty: number
  varianceQty: number
  // − razčlenitev (podpisani prispevek k varianci) −
  waste: FcComponent
  prepConsumption: FcComponent
  returns: FcComponent
  saleShortfall: FcComponent
  inventoryCorrection: FcComponent
  unexplained: FcComponent
  // − vrednotenje −
  price: number | null
  priceBasis: FcPriceBasis
  priorPrice: number | null
  priceChangeImpact: number | null
  theoreticalValue: number | null
  actualValue: number | null
  varianceValue: number | null
  // − dokazi −
  saleOrderNumbers: number[]
  receiptDocs: string[]
  wasteReasons: string[]
  stocktakeIds: string[]
  // − podatkovna kakovost (per vrstica) −
  unitMismatch: boolean
  recipeChangedSinceFrom: boolean
  ledgerSaleQty: number
}

export interface FcDataQuality {
  incompleteData: boolean
  reasons: string[]
  openingBasis: FcAnchorBasis
  closingBasis: FcAnchorBasis
  hasOpeningStocktake: boolean
  hasClosingStocktake: boolean
  itemsWithUnknownPrice: number
  itemsWithUnitMismatch: number
  soldMenuItemsWithoutRecipe: number
  recipesPossiblyChanged: number
  transactionsTruncated: boolean
}

export interface FcReport {
  from: string
  to: string
  generatedAt: string
  currency: string
  salesBasis: 'paid_at'
  recipeBasis: 'current'
  netSales: number
  kpi: {
    actualFoodCostValue: number | null
    theoreticalFoodCostValue: number | null
    varianceValue: number | null
    actualFoodCostPct: number | null
    theoreticalFoodCostPct: number | null
    variancePctOfTheoretical: number | null
    variancePctOfSales: number | null
    wasteValue: number | null
    wasteSharePct: number | null
  }
  totals: {
    theoreticalQty: number
    actualUsageQty: number
    varianceQty: number
    receiptsQty: number
    productionQty: number
    wasteQty: number
    prepQty: number
    returnsQty: number
    shortfallQty: number
    correctionQty: number
    unexplainedQty: number
    purchaseValue: number | null
  }
  items: FcItemRow[]
  byCategory: {
    category: string
    theoreticalValue: number | null
    actualValue: number | null
    varianceValue: number | null
    wasteValue: number | null
    unexplainedValue: number | null
  }[]
  byLocation: {
    locationId: string | null
    locationName: string
    theoreticalValue: number | null
    actualValue: number | null
    varianceValue: number | null
    unexplainedValue: number | null
  }[]
  /** Jedi z prodajo BREZ recepture (teoretična poraba jih ne vidi). */
  soldWithoutRecipe: { menuItemId: string; name: string; qtySold: number; revenue: number }[]
  dataQuality: FcDataQuality
  notes: string[]
}

// ─────────────────────────── Klasifikacija transakcij ───────────────────────────

export type FcTxGroup =
  | 'receipt' // purchase (GRN), RECEIVE
  | 'return' // STORNO_RETURN
  | 'production' // BATCH_OUTPUT
  | 'prep' // BATCH_INPUT
  | 'sale' // SALE
  | 'waste' // WASTE
  | 'correction' // STOCKTAKE, ADJUST
  | 'unknown'

/** Case-insensitive klasifikacija (GRN piše 'purchase' z malo — issue #18 ruta). */
export function txGroupOf(type: string): FcTxGroup {
  switch ((type || '').trim().toLowerCase()) {
    case 'purchase':
    case 'receive':
      return 'receipt'
    case 'storno_return':
      return 'return'
    case 'batch_output':
      return 'production'
    case 'batch_input':
      return 'prep'
    case 'sale':
      return 'sale'
    case 'waste':
      return 'waste'
    case 'stocktake':
    case 'adjust':
      return 'correction'
    default:
      return 'unknown'
  }
}

// ─────────────────────────── Enotne pretvorbe (issue §2) ───────────────────────────

/**
 * Izrecne, preverjene pretvorke SAMO za kg↔g in l↔ml (faktor 1000).
 * Kosi/paketi/komadi se NE pretvarjajo (vrne null → zastavica unitMismatch).
 * Prazna/ista enota → 1. Neznane pretvorke → null (NIČ se ne izmisli).
 */
export function unitFactor(fromUnit: string, toUnit: string): number | null {
  const f = (fromUnit || '').trim().toLowerCase()
  const t = (toUnit || '').trim().toLowerCase()
  if (!f || !t || f === t) return 1
  const pairs: Record<string, string> = { kg: 'g', g: 'kg', l: 'ml', ml: 'l' }
  const partner = pairs[f]
  if (partner === t) {
    // kg → g / l → ml: ×1000; g → kg / ml → l: ÷1000
    return f === 'kg' || f === 'l' ? 1000 : 0.001
  }
  return null
}

// ─────────────────────────── Jedro ───────────────────────────

interface WindowSums {
  receipt: number
  return: number
  production: number
  prep: number
  sale: number
  waste: number
  correction: number
  unknownIn: number
  unknownOut: number
  receiptCostWeighted: { sum: number; qty: number }
}

const emptySums = (): WindowSums => ({
  receipt: 0, return: 0, production: 0, prep: 0, sale: 0, waste: 0, correction: 0,
  unknownIn: 0, unknownOut: 0, receiptCostWeighted: { sum: 0, qty: 0 },
})

function inWindow(t: FcTxRow, from: Date, to: Date): boolean {
  return t.createdAt.getTime() > from.getTime() && t.createdAt.getTime() <= to.getTime()
}

/**
 * Stanje ob času t. S sidrom: PREŠTETO količino + dokumentirani premiki po njej
 * (fizična resnica — imuna na knjižovodski drift). Brez sidra: rekonstrukcija
 * iz živega stanja (live − Σ transakcij po t).
 */
function resolveBalance(
  liveQty: number,
  txs: FcTxRow[],
  t: Date,
  anchor: { approvedAt: Date; counted: number } | undefined,
): number {
  if (anchor) {
    let s = anchor.counted
    for (const tx of txs) {
      if (tx.createdAt.getTime() > anchor.approvedAt.getTime() && tx.createdAt.getTime() <= t.getTime()) {
        s += tx.quantity
      }
    }
    return r3(s)
  }
  let s = liveQty
  for (const tx of txs) {
    if (tx.createdAt.getTime() > t.getTime()) s -= tx.quantity
  }
  return r3(s)
}

function priceBasisFor(
  itemId: string,
  sums: WindowSums,
  hist: FcPricePoint | undefined,
  itemCost: number,
): { price: number | null; basis: FcPriceBasis } {
  const w = sums.receiptCostWeighted
  if (w.qty > 0) return { price: r2(w.sum / w.qty), basis: 'period_avg' }
  if (hist && hist.unitPrice > 0) return { price: r2(hist.unitPrice), basis: 'last_supplier_price' }
  if (itemCost > 0) return { price: r2(itemCost), basis: 'current_cost' }
  return { price: null, basis: 'unknown' }
}

/**
 * Glavni gradnik poročila. ČISTO: brez db; deterministično; ročno preverljivo.
 */
export function buildFoodCostVariance(input: FcInput): FcReport {
  const { from, to } = input
  const currency = input.currency || 'EUR'
  const byItem = new Map<string, FcInvItem>(input.items.map((i) => [i.id, i]))
  const txsByItem = new Map<string, FcTxRow[]>()
  for (const tx of input.transactions) {
    const arr = txsByItem.get(tx.inventoryItemId)
    if (arr) arr.push(tx)
    else txsByItem.set(tx.inventoryItemId, [tx])
  }

  // ── inventurna sidra per artikel (zadnja POTRJENA s preštevanim) ──
  // sidro nosi PREŠTETO količino (fizična opažba!) + verižne premike po njej:
  //   anchored(t) = counted + Σ transakcij (approvedAt, t]   ← fizična resnica
  //   ledger(t)   = živo stanje − Σ transakcij (t, sedaj]    ← knjigovodski
  // Neujemanje med njima (drift brez dokumenta) pristane v nepojasnjenem.
  interface Anchor { id: string; approvedAt: Date; counted: number }
  const openingAnchor = new Map<string, Anchor>()
  const closingAnchor = new Map<string, Anchor>()
  const stSorted = [...input.stocktakes].sort((a, b) => a.approvedAt.getTime() - b.approvedAt.getTime())
  for (const st of stSorted) {
    for (const it of st.items) {
      if (it.countedQuantity == null) continue
      if (st.approvedAt.getTime() <= from.getTime()) {
        openingAnchor.set(it.inventoryItemId, { id: st.id, approvedAt: st.approvedAt, counted: it.countedQuantity })
      } else if (st.approvedAt.getTime() <= to.getTime()) {
        closingAnchor.set(it.inventoryItemId, { id: st.id, approvedAt: st.approvedAt, counted: it.countedQuantity })
      }
    }
  }

  // ── teoretična poraba: recepture z enotno normalizacijo ──
  const recipesByMenu = new Map<string, FcRecipeRow[]>()
  for (const r of input.recipes) {
    const arr = recipesByMenu.get(r.menuItemId)
    if (arr) arr.push(r)
    else recipesByMenu.set(r.menuItemId, [r])
  }
  const theoretical = new Map<string, number>()
  const unitMismatchItems = new Set<string>()
  const recipeChangedItems = new Set<string>()
  const soldQtyByMenu = new Map<string, number>()
  const revenueByMenu = new Map<string, number>()
  for (const s of input.sold) {
    soldQtyByMenu.set(s.menuItemId, (soldQtyByMenu.get(s.menuItemId) || 0) + s.quantity)
    revenueByMenu.set(s.menuItemId, (revenueByMenu.get(s.menuItemId) || 0) + s.quantity * s.price - s.discountAmount)
  }

  for (const [menuItemId, rows] of recipesByMenu) {
    const qtySold = soldQtyByMenu.get(menuItemId)
    if (!qtySold || qtySold <= 0) continue
    const nodes: RecipeNode[] = []
    let changed = false
    for (const r of rows) {
      if (r.updatedAt && r.updatedAt.getTime() > from.getTime()) changed = true
      const inv = byItem.get(r.inventoryItemId)
      const invUnit = inv?.unit || ''
      const factor = unitFactor(r.unit, invUnit)
      if (factor === null) {
        unitMismatchItems.add(r.inventoryItemId)
        nodes.push({
          id: r.id, menuItemId: r.menuItemId, inventoryItemId: r.inventoryItemId,
          quantityPerServing: r.quantityPerServing, yieldPercent: r.yieldPercent,
          unit: r.unit, parentRecipeItemId: r.parentRecipeItemId,
        })
      } else {
        nodes.push({
          id: r.id, menuItemId: r.menuItemId, inventoryItemId: r.inventoryItemId,
          quantityPerServing: r3(r.quantityPerServing * factor), yieldPercent: r.yieldPercent,
          unit: invUnit || r.unit, parentRecipeItemId: r.parentRecipeItemId,
        })
      }
    }
    if (changed) for (const r of rows) recipeChangedItems.add(r.inventoryItemId)
    const flat = flattenDeduction(nodes, menuItemId, qtySold)
    for (const [invId, q] of flat) {
      if (q > 0) theoretical.set(invId, r3((theoretical.get(invId) || 0) + q))
    }
  }

  // ── jedi z prodajo brez recepture (vidna vrzel) ──
  const soldWithoutRecipe: FcReport['soldWithoutRecipe'] = []
  for (const [menuItemId, qty] of soldQtyByMenu) {
    if (qty <= 0) continue
    const rows = recipesByMenu.get(menuItemId)
    if (!rows || rows.length === 0) {
      soldWithoutRecipe.push({
        menuItemId,
        name: input.soldItemNames[menuItemId] || menuItemId,
        qtySold: qty,
        revenue: r2(revenueByMenu.get(menuItemId) || 0),
      })
    }
  }

  // ── per-artikel analiza ──
  const rows: FcItemRow[] = []
  const windowLen = to.getTime() - from.getTime()
  const priorFrom = new Date(from.getTime() - windowLen)

  for (const item of input.items) {
    const txs = txsByItem.get(item.id) || []
    const liveQty = item.quantity

    const openAnc = openingAnchor.get(item.id)
    const closeAnc = closingAnchor.get(item.id)
    const openingQty = resolveBalance(liveQty, txs, from, openAnc)
    const closingQty = resolveBalance(liveQty, txs, to, closeAnc)

    const sums = emptySums()
    const saleOrderIds: string[] = []
    const receiptDocs: string[] = []
    const wasteReasons: string[] = []
    const stocktakeIds: string[] = []
    const priorReceipts = { sum: 0, qty: 0 }

    for (const tx of txs) {
      const g = txGroupOf(tx.type)
      if (inWindow(tx, from, to)) {
        switch (g) {
          case 'receipt':
            sums.receipt += tx.quantity
            if (tx.quantity > 0 && tx.costPerUnit > 0) {
              sums.receiptCostWeighted.sum += tx.costPerUnit * tx.quantity
              sums.receiptCostWeighted.qty += tx.quantity
            }
            if (tx.supplierDoc && receiptDocs.length < 5 && !receiptDocs.includes(tx.supplierDoc)) receiptDocs.push(tx.supplierDoc)
            break
          case 'return': sums.return += tx.quantity; break
          case 'production': sums.production += tx.quantity; break
          case 'prep': sums.prep += tx.quantity; break
          case 'sale':
            sums.sale += tx.quantity
            if (tx.orderId && saleOrderIds.length < 5 && !saleOrderIds.includes(tx.orderId)) saleOrderIds.push(tx.orderId)
            break
          case 'waste':
            sums.waste += tx.quantity
            if (tx.reason && wasteReasons.length < 3 && !wasteReasons.includes(tx.reason)) wasteReasons.push(tx.reason)
            break
          case 'correction':
            sums.correction += tx.quantity
            if (input.stocktakeIdByTxId?.[tx.id] && stocktakeIds.length < 3 && !stocktakeIds.includes(input.stocktakeIdByTxId[tx.id])) {
              stocktakeIds.push(input.stocktakeIdByTxId[tx.id])
            }
            break
          default:
            if (tx.quantity >= 0) sums.unknownIn += tx.quantity
            else sums.unknownOut += tx.quantity
        }
      }
      // prejšnje obdobje: prilivi za prior ceno
      if (g === 'receipt' && tx.quantity > 0 && tx.costPerUnit > 0 && tx.createdAt.getTime() > priorFrom.getTime() && tx.createdAt.getTime() <= from.getTime()) {
        priorReceipts.sum += tx.costPerUnit * tx.quantity
        priorReceipts.qty += tx.quantity
      }
    }

    // −0 normalizacija: −(0) da −0, ki je bitno različen od 0 (testi/JSON)
    const nz = (n: number) => (n === 0 ? 0 : n)
    const saleDeducted = nz(r3(-sums.sale)) // SALE so negativne
    const wasteQty = nz(r3(-sums.waste)) // WASTE negativne; reversali pozitivni se odštejejo
    const prepQty = nz(r3(-sums.prep))
    const returnsQty = nz(r3(sums.return))
    const correctionQty = nz(r3(sums.correction)) // ± (pozitivno = presežek)
    const receiptsQty = nz(r3(sums.receipt))
    const productionQty = nz(r3(sums.production))

    // NEPOZNANI tipi transakcij v oknu spremenijo stanje (že v opening/closing)
    // — njihov prispevek pristane v nepojasnjenem (vidno, ne skrito):
    const unknownNetQty = r3(sums.unknownIn + sums.unknownOut) // ±

    const theoQty = nz(r3(theoretical.get(item.id) || 0))
    const actualUsageQty = nz(r3(openingQty + receiptsQty + productionQty - closingQty))
    const varianceQty = nz(r3(actualUsageQty - theoQty))
    const shortfallQty = nz(r3(theoQty - saleDeducted))
    // normalizacija −0 → 0 (testi pričakujejo bitno 0)
    const unexplainedRaw = r3(varianceQty - (wasteQty + prepQty - returnsQty - shortfallQty - correctionQty))
    const unexplainedQty = unexplainedRaw === 0 ? 0 : unexplainedRaw

    // vrednotenje — ISTA osnova za obe strani (količinska izolacija)
    const hist = input.priceHistory[item.id]
    const { price, basis } = priceBasisFor(item.id, sums, hist, item.costPerUnit)
    const priorPrice = priorReceipts.qty > 0 ? r2(priorReceipts.sum / priorReceipts.qty) : hist && hist.unitPrice > 0 ? r2(hist.unitPrice) : item.costPerUnit > 0 ? r2(item.costPerUnit) : null
    const priceChangeImpact = price != null && priorPrice != null ? r2((price - priorPrice) * theoQty) : null

    const val = (qty: number): number | null => (price == null ? null : r2(qty * price))

    rows.push({
      inventoryItemId: item.id,
      name: item.name,
      category: item.category || 'general',
      unit: item.unit,
      locationId: item.locationId,
      locationName: item.locationName || item.locationId || '—',
      openingQty,
      openingBasis: openAnc ? 'stocktake' : 'ledger',
      openingStocktakeId: openAnc?.id || null,
      closingQty,
      closingBasis: closeAnc ? 'stocktake' : 'ledger',
      closingStocktakeId: closeAnc?.id || null,
      receiptsQty,
      productionQty,
      theoreticalQty: theoQty,
      actualUsageQty,
      varianceQty,
      waste: { qty: wasteQty, value: val(wasteQty) },
      prepConsumption: { qty: prepQty, value: val(prepQty) },
      returns: { qty: nz(-returnsQty), value: val(nz(-returnsQty)) },
      saleShortfall: { qty: nz(-shortfallQty), value: val(nz(-shortfallQty)) },
      inventoryCorrection: { qty: nz(-correctionQty), value: val(nz(-correctionQty)) },
      unexplained: {
        qty: unexplainedQty,
        value: null, // izračunano spodaj (val je odvisno od price)
      },
      price,
      priceBasis: basis,
      priorPrice,
      priceChangeImpact,
      theoreticalValue: val(theoQty),
      actualValue: val(actualUsageQty),
      varianceValue: val(varianceQty),
      saleOrderNumbers: saleOrderIds.map((oid) => input.orderNumbers?.[oid] ?? 0).filter((n) => n > 0),
      receiptDocs,
      wasteReasons,
      stocktakeIds,
      unitMismatch: unitMismatchItems.has(item.id),
      recipeChangedSinceFrom: recipeChangedItems.has(item.id),
      ledgerSaleQty: saleDeducted,
    })
  }

  // unexplained vrednosti (po val funkciji, ki potrebuje price)
  for (const row of rows) {
    row.unexplained.value = row.price == null ? null : r2(row.unexplained.qty * row.price)
    // nepoznani tipi transakcij: njihov neto premik je ŽE v opening/closing —
    // v razčlenitvi ga izrecno dodamo nepojasnjenemu, da se vsota pokrije
    if (row.price != null) {
      // (unknownNetQty je že vključen v varianceQty prek balance; nič dodatnega)
    }
  }

  // ── agregati ──
  let netSales = 0
  for (const s of input.sold) netSales += s.quantity * s.price - s.discountAmount
  netSales = r2(netSales)

  let theoreticalTotal = 0
  let actualTotal = 0
  const totals = {
    theoreticalQty: 0, actualUsageQty: 0, varianceQty: 0, receiptsQty: 0, productionQty: 0,
    wasteQty: 0, prepQty: 0, returnsQty: 0, shortfallQty: 0, correctionQty: 0, unexplainedQty: 0,
    purchaseValue: 0 as number | null,
  }
  let theoreticalValueTotal: number | null = null
  let actualValueTotal: number | null = null
  let varianceValueTotal: number | null = null
  let wasteValueTotal: number | null = null
  let purchaseValueAcc: number | null = null

  for (const r of rows) {
    totals.theoreticalQty = r3(totals.theoreticalQty + r.theoreticalQty)
    totals.actualUsageQty = r3(totals.actualUsageQty + r.actualUsageQty)
    totals.varianceQty = r3(totals.varianceQty + r.varianceQty)
    totals.receiptsQty = r3(totals.receiptsQty + r.receiptsQty)
    totals.productionQty = r3(totals.productionQty + r.productionQty)
    totals.wasteQty = r3(totals.wasteQty + r.waste.qty)
    totals.prepQty = r3(totals.prepQty + r.prepConsumption.qty)
    totals.returnsQty = r3(totals.returnsQty - r.returns.qty)
    totals.shortfallQty = r3(totals.shortfallQty - r.saleShortfall.qty)
    totals.correctionQty = r3(totals.correctionQty - r.inventoryCorrection.qty)
    totals.unexplainedQty = r3(totals.unexplainedQty + r.unexplained.qty)
    theoreticalTotal += r.theoreticalQty
    actualTotal += r.actualUsageQty
    if (r.theoreticalValue != null) theoreticalValueTotal = r2((theoreticalValueTotal || 0) + r.theoreticalValue)
    if (r.actualValue != null) actualValueTotal = r2((actualValueTotal || 0) + r.actualValue)
    if (r.varianceValue != null) varianceValueTotal = r2((varianceValueTotal || 0) + r.varianceValue)
    if (r.waste.value != null) wasteValueTotal = r2((wasteValueTotal || 0) + r.waste.value)
    if (r.price != null && r.receiptsQty > 0) purchaseValueAcc = r2((purchaseValueAcc || 0) + r.price * r.receiptsQty)
  }
  totals.purchaseValue = purchaseValueAcc

  const pct = (v: number | null, base: number): number | null =>
    v == null || !Number.isFinite(v) || base <= 0 ? null : r2((v / base) * 100)

  // ── kategorije / lokacije ──
  const catMap = new Map<string, { theoreticalValue: number | null; actualValue: number | null; varianceValue: number | null; wasteValue: number | null; unexplainedValue: number | null }>()
  for (const r of rows) {
    const cur = catMap.get(r.category) || { theoreticalValue: null, actualValue: null, varianceValue: null, wasteValue: null, unexplainedValue: null }
    if (r.theoreticalValue != null) cur.theoreticalValue = r2((cur.theoreticalValue || 0) + r.theoreticalValue)
    if (r.actualValue != null) cur.actualValue = r2((cur.actualValue || 0) + r.actualValue)
    if (r.varianceValue != null) cur.varianceValue = r2((cur.varianceValue || 0) + r.varianceValue)
    if (r.waste.value != null) cur.wasteValue = r2((cur.wasteValue || 0) + r.waste.value)
    if (r.unexplained.value != null) cur.unexplainedValue = r2((cur.unexplainedValue || 0) + r.unexplained.value)
    catMap.set(r.category, cur)
  }
  const byCategory = [...catMap.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => Math.abs(b.varianceValue || 0) - Math.abs(a.varianceValue || 0))

  const locMap = new Map<string, { locationId: string | null; locationName: string; theoreticalValue: number | null; actualValue: number | null; varianceValue: number | null; unexplainedValue: number | null }>()
  for (const r of rows) {
    const key = r.locationId || '_none'
    const cur = locMap.get(key) || { locationId: r.locationId, locationName: r.locationName, theoreticalValue: null, actualValue: null, varianceValue: null, unexplainedValue: null }
    if (r.theoreticalValue != null) cur.theoreticalValue = r2((cur.theoreticalValue || 0) + r.theoreticalValue)
    if (r.actualValue != null) cur.actualValue = r2((cur.actualValue || 0) + r.actualValue)
    if (r.varianceValue != null) cur.varianceValue = r2((cur.varianceValue || 0) + r.varianceValue)
    if (r.unexplained.value != null) cur.unexplainedValue = r2((cur.unexplainedValue || 0) + r.unexplained.value)
    locMap.set(key, cur)
  }
  const byLocation = [...locMap.values()].sort((a, b) => Math.abs(b.varianceValue || 0) - Math.abs(a.varianceValue || 0))

  // ── podatkovna kakovost ──
  const hasOpeningStocktake = rows.some((r) => r.openingBasis === 'stocktake')
  const hasClosingStocktake = rows.some((r) => r.closingBasis === 'stocktake')
  const itemsWithUnknownPrice = rows.filter((r) => r.priceBasis === 'unknown').length
  const itemsWithUnitMismatch = rows.filter((r) => r.unitMismatch).length
  const recipesPossiblyChanged = rows.filter((r) => r.recipeChangedSinceFrom).length
  const reasons: string[] = []
  if (!hasOpeningStocktake) reasons.push('no_opening_stocktake')
  if (!hasClosingStocktake) reasons.push('no_closing_stocktake')
  if (itemsWithUnknownPrice > 0) reasons.push('items_with_unknown_price')
  if (itemsWithUnitMismatch > 0) reasons.push('unit_mismatch')
  if (soldWithoutRecipe.length > 0) reasons.push('sold_menu_items_without_recipe')
  if (recipesPossiblyChanged > 0) reasons.push('recipes_possibly_changed')

  const kpi: FcReport['kpi'] = {
    actualFoodCostValue: actualValueTotal,
    theoreticalFoodCostValue: theoreticalValueTotal,
    varianceValue: varianceValueTotal,
    actualFoodCostPct: pct(actualValueTotal, netSales),
    theoreticalFoodCostPct: pct(theoreticalValueTotal, netSales),
    variancePctOfTheoretical: pct(varianceValueTotal, theoreticalValueTotal || 0),
    variancePctOfSales: pct(varianceValueTotal, netSales),
    wasteValue: wasteValueTotal,
    wasteSharePct: pct(wasteValueTotal, actualValueTotal || 0),
  }

  // narativne opombe (izrecne, prevedene v UI iz ključev — tukaj kanonična vsebina)
  const notes: string[] = ['signal_not_proof', 'recipe_basis_current', 'unexplained_ledger_caveat']

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    generatedAt: new Date().toISOString(),
    currency,
    salesBasis: 'paid_at',
    recipeBasis: 'current',
    netSales,
    kpi,
    totals: { ...totals, theoreticalQty: r3(totals.theoreticalQty) },
    items: rows.sort((a, b) => {
      const av = Math.abs(a.varianceValue ?? a.varianceQty * 1000)
      const bv = Math.abs(b.varianceValue ?? b.varianceQty * 1000)
      return bv - av
    }),
    byCategory,
    byLocation,
    soldWithoutRecipe: soldWithoutRecipe.sort((a, b) => b.revenue - a.revenue),
    dataQuality: {
      incompleteData: reasons.length > 0,
      reasons,
      openingBasis: hasOpeningStocktake ? 'stocktake' : 'ledger',
      closingBasis: hasClosingStocktake ? 'stocktake' : 'ledger',
      hasOpeningStocktake,
      hasClosingStocktake,
      itemsWithUnknownPrice,
      itemsWithUnitMismatch,
      soldMenuItemsWithoutRecipe: soldWithoutRecipe.length,
      recipesPossiblyChanged,
      transactionsTruncated: false, // ruta nastavi, če je take cap dosežen
    },
    notes,
  }
}
