/**
 * Issue #18 (P1) — tristransko ujemanje PO ↔ dejanski prevzem (GRN) ↔
 * dobaviteljev račun (eSLOG).
 *
 * PREJ (potrjena vrzel v issue-ju):
 *  - PO→AP most ob prevzemu je obveznost takoj označil `matchStatus: 'matched'`
 *    SAMO na podlagi podatkov naročila/prevzema — brez primerjave z dejanskim
 *    dokumentom dobavitelja (lažni "matched");
 *  - eSLOG uvoz je ustvaril vrstice BREZ povezave na PO postavke in zgolj
 *    nastavil `matchStatus: 'auto'`.
 *
 * Zdaj (ta modul):
 *  1. EVALVACIJA (evaluateApMatch): vsaka AP vrstica, povezana na PO postavko,
 *     se primerja PO dogovorjeni ceni/DDV, KUMULATIVNI fakturirani količini
 *     (vsota vseh ne-preklicanih AP vrstic na isto PO postavko — več računov,
 *     delnih dobav in dobropisov ne sme fakturirati iste količine dvakrat) in
 *     skladnosti zneska vrstice (količina × cena × DDV). Nepovezane vrstice →
 *     review_required. Prekoračitve čez tolerance → blocked.
 *  2. STATUSI (kanonični nabor #18, String stolpci — brez DDL):
 *       matched | review_required | blocked | exception_approved  (izračun)
 *       grn_draft (osnutek iz prevzema — NE izgleda kot potrjen račun)
 *       auto (legacy eSLOG uvozi pred #18) | unmatched (ročni stroški)
 *     exception_approved je LEPENJIV: ponovna evalvacija ga ne prepiše
 *     (odobritev izjeme je human akt z audit sledjo).
 *  3. PREDLOGI (proposeLineLinks): deterministično predlaganje povezav
 *     eSLOG vrstica → PO postavka istega dobavitelja v uporabnikovem obsegu
 *     (normaliziran opis + enota + DDV stopnja + količinska smiselnost —
 *     SOLO IME NI DOVOLJENO za samodejno povezavo; samodejno se poveže SAMO
 *     točno ujemanje, ostalo zahteva ročno potrditev).
 *
 * Tolerance: src/lib/ap-tolerance.ts (DDL-gated nastavitev pooblaščene osebe;
 * privzeto STROGO: 0 % količina/cena/DDV + 2 centa zaokroževanja).
 *
 * Zaloge račun NE spreminja (zaloga sledi potrjeni dobavnici; AP sledi
 * dejanskemu računu — zahteva #18 §3). Audit: AP_MATCH_EVALUATED /
 * AP_LINE_LINKED prek writeAudit (hash-chain ohranjen).
 */
import { db } from '@/lib/db'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { apToleranceConfig, DEFAULT_AP_TOLERANCE, type ApMatchTolerance } from '@/lib/ap-tolerance'

/* ───────────── statusi ───────────── */

export const AP_MATCH_STATUSES = [
  'unmatched', // privzeto (ročni strošek brez vrstic)
  'auto', // legacy eSLOG (pred #18)
  'grn_draft', // osnutek obveznosti iz prevzema (#18: ločeno od potrjenega računa)
  'matched', // potrjena tristranska primerjava
  'review_required', // nepovezane vrstice / manjše odstopanje
  'blocked', // prekoračena toleranca (količina/cena/DDV/znesek)
  'exception_approved', // blokirano, a pooblaščena oseba odobrila izjemo
] as const
export type ApMatchStatus = (typeof AP_MATCH_STATUSES)[number]

/** Statusi, ki jih lahko avtomatska evalvacija prepiše (odobritev je lepenljiva). */
export const REEVALUABLE_STATUSES: readonly ApMatchStatus[] = ['auto', 'matched', 'review_required', 'blocked']

