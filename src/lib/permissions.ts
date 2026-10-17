/**
 * Granularne pravice (GitLab issue #1, naloga 3).
 * - Kanonična dovoljenja (združljiva z obstoječimi permissionOverrides podatki)
 * - Privzete matrice po vlogah (DB vrednosti: admin|manager|staff|waiter|bar|chef|kitchen)
 * - Obveznice (overrides) so DODATNE pravice na vrhu vloge — nikoli ne odvzamejo
 * - Backend: requirePermission() (src/lib/api.ts) — DB lookup na vsak preverjan klic
 * - Frontend: /api/auth/login|me vračata resolved permissions za UI gating
 *
 * ISSUE #72 (v1.133.0) — ključi pomenijo točno to, kar piše:
 * - ODSTRANJEN 'furs.issue' (v resnici je varoval STORNO; izdaja FURS računa
 *   poteče ob plačilu naročila → orders.pay). Nadomestil ga je 'receipts.storno'.
 * - ODSTRANJEN 'orders.discount' (fantomski: deklariran, nikoli uveljavljen —
 *   limit popustov v resnici drži excDiscountApprovalPct iz exception politike).
 *   Stare override-vrednosti obeh ključev postanejo nedorazveljane
 *   (resolvePermissions filtrira neveljavne) — v produkciji 11/11 računov
 *   ima prazen override, torej brez učinka na žive podatke.
 * - 'reports.view' RAZSTAVLJEN (PII ločena od financ):
 *   · 'reports.sales'  — finančna/poslovna poročila, računi, stroški, zvestoba,
 *                        menu inženiring, izjeme, GL, izvozi
 *   · 'reports.labour' — napitnine (plačni podatki) + poročila dela
 *                        (labor-cost, labor-coverage)
 *   · 'guests.read'    — CRM gostov: e-naslovi, telefoni, privolitve (PII)
 * - DODAN 'einvoices.issue' — izdaja e-računov B2B (prej pod inventory.manage,
 *   kar je skladišniku dalo pravico do fiskalnega dokumenta).
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
  'reports.sales',
  'employees.manage',
  'settings.manage',
  // issue #72 D1: storno fiskalnega računa ima SVOJ ključ (prej furs.issue,
  // ki je zmotno zvenel kot »izdaja«; izdaja poteče z orders.pay)
  'receipts.storno',
  // issue #72 D2: izdaja e-računa B2B — ločeno od zalog (prej inventory.manage)
  'einvoices.issue',
  // OPS-4 matrica (v1.67.0) — 8 novih ključev za granularne vloge:
  'orders.void',
  'cash.manage',
  'menu.availability',
  'haccp.execute',
  'timeclock.manage',
  'delivery.manage',
  'giftcards.manage',
  // Issue #5 (P0-A): katalog promocij/popustov ločeno od UPORABE popusta na računu
  'discounts.manage',
  // issue #72 D3: PII in plačni podatki ločeni od finančnih poročil
  'reports.labour',
  'guests.read',
] as const

export type CanonicalPermission = (typeof CANONICAL_PERMISSIONS)[number]

export const PERMISSION_LABELS: Record<CanonicalPermission, string> = {
  'orders.create': 'Naročila — ustvarjanje',
  'orders.pay': 'Naročila — plačilo in izdaja računa (FURS)',
  'apply_discounts': 'Popusti — uporaba in upravljanje',
  'kitchen.update': 'Kuhinja/bar — status artiklov',
  'reservations.manage': 'Rezervacije — upravljanje',
  'menu.manage': 'Meni — upravljanje',
  'inventory.manage': 'Zaloge — upravljanje',
  'reports.sales': 'Poročila — prodaja, računi, stroški (finance)',
  'employees.manage': 'Zaposleni — upravljanje',
  'settings.manage': 'Nastavitve — upravljanje',
  'receipts.storno': 'Računi — storno (fiskalna razveljavitev)',
  'einvoices.issue': 'E-računi — izdaja (B2B)',
  // OPS-4 matrica (v1.67.0):
  'orders.void': 'Naročila — storno postavk (kritično)',
  'cash.manage': 'Blagajna — odpiranje/zapiranje izmene, no-sale',
  'menu.availability': 'Meni — razpoložljivost (86 / razprodano)',
  'haccp.execute': 'HACCP — izvedba kontrol in meritev',
  'timeclock.manage': 'Delovni čas — urejanje izmen drugih',
  'delivery.manage': 'Dostava — sprejem, statusi, cone',
  'giftcards.manage': 'Darilne kartice — izdaja, polnjenje',
  'discounts.manage': 'Popusti — urejanje kataloga promocij (ne uporaba)',
  'reports.labour': 'Poročila — delo in napitnine (plačni podatki)',
  'guests.read': 'Gosti — CRM vpogled (stiki, privolitve)',
}

/**
 * Privzete pravice po DB vlogi. Vloge iz sheme: owner|admin|manager|staff|waiter|bar|chef|kitchen
 * + enterprise (issue #11 §1): group_owner|org_admin|property_manager|warehouse|accounting.
 * Legacy (staff → natakar, chef/kitchen → kuhinja) ima iste privzete pravice.
 * KONFLIKTNO PRAVILO (issue #1, komentar: vloge): override-i so vedno DODATNA dovoljenja
 * na vrhu vloge — nikoli ne odvzamejo pravic vloge. To je edino pravilo.
 *
 * ISSUE #72 C1 (v1.133.0): MANAGER ni več LASTNIK — vodja dobi operativni + kadrovski
 * + poročilni nabor, BREZ globalnih stropov: settings.manage (denarna politika,
 * pragovi izjem, integracije, enterprise), receipts.storno (fiskalna razveljavitev).
 * Dodeljevanje teh dveh + ustvarjanje vodstvenih računov je rezervirano za
 * centralne vloge (glej assertCentralGrant v employees rutah, C2).
 */
