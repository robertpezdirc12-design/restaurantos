/**
 * ISSUE #75 (v1.134.0) — varnostni izvajalni načrt iz #72, regresijske varovalke.
 *
 * Sklop 0 — tri odločitve lastnika (dokumentirane v komentarju issue-ja #75):
 *   0.1  vodja lokale NE spreminja denarne politike (settings.manage = centralno);
 *        sme ustvarjati samo operativne delavce (ne vodij) — že v1.133.0, tu zaklenjeno
 *   0.2  centralni račun brez lokacije: OWNER/ADMIN vidi vse; MANAGER brez lokacije
 *        = fail-closed rdeče stanje (E5, v1.133.0)
 *   0.3  manjkajoči alergeni: opozorilo z rdečim pasom + izrecna potrditev (ne
 *        tiha blokada) — vizualna izvedba v #74 V-10
 *
 * Sklop T — varovalka ruta×metoda: tests/route-coverage.test.ts (226 route.ts).
 *
 * Sklop 5.1 (C1) — tri ravni (Standard / Enhanced / Full) po vzoru Square:
 *   - property_manager NI VEČ superuporabnik (Razširjena raven)
 *   - permissionTierFor() — enoten vir resnice o ravni
 *   - FULL_ONLY_PERMISSIONS + strop na podeljevanju (PATCH 403, ne-le odvzem)
 * Sklop 5.2 (C3) — denarna politika centralno-only (že v1.133.0 — varovalka tu).
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { employeePinFields, createToken } from '@/lib/auth'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import {
  CANONICAL_PERMISSIONS,
  FULL_ONLY_PERMISSIONS,
  PERMISSION_TIER_LABELS,
  permissionTierFor,
  resolvePermissions,
} from '@/lib/permissions'
import { PATCH as employeePATCH } from '../src/app/api/employees/[id]/route'

const read = (p: string) => readFileSync(join(import.meta.dir, p), 'utf-8')
const PREFIX = 'i75fx-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: `${PREFIX}` } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: `${PREFIX}loc-` } } }).catch(() => null)
})

const setupP = (async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `I75FX-${RUN.toUpperCase()}`, premisesId: `${PREFIX}prem-${RUN}` },
  })
  const mk = async (tag: string, role: string) => {
    const f = employeePinFields(`${PIN_BASE}${tag.length}`, `${PREFIX}${tag}-${RUN}@test.local`)
    return db.employee.create({
      data: {
        id: `${PREFIX}${tag}-${RUN}`, name: `${PREFIX}${tag}`, email: `${PREFIX}${tag}-${RUN}@test.local`,
        role, status: 'active', sessionVersion: 0, locationId: loc.id, pin: f.pin, pinLookup: f.pinLookup,
      },
    })
  }
  const manager = await mk('mgr', 'manager')
  const target = await mk('target', 'waiter')
  return {
    locId: loc.id,
    targetId: target.id,
    managerToken: createToken({ sub: manager.id, name: manager.name, role: 'MANAGER', loc: loc.id, sv: 0 }),
  }
})()

/* ── Sklop 5.1 (C1): tri ravni — enoten vir resnice ── */
describe('ISSUE #75 5.1 — permissionTierFor (Standard / Enhanced / Full)', () => {
  test('Full: owner, admin, group_owner, org_admin', () => {
    for (const r of ['owner', 'admin', 'group_owner', 'org_admin', 'OWNER', 'ORG_ADMIN']) {
      expect(permissionTierFor(r)).toBe('full')
    }
  })

  test('Enhanced: manager, property_manager (vodstvo — ne superuporabnik)', () => {
    expect(permissionTierFor('manager')).toBe('enhanced')
    expect(permissionTierFor('property_manager')).toBe('enhanced')
    expect(permissionTierFor('PROPERTY_MANAGER')).toBe('enhanced')
  })

  test('Standard: operativne vloge; prazna/neznana → standard (fail-safe tla)', () => {
    for (const r of ['waiter', 'bar', 'kitchen', 'cleaner', 'warehouse', 'accounting', '', 'unknown-role']) {
      expect(permissionTierFor(r)).toBe('standard')
    }
  })

  test('ALL_DB_ROLES pokritost: vsaka vloga iz enuma ima določeno raven', () => {
    const ALL = ['owner', 'admin', 'manager', 'staff', 'waiter', 'bar', 'chef', 'kitchen',
      'group_owner', 'org_admin', 'property_manager', 'warehouse', 'accounting', 'cleaner']
    for (const r of ALL) {
      expect(['standard', 'enhanced', 'full']).toContain(permissionTierFor(r))
    }
  })

  test('nabor Enhanced (manager/property_manager) ne vsebuje NOGA lastniškega ključa', () => {
    for (const role of ['manager', 'property_manager']) {
      const p = resolvePermissions(role, [])
      for (const own of FULL_ONLY_PERMISSIONS) expect(p).not.toContain(own)
    }
  })

  test('FULL_ONLY_PERMISSIONS ⊆ CANONICAL (veljavni ključi, ne fantomski)', () => {
    for (const p of FULL_ONLY_PERMISSIONS) {
      expect((CANONICAL_PERMISSIONS as readonly string[]).includes(p)).toBe(true)
    }
  })

  test('PERMISSION_TIER_LABELS obstajajo za vse tri ravni (UI značke)', () => {
    expect(PERMISSION_TIER_LABELS.standard).toBeTruthy()
    expect(PERMISSION_TIER_LABELS.enhanced).toBeTruthy()
    expect(PERMISSION_TIER_LABELS.full).toBeTruthy()
  })
})

