'use client'

/**
 * Offline vrsta operacij (issue #1: offline/local-first).
 * - localStorage vrsta (ro_offline_queue) z UUID clientOperationId po operaciji
 * - v vrsto gredo SAMO replajabilne mutacije (naročila, artikli, kuhinja) — NE plačila
 * - flush → POST /api/sync (strežniška idempotencija prek DeviceSyncOperation)
 * - zaščita pred izgubo: odjava/401 NE počistita vrste
 */

export type QueuedOpKind = 'order.create' | 'order.addItems' | 'kitchen.status'

/** Issue #3 §A: stanje operacije v vrsti — 'dead' = dead-letter (po 10 neuspelih poskusih). */
export type QueuedOpStatus = 'queued' | 'dead'

export interface QueuedOp {
  clientOperationId: string
  kind: QueuedOpKind
  payload: Record<string, unknown>
  createdAt: string
  attempts: number
  lastError?: string
  /**
   * Issue #3 §A (P0): undefined = 'queued' — nazajkompatibilno z obstoječimi
   * localStorage vnosi (novo polje se zapiše šele ob prehodu v dead-letter).
   */
  status?: QueuedOpStatus
}

const QUEUE_KEY = 'ro_offline_queue'
const DEVICE_KEY = 'ro_device_id'
const MAX_ATTEMPTS = 10

/**
 * v1.170.0 (R2b) — vrsta se ne sme podvojiti in ne rasti neomejeno.
 *
 * Zakaj stožec, ne samodejno čiščenje: `setQueue` zapiše CELoten seznam, zato
 * en sam prevelik zapis vrže `QuotaExceededError` SRED pisanja — dotlej je
 * vrsta izgledala oddana (košarica se izprazni, prikaže se obvestilo o čakanju),
 * v brskalniku pa ni ničesar. Pri POS-u je napačen pritisk cenejši od izgubljenega
 * naročila, zato je edina varna reakcija na polno vrsto ZAVRNITEV + jasno
 * sporočilo, ne tiha odstranitev.
 *
 * Številki: 200 živih operacij je približno ena izmena na tablici (naročila +
 * kuhinjski statusi, ~200 B na operacijo ≈ 40 kB, daleč pod 5 MB kvoto). Starost
 * 12 h je daljša od vsake same izmene: dlje kot operacija čaka, bolj verjetno je,
 * da je miza že obrnjena in jo mora osebje pregledati, ne pa da jo pošiljamo v
 * nedogled.
 */
export const MAX_QUEUE_OPS = 200
export const MAX_QUEUE_AGE_MS = 12 * 60 * 60 * 1000

/** Zavrnitev vpisa: vrsta je polna ali brskalnik nima več prostora. */
export class QueueFullError extends Error {
  readonly code = 'queue_full'

  constructor(razlog: 'zapolnjena' | 'kvota') {
    super(
      razlog === 'kvota'
        ? 'Brskalnik nima več prostora za offline vrsto. Pošlji čakajoče operacije ali počisti zastarele, nato poskusi znova.'
        : `Offline vrsta je polna (največ ${MAX_QUEUE_OPS} operacij). Pošlji čakajoče operacije, nato poskusi znova.`,
    )
    this.name = 'QueueFullError'
  }
}

/** Prepoznavanje po `code`, ne po razredu: klasična identiteta razpada čez chunke. */
export function isQueueFullError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'queue_full'
}

const isLive = (op: QueuedOp): boolean => op.status !== 'dead'

/** Brez zanesljive ure operacije ne moremo soditi kot mlado — gre na pregled. */
const isExpired = (op: QueuedOp, now: Date): boolean => {
  const ustvarjena = Date.parse(op.createdAt)
  if (!Number.isFinite(ustvarjena)) return true
  return now.getTime() - ustvarjena > MAX_QUEUE_AGE_MS
}

/** Operacije, ki zasedejo stožec: žive in še znotraj starostne meje. */
const countsAgainstCap = (ops: QueuedOp[], now: Date): number =>
  ops.filter((op) => isLive(op) && !isExpired(op, now)).length

/** Koliko novih operacij vrsta še sprejme — nikoli negativno. */
export function queueHeadroom(now = new Date()): number {
  return Math.max(0, MAX_QUEUE_OPS - countsAgainstCap(getQueue(), now))
}

/**
 * Zastarele žive operacije pridejo v dead-letter, NE iz brskalnika: tam jih
 * osebje vidi in lahko ponovno vklopi ali zavrne, prehod pa se poroča na
 * /api/sync/drop, da ostane sled v reviziji. Idempotentno — drug klic ne
 * najdi ničesar za preseliti.
 */
