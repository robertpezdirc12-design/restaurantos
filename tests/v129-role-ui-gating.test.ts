/**
 * v1.129.0 — regresijski testi UI gatinga po vlogah (POS benchmark izboljšave).
 *
 * Varuje:
 *  A. HaccpTab: canManagePlans=false (čistilka/haccp.execute BREZ settings.manage)
 *     → urejevalnik načrtov in CSV izvoz sta skrita (izvajalni vmesnik ostane);
 *  B. InventoryTab: onNavigate prop → akcijske bližnjice (nabava/prenosi/odpad);
 *  C. tab-permissions: CLEANER vidi SAMO pregled/haccp/delovnicas/urnik/odpiralnicas,
 *     WAREHOUSE pristane na zaloge, aktivni zavihek je VEDNO viden v vrstici;
 *  D. dashboard API: yesterdayRevenue (Δ% vs včeraj) — waiter brez finančnega
 *     dovoljenja dobi null/0, admin dobi številko.
 * Staticna analiza (regex na izvornih datotekah) + enotski testi logike —
 * brez rendera (DOM testi so projektov ESLint-higiene).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tabHasPerm, landingTab } from '../src/lib/tab-permissions'
import { resolvePermissions } from '../src/lib/permissions'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('v1.129.0 A — HaccpTab: canManagePlans gating (čistilka)', () => {
  const src = read('src/components/tabs/haccp-tab.tsx')
  test('prop canManagePlans obstaja in poganja HaccpPlansSection + CSV', () => {
    expect(src).toContain('canManagePlans')
    expect(src).toContain('{canManagePlans && <HaccpPlansSection />}')
    expect(src).toContain('{canManage && (')
    expect(src).toContain('exportCsv')
  })
  test('ScheduleBoard (termini) ostaja vidna izvajalcem', () => {
    expect(src).toMatch(/<ScheduleBoard[^>]*canManage=\{canManagePlans\}/)
    // osnovna plošča termina NI pogojena z canManagePlans
    expect(src).toContain('<ScheduleBoard')
  })
})

describe('v1.129.0 B — InventoryTab: akcijske bližnjice skladiščnika', () => {
  const src = read('src/components/tabs/zaloga-tab.tsx')
  test('onNavigate prop + inv-actions regija s 3 dejanji', () => {
    expect(src).toContain('onNavigate?: (tab: string) => void')
    expect(src).toContain('data-region="inv-actions"')
    expect(src).toContain("'nabava'")
    expect(src).toContain("'prenosi'")
    expect(src).toContain("'odpad'")
  })
  test('badge pod minimumom na nabavni bližnjici', () => {
    expect(src).toContain('a.badge')
    expect(src).toContain('low.length')
  })
})

describe('v1.129.0 C — tab gating po vlogah (čistilka/skladiščnik)', () => {
  const cleaner = { canManage: false, perms: resolvePermissions('cleaner', []) }
  const warehouse = { canManage: false, perms: resolvePermissions('warehouse', []) }
  test('čistilka: haccp DA, finančni/meni/zaloge NE', () => {
    expect(cleaner.perms).toContain('haccp.execute')
    expect(tabHasPerm('haccp', cleaner)).toBe(true)
    expect(tabHasPerm('pregled', cleaner)).toBe(true)
    expect(tabHasPerm('racuni', cleaner)).toBe(false)
    expect(tabHasPerm('meni', cleaner)).toBe(false)
    expect(tabHasPerm('zaloge', cleaner)).toBe(false)
    expect(tabHasPerm('zaposleni', cleaner)).toBe(false)
  })
  test('skladiščnik: zaloge/nabava/prenosi/odpad DA, miz/kuhinja NE', () => {
    expect(tabHasPerm('zaloge', warehouse)).toBe(true)
    expect(tabHasPerm('nabava', warehouse)).toBe(true)
    expect(tabHasPerm('prenosi', warehouse)).toBe(true)
    expect(tabHasPerm('odpad', warehouse)).toBe(true)
    expect(tabHasPerm('mize', warehouse)).toBe(false)
    expect(tabHasPerm('kuhinja', warehouse)).toBe(false)
    expect(tabHasPerm('racuni', warehouse)).toBe(true) // reports.view
  })
  test('landingTab: CLEANER→haccp, WAREHOUSE→zaloge', () => {
    expect(landingTab('CLEANER', cleaner.perms).tab).toBe('haccp')
    expect(landingTab('WAREHOUSE', warehouse.perms).tab).toBe('zaloge')
  })
  test('aktivni zavihek je vedno viden v vrstici (page.tsx filter)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('DASHBOARD_PRIMARY_TABS.has(v) || v === activeTab')
  })
})

describe('v1.129.0 D — dashboard API: yesterdayRevenue za Δ%', () => {
  const api = read('src/app/api/dashboard/route.ts')
  test(' agregat včerajšnjega prometa obstaja (Toast/Square Δ vzorec)', () => {
    expect(api).toContain('yesterdayRevenue')
    expect(api).toContain('startOfYesterday')
    expect(api).toContain('showFinancial')
  })
})

describe('v1.129.0 E — KDS vizualni popravek (tailwind-merge past)', () => {
  const page = read('src/app/dashboard/page.tsx')
  test('starostni LEVI rob: enoten vir kdsAgeBorderCls (issue #74 V-3 pet stopenj) + stale pas', () => {
    // tailwind-merge odstrani border-l-{color}, če pride celovit border-{color} ZA njim.
    // v1.135.0 (issue #74 V-3): starostni razred izračuna enoten vir kdsAgeClass/
    // kdsAgeBorderCls v src/lib/kds-delays.ts (prej dve kopiji logike z pragoma 5/10);
    // vrstni red razredov varuje tests/issue74-visual.test.ts (regex na kdsAgeBorderCls).
    expect(page).toContain('kdsAgeBorderCls(ageCls)')
    expect(page).toContain("stale ? 'border-dashed border-stone-300 border-l-stone-300 bg-stone-50'")
    expect(page).toContain('kdsAgePillCls(ageCls)')
  })
  test('all-day vrstica je LEPLJIVA na dnu zaslona (Toast production view)', () => {
    expect(page).toContain('data-region="kds-allday"')
    expect(page).toContain('className="sticky bottom-0 z-10')
  })
  test('v1.131.1: all-day čipi so ENOVrstIČNI z horizontalnim drsenjem (nowrap) — ovijanje je na mobilnem naredilo blok višji od zaslona (878px > 844), sticky ni mogel prilepiti (izmerjeno bottom 1137 > vh 844)', () => {
    expect(page).toContain('overflow-x-auto flex-nowrap')
    expect(page).toContain('shrink-0 whitespace-nowrap')
  })
})

describe('v1.131.0 F — sistemski popravek obrob (unlayered border-color past)', () => {
  const css = read('src/app/globals.css')
  test('rafinirana barva obrobe je VEZANA na :not([class*="border-"]) — ekspresne utilitie prevladajo', () => {
    // prej: neplasteno [data-slot=card]{border-color} je premagalo VSE utilitije
    // (hover:*, border-l-* starostnega roba KDS, border-amber-300 all-day, aktivni
    // žetoni na plačilni strani gosta). @layer components ni zanesljiv (Turbopack
    // ga v dev odstrani) → :not([class*="border-"]) je plast-agnostična varovalka.
    expect(css).toContain('[data-slot="card"]:not([class*="border-"])')
    expect(css).toContain('.rounded-xl.border:not([class*="border-"])')
    expect(css).toContain('.rounded-lg.border:not([class*="border-"])')
    // senca in prehod ostajata za VSE površine (brez :not) — izgled kartic se ne spremeni
    expect(css).toContain('[data-slot="card"], .rounded-xl.border, .rounded-lg.border {')
  })
  test('hover barva obrobe prav tako vezana na :not (hover utilitie zadihajo)', () => {
    expect(css).toContain('[data-slot="card"]:not([class*="border-"]):hover')
  })
})
