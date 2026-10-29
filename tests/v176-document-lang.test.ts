/**
 * v1.176.0 — JEZIK DOKUMENTA NA GOSTOVIH ZASLONIH (WCAG 3.1.1 / 3.1.2)
 *
 * Zakaj: od 28. 6. 2025 v Sloveniji zavezuje ZDPSI (izvedba direktive
 * (EU) 2019/882, EAA) in zajema storitve e-trgovine — za to aplikacijo torej
 * QR meni ter javno plačilno in rezervacijsko povezavo. `src/app/layout.tsx`
 * ima trdo zapisan `<html lang="sl">`, `documentElement.lang` pa se v celotnem
 * `src/` nikoli ne posodobi (izmerjeno 0 zadetkov). Angleški ali hrvaški gost
 * torej dobi vsebino v svojem jeziku, brskalnik in bralni zaslon pa jo berjeta
 * po slovenskih pravilih izgovarjave.
 *
 * Test je mešan: (A) dejansko obnašanje na podtujenem DOM objektu (brez jsdom),
 * (B) varovalke, zapisane v viru (source pins), ki preprečijo ponovni nastop
 * trdo zapisanega jezika in tiho odstranitev klica.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_HTML_LANG,
  applyDocumentLang,
  type Locale,
} from '../src/lib/i18n'
import { staffUiLocale } from '../src/components/i18n'

const src = (p: string): string => readFileSync(join(process.cwd(), 'src', p), 'utf8')

/** Podtujen DOM — `applyDocumentLang` mora sprejeti koren, sicer test ne more dokazati obnašanja. */
type FakeRoot = { documentElement: { lang: string } }
const fakeRoot = (initial = ''): FakeRoot => ({ documentElement: { lang: initial } })

// ═══ A — dejansko obnašanje ═══
describe('v1.176.0 §A — applyDocumentLang dejansko zapiše jezik', () => {
  it('vsaka podprta lokacija ima BCP-47 oznako', () => {
    for (const l of LOCALES) {
      expect(typeof LOCALE_HTML_LANG[l]).toBe('string')
      expect(LOCALE_HTML_LANG[l].length).toBeGreaterThan(1)
    }
    expect(LOCALE_HTML_LANG.sl).toBe('sl-SI')
    expect(LOCALE_HTML_LANG.hr).toBe('hr-HR')
    expect(LOCALE_HTML_LANG.en).toBe('en')
    // P3-21 (v1.191.0): DE/IT gole oznake — isti razlog kot EN (regionalna
    // oznaka bi bralnemu zaslonu napačno nastavila izgovarjavo)
    expect(LOCALE_HTML_LANG.de).toBe('de')
    expect(LOCALE_HTML_LANG.it).toBe('it')
  })
  it('zapiše hr-HR v documentElement.lang (ne "hr")', () => {
    const root = fakeRoot('sl-SI')
    const out = applyDocumentLang('hr', root)
    expect(root.documentElement.lang).toBe('hr-HR')
    expect(out).toBe('hr-HR')
  })
  it('preklop nazaj na sl obnovi sl-SI', () => {
    const root = fakeRoot('hr-HR')
    applyDocumentLang('sl', root)
    expect(root.documentElement.lang).toBe('sl-SI')
  })
  it('neznana vrednost pade na privzeto lokacijo, ne na prazno oznako', () => {
    const root = fakeRoot('hr-HR')
    applyDocumentLang('xx' as unknown as Locale, root)
    expect(root.documentElement.lang).toBe(LOCALE_HTML_LANG[DEFAULT_LOCALE])
  })
  it('brez DOM (strežniški izris) ne vrže in ne zapiše', () => {
    expect(applyDocumentLang('en', null)).toBeNull()
    expect(applyDocumentLang('en', undefined)).toBeNull()
  })
  it('ponovni klic z isto oznako ne piše dvakrat (mirna re-renderitev)', () => {
    let writes = 0
    const root: FakeRoot = {
      documentElement: {
        get lang() { return 'en' },
        set lang(_v: string) { writes++ },
      },
    }
    applyDocumentLang('en', root)
    expect(writes).toBe(0)
  })
  it("dashboard pri shranjenem 'en' ne sme zapisati lang=en (vsebina je SL)", () => {
    // P1-5 varovalka (src/components/i18n.tsx): EN preklopnik ni na voljo osebju;
    // ob locale 'en' dashboard prevaja iz SL slovarja. Dokument, ki nad slovensko
    // vsebino trdi angleščino, je isti razred napake kot obratni primer — bralni
    // zaslon bi govoril napačno. Zato sme biti efektivni jezik za osebje 'sl'.
    const root = fakeRoot('hr-HR')
    applyDocumentLang(staffUiLocale('en'), root)
    expect(root.documentElement.lang).toBe('sl-SI')
    expect(staffUiLocale('hr')).toBe('hr')
    expect(staffUiLocale('sl')).toBe('sl')
    // P3-21 (v1.191.0): DE/IT so gostovska jezika — osebje vidi SL vsebino,
    // dokument sme trditi samo to (isti varovalni vzorec kot 'en')
    expect(staffUiLocale('de')).toBe('sl')
    expect(staffUiLocale('it')).toBe('sl')
    // gostove strani EN dejansko izrisujejo (guest.*/pay.* slovar) → sme ostati 'en'
    applyDocumentLang('en', root)
    expect(root.documentElement.lang).toBe('en')
  })
})

