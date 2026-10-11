/**
 * Issue #4 §11 — unit testi za centralni resource/location authorization
 * (src/lib/api.ts: assertResourceLocation, locationScope, isCentralRole).
 *
 * '@/lib/api' vleče tudi '@/lib/db' (prisma client, lazy connect) in next/server —
 * bun test oboje prenaša (DATABASE_URL je v .env, prisma client je generiran).
 * Testi so PURE (brez DB klicev) — PrismaClient se samo instancira.
 */
import { describe, expect, test } from 'bun:test'
import { assertResourceLocation, locationScope, isCentralRole } from '@/lib/api'
import type { AuthPayload } from '@/lib/auth'

const staffA: AuthPayload = { sub: 'e1', name: 'T', role: 'WAITER', loc: 'A', exp: Date.now() + 3600 }
const owner: AuthPayload = { sub: 'e2', name: 'O', role: 'OWNER', loc: null, exp: Date.now() + 3600 }
const admin: AuthPayload = { sub: 'e3', name: 'A', role: 'ADMIN', loc: null, exp: Date.now() + 3600 }
const staffNoLoc: AuthPayload = { sub: 'e4', name: 'N', role: 'WAITER', loc: null, exp: Date.now() + 3600 }

describe('isCentralRole', () => {
  test('OWNER in ADMIN sta centralni, staff ni', () => {
    expect(isCentralRole(owner)).toBe(true)
    expect(isCentralRole(admin)).toBe(true)
    expect(isCentralRole(staffA)).toBe(false)
  })
})

describe('assertResourceLocation', () => {
  test('staff lokacija A + resource B → 403 response', () => {
    const res = assertResourceLocation(staffA, 'B')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  test('staff A + resource A → null (dostop dovoljen)', () => {
    expect(assertResourceLocation(staffA, 'A')).toBeNull()
  })

  test('staff brez lokacije → 403 (fail-closed)', () => {
    const res = assertResourceLocation(staffNoLoc, 'A')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  test('resource brez lokacije + staff → 403 (fail-closed)', () => {
    const res = assertResourceLocation(staffA, null)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  test('OWNER/ADMIN → vedno null (tudi brez lokacije / tuji resource)', () => {
    expect(assertResourceLocation(owner, 'B')).toBeNull()
    expect(assertResourceLocation(owner, null)).toBeNull()
    expect(assertResourceLocation(admin, 'B')).toBeNull()
    expect(assertResourceLocation(admin, undefined)).toBeNull()
  })
})

describe('locationScope', () => {
  test('staff → filter na svojo lokacijo', async () => {
    expect(await locationScope(staffA)).toEqual({ locationId: 'A' })
  })

  test('staff brez lokacije → fail-closed sentinel (ne vidi nič)', async () => {
    expect(await locationScope(staffNoLoc)).toEqual({ locationId: '__no_location__' })
  })

  test('centralna vloga → brez filtra (vidi vse)', async () => {
    expect(await locationScope(owner)).toEqual({})
    expect(await locationScope(admin)).toEqual({})
  })
})