export const AP_LINE_VARIANCE_STATUSES = ['match', 'not_linked', 'blocked', 'unverified'] as const
export type ApLineVarianceStatus = (typeof AP_LINE_VARIANCE_STATUSES)[number]

/* ───────────── evalvacija ───────────── */

export interface ApLineEval {
  lineId: string
  description: string
  purchaseOrderItemId: string | null
  varianceStatus: ApLineVarianceStatus
  reasons: string[]
  varianceNote: string
  quantityInvoiced: number // predznačena (dobropis negativno)
  quantityInvoicedCumulative: number // vključno to vrstico (suma vseh ne-void AP)
  quantityOrdered: number | null
  quantityReceived: number | null
  unitPriceInvoiced: number
  unitPriceOrdered: number | null
  vatRateInvoiced: number | null
  vatRateOrdered: number | null
  lineTotal: number
  expectedLineTotal: number | null // količina × PO cena × (1 + PO DDV)
  amountVarianceCents: number // |lineTotal − expected| v centih (povezane vrstice)
}

export interface ApMatchEval {
  apId: string
  apNumber: string
  matchStatus: ApMatchStatus
  lines: ApLineEval[]
  linesTotal: number
  linesMatched: number
  linesBlocked: number
  linesNotLinked: number
  varianceCents: number // suma |lineTotal − expected| povezanih vrstic
  totalsOk: boolean
  reasons: string[]
  tolerance: ApMatchTolerance
}

const cents = (v: number) => Math.round(v * 100)
const qtyEps = 1e-9

/** Ali AP sploh zadeva tristransko evalvacijo? (osnutki/ročni stroški NE) */
export function apEligibleForMatch(matchStatus: string, lineCount: number): boolean {
  if (lineCount === 0) return false
  if (matchStatus === 'grn_draft') return false // osnutek iz prevzema — NI dejanski račun
  if (matchStatus === 'exception_approved') return false // odobritev je lepenljiva
  return true // auto / matched / review_required / blocked / unmatched z vrsticami
}

/**
 * Izračuna tristransko evalvacijo AP (BREZ pisanja). Vrne null, če AP ni
 * upravičen (osnutek brez vrstic / grn_draft / exception_approved / ne obstaja).
 */
