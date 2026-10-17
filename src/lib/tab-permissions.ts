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
  inzeniring: 'reports.view', // OPS-8 v1.71.0 — menu engineering (Kasavana-Smith kvadrant; GET /api/menu-engineering = reports.view)
  popusti: 'discounts.manage', // Issue #5 P0-A — katalog promocij = discounts.manage (vodstvo); UPORABA popusta ob plačilu ostaja apply_discounts (natakar)
  integracije: 'settings.manage', // Task 60 — admin integracije (backend requirePermission settings.manage)
  zaloge: 'inventory.manage',
  izmene: 'cash.manage', // OPS-4 v1.67.0 — blagajna izmena (open/close/no-sale) = cash.manage (bar + vodstvo)
  delovnicas: TAB_PERM_ALL, // Delovni čas — ura je za VSE zaposlene (samooskrba; ekipni del notri gating employees.manage)
  urnik: TAB_PERM_ALL, // OPS-7: urnik izmen — pogled svojih izmen za vse; urejanje gating timeclock.manage (notri + backend)
  haccp: ['settings.manage', 'haccp.execute'], // OPS-4 v1.67.0 — urejanje načrtov (settings.manage) ALI izvedba kontrol (haccp.execute — kuhinja, čistilka)
  stroski: 'reports.view',
  zvestoba: 'reports.view',
  mnenja: 'reservations.manage',
  crm: 'reports.view', // Issue #11 (v1.126.0) — CRM gostov (ogled segmentov/gostov = reports.view; mutacije soglasja/kampanj/izvoz = settings.manage strežniško)
  dostava: 'delivery.manage', // OPS-4 v1.67.0 — sprejem dostav/con = delivery.manage (vodstvo)
  napitnine: 'reports.view',
  obracun: 'employees.manage', // Issue #22 (v1.115.0) — obračunsko obdobje + izvoz (backend requirePermission employees.manage)
  prenosi: 'inventory.manage', // Issue #8 (v1.116.0) — medlokacijski prenosi zalog (backend requirePermission inventory.manage)
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
 * - PRAZNA dovoljenja = fail-closed (issue #6 §F: prej permisivno "pred nalaganjem",
 *   da UI ne utripa — a v1.88.0 inicializacija iz localStorage je SINHRONA, zato
 *   stanja "pred nalaganjem" ni več; prazen seznam pomeni RESNIČNO brez dovoljenj
 *   in ne sme odpreti privilegiranih panelov). Backend uveljavlja neodvisno.
 */
export function tabHasPerm(tabId: string | undefined | null, ctx: TabPermContext): boolean {
  const perm = tabId ? TAB_PERM[tabId] : undefined
  if (!perm) return false // fail-closed — neznan/undefined tab ali manjkajoč vnos
  if (perm === TAB_PERM_ALL) return true
  if (ctx.canManage) return true
  // issue #6 §F: perms.length === 0 → ostanejo samo TAB_PERM_ALL zavihki (fail-closed)
  // OR-logika (OPS-4 v1.67.0): seznam = zadosti ENO izmed dovoljenj (npr. haccp)
  if (Array.isArray(perm)) return perm.some((p) => ctx.perms.includes(p))
  return ctx.perms.includes(perm)
}

/**
 * Issue #5 (P1-A): začetni zavihek po vlogi/dovoljenjih po prijavi.
 * Vrne { tab, station } — dashboard URL: /dashboard?tab=<tab>[&station=<station>].
 * Pravila (iz issue #5 §B delovni profili):
 *  - centralne vloge + MANAGER → pregled (poslovni nadzor);
 *  - KITCHEN/CHEF → kuhinja (KDS); BAR → prodaja (hitra prodaja šanka);
 *  - WAITER/STAFF → mize (mapsView natakarja);
 *  - CLEANER → haccp (dovoljene kontrole) ali delovnicas;
 *  - enterprise warehouse → zaloge; accounting → racuni.
 * Dovoljenja (perms) vedno premagajo vlogo — vrstni red: vloga → preverba dovoljenja
 * (npr. BAR brez orders.pay pade na mize). URL param NE poviša pravic (backend neodvisno).
 */
export function landingTab(uiRole: string, perms: string[]): { tab: string; station?: string } {
  const has = (p: string) => perms.includes(p)
  const role = (uiRole || '').toUpperCase()
  if (role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER') return { tab: 'pregled' }
  if (role === 'GROUP_OWNER' || role === 'ORG_ADMIN' || role === 'PROPERTY_MANAGER') return { tab: 'pregled' }
  if (role === 'ACCOUNTING') return { tab: has('reports.view') ? 'racuni' : 'pregled' }
  if (role === 'WAREHOUSE') return { tab: has('inventory.manage') ? 'zaloge' : 'pregled' }
  if (role === 'KITCHEN' || role === 'CHEF') return { tab: 'kuhinja' }
  if (role === 'BAR') return { tab: has('orders.pay') ? 'prodaja' : 'mize' }
  if (role === 'CLEANER') return { tab: has('haccp.execute') ? 'haccp' : 'delovnicas' }
  // WAITER / STAFF / neznane vloge
  return { tab: 'mize' }
}
