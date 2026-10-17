import { num, r2 } from '@/lib/map'

/**
 * Issue #1 §6 — kanonični izračun računa (deljeno plačilo, popusti, zvestoba, Happy Hour).
 * VSA obdelava zneskov gre skozi tukaj — POS UI, /api/orders/[id]/bill in /api/furs
 * uporabljajo isti vir, ne sme obstajati vzporedni izračun.
 *
 * Pravila:
 * - ročni popust (Order.appliedDiscountId / Order.discount) + avtomatski (Happy Hour) se seštejeta,
 *   skupni popust je omejen na subtotal (račun nikoli pod 0);
 * - Happy Hour: Discount s triggerType='auto', veljavnost validFrom/validTo + časovno okno
 *   happyDays (CSV ISO dni 0=ned..6=sob) / happyFromHour / happyToHour (lokalna ura lokacije);
 *   ciljanje prek targetCategoryIds (CSV; prazno = cel račun, 'check');
 * - zvestoba: obračun = točke × pointsValue (Location.loyaltyPointsValue), zaslužek
 *   = floor(znesekZaPlačilo × pointsPerEuro) — samo če je lokacija omogočila zvestobo.
 */

export interface BillItem {
  id: string
  menuItemId: string
  name: string
  quantity: number
  unitPrice: number
  vatRate: number
  vatAmount: number
  categoryId: string | null
  voided: boolean
}

export interface AutoDiscountLine {
  discountId: string
  name: string
  amount: number
}

export interface BillResult {
  items: BillItem[]
  subtotal: number
  tax: number
  grossTotal: number
  manualDiscount: number
  autoDiscounts: AutoDiscountLine[]
  discountTotal: number
  totalDue: number
  loyalty: {
    enabled: boolean
    pointsPerEuro: number
    pointsValue: number
    /** maksimalno št. točk, ki jih je mogoče unovčiti na tem računu (<= totalDue) */
    maxRedeemablePoints: number
  }
}

/** Je Happy Hour aktiven ob podanem času (lokalna ura lokacije)? */
export function isHappyActive(
  d: { happyDays?: string | null; happyFromHour?: number | null; happyToHour?: number | null },
  now: Date,
): boolean {
  // brez okna je 'auto' discount aktiven ves čas veljavnosti (validFrom/validTo loči klicatelj)
  const hasWindow = d.happyFromHour != null && d.happyToHour != null
  if (!hasWindow) return true
  const from = Number(d.happyFromHour)
  const to = Number(d.happyToHour)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false
  if (d.happyDays) {
    const days = d.happyDays.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    if (days.length > 0 && !days.includes(now.getDay())) return false
  }
  const h = now.getHours()
  if (from < to) return h >= from && h < to
  // okno čez polnoč (npr. 22–2)
  return h >= from || h < to
}