export async function evaluateApMatch(
  apId: string,
  opts?: { tolerance?: ApMatchTolerance }
): Promise<ApMatchEval | null> {
  const ap = await db.accountsPayable.findUnique({
    where: { id: apId },
    include: { AccountsPayableLine: { orderBy: { createdAt: 'asc' } } },
  })
  if (!ap || ap.status === 'void') return null
  if (!apEligibleForMatch(ap.matchStatus, ap.AccountsPayableLine.length)) return null

  const tolerance = opts?.tolerance ?? (await apToleranceConfig())
  const lines = ap.AccountsPayableLine

  // PO postavke povezanih vrstic + kumulativne fakturirane količine (vsi ne-void AP)
  const poItemIds = [...new Set(lines.map((l) => l.purchaseOrderItemId).filter((x): x is string => !!x))]
  const poItems = poItemIds.length
    ? await db.purchaseOrderItem.findMany({
        where: { id: { in: poItemIds } },
        include: { PurchaseOrder: { select: { id: true, poNumber: true, status: true } } },
      })
    : []
  const poItemById = new Map(poItems.map((i) => [i.id, i]))

  // kumulativa: APji (ne-void) z vrsticami na iste PO postavke — ročna suma (groupBy
  // ne more filtrirati po statusu starša). OSNUTKI (grn_draft) NE ŠTEJEJO: osnutek
  // iz prevzema NI račun dobavitelja — kumulativna fakturirana količina meri SAMO
  // dejanske dokumente dobavitelja (issue #18: ločitev osnutka od računa).
  let cumulative = new Map<string, number>()
  if (poItemIds.length) {
    const siblingApLines = await db.accountsPayableLine.findMany({
      where: { purchaseOrderItemId: { in: poItemIds }, AccountsPayable: { status: { not: 'void' }, matchStatus: { not: 'grn_draft' } } },
      select: { purchaseOrderItemId: true, quantityInvoiced: true },
    })
    cumulative = new Map<string, number>()
    for (const l of siblingApLines) {
      const key = l.purchaseOrderItemId as string
      cumulative.set(key, (cumulative.get(key) ?? 0) + Number(l.quantityInvoiced))
    }
  }

  const lineEvals: ApLineEval[] = []
  let linesMatched = 0
  let linesBlocked = 0
  let linesNotLinked = 0
  let varianceCentsSum = 0
  const globalReasons: string[] = []

  for (const l of lines) {
    const qty = Number(l.quantityInvoiced)
    const unitPrice = Number(l.unitPriceInvoiced)
    const vatRate = l.vatRateInvoiced == null ? null : Number(l.vatRateInvoiced)
    const lineTotal = Number(l.lineTotal)
    const reasons: string[] = []
    let varianceStatus: ApLineVarianceStatus = 'match'

    const poItem = l.purchaseOrderItemId ? poItemById.get(l.purchaseOrderItemId) : undefined
    if (!poItem) {
      varianceStatus = 'not_linked'
      linesNotLinked++
      lineEvals.push({
        lineId: l.id, description: l.description, purchaseOrderItemId: null,
        varianceStatus, reasons: ['Ni povezave z nabavno postavko (PO) — ročna povezava potrebna.'],
        varianceNote: 'Ni povezave z nabavno postavko (PO).',
        quantityInvoiced: qty, quantityInvoicedCumulative: qty,
        quantityOrdered: null, quantityReceived: null,
        unitPriceInvoiced: unitPrice, unitPriceOrdered: null,
        vatRateInvoiced: vatRate, vatRateOrdered: null,
        lineTotal, expectedLineTotal: null, amountVarianceCents: 0,
      })
      continue
    }

    const ordered = Number(poItem.quantityOrdered)
    const received = Number(poItem.quantityReceived)
    const poPrice = Number(poItem.unitPrice)
    const poVat = Number(poItem.vatRate)
    const cum = cumulative.get(poItem.id) ?? 0

    // 1. količinska kontrola (kumulativno, predznačeno za dobropise)
    const qtyTolOrdered = (ordered * tolerance.qtyTolerancePct) / 100
    const qtyTolReceived = (received * tolerance.qtyTolerancePct) / 100
    if (cum > ordered + qtyTolOrdered + qtyEps) {
      reasons.push(`Kumulativno fakturirano (${cum.toFixed(3)}) presega naročeno (${ordered}) več kot dovoljena toleranca.`)
    }
    if (cum - received > qtyTolReceived + qtyEps) {
      reasons.push(`Fakturirano (${cum.toFixed(3)}) presega dejansko sprejeto količino (${received}) — blago še ni prevzeto.`)
    }
    // 2. cena na enoto
    if (unitPrice > 0 || poPrice > 0) {
      const priceDiff = Math.abs(unitPrice - poPrice)
      const priceTol = (Math.abs(poPrice) * tolerance.priceTolerancePct) / 100
      if (priceDiff > priceTol + 1e-9) {
        reasons.push(`Cena na enoto (${unitPrice.toFixed(4)}) odstopa od dogovorjene (${poPrice.toFixed(4)}).`)
      }
    }
    // 3. DDV stopnja (absolutna razlika v odstotnih točkah)
    if (vatRate != null) {
      const vatDiff = Math.abs(vatRate - poVat)
      if (vatDiff > tolerance.vatTolerancePct + 1e-9) {
        reasons.push(`DDV stopnja (${vatRate} %) se ne ujema z dogovorjeno (${poVat} %).`)
      }
    }
    // 4. skladnost zneska vrstice (količina × fakturirana cena × DDV)
    const vatMult = vatRate == null ? 1 : 1 + vatRate / 100
    const recomputed = Math.abs(qty * unitPrice * vatMult)
    // audit #13: razlika mora biti DVOSMERNA. Prej je bil preizkus enostranski
    // (|lineTotal| − recomputed > toleranca), zato je bila PODFakturirana vrstica
    // (npr. tipkanih 10,00 namesto 61,00) VEDNO 'match' — razlika je negativna in
    // nikoli ne preseže tolerance. Tudi obe strani sta magnitudi, da predznačena
    // vrstica dobropisa ne odstopa sama od sebe.
    const lineAmountDiff = Math.abs(Math.abs(lineTotal) - recomputed)
    if (lineAmountDiff > tolerance.amountToleranceCents / 100 + 1e-9) {
      reasons.push(`Znesek vrstice (${lineTotal.toFixed(2)}) ne ustreza količini × ceni × DDV (${recomputed.toFixed(2)}).`)
    }
    // 5. pričakovani znesek po PO (varianca v centih)
    const expected = Math.abs(qty) * poPrice * (1 + poVat / 100)
    const amountVarianceCents = Math.abs(cents(Math.abs(lineTotal)) - cents(expected))

    if (reasons.length > 0) {
      varianceStatus = 'blocked'
      linesBlocked++
    } else {
      linesMatched++
    }
    varianceCentsSum += amountVarianceCents

    lineEvals.push({
      lineId: l.id, description: l.description, purchaseOrderItemId: poItem.id,
      varianceStatus, reasons, varianceNote: reasons.join(' '),
      quantityInvoiced: qty, quantityInvoicedCumulative: cum,
      quantityOrdered: ordered, quantityReceived: received,
      unitPriceInvoiced: unitPrice, unitPriceOrdered: poPrice,
      vatRateInvoiced: vatRate, vatRateOrdered: poVat,
      lineTotal, expectedLineTotal: Math.round(expected * 100) / 100, amountVarianceCents,
    })
  }

  // 6. kontrola glave računa (vsota vrstic vs. navedeni zneski)
  const linesGrossSum = lines.reduce((s, l) => s + Math.abs(Number(l.lineTotal)), 0)
  const headTotal = Number(ap.totalAmount)
  const headNet = Number(ap.subtotal) + Number(ap.vatAmount)
  const amountTolEur = tolerance.amountToleranceCents / 100
  const totalsOk = Math.abs(linesGrossSum - Math.abs(headTotal)) <= amountTolEur + 1e-9
    && Math.abs(Math.abs(headNet) - Math.abs(headTotal)) <= amountTolEur + 1e-9
  if (!totalsOk) {
    globalReasons.push(`Vsota vrstic (${linesGrossSum.toFixed(2)}) se ne ujema z glavo računa (${Math.abs(headTotal).toFixed(2)}).`)
  }

  let matchStatus: ApMatchStatus
  if (linesBlocked > 0 || !totalsOk) matchStatus = 'blocked'
  else if (linesNotLinked > 0) matchStatus = 'review_required'
  else matchStatus = 'matched'
  if (globalReasons.length && linesBlocked === 0) matchStatus = 'blocked'

  return {
    apId: ap.id,
    apNumber: ap.apNumber,
    matchStatus,
    lines: lineEvals,
    linesTotal: lines.length,
    linesMatched,
    linesBlocked,
    linesNotLinked,
    varianceCents: varianceCentsSum,
    totalsOk,
    reasons: [...globalReasons, ...lineEvals.flatMap((l) => l.reasons)],
    tolerance,
  }
}

