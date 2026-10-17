/**
 * Test 32-c — P1 točka 4 (audit §12): kritična testna pokritost `resolvePermissions`/`ROLE_DEFAULTS`.
 *
 * Čisti unit testi (brez DB) za src/lib/permissions.ts:
 *  - privzete matrice po vlogah (full set za owner/admin/enterprise; OMEJEN nabor za
 *    manager od issue #72 C1; podnabori za staff vloge);
 *  - vsak ROLE_DEFAULTS vnos ⊆ CANONICAL_PERMISSIONS (brez izmišljenih dovoljenj);
 *  - obveznice (overrides) so SAMO DODATNE — neznani/revocation nizi se ignorirajo
 *    (dejansko obnašanje implementacije: filter prek isValidPermission, KONFLIKTNO PRAVILO issue #1);
 *  - ISSUE #72 B4: neznana vloga → PRAZEN nabor (fail-closed; prej padec na staff
 *    je DELOVAL pravico do plačila).
 *  - ISSUE #72 D1/D2/D3/D4: ključi pomenijo točno to, kar piše (storno/izdaja
 *    e-računa/PII ločena/phantom odstranjen).
 * Fixture predpona: perms- (samo v komentarjih/imena testnih vlog — brez DB zapisa).
 */
import { describe, expect, test } from 'bun:test'
import {
  CANONICAL_PERMISSIONS,
  PERMISSION_LABELS,
  isValidPermission,
  resolvePermissions,
  resolvePermissionsForUIRole,
  effectivePermissionSets,
  isManagerialRole,
} from '@/lib/permissions'
import { tabHasPerm } from '@/lib/tab-permissions'

/** Vse vloge iz Prisma enuma EmployeeRole (schema.prisma) — pokritost vseh ROLE_DEFAULTS vnosov */
const ALL_DB_ROLES = [
  'owner', 'admin', 'manager', 'staff', 'waiter', 'bar', 'chef', 'kitchen',
  'group_owner', 'org_admin', 'property_manager', 'warehouse', 'accounting', 'cleaner',
] as const

/** ISSUE #72 C1: MANAGER ni več med polnimi vlogami — omejen nabor (19 ključev) */
const FULL_ROLES = ['owner', 'admin', 'group_owner', 'org_admin', 'property_manager']
const canonical = [...CANONICAL_PERMISSIONS]

const sortedEq = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join('|') === [...b].sort().join('|')

/** ISSUE #72 C1: vodja = operativa + kadri + poročila; BREZ settings.manage,
 * receipts.storno (fiskalna razveljavitev) in einvoices.issue. */
const MANAGER_EXPECTED = [
  'orders.create', 'orders.pay', 'apply_discounts', 'kitchen.update',
  'reservations.manage', 'menu.manage', 'inventory.manage',
  'reports.sales', 'reports.labour', 'guests.read', 'employees.manage',
  'orders.void', 'cash.manage', 'menu.availability', 'haccp.execute',
  'timeclock.manage', 'delivery.manage', 'giftcards.manage', 'discounts.manage',
] as const