/* ── Sklop 5.1/5.3 (C1+C2): strop podeljevanja — VEDENJE na ruti ── */
describe('ISSUE #75 5.1/5.3 — PATCH strop: manager NE podeli lastniških ključev', () => {
  test('MANAGER poskuša dodati receipts.storno natakarju → 403 (fiskalna razveljavitev)', async () => {
    const { targetId, managerToken } = await setupP
    const res = await employeePATCH(
      req(`/api/employees/${targetId}`, managerToken, 'PATCH', { permissionOverrides: ['receipts.storno'] }),
      { params: Promise.resolve({ id: targetId }) },
    )
    expect(res.status).toBe(403)
    expect(await db.employee.findUnique({ where: { id: targetId } }).then((e) => e?.permissionOverrides)).toBe('[]')
  })

  test('MANAGER poskuša dodati einvoices.issue natakarju → 403 (fiskalni B2B dokument)', async () => {
    const { targetId, managerToken } = await setupP
    const res = await employeePATCH(
      req(`/api/employees/${targetId}`, managerToken, 'PATCH', { permissionOverrides: ['einvoices.issue'] }),
      { params: Promise.resolve({ id: targetId }) },
    )
    expect(res.status).toBe(403)
  })

  test('MANAGER sme dodati NEPRIVILEGIRAN ključ (haccp.execute) → 200', async () => {
    const { targetId, managerToken } = await setupP
    const res = await employeePATCH(
      req(`/api/employees/${targetId}`, managerToken, 'PATCH', { permissionOverrides: ['haccp.execute'] }),
      { params: Promise.resolve({ id: targetId }) },
    )
    expect(res.status).toBe(200)
  })
})

/* ── Viri (source) varovalke: dialog + i18n + rute ── */
describe('ISSUE #75 — UI in viri (source varovalke)', () => {
  test('dialog uporablja FULL_ONLY_PERMISSIONS za zaklepanje (isti strop kot backend)', () => {
    const dash = read('../src/app/dashboard/page.tsx')
    expect(dash).toContain('(FULL_ONLY_PERMISSIONS as readonly string[]).includes(perm)')
    expect(dash).toContain('permissionTierFor(empRole)')
    expect(dash).toContain("t('emp.tierBadge')")
  })

  test('i18n značka ravni obstaja v SL in HR', () => {
    expect(read('../src/lib/i18n/sl.ts')).toContain("'emp.tierBadge'")
    expect(read('../src/lib/i18n/hr.ts')).toContain("'emp.tierBadge'")
  })

  test('PATCH strop vsebuje VSE lastniške ključe + employees.manage', () => {
    const patch = read('../src/app/api/employees/[id]/route.ts')
    expect(patch).toContain('FULL_ONLY_PERMISSIONS')
    expect(patch).toContain("p === 'employees.manage'")
  })

  test('Sklop 5.2 (C3): denarna politika ostaja centralno-only (varovalka iz #72)', () => {
    const s = read('../src/app/api/settings/route.ts')
    expect(s).toContain('touchesPolicy && !isCentralRole(user)')
  })
})