/**
 * Evalvacija + PERSISTENCA: posodobi varianceStatus/varianceNote vrstic in
 * matchStatus AP + audit AP_MATCH_EVALUATED (povzetek, brez tujih zneskov).
 * Vrne evalvacijo (null = ni upravičen / ne obstaja).
 *
 * Issue #18: ko DEJANSKI račun (ne osnutek) dobi status 'matched', se osnutki
 * iz prevzema (grn_draft) na ISTE PO postavke, ki jih je račun v celoti
 * pokril, nadomestijo (status 'void' + audit GRN_DRAFT_SUPERSEDED) — s tem
 * ista blago ne ostane DVOJNO knjiženo kot obveznost (osnutek + račun).
 */
export async function applyApMatchEvaluation(
  apId: string,
  opts?: { tolerance?: ApMatchTolerance; userId?: string | null; reason?: string }
): Promise<ApMatchEval | null> {
  const evalResult = await evaluateApMatch(apId, { tolerance: opts?.tolerance })
  if (!evalResult) return null

  await db.$transaction(async (tx) => {
    for (const l of evalResult.lines) {
      await tx.accountsPayableLine.update({
        where: { id: l.lineId },
        data: { varianceStatus: l.varianceStatus, varianceNote: l.varianceNote.slice(0, 500) },
      })
    }
    await tx.accountsPayable.update({
      where: { id: apId },
      data: { matchStatus: evalResult.matchStatus },
    })
    await writeAudit(tx, {
      userId: opts?.userId ?? null,
      action: 'AP_MATCH_EVALUATED',
      entityType: 'AccountsPayable',
      entityId: apId,
      details: jstr({
        apNumber: evalResult.apNumber,
        matchStatus: evalResult.matchStatus,
        linesTotal: evalResult.linesTotal,
        linesMatched: evalResult.linesMatched,
        linesBlocked: evalResult.linesBlocked,
        linesNotLinked: evalResult.linesNotLinked,
        varianceCents: evalResult.varianceCents,
        totalsOk: evalResult.totalsOk,
        tolerance: evalResult.tolerance,
        trigger: opts?.reason || 'auto',
      }),
    })
  })

  // Issue #18: uspešno primerjan račun nadomesti pokrite osnutke iz prevzema
  if (evalResult.matchStatus === 'matched') {
    await supersedeGrnDrafts(apId).catch((e) => {
      console.warn('[ap-match] supersede osnutkov ni uspel:', String((e as Error).message || e))
    })
  }
  return evalResult
}

