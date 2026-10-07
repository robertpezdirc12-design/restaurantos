/**
 * Granularne pravice (GitLab issue #1, naloga 3).
 * - Kanonična dovoljenja (združljiva z obstoječimi permissionOverrides podatki)
 * - Privzete matrice po vlogah (DB vrednosti: admin|manager|staff|waiter|bar|chef|kitchen)
 * - Obveznice (overrides) so DODATNE pravice na vrhu vloge — nikoli ne odvzamejo
 * - Backend: requirePermission() (src/lib/api.ts) — DB lookup na vsak preverjan klic
 * - Frontend: /api/auth/login|me vračata resolved permissions za UI gating
 */
import { jparse } from '@/lib/map'

export const CANONICAL_PERMISSIONS = [
  'orders.create',
  'orders.pay',
  'apply_discounts',
  'kitchen.update',
  'reservations.manage',
  'menu.manage',
  'inventory.manage',
  'reports.view',
  'employees.manage',
  'settings.manage',
  'furs.issue',
] as const

export type CanonicalPermission = (typeof CANONICAL_PERMISSIONS)[number]

export const PERMISSION_LABELS: Record<CanonicalPermission, string> = {
  'orders.create': 'Naročila — ustvarjanje',
  'orders.pay': 'Naročila — plačilo izdaja',
  'apply_discounts': 'Popusti — uporaba in upravljanje',
  'kitchen.update': 'Kuhinja/bar — status artiklov',
  'reservations.manage': 'Rezervacije — upravljanje',
  'menu.manage': 'Meni — upravljanje',
  'inventory.manage': 'Zaloge — upravljanje',
  'reports.view': 'Poročila in računi — vpogled',
  'employees.manage': 'Zaposleni — upravljanje',
  'settings.manage': 'Nastavitve — upravljanje',
  'furs.issue': 'FURS — izdaja',
}

/**
 * Privzete pravice po DB vlogi. Vloge iz sheme: owner|admin|manager|staff|waiter|bar|chef|kitchen
 * + enterprise (issue #11 §1): group_owner|org_admin|property_manager|warehouse|accounting.
 * Legacy (staff → natakar, chef/kitchen → kuhinja) ima iste privzete pravice.
 * KONFLIKTNO PRAVILO (issue #1, komentar: vloge): override-i so vedno DODATNA dovoljenja
 * na vrhu vloge — nikoli ne odvzamejo pravic vloge. To je edino pravilo.
 */
const ROLE_DEFAULTS: Record<string, readonly CanonicalPermission[]> = {
  owner: CANONICAL_PERMISSIONS,
  admin: CANONICAL_PERMISSIONS,
  manager: CANONICAL_PERMISSIONS,
  staff: ['orders.create', 'orders.pay', 'apply_discounts', 'reservations.manage'],
  waiter: ['orders.create', 'orders.pay', 'apply_discounts', 'reservations.manage'],
  bar: ['orders.create', 'apply_discounts', 'kitchen.update'],
  chef: ['kitchen.update'],
  kitchen: ['kitchen.update'],
  // issue #11 §1 — enterprise vloge
  group_owner: CANONICAL_PERMISSIONS,
  org_admin: CANONICAL_PERMISSIONS,
  property_manager: CANONICAL_PERMISSIONS,
  warehouse: ['inventory.manage', 'reports.view'],
  accounting: ['reports.view'],
}

/** UI vloga (UPPERCASE iz žetona) → DB vloga za privzete pravice */
const UI_ROLE_TO_DB: Record<string, string> = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  WAITER: 'waiter',
  BAR: 'bar',
  KITCHEN: 'kitchen',
  GROUP_OWNER: 'group_owner',
  ORG_ADMIN: 'org_admin',
  PROPERTY_MANAGER: 'property_manager',
  WAREHOUSE: 'warehouse',
  ACCOUNTING: 'accounting',
}

export function isValidPermission(p: unknown): p is CanonicalPermission {
  return typeof p === 'string' && (CANONICAL_PERMISSIONS as readonly string[]).includes(p)
}

/**
 * Razreši končni niz dovoljenj: privzete po vlogi + dodatne obveznice.
 * @param roleDB vloga v DB obliki (lowercase) — lahko tudi UI oblika, normalizira
 * @param overrides permissionOverrides iz DB (Json/String — seznam dovoljenj)
 */
export function resolvePermissions(roleDB: string, overrides: unknown): CanonicalPermission[] {
  const role = (roleDB || 'staff').toLowerCase()
  const defaults = ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.staff
  const parsed = jparse<unknown>(overrides, [])
  const extra = Array.isArray(parsed)
    ? parsed.filter(isValidPermission)
    : []
  return Array.from(new Set([...defaults, ...extra]))
}

/** Razreši dovoljenja iz UI vloge (za žeton brez DB dostopa, npr. bootstrap) */
export function resolvePermissionsForUIRole(uiRole: string, overrides?: unknown): CanonicalPermission[] {
  const dbRole = UI_ROLE_TO_DB[uiRole?.toUpperCase()] ?? 'waiter'
  return resolvePermissions(dbRole, overrides)
}
