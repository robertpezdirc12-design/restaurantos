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
 * Privzete pravice po DB vlogi. Vloge iz sheme: admin|manager|staff|waiter|bar|chef|kitchen.
 * Legacy (staff → natakar, chef/kitchen → kuhinja) ima iste privzete pravice.
 */
const ROLE_DEFAULTS: Record<string, readonly CanonicalPermission[]> = {
  admin: CANONICAL_PERMISSIONS,
  manager: CANONICAL_PERMISSIONS,
  staff: ['orders.create', 'orders.pay', 'reservations.manage'],
  waiter: ['orders.create', 'orders.pay', 'reservations.manage'],
  bar: ['orders.create', 'kitchen.update'],
  chef: ['kitchen.update'],
  kitchen: ['kitchen.update'],
}

/** UI vloga (UPPERCASE iz žetona) → DB vloga za privzete pravice */
const UI_ROLE_TO_DB: Record<string, string> = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  WAITER: 'waiter',
  BAR: 'bar',
  KITCHEN: 'kitchen',
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
