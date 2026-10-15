/**
 * Issue #19 (P1/P2, v1.107.0) — razlog + odobritev finančnih izjem.
 *
 * Dva čista mehanizma, skupaj za enoto »kaj je bilo spremenjeno, zakaj, kdo
 * je izvedel in kdo je odobril«:
 *
 * 1) RAZLOG (validateExceptionReason) — katalog VoidReason (POONOVNO UPORABLJEN
 *    obstoječi lokacijsko-scoped model, issue: »ne uvajaj vzporednega sistema
 *    razlogov«), razširjen z DDL stolpcema:
 *      "kind"           VARCHAR(20) DEFAULT 'void'  — void|discount|cancel|storno|any
 *      "requireComment" BOOLEAN     DEFAULT false
 *    Vrsta izjeme → katalog razlogov (kind × 'any'):
 *      void → void|any, discount/discount_remove → discount|any,
 *      cancel → cancel|any, storno → storno|any
 *    Posnetek razloga (reasonName ob dejanju) se zapiše v audit — kasnejša
 *    preimenovanitev kataloga NE spremeni zgodovine.
 *    »Drugo« (ali requireComment vrstica) zahteva obvezen komentar.
 *    Brez kataloga: prosto besedilo 3–200 znakov.
 *    DDL-gated: brez stolpca "kind" so katalog razlogi veljavni SAMO za void
 *    (dosedanja semantika); druge vrste uporabijo prosto besedilo.
 *
 * 2) ODOBRITEV (resolveExceptionApproval) — ločena identiteta odobritelja:
 *    - vodstvena izvajalska vloga (MANAGER/ADMIN/OWNER/…) → odobritev 'role'
 *      (ohranjena dosedanja politika 15-% pravila);
 *    - NE-vodstveni izvajalec → odobritev 'pin': e-pošta + PIN DRUGE
 *      pooblaščene osebe (obstoječa avtentikacijska disciplina — timing-safe
 *      pinLookup/pin primerjava, aktivna vrstica, vodstvena vloga, lokacijski
 *      obseg). Izvajalec in odobritelj sta ZAVEZANO različni osebi — vnos
 *      role=MANAGER na istem klicu NE šteje kot druga oseba.
 *    Odobritev je veljavna SAMO za ta klic (točen znesek/postavko/vrsto
 *    akcije — strežnik vsakokrat izračuna na novo); vsaka sprememba zneska
 *    ali postavk znova sproži prag in zahteva novo potrditev.
 *    PIN/geslo se NIKOLI ne zapiše v audit (issue: »Audit ne sme vsebovati
 *    PIN-a, gesla, auth tokena«) — samo approverId/approverName/metoda.
 */
import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'
import { timingSafeEqualStr, employeePinFields } from './auth'
import type { AuthPayload } from './auth'

/* ───────── vrste izjem in katalog ───────── */

export type ExceptionKind = 'void' | 'discount' | 'discount_remove' | 'cancel' | 'storno'

/** Katalog kind-i, ki jih vrsta izjeme sprejema (VoidReason.kind × 'any'). */
const CATALOG_KINDS: Record<ExceptionKind, string[]> = {
  void: ['void', 'any'],
  discount: ['discount', 'any'],
  discount_remove: ['discount', 'any'],
  cancel: ['cancel', 'any'],
  storno: ['storno', 'any'],
}

/** Vodstvene vloge (ista disciplina kot dosedanje 15-% pravilo v discount ruti). */
export const MANAGERIAL_ROLES = [
  'MANAGER', 'ADMIN', 'OWNER', 'GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER',
] as const

export function isManagerialRole(role?: string | null): boolean {
  return MANAGERIAL_ROLES.includes(String(role ?? '').toUpperCase() as (typeof MANAGERIAL_ROLES)[number])
}

/** Centralne vloge imajo širši lokacijski dostop (ista semantika kot guardResource). */
function isCentralRoleForApproval(role: string): boolean {
  const r = String(role).toUpperCase()
  return r === 'ADMIN' || r === 'OWNER'
}

/* ───────── DDL probe: VoidReason.kind / requireComment ───────── */

const PROBE_TTL_MS = 60_000
let kindColumnCache: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL / v testih). Z vrednostjo jo vsili. */
export function resetReasonKindProbe(value?: boolean): void {
  kindColumnCache = value === undefined ? null : { value, at: Date.now() }
}