/**
 * Issue #18: osnutki iz prevzema (grn_draft), katerih PO postavke je DEJANSKI
 * račun v celoti pokril (kumulativno fakturirano ≥ osnutek), se nadomestijo —
 * status 'void' (mehko, revizijska sled ostane) + audit GRN_DRAFT_SUPERSEDED.
 * Delni računi pustijo delni osnutek (samo pokrite vrstice nadomestijo celo).
 */
async function supersedeGrnDrafts(apId: string): Promise<string[]> {
  const ap = await db.accountsPayable.findUnique({
    where: { id: apId },
    include: { AccountsPayableLine: { select: { purchaseOrderItemId: true } } },
  })
  if (!ap) return []
  const poItemIds = [...new Set(ap.AccountsPayableLine.map((l) => l.purchaseOrderItemId).filter((x): x is string => !!x))]
  if (poItemIds.length === 0) return []

  const drafts = await db.accountsPayable.findMany({
    where: { status: { not: 'void' }, matchStatus: 'grn_draft', AccountsPayableLine: { some: { purchaseOrderItemId: { in: poItemIds } } } },
    include: { AccountsPayableLine: { select: { purchaseOrderItemId: true, quantityInvoiced: true } } },
  })
  if (drafts.length === 0) return []

  // kumulativno fakturirano (DEJANSKI računi) na dotičnih postavkah
  const realCum = new Map<string, number>()
  const rows = await db.accountsPayableLine.findMany({
    where: { purchaseOrderItemId: { in: poItemIds }, AccountsPayable: { status: { not: 'void' }, matchStatus: { not: 'grn_draft' } } },
    select: { purchaseOrderItemId: true, quantityInvoiced: true },
  })
  for (const r of rows) {
    const key = r.purchaseOrderItemId as string
    realCum.set(key, (realCum.get(key) ?? 0) + Number(r.quantityInvoiced))
  }

  const superseded: string[] = []
  for (const draft of drafts) {
    const linked = draft.AccountsPayableLine.filter((l) => !!l.purchaseOrderItemId)
    if (linked.length === 0) continue
    const covered = linked.every(
      (l) => Math.abs(Number(l.quantityInvoiced)) <= (realCum.get(l.purchaseOrderItemId as string) ?? 0) + 1e-9,
    )
    if (!covered) continue
    await db.accountsPayable.update({ where: { id: draft.id }, data: { status: 'void' } })
    await writeAudit(db, {
      userId: null,
      action: 'GRN_DRAFT_SUPERSEDED',
      entityType: 'AccountsPayable',
      entityId: draft.id,
      details: jstr({
        draftApNumber: draft.apNumber,
        supersededByApNumber: ap.apNumber,
        purchaseOrderId: ap.purchaseOrderId,
        note: 'Osnutek obveznosti iz prevzema je nadomeščen z dejanskim računom dobavitelja (tristransko ujemanje uspešno).',
      }),
      locationId: draft.locationId ?? undefined,
    })
    superseded.push(draft.apNumber)
  }
  return superseded
}

