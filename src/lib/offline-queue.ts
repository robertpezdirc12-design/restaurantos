'use client'

/**
 * Offline vrsta operacij (issue #1: offline/local-first).
 * - localStorage vrsta (ro_offline_queue) z UUID clientOperationId po operaciji
 * - v vrsto gredo SAMO replajabilne mutacije (naročila, artikli, kuhinja) — NE plačila
 * - flush → POST /api/sync (strežniška idempotencija prek DeviceSyncOperation)
 * - zaščita pred izgubo: odjava/401 NE počistita vrste
 */

export type QueuedOpKind = 'order.create' | 'order.addItems' | 'kitchen.status'

export interface QueuedOp {
  clientOperationId: string
  kind: QueuedOpKind
  payload: Record<string, unknown>
  createdAt: string
  attempts: number
  lastError?: string
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

/** Neuspešno poskusi šteje — ob prekoračitvi operacijo zavžemo (napačna/neizvedljiva) */
export function markOpAttempt(clientOperationId: string, error: string) {
  const ops = getQueue()
  const op = ops.find((o) => o.clientOperationId === clientOperationId)
  if (!op) return
  op.attempts += 1
  op.lastError = error.slice(0, 200)
  setQueue(ops.filter((o) => o.clientOperationId !== clientOperationId || o.attempts < MAX_ATTEMPTS))
}

export interface FlushResult {
  flushed: number
  failed: number
  remaining: number
}

/** Pošlji vse čakajoče operacije na /api/sync; vrni povzetek */
export async function flushQueue(): Promise<FlushResult> {
  const ops = getQueue()
  if (ops.length === 0) return { flushed: 0, failed: 0, remaining: 0 }
  const token = localStorage.getItem('ro_token')
  if (!token) return { flushed: 0, failed: 0, remaining: ops.length }
  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId: getDeviceId(), ops: ops.map((o) => ({ clientOperationId: o.clientOperationId, kind: o.kind, payload: o.payload })) }),
  })
  if (!res.ok) {
    // 401 itd. — pusti vrsto, ne izgubi ničesar
    return { flushed: 0, failed: 0, remaining: ops.length }
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
  return { flushed, failed, remaining: getQueue().length }
}
