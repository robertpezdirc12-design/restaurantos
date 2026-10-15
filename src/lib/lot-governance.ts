/**
 * Issue #15 (P1, v1.105.0) — sledljivost serij: lot governance.
 *
 * Čista matematika + Prisma where-pomočniki (brez neposrednega db uvoza —
 * testabilno enako kot allergen-catalog). Pokriva:
 *  - statuse serije: ACTIVE / EXHAUSTED / QUARANTINE / RECALLED
 *    (status je PROST niz v shemi — brez DDL za nove vrednosti);
 *  - blokada uporabe: karantena/odpoklic/pretečeno/odstranitveni datum
 *    preprečijo NOVO razknjižbo (FEFO v lib/inventory.ts + pripravi);
 *  - klasifikacija serije za sezname (poteče kmalu / pretečeno / karantena /
 *    odpoklic / izčrpano / brez roka);
 *  - validacija datuma: alertDate ≤ removalDate ≤ expiryDate (izrecne
 *    vrednosti upravljavca — NO privzetega števila dni).
 *
 * PRAVILA (issue #15):
 *  - Odpoklic NE razveljavi izračun zalohistorije — agregatna količina ostane
 *    resnica fizične zaloge; blokirana serija samo NI več razpoložljiva za
 *    NOVE razknjižbe (allocate-skip + note "brez serije").
 *  - Sprostitev karantene je IZRECEN korak z razlogom (releaseNote) — nikoli
 *    tiha (storno vračilo ohrani blokiran status).
 *  - RECALLED je TERMINALEN — sprostitev ni mogoča (409), fizika odstranitve
 *    gre skozi obstoječi odpis (waste), ne skozi "release".
 */
import { num } from '@/lib/map'
import type { Prisma } from '@prisma/client'
import { isMissingSchemaError } from '@/lib/prisma-missing'

/* ───────────────────── pre-DDL degradacija (prod okno) ───────────────────── */

/**
 * Ali lot-governance stolpci (alertDate, removalDate, hold*, release*) že obstajajo
 * v DB? Prisma klient jih generira ob BUILD času — select/findMany jih zahteva
 * takoj, produkcijski Postgres pa jih dobi šele z DDL (konzola). Ta probe
 * (module-level cache, en $queryRawUnsafe) omogoča VROČI POTI (FEFO ob plačilu!)
 * degradacijo na legacy where/select — prodaja NIKOLI ne sme pasti na šemu.
 * Vzorec: haccp-plans capability probe (src/lib/haccp-plans.ts).
 */
let lotColsCache: boolean | null = null

export async function lotGovernanceColumnsReady(): Promise<boolean> {
  if (lotColsCache !== null) return lotColsCache
  try {
    const { db } = await import('@/lib/db')
    await db.$queryRawUnsafe(
      `SELECT "alertDate", "removalDate", "holdReason", "holdAt", "holdById", "holdRef", "releaseAt", "releaseById", "releaseNote" FROM "InventoryBatch" LIMIT 1`,
    )
    lotColsCache = true
  } catch (e) {
    if (isMissingSchemaError(e)) {
      lotColsCache = false
      return false
    }
    throw e
  }
  return true
}

/** test hook: poščisti cache (simulacija pre-DDL stanja) */
export function __resetLotGovernanceCacheForTests(): void {
  lotColsCache = null
}

/** test hook: VSILI cache vrednost (false = simulacija pre-DDL produkcijskega okna) */
export function __setLotGovernanceCacheForTests(v: boolean | null): void {
  lotColsCache = v
}

/** eksplicitni select za FEFO — legacy (brez novih stolpcev) ali poln. */
export const BATCH_SELECT_LEGACY = {
  id: true,
  inventoryItemId: true,
  lotNumber: true,
  status: true,
  quantityRemaining: true,
  expiryDate: true,
  receivedAt: true,
  unitCost: true,
} as const