/* ───────────── predlogi povezav ───────────── */

export interface PoItemCandidate {
  id: string
  description: string
  unit: string
  vatRate: number
  quantityOrdered: number
  quantityReceived: number
  quantityInvoicedCumulative: number // brez trenutnega AP
  poNumber: string
  purchaseOrderId: string
}

export interface LineProposal {
  lineId: string
  description: string
  best: PoItemCandidate | null
  score: number
  confidence: 'exact' | 'strong' | 'weak' | 'none'
  reasons: string[]
}

/** Normalizacija opisa: male črke, brez diakritik, zloženi presledki. */
export function normalizeDesc(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenSet(s: string): Set<string> {
  return new Set(normalizeDesc(s).split(' ').filter((t) => t.length > 2))
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const t of a) if (b.has(t)) hit++
  return hit / Math.min(a.size, b.size)
}

/**
 * Deterministični predlog povezav za vrstice AP (eSLOG) → PO postavke istega
 * dobavitelja v danem obsegu. SOLO IME NI DOVOLJENO za samodejno povezavo:
 * samodejno (exact) zahteva normaliziran opis + DDV + količinsko smiselnost
 * (kumulativ + vrstica ≤ NAROČENO); ostalo so predlogi za ročno potrditev.
 *
 * Nihanje med več enakimi kandidati (isti artikel na več odprtih PO-jih):
 * prednost ima postavka z največ NEFAKTURIRANEGA PREJETEGA (uncovered) —
 * račun pokriva blago, ki je dejansko prejeto in še ni fakturirano
 * (FIFO logika kumulativnega fakturiranja; kandidat, ki preseže prejeto,
 * še vedno dobi točno ujemanje, a z opozorilom — evalvacija ga BLOKIRA).
 */
