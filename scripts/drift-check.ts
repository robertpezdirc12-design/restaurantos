#!/usr/bin/env bun
/**
 * Task 45: Schema drift check s "known-issue" allowlist.
 *
 * Pokaže se kot CI korak v .github/workflows/ci.yml (job neon-smoke) in
 * primerja produkcijsko kopijo sheme (Neon ephemeral branch od prod) z
 * prisma/schema.prisma. Razlikuje TRI izide:
 *
 *   1. brez drifta          → exit 0 (zelena)
 *   2. SAMO znani pending drift → exit 0 + ::warning:: anotacija (rumena)
 *      — trenutno issue-13: Location.premisesId nullable (Task 44), produkcija
 *      čaka na uporabniški DDL korak (admin ruta /api/admin/migrate-issue13).
 *      Rdeči CI na vsakem commitu bi učil tim ignoriranja rdečega CI in
 *      utišal prave regresije; allowlist to odpravi, VSAK drug drift pa
 *      ostane hard fail.
 *   3. nepričakovan drift ALI infra napaka → exit 1 (rdeča, blokator)
 *
 * Uporaba:
 *   bun scripts/drift-check.ts <from-url> <schema.prisma>
 *
 * Exit kodi prisma migrate diff --exit-code:
 *   0 = brez razlik · 2 = razlike obstajajo (SQL na stdout) · 1 = napaka
 *
 * Pisanje v $GITHUB_STEP_SUMMARY in GitHub anotacije se izvede le, če
 * spremenljivka obstaja (lokalni zagon izpiše vse na stdout).
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** Normaliziran SQL stavek: brez komentarjev/praznih vrstic, en sam presledek. */
export function parseStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .map((line) => line.replace(/^\s*--.*$/, ''))
    .join('\n')
  return withoutComments
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Issue-13 (Task 44): Location.premisesId je v datamodelu `String? @unique`,
 * produkcija pa še vedno NOT NULL DEFAULT ''. Prisma diff generira (lokalno
 * replikirano, deterministično):
 *
 *   -- AlterTable
 *   ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL,
 *   ALTER COLUMN "premisesId" DROP DEFAULT;
 *
 * (prav tako sprejmemo razdvojeni dva stavka — enaka semantika)
 */
export function isIssue13Statement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"Location"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (clauses.length === 0) return false
  return clauses.every((c) =>
    /^ALTER\s+COLUMN\s+"premisesId"\s+(DROP\s+NOT\s+NULL|DROP\s+DEFAULT)$/i.test(c),
  )
}

export interface KnownDrift {
  id: string
  reason: string
  matches(stmt: string): boolean
}

/**
 * Task 66 (v1.64.0): stroški kategorije — stolpec "category" na AccountsPayable
 * je v fazi DDL-drafta (main schema.prisma polja ŠE nima; dev zrcalo ga ima).
 * Diff (Neon → main schema) lahko generira DVA smeri, odvisno od faze:
 *  - faza B (uporabnik je apliciral DDL, main schema še brez polja):
 *      ALTER TABLE "AccountsPayable" DROP COLUMN "category";
 *  - faza C' (naslednja naloga doda polje v main schema, DDL še ni apliciran):
 *      ALTER TABLE "AccountsPayable" ADD COLUMN "category" TEXT NOT NULL DEFAULT '';
 * Matcher je STROG (po vzoru isIssue13Statement): tabela + VSAKA klavzula mora
 * biti točno ADD/DROP COLUMN "category" — kombiniran ALTER z dodatnimi stolpci
 * ostane unexpected. Narekovaji preprečujejo lažne ujeme ("AccountsPayableLine",
 * "category_id"). Ko sta polje in DDL usklajena (faza C), drift izgine in vnos
 * postane mrtva koda.
 */
export function isStroskiKategorijeStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"AccountsPayable"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (clauses.length === 0) return false
  return clauses.every((c) => /^(ADD|DROP)\s+COLUMN\s+"category"(\s|$)/i.test(c))
}

/**
 * Issue #18 (v1.103.0): tolerance tristranskega ujemanja — 4 stolpci na
 * RestaurantSettings. Dvosmerno (kot stroski-kategorije): pred DDL jih main
 * schema nima (brez drifta, če jih baza še ne ima); PO uporabniškem DDL in
 * PRED umikom iz mirror sheme diff generira DROP COLUMN ×4; po uskladitvi
 * izgine. Matcher je STROG: tabela + vsaka klavzula ADD/DROP enega od 4 imen.
 * Split klavzul je OKLEPAJNO-ZAVEDEN (DECIMAL(5,2) vsebuje vejico!).
 */
export function isApToleranceStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"RestaurantSettings"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = splitTopLevelClauses(m[1])
  if (clauses.length === 0) return false
  const cols = [
    'apMatchQtyTolerancePct', 'apMatchPriceTolerancePct',
    'apMatchVatTolerancePct', 'apMatchAmountToleranceCents',
  ]
  return clauses.every((c) => {
    const mm = /^(ADD|DROP)\s+COLUMN\s+"(\w+)"(\s|$)/i.exec(c)
    return !!mm && cols.includes(mm[2])
  })
}

/**
 * Issue #7 (v1.104.0): alergeni — en vir resnice. 10 stolpcev na 3 tabelah
 * (InventoryItem 4 + MenuItem 5 + OrderItem 2). Dvosmerno (kot ap-tolerance):
 * pred DDL jih main schema ima, baza pa ne → diff ADD COLUMN; po uporabniškem
 * DDL (in pred umikom iz mirror/main) lahko generira DROP COLUMN. Matcher je
 * STROG po tabeli: vsaka klavzula ADD/DROP mora biti stolpec IZ RAVNO TE
 * tabele (InventoryItem ≠ MenuItem stolpci se mešati ne smejo).
 */
const ALLERGEN_TRUTH_COLUMNS: Record<string, string[]> = {
  InventoryItem: ['allergens', 'allergensCrossContact', 'allergensConfirmedAt', 'allergensConfirmedById'],
  MenuItem: ['allergensOverride', 'allergensConfirmedAt', 'allergensConfirmedById', 'allergenReviewFlag', 'allergenReviewReason'],
  OrderItem: ['allergenSnapshot', 'allergenWarning'],
}

export function isAllergenTruthStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"(\w+)"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const table = m[1]
  const allowed = ALLERGEN_TRUTH_COLUMNS[table]
  if (!allowed) return false
  const clauses = splitTopLevelClauses(m[2])
  if (clauses.length === 0) return false
  return clauses.every((c) => {
    // IF NOT EXISTS je dovoljen vmes (naša DDL ruta ga izdaje; prisma diff ne)
    const mm = /^(ADD|DROP)\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"(\s|$)/i.exec(c)
    if (mm) return allowed.includes(mm[2])
    // Issue #2 (faza B po DDL, CI run 38964400094): DDL ruta je allergensConfirmedAt
    // ustvarila kot goli TIMESTAMP (µs natančnost), prisma DateTime pa generira
    // TIMESTAMP(3) (ms — aplikacija piše izključno ms). Dokler normalizacija ni
    // aplicirana, diff zahteva SET DATA TYPE TIMESTAMP(3) (varna prirezava µs→ms).
    const tp =
      /^ALTER\s+COLUMN\s+"allergensConfirmedAt"\s+SET\s+DATA\s+TYPE\s+TIMESTAMP\(3\)$/i.exec(c)
    return !!tp && allowed.includes('allergensConfirmedAt')
  })
}