const ROLE_DEFAULTS: Record<string, readonly CanonicalPermission[]> = {
  owner: CANONICAL_PERMISSIONS,
  admin: CANONICAL_PERMISSIONS,
  // issue #72 C1: vodja = operativa + kadri + poročila; brez settings.manage,
  // brez receipts.storno, brez einvoices.issue (fiskalni dokumenti = lastnik/računovodstvo)
  manager: [
    'orders.create', 'orders.pay', 'apply_discounts', 'kitchen.update',
    'reservations.manage', 'menu.manage', 'inventory.manage',
    'reports.sales', 'reports.labour', 'guests.read', 'employees.manage',
    'orders.void', 'cash.manage', 'menu.availability', 'haccp.execute',
    'timeclock.manage', 'delivery.manage', 'giftcards.manage', 'discounts.manage',
  ],
  // OPS-4 matrica: natakar dobi tudi 86 (razpoložljivost) — brez urejanja menija.
  staff: ['orders.create', 'orders.pay', 'apply_discounts', 'reservations.manage', 'menu.availability'],
  waiter: ['orders.create', 'orders.pay', 'apply_discounts', 'reservations.manage', 'menu.availability'],
  // OPS-4 matrica: sank dobi hitro prodajo (orders.pay), 86 pijač in svojo blagajno;
  // kitchen.update ostane (KDS filter po postaji se rešuje v UI/API, ne v ključu).
  bar: ['orders.create', 'orders.pay', 'apply_discounts', 'kitchen.update', 'menu.availability', 'cash.manage'],
  chef: ['kitchen.update', 'menu.availability', 'haccp.execute'],
  kitchen: ['kitchen.update', 'menu.availability', 'haccp.execute'],
  // OPS-4 (v1.67.0): NOVA vloga čistilke — samo izvedba HACCP kontrol + lastni delovni čas.
  cleaner: ['haccp.execute'],
  // issue #11 §1 — enterprise vloge
  group_owner: CANONICAL_PERMISSIONS,
  org_admin: CANONICAL_PERMISSIONS,
  property_manager: CANONICAL_PERMISSIONS,
  // issue #72 D3: skladiščnik izgubi PII (guests.read) in plačne podatke
  // (reports.labour) — dobi samo finančni vpogled prodaje (reports.sales)
  warehouse: ['inventory.manage', 'reports.sales'],
  // issue #72 D2/D3: računovodstvo — vsa poročila + PII gostov (obračun)
  // + izdaja e-računov (fiskalni dokument je računovodska pristojnost)
  accounting: ['reports.sales', 'reports.labour', 'guests.read', 'einvoices.issue'],
}