/** `num` vrne Number.NaN za number-tipovni NaN — pri denarju ne sme potovati naprej. */
function finite(v: unknown): number {
  const n = num(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Naloga #6 (DDV konvencija): cena artikla v bazi je **končna cena za gosta**
 * (vključno z DDV), kot je natisnjena na meniju. DDV se zato IZVLEČE iz cene,
 * ne prišteva k njej.
 *
 * `netFromGross` je edini vir resnice za razčlenitev; vsota prikazanih cen na
 * računu mora biti enaka ZA PLAČATI.
 */
export function netFromGross(lineGross: number, vatRate: number): number {
  const g = Math.max(0, finite(lineGross))
  const rate = finite(vatRate)
  return rate > 0 ? r2(g / (1 + rate / 100)) : r2(g)
}

/** DDV, izvlečen iz končne cene postavke (obračunana razlika — brez dvojinega zaokroževanja). */
export function vatFromGross(lineGross: number, vatRate: number): number {
  const g = r2(Math.max(0, finite(lineGross)))
  return r2(g - netFromGross(g, vatRate))
}

/** Razčlenitev vrstice (končna cena + izvlečeni DDV) na NETO osnovo, DDV in
 *  znesek ZA PLAČANJE. `lineTotal` je vedno KONČNA cena (DDV je že v njej),
 *  `vatOf` iz nje izvlečeni DDV. Vsota `lineTotal` nikoli NE pride nazaj k
 *  `net` — to je točka, kjer se DDV lahko podvoji. */
export function splitVat<T>(rows: T[], lineTotal: (r: T) => number, vatOf: (r: T) => number): { net: number; vat: number; gross: number } {
  let gross = 0
  let vat = 0
  for (const r of rows) {
    gross += finite(lineTotal(r))
    vat += finite(vatOf(r))
  }
  const g = r2(gross)
  const v = r2(Math.min(vat, gross))
  return { net: r2(g - v), vat: v, gross: g }
}

/** Osnova za popust na ciljne kategorije (ali cel račun, če target prazen).
 *  Popust je vedno na BRUTO osnovi — gost vidi končne cene, zato mora «−10 %»
 *  pomeniti 10 % tega, kar je prečital na meniju. */
function discountBase(
  items: BillItem[],
  targetCategoryIds: string,
  grossBase: number,
): number {
  const cats = targetCategoryIds.split(',').map((s) => s.trim()).filter(Boolean)
  if (cats.length === 0) return grossBase
  const set = new Set(cats)
  let base = 0
  for (const it of items) {
    if (it.voided) continue
    if (it.categoryId && set.has(it.categoryId)) base += it.unitPrice * it.quantity
  }
  return r2(base)
}

/** Znesek popusta za en Discount na podani osnovi (odstotek ali fiksni znesek).
 *  'percentage' = legacy alias za 'percent' (obstoječi produkcijski podatki). */
export function discountAmountOf(d: { type: string; amount: number | unknown }, base: number): number {
  const a = num(d.amount)
  if (base <= 0) return 0
  const type = String(d.type).toLowerCase()
  if (type === 'percent' || type === 'percentage') return r2(Math.min((base * a) / 100, base))
  return r2(Math.min(a, base))
}

export interface BillInput {
  items: BillItem[]
  subtotal: number
  tax: number
  manualDiscount: number
  autoCandidates: {
    id: string
    name: string
    type: string
    amount: number | unknown
    happyDays?: string | null
    happyFromHour?: number | null
    happyToHour?: number | null
    targetCategoryIds?: string | null
  }[]
  now: Date
  loyaltyEnabled: boolean
  pointsPerEuro: number
  pointsValue: number
}

/** Kanonični izračun računa — enoten za UI predogled in zaključek plačila (FURS).
 *  `subtotal` je NETO (osnova za DDV), `tax` izvlečeni DDV, `grossTotal` znesek, ki ga
 *  gost plača — enak vsoti prikazanih cen. Popusti so na bruto osnovi (Naloga #6).
 *  Neveljavni (NaN/±Infinity) zneski se nevtralizirajo na 0: pokvarjen popust pomeni
 *  «brez popusta», ne «račun je plačan 0 €» — smer, ki nikoli ne izniži prihodka. */
export function computeBill(input: BillInput): BillResult {
  const subtotal = r2(finite(input.subtotal))
  const tax = r2(finite(input.tax))
  const grossTotal = r2(subtotal + tax)

  // avtomatski popusti (Happy Hour): oceni samo AktIVNE ob 'now', izberi najugodnejšega na osnovi
  const autoDiscounts: AutoDiscountLine[] = []
  for (const d of input.autoCandidates) {
    if (!isHappyActive(d, input.now)) continue
    const base = discountBase(input.items, d.targetCategoryIds || '', grossTotal)
    const amount = discountAmountOf(d, base)
    if (amount > 0) autoDiscounts.push({ discountId: d.id, name: d.name, amount })
  }
  // en popust na discountId (zaščita pred podvajanjem), najugodnejša kombinacija = vsi veljavni
  const seen = new Set<string>()
  let autoTotal = 0
  for (const ad of autoDiscounts.sort((a, b) => b.amount - a.amount)) {
    if (seen.has(ad.discountId)) continue
    seen.add(ad.discountId)
    autoTotal += ad.amount
  }

  const manualDiscount = r2(Math.max(0, Math.min(finite(input.manualDiscount), grossTotal)))
  const discountTotal = r2(Math.min(manualDiscount + r2(autoTotal), grossTotal))
  const totalDue = r2(Math.max(0, grossTotal - discountTotal))

  const ppv = Math.max(0, num(input.pointsValue, 0.01))
  const maxRedeemablePoints = ppv > 0 ? Math.floor(totalDue / ppv) : 0

  return {
    items: input.items,
    subtotal,
    tax,
    grossTotal,
    manualDiscount,
    autoDiscounts,
    discountTotal,
    totalDue,
    loyalty: {
      enabled: input.loyaltyEnabled,
      pointsPerEuro: Math.max(0, Math.floor(input.pointsPerEuro || 0)),
      pointsValue: ppv,
      maxRedeemablePoints,
    },
  }
}

/** Zaslužene točke za plačani znesek (kanonično pravilo — isti izračun povsod). */
export function earnPointsFor(totalDue: number, pointsPerEuro: number): number {
  if (pointsPerEuro <= 0) return 0
  return Math.floor(Math.max(0, totalDue) * pointsPerEuro)
}

/** Tier po dosedanjih točkah (kanonično pravilo, usklajeno z /api/loyalty). */
export function tierForPoints(lifetimePoints: number): string {
  return lifetimePoints >= 1000 ? 'platinum' : lifetimePoints >= 500 ? 'gold' : lifetimePoints >= 100 ? 'silver' : 'bronze'
}