export function sweepExpired(now = new Date()): QueuedOp[] {
  const ops = getQueue()
  const prestavljene: QueuedOp[] = []
  for (const op of ops) {
    if (isLive(op) && isExpired(op, now)) {
      op.status = 'dead'
      op.lastError = `čaka več kot ${Math.round(MAX_QUEUE_AGE_MS / 3_600_000)} h`
      prestavljene.push(op)
    }
  }
  if (prestavljene.length > 0) setQueue(ops)
  for (const op of prestavljene) reportDeadOp(op)
  return prestavljene
}

const listeners = new Set<(ops: QueuedOp[]) => void>()

export function newOperationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

/** Ali je napaka omrežna (offline / fetch failure) — takrat operacijo varno vrstimo */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const e = err as Error | undefined
  if (!e) return false
  return e.name === 'TypeError' || /failed to fetch|networkerror|load failed|fetch failed/i.test(e.message || '')
}

export function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server'
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = newOperationId()
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

export function getQueue(): QueuedOp[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') as QueuedOp[]
  } catch {
    return []
  }
}

function setQueue(ops: QueuedOp[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(ops))
  for (const l of listeners) l(ops)
}

export function subscribeQueue(fn: (ops: QueuedOp[]) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function enqueueOp(kind: QueuedOpKind, payload: Record<string, unknown>, clientOperationId?: string): QueuedOp {
  const ops = getQueue()
  // Idempotenca: isti clientOperationId je ponovni pritisk na isto operacijo
  // (npr. retry po omrežni napaki), ne drugo naročilo.
  if (clientOperationId) {
    const obstojeca = ops.find((o) => o.clientOperationId === clientOperationId)
    if (obstojeca) return obstojeca
  }
  const now = new Date()
  if (countsAgainstCap(ops, now) >= MAX_QUEUE_OPS) throw new QueueFullError('zapolnjena')
  const op: QueuedOp = {
    clientOperationId: clientOperationId || newOperationId(),
    kind,
    payload,
    createdAt: now.toISOString(),
    attempts: 0,
  }
  const naslednja = [...ops, op]
  // Zapis je edini trenutek, kjer vrsta res obstaja: kvota vrže PREJ, kot da bi
  // klicalec kaj trdil o oddanem naročilu.
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(naslednja))
  } catch {
    throw new QueueFullError('kvota')
  }
  for (const l of listeners) l(naslednja)
  return op
}

export type TryEnqueueResult =
  | { ok: true; op: QueuedOp }
  | { ok: false; reason: 'queue_full' }

/**
 * Različica za uporabniški tok: zavrnitev je rezultat, ne izjema. Klic na POS
 * mora vedeti, ali je operacija res v vrsti, preden sprejme nadaljnje korake
 * (izprazni košarico, pokaže "čaka na pošiljanje") — izjema, ki jo ujame širok
 * `catch`, je tisto, kar je v1.169.0 pustilo naročilo izgubljenim.
 */
export function tryEnqueueOp(kind: QueuedOpKind, payload: Record<string, unknown>, clientOperationId?: string): TryEnqueueResult {
  try {
    return { ok: true, op: enqueueOp(kind, payload, clientOperationId) }
  } catch (err) {
    if (isQueueFullError(err)) return { ok: false, reason: 'queue_full' }
    throw err
  }
}

export function removeOp(clientOperationId: string) {
  setQueue(getQueue().filter((o) => o.clientOperationId !== clientOperationId))
}

/**
 * Issue #3 §A (P0) — dead-letter namesto tihe izgube.
 * PREJ: ob prekoračitvi MAX_ATTEMPTS je filter vrsto operacijo TIHO izvrgel iz
 * localStorage (podatkovna izguba brez sledi, brez audit, brez UI sporočila —
 * strežnik je sicer pisal DeviceSyncOperation 'failed', klient pa ni vedel, da
 * je operacija padla). Zdaj: operacija OSTANE v vrsti z status 'dead' (flush jo
 * preskoči), prehod v dead-letter sproži fire-and-forget poročilo na
 * /api/sync/drop (AuditLog SYNC_OP_DROPPED), uporabnik pa jo lahko ponovno
 * odpošlje (resetDeadOp) ali zavrze (clearDeadOps).
 */
