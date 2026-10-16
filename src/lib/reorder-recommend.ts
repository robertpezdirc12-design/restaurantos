/**
 * Issue #12 (P2) — priporočeni nabavni nalogi: ČISTI izračun priporočil
 * (brez DB — enotsko testiran), nadgradnja PAR-logike iz src/lib/reorder.ts.
 *
 * Formula (iz issue #12 — preprost, determinističen, razumljiv uporabniku):
 *   target  = avgDailyUse × (leadTimeDays + reviewDays) + safetyStock
 *   needQty = target − onHand − incoming          (incoming = POTRJENE dobave
 *              v teku: Σ(ordered − received) po odprtih naročilih z statusom
 *              submitted | approved | partial — OSNUTEK ni potrjena dobava)
 *   verdict = RECOMMEND  (needQty > 0 → naroči)
 *             WATCH      (needQty ≤ 0, a artikel je pod pragom ponaročanja
 *                          ali pod varnostno zalogo → človek presodi)
 *             null       (zaloga pokriva prihodnost — izpusti)
 *
 * Pakiranja (SupplierItem): need se zaokroži NAVZGOR na celo število paketov,
 * najmanj minOrderPacks (issue: "velikost pakiranja, minOrderPacks"):
 *   packs = max(minOrderPacks, ceil(need / packQty)); qty = packs × packQty
 * Brez dobaviteljskega kataloga: količina = need (brez zaokroževanja),
 * ocena cene = need × costPerUnit.
 *
 * Izhodišče porabe: podpisana knjiga StockTransaction (tipi SALE,
 * STORNO_RETURN, WASTE, BATCH_INPUT, BATCH_OUTPUT — neto vsota; STORNO in
 * BATCH_OUTPUT sta pozitivna in ZMANJŠATA neto porabo — isto količino nikoli
 * ne odštejemo dvakrat). Povprečje = neto odtok / dolžina okna (dni).
 *
 * Kakovost podatkov (issue: "jasno označi, če so podatki nepopolni"):
 *   flags.noHistory  — v oknu ni bilo nobene transakcije porabe
 *   flags.noLeadTime — artikel nima leadTimeDays → privzeti rok (2 dni,
 *                       enako privzetku ReorderRule)
 *   flags.noSupplier — ni aktivnega SupplierItem niti legacy vezave
 *   flags.belowPar   — zaloga ≤ prag ponaročanja (PAR iz reorder.ts)
 *
 * Predviden datum pomanjkanja: onHand / avgDailyUse dni od "zdaj"
 * (coverageDays; null kadar ni zgodovine porabe — ni izmišljenega datuma).
 */

const r3 = (n: number) => Math.round(n * 1000) / 1000
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Privzeti dobavni rok, kadar artikel nima svojega (enako ReorderRule privzetku). */
export const DEFAULT_LEAD_TIME_DAYS = 2
/** Privzeti pregledni cikel med naročili (dnevi med dvema pregledoma zaloge). */
export const DEFAULT_REVIEW_DAYS = 7
/** Privzeto okno zgodovine porabe (dnevi) — parameter GET rute. */
export const DEFAULT_HISTORY_DAYS = 28

/** Vrste transakcij, ki tvorijo NETO porabo (podpisane količine; glej zgornjo opombo). */
export const CONSUMPTION_TX_TYPES = ['SALE', 'STORNO_RETURN', 'WASTE', 'BATCH_INPUT', 'BATCH_OUTPUT'] as const

/** Dobaviteljska vezava artikla s pakiranjem (SupplierItem, aktivna). */
export interface RecommendSupplier {
  supplierId: string
  supplierName: string
  packQty: number
  packUnit: string
  minOrderPacks: number
  pricePerPack: number
  vatRate: number | null
}

