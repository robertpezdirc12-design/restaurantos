/**
 * Test 32-c — P1 točka 4 (audit §12): kritična testna pokritost `resolvePermissions`/`ROLE_DEFAULTS`.
 *
 * Čisti unit testi (brez DB) za src/lib/permissions.ts:
 *  - privzete matrice po vlogah (full set za owner/admin/manager/enterprise; podnabori za staff vloge);
 *  - vsak ROLE_DEFAULTS vnos ⊆ CANONICAL_PERMISSIONS (brez izmišljenih dovoljenj);
 *  - obveznice (overrides) so SAMO DODATNE — neznani/revocation nizi se ignorirajo
 *    (dejansko obnašanje implementacije: filter prek isValidPermission, KONFLIKTNO PRAVILO issue #1);
 *  - varno privzeto obnašanje za neznane vloge (fallback na staff podnabor, NE prazen set).
 * Fixture predpona: perms- (samo v komentarjih/imena testnih vlog — brez DB zapisa).
 */
import { describe, expect, test } from 'bun:test'
import {
  CANONICAL_PERMISSIONS,
  PERMISSION_LABELS,
  isValidPermission,
  resolvePermissions,
  resolvePermissionsForUIRole,
} from '@/lib/permissions'
import { tabHasPerm } from '@/lib/tab-permissions'

/** Vse vloge iz Prisma enuma EmployeeRole (schema.prisma) — pokritost vseh ROLE_DEFAULTS vnosov */
const ALL_DB_ROLES = [
  'owner', 'admin', 'manager', 'staff', 'waiter', 'bar', 'chef', 'kitchen',
  'group_owner', 'org_admin', 'property_manager', 'warehouse', 'accounting', 'cleaner',
] as const

const FULL_ROLES = ['owner', 'admin', 'manager', 'group_owner', 'org_admin', 'property_manager']
const canonical = [...CANONICAL_PERMISSIONS]

const sortedEq = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join('|') === [...b].sort().join('|')

describe('resolvePermissions — vloge s polnim naborom dovoljenj', () => {
  for (const role of FULL_ROLES) {
    test(`vloga "${role}" ima VSA kanonična dovoljenja`, () => {
      const perms = resolvePermissions(role, [])
      expect(sortedEq(perms, canonical)).toBe(true)
      expect(perms).toHaveLength(canonical.length)
    })
  }

  test('velike črke vloga se normalizira (DB/UI mešanica) — "MANAGER"', () => {
    expect(sortedEq(resolvePermissions('MANAGER', []), canonical)).toBe(true)
  })
})

describe('resolvePermissions — podnabori po vlogah (staff/vodstvo operativke)', () => {
  test('waiter: orders.create + orders.pay + apply_discounts + reservations.manage + menu.availability (OPS-4)', () => {
    expect(sortedEq(resolvePermissions('waiter', []), [
      'orders.create', 'orders.pay', 'apply_discounts', 'reservations.manage', 'menu.availability',
    ])).toBe(true)
    // granularnost OPS-4: natakar NE sme urejati menija/blagajne/vodstvenih zadev
    expect(resolvePermissions('waiter', [])).not.toContain('menu.manage')
    expect(resolvePermissions('waiter', [])).not.toContain('cash.manage')
  })

  test('staff (legacy natakar) ima ISTO privzeto množico kot waiter', () => {
    expect(sortedEq(resolvePermissions('staff', []), resolvePermissions('waiter', []))).toBe(true)
  })

  test('bar: hitra prodaja (orders.pay) + 86 + blagajna + KDS (OPS-4 matrica)', () => {
    const perms = resolvePermissions('bar', [])
    expect(sortedEq(perms, [
      'orders.create', 'orders.pay', 'apply_discounts', 'kitchen.update', 'menu.availability', 'cash.manage',
    ])).toBe(true)
    expect(perms).toContain('orders.pay') // OPS-4: sank sme hitro prodajo
    expect(perms).not.toContain('menu.manage')
    expect(perms).not.toContain('employees.manage')
  })

  test('chef in kitchen: KDS + 86 + HACCP meritve (OPS-4) — brez prodaje', () => {
    expect(sortedEq(resolvePermissions('chef', []), ['kitchen.update', 'menu.availability', 'haccp.execute'])).toBe(true)
    expect(sortedEq(resolvePermissions('kitchen', []), ['kitchen.update', 'menu.availability', 'haccp.execute'])).toBe(true)
    expect(resolvePermissions('kitchen', [])).not.toContain('orders.create')
    expect(resolvePermissions('kitchen', [])).not.toContain('orders.pay')
  })

  test('cleaner (NOVO, OPS-4): izključno haccp.execute + lastni delovni čas (implicitno)', () => {
    const perms = resolvePermissions('cleaner', [])
    expect(sortedEq(perms, ['haccp.execute'])).toBe(true)
    expect(perms).not.toContain('orders.create')
    expect(perms).not.toContain('orders.pay')
    expect(perms).not.toContain('reports.view')
    expect(perms).not.toContain('settings.manage')
  })

  test('OPS-4: 20 kanoničnih dovoljenj (11 izvornih + 8 OPS-4 + discounts.manage issue #5)', () => {
    expect(canonical).toHaveLength(20)
    for (const k of [
      'orders.void', 'orders.discount', 'cash.manage', 'menu.availability',
      'haccp.execute', 'timeclock.manage', 'delivery.manage', 'giftcards.manage',
      // issue #5: katalog promocij ločeno od uporabe popusta
      'discounts.manage',
    ]) expect(canonical).toContain(k)
  })

  test('warehouse: inventory.manage + reports.view (naloga 31-b dejstvo)', () => {
    const perms = resolvePermissions('warehouse', [])
    expect(sortedEq(perms, ['inventory.manage', 'reports.view'])).toBe(true)
    expect(perms).toContain('inventory.manage')
  })

  test('accounting: samo reports.view', () => {
    expect(sortedEq(resolvePermissions('accounting', []), ['reports.view'])).toBe(true)
  })
})