export function markOpAttempt(clientOperationId: string, error: string) {
  const ops = getQueue()
  const op = ops.find((o) => o.clientOperationId === clientOperationId)
  if (!op) return
  op.attempts += 1
  op.lastError = error.slice(0, 200)
  if (op.attempts >= MAX_ATTEMPTS && op.status !== 'dead') {
    op.status = 'dead'
    setQueue(ops)
    void reportDeadOp(op)
    return
  }
  setQueue(ops)
}

/** Issue #3 §A: vse dead-letter operacije v vrsti. */
export function getDeadOps(): QueuedOp[] {
  return getQueue().filter((o) => o.status === 'dead')
}

/** Issue #3 §A: ponovno vključi dead operacijo (attempts=0, status='queued', lastError počiščen). */
export function resetDeadOp(clientOperationId: string): boolean {
  const ops = getQueue()
  const op = ops.find((o) => o.clientOperationId === clientOperationId && o.status === 'dead')
  if (!op) return false
  op.attempts = 0
  op.status = 'queued'
  // Izrecen poskus osebja šteje od zdaj: brez osvežitve ure bi jo starostni
  // poseg takoj vrnil v dead-letter in gumb ne bi naredil ničesar.
  op.createdAt = new Date().toISOString()
  delete op.lastError
  setQueue(ops)
  return true
}

/** Issue #3 §A: odstrani VSE dead operacije (vrne število odstranjenih). */
export function clearDeadOps(): number {
  const ops = getQueue()
  const dead = ops.filter((o) => o.status === 'dead')
  if (dead.length === 0) return 0
  setQueue(ops.filter((o) => o.status !== 'dead'))
  return dead.length
}

/**
 * Issue #3 §A: fire-and-forget poročilo o padli operaciji na strežnik
 * (/api/sync/drop → AuditLog SYNC_OP_DROPPED). Telo vsebuje SAMO identiteto
 * operacijo + napako — NO vsebine payload (skrivnosti/količine ostanejo lokalne).
 * Tih: napaka poročila NIKOLI ne vpliva na vrsto.
 */
export function reportDeadOp(op: QueuedOp): void {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('ro_token') : null
    void fetch('/api/sync/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        clientOperationId: op.clientOperationId,
        kind: op.kind,
        attempts: Math.min(50, Math.max(1, op.attempts)),
        lastError: (op.lastError || '').slice(0, 200),
      }),
    }).catch(() => undefined)
  } catch { /* tih — poročilo ne sme vplivati na vrsto */ }
}

export interface FlushResult {
  flushed: number
  failed: number
  remaining: number
  /** Issue #3 §A: število dead operacij, ki jih flush NI poslal (čakajo v intervention). */
  dead: number
}

/** Pošlji vse čakajoče operacije na /api/sync; vrni povzetek. Dead operacije se NE pošiljajo (Issue #3 §A). */
export async function flushQueue(): Promise<FlushResult> {
  // Starost se pregleda ob vsakem poskusu pošiljanja: operacija, ki je čakala
  // dlje od izmene, spada na pregled osebja, ne v ponovitve v nedogled.
  sweepExpired()
  const ops = getQueue()
  if (ops.length === 0) return { flushed: 0, failed: 0, remaining: 0, dead: 0 }
  const token = localStorage.getItem('ro_token')
  if (!token) return { flushed: 0, failed: 0, remaining: ops.length, dead: ops.filter((o) => o.status === 'dead').length }
  // Issue #3 §A: dead operacije ostanejo v localStorage, na /api/sync gredo SAMO
  // žive (strežniška zavrnitev bi sicer samo povečala attempts brez efekta)
  const sendable = ops.filter((o) => o.status !== 'dead')
  const dead = ops.length - sendable.length
  if (sendable.length === 0) return { flushed: 0, failed: 0, remaining: 0, dead }
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId: getDeviceId(), ops: sendable.map((o) => ({ clientOperationId: o.clientOperationId, kind: o.kind, payload: o.payload })) }),
  })
  if (!res.ok) {
    // 401 itd. — pusti vrsto, ne izgubi ničesar
    return { flushed: 0, failed: 0, remaining: getQueue().length, dead }
  }
  const data = (await res.json()) as { results: { clientOperationId: string; ok: boolean; error?: string }[] }
  let flushed = 0
  let failed = 0
  for (const r of data.results || []) {
    if (r.ok) {
      removeOp(r.clientOperationId)
      flushed += 1
    } else {
      markOpAttempt(r.clientOperationId, r.error || 'neznana napaka')
      failed += 1
    }
  }
  return { flushed, failed, remaining: getQueue().filter((o) => o.status !== 'dead').length, dead: getDeadOps().length }
}