// ═══ B — varovalke na viru ═══
describe('v1.176.0 §B — klic je povsod, kjer se jezik dejansko spreminja', () => {
  it('gostov store pokliče applyDocumentLang ob pridobitvi shranjenega jezika', () => {
    const g = src('components/guest-i18n.tsx')
    expect(g).toContain('applyDocumentLang')
    // mora biti znotraj loadStoredLocale (prvi obisk: jezik brskalnika) IN
    // znotraj setGuestLocale (ročni preklop) — sicer prvi izris ostane napačen
    const load = g.slice(g.indexOf('function loadStoredLocale'), g.indexOf('function subscribe'))
    expect(load).toContain('applyDocumentLang(currentLocale)')
    const set = g.slice(g.indexOf('export function setGuestLocale'), g.indexOf('function translate'))
    expect(set).toContain('applyDocumentLang(')
  })
  it('store za osebje (dashboard/prijava) pokliče enako, a po efektivnem jeziku', () => {
    const s = src('components/i18n.tsx')
    expect(s).toContain('applyDocumentLang')
    const load = s.slice(s.indexOf('function loadStoredLocale'), s.indexOf('function subscribe'))
    expect(load).toContain('applyDocumentLang(staffUiLocale(currentLocale))')
    const set = s.slice(s.indexOf('export function setStoredLocale'), s.indexOf('// ── Provider ──'))
    expect(set).toContain('applyDocumentLang(staffUiLocale(')
  })
  it('root layout ostane pri trdi privzeti vrednosti, a s suppressHydrationWarning', () => {
    const l = src('app/layout.tsx')
    // SSR izriše privzeti jezik, klient ga popravi; brez opozorila bi bila
    // hydratacijska napaka vidna na vsaki napravi osebja.
    expect(l).toMatch(/<html lang="\w+"[^>]*suppressHydrationWarning/)
  })
  it('noben drug modul ne piše documentElement.lang na črno', () => {
    // Dovoljeno mesto je eno samo: i18n/index.ts (izvajalec). Nobena stran ne
    // sme pisati documentElement.lang na črno.
    const files = ['app/layout.tsx', 'app/dashboard/page.tsx', 'app/kiosk/page.tsx',
      'app/m/[token]/page.tsx', 'app/pay/[token]/page.tsx', 'app/r/[token]/page.tsx',
      'app/display/page.tsx', 'app/handheld/page.tsx', 'app/tablica/page.tsx']
    for (const f of files) expect(src(f)).not.toContain('documentElement.lang')
  })
})