/** Vhod za en artikel (vse številke že pretvorjene iz Decimal). */
export interface RecommendItemInput {
  id: string
  name: string
  unit: string
  /** Trenutna zaloga na roki (InventoryItem.quantity). */
  quantity: number
  minQuantity: number
  reorderPoint: number
  safetyStock: number
  leadTimeDays: number
  /** Povprečna dnevna NETO poraba v oknu (≥ 0). */
  avgDailyUse: number
  /** Št. transakcij porabe v oknu (0 → flags.noHistory). */
  historyCount: number
  /** Potrjene dobave v teku (odprta naročila, NE osnutki). */
  incoming: number
  costPerUnit: number
  supplier: RecommendSupplier | null
}

export type RecommendVerdict = 'RECOMMEND' | 'WATCH'

export interface RecommendFlags {
  noHistory: boolean
  noLeadTime: boolean
  noSupplier: boolean
  belowPar: boolean
}

export interface Recommendation {
  itemId: string
  itemName: string
  unit: string
  verdict: RecommendVerdict
  onHand: number
  incoming: number
  avgDailyUse: number
  leadTimeDays: number
  safetyStock: number
  reorderPoint: number
  reviewDays: number
  targetQty: number
  needQty: number
  /** Predlagano št. paketov (0 brez dobavitelja / pri WATCH). */
  suggestedPacks: number
  /** Predlagana količina v enotah artikla (paketi × packQty ali need). */
  suggestedQty: number
  estCost: number
  supplierId: string | null
  supplierName: string
  /** Dni do izpraznitve zaloge pri trenutni porabi (null = ni zgodovine). */
  coverageDays: number | null
  /** ISO datum (samo dan) predvidenega pomanjkanja (null = ni zgodovine). */
  stockoutDate: string | null
  flags: RecommendFlags
}

export interface RecSupplierGroup {
  supplierId: string | null
  supplierName: string
  items: Recommendation[]
  total: number
}

export interface RecommendAllResult {
  recommendations: Recommendation[]
  watch: Recommendation[]
  skipped: number
}

export interface RecommendOptions {
  /** Pregledni cikel v dnevih (privzeto DEFAULT_REVIEW_DAYS). */
  reviewDays?: number
  /** Časovna točka izračuna (testi); privzeto zdaj. */
  now?: Date
}

const localDate = (d: Date): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Učinkoviti dobavni rok: lastni (če > 0) sicer privzeti. */
export function effectiveLeadTime(leadTimeDays: number): number {
  return leadTimeDays > 0 ? leadTimeDays : DEFAULT_LEAD_TIME_DAYS
}

/** PAR prag (isto hierarhijo kot reorder.ts: reorderPoint pred minQuantity). */
export function parThreshold(minQuantity: number, reorderPoint: number): number {
  if (reorderPoint > 0) return r3(reorderPoint)
  return minQuantity > 0 ? r3(minQuantity) : 0
}

/** Ciljna količula: poraba v (rok + pregled) + varnostna zaloga. */
export function targetQty(avgDailyUse: number, leadTimeDays: number, reviewDays: number, safetyStock: number): number {
  const use = avgDailyUse > 0 ? avgDailyUse : 0
  return r3(use * (effectiveLeadTime(leadTimeDays) + reviewDays) + (safetyStock > 0 ? safetyStock : 0))
}

/** Zaokroževanje na pakete: navzgor na celo pakiranje, najmanj minOrderPacks. */
export function packsFor(need: number, packQty: number, minOrderPacks: number): number {
  if (!(need > 0)) return 0
  const pq = packQty > 0 ? packQty : 1
  const min = Number.isInteger(minOrderPacks) && minOrderPacks > 0 ? minOrderPacks : 1
  return Math.max(min, Math.ceil(need / pq))
}

/**
 * Priporočilo za en artikel (ali null — zaloga pokriva, brez razloga za prikaz).
 * Deterministično: isti vhod → isti izhod (razen stockoutDate, ki sledi `now`).
 */
