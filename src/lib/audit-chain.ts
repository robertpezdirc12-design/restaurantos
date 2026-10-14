/**
 * Task 33-c — tamper-evident revizijska veriga (audit §6: "polji previousHash/chainHash
 * nikoli ne zapisana — aktivirati").
 *
 * Zasnova:
 *  - Vsak nov revizijski zapis (AuditLog, HaccpEntry) dobi `previousHash` (chainHash
 *    zadnje vrstice istega modela) in `chainHash` = sha256 nad kanoničnim nizom vrstice.
 *  - Veriga je GLOBALNA (ne per-location): AuditLog vsebuje vrstice vseh lokacij in
 *    akcij; tamper-evidenca velja naprej za celoten dnevnik. Location-scoped vidnost
 *    ostane rešitev poiskusov (locationId stolpec + indeks), ne ločene verige — ločene
 *    verige na lokacijo bi zapletle verifikacijo brez dodatne varnosti (premik vrstice
 *    med lokacije vseeno spremeni chainHash in bi bil odkrit).
 *
 * Kanonični niz (canonical string):
 *    `${model}|${previousHash}|${id}|${dateISO}|${action}|${entityType}|${entityId}|${locationId ?? ''}|${canonicalDetails}`
 *  - dateISO = createdAt?.toISOString() ?? ''. KONVENCIJA V TEM REPOZITORIJU: pisci
 *    NE podajo createdAt (čas zapisuje DB default now()), zato je dateISO vedno '' —
 *    verifikacija (verifyAuditChain) pričakuje enako (''). Polje createdAt obstaja za
 *    prihodnje pisce, ki bi zapisali izrecni čas — takrat je treba uskladiti tudi
 *    verifikacijo. Veriga s tem ščiti identiteto/vsebino/zaporedje (prek previousHash
 *    povezave), ne pa DB časovnega žiga (omejitev, dokumentirano).
 *
 * Kako se verifikacija izvede:
 *  1. preberi zadnjih N vrstic modela (orderBy datum desc, id desc), obrni v kronološko
 *     zaporedje;
 *  2. za vsako vrstico ponovno izračunaj chainHash iz shranjenih polj (id, action,
 *     entityType, entityId, locationId, details — kanonizirani) in primerjaj s
 *     shranjenim chainHash — neujemano = tampering na vsebini;
 *  3. preveri povezavo: row[i].previousHash === row[i-1].chainHash — neujemano =
 *     izbrisana/vstavljena/preurejena vrstica. Prva vrstica v oknu nima predhodnika v
 *     oknu (limit boundary), zato njene previousHash ne moremo preveriti povezave
 *     (samo hash). Prazna baza → ok (nič za preverit).
 *
 * Omejitve (dokumentirano):
 *  - Konkurenčni zapisi lahko delijo isti previousHash (read-last → insert brez zaklepa).
 *    Veriga ostaje preverljiva po id/createdAt: povezovalna preverba row[i].previousHash
 *    === row[i-1].chainHash odkrije vejo (neveljavna povezava), hash vrstice ostane
 *    veljaven. Za močnejše garancije bi bil potreben serializable tran ali DB sekvencer
 *    (izven obsega P2).
 *  - details se kanonizira deterministično: objekt → JSON s SORTIRANIMI ključi (rekurzivno),
 *    string → če se parse-a kot plain object, se sortira, sicer trim. Isti algoritem
 *    teče pri zapisu in verifikaciji → deterministično v obeh smereh.
 */
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { nid } from '@/lib/map'

/** DB klient (PrismaClient ali transakcijski klient) — oba izpolnjujeta TransactionClient. */
export type ChainDb = Prisma.TransactionClient

/** Modeli s chain polji, ki jih piše ta helper. (TipDistribution ima svojo verigo v tips.ts; GuestVisit/WaitlistEntry brez piscev — glej worklog 33-c.) */
export type ChainModel = 'auditLog' | 'haccpEntry'

export interface AuditChainFields {
  previousHash: string
  chainHash: string
}

export interface AuditChainOpts {
  action: string
  entityType: string
  entityId: string
  /** Details kot objekt (kanonizira: sortirani ključi) ali string (shrani + kanoniziraj enako). */
  details?: string | object
  locationId?: string | null
  /** ID vrstice — MORA biti enak ID-ju, ki ga pišeš v data (sicer veriga ne ustreza vrstici). */
  id: string
  /** Opcijsko: izrecni čas zapisa. Konvencija tega repozitorija: NE podajaj (glej zgoraj). */
  createdAt?: Date
  model?: ChainModel
}

