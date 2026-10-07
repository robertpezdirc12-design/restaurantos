/**
 * Issue #11 §3 — dogodkovna arhitektura (faza 1): čisti deli brez DB
 * (registracija handlerjev, dispatch semantika, retry konstanta, payload parsing).
 * publishEvent/dispatchPending (z DB) se verifikirajo prek API (lokalni tok).
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  registerHandler,
  dispatchEvent,
  __resetHandlersForTests,
  eventPayload,
  EVENT_TYPES,
  MAX_EVENT_ATTEMPTS,
  type EventRecord,
} from '@/lib/events'

function evt(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'e1',
    type: 'OrderCreated',
    entityType: 'Order',
    entityId: 'ord-1',
    payload: '{"orderNumber":1}',
    status: 'pending',
    attempts: 0,
    error: '',
    ...overrides,
  }
}

describe('dogodkovni registri (Issue #11 §3)', () => {
  beforeEach(() => __resetHandlersForTests())

  it('brez handlerjev → dispatch uspešen (evidenca, replay mogoč)', async () => {
    const r = await dispatchEvent(evt())
    expect(r.ok).toBe(true)
  })

  it('registriran handler se izvede', async () => {
    let called = ''
    registerHandler('OrderCreated', async (e) => { called = e.entityId })
    const r = await dispatchEvent(evt({ entityId: 'ord-42' }))
    expect(r.ok).toBe(true)
    expect(called).toBe('ord-42')
  })

  it('več handlerjev: vse se izvedejo po vrsti', async () => {
    const order: string[] = []
    registerHandler('PaymentCompleted', async () => { order.push('a') })
    registerHandler('PaymentCompleted', async () => { order.push('b') })
    const r = await dispatchEvent(evt({ type: 'PaymentCompleted' }))
    expect(r.ok).toBe(true)
    expect(order).toEqual(['a', 'b'])
  })

  it('napaka handlerja → dispatch neuspešen z napako (retry machinerija jo zabeleži)', async () => {
    registerHandler('StockChanged', async () => { throw new Error('db down') })
    const r = await dispatchEvent(evt({ type: 'StockChanged' }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('db down')
  })

  it('prvi neuspeli handler ustavi zaporedje', async () => {
    let second = false
    registerHandler('InvoiceCreated', async () => { throw new Error('x') })
    registerHandler('InvoiceCreated', async () => { second = true })
    const r = await dispatchEvent(evt({ type: 'InvoiceCreated' }))
    expect(r.ok).toBe(false)
    expect(second).toBe(false)
  })
})

describe('konstante in helperji (Issue #11 §3)', () => {
  it('vseh 7 vrst dogodkov iz issue-ja', () => {
    expect(EVENT_TYPES).toEqual([
      'OrderCreated', 'OrderUpdated', 'OrderCancelled', 'PaymentCompleted',
      'InvoiceCreated', 'StockChanged', 'KitchenCompleted',
    ])
  })

  it('retry cap je 5 poskusov', () => {
    expect(MAX_EVENT_ATTEMPTS).toBe(5)
  })

  it('eventPayload: veljaven/neveljaven/prazen JSON', () => {
    expect(eventPayload({ payload: '{"a":1}' })).toEqual({ a: 1 })
    expect(eventPayload({ payload: 'ni-json' })).toEqual({})
    expect(eventPayload({ payload: '' })).toEqual({})
    expect(eventPayload({ payload: '[1,2]' })).toEqual({})
  })
})