/** UI vloga (UPPERCASE iz žetona) → DB vloga za privzete pravice */
const UI_ROLE_TO_DB: Record<string, string> = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  WAITER: 'waiter',
  BAR: 'bar',
  KITCHEN: 'kitchen',
  CLEANER: 'cleaner',
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
  const defaults = roleDefaultsFor(role)
  const parsed = jparse<unknown>(overrides, [])
  const extra = Array.isArray(parsed)
    ? parsed.filter(isValidPermission)
    : []
  return Array.from(new Set([...defaults, ...extra]))
}

/**
 * Issue #72 B4: neznana vloga pade na PRAZEN nabor (fail-closed) — prej je
 * padla na natakarja (orders.create/pay + apply_discounts): tipkarska napaka
 * v enumu je tako DELOVALA pravico do plačila. Prazen nabor pomeni: samo
 * TAB_PERM_ALL zavihki (delovni čas, urnik …), vsak API ključ pa 403.
 * Metriko neznane vloge zapiši v dnevnik (klicalec).
 */
export function roleDefaultsFor(role: string): readonly CanonicalPermission[] {
  return ROLE_DEFAULTS[(role || '').toLowerCase()] ?? []
}

/** resolvePermissions z zapisom neznane vloge v dnevnik (issue #72 B4). */
export function resolvePermissionsStrict(roleDB: string, overrides: unknown, onUnknown?: (role: string) => void): CanonicalPermission[] {
  const key = (roleDB || '').toLowerCase()
  if (!(key in ROLE_DEFAULTS) && onUnknown) onUnknown(key)
  return resolvePermissions(key, overrides)
}

/** Razreši dovoljenja iz UI vloge (za žeton brez DB dostopa, npr. bootstrap) */
export function resolvePermissionsForUIRole(uiRole: string, overrides?: unknown): CanonicalPermission[] {
  const dbRole = UI_ROLE_TO_DB[uiRole?.toUpperCase()] ?? 'waiter'
  return resolvePermissions(dbRole, overrides)
}

/**
 * Issue #72 A4/C2: EN sam vir resnice za »vodstveni pogled«. Prej je pet
 * ločenih seznamov vlog teklo vzporedno (command-palette, finance-tab,
 * dashboard zavihki, employees strop …) — OWNER je npr. v ukazni paleti
 * manjkal, zato lastnik ni videl ukazov svojega vodje.
 */
export const MANAGERIAL_UI_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER'] as const

export function isManagerialRole(uiRole: unknown): boolean {
  return MANAGERIAL_UI_ROLES.includes(String(uiRole ?? '').toUpperCase() as (typeof MANAGERIAL_UI_ROLES)[number])
}

/**
 * Centralne vloge (nad vodjo) — enaka semantika kot strežniški isCentralRole
 * (src/lib/api.ts) in UI isCentralUIRole (src/lib/multilocation): OWNER/ADMIN.
 * Enterprise vloge (group_owner …) imajo sicer ves CANONICAL nabor pravic, a
 * stropovi C2 (dodeljevanje vlog/stropov) ostanejo nad njimi.
 */
export const CENTRAL_UI_ROLES = ['OWNER', 'ADMIN'] as const

/**
 * Issue #72 A1: efektivni nabor za PRIKAZ — ločena vira, ne lažna mreža.
 * Vrača pravice iz vloge (brane, neodstranljive) in dodane (odstranljive)
 * ter števca za povzetek na vrhu dialoga.
 */
export function effectivePermissionSets(roleDB: string, overrides: unknown): {
  fromRole: CanonicalPermission[]
  added: CanonicalPermission[]
  roleDefaultCount: number
} {
  const role = (roleDB || 'staff').toLowerCase()
  const fromRole = [...roleDefaultsFor(role)]
  const parsed = jparse<unknown>(overrides, [])
  const extra = Array.isArray(parsed) ? parsed.filter(isValidPermission) : []
  const added = extra.filter((p) => !fromRole.includes(p))
  return { fromRole, added, roleDefaultCount: fromRole.length }
}
