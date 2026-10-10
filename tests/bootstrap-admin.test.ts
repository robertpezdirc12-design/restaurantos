import { describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { requireAuth, requirePermission, requireCentralRole, isResponse } from '../src/lib/api'
import { CANONICAL_PERMISSIONS } from '../src/lib/permissions'
import { GET as expensesGET } from '../src/app/api/expenses/route'

/**
 * Bootstrap admin break-glass (audit §3 vrstica: "bootstrap break-glass — dokumentiran
 * ostanek"): žeton sub='bootstrap' + role='ADMIN' (izdan prek /api/auth/login, brez
 * Employee vrstice) MORAJE preiti requireAuth, requirePermission in requireCentralRole.
 * Pred popravkom je requirePermission vračal 403 (DB lookup na neobstoječega zaposlenega).
 *
 * Guardi (fail-closed): fast-path velja SAMO za sub='bootstrap' IN role='ADMIN' —
 * katerakoli druga kombinacija gre čez DB in pade na 403/401.
 */

function req(url: string, token: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
}

/** Žeton natanko tak, kot ga izda /api/auth/login bootstrap veja (brez sv — break-glass). */
const bootstrapToken = createToken({ sub: 'bootstrap', name: 'Bootstrap Admin', role: 'ADMIN', loc: null }, 2)

describe('bootstrap admin fast-path (auth + permission + central role)', () => {
  test('requireAuth: bootstrap žeton preide brez Employee vrstice', async () => {
    const user = await requireAuth(req('/api/anything', bootstrapToken))
    expect(isResponse(user)).toBe(false)
    if (!isResponse(user)) {
      expect(user.sub).toBe('bootstrap')
      expect(user.role).toBe('ADMIN')
    }
  })

  test('requirePermission: bootstrap preide za VSIM kanoničnimi dovoljenji', async () => {
    for (const permission of CANONICAL_PERMISSIONS) {
      const user = await requirePermission(req('/api/anything', bootstrapToken), permission)
      expect(isResponse(user)).toBe(false)
    }
  })

  test('requireCentralRole: bootstrap preide (break-glass za DDL rute)', async () => {
    const user = await requireCentralRole(req('/api/anything', bootstrapToken))
    expect(isResponse(user)).toBe(false)
  })

  test('GUARD: ADMIN z neobstoječim sub (≠ bootstrap) → 403 fail-closed', async () => {
    const fake = createToken({ sub: 'not-a-real-employee', name: 'Fake', role: 'ADMIN', loc: null, sv: 0 }, 2)
    const res = await requirePermission(req('/api/anything', fake), 'orders.create')
    expect(isResponse(res)).toBe(true)
    if (isResponse(res)) expect(res.status).toBe(403)
  })

  test('GUARD: sub=bootstrap vendar role ≠ ADMIN → 403 (fast-path zahteva ADMIN)', async () => {
    const fake = createToken({ sub: 'bootstrap', name: 'Igralec', role: 'WAITER', loc: null }, 2)
    const res = await requirePermission(req('/api/anything', fake), 'orders.create')
    expect(isResponse(res)).toBe(true)
    if (isResponse(res)) expect(res.status).toBe(403)
  })

  test('INTEGRACIJA: GET /api/expenses (reports.view) z bootstrap žetonom → 200', async () => {
    const res = await expensesGET(req('/api/expenses', bootstrapToken))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { expenses?: unknown[] }
    expect(Array.isArray(body.expenses)).toBe(true)
  })
})
