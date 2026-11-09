import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_VERSION } from '../src/lib/version'

/**
 * UPORABNIŠKI QA VAL #10 — NEPREKRITE POVRŠINE #3: TABLICA, HANDHELD, PALETA (v1.228.0).
 *
 * Kontekst: val #10 po uspešnem pushu v1.223–v1.227 (Neon okrevanje, vse tri
 * platforme sinhronizirane). Cilj: površine, ki jih noben prejšnji val ni
 * odprl PO prijavi s piškotkom — namenske natakarjeve rute in ukazna paleta.
 *
 * NAJDBA #1 (P2 — /tablica IN /handheld NEDOSEGLJIVI ZA NOVE SEJE): vrata na
 * obeh straneh so preverjala SAMO legacy žeton v localStorage (ro_token),
 * ki ga prijava od v1.219.0 (issue #90) ne piše več (seja živi v httpOnly
 * piškotku ro_session) → vsak odprt je končal v zanki →/ → avtodetekt →
 * /dashboard. POPRAVEK: vrata `!getToken() && !getUser()` (piškotek overi
 * /api/auth/me; api() ob 401 preusmeri) — enaka disciplina kot dashboard.
 *
 * NAJDBA #2 (P3 — UKAZNA PALETA 15/32 ZAVIHKOV): glava je obljubljala
 * »vsi zavihki«, a je imela ročen seznam 15 vnosov; 17 zavihkov je bilo z
 * Ctrl+K nedosegljivih. Paleta je tudi podvajala logiko vlog (canManage +
 * poseben KITCHEN pogoj). POPRAVEK: navigacija izpeljana iz ISTEGA vira kot
 * stranski steber — tabs (DASHBOARD_TABS) + ctx (TabPermContext) →
 * tabHasPerm; oznake iz t(`tabs.${id}`) — SL/HR pošteno, enako ime kot
 * navigacija.
 */

const read = (p: string) => readFileSync(p, 'utf8')
const tablica = read('src/app/tablica/page.tsx')
const handheld = read('src/app/handheld/page.tsx')
const palette = read('src/components/command-palette.tsx')
const dash = read('src/app/dashboard/page.tsx')
const sl = read('src/lib/i18n/sl.ts')
const hr = read('src/lib/i18n/hr.ts')

describe('QA-val #10 A — tablica/handheld vrata (issue #90 kompatibilnost)', () => {
  test('A1: vrata preverjata OBA signala seje (token ALI ro_user) na OBEH straneh', () => {
    // Popravek: `!getToken() && !getUser()` — seja z ro_user (piškotek) gre
    // skozi, brez obeh = res brez seje → prijava.
    expect(tablica).toContain('if (!getToken() && !getUser()) { router.replace(\'/\'); return }')
    expect(handheld).toContain('if (!getToken() && !getUser()) { router.replace(\'/\'); return }')
  })

  test('A1b: hroščasta ozka vrata ODSOTNA (samo getToken bi zopet zaprlo piškotne seje)', () => {
    expect(tablica).not.toContain('if (!getToken()) { router.replace(\'/\'); return }')
    expect(handheld).not.toContain('if (!getToken()) { router.replace(\'/\'); return }')
  })

  test('A2: namere dokumentirane (QA-val #10 + sklic na issue #90 v obeh)', () => {
    expect(tablica).toContain('QA-val #10')
    expect(tablica).toContain('issue #90')
    expect(handheld).toContain('QA-val #10')
    expect(handheld).toContain('issue #90')
  })

  test('A3: pravi avtorizacijski tok ostaja (api(/api/auth/me) + api() 401 preusmeritev iz client.ts)', () => {
    expect(tablica).toContain("api<{ employee: { name: string; role: string } }>('/api/auth/me')")
    expect(handheld).toContain("api<{ employee: { name: string; role: string } }>('/api/auth/me')")
    // client.ts: 401 → window.location.href = '/' (samodejna izjava v komentarju obeh strani)
    expect(tablica).toContain('api() ob 401')
    expect(handheld).toContain('api() ob 401')
  })
})

