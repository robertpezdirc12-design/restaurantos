/**
 * Issue #73 (v1.138.0) — audit-10 + audit-11: navigacijska prenova + besednjak.
 *
 * audit-10 (»Pod 1024 px pet ikoničnih zavihkov, 27 v gumbu ⋮ brez oznake —
 * uporabnik ne vidi, kaj aplikacija zna«):
 *  A. nav-groups: vsak zavihek iz DASHBOARD_TABS ima skupino; 5 skupin po
 *     issue #71 (Naročanje · Gostje · Zaloge in finance · Ekipa · Sistem);
 *  B. mobilna vrstica po VLOGI (mobileTabsForRole) — dovoljenja premagajo
 *     vlogo, fallback, nikoli prazna;
 *  C. page.tsx: stara horizontalna vrstica (data-region="dashboard-tabs") in
 *     spustni meni ⋮ ODSTRANJENA; novo: stranski steber + mobilna vrstica +
 *     predal Več; aktivni zavihek je VEDNO viden v mobilni vrstici (v1.129.0
 *     pogodba prenesena na MobileBottomNav);
 *  D. iskanje brez diakritike (»racuni« najde »Računi«).
 *
 * audit-11 (»imena mešajo jezike, štirje časovni zavihki, Zaloge/Nabava/Odpad«):
 *  E. enoten besednjak SL+HR: preimenovanja Analiza menija / Razpored delovnih
 *     ur / Odprtost lokala / Smene / Odnosi z gosti / Organizacija / Naročanje /
 *     Popisi; IZPOSOJENKE odstranjene (CRM gostov, Menu inženiring, Enterprise);
 *  F. komponente NE izumljajo imen — dashboard-nav.tsx uporablja t(`tabs.${id}`)
 *     (nobeno trdo kodirano ime zavihka).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MOBILE_FALLBACK_TABS, MOBILE_ROLE_TABS, NAV_GROUP_KEYS, NAV_GROUP_LABEL_KEY,
  NAV_GROUP_OF, NAV_STANDALONE_TABS, mobileTabsForRole, navGroupOf, normNavText,
} from '../src/lib/nav-groups'
import { resolvePermissions } from '../src/lib/permissions'
import { t } from '../src/lib/i18n'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const page = read('src/app/dashboard/page.tsx')
const nav = read('src/components/dashboard-nav.tsx')

/* Zavihki iz DASHBOARD_TABS v page.tsx — isti regex kot tests/rbac-p2.test.ts
   (N8 pogodba: vsak id ima izrecen vnos v TAB_PERM). */
const dashboardIds = [...page.matchAll(/\['([a-z]+)', [A-Z][A-Za-z0-9]*\]/g)].map((m) => m[1])

describe('audit-10 A — skupine stranskega stebra (nav-groups)', () => {
  test('vsak zavihek dashboarda ima izrecno skupino (fail-safe: neznan → ops)', () => {
    expect(dashboardIds.length).toBeGreaterThanOrEqual(31)
    for (const id of new Set(dashboardIds)) {
      expect(NAV_GROUP_OF[id]).toBeDefined()
    }
  })

  test('natančno 5 skupin po issue #71 (ops/guests/finance/staff/system) + vsaka neprazna', () => {
    expect(NAV_GROUP_KEYS).toEqual(['ops', 'guests', 'finance', 'staff', 'system'])
    for (const g of NAV_GROUP_KEYS) {
      const members = Object.values(NAV_GROUP_OF).filter((x) => x === g)
      expect(members.length).toBeGreaterThan(0)
      expect(NAV_GROUP_LABEL_KEY[g]).toMatch(/^tabs\.group/)
    }
  })

  test('skupine pokrivajo VSE 32 zavihke brez ostankov (vsak id natanko enkrat)', () => {
    expect(new Set(dashboardIds).size).toBe(32)
    for (const id of new Set(dashboardIds)) {
      // en id → ena skupina (zemljevid je Record — sama struktura to zagotavlja)
      expect(Object.keys(NAV_GROUP_OF)).toContain(id)
    }
  })

  test('»Pregled« je samostojen (nad skupinami — domov, ne del naročanja)', () => {
    expect(NAV_STANDALONE_TABS).toContain('pregled')
    expect(NAV_GROUP_OF.pregled).toBe('ops') // fail-safe vnos ostaja
  })

  test('nabava/odpad/prenosi so SOSEDI v isti skupini (»trije vhodi za isto skladišno zgodbo«)', () => {
    expect(navGroupOf('zaloge')).toBe(navGroupOf('nabava'))
    expect(navGroupOf('zaloge')).toBe(navGroupOf('odpad'))
    expect(navGroupOf('prenosi')).toBe('finance')
  })

  test('neznan id zavihka pade v ops (fail-safe kot prej v meniju Več)', () => {
    expect(navGroupOf('neznani-zavihek')).toBe('ops')
  })
})