/** Determinističen JSON: rekurzivno sortirani ključi objektov, polja v vrstnem redu. */
export function sortedKeysJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((v) => sortedKeysJson(v)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${sortedKeysJson((value as Record<string, unknown>)[k])}`)
    .join(',')
  return `{${body}}`
}

/**
 * Kanonizacija details: objekt → sortedKeysJson; string → če se parse-a kot plain
 * (ne-array) object, sortedKeysJson(parsed), sicer trim. Isti algoritem teče ob zapisu
 * in verifikaciji → deterministično.
 */
export function canonicalDetails(details: string | object | null | undefined): string {
  if (details === null || details === undefined) return ''
  if (typeof details !== 'string') return sortedKeysJson(details)
  const s = details.trim()
  if (!s) return ''
  try {
    const parsed: unknown = JSON.parse(s)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return sortedKeysJson(parsed)
    }
  } catch {
    /* ni JSON — pusti triman string */
  }
  return s
}

/** Datumski del kanoničnega niza ('' po konvenciji tega repozitorija — glej JSDoc zgoraj). */
function datePart(createdAt?: Date): string {
  return createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : ''
}

/** Kanonični niz vrstice (izpostavljeno za teste in zunanje verifikatorje). */
export function auditCanonicalString(input: {
  model: ChainModel
  previousHash: string
  id: string
  dateISO?: string
  action: string
  entityType: string
  entityId: string
  locationId?: string | null
  details?: string | object
}): string {
  return [
    input.model,
    input.previousHash,
    input.id,
    input.dateISO ?? '',
    input.action,
    input.entityType,
    input.entityId,
    input.locationId ?? '',
    canonicalDetails(input.details),
  ].join('|')
}

function chainHashOf(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Izračuna { previousHash, chainHash } za nov zapis. Pokliči PRED create in razširi
 * data z `...chain` — id MORA biti isti kot v data.
 *
 * previousHash = chainHash zadnje vrstice istega modela (orderBy datum desc, id desc)
 * ali '' (prva vrstica / prazna baza).
 *
 * Uporaba (AuditLog):
 *   const id = nid()
 *   const chain = await auditChainFields(tx ?? db, { id, action: 'X', entityType: 'Y', entityId, details, locationId })
 *   await db.auditLog.create({ data: { id, ..., ...chain } })
 *
 * Uporaba (HaccpEntry): isti vzorec z model: 'haccpEntry'.
 */
export async function auditChainFields(prisma: ChainDb, opts: AuditChainOpts): Promise<AuditChainFields> {
  const model: ChainModel = opts.model ?? 'auditLog'
  let previousHash = ''
  if (model === 'auditLog') {
    const last = await prisma.auditLog.findFirst({
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      select: { chainHash: true },
    })
    previousHash = last?.chainHash || ''
  } else {
    const last = await prisma.haccpEntry.findFirst({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { chainHash: true },
    })
    previousHash = last?.chainHash || ''
  }
  const canonical = auditCanonicalString({
    model,
    previousHash,
    id: opts.id,
    dateISO: datePart(opts.createdAt),
    action: opts.action,
    entityType: opts.entityType,
    entityId: opts.entityId,
    locationId: opts.locationId ?? '',
    // manjkajoč details v data pomeni DB default '{}' — kanoniziraj enako kot bo shranjeno
    details: opts.details === undefined ? '{}' : opts.details,
  })
  return { previousHash, chainHash: chainHashOf(canonical) }
}

export interface VerifyChainResult {
  /** true = vseh preverjenih vrstic hash + povezava veljavna (ali prazna baza/okno). */
  ok: boolean
  /** id prve pokvarjene vrstice (hash ali povezava), sicer null. */
  brokenAt: string | null
  /** vzrok zloma: 'hash' (vsebina spremenjena) ali 'link' (izbris/vstavek/preureditev). */
  reason: 'hash' | 'link' | null
  /** število preverjenih vrstic. */
  checked: number
}

/**
 * Verifikacija verige nazadnje `limit` vrstic modela (privzeto 500). Glej JSDoc modula
 * za postopek in omejitve (konkurenčni zapisi z deljenim previousHash + prva vrstica
 * okna brez povezovalne preverbe).
 *
 * `after` (aditivno, 33-c): omeji okno na vrstice z datumom >= after — uporabno za
 * verifikacijo samo novo-zapisanih vrstic (stare vrstice iz dobe PRED aktivacijo verige
 * imajo chainHash='' in bi okno "onesnažile"). Ne vpliva na strogo preverbo znotraj okna.
 */
export async function verifyAuditChain(
  db: ChainDb,
  opts?: { model?: ChainModel; limit?: number; after?: Date }
): Promise<VerifyChainResult> {
  const model: ChainModel = opts?.model ?? 'auditLog'
  const take = Math.min(5000, Math.max(1, Math.floor(opts?.limit ?? 500)))
  const orderBy = model === 'auditLog'
    ? [{ timestamp: 'desc' as const }, { id: 'desc' as const }]
    : [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
  const where = model === 'auditLog'
    ? (opts?.after ? { timestamp: { gte: opts.after } } : {})
    : (opts?.after ? { createdAt: { gte: opts.after } } : {})
  const select = model === 'auditLog'
    ? { id: true, action: true, entityType: true, entityId: true, details: true, locationId: true, previousHash: true, chainHash: true, timestamp: true }
    : { id: true, category: true, title: true, description: true, value: true, status: true, correctiveAction: true, employeeName: true, locationId: true, previousHash: true, chainHash: true, createdAt: true, date: true }

  const desc = model === 'auditLog'
    ? await db.auditLog.findMany({ where, orderBy, take, select })
    : await db.haccpEntry.findMany({ where, orderBy, take, select })
  const rows = desc.slice().reverse() // kronološko

  let prevChain: string | null = null // null = prva v oknu (povezave ne moremo preveriti)
  for (const row of rows as (typeof rows)[number][]) {
    const r = row as unknown as Record<string, unknown>
    const storedHash = String(r.chainHash ?? '')
    const canonical = model === 'auditLog'
      ? auditCanonicalString({
          model,
          previousHash: String(r.previousHash ?? ''),
          id: String(r.id),
          dateISO: '', // konvencija: pisci ne podajo createdAt (glej JSDoc modula)
          action: String(r.action ?? ''),
          entityType: String(r.entityType ?? ''),
          entityId: String(r.entityId ?? ''),
          locationId: (r.locationId as string | null) ?? '',
          details: String(r.details ?? ''),
        })
      : auditCanonicalString({
          model,
          previousHash: String(r.previousHash ?? ''),
          id: String(r.id),
          dateISO: '',
          action: 'HACCP_ENTRY',
          entityType: 'HaccpEntry',
          entityId: String(r.id),
          locationId: (r.locationId as string | null) ?? '',
          details: {
            category: r.category, title: r.title, description: r.description, value: r.value,
            status: r.status, correctiveAction: r.correctiveAction, employeeName: r.employeeName,
          },
        })
    if (chainHashOf(canonical) !== storedHash) {
      return { ok: false, brokenAt: String(r.id), reason: 'hash', checked: rows.length }
    }
    if (prevChain !== null && String(r.previousHash ?? '') !== prevChain) {
      return { ok: false, brokenAt: String(r.id), reason: 'link', checked: rows.length }
    }
    prevChain = storedHash
  }
  return { ok: true, brokenAt: null, reason: null, checked: rows.length }
}


/**
 * AUDIT-FIX v1.82.8 — centraliziran zapis AuditLog vrstice.
 *
 * Do tega commita je 124 API-mest pisalo trojček ročno (≈4 vrstice boilerplate vsak):
 *   const __aId = nid()
 *   const __chain = await auditChainFields(db, { id: __aId, action, entityType, entityId, details?, locationId? })
 *   await db.auditLog.create({ data: { ...__chain, id: __aId, userId, action, entityType, entityId, details?, ipAddress?, locationId? } })
 *
 * writeAudit() združi vse tri korake v en klic z ENAKIMI semantikami:
 *  - id = nid(); chain se izračuna PREJ create (ista zaporedja kot prej),
 *  - polja, ki niso podana, se v data izpustijo (undefined) → isti DB defaulti
 *    kot prej (details '{}', ipAddress '', locationId/userId/entityId NULL),
 *  - details je string (jstr(...)): chain ga kanonizira (parse+sort), enako kot
 *    prej — zapis in verifikacija ostajata bitno-identična,
 *  - napake se širijo klicatelju; ognjevzdržni klici (npr. LOGIN_FAILED) obdržijo
 *    .catch(() => {}) na klicnem mestu.
 *
 * Izven obsega (ostajajo ročni): haccpEntry veriga (drugi model), monitoring/errors
 * (issue #25: ruta potrebuje nid za reportId v odgovoru in vodi svojo
 * validacijo/redakcijo details pred zapisom), delivery/webhook + staff-shifts
 * (nestandardne oblike).
 */
export interface WriteAuditOpts {
  userId?: string | null
  action: string
  entityType: string
  entityId?: string | null
  /** Podrobnosti kot niz (jstr(...)) — kanonizira ga auditChainFields. */
  details?: string
  ipAddress?: string
  locationId?: string | null
}

export async function writeAudit(prisma: ChainDb, opts: WriteAuditOpts): Promise<void> {
  const id = nid()
  const chain = await auditChainFields(prisma, {
    action: opts.action,
    entityType: opts.entityType,
    entityId: opts.entityId ?? '',
    details: opts.details,
    locationId: opts.locationId,
    id,
  })
  await prisma.auditLog.create({
    data: {
      ...chain,
      id,
      userId: opts.userId,
      action: opts.action,
      entityType: opts.entityType,
      entityId: opts.entityId,
      details: opts.details,
      ipAddress: opts.ipAddress,
      locationId: opts.locationId,
    },
  })
}