describe('resolvePermissions — vloge s polnim naborom dovoljenj', () => {
  for (const role of FULL_ROLES) {
    test(`vloga "${role}" ima VSA kanonična dovoljenja`, () => {
      const perms = resolvePermissions(role, [])
      expect(sortedEq(perms, canonical)).toBe(true)
      expect(perms).toHaveLength(canonical.length)
    })
  }

  test('ISSUE #72 C1: vloga "manager" ima OMEJEN nabor (19) — brez globalnih stropov', () => {
    const perms = resolvePermissions('manager', [])
    expect(sortedEq(perms, [...MANAGER_EXPECTED])).toBe(true)
    // stropovi so LASTNIŠKI: globalne nastavitve, fiskalna razveljavitev, e-računi
    expect(perms).not.toContain('settings.manage')
    expect(perms).not.toContain('receipts.storno')
    expect(perms).not.toContain('einvoices.issue')
  })

  test('velike črke vloga se normalizira (DB/UI mešanica) — "MANAGER" omejen nabor', () => {
    expect(sortedEq(resolvePermissions('MANAGER', []), [...MANAGER_EXPECTED])).toBe(true)
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
    expect(perms).not.toContain('reports.sales')
    expect(perms).not.toContain('settings.manage')
  })

  test('ISSUE #72 D1/D2/D3/D4: 22 kanoničnih dovoljenj (stari 20 − 3 odstranjeni + 5 novih)', () => {
    expect(canonical).toHaveLength(22)
    for (const k of [
      'orders.void', 'cash.manage', 'menu.availability',
      'haccp.execute', 'timeclock.manage', 'delivery.manage', 'giftcards.manage',
      'discounts.manage',
      // issue #72: novi ključi pomenijo točno to, kar piše
      'receipts.storno', 'einvoices.issue', 'reports.sales', 'reports.labour', 'guests.read',
    ]) expect(canonical).toContain(k)
    // ODSTRANJENI (D1: furs.issue je varoval STORNO; D4: phantom; D3: razstavljen)
    expect(canonical).not.toContain('furs.issue')
    expect(canonical).not.toContain('orders.discount')
    expect(canonical).not.toContain('reports.view')
  })

  test('ISSUE #72 D3: warehouse = inventory.manage + reports.sales — BREZ PII in plačnih podatkov', () => {
    const perms = resolvePermissions('warehouse', [])
    expect(sortedEq(perms, ['inventory.manage', 'reports.sales'])).toBe(true)
    expect(perms).not.toContain('guests.read')
    expect(perms).not.toContain('reports.labour')
  })

  test('ISSUE #72 D2/D3: accounting = vsa poročila + PII (obračun) + izdaja e-računov', () => {
    expect(sortedEq(resolvePermissions('accounting', []), [
      'reports.sales', 'reports.labour', 'guests.read', 'einvoices.issue',
    ])).toBe(true)
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

  test('ISSUE #72 B4: neznana vloga → PRAZEN nabor (fail-closed; prej padec na staff)', () => {
    // prej: ROLE_DEFAULTS[role] ?? staff — tipkarska napaka je DELOVALA pravico do plačila
    const unknown = resolvePermissions('nonexistent-role-xyz', [])
    expect(unknown).toHaveLength(0)
    expect(unknown).not.toContain('orders.pay')
    expect(unknown).not.toContain('employees.manage')
    expect(unknown).not.toContain('settings.manage')
  })

  test('prazen roleDB niz → privzetek staff (falsy pomeni »vloga ni podana«, ne »neznana«)', () => {
    expect(sortedEq(resolvePermissions('', []), resolvePermissions('staff', []))).toBe(true)
  })
})

describe('permissionOverrides — dodatne obveznice (SAMO aditivne)', () => {
  test('override DODA manjkajoče dovoljenje in ohrani privzete vloge', () => {
    const base = resolvePermissions('waiter', [])
    const withExtra = resolvePermissions('waiter', ['menu.manage', 'reports.sales'])
    expect(withExtra).toContain('menu.manage')
    expect(withExtra).toContain('reports.sales')
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

  test('ISSUE #72 D1: star override "furs.issue" (odstranjen ključ) postane nedorazveljan — brez učinka', () => {
    // produkcijski podatki: 11/11 računov ima prazen override → brez živega učinka;
    // morebitni stari nizi se varno filtrirajo (isValidPermission)
    const base = resolvePermissions('waiter', [])
    const perms = resolvePermissions('waiter', ['furs.issue', 'reports.view', 'orders.discount'])
    expect(sortedEq(perms, base)).toBe(true)
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
    expect(sortedEq(resolvePermissionsForUIRole('warehouse', []), ['inventory.manage', 'reports.sales'])).toBe(true)
    expect(sortedEq(resolvePermissionsForUIRole('ACCOUNTING', []), ['reports.sales', 'reports.labour', 'guests.read', 'einvoices.issue'])).toBe(true)
  })

  test('neznana UI vloga → varni privzetek waiter podnabor (fail-closed)', () => {
    const perms = resolvePermissionsForUIRole('NOT_A_ROLE', [])
    expect(sortedEq(perms, resolvePermissions('waiter', []))).toBe(true)
    expect(perms).not.toContain('settings.manage')
  })

  test('neznana UI vloga z overrides → overrides se še vedno upoštevajo', () => {
    const perms = resolvePermissionsForUIRole('NOT_A_ROLE', ['receipts.storno'])
    expect(perms).toContain('receipts.storno')
    expect(perms).toContain('orders.pay')
  })
})

describe('ISSUE #72 A1: effectivePermissionSets — ločena vira za PRIKAZ', () => {
  test('natakar z override-i: 5 branih iz vloge + samo NOVI dodatki so "added"', () => {
    const eff = effectivePermissionSets('waiter', ['menu.manage', 'orders.pay'])
    expect(eff.fromRole).toHaveLength(5)
    // orders.pay je ŽE v vlogi → ni "dodatek", ampak redundantni zapis
    expect(eff.added).toEqual(['menu.manage'])
    expect(eff.roleDefaultCount).toBe(5)
  })

  test('C1: manager — 19 branih; settings.manage/receipts.storno sta dodatek (če jih admin da)', () => {
    const eff = effectivePermissionSets('manager', ['settings.manage'])
    expect(eff.fromRole).toHaveLength(19)
    expect(eff.added).toEqual(['settings.manage'])
  })
})

describe('ISSUE #72 A4: isManagerialRole — en vir resnice za vodstveni pogled', () => {
  test('MANAGER + centralne vloge so vodstvene', () => {
    for (const r of ['MANAGER', 'ADMIN', 'OWNER', 'GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER']) {
      expect(isManagerialRole(r)).toBe(true)
    }
  })

  test('operativne vloge NISO vodstvene', () => {
    for (const r of ['WAITER', 'BAR', 'KITCHEN', 'CHEF', 'CLEANER', 'WAREHOUSE', 'ACCOUNTING', undefined, null, '']) {
      expect(isManagerialRole(r)).toBe(false)
    }
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
    // ISSUE #72 D1/D4: odstranjena ključa nista več veljavna (stari override-i → nedorazveljani)
    expect(isValidPermission('furs.issue')).toBe(false)
    expect(isValidPermission('orders.discount')).toBe(false)
    expect(isValidPermission('reports.view')).toBe(false)
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

  test('darilne: giftcards.manage — reports.sales samo NE zadošča (premalo!)', () => {
    expect(tabHasPerm('darilne', { ...baseCtx, perms: ['giftcards.manage'] })).toBe(true)
    expect(tabHasPerm('darilne', { ...baseCtx, perms: ['reports.sales'] })).toBe(false)
  })

  test('ISSUE #72 D3: crm = guests.read (PII) — reports.sales NE zadošča več', () => {
    expect(tabHasPerm('crm', { ...baseCtx, perms: ['guests.read'] })).toBe(true)
    expect(tabHasPerm('crm', { ...baseCtx, perms: ['reports.sales'] })).toBe(false)
  })

  test('ISSUE #72 D3: napitnine = reports.labour (plačni podatki) — skladiščnik NE vidi', () => {
    expect(tabHasPerm('napitnine', { ...baseCtx, perms: ['reports.labour'] })).toBe(true)
    expect(tabHasPerm('napitnine', { ...baseCtx, perms: ['reports.sales'] })).toBe(false)
    expect(tabHasPerm('napitnine', { ...baseCtx, perms: ['inventory.manage'] })).toBe(false)
  })

  test('dostava: delivery.manage — orders.create NE zadošča', () => {
    expect(tabHasPerm('dostava', { ...baseCtx, perms: ['delivery.manage'] })).toBe(true)
    expect(tabHasPerm('dostava', { ...baseCtx, perms: ['orders.create'] })).toBe(false)
  })

  test('prodaja (nov tab): orders.pay — natakar in sank vidita, kuhinja ne', () => {
    expect(tabHasPerm('prodaja', { ...baseCtx, perms: ['orders.pay'] })).toBe(true)
    expect(tabHasPerm('prodaja', { ...baseCtx, perms: ['kitchen.update'] })).toBe(false)
  })

  test('ISSUE #72 C1: MANAGER vidi zavihke SKOZ lastne pravice — nastavitve izginejo', () => {
    const managerPerms = resolvePermissions('manager', [])
    expect(tabHasPerm('nastavitve', { canManage: false, perms: managerPerms })).toBe(false)
    expect(tabHasPerm('integracije', { canManage: false, perms: managerPerms })).toBe(false)
    expect(tabHasPerm('enterprise', { canManage: false, perms: managerPerms })).toBe(false)
    // operativa ostaja (isti vir kot backend)
    expect(tabHasPerm('zaposleni', { canManage: false, perms: managerPerms })).toBe(true)
    expect(tabHasPerm('racuni', { canManage: false, perms: managerPerms })).toBe(true)
    expect(tabHasPerm('obracun', { canManage: false, perms: managerPerms })).toBe(true)
  })

  test('canManage (centralna vloga) vidi vse; fail-closed za neznan tab ostaja', () => {
    expect(tabHasPerm('dostava', { canManage: true, perms: [] })).toBe(true)
    expect(tabHasPerm('neznan-tab', { ...baseCtx, perms: ['settings.manage'] })).toBe(false)
  })
})