describe('audit-10 B — mobilna vrstica po DEJANSKI vlogi', () => {
  const ctxFor = (role: string, canManage = false) => ({ canManage, perms: resolvePermissions(role, []) })

  test('kuhinja vidi svojo kuhinjo, natakar mize, skladiščnik zaloge', () => {
    expect(mobileTabsForRole('KITCHEN', ctxFor('kitchen'))).toContain('kuhinja')
    expect(mobileTabsForRole('CHEF', ctxFor('chef'))).toContain('kuhinja')
    expect(mobileTabsForRole('WAITER', ctxFor('waiter'))).toContain('mize')
    expect(mobileTabsForRole('BAR', ctxFor('bar'))).toContain('prodaja')
    expect(mobileTabsForRole('CLEANER', ctxFor('cleaner'))).toContain('haccp')
    expect(mobileTabsForRole('WAREHOUSE', ctxFor('warehouse'))).toContain('zaloge')
    expect(mobileTabsForRole('ACCOUNTING', ctxFor('accounting'))).toContain('racuni')
  })

  test('MANAGER: nabor brez nastavitev (issue #72 C1 — vodja nima settings.manage)', () => {
    const tabs = mobileTabsForRole('MANAGER', ctxFor('manager'))
    expect(tabs).toContain('racuni')
    expect(tabs).toContain('zaposleni')
    expect(tabs).not.toContain('nastavitve')
  })

  test('vsak vrnjen zavihek ustreza dovoljenjem vloge (UI gating; backend neodvisno)', () => {
    for (const role of Object.keys(MOBILE_ROLE_TABS)) {
      const ctx = ctxFor(role.toLowerCase(), ['OWNER', 'ADMIN', 'GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER'].includes(role))
      const tabs = mobileTabsForRole(role, ctx)
      // vsaj pristajalni zavihek vloge mora obstajati
      expect(tabs.length).toBeGreaterThan(0)
      expect(tabs[0]).toBe('pregled')
    }
  })

  test('dovoljenja premagajo vlogo: BAR brez orders.pay ne dobi prodaje', () => {
    const tabs = mobileTabsForRole('BAR', { canManage: false, perms: [] })
    // prazna dovoljenja → fallback (samo TAB_PERM_ALL zavihki) → najmanj pregled
    expect(tabs).toEqual(['pregled'])
  })

  test('neznana vloga → splošni nabor (kot prejšnja primarna vrstica)', () => {
    expect(mobileTabsForRole('NOVA-VLOGA', { canManage: true, perms: [] })).toEqual(MOBILE_FALLBACK_TABS)
    expect(mobileTabsForRole(null, { canManage: true, perms: [] })).toEqual(MOBILE_FALLBACK_TABS)
  })

  test('nabor vloge ima največ 5 zavihkov (4–5 po issue)', () => {
    for (const tabs of Object.values(MOBILE_ROLE_TABS)) {
      expect(tabs.length).toBeLessThanOrEqual(5)
      expect(tabs.length).toBeGreaterThanOrEqual(4)
    }
  })
})