describe('QA-val #10 B — ukazna paleta = stranski steber (en vir)', () => {
  test('B1: navigacija izpeljana iz tabs + ctx prek tabHasPerm (kanon issue #72 A4)', () => {
    expect(palette).toContain("import { tabHasPerm, type TabPermContext } from '@/lib/tab-permissions'")
    expect(palette).toContain('tabs.filter(([v]) => tabHasPerm(v, ctx))')
    // PODVOJENA logika vlog v paleti je ODSOTNA (namere A4 okrepšene: en kanon)
    expect(palette).not.toContain('isManagerialRole')
    expect(palette).not.toContain("role === 'KITCHEN'")
  })

  test('B1b: oznake iz t(`tabs.${id}`) — enako ime kot navigacija, i18n pošteno', () => {
    expect(palette).toContain('t(`tabs.${v}`)')
    // hroščasta ločena oznaka (samo-paleta) ODSOTNA; en vir imen
    expect(palette).not.toContain("'Smene + Z-poročila'")
  })

  test('B2: klicno mesto podaja ISTA vira kot DashboardSidebar', () => {
    expect(dash).toContain('tabs={DASHBOARD_TABS}')
    expect(dash).toContain('ctx={{ canManage, perms }}')
    // DashboardSidebar prejema iste propse (dokaz enakovrednosti virov)
    expect(dash).toContain('<DashboardSidebar tabs={DASHBOARD_TABS} activeTab={activeTab} onSelect={setActiveTab} ctx={{ canManage, perms }} />')
    // user prop NI več potreben (vrata/paleta ne preverjata vloge)
    expect(dash).not.toContain('<CommandPalette\n        open={paletteOpen}\n        onOpenChange={setPaletteOpen}\n        user={user}')
  })

  test('B3: i18n pokritost — tabs.* obstajajo v SL in HR za VSE zavihke iz TAB_PERM', () => {
    // Vsi id-ji zavihkov (isti register kot sidebar TAB_PERM — če nov zavihek
    // nastane brez slovarskega vnosa, ta test pade PREJ kot uporabnikovo
    // prašeno ime v paleti/navigaciji).
    const perm = read('src/lib/tab-permissions.ts')
    const ids = [...perm.matchAll(/^  ([a-z]+): (?:TAB_PERM_ALL|'| \[)/gm)].map((m) => m[1])
    expect(ids.length).toBeGreaterThanOrEqual(30)
    for (const id of ids) {
      expect(sl).toContain(`'tabs.${id}':`)
      expect(hr).toContain(`'tabs.${id}':`)
    }
  })

  test('B4: iskanje pokriva tudi id zavihka (value nosi oznako + id)', () => {
    // »crm« najde »Odnosi z gosti« tudi po id-ju (cmdk value)
    expect(palette).toContain('value={`${t(`tabs.${v}`)} ${v}`}')
  })
})

describe('QA-val #10 Č — verzija + registri (doc-truth)', () => {
  test('Č1: verzija je dvignjena na 1.238.0 (version.ts + compose oznaka)', () => {
    expect(APP_VERSION).toBe('1.290.0')
    expect(read('src/lib/version.ts')).toContain("'1.290.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.290.0')
  })

  test('Č2: PRD nosi zapis QA-vala v1.228.0 (doc-truth)', () => {
    expect(read('docs/PRD-LOKALNA-BAZA.md')).toContain('QA-val v1.228.0')
  })

  test('Č3: worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.290.0-repni-siroki-klici')
    expect(wl.indexOf('Task ID: v1.230.0')).toBeLessThan(wl.indexOf('Task ID: v1.227.0'))
  })

  test('Č4: a11y/intent komentarji v paleti nosijo QA-val #10 oznako', () => {
    expect(palette).toContain('QA-val #10')
  })
})
