/**
 * Issue #24 (P2, v1.114.0) — ČISTI MOTOR etiket za pripravljeno hrano in
 * odprte serije (brez DB uvozov — popolnoma testabilen).
 *
 * Ključna načela (iz issue besedila):
 *  1. ROK iz IZRECNO POTRJENEGA pravila (LabelShelfRule, filozofija #15 —
 *     "ne izmišljaj si univerzalnega števila dni"). Brez pravila in brez
 *     ročnega vnosa → needsReview: etiketa IZRECNO pokaže "potreben pregled",
 *     NIKOLI pa ne natisne navidezno veljavnega datuma.
 *  2. ZAMRZNJEN POSNETEK ob izdaji — kasnejša sprememba pravila/recepture/
 *     alergenov ne spreminja stare etikete; nova izdaja vzame trenutne
 *     (potrjene) podatke.
 *  3. Ponovni tisk = ISTA etiketa (printCount++) + NOV PrintJob poskus —
 *     ne podvoji serije, količine, StockTransaction ali preparacije.
 *  4. BLOKADA tiska za serije v karanteni/odpoku/izčrpane ali s pretečenim
 *     rokom — tiskanje ne sme ustvariti vtisa, da je živilo primerno.
 *  5. Scan status (QR) usklajen z lot-governance #15 klasifikacijo.
 */
import { allergenLabels, type AllergenCode } from './allergen-catalog'

export const LABEL_SOURCES = ['batch', 'preparation'] as const
export type LabelSource = (typeof LABEL_SOURCES)[number]

export const LABEL_STATUSES = {
  ACTIVE: 'ACTIVE',
  VOID: 'VOID',
} as const
export type LabelStatus = (typeof LABEL_STATUSES)[keyof typeof LABEL_STATUSES]

export const LABEL_RULE_SOURCES = {
  RULE: 'rule',
  MANUAL: 'manual',
  NONE: 'none',
} as const
export type LabelRuleSource = (typeof LABEL_RULE_SOURCES)[keyof typeof LABEL_RULE_SOURCES]

/** Scan status (javna statusna stran /label/<token>) — usklajen z #15. */
export const LABEL_SCAN_STATUSES = [
  'ok',
  'alert',
  'expired',
  'exhausted',
  'quarantined',
  'recalled',
  'review',
  'void',
] as const
export type LabelScanStatus = (typeof LABEL_SCAN_STATUSES)[number]

/** Rok "kmalu poteče" za ETIKETO (lastni expiresAt): 24 h prag. */
export const LABEL_ALERT_MS = 24 * 3_600_000

/** Max dolžina note na etiketi. */
export const LABEL_NOTE_MAX = 200

/** Validacija ur pravila: 0 .. 1 leto (izrecnost, ne omejevanje kuhinje). */
export const LABEL_RULE_HOURS_MAX = 8760

/** Slovenska decimalna vejica + brez odvečnih decimal za količino na etiketi. */
export function formatQty(qty: number): string {
  const r = Math.round(qty * 1000) / 1000
  return Number.isInteger(r) ? String(r) : String(r).replace('.', ',')
}

/** Začetnice odgovorne osebe ("Mojca Vodja" → "MV"; enodelno ime → 1 črka). */
export function initialsOf(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('').slice(0, 4)
}

