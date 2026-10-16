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
  const op: QueuedOp = {
    clientOperationId: clientOperationId || newOperationId(),
    kind,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  }
  setQueue([...getQueue(), op])
  return op
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