export const BATCH_SELECT_FULL = {
  ...BATCH_SELECT_LEGACY,
  removalDate: true,
  alertDate: true,
} as const

/* ───────────────────────── statusi + blokada ───────────────────────── */

export const BATCH_STATUS = {
  ACTIVE: 'ACTIVE',
  EXHAUSTED: 'EXHAUSTED',
  QUARANTINE: 'QUARANTINE',
  RECALLED: 'RECALLED',
} as const

/** Statuse, ki preprečujejo novo razknjižbo (uporabo) serije. */
export const BLOCKED_STATUSES: readonly string[] = [BATCH_STATUS.QUARANTINE, BATCH_STATUS.RECALLED]

export function isBlockedStatus(status: unknown): boolean {
  return typeof status === 'string' && BLOCKED_STATUSES.includes(status.toUpperCase())
}

/** Toleranten match statusa (legacy 'active' iz receive poti pred v1.105.0). */
export function isActiveStatus(status: unknown): boolean {
  return typeof status === 'string' && status.toUpperCase() === BATCH_STATUS.ACTIVE
}

/* ───────────────────────── FEFO where + sort ───────────────────────── */

/**
 * Prisma where-pogoj za RAZPOLOŽLJIVE serije (FEFO vir):
 *  - status ACTIVE (tolerantno 'active' legacy);
 *  - quantityRemaining > 0;
 *  - rok: null (neznan — uporaben, a FEFO zadnji) ALI v prihodnosti;
 *  - removalDate: null ALI v prihodnosti (datum odstranitve iz zaloge).
 * KARANTENA/ODPOKLIČ/PRETEČENO/ODSTRANJENO so IZKLJUČENI iz nove razknjižbe.
 */
export function usableBatchWhere(now: Date): Prisma.InventoryBatchWhereInput {
  return {
    status: { in: [BATCH_STATUS.ACTIVE, 'active'] },
    quantityRemaining: { gt: 0 },
    AND: [
      { OR: [{ expiryDate: null }, { expiryDate: { gt: now } }] },
      { OR: [{ removalDate: null }, { removalDate: { gt: now } }] },
    ],
  }
}

/** Pre-DDL varianta: brez removalDate pogoja (stolpec še ne obstaja v DB). */
export function usableBatchWhereLegacy(now: Date): Prisma.InventoryBatchWhereInput {
  return {
    status: { in: [BATCH_STATUS.ACTIVE, 'active'] },
    quantityRemaining: { gt: 0 },
    OR: [{ expiryDate: null }, { expiryDate: { gt: now } }],
  }
}

/**
 * Klasifikacija serije (sezlivi pojavi za UI + sezname GET /batches?filter=):
 *  - 'recalled'   — odpoklic (terminalen, blokiran)
 *  - 'quarantined'— karantena (blokiran do izrecne sprostitve)
 *  - 'expired'    — rok uporabe je pretekel (blokiran za novo razknjižbo)
 *  - 'removal_due'— datum odstranitve je pretekel (blokiran)
 *  - 'exhausted'  — količina izčrpana
 *  - 'unknown_expiry' — rok NI nastavljen (sledljivostna vrzel — vidna)
 *  - 'alert'      — opozorilni datum je pretekel / rok ≤ 7 dni (še uporaben)
 *  - 'ok'         — zdrava serija z rokom
 * Blokirane klasifikacije se prenesejo ZGODAJ (recall > karantena > poteklo >
 * odstranitev > izčrpano), ker je za odločanje najpomembnejša najhujša ovira.
 */
export type BatchBucket =
  | 'recalled'
  | 'quarantined'
  | 'expired'
  | 'removal_due'
  | 'exhausted'
  | 'unknown_expiry'
  | 'alert'
  | 'ok'

