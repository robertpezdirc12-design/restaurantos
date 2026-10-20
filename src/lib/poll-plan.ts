/**
 * v1.164.0 — načrt periodičnega osveževanja (zmanjšanje Neon egressa).
 *
 * Dashboard loči dva cikla: »hot« (15 s) za operativne vire, ki se res
 * spreminjajo — statistika, mize, naročila, kuhinja — in »full« (60 s), ki
 * doda počasne vire (meni, rezervacije, računi, izmene). Naprave (handheld,
 * tablica) osvežijo meni vsak 4. 15-sekundni cikel; mize in naročila ostanejo
 * na 15 s. Strežniška validacija naročila ostaja varnostna mreža za morebitno
 * zastarelo razpoložljivost v meniju.
 */

export type DashboardPollScope = 'hot' | 'full'
export type DashboardPollResource =
  | 'stats'
  | 'tables'
  | 'orders'
  | 'kitchen'
  | 'menus'
  | 'reservations'
  | 'furs'
  | 'shifts'

const HOT_RESOURCES: ReadonlySet<DashboardPollResource> = new Set([
  'stats',
  'tables',
  'orders',
  'kitchen',
])

export function dashboardPollIncludes(scope: DashboardPollScope, resource: DashboardPollResource): boolean {
  if (scope === 'full') return true
  return HOT_RESOURCES.has(resource)
}

/** Meni na napravah: vsak 4. cikel (ob 15 s => 60 s). */
export const MENU_REFRESH_EVERY = 4

export function menuRefreshDue(tick: number): boolean {
  return tick % MENU_REFRESH_EVERY === 0
}
