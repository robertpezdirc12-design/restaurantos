/**
 * Issue #4 D4 — session revokacija (unit, čista logika brez DB).
 * Pravilo: fail-closed — žeton brez sv (izdan pred deployem) je preklican;
 * odstopanje od trenutnega Employee.sessionVersion je preklicano.
 */
import { describe, it, expect } from 'bun:test'
import { sessionRevoked } from '@/lib/auth'

describe('sessionRevoked (Issue #4 D4)', () => {
  it('veljavna seja: sv ustreza DB vrednosti', () => {
    expect(sessionRevoked(0, 0)).toBe(false)
    expect(sessionRevoked(3, 3)).toBe(false)
  })

  it('PIN reset / deaktivacija: sv odstopa → preklicano', () => {
    expect(sessionRevoked(0, 1)).toBe(true)
    expect(sessionRevoked(4, 5)).toBe(true)
    expect(sessionRevoked(5, 4)).toBe(true)
  })

  it('fail-closed: žeton brez sv (starejši od deploya) → preklicano', () => {
    expect(sessionRevoked(undefined, 0)).toBe(true)
    expect(sessionRevoked(null, 0)).toBe(true)
  })

  it('fail-closed: neveljavne vrednosti → preklicano', () => {
    expect(sessionRevoked(Number.NaN, 0)).toBe(true)
    expect(sessionRevoked(Number.POSITIVE_INFINITY, 0)).toBe(true)
  })
})