/**
 * Issue #15 (v1.105.0): lot governance — 9 stolpcev na InventoryBatch
 * (alertDate/removalDate/holdReason/holdAt/holdById/holdRef/releaseAt/
 * releaseById/releaseNote). Dvosmerno (kot allergen-truth): pred DDL jih
 * main schema ima, baza ne → ADD COLUMN; po DDL (in pred umikom iz mirror/
 * main, če bo kdaj) DROP COLUMN. Matcher STROG po tabeli: samo InventoryBatch
 * in samo lot-governance stolpci.
 */
const LOT_GOVERNANCE_COLUMNS = [
  'alertDate', 'removalDate', 'holdReason', 'holdAt', 'holdById', 'holdRef',
  'releaseAt', 'releaseById', 'releaseNote',
]

const LOT_GOVERNANCE_TIMESTAMP_COLS = ['alertDate', 'removalDate', 'holdAt', 'releaseAt']

export function isLotGovernanceStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"(\w+)"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  if (m[1] !== 'InventoryBatch') return false
  const clauses = splitTopLevelClauses(m[2])
  if (clauses.length === 0) return false
  return clauses.every((c) => {
    const mm = /^(ADD|DROP)\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"(\s|$)/i.exec(c)
    if (mm) return LOT_GOVERNANCE_COLUMNS.includes(mm[2])
    // Issue #2 (faza B po DDL, CI run 38964400094): lot-governance DDL ruta je
    // 4 časovne stolpce ustvarila kot goli TIMESTAMP (µs), prisma DateTime pa
    // generira TIMESTAMP(3) (ms). Dokler normalizacija ni aplicirana, diff
    // zahteva SET DATA TYPE TIMESTAMP(3) (varna prirezava µs→ms).
    const tp = /^ALTER\s+COLUMN\s+"(\w+)"\s+SET\s+DATA\s+TYPE\s+TIMESTAMP\(3\)$/i.exec(c)
    return !!tp && LOT_GOVERNANCE_TIMESTAMP_COLS.includes(tp[1])
  })
}

/** Split na vejice ZUNAJ oklepajev (DECIMAL(5,2) ne razbije klavzul). */
function splitTopLevelClauses(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * Task 64 (v1.62.0): HaccpPlan tabela — prisma diff generira CREATE TABLE +
 * 2× CREATE INDEX + ADD CONSTRAINT (FK na Location). Vsi 4 stavki vsebujejo
 * "HaccpPlan" (noben drug model se nanjo veže), zato je matcher preprost in
 * strog hkrati: samo DDL-ključne besede + ime tabele.
 */
export function isHaccpPlanStatement(stmt: string): boolean {
  if (!/"HaccpPlan"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

/** v1.85.1 (P0-2): PayLink tabela — isti vzorec kot HaccpPlan (vsi stavki vsebujejo ime). */
export function isPayLinkStatement(stmt: string): boolean {
  if (!/"PayLink"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

/** v1.87.0 (P1-6): split po gostih — ALTER TABLE ADD COLUMN + DROP INDEX nad PayLink. */
export function isPayLinkSplitStatement(stmt: string): boolean {
  if (!/"PayLink"/.test(stmt)) return false
  return /^(ALTER\s+TABLE|DROP\s+INDEX)\b/i.test(stmt)
}

/**
 * v1.98.0 (issue #37): aditivni stolpec PayLink."sessionId" — kanonična Stripe
 * Checkout seja povezave (strežniška vezava plačila na KONKRETNO povezavo).
 * Prepozna ALTER TABLE "PayLink" z SAMO tem dodatnim stolpcem.
 */
export function isPayLinkSessionStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"PayLink"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"sessionId"\s+TEXT\b/i.exec(stmt)
  return !!m
}

/**
 * v1.94.0 (issue #31–36): aditivna MFA stolpca nad Employee — mfaLastTotpCounter
 * (TOTP replay zaščita, RFC 6238 §5.2) + mfaRecoveryVersion (CAS za atomarno
 * porabo recovery kod). Prepozna ALTER TABLE "Employee" z SAMO tema dvema
 * dodatnima stolpcema (druge spremembe Employee ostanejo nepričakovani drift).
 */
export function isIssue31_36MfaStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"Employee"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = m[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (clauses.length === 0) return false
  return clauses.every((c) =>
    /^ADD\s+COLUMN\s+"(mfaLastTotpCounter|mfaRecoveryVersion)"(\s|$)/i.test(c)
  )
}

/**
 * v1.100.0 (issue #38): aditivni tenant ključ EventLog."locationId" (+ index).
 * Prepozna ALTER TABLE "EventLog" z SAMO tem dodatnim stolpcem (drugo = nepričakovan drift)
 * in CREATE INDEX EventLog_locationId_idx.
 */
export function isIssue38EventTenantStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"EventLog"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"locationId"\s+TEXT\b/i.exec(stmt)
  if (m) return true
  return /^CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"EventLog_locationId_idx"\s+ON\s+"EventLog"\s+\("locationId"\)/i.test(stmt)
}

/**
 * Issue #19 (v1.107.0): politika finančnih izjem — 9 stolpcev na
 * RestaurantSettings (pragovi odobritve + obveznost razloga) IN katalog
 * razlogov izjem — 2 stolpca na VoidReason (kind + requireComment).
 * Dvosmerno (kot ap-tolerance): pred DDL jih main schema nima; po DDL in
 * pred uskladitvijo shem diff generira DROP COLUMN. Matcherja STROGA po
 * tabeli (RestaurantSettings ≠ VoidReason stolpci se ne mešajo).
 */
const EXCEPTION_POLICY_COLUMNS = [
  'excDiscountApprovalPct', 'excDiscountApprovalAmountCents', 'excVoidApprovalAmountCents',
  'excStornoApprovalAmountCents', 'excCancelApprovalAmountCents', 'excRequireReasonDiscount',
  'excRequireReasonCancel', 'excRequireReasonStorno', 'excRequireReasonVoid',
]

export function isExceptionPolicyStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"RestaurantSettings"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = splitTopLevelClauses(m[1])
  if (clauses.length === 0) return false
  return clauses.every((c) => {
    const mm = /^(ADD|DROP)\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"(\s|$)/i.exec(c)
    return !!mm && EXCEPTION_POLICY_COLUMNS.includes(mm[2])
  })
}

const EXCEPTION_REASON_COLUMNS = ['kind', 'requireComment']

export function isExceptionReasonsStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"VoidReason"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = splitTopLevelClauses(m[1])
  if (clauses.length === 0) return false
  return clauses.every((c) => {
    const mm = /^(ADD|DROP)\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"(\s|$)/i.exec(c)
    return !!mm && EXCEPTION_REASON_COLUMNS.includes(mm[2])
  })
}

/**
 * Issue #16 (v1.108.0): blagajniški premiki denarja — NOVA tabela CashMovement
 * (knjiga neprodajnih premikov predala; HaccpPlan vzorec: vsi stavki vsebujejo
 * ime tabele) + 2 politika stolpca na RestaurantSettings (prag variance +
 * slepi popis) + 3 povzetek stolpca na ZReport (paidIn/paidOut/guestRefund).
 * Dvosmerno (kot allergen-truth): pred DDL ADD COLUMN, po DDL DROP COLUMN.
 * Matcher STROG: CashMovement samo CREATE/ALTER stavki; RestaurantSettings in
 * ZReport samo njihovi cash- stolpci.
 */
const CASH_POLICY_COLS = ['cashVarianceThresholdCents', 'cashBlindCount']
const ZREPORT_CASH_COLS = ['cashPaidIn', 'cashPaidOut', 'cashGuestRefund']

function allClausesCashColumn(clauses: string[], allowed: string[]): boolean {
  if (clauses.length === 0) return false
  return clauses.every((c) => {
    const mm = /^(ADD|DROP)\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"(\s|$)/i.exec(c)
    return !!mm && allowed.includes(mm[2])
  })
}

export function isCashMovementStatement(stmt: string): boolean {
  // 1) nova tabela: vsi stavki vsebujejo "CashMovement" (HaccpPlan vzorec)
  if (/"CashMovement"/.test(stmt)) {
    return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE)\b/i.test(stmt)
  }
  // 2) RestaurantSettings politika stolpca
  let m = /^ALTER\s+TABLE\s+"RestaurantSettings"\s+([\s\S]+)$/i.exec(stmt)
  if (m) return allClausesCashColumn(splitTopLevelClauses(m[1]), CASH_POLICY_COLS)
  // 3) ZReport povzetek stolpca
  m = /^ALTER\s+TABLE\s+"ZReport"\s+([\s\S]+)$/i.exec(stmt)
  if (m) return allClausesCashColumn(splitTopLevelClauses(m[1]), ZREPORT_CASH_COLS)
  return false
}