describe('ROLE_DEFAULTS hidrična pravila (prek javnega API-ja)', () => {
  test('vsaka privzeta pravica VSEH znanih vlog je kanonična (brez izmišljenih dovoljenj)', () => {
    for (const role of ALL_DB_ROLES) {
      const perms = resolvePermissions(role, [])
      expect(perms.length).toBeGreaterThan(0)
      for (const p of perms) {
        expect(isValidPermission(p)).toBe(true)
        expect(canonical).toContain(p)
      }
    }
  })

  test('vloga brez vnosa v ROLE_DEFAULTS pade na VARNI privzetek = staff podnabor (NE prazen set)', () => {
    // dejansko obnašanje: ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.staff — fail-closed na najmanjši operativni nabor
    const unknown = resolvePermissions('nonexistent-role-xyz', [])
    expect(sortedEq(unknown, resolvePermissions('staff', []))).toBe(true)
    expect(unknown).not.toContain('employees.manage')
    expect(unknown).not.toContain('settings.manage')
  })

  test('prazen roleDB niz → privzetek staff', () => {
    expect(sortedEq(resolvePermissions('', []), resolvePermissions('staff', []))).toBe(true)
  })
})

describe('permissionOverrides — dodatne obveznice (SAMO aditivne)', () => {
  test('override DODA manjkajoče dovoljenje in ohrani privzete vloge', () => {
    const base = resolvePermissions('waiter', [])
    const withExtra = resolvePermissions('waiter', ['menu.manage', 'reports.view'])
    expect(withExtra).toContain('menu.manage')
    expect(withExtra).toContain('reports.view')
    // vse privzete ostanejo
    for (const p of base) expect(withExtra).toContain(p)
    expect(withExtra).toHaveLength(base.length + 2)
  })

  test('override enak obstoječi pravici → brez duplikatov (Set dedup)', () => {
    const perms = resolvePermissions('waiter', ['orders.pay', 'orders.create'])
    expect(perms).toHaveLength(new Set(perms).size)
    expect(perms).toHaveLength(resolvePermissions('waiter', []).length)
  })

  test('NEZNAN override niz se IGNORIRA — ne ustvari izmišljenega dovoljenja', () => {
    const base = resolvePermissions('waiter', [])
    const perms = resolvePermissions('waiter', ['flying.pigs', 'orders.delete', '', '  '])
    expect(sortedEq(perms, base)).toBe(true)
    expect(perms).not.toContain('flying.pigs')
  })

  test('revocation sintaksa ("-orders.pay") NI podprta — override ne ODVZAME pravice', () => {
    // KONFLIKTNO PRAVILO (issue #1, komentar: vloge): overrides so vedno DODATNA dovoljenja,
    // nikoli ne odvzamejo — "-orders.pay" ni kanonično → filtriran → pravica ostane
    const perms = resolvePermissions('waiter', ['-orders.pay'])
    expect(perms).toContain('orders.pay')
    expect(sortedEq(perms, resolvePermissions('waiter', []))).toBe(true)
  })

  test('overrides, ki niso array (object/število), se ignorirajo → samo privzete', () => {
    const base = resolvePermissions('manager', [])
    expect(sortedEq(resolvePermissions('manager', { menu: true }), base)).toBe(true)
    expect(sortedEq(resolvePermissions('manager', 42), base)).toBe(true)
    expect(sortedEq(resolvePermissions('manager', null), base)).toBe(true)
  })

  test('overrides shranjeni kot JSON STRING (SQLite String polje) se razčlenijo', () => {
    const perms = resolvePermissions('chef', JSON.stringify(['menu.manage']))
    expect(perms).toContain('menu.manage')
    expect(perms).toContain('kitchen.update')
    expect(perms).toHaveLength(4) // 3 privzete (kitchen.update, menu.availability, haccp.execute) + menu.manage
  })

  test('pokvarjen JSON string overrides → varno samo privzete (jparse fallback)', () => {
    const base = resolvePermissions('chef', [])
    expect(sortedEq(resolvePermissions('chef', '{ni json'), base)).toBe(true)
    expect(sortedEq(resolvePermissions('chef', '"samo niz"'), base)).toBe(true)
  })
})