/** Datum DD.MM.YYYY (etiketa — berljivo za kuhinjo). */
export function formatLabelDate(d: Date | null | undefined): string {
  if (!d) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

/** Datum + čas DD.MM.YYYY HH:mm (priprava/odprtje). */
export function formatLabelDateTime(d: Date | null | undefined): string {
  if (!d) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${formatLabelDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface ShelfRuleSnapshot {
  hours: number | null
  confirmedByName: string
}

export interface ExpiryDecision {
  expiresAt: Date | null
  ruleSource: LabelRuleSource
  ruleHours: number | null
  ruleConfirmedBy: string
  needsReview: boolean
}

/**
 * Izračun roka (issue #24 §1):
 *  - potrjeno pravilo (hours > 0) → preparedAt + hours, needsReview = false;
 *  - pravilo hours = 0 → IZRECNO "rok ni določen" → needsReview (nižje od ročnega);
 *  - ročni vnos → velja, a needsReview = true (rok NI iz potrjenega pravila);
 *  - nič → expiresAt null + needsReview (etiketa pokaže "potreben pregled").
 */
export function computeExpiry(
  preparedAt: Date,
  rule: ShelfRuleSnapshot | null,
  manualExpiresAt: Date | null,
): ExpiryDecision {
  if (rule && typeof rule.hours === 'number' && rule.hours > 0) {
    return {
      expiresAt: new Date(preparedAt.getTime() + rule.hours * 3_600_000),
      ruleSource: 'rule',
      ruleHours: rule.hours,
      ruleConfirmedBy: rule.confirmedByName || '',
      needsReview: false,
    }
  }
  if (rule && rule.hours === 0) {
    return {
      expiresAt: null,
      ruleSource: 'rule',
      ruleHours: 0,
      ruleConfirmedBy: rule.confirmedByName || '',
      needsReview: true,
    }
  }
  if (manualExpiresAt && !isNaN(manualExpiresAt.getTime())) {
    return {
      expiresAt: manualExpiresAt,
      ruleSource: 'manual',
      ruleHours: null,
      ruleConfirmedBy: '',
      needsReview: true,
    }
  }
  return { expiresAt: null, ruleSource: 'none', ruleHours: null, ruleConfirmedBy: '', needsReview: true }
}

/** Lot-governance bucket VEZANE serije (ali null, če etiketa ni vezana na serijo). */
export interface LabelScanBatchInfo {
  bucket:
    | 'ok'
    | 'alert'
    | 'expired'
    | 'removal_due'
    | 'exhausted'
    | 'quarantined'
    | 'recalled'
    | 'unknown_expiry'
    | null
}

export interface LabelScanInput {
  status: string
  needsReview: boolean
  expiresAt: Date | string | null
  batch: LabelScanBatchInfo | null
}

/**
 * Scan status etikete (QR → javna stran, issue #24 §2) — prednost ima STANJE
 * SERIJE (#15), nato lastni rok etikete:
 *   void → void; karantena/odpoklic/izčrpana serija → isti status;
 *   potekla serija → expired; removal_due → review (odstranitev pred rokom);
 *   sicer lastni expiresAt: pretekla → expired; ≤24 h → alert; null → review
 *   (needsReview) oz. ok (potrjeno pravilo "brez roka" — ni lažna veljavnost).
 */
export function labelScanStatus(label: LabelScanInput, now: Date = new Date()): LabelScanStatus {
  if (String(label.status || '').toUpperCase() === LABEL_STATUSES.VOID) return 'void'
  const bucket = label.batch?.bucket ?? null
  if (bucket === 'recalled') return 'recalled'
  if (bucket === 'quarantined') return 'quarantined'
  if (bucket === 'exhausted') return 'exhausted'
  if (bucket === 'expired') return 'expired'
  if (bucket === 'removal_due') return 'review'
  if (bucket === 'alert') return 'alert'
  const exp = label.expiresAt ? new Date(label.expiresAt) : null
  if (exp !== null && !isNaN(exp.getTime())) {
    if (exp.getTime() <= now.getTime()) return 'expired'
    if (exp.getTime() - now.getTime() <= LABEL_ALERT_MS) return 'alert'
    return 'ok'
  }
  if (label.needsReview) return 'review'
  return 'ok'
}

/** Slovenska sporočila blokade tiska (ključi printBlockedReason). */
export const PRINT_BLOCK_MESSAGES: Record<string, string> = {
  void: 'Etiketa je razveljavljena — natisnite novo.',
  quarantined: 'Serija je v karanteni — tiskanje ne sme ustvariti vtisa primernosti.',
  recalled: 'Serija je odpoklicana — tiskanje zavrnjeno.',
  expired: 'Rok je potekel — tiskanje zavrnjeno.',
  removal_due: 'Serija je pred odstranitvijo — tiskanje zavrnjeno.',
  exhausted: 'Serija je izčrpana — tiskanje zavrnjeno.',
}

/**
 * BLOKADA tiska (issue #24 §2): razveljavljena etiketa, serija v karanteni/
 * odpoku/izčrpana/pred odstranitvijo, serija ali etiketa s pretečenim rokom →
 * tiskanje NE sme ustvariti vtisa primernosti. "kmalu poteče" (alert) tiska
 * NE blokira (rok je znan in izpisan na etiketi).
 */
export function printBlockedReason(
  label: { status: string; expiresAt: Date | string | null },
  batch: LabelScanBatchInfo | null,
  now: Date = new Date(),
): string | null {
  if (String(label.status || '').toUpperCase() === LABEL_STATUSES.VOID) return 'void'
  if (batch) {
    if (batch.bucket === 'quarantined') return 'quarantined'
    if (batch.bucket === 'recalled') return 'recalled'
    if (batch.bucket === 'expired') return 'expired'
    if (batch.bucket === 'removal_due') return 'removal_due'
    if (batch.bucket === 'exhausted') return 'exhausted'
  }
  const exp = label.expiresAt ? new Date(label.expiresAt) : null
  if (exp !== null && !isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) return 'expired'
  return null
}

/** Vrstica tiskalnega izpisa (strukturno identična PrintLine v devices/print). */
export interface LabelPrintLine {
  text: string
  align?: 'left' | 'center' | 'right'
  bold?: boolean
  size?: 'normal' | 'large'
}

/** Prevod ključev za izpis (client pošlje že prevedene nize — i18n ostaja lokalen). */
export interface LabelPrintStrings {
  title: string
  item: string
  prepared: string
  expiry: string
  needsReview: string
  lot: string
  qty: string
  area: string
  by: string
  allergens: string
  scanNote: string
}

export interface LabelPrintData {
  itemName: string
  itemUnit: string
  lotNumber: string
  quantity: number
  area: string
  preparedAt: Date | string | null
  expiresAt: Date | string | null
  needsReview: boolean
  preparedByName: string
  allergenCodes: AllergenCode[]
  locale: 'sl' | 'hr' | 'en'
}

/**
 * Vsebina etikete (issue #24 §1): naziv, količina/enota, lokacija/območje,
 * datum+čas priprave/odprtja, določeni rok (ali IZRECNO "potreben pregled"),
 * serija, odgovorna oseba (začetnice), alergeni (samo potrjeni iz #7 —
 * prazno = ne napišemo nič, NIKOLI "brez alergenov").
 */
export function buildLabelLines(data: LabelPrintData, s: LabelPrintStrings): LabelPrintLine[] {
  const lines: LabelPrintLine[] = []
  lines.push({ text: s.title, align: 'center', bold: true, size: 'large' })
  lines.push({ text: data.itemName, align: 'center', bold: true })
  if (data.quantity > 0) {
    lines.push({ text: `${s.qty}: ${formatQty(data.quantity)} ${data.itemUnit}`, align: 'center' })
  }
  if (data.area) lines.push({ text: `${s.area}: ${data.area}`, align: 'center' })
  lines.push({ text: '─'.repeat(28), align: 'center' })
  lines.push({ text: `${s.prepared}: ${formatLabelDateTime(data.preparedAt ? new Date(data.preparedAt) : null)}` })
  if (data.expiresAt) {
    const exp = new Date(data.expiresAt)
    lines.push({ text: `${s.expiry}: ${formatLabelDate(exp)}`, bold: true })
  } else {
    lines.push({ text: s.needsReview, bold: true })
  }
  if (data.lotNumber) lines.push({ text: `${s.lot}: ${data.lotNumber}` })
  lines.push({ text: `${s.by}: ${initialsOf(data.preparedByName) || data.preparedByName}` })
  if (data.allergenCodes.length > 0) {
    lines.push({ text: `${s.allergens}: ${allergenLabels(data.allergenCodes, data.locale)}`, bold: true })
  }
  lines.push({ text: '─'.repeat(28), align: 'center' })
  lines.push({ text: s.scanNote, align: 'center' })
  return lines
}