/**
 * Issue #2 (CI run 38964400094 — prvi neon-smoke po DDL valovih 13.–16. 10.
 * 2026): ZDRUŽENI RestaurantSettings stavek. prisma migrate diff vse
 * manjkajoče/odvečne stolpce ENE tabele združi v EN ALTER TABLE stavek,
 * ne glede na to, iz katere funkcije izhajajo. Posamične faze (pred DDL /
 * po DDL) pokrivajo ap-tolerance, exception-policy in cash-movements svoje
 * vnose; PO apliciranju VEČ DDL korakov pred uskladitvijo main sheme pa
 * diff generira ENEGA združenega DROP COLUMN ×15, ki ga posamični matcher
 * ne pokriva. Ta matcher sprejme ZDRUŽENO obliko: unija 15 dokumentiranih
 * pending stolpcev. STROG: tabela RestaurantSettings, VSAKA klavzula je
 * ADD/DROP COLUMN izključno iz unije — vsak drug (nov, nedokumentiran)
 * stolpec ostane hard fail. Ko naslednja schema naloga prevzame polja v
 * prisma/schema.prisma (že so v prisma/schema.sqlite.prisma), drift izgine
 * in vnos postane mrtva koda (vzorec stroski-kategorije, faza B→C).
 */
const SETTINGS_PENDING_MERGED_COLUMNS = new Set<string>([
  'apMatchQtyTolerancePct', 'apMatchPriceTolerancePct',
  'apMatchVatTolerancePct', 'apMatchAmountToleranceCents',
  ...CASH_POLICY_COLS,
  ...EXCEPTION_POLICY_COLUMNS,
])

export function isRestaurantSettingsPendingMergedStatement(stmt: string): boolean {
  const m = /^ALTER\s+TABLE\s+"RestaurantSettings"\s+([\s\S]+)$/i.exec(stmt)
  if (!m) return false
  const clauses = splitTopLevelClauses(m[1])
  if (clauses.length === 0) return false
  return clauses.every((c) => {
    const mm = /^(ADD|DROP)\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"(\s|$)/i.exec(c)
    return !!mm && SETTINGS_PENDING_MERGED_COLUMNS.has(mm[2])
  })
}

/** Issue #20 (v1.109.0): HACCP operativni tok — HaccpEntry/HaccpPlan novi
 * stolpci + NOVA tabela HaccpAction (strogo po tabelah, vzorec cash-movements). */
const HACCP_OPS_ENTRY_COLS = new Set([
  'planId', 'planName', 'planVersion', 'ruleSnapshot', 'measureKind', 'numericValue',
  'unit', 'occurrenceKey', 'dueAt', 'entryState', 'source', 'closedAt',
])
const HACCP_OPS_PLAN_COLS = new Set([
  'measureKind', 'unit', 'direction', 'okLimit', 'warnLimit', 'rangeMin', 'rangeMax',
  'critical', 'requiresVerification', 'dueTime', 'weekday', 'monthDay', 'version',
])

function allClausesHaccpColumn(clauses: string[], allowed: Set<string>): boolean {
  return clauses.length > 0 && clauses.every((c) => {
    const m = /^(ADD|DROP)\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"(\s|$)/i.exec(c.trim())
    return m !== null && allowed.has(m[2])
  })
}

export function isHaccpOpsStatement(stmt: string): boolean {
  // 1) nova tabela HaccpAction + indeksi
  if (/"HaccpAction"/.test(stmt)) {
    return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE)\b/i.test(stmt)
  }
  // 2) HaccpEntry novi stolpci (CREATE INDEX ISTO imena tabel dovoljena zgoraj)
  //    + planId nullability uskladitev (issue #2, faza B po DDL): DDL ruta je
  //    planId ustvarila kot TEXT NOT NULL DEFAULT '', main schema pa ima planId
  //    String? @default("") — dokler ni usklajeno, diff zahteva
  //    ALTER COLUMN "planId" DROP NOT NULL (sprostitev omejitve, brez
  //    podatkovne spremembe). Vsak drug HaccpEntry stolpec/klavzula → fail.
  let m = /^ALTER\s+TABLE\s+"HaccpEntry"\s+([\s\S]+)$/i.exec(stmt)
  if (m) {
    const clauses = splitTopLevelClauses(m[1])
    return (
      clauses.length > 0 &&
      clauses.every((c) => {
        const col = /^(ADD|DROP)\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"(\s|$)/i.exec(c.trim())
        if (col) return HACCP_OPS_ENTRY_COLS.has(col[2])
        const nullab = /^ALTER\s+COLUMN\s+"planId"\s+DROP\s+(?:NOT\s+NULL|DEFAULT)$/i.exec(c.trim())
        return !!nullab
      })
    )
  }
  // 3) HaccpPlan novi stolpci
  m = /^ALTER\s+TABLE\s+"HaccpPlan"\s+([\s\S]+)$/i.exec(stmt)
  if (m) return allClausesHaccpColumn(splitTopLevelClauses(m[1]), HACCP_OPS_PLAN_COLS)
  return false
}