describe('resolvePermissionsForUIRole — UI vloga (žeton) → DB privzete', () => {
  test('UI vloge se preslikajo v DB privzete (OWNER/WAREHOUSE/ACCOUNTING)', () => {
    expect(sortedEq(resolvePermissionsForUIRole('OWNER', []), canonical)).toBe(true)
    expect(sortedEq(resolvePermissionsForUIRole('warehouse', []), ['inventory.manage', 'reports.view'])).toBe(true)
    expect(resolvePermissionsForUIRole('ACCOUNTING', [])).toEqual(['reports.view'])
  })

  test('neznana UI vloga → varni privzetek waiter podnabor (fail-closed)', () => {
    const perms = resolvePermissionsForUIRole('NOT_A_ROLE', [])
    expect(sortedEq(perms, resolvePermissions('waiter', []))).toBe(true)
    expect(perms).not.toContain('settings.manage')
  })

  test('neznana UI vloga z overrides → overrides se še vedno upoštevajo', () => {
    const perms = resolvePermissionsForUIRole('NOT_A_ROLE', ['furs.issue'])
    expect(perms).toContain('furs.issue')
    expect(perms).toContain('orders.pay')
  })
})

describe('isValidPermission + PERMISSION_LABELS konsistentnost', () => {
  test('kanonične pravice so veljavne, druge ne (tudi non-string)', () => {
    for (const p of canonical) expect(isValidPermission(p)).toBe(true)
    expect(isValidPermission('orders.delete')).toBe(false)
    expect(isValidPermission('')).toBe(false)
    expect(isValidPermission(null)).toBe(false)
    expect(isValidPermission(42)).toBe(false)
    expect(isValidPermission(undefined)).toBe(false)
  })

  test('vsaka kanonična pravica ima oznako (UI prikaz)', () => {
    for (const p of canonical) {
      expect(typeof PERMISSION_LABELS[p]).toBe('string')
      expect(PERMISSION_LABELS[p].length).toBeGreaterThan(0)
    }
  })
})

describe('tab-permissions — OR-logika (OPS-4 v1.67.0)', () => {
  const baseCtx = { canManage: false }

  test('haccp: zadosti settings.manage ALI haccp.execute (kuhinja/čistilka vidita)', () => {
    expect(tabHasPerm('haccp', { ...baseCtx, perms: ['haccp.execute'] })).toBe(true)
    expect(tabHasPerm('haccp', { ...baseCtx, perms: ['settings.manage'] })).toBe(true)
    expect(tabHasPerm('haccp', { ...baseCtx, perms: ['orders.pay'] })).toBe(false)
  })

  test('izmene: cash.manage (bar) — natakar (orders.pay) NE vidi več', () => {
    expect(tabHasPerm('izmene', { ...baseCtx, perms: ['cash.manage'] })).toBe(true)
    expect(tabHasPerm('izmene', { ...baseCtx, perms: ['orders.pay'] })).toBe(false)
  })

  test('darilne: giftcards.manage — reports.view samo NE zadošča (premalo!)', () => {
    expect(tabHasPerm('darilne', { ...baseCtx, perms: ['giftcards.manage'] })).toBe(true)
    expect(tabHasPerm('darilne', { ...baseCtx, perms: ['reports.view'] })).toBe(false)
  })

  test('dostava: delivery.manage — orders.create NE zadošča', () => {
    expect(tabHasPerm('dostava', { ...baseCtx, perms: ['delivery.manage'] })).toBe(true)
    expect(tabHasPerm('dostava', { ...baseCtx, perms: ['orders.create'] })).toBe(false)
  })

  test('prodaja (nov tab): orders.pay — natakar in sank vidita, kuhinja ne', () => {
    expect(tabHasPerm('prodaja', { ...baseCtx, perms: ['orders.pay'] })).toBe(true)
    expect(tabHasPerm('prodaja', { ...baseCtx, perms: ['kitchen.update'] })).toBe(false)
  })

  test('canManage vseeno vidi vse; fail-closed za neznan tab ostaja', () => {
    expect(tabHasPerm('dostava', { canManage: true, perms: [] })).toBe(true)
    expect(tabHasPerm('neznan-tab', { ...baseCtx, perms: ['settings.manage'] })).toBe(false)
  })
})