/** Ali VoidReason nosi stolpca kind/requireComment? (memoizirano, 60 s) */
export async function reasonKindColumnAvailable(): Promise<boolean> {
  if (kindColumnCache && Date.now() - kindColumnCache.at < PROBE_TTL_MS) return kindColumnCache.value
  try {
    await db.$queryRawUnsafe(`SELECT "kind" FROM "VoidReason" LIMIT 1`)
    kindColumnCache = { value: true, at: Date.now() }
  } catch (e) {
    kindColumnCache = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return kindColumnCache.value
}

/* ───────── 1) razlog ───────── */

export interface ReasonEvidence {
  reasonId: string | null
  /** POSNETEK imena razloga ob dejanju (zgodovinska celovitost). */
  reasonName: string | null
  /** Prosto besedilo razloga (brez kataloga). */
  reasonText: string | null
  /** Obvezen komentar pri »drugo«/requireComment. */
  comment: string | null
}

export type ReasonResult =
  | { ok: true; reason: ReasonEvidence }
  | { ok: false; status: number; message: string }

const REASON_TEXT_MIN = 3
const REASON_TEXT_MAX = 200
const COMMENT_MIN = 3
const COMMENT_MAX = 500

/** »Drugo« katalog razlog vedno zahteva komentar (issue P1) — ime je lahko
 *  tudi s prefiksom (npr. »i19-Drugo«) ali v kontekstu (»drugo — opiši«). */
function isOtherReasonName(name: string): boolean {
  return /(^|[^a-zčšž])(drugo|other|ostalo)([^a-zčšž]|$)/i.test(name.trim()) || /^(drugo|other|ostalo)$/i.test(name.trim())
}

/**
 * Validira razlog izjeme za LOKACIJO dejanja (ne uporabnika).
 * Telo: { reasonId } (katalog) ALI { reason } (prosto besedilo 3–200) + morebitni
 * { comment }. Vrne posnetek za audit.
 */
export async function validateExceptionReason(
  kind: ExceptionKind,
  actionLocationId: string,
  body: { reasonId?: unknown; reason?: unknown; comment?: unknown } | null | undefined
): Promise<ReasonResult> {
  const reasonId = typeof body?.reasonId === 'string' ? body.reasonId.trim() : ''
  const reasonText = typeof body?.reason === 'string' ? body.reason.trim().slice(0, REASON_TEXT_MAX) : ''
  const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, COMMENT_MAX) : ''

  if (reasonId) {
    const kindsReady = await reasonKindColumnAvailable()
    let row: { id: string; name: string; isActive: boolean | number; locationId: string; kind: string; requireComment: boolean | number } | null = null
    if (kindsReady) {
      // OZNAČENA PREDLOGA ($queryRaw) — parametrizirana za OBA dialekta
      // (SQLite ? / Postgres $1) brez niz interpolacije ID-ja v SQL.
      const rows = await db.$queryRaw<{ id: string; name: string; isActive: number; locationId: string; kind: string; requireComment: number }[]>`
        SELECT "id", "name", "isActive", "locationId", "kind", "requireComment" FROM "VoidReason" WHERE "id" = ${reasonId} LIMIT 1`
      row = rows?.[0]
        ? {
            id: rows[0].id,
            name: rows[0].name,
            isActive: !!rows[0].isActive,
            locationId: rows[0].locationId,
            kind: rows[0].kind || 'void',
            requireComment: !!rows[0].requireComment,
          }
        : null
    } else {
      const base = await db.voidReason.findUnique({ where: { id: reasonId } })
      row = base
        ? { id: base.id, name: base.name, isActive: !!base.isActive, locationId: base.locationId, kind: 'void', requireComment: false }
        : null
    }
    if (!row || !row.isActive) {
      return { ok: false, status: 400, message: 'Razlog izjeme ne obstaja ali ni aktiven.' }
    }
    // Lokacijska veljavnost: razlog MORA pripadati lokaciji dejanja (tuji katalog zavrnjen)
    if (row.locationId !== actionLocationId) {
      return { ok: false, status: 400, message: 'Razlog izjeme ni veljaven za to lokacijo.' }
    }
    // Vrsta: brez DDL so katalog razlogi veljavni SAMO za void (dosedanja semantika)
    if (kindsReady) {
      const allowed = CATALOG_KINDS[kind]
      if (!allowed.includes(row.kind)) {
        return { ok: false, status: 400, message: `Razlog ni namenjen za to vrsto izjeme (${kind}).` }
      }
    } else if (kind !== 'void') {
      return { ok: false, status: 400, message: 'Katalog razlogov čaka DDL korak — vpišite razlog kot besedilo.' }
    }
    if ((row.requireComment || isOtherReasonName(row.name)) && comment.length < COMMENT_MIN) {
      return { ok: false, status: 400, message: 'Za ta razlog je obvezen komentar (vsaj 3 znake).' }
    }
    return {
      ok: true,
      reason: {
        reasonId: row.id,
        reasonName: row.name, // posnetek ob dejanju
        reasonText: null,
        comment: comment.length > 0 ? comment : null,
      },
    }
  }

  if (reasonText.length >= REASON_TEXT_MIN) {
    return {
      ok: true,
      reason: { reasonId: null, reasonName: null, reasonText, comment: comment.length > 0 ? comment : null },
    }
  }
  return {
    ok: false,
    status: 400,
    message: 'Razlog izjeme je obvezen (izberi iz seznama ali vpiši vsaj 3 znake).',
  }
}

/* ───────── 2) odobritev ───────── */