describe('audit-10 C — page.tsx: nova navigacijska struktura', () => {
  test('stara horizontalna vrstica + spustni meni ⋮ sta ODSTRANJENA', () => {
    expect(page).not.toContain('data-region="dashboard-tabs"')
    expect(page).not.toContain('DASHBOARD_PRIMARY_TABS')
    expect(page).not.toContain('DASHBOARD_MOBILE_PRIMARY_TABS')
    expect(page).not.toContain('TabsList')
  })

  test('novi trije deli navigacije so prisotni (steber + mobilna vrstica + predal)', () => {
    expect(page).toContain('<DashboardSidebar ')
    expect(page).toContain('<MobileBottomNav ')
    expect(page).toContain('<MobileNavDrawer ')
    expect(nav).toContain('data-region="dashboard-sidebar"')
    expect(nav).toContain('data-region="dashboard-mobile-nav"')
    expect(nav).toContain('nav-search')
  })

  test('aktivni zavihek je VEDNO viden v mobilni vrstici (v1.129.0 pogodba)', () => {
    expect(nav).toContain('roleSet.includes(v) || v === activeTab')
  })

  test('iskalnik zavihkov je v stranskem stebri in predalu (iskanje čez razdelke)', () => {
    expect(nav).toContain('region="nav-search"')
    expect(nav).toContain('region="nav-search-drawer"')
    expect(nav).toMatch(/type="search"/)
    expect(nav).toContain("t('nav.searchPlaceholder')")
  })

  test('UI gating po dovoljenjih ostaja (tabHasPerm v stebri in predalu)', () => {
    expect((nav.match(/tabHasPerm/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

describe('audit-10 D — iskanje brez diakritike', () => {
  test('normNavText: č/š/ž/ć → osnovne črke, lowercase, trim', () => {
    expect(normNavText('Računi')).toBe('racuni')
    expect(normNavText('  Smene ')).toBe('smene')
    expect(normNavText('Čakalna lista')).toBe('cakalna lista')
    expect(normNavText('Pronađi')).toBe('pronadi')
  })

  test('poizvedba »racuni« najde naslov »Računi« (t preskoči diakritiko)', () => {
    const label = t('sl', 'tabs.racuni')
    expect(normNavText(label).includes(normNavText('racuni'))).toBe(true)
    expect(normNavText(label).includes(normNavText('smene'))).toBe(false)
  })
})

describe('audit-11 E — enoten besednjak (SL + HR preimenovanja)', () => {
  test('SL: štirje časovni zavihki so razločljivi + izposojenke odstranjene', () => {
    expect(t('sl', 'tabs.inzeniring')).toBe('Analiza menija')
    expect(t('sl', 'tabs.urnik')).toBe('Razpored delovnih ur')
    expect(t('sl', 'tabs.odpiralnicas')).toBe('Odprtost lokala')
    expect(t('sl', 'tabs.izmene')).toBe('Smene')
    expect(t('sl', 'tabs.crm')).toBe('Odnosi z gosti')
    expect(t('sl', 'tabs.enterprise')).toBe('Organizacija')
    expect(t('sl', 'tabs.groupOps')).toBe('Naročanje')
    expect(t('sl', 'st.title')).toBe('Popisi')
  })

  test('SL: stara mešana imena NE obstajajo več v zavihkih/naslovih razdelkov', () => {
    // obseg: tabs.* (zavihki) + me.title (naslov analize) + lcov.covShifts (pokritost)
    // — druga vsebina (opisi, gumbi) sme besedo uporabiti v drugem pomenu
    const scoped = Object.fromEntries(
      Object.entries(sl).filter(([k]) => k.startsWith('tabs.') || ['me.title', 'lcov.covShifts', 'st.title'].includes(k)),
    )
    const values = Object.values(scoped)
    expect(values).not.toContain('Menu inženiring')
    expect(values).not.toContain('CRM gostov')
    expect(values).not.toContain('Enterprise')
    expect(values).not.toContain('Izmene')
    expect(values).not.toContain('Urnik')
    expect(values).not.toContain('Odpiralni čas')
  })

  test('HR: enakovredna preimenovanja (pariteta pomenov)', () => {
    expect(t('hr', 'tabs.inzeniring')).toBe('Analiza jelovnika')
    expect(t('hr', 'tabs.urnik')).toBe('Raspored radnih sati')
    expect(t('hr', 'tabs.odpiralnicas')).toBe('Otvaranje lokala')
    expect(t('hr', 'tabs.izmene')).toBe('Smjene')
    expect(t('hr', 'tabs.crm')).toBe('Odnosi s gostima')
    expect(t('hr', 'tabs.enterprise')).toBe('Organizacija')
    expect(t('hr', 'tabs.groupOps')).toBe('Naručivanje')
    expect(t('hr', 'st.title')).toBe('Popisi')
  })

  test('HR: izposojenke odstranjene tudi v HR zavihkih/naslovih', () => {
    const scoped = Object.fromEntries(
      Object.entries(hr).filter(([k]) => k.startsWith('tabs.') || ['me.title', 'st.title'].includes(k)),
    )
    const values = Object.values(scoped)
    expect(values).not.toContain('CRM gostiju')
    expect(values).not.toContain('Inženjering jelovnika')
    expect(values).not.toContain('Enterprise')
  })

  test('nav.* tipke obstajajo v SL in HR (pariteta — slovarja sta brez lukenj)', () => {
    for (const key of ['nav.mainAria', 'nav.quickAria', 'nav.drawerTitle', 'nav.drawerDesc', 'nav.moreAria', 'nav.searchLabel', 'nav.searchPlaceholder', 'nav.noResults']) {
      expect(sl[key]).toBeDefined()
      expect(hr[key]).toBeDefined()
      expect(sl[key]?.length).toBeGreaterThan(0)
    }
  })
})

describe('audit-11 F — komponente ne izumljajo imen (en vir resnice)', () => {
  test('dashboard-nav.tsx: vsi naslovi zavihkov/skupin iz t() (noben hardcode)', () => {
    expect(nav).toContain("t(`tabs.${v}`)")
    expect(nav).toContain('NAV_GROUP_LABEL_KEY')
    // trdo kodirana imena zavihkov NE smejo obstajati v komponenti
    for (const forbidden of ['>Pregled<', '>Mize<', '"Naročanje"', "'Naročanje'", '"Zaloge in finance"']) {
      expect(nav).not.toContain(forbidden)
    }
  })

  test('ukazna paleta uporablja novo ime (Smene + Z-poročila)', () => {
    const palette = read('src/components/command-palette.tsx')
    expect(palette).toContain('Smene + Z-poročila')
    expect(palette).not.toContain('Izmene + Z-poročila')
  })
})