/** Issue #13 (v1.110.0): javni rezervacijski widget — NOVA tabela
 * ReservationWidget (strogo po tabeli — vzorec HaccpAction; nova tabela
 * se ne prekriva z nobenim obstoječim matcherjem). */
export function isReservationWidgetStatement(stmt: string): boolean {
  if (!/"ReservationWidget"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

/** Issue #21 (v1.111.0): klic vodje iz POS-a — NOVA tabela ManagerCall
 * (strogo po tabeli — vzorec ReservationWidget/HaccpAction). */
export function isManagerCallStatement(stmt: string): boolean {
  if (!/"ManagerCall"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

/** Issue #14 (v1.112.0): KDS poimenovane postaje — NOVI tabeli StationTask +
 * MenuItemStation + STOLPCA Modifier.prepStationId / PrepStation.isExpo
 * (strogo po tabelah/stolpcih — vzorec ManagerCall). */
export function isKdsStationsStatement(stmt: string): boolean {
  if (/"StationTask"|"MenuItemStation"/.test(stmt)) {
    return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE)\b/i.test(stmt)
  }
  if (/"Modifier"/.test(stmt) && /"prepStationId"/.test(stmt)) return true
  if (/"PrepStation"/.test(stmt) && /"isExpo"/.test(stmt)) return true
  return false
}

/** Issue #24 (v1.114.0): etikete pripravljene hrane — NOVI tabeli PrepLabel + LabelShelfRule. */
export function isPrepLabelsStatement(stmt: string): boolean {
  if (/"PrepLabel"|"LabelShelfRule"/.test(stmt)) {
    return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
  }
  return false
}

/** N-27-3 (v1.197.0): noge doplačil obračuna — NOVA tabela PayrollSurchargeRate
 * (strogo po tabeli — vzorec PayrollPeriod/EInvoiceOutbox). */
export function isPayrollSurchargeRateStatement(stmt: string): boolean {
  if (!/"PayrollSurchargeRate"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

/** Issue #22 (v1.115.0): obračun plač — NOVI tabeli PayrollPeriod + PayrollExport. */
export function isPayrollPeriodsStatement(stmt: string): boolean {
  if (/"PayrollPeriod"|"PayrollExport"/.test(stmt)) {
    return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
  }
  return false
}

/** Issue #8 (v1.116.0): medlokacijski prenosi — NOVI tabeli StockTransfer + StockTransferItem. */
export function isStockTransfersStatement(stmt: string): boolean {
  if (/"StockTransfer"|"StockTransferItem"/.test(stmt)) {
    return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
  }
  return false
}

/** Issue #4 (v1.125.0): odhodni B2B e-računi — NOVA tabela EInvoiceOutbox
 * (strogo po tabeli — vzorec StockTransfer/ManagerCall). */
export function isEInvoiceOutboxStatement(stmt: string): boolean {
  if (!/"EInvoiceOutbox"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

export function isCrmCampaignsStatement(stmt: string): boolean {
  if (!/"GuestConsent"|"Campaign"|"CampaignSend"/.test(stmt)) return false
  return /^(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+INDEX|ALTER\s+TABLE)\b/i.test(stmt)
}

/** Register znanih, dokumentiranih pending driftov. Novi vnosi dodajaj tukaj. */
export const KNOWN_DRIFTS: KnownDrift[] = [
  {
    id: 'issue-13',
    reason:
      'Location.premisesId nullable migracija (Task 44) — produkcija čaka na uporabniški ' +
      'DDL korak: admin ruta /api/admin/migrate-issue13 (docs/RESTAURANTOS-AUDIT.md §13). ' +
      'Produkcija deluje normalno (aditivno-varno).',
    matches: isIssue13Statement,
  },
  {
    id: 'haccp-ops',
    reason:
      'HACCP operativni tok (issue #20, v1.109.0) — 12 novih stolpcev na HaccpEntry ' +
      '(vezava na načrt, strukturirana meritev, cikel odstopanja), 13 novih stolpcev ' +
      'na HaccpPlan (pravila meritev, termin, različica) + NOVA tabela HaccpAction ' +
      '(append-only revizijski dogodki). Produkcija čaka DDL korak: admin ruta ' +
      '/api/admin/migrate-haccp-ops (konzola Enterprise → Shema migracije → en klik). ' +
      'Rute graceful degradirajo (capability probe → 503 s prijaznim sporočilom); ' +
      'obstoječi tokovi (načrti brez novih polj, ad-hoc vnosi, zgodovina) delujejo ' +
      'nespremenjeno. Ko je DDL apliciran, drift izgine in vnos postane mrtva koda. ' +
      'POZOR (issue #2, faza B po DDL): planId je DDL ruta ustvarila kot TEXT NOT ' +
      'NULL DEFAULT \'\', main schema pa ima planId String? @default("") — dokler ' +
      'uskladitev nullability ni aplicirana, diff zahteva ALTER COLUMN "planId" ' +
      'DROP NOT NULL (sprostitev omejitve, brez podatkovne spremembe).',
    matches: isHaccpOpsStatement,
  },
  {
    id: 'haccp-plans',
    reason:
      'HaccpPlan tabela (Task 64, v1.62.0) — produkcija čaka DDL korak: admin ruta ' +
      '/api/admin/migrate-haccp-plans (issue-13 vzorec, requireCentralRole). Rute ' +
      '/api/haccp/plans** graceful degradirajo (capability probe → ddlPending/503); ' +
      'nobena živa funkcionalnost ne uporablja nove tabele. Ko je DDL apliciran, ' +
      'drift izgine in ta vnos postane mrtva koda (brez spremembe workflowa).',
    matches: isHaccpPlanStatement,
  },
  {
    id: 'paylink',
    reason:
      'PayLink tabela (v1.85.0, P0-2 — javna plačilna povezava /pay/<token>) — ' +
      'produkcija čaka DDL korak: admin ruta /api/admin/migrate-paylink (konzola ' +
      'Enterprise → Shema migracije → en klik). Rute /api/orders/[id]/paylink in ' +
      '/api/public/pay/[token] graceful degradirajo (capability probe → 503 s ' +
      'prijaznim sporočilom); PayLink povezave se ZAČNEJO uporabljati šele po DDL ' +
      '(ustvari jih osebje — pred tem ne obstajajo). Ko je DDL apliciran, drift ' +
      'izgine in ta vnos postane mrtva koda.',
    matches: isPayLinkStatement,
  },
  {
    id: 'paylink-split',
    reason:
      'PayLink split po gostih (P1-6, v1.87.0 — N povezav na naročilo) — ' +
      'produkcija čaka DDL korak: admin ruta /api/admin/migrate-paylink-split ' +
      '(konzola Enterprise → Shema migracije → en klik; DROP orderId unique + ' +
      'splitIndex/splitCount/approvalCode stolpci). Do DDL obstoječe PayLink ' +
      'poizvedbe delujejo (stolpci imajo varne defaulte v Prisma klientu — ' +
      'poizvedbe z novimi stolpci vrnejo P2022/P2010 → rute 503 degradirajo ' +
      'prek payLinkReady probe). Ko je DDL apliciran, drift izgine.',
    matches: isPayLinkSplitStatement,
  },
  {
    id: 'paylink-session',
    reason:
      'PayLink kanonična Stripe seja (issue #37, v1.98.0 — sessionId stolpec) — ' +
      'produkcija čaka DDL korak: admin ruta /api/admin/migrate-paylink-session ' +
      '(konzola Enterprise → Shema migracije → en klik). Do DDL javna /pay ruta ' +
      '503 degradira prek payLinkReady probe (prijazno sporočilo, nižje je že ' +
      'paylink/paylink-split predpogoj). Ko je DDL apliciran, drift izgine.',
    matches: isPayLinkSessionStatement,
  },
  {
    id: 'stroski-kategorije',
    reason:
      'Stroški kategorije — stolpec AccountsPayable."category" (Task 66, v1.64.0, ' +
      'DDL draft): admin ruta /api/admin/migrate-stroski-kategorije (konzola ' +
      'Enterprise → en klik). Faza je dvosmerna (glej isStroskiKategorijeStatement): ' +
      'po uporabniškem DDL (stolpec v Neonu, main schema še brez) diff generira ' +
      'DROP COLUMN; po naslednji nalogi (polje v main schema, DDL še ne apliciran) ' +
      'ADD COLUMN. Nobena živa poizvedba ne uporablja stolpca v obeh fazah — ' +
      'produkcija deluje normalno. Ko je oboje usklajeno, drift izgine (mrtva koda).',
    matches: isStroskiKategorijeStatement,
  },
  {
    id: 'issue31-36-mfa',
    reason:
      'MFA utrjevanje (v1.94.0, issue #31–36) — Employee.mfaLastTotpCounter ' +
      '(RFC 6238 §5.2 TOTP replay zaščita) + Employee.mfaRecoveryVersion (CAS ' +
      'atomarna poraba recovery kod): produkcija čaka DDL korak — admin ruta ' +
      '/api/admin/migrate-issue31-36 (konzola Enterprise → Shema migracije → ' +
      'en klik). Do DDL: običajne prijave BREZ MFA so neprizadete (pisajo samo ' +
      'obstoječa polja), MFA poti (enroll/enable/disable, prijava mfaEnabled ' +
      'računov) pa pišejo v nove stolpce → P2022 → 500. DDL aplicirajmo TAKOJ ' +
      'po deployu (idempotentno, IF NOT EXISTS).',
    matches: isIssue31_36MfaStatement,
  },
  {
    id: 'issue38-event-tenant',
    reason:
      'Tenant ključ dogodkovne vrste (v1.100.0, issue #38 P1) — ' +
      'EventLog."locationId" (kanonična lokacija dogodka, strežniško izpeljana ' +
      'iz preverjene entitete; NULL = legacy/sistemski dogodek, viden samo ' +
      'bootstrap operatorju) + index EventLog_locationId_idx: produkcija čaka ' +
      'DDL korak — admin ruta /api/admin/migrate-issue38 (konzola Enterprise → ' +
      'Shema migracije → en klik). Do DDL: /api/events GET/.dispatch in ' +
      'publishEvent vračajo P2022 → dogodkovna vrsta miruje (evidenca se ' +
      'zapiše šele po DDL — poslovni tokovi niso prizadeti, publishEvent ' +
      'nikoli ne meče). DDL aplicirajmo TAKOJ po deployu (idempotentno, ' +
      'IF NOT EXISTS).',
    matches: isIssue38EventTenantStatement,
  },
  {
    id: 'ap-tolerance',
    reason:
      'Tolerance tristranskega ujemanja (v1.103.0, issue #18 P1) — 4 stolpci na ' +
      'RestaurantSettings (apMatchQtyTolerancePct / apMatchPriceTolerancePct / ' +
      'apMatchVatTolerancePct / apMatchAmountToleranceCents): produkcija čaka DDL ' +
      'korak — admin ruta /api/admin/migrate-ap-tolerance (konzola Enterprise → ' +
      'Shema migracije → en klik). Dvosmerna faza (kot stroski-kategorije): po ' +
      'DDL in pred uskladitvijo main sheme diff generira DROP COLUMN ×4. Do DDL ' +
      'match motor teče na STROGIH privzetkih (0 % / 2 c — graceful), pisanje ' +
      'toleranc prek PUT /api/settings vrne 503. Nobena tipizirana poizvedba ' +
      'stolpcev ne uporablja (raw SQL + probe, vzorec stroski-kategorije).',
    matches: isApToleranceStatement,
  },
  {
    id: 'allergen-truth',
    reason:
      'Alergeni — en vir resnice (v1.104.0, issue #7 P1) — 10 stolpcev na 3 obstoječih ' +
      'tabelah (InventoryItem.allergens/allergensCrossContact/allergensConfirmedAt/ById; ' +
      'MenuItem.allergensOverride/allergensConfirmedAt/ById/allergenReviewFlag/Reason; ' +
      'OrderItem.allergenSnapshot/allergenWarning): produkcija čaka DDL korak — admin ruta ' +
      '/api/admin/migrate-allergen-truth (konzola Enterprise → Shema migracije → en klik). ' +
      'Dvosmerna faza (kot ap-tolerance): po DDL in pred uskladitvijo shem diff generira ' +
      'DROP COLUMN. POZOR — vroče tabele (MenuItem/InventoryItem/OrderItem): v oknu ' +
      'deploy→DDL tipizirane poizvedbe (naročila/KDS/meni) vrnejo P2022 (client pozna ' +
      'stolpce, baza jih še ne) — DDL apliciramo TAKOJ po deployu (vzorec issue31-36/38), ' +
      'produkcija nima živega prometa v tem oknu. POZOR (issue #2, faza B po DDL): ' +
      'allergensConfirmedAt je DDL ruta ustvarila kot goli TIMESTAMP (µs), prisma ' +
      'DateTime pa generira TIMESTAMP(3) — dokler normalizacija ni aplicirana, diff ' +
      'zahteva SET DATA TYPE TIMESTAMP(3) (varna prirezava µs→ms, aplikacija piše ms).',
    matches: isAllergenTruthStatement,
  },
  {
    id: 'lot-governance',
    reason:
      'Lot governance (v1.105.0, issue #15 P1) — 9 stolpcev na InventoryBatch ' +
      '(alertDate/removalDate/holdReason/holdAt/holdById/holdRef/releaseAt/releaseById/' +
      'releaseNote): produkcija čaka DDL korak — admin ruta /api/admin/migrate-lot-governance ' +
      "(konzola Enterprise → Shema migracije → en klik). DDL vključuje tudi podatkovno " +
      "normalizacijo legacy status='active' → 'ACTIVE' (receive pot ≤ v1.104: SQLite " +
      'case-sensitive primerjava jih je izpustila iz FEFO). Dvosmerna faza (kot ' +
      'allergen-truth): po DDL in pred uskladitvijo shem diff generira DROP COLUMN ×9. ' +
      'Vroča pot (FEFO ob plačilu) je zaščitena s capability-probe (lotGovernanceColumnsReady) ' +
      '— pre-DDL teče legacy where/select, prodaja ne pada na šemo. POZOR (issue #2, ' +
      'faza B po DDL): 4 časovni stolpci (alertDate/removalDate/holdAt/releaseAt) so ' +
      'DDL ruta ustvarila kot goli TIMESTAMP (µs), prisma DateTime generira ' +
      'TIMESTAMP(3) — dokler normalizacija ni aplicirana, diff zahteva SET DATA TYPE ' +
      'TIMESTAMP(3) (varna prirezava µs→ms, aplikacija piše ms).',
    matches: isLotGovernanceStatement,
  },
  {
    id: 'exception-policy',
    reason:
      'Politika finančnih izjem (v1.107.0, issue #19 P1/P2) — 9 stolpcev na ' +
      'RestaurantSettings (excDiscountApprovalPct/AmountCents + zneskovni pragovi ' +
      'void/storno/cancel + obveznost razloga discount/cancel/storno/void): produkcija ' +
      'čaka DDL korak — admin ruta /api/admin/migrate-exception-policy (konzola ' +
      'Enterprise → Shema migracije → en klik). Dvosmerna faza (kot ap-tolerance): po ' +
      'DDL in pred uskladitvijo main sheme diff generira DROP COLUMN ×9. Do DDL rute ' +
      'tečejo na varnih privzetkih (graceful — 15 % prag + razlog za preklic/storno/void), ' +
      'pisanje politike prek PUT /api/settings vrne 503. Nobena tipizirana poizvedba ' +
      'stolpcev ne uporablja (raw SQL + probe, vzorec ap-tolerance).',
    matches: isExceptionPolicyStatement,
  },
  {
    id: 'exception-reasons',
    reason:
      'Katalog razlogov izjem (v1.107.0, issue #19 P1/P2) — 2 stolpca na obstoječem ' +
      'VoidReason (kind: void|discount|cancel|storno|any + requireComment): produkcija ' +
      'čaka DDL korak — admin ruta /api/admin/migrate-exception-reasons (konzola ' +
      'Enterprise → Shema migracije → en klik). Dvosmerna faza (kot ap-tolerance). ' +
      'Do DDL: katalog razlogov je uporabljiv SAMO za void (dosedanja semantika — ' +
      'findUnique pot), druge vrste izjem uporabijo prosto besedilo. Po DDL ' +
      'validateExceptionReason preklopi na kind-aware poizvedbo.',
    matches: isExceptionReasonsStatement,
  },
  {
    id: 'cash-movements',
    reason:
      'CashMovement tabela + RestaurantSettings politika (cashVarianceThresholdCents/cashBlindCount) ' +
      '+ ZReport povzetek (cashPaidIn/cashPaidOut/cashGuestRefund) — issue #16 (v1.108.0), ' +
      'produkcija čaka DDL korak: admin ruta /api/admin/migrate-cash-movements (konzola ' +
      'Enterprise → Shema migracije → en klik). Rute /api/shifts/movements** in ' +
      '/api/shifts/no-sale-reasons graceful degradirajo (503/ddlPending); zaključek izmene ' +
      'deluje nespremenjeno (premiki se ne upoštevajo do DDL). Ko je DDL apliciran, drift ' +
      'izgine in vnos postane mrtva koda.',
    matches: isCashMovementStatement,
  },
  {
    id: 'reservation-widget',
    reason:
      'Javni rezervacijski widget (v1.110.0, issue #13 P1/P2) — NOVA tabela ' +
      'ReservationWidget (ena vrstica na lokacijo: skrivnostni token javne povezave ' +
      '/r/<token>, vklop, politika terminov; locationId skalar brez FK — EventLog vzorec): ' +
      'produkcija čaka DDL korak — admin ruta /api/admin/migrate-reservation-widget ' +
      '(konzola Enterprise → Shema migracije → en klik). Do DDL javni ruti widgeta ' +
      '(/api/public/reservations, /r/<token>) odgovarjata 404 (graceful — povezava se ' +
      'začne uporabljati šele po DDL, ustvari jo osebje prek nastavitev); interni ' +
      'rezervacijski tok POS se ne dotakne. Ko je DDL apliciran, drift izgine in ' +
      'vnos postane mrtva koda.',
    matches: isReservationWidgetStatement,
  },
  {
    id: 'manager-call',
    reason:
      'Klic vodje iz POS-a (v1.111.0, issue #21 P1/P2) — NOVA tabela ManagerCall ' +
      '(življenjski cikel zahtev za pomoč: OPEN → ESCALATED (krogi, max 3) / ' +
      'ACKNOWLEDGED → IN_PROGRESS → RESOLVED / CANCELLED; skalarne vezave brez FK, ' +
      'snapshot imen, dostavna evidenca, idempotencyKey — EventLog/ReservationWidget ' +
      'vzorec): produkcija čaka DDL korak — admin ruta /api/admin/migrate-manager-call ' +
      '(konzola Enterprise → Shema migracije → en klik). Do DDL rute /api/manager-call** ' +
      'graceful degradirajo (503/ddlPending — POS tok se ne dotakne). Ko je DDL ' +
      'apliciran, drift izgine in vnos postane mrtva koda.',
    matches: isManagerCallStatement,
  },
  {
    id: 'kds-stations',
    reason:
      'KDS poimenovane postaje (v1.112.0, issue #14 P1/P2) — NOVI tabeli ' +
      'StationTask (postavka × postaja: usmerjanje ob FIRE-u, posnetki imen, ' +
      'zaporedje korakov, statusi waiting/pending/preparing/ready/done) in ' +
      'MenuItemStation (dodatne postaje artikla M:N) + STOLPCA ' +
      'Modifier.prepStationId (usmeritev opcije na drugo postajo) in ' +
      'PrepStation.isExpo (izdajna postaja) — skalarne vezave brez FK ' +
      '(EventLog/ManagerCall vzorec): produkcija čaka DDL korak — admin ruta ' +
      '/api/admin/migrate-kds-stations (konzola Enterprise → Shema migracije → ' +
      'en klik). Do DDL /api/kitchen additive polja (stations/tasks/' +
      'stationStats) in usmerjanje v fire ruti se tiho izpraznijo/preskočijo ' +
      '(graceful — queue + stationTargets + POS/KDS tok se ne dotaknejo). Ko je ' +
      'DDL apliciran, drift izgine in vnos postane mrtva koda.',
    matches: isKdsStationsStatement,
  },
  {
    id: 'prep-labels',
    reason:
      'Etikete za pripravljeno hrano in odprte serije (v1.114.0, issue #24 P2) — ' +
      'NOVI tabeli PrepLabel (zamrznjen posnetek etikete ob izdaji: naziv, ' +
      'količina, serija, območje, priprava/odprtje, ROK iz potrjenega pravila, ' +
      'alergeni, odgovorna oseba, QR token skrivnost, printCount) in ' +
      'LabelShelfRule (potrjeno pravilo roka po pripravi/odprtju po artiklu, ' +
      'revizijska sled) — skalarne vezave brez FK (StationTask/PrintJob ' +
      'vzorec): produkcija čaka DDL korak — admin ruta /api/admin/migrate-prep-labels ' +
      '(konzola Enterprise → Shema migracije → en klik). Do DDL /api/labels* ' +
      'rute vračajo 503 (graceful — serije/priprava/tisk tokovi se ne dotaknejo). ' +
      'Ko je DDL apliciran, drift izgine in vnos postane mrtva koda.',
    matches: isPrepLabelsStatement,
  },
  {
    id: 'payroll-periods',
    reason:
      'Obračun plač pripravljeni podatki (v1.115.0, issue #22 P2) — NOVI tabeli ' +
      'PayrollPeriod (agregatni zaklep nad obstoječo evidenco časa: obdobje po ' +
      'lokaciji s časovnim pasom, status draft/closed, zaklep/ponovno odprtje s ' +
      'razlogom, števci vnosi/potrjene ure/izjeme, centni zneski bruto plače in ' +
      'napitnin) in PayrollExport (zabeležka vsakega izvoza: zaporedna številka, ' +
      'format, contentHash + rowDigest brez PII vsebine) + indeksi — skalarne ' +
      'vezave brez FK (PrepLabel/PrintJob vzorec): pred aplikacijo na produkcijo ' +
      'je drift pričakovan — DDL korak: admin ruta /api/admin/migrate-payroll-periods ' +
      '(konzola Enterprise → Shema migracije → en klik). Do DDL /api/payroll* ' +
      'rute vračajo 503 (graceful — timeclock/tips/urnik tokovi se ne dotaknejo). ' +
      'Ko je DDL apliciran, drift izgine in vnos postane mrtva koda.',
    matches: isPayrollPeriodsStatement,
  },
  {
    id: 'stock-transfers',
    reason:
      'Medlokacijski prenosi zalog (v1.116.0, issue #8 P2) — NOVI tabeli ' +
      'StockTransfer (glava: številka TRF-dan-zaporedna, izvorna/ciljna ' +
      'lokacija kot skalar, status DRAFT/DISPATCHED/RECEIVED/PARTIAL/CANCELLED, ' +
      'idempotencyKey @@unique(from+key), odprem/prevzem/preklic sled) in ' +
      'StockTransferItem (snapshot imena/enote, količine requested/dispatched/' +
      'received/damaged, izvorna serija, razrešen ciljni artikel; transferId ' +
      'FK Cascade) + indeksi — skalarne vezave brez FK na Location/' +
      'InventoryItem (PrepLabel/PayrollPeriod vzorec). Do DDL ' +
      '/api/admin/migrate-stock-transfers /api/transfers* rute vračajo 503 ' +
      '(graceful degradacija). Ko je DDL apliciran ' +
      '(Enterprise → Shema migracije), drift izgine in vnos postane mrtva koda.',
    matches: isStockTransfersStatement,
  },
  {
    id: 'einvoice-outbox',
    reason:
      'Odhodni B2B e-računi SI/HR (v1.125.0, issue #4 P1) — NOVA tabela ' +
      'EInvoiceOutbox (kanonični zapis izmenjave: AR vezava SetNull, država/profil ' +
      '(eSLOG 2.0 SI / UBL 2.1 HR), vrsta dokumenta račun/dobropis, valuta, ' +
      'zneski, xmlPayload + xmlHash dokaz poslane vsebine, idempotencyKey ' +
      '@unique, statusni življenjski cikel draft→validated→queued→sent→' +
      'delivered→accepted/rejected (+ failed/needs_review retry poti), ' +
      'externalRef, processedEvents webhook dedup) — AR in Location dobita SAMO ' +
      'prisma back-relacijo (0 DDL na obstoječih tabelah): produkcija čaka DDL ' +
      'korak — admin ruta /api/admin/migrate-einvoice-outbox (konzola ' +
      'Enterprise → Shema migracije → en klik). Do DDL /api/einvoices* rute ' +
      '503 degradirajo (graceful — POS/fiskalizacija/nabava tokovi se ne ' +
      'dotaknejo); izvoz reports/export bloka receivablesByStatus/' +
      'einvoicesByStatus se tiho izprazni (isMissingSchemaError). Ko je DDL ' +
      'apliciran, drift izgine in vnos postane mrtva koda.',
    matches: isEInvoiceOutboxStatement,
  },
  {
    id: 'crm-campaigns',
    reason:
      'CRM gostov in kampanje (v1.126.0, issue #11 P2) — NOVE tabele ' +
      'GuestConsent (append-only sled marketing soglasja — kanal email/sms ' +
      'LOČENO, vir, različica besedila, dokaz izrecnega dejanja; GDPR člen 7), ' +
      'Campaign (življenjski cikel osnutek→odobritev→načrt→pošiljanje→zaključek, ' +
      'števci izključno iz vrstic) in CampaignSend (idempotenca ' +
      '@@unique(campaignId+guestId), enkratni žeton za javno enklik odjavo, ' +
      'statusi SAMO z dokazom — SMTP sprejem = sent_to_provider, NE dostava) — ' +
      'skalarne vezave brez FK (EventLog vzorec; 0 DDL na obstoječih tabelah). ' +
      'Produkcija čaka DDL korak: admin ruta /api/admin/migrate-crm-campaigns ' +
      '(konzola Enterprise → Shema migracije → en klik). Do DDL /api/crm* rute ' +
      'vračajo 503/graceful napako (gostje, zvestoba, rezervacije tokovi se ne ' +
      'dotaknejo). Ko je DDL apliciran, drift izgine in vnos postane mrtva koda.',
    matches: isCrmCampaignsStatement,
  },
  {
    id: 'settings-pending-merged',
    reason:
      'RestaurantSettings pending stolpci — ZDRUŽENI stavek več DDL valov (issue #2, ' +
      'CI run 38964400094): prisma migrate diff vse odvečne/manjkajoče stolpce ENE ' +
      'tabele združi v EN ALTER TABLE stavek, ne glede na funkcijo izvora. ' +
      'ap-tolerance (v1.103.0, issue #18 — 4 stolpci), exception-policy (v1.107.0, ' +
      'issue #19 — 9 stolpcev) in cash-movements (v1.108.0, issue #16 — 2 stolpca) ' +
      'imajo VSAK svoj fazni vnos (admin rute /api/admin/migrate-ap-tolerance, ' +
      '/api/admin/migrate-exception-policy, /api/admin/migrate-cash-movements — ' +
      'konzola Enterprise → Shema migracije → en klik); ko produkcija aplicira VEČ teh DDL korakov pred ' +
      'uskladitvijo main sheme (polja so že v prisma/schema.sqlite.prisma, v ' +
      'prisma/schema.prisma jih prevzame naslednja schema naloga), diff generira ' +
      'ENEGA združenega DROP COLUMN ×15, ki ga posamični matcher ne pokriva. ' +
      'Matcher STROG: tabela RestaurantSettings, vsaka klavzula ADD/DROP COLUMN ' +
      'izključno iz množice 15 dokumentiranih stolpcev — vsak drug (nov, ' +
      'nedokumentiran) stolpec ostane hard fail. Ko main schema prevzame polja, ' +
      'drift izgine in vnos postane mrtva koda (faza B→C, vzorec stroski-kategorije).',
    matches: isRestaurantSettingsPendingMergedStatement,
  },
  {
    id: 'payroll-surcharge-rates',
    reason:
      'Noge doplačil obračuna (N-27-3, v1.197.0) — NOVA tabela PayrollSurchargeRate ' +
      '(ena vrstica na lokacijo; odstotki noč/nedelja/praznik/nadure Decimal(5,2) — ' +
      'UPORABNIŠKI vhod po kolektivni pogodbi lastnika, zakonitost potrdi biro; ' +
      'sistem izračuna ZNESKE iz minut obračuna in posnetkov urnih postavk, ' +
      'izvoz shema payroll-export/3 nosi zneske ob minutah) — skalarne vezave brez ' +
      'FK (PrepLabel/PayrollPeriod vzorec): pred aplikacijo na produkcijo je drift ' +
      'pričakovan — DDL korak: admin ruta /api/admin/migrate-payroll-surcharge-rates ' +
      '(konzola Enterprise → Shema migracije → en klik). Do DDL /api/payroll/' +
      'surcharge-rates → 503, detail/izvoz degradirata graceful (minute brez ' +
      'zneskov — nič ne izmišljujemo). Ko je DDL apliciran, drift izgine in vnos ' +
      'postane mrtva koda.',
    matches: isPayrollSurchargeRateStatement,
  },
]

export interface DriftClassification {
  known: { id: string; reason: string; statements: string[] }[]
  unexpected: string[]
}

/** Razvrsti drift SQL na znane (allowlist) in nepričakovane (blokator) stavke. */
export function classifyDrift(
  sql: string,
  known: KnownDrift[] = KNOWN_DRIFTS,
): DriftClassification {
  const result: DriftClassification = { known: [], unexpected: [] }
  for (const stmt of parseStatements(sql)) {
    const hit = known.find((k) => k.matches(stmt))
    if (hit) {
      let bucket = result.known.find((k) => k.id === hit.id)
      if (!bucket) {
        bucket = { id: hit.id, reason: hit.reason, statements: [] }
        result.known.push(bucket)
      }
      bucket.statements.push(stmt)
    } else {
      result.unexpected.push(stmt)
    }
  }
  return result
}

export interface DiffResult {
  status: number
  stdout: string
  stderr: string
}

/** Zaženi prisma migrate diff --exit-code in vrni { status, stdout, stderr }. */
export function runDiff(fromUrl: string, schemaPath: string): DiffResult {
  try {
    const stdout = execFileSync(
      'bunx',
      [
        'prisma',
        'migrate',
        'diff',
        '--from-url',
        fromUrl,
        '--to-schema-datamodel',
        schemaPath,
        '--script',
        '--exit-code',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
    )
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return {
      status: typeof err.status === 'number' ? err.status : -1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }
  }
}

function summaryAppend(md: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path) {
    try {
      appendFileSync(path, md)
    } catch {
      /* summary je nekritičen */
    }
  }
}

function annotation(level: 'warning' | 'error', message: string): void {
  // GitHub workflow command — v lokalnem okolju je neškodljiv izpis
  console.log(`::${level}::${message}`)
}

async function main(): Promise<number> {
  const [fromUrl, schemaPath] = process.argv.slice(2)
  if (!fromUrl || !schemaPath) {
    console.error('uporaba: bun scripts/drift-check.ts <from-url> <schema.prisma>')
    return 2
  }

  const diff = runDiff(fromUrl, schemaPath)

  // 1) brez drifta
  if (diff.status === 0) {
    console.log('✅ No drift: production schema matches prisma datamodel')
    summaryAppend('### ✅ Schema drift check: no drift (production copy matches datamodel)\n')
    return 0
  }

  // 2) infra napaka (npr. P1001 unreachable) — LOČENO od drifta, vedno blokator
  if (diff.status === 1) {
    const msg = `drift check infrastructure failure (prisma exit 1): ${diff.stderr.slice(0, 400).trim()}`
    console.error(`❌ ${msg}`)
    summaryAppend(`### 🔴 Schema drift check: INFRA NAPAKA (ne drift)\n\n\`\`\`\n${diff.stderr.slice(0, 800)}\n\`\`\`\n`)
    annotation('error', msg)
    return 1
  }

  // 3) drift obstaja (prisma exit 2) → klasificiraj
  if (diff.status !== 2) {
    const msg = `drift check: nepričakovan prisma exit ${diff.status}`
    console.error(`❌ ${msg}: ${diff.stderr.slice(0, 300)}`)
    summaryAppend(`### 🔴 Schema drift check: ${msg}\n\n\`\`\`\n${diff.stderr.slice(0, 800)}\n\`\`\`\n`)
    annotation('error', msg)
    return 1
  }

  const cls = classifyDrift(diff.stdout)

  if (cls.unexpected.length === 0 && cls.known.length === 0) {
    // exit 2, a nič parsanega — brani se: tretjaj kot nepričakovan drift
    const raw = diff.stdout.trim()
    const msg = 'prisma je javil drift, a izhoda ni bilo mogoče parsati'
    console.error(`❌ ${msg}. Raw:\n${raw.slice(0, 800)}`)
    summaryAppend(`### 🔴 Schema drift check: ${msg}\n\n\`\`\`\n${raw.slice(0, 1200)}\n\`\`\`\n`)
    annotation('error', msg)
    return 1
  }

  let md = ''
  for (const k of cls.known) {
    const lines = [
      `### ⚠️ Znan pending drift: ${k.id} (dovoljen — NI blokator)`,
      '',
      k.reason,
      '',
      '```sql',
      ...k.statements.slice(0, 20),
      '```',
      '',
    ]
    md += lines.join('\n')
    console.log(lines.join('\n'))
    annotation('warning', `Schema drift (KNOWN): ${k.id} — ${k.statements.length} stavek/ov, nepričakovanih: 0`)
  }

  if (cls.unexpected.length > 0) {
    const lines = [
      '### 🔴 Schema drift: NEPRIČAKOVAN drift — pushaj ne (produkcija tvega)',
      '',
      '```sql',
      ...cls.unexpected.slice(0, 40),
      '```',
      '',
    ]
    md += lines.join('\n')
    console.error(lines.join('\n'))
    annotation('error', `NEPRIČAKOVAN schema drift: ${cls.unexpected.length} stavek/ov`)
  }

  summaryAppend(md)

  if (cls.unexpected.length > 0) return 1

  console.log(
    `✅ Drift check PASSED: samo znani pending drift(i) (${cls.known.map((k) => k.id).join(', ')}) — nepričakovanih 0`,
  )
  return 0
}

// bun test importa module brez zagona main
if (import.meta.main) {
  process.exit(await main())
}