export function proposeLinks(
  apLines: { id: string; description: string; quantityInvoiced: number; vatRateInvoiced: number | null }[],
  poCandidates: PoItemCandidate[]
): LineProposal[] {
  return apLines.map((line) => {
    const norm = normalizeDesc(line.description)
    const lineVat = line.vatRateInvoiced
    const lineTokens = tokenSet(line.description)
    let best: PoItemCandidate | null = null
    let bestScore = 0
    let bestUncovered = -Infinity
    let bestConfidence: LineProposal['confidence'] = 'none'
    let bestReasons: string[] = []

    for (const cand of poCandidates) {
      const reasons: string[] = []
      let score = 0
      let confidence: LineProposal['confidence'] = 'none'
      const descExact = norm !== '' && norm === normalizeDesc(cand.description)
      const vatMatch = lineVat != null && Math.abs(lineVat - cand.vatRate) < 0.01
      const qtyFitsOrdered = Math.abs(line.quantityInvoiced) + cand.quantityInvoicedCumulative <= cand.quantityOrdered + qtyEps
      // nefakturirano prejeto (dobropisne/negativne količine vedno »pokrijejo«)
      const uncovered = cand.quantityReceived - cand.quantityInvoicedCumulative
      const qtyCoversReceived = line.quantityInvoiced <= uncovered + qtyEps
      const tokens = overlap(lineTokens, tokenSet(cand.description))

      if (descExact && vatMatch) {
        if (qtyFitsOrdered) {
          // točno ujemanje: opis + DDV + količina znotraj naročenega; prednost
          // kandidatu, ki pokriva največ nefakturiranega PREJETEGA blaga
          score = 100 + Math.max(0, Math.min(uncovered, Math.abs(line.quantityInvoiced)))
          confidence = 'exact'
          reasons.push('Ujemanje opisa (normalizirano) + DDV stopnje')
          if (!qtyCoversReceived) reasons.push('Količina presega (še ne fakturirano) sprejeto količino — izjema bo označena')
        } else {
          score = 90
          confidence = 'strong'
          reasons.push('Ujemanje opisa + DDV, a količina presega naročeno — potreben pregled')
        }
      } else if (tokens >= 0.8 && vatMatch) {
        score = 70
        confidence = 'strong'
        reasons.push(`Visoko ujemanje opisa (${Math.round(tokens * 100)} %) + DDV`)
        if (!qtyFitsOrdered) { score = 60; reasons.push('Količina presega naročeno — potreben pregled') }
      } else if (tokens >= 0.5) {
        score = 40
        confidence = 'weak'
        reasons.push(`Delno ujemanje opisa (${Math.round(tokens * 100)} %) — ročna potrditev obvezna`)
      }
      // v1.105.0 (#15): DETERMINISTIČNI tie-break — enake točke (npr. več PO
      // postavk istega artikla za dobropis) ne smejo odviseti od nedoločenega
      // vrstnega reda DB poizvedbe: (1) več nefakturiranega prejete količine,
      // (2) leksikografsko manjši id (stabilen vrstni red). Brez tega je bila
      // izbira kandidata odvisna od SQLite query plana (shemske spremembe so
      // lahko preletele vrstni red → isti račun povezal na DRUGO postavko).
      const better =
        score > bestScore
        || (score === bestScore && score > 0 && best !== null
          && (uncovered > bestUncovered
            || (uncovered === bestUncovered && cand.id < best.id)))
      if (better) {
        bestScore = score
        bestUncovered = uncovered
        best = cand
        bestConfidence = confidence
        bestReasons = reasons
      }
    }
    return {
      lineId: line.id,
      description: line.description,
      best,
      score: bestScore,
      confidence: bestConfidence,
      reasons: bestReasons,
    }
  })
}