export function recommendForItem(input: RecommendItemInput, opts: RecommendOptions = {}): Recommendation | null {
  const reviewDays = opts.reviewDays && opts.reviewDays > 0 ? opts.reviewDays : DEFAULT_REVIEW_DAYS
  const now = opts.now ?? new Date()

  const onHand = r3(input.quantity)
  const incoming = r3(input.incoming)
  const use = input.avgDailyUse > 0 ? r3(input.avgDailyUse) : 0
  const par = parThreshold(input.minQuantity, input.reorderPoint)
  const safety = input.safetyStock > 0 ? r3(input.safetyStock) : 0
  const lead = effectiveLeadTime(input.leadTimeDays)

  const target = targetQty(use, input.leadTimeDays, reviewDays, input.safetyStock)
  const need = r3(target - onHand - incoming)

  const belowPar = par > 0 && onHand <= par
  const belowSafety = safety > 0 && onHand <= safety

  let verdict: RecommendVerdict | null = null
  if (need > 0) verdict = 'RECOMMEND'
  else if (belowPar || belowSafety) verdict = 'WATCH'
  if (!verdict) return null

  // pakiranja (samo pri RECOMMEND — pri WATCH ni količine, samo opozorilo)
  const hasPackSupplier = verdict === 'RECOMMEND' && input.supplier != null
  const packQty = hasPackSupplier && input.supplier!.packQty > 0 ? input.supplier!.packQty : 1
  const packs = hasPackSupplier ? packsFor(need, packQty, input.supplier!.minOrderPacks) : 0
  const suggestedQty = verdict === 'RECOMMEND'
    ? (hasPackSupplier ? r3(packs * packQty) : need)
    : 0
  const estCost = verdict === 'RECOMMEND'
    ? (hasPackSupplier && input.supplier!.pricePerPack > 0
        ? r2(packs * input.supplier!.pricePerPack)
        : r2(suggestedQty * input.costPerUnit))
    : 0

  const coverageDays = use > 0 ? r3(Math.max(0, onHand) / use) : null
  const stockoutDate = use > 0
    ? localDate(new Date(now.getTime() + Math.max(0, onHand) / use * 86_400_000))
    : null

  return {
    itemId: input.id,
    itemName: input.name,
    unit: input.unit,
    verdict,
    onHand,
    incoming,
    avgDailyUse: use,
    leadTimeDays: lead,
    safetyStock: safety,
    reorderPoint: par,
    reviewDays,
    targetQty: target,
    needQty: need,
    suggestedPacks: packs,
    suggestedQty,
    estCost,
    supplierId: input.supplier?.supplierId ?? null,
    supplierName: input.supplier?.supplierName ?? '',
    coverageDays,
    stockoutDate,
    flags: {
      noHistory: input.historyCount <= 0,
      noLeadTime: !(input.leadTimeDays > 0),
      noSupplier: input.supplier == null,
      belowPar,
    },
  }
}

/** Priporočila za vse artikle (RECOMMEND ločeno od WATCH; števec preskočenih). */
export function recommendAll(items: RecommendItemInput[], opts: RecommendOptions = {}): RecommendAllResult {
  const recommendations: Recommendation[] = []
  const watch: Recommendation[] = []
  let skipped = 0
  for (const i of items) {
    const rec = recommendForItem(i, opts)
    if (!rec) { skipped++; continue }
    if (rec.verdict === 'RECOMMEND') recommendations.push(rec)
    else watch.push(rec)
  }
  // najbolj kritični najprej: manj pokritosti = prej zmanjka
  const byUrgency = (a: Recommendation, b: Recommendation) => {
    const ca = a.coverageDays ?? Number.POSITIVE_INFINITY
    const cb = b.coverageDays ?? Number.POSITIVE_INFINITY
    return ca - cb || b.needQty - a.needQty
  }
  recommendations.sort(byUrgency)
  watch.sort(byUrgency)
  return { recommendations, watch, skipped }
}

/** Združi RECOMMEND priporočila po dobavitelju (skupna skupina brez dobavitelja). */
export function groupRecommendationsBySupplier(recs: Recommendation[]): RecSupplierGroup[] {
  const map = new Map<string, RecSupplierGroup>()
  for (const r of recs) {
    const key = r.supplierId || `__none__:${r.supplierName}`
    let g = map.get(key)
    if (!g) {
      g = { supplierId: r.supplierId, supplierName: r.supplierName, items: [], total: 0 }
      map.set(key, g)
    }
    g.items.push(r)
    g.total = r2(g.total + r.estCost)
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}