export function batchBucket(
  b: {
    status: string
    quantityRemaining: unknown
    expiryDate?: Date | string | null
    alertDate?: Date | string | null
    removalDate?: Date | string | null
  },
  now: Date = new Date(),
): BatchBucket {
  const st = (b.status || '').toUpperCase()
  if (st === BATCH_STATUS.RECALLED) return 'recalled'
  if (st === BATCH_STATUS.QUARANTINE) return 'quarantined'
  const qty = num(b.quantityRemaining)
  if (qty <= 0.0005) return 'exhausted'
  const exp = toDate(b.expiryDate)
  const rem = toDate(b.removalDate)
  const alert = toDate(b.alertDate)
  if (exp !== null && exp.getTime() <= now.getTime()) return 'expired'
  if (rem !== null && rem.getTime() <= now.getTime()) return 'removal_due'
  if (exp === null) return 'unknown_expiry'
  if ((alert !== null && alert.getTime() <= now.getTime()) || exp.getTime() - now.getTime() <= 7 * 86_400_000) {
    return 'alert'
  }
  return 'ok'
}

/** Ali klasifikacija preprečuje novo razknjižbo? */
export function bucketBlocksUse(bucket: BatchBucket): boolean {
  return bucket === 'recalled' || bucket === 'quarantined' || bucket === 'expired' || bucket === 'removal_due'
}

/* ───────────────────────── datum validacija ───────────────────────── */

export interface LotDateInput {
  alertDate?: Date | null
  removalDate?: Date | null
  expiryDate?: Date | null
}

export interface LotDateValidation {
  ok: boolean
  error?: string
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null
  const d = v instanceof Date ? v : new Date(v)
  return isNaN(d.getTime()) ? null : d
}

/**
 * Poslovno pravilo datumov (Odoo removal-strategy + issue #15):
 *  opozorilni datum ≤ datum odstranitve ≤ rok uporabe — kadar sta vpisana.
 * NULL = vrednost ni določena (NE izpeljujemo privzetih dni).
 */
export function validateLotDates(d: LotDateInput): LotDateValidation {
  const alert = toDate(d.alertDate)
  const removal = toDate(d.removalDate)
  const expiry = toDate(d.expiryDate)
  if (alert && removal && alert.getTime() > removal.getTime()) {
    return { ok: false, error: 'Opozorilni datum mora biti pred ali enak datumu odstranitve.' }
  }
  if (alert && expiry && alert.getTime() > expiry.getTime()) {
    return { ok: false, error: 'Opozorilni datum mora biti pred ali enak roku uporabe.' }
  }
  if (removal && expiry && removal.getTime() > expiry.getTime()) {
    return { ok: false, error: 'Datum odstranitve mora biti pred ali enak roku uporabe.' }
  }
  return { ok: true }
}

/* ───────────────────────── FEFO vrstni red ───────────────────────── */

/**
 * Dialekt-determinističen FEFO vrstni red (v pomnilniku):
 *  1. učinkovita razpoložljivost = removalDate ?? expiryDate (NULL = +∞ zadnji —
 *     SQLite ASC da NULL PRVE, Postgres ZADNJE; pomnilniški sort poenoti);
 *  2. receivedAt (starejši sprejem prvi).
 * Podani seznam mora biti ŽE filtriran na uporabne serije (usableBatchWhere).
 */
export function sortUsableFefo<T extends { removalDate?: Date | string | null; expiryDate?: Date | string | null; receivedAt?: Date | string | null }>(
  batches: readonly T[],
): T[] {
  const eff = (b: T) => {
    const r = toDate(b.removalDate)
    if (r !== null) return r.getTime()
    const e = toDate(b.expiryDate)
    return e !== null ? e.getTime() : Number.POSITIVE_INFINITY
  }
  const rec = (b: T) => {
    const r = toDate(b.receivedAt)
    return r !== null ? r.getTime() : 0
  }
  return [...batches].sort((a, b) => eff(a) - eff(b) || rec(a) - rec(b))
}
