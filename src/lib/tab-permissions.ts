/**
 * UI dovoljenja zavihkov dashboarda (P2 audit — N8, fail-closed).
 *
 * Pravilo (issue #1, naloga 3 + N8): vsak zavihek ima IZRECEN vnos —
 * kanonično dovoljenje ALI '*' (viden vsem avtenticiranim zaposlenim).
 * - Neznan/undefined id zavihka → tabHasPerm() vrne FALSE (fail-closed).
 *   Prej je `hasPerm(undefined)` vrnil true in so zavihki brez vnosa
 *   (pregled, delovnicas, odpiralnicas) uhajali vsem — N8.
 * - Dovoljenja: src/lib/permissions.ts (ROLE_DEFAULTS — owner/admin/manager
 *   imajo vsa kanonična dovoljenja, ostale vloge po matrici).
 * - Backend uveljavlja neodvisno (requirePermission v API rutah) — ta lib je
 *   SAMO UI gating navigacije.
 */

/** Izrecen marker »zavihek za vse avtenticirane zaposlene« */
export const TAB_PERM_ALL = '*'

/** Zavihek → zahtevano dovoljenje (string ALI seznam — OR logika). Vsak zavihek iz TabsList MORA imeti vnos. */
export const TAB_PERM: Record<string, string | string[]> = {
  pregled: TAB_PERM_ALL, // Pregled — začetna stran (GET /api/dashboard = requireAuth)
  mize: 'orders.create',
  narocila: 'orders.create',
  kuhinja: 'kitchen.update',
  prodaja: 'orders.pay', // OPS-4 v1.67.0 — hitra prodaja (šank, brez mize)
  meni: 'menu.manage',
  rezervacije: 'reservations.manage',
  racuni: 'reports.view',
  popusti: 'apply_discounts', // Task 59 — admin upravljanje popustov (backend requirePermission apply_discounts)
  integracije: 'settings.manage', // Task 60 — admin integracije (backend requirePermission settings.manage)
  zaloge: 'inventory.manage',
  izmene: 'cash.manage', // OPS-4 v1.67.0 — blagajna izmena (open/close/no-sale) = cash.manage (bar + vodstvo)
  delovnicas: TAB_PERM_ALL, // Delovni čas — ura je za VSE zaposlene (samooskrba; ekipni del notri gating employees.manage)
  haccp: ['settings.manage', 'haccp.execute'], // OPS-4 v1.67.0 — urejanje načrtov (settings.manage) ALI izvedba kontrol (haccp.execute — kuhinja, čistilka)
  stroski: 'reports.view',
  zvestoba: 'reports.view',
  mnenja: 'reservations.manage',
  dostava: 'delivery.manage', // OPS-4 v1.67.0 — sprejem dostav/con = delivery.manage (vodstvo)
  napitnine: 'reports.view',
  nabava: 'inventory.manage',
  darilne: 'giftcards.manage', // OPS-4 v1.67.0 — izdaja/polnjenje darilnih kartic (vodstvo); lookup pri plačilu ostaja orders.pay
  odpad: 'inventory.manage',
  cakalna: 'reservations.manage',
  odpiralnicas: TAB_PERM_ALL, // Odpiralni čas — GET /api/opening-hours = requireAuth (»status koristni vsem«); urejanje notri gating settings.manage
  zaposleni: 'employees.manage',
  nastavitve: 'settings.manage',
  enterprise: 'settings.manage', // Task 62 — enterprise org/brand/property drevo (backend GET requireAuth, POST settings.manage)
}

export interface TabPermContext {
  /** centralne vloge in MANAGER vidijo vse zavihke (enako kot do zdaj v page.tsx) */
  canManage: boolean
  /** razrešena dovoljenja prijavljenega (/api/auth/me) — prazna PRED nalaganjem */
  perms: string[]
}

/**
 * Ali sme prijavljeni videti zavihek? FAIL-CLOSED:
 * - neznan/undefined/prazen id zavihka → false (N8: prej true),
 * - zavihek brez vnosa v TAB_PERM → false,
 * - '*' → true za vse,
 * - pred nalaganjem dovoljenj (perms prazna) pokaži vse — permisivno, da UI
 *   ne utripa (obstoječe vedenje page.tsx, dokumentirano v izvorni kodi);
 *   backend uveljavlja dovoljenja neodvisno.
 */
export function tabHasPerm(tabId: string | undefined | null, ctx: TabPermContext): boolean {
  const perm = tabId ? TAB_PERM[tabId] : undefined
  if (!perm) return false // fail-closed — neznan/undefined tab ali manjkajoč vnos
  if (perm === TAB_PERM_ALL) return true
  if (ctx.canManage) return true
  if (ctx.perms.length === 0) return true // pred nalaganjem dovoljenj (stabilen UI)
  // OR-logika (OPS-4 v1.67.0): seznam = zadosti ENO izmed dovoljenj (npr. haccp)
  if (Array.isArray(perm)) return perm.some((p) => ctx.perms.includes(p))
  return ctx.perms.includes(perm)
}