/** Kandidati PO postavk istega dobavitelja (status approved/partial/received) v obsegu. */
export async function poCandidatesForSupplier(
  supplierId: string,
  scope: { locationId?: string | { in: string[] } },
  excludeApId?: string
): Promise<PoItemCandidate[]> {
  const pos = await db.purchaseOrder.findMany({
    where: {
      supplierId,
      status: { in: ['approved', 'partial', 'received'] },
      ...(scope.locationId ? { locationId: scope.locationId } : {}),
    },
    select: {
      id: true, poNumber: true, status: true,
      PurchaseOrderItem: {
        where: { status: { not: 'cancelled' } },
        select: {
          id: true, description: true, unit: true, vatRate: true,
          quantityOrdered: true, quantityReceived: true,
        },
      },
    },
    take: 50,
  })
  const itemIds = pos.flatMap((po) => po.PurchaseOrderItem.map((i) => i.id))
  const cumulative = new Map<string, number>()
  if (itemIds.length) {
    const rows = await db.accountsPayableLine.findMany({
      where: {
        purchaseOrderItemId: { in: itemIds },
        // Issue #18: osnutki iz prevzema (grn_draft) NE štejejo v kumulativno
        // fakturirano količino — niso dejanski računi dobavitelja
        AccountsPayable: { status: { not: 'void' }, matchStatus: { not: 'grn_draft' }, id: excludeApId ? { not: excludeApId } : undefined },
      },
      select: { purchaseOrderItemId: true, quantityInvoiced: true },
    })
    for (const r of rows) {
      const key = r.purchaseOrderItemId as string
      cumulative.set(key, (cumulative.get(key) ?? 0) + Number(r.quantityInvoiced))
    }
  }
  const out: PoItemCandidate[] = []
  for (const po of pos) {
    for (const i of po.PurchaseOrderItem) {
      out.push({
        id: i.id,
        description: i.description,
        unit: i.unit,
        vatRate: Number(i.vatRate),
        quantityOrdered: Number(i.quantityOrdered),
        quantityReceived: Number(i.quantityReceived),
        quantityInvoicedCumulative: cumulative.get(i.id) ?? 0,
        poNumber: po.poNumber,
        purchaseOrderId: po.id,
      })
    }
  }
  return out
}

/**
 * Samodejna povezava SAMO točnih ujemanj (desc + DDV + količina smiselna) —
 * vrne število povezanih vrstic (0 = nič sprememb). Pisce klica nato izvede
 * applyApMatchEvaluation. Obseg kandidatov: user's locationScope (klicalca
 * podá — nikoli kar AP lokacija: centralni uvoz ne sme povezati vrstic na PO-je
 * TUJE organizacije).
 */
export async function autoLinkExactMatches(
  apId: string,
  userId?: string | null,
  scope?: { locationId?: string | { in: string[] } }
): Promise<number> {
  const ap = await db.accountsPayable.findUnique({
    where: { id: apId },
    include: { AccountsPayableLine: { orderBy: { createdAt: 'asc' } } },
  })
  if (!ap || ap.status === 'void' || ap.AccountsPayableLine.length === 0) return 0
  if (ap.matchStatus === 'grn_draft' || ap.matchStatus === 'exception_approved') return 0

  const candidates = await poCandidatesForSupplier(ap.supplierId, scope ?? {}, apId)
  const proposals = proposeLinks(
    ap.AccountsPayableLine.map((l) => ({
      id: l.id, description: l.description,
      quantityInvoiced: Number(l.quantityInvoiced),
      vatRateInvoiced: l.vatRateInvoiced == null ? null : Number(l.vatRateInvoiced),
    })),
    candidates,
  )
  const exact = proposals.filter((p) => p.confidence === 'exact' && p.best)
  if (exact.length === 0) return 0

  // ena PO postavka na vrstico — in PO postavka se NE sme povezati dvakrat znotraj
  // enega AP (nalaganje več računov na isto postavko istočasno = dvakratno fakturiranje)
  const usedPoItems = new Set<string>()
  const links: { lineId: string; purchaseOrderItemId: string }[] = []
  for (const p of exact) {
    const cand = p.best as PoItemCandidate
    if (usedPoItems.has(cand.id)) continue
    usedPoItems.add(cand.id)
    links.push({ lineId: p.lineId, purchaseOrderItemId: cand.id })
  }
  await db.$transaction(async (tx) => {
    for (const link of links) {
      await tx.accountsPayableLine.update({
        where: { id: link.lineId },
        data: { purchaseOrderItemId: link.purchaseOrderItemId },
      })
    }
    await writeAudit(tx, {
      userId: userId ?? null,
      action: 'AP_LINE_LINKED',
      entityType: 'AccountsPayable',
      entityId: apId,
      details: jstr({
        apNumber: ap.apNumber,
        mode: 'auto_exact',
        links: links.map((l) => ({ lineId: l.lineId, purchaseOrderItemId: l.purchaseOrderItemId })),
      }),
    })
  })
  return links.length
}