export interface ApprovalEvidence {
  method: 'role' | 'pin'
  approverId: string
  approverName: string
}

export type ApprovalResult =
  | { ok: true; approval: ApprovalEvidence }
  | { ok: false; status: number; message: string }

export interface ApproverInput {
  approverEmail?: unknown
  approverPin?: unknown
}

/**
 * Odobritev izjeme. Klicalc je ZAZEDE izračunal, da dejanje presega prag
 * (needsApproval = true). Pravila:
 *  - vodstveni izvajalec → odobritev 'role' (ista oseba, zabeležena kot
 *    approver z metodo role — ohranjena dosedanja politika);
 *  - sicer → obvezna poverilnica DRUGE pooblaščene osebe (e-pošta + PIN):
 *    aktivna vrstica, veljaven PIN (timing-safe), vodstvena vloga, lokacijski
 *    obseg dejanja, in RAZLIČNA identiteta od izvajalca.
 * Vrne dokaz za audit (brez PIN-a!). PIN NIKOLI ne sme priti v audit/details.
 */
export async function resolveExceptionApproval(
  actor: AuthPayload,
  actionLocationId: string,
  input: ApproverInput | null | undefined
): Promise<ApprovalResult> {
  if (isManagerialRole(actor.role)) {
    return { ok: true, approval: { method: 'role', approverId: actor.sub, approverName: actor.name } }
  }

  const emailRaw = typeof input?.approverEmail === 'string' ? input.approverEmail.trim() : ''
  const email = emailRaw.toLowerCase()
  const pin = typeof input?.approverPin === 'string' ? input.approverPin.trim() : ''
  if (!email || !pin) {
    return {
      ok: false,
      status: 403,
      message: 'Dejanje presega prag in zahteva odobritev vodje — vnesite e-pošto in PIN odobritelja.',
    }
  }

  // prijava normalizira e-pošto v male črke (isti konvention); zaradi
  // robustnosti poskusimo še izvirni zapis (mešane velike črke v starejših vrsticah)
  const employee =
    (await db.employee.findUnique({ where: { email } })) ??
    (emailRaw !== email ? await db.employee.findUnique({ where: { email: emailRaw } }) : null)
  if (!employee || employee.status !== 'active') {
    return { ok: false, status: 403, message: 'Odobritelj ne obstaja ali ni aktiven.' }
  }

  // PIN (ista disciplina kot prijava): pinLookup primerjava, fallback pin
  const expected = employeePinFields(pin, employee.email)
  const pinOk =
    (employee.pinLookup && timingSafeEqualStr(employee.pinLookup.toLowerCase(), expected.pinLookup.toLowerCase())) ||
    (employee.pin && timingSafeEqualStr(employee.pin, expected.pin))
  if (!pinOk) {
    return { ok: false, status: 403, message: 'Odobritev zavrnjena — napačna poverilnica odobritelja.' }
  }

  // LOČENA identiteta: odobritelj NE sme biti izvajalec (issue P1)
  if (employee.id === actor.sub) {
    return {
      ok: false,
      status: 403,
      message: 'Odobritelj mora biti druga oseba kot izvajalec — vodstvena izvajalska vloga že šteje kot odobritev.',
    }
  }

  // Vloga odobritelja: vodstvena (Toast vzorec »manager passcode«)
  if (!isManagerialRole(employee.role)) {
    return { ok: false, status: 403, message: 'Odobritelj nima vodstvene vloge.' }
  }

  // Lokacijski obseg: ne-centralni odobritelj MORA pripadati lokaciji dejanja
  // (centralne vloge ADMIN/OWNER imajo širši dostop — ista semantika guardResource)
  if (!isCentralRoleForApproval(employee.role) && employee.locationId !== actionLocationId) {
    return { ok: false, status: 403, message: 'Odobritelj ni pooblaščen za to lokacijo.' }
  }

  return { ok: true, approval: { method: 'pin', approverId: employee.id, approverName: employee.name } }
}

/**
 * Audit polja odobritve (enoten zapis v details) — NIKOLI ne vsebuje poverilnic.
 *approvalBasis je opis praga, ki je sprožil odobritev (npr. 'percent>15').
 */
export function approvalAuditFields(approval: ApprovalEvidence | null, approvalBasis: string | null): Record<string, unknown> {
  if (!approval) return { approved: false }
  return {
    approved: true,
    approvalMethod: approval.method,
    approverId: approval.approverId,
    approverName: approval.approverName,
    approvalBasis,
  }
}

/** Audit polja razloga (posnetek — brez ID-ja obstoječega kataloga NI dovolj);
 *  null → vsa polja prazna (razlog NI bil zahtevan — politika). */
export function reasonAuditFields(reason: ReasonEvidence | null): Record<string, unknown> {
  if (!reason) return { reasonId: null, reasonName: null, reasonText: null, reasonComment: null }
  return {
    reasonId: reason.reasonId,
    reasonName: reason.reasonName,
    reasonText: reason.reasonText,
    reasonComment: reason.comment,
  }
}
