/**
 * v1.179.0 — kontrastni gate, ki pozna TEMNO paleto.
 *
 * Izmerjena odprtina iz v1.177.0 (worklog tiste izdaje, `docs/TRZNA-VRZELI-2026.md`
 * §5): pravilo `contrast` je računalo razmerje iz `node_modules/tailwindcss/theme.css`,
 * torej iz SVETLE palete. Gostove strani pa tečejo pod `.dark`, kadar ima obiskovalec
 * temne nastavitve: `src/app/layout.tsx:37` vgradi `ThemeProvider attribute="class"
 * defaultTheme="system" enableSystem` okrog VSAKE rute, `src/app/globals.css` pa pod
 * `.dark` predefinira štiri žetone in enajst razredov. Na temno nastavljenem telefonu
 * torej gate meri paleto, je gost nikoli ne vidi.
 *
 * Ta datoteka ne trdi, da je temna paleta narobe — trdi, da je moral gate poznati
 * OBA načina. Merilo: element pade, če pade v KTEREMKOLI načinu, in sporočilo imenuje način.
 * Vse se računa iz dejanskih datotek (`theme.css` + `globals.css`), ne iz tabele,
 * napisane v testu.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'bun:test'
import * as a11y from './helpers/guest-a11y'
import { lintGuestRoutes, lintJsxString, contrastRatio, contrastBoth, GUEST_ROUTES } from './helpers/guest-a11y'

const css = (s: string) => lintJsxString(s).filter((v) => v.rule === 'contrast')

// ── §A — API, ki pozna oba načina, mora obstajati ────────────────────────────

describe('v1.179.0 §A — help r ima dvonačinski kontrast', () => {
  it('A1: izvozi `contrastBoth(fg, bg)` in `darkPalette()`', () => {
    expect(typeof (a11y as unknown as Record<string, unknown>).contrastBoth).toBe('function')
    expect(typeof (a11y as unknown as Record<string, unknown>).darkPalette).toBe('function')
  })
})

// ── §B — padec samo v temnem načinu ni več neviden ───────────────────────────

describe('v1.179.0 §B — padec samo v temnem načinu ni več neviden', () => {
  it('B1: `text-stone-950` na `bg-white` — svetlo 19,75:1, pod `.dark` se površina obrne, besedilo ne (1,19:1), JAVI kršitev', () => {
    const both = contrastBoth('stone-950', 'white')
    expect(both.light).toBeGreaterThan(15)
    expect(both.dark).not.toBeNull()
    expect(both.dark!).toBeLessThan(4.5)
    const vs = css('<div className="bg-white"><p className="text-stone-950">Opomba postrežbe</p></div>')
    expect(vs.length).toBe(1)
    expect(vs[0].message).toContain('temno')
    expect(vs[0].message).not.toContain('svetlo')
  })
  it('B2: `text-stone-900` na `bg-amber-500` — nasiten pas se ne obrne, žeton za besedilo pa da (svetlo 8,15 / temno 1,97), JAVI kršitev', () => {
    const vs = css('<div className="bg-amber-500"><p className="text-stone-900">Odobritev</p></div>')
    expect(vs.length).toBe(1)
    expect(vs[0].message).toContain('temno')
  })
  it('B3: en element = ENA kršitev, če pade v obeh načinih (ne dve, sicer se število kršitev ne ujema z enim elementom)', () => {
    const vs = css('<div className="bg-stone-500"><p className="text-stone-400">Alergeni</p></div>')
    expect(vs.length).toBe(1)
    expect(vs[0].message).toContain('svetlo')
    expect(vs[0].message).toContain('temno')
  })
})

// ── §B2 — šest parov, ki jih je ta izdaja popravila, ostanejo popravljeni ────

/**
 * Vsak od teh parov je bil MERJEN padec v samem temnem načinu na dejanski
 * gostovi roti (48 kršitev pred posegom). Pinovi so tu zato, ker je edini
 * mehanizem, ki ga izdaja popravlja, CSS — CSS pa noben drug test ne varuje.
 */
describe('v1.179.0 §B2 — popravljeni pari ne smejo zrasti nazaj', () => {
  const PAROVI: [string, string, string][] = [
    ['stone-100', 'stone-800', '/kiosk kartica: skoraj belo besedilo na temni kartici'],
    ['white', 'stone-900', '/pay in /r: belo besedilo na temnem pasu'],
    ['stone-400', 'stone-800', '/kiosk: muted besedilo na temni kartici'],
    ['stone-500', 'green-50', '/r: opomba na zeleni ploskvi'],
    ['stone-800', 'white', '/m: temno besedilo na kartici'],
    ['stone-950', 'amber-500', '/kiosk: zaklep — temno besedilo na nasitenem amber pasu'],
  ]
  for (const [fg, bg, zakaj] of PAROVI) {
    it(`text-${fg} na bg-${bg} ≥ 4,5:1 v obeh načinih (${zakaj})`, () => {
      const b = contrastBoth(fg, bg)
      expect(b.light).not.toBeNull()
      expect(b.dark).not.toBeNull()
      expect(b.light!).toBeGreaterThanOrEqual(4.5)
      expect(b.dark!).toBeGreaterThanOrEqual(4.5)
      expect(css(`<div className="bg-${bg}"><p className="text-${fg}">x</p></div>`)).toEqual([])
    })
  }
})

// ── §C — svetlo pravilo iz v1.177.0 sme ostati isto ──────────────────────────

describe('v1.179.0 §C — nič od svetle presoje se ni izgubilo', () => {
  it('C1: `contrastRatio` ostane svetla presoja in ostane 2,59 za stone-400 na beli', () => {
    expect(contrastRatio('stone-400', 'white')).toBeCloseTo(2.59, 1)
  })
  it('C2: par, čist v obeh načinih, se NE javi', () => {
    const vs = css('<div className="bg-white"><p className="text-stone-600">Alergeni</p></div>')
    expect(vs).toEqual([])
  })
  it('C3: nedoločljivo ozadje (prosojen mešan razred) se NE javi — ne trdim, česar ne morem izračunati', () => {
    const vs = css('<div className="bg-white/95"><p className="text-stone-400">x</p></div>')
    expect(vs).toEqual([])
  })
})

// ── §D — temna paleta se bere iz globals.css in ne iz tabele v testu ─────────

describe('v1.179.0 §D — bralnik `.dark` sloja je pošten', () => {
  const dp = () =>
    (a11y as unknown as { darkPalette: () => { tokens: Map<string, number | null>; classes: Map<string, number | null> } })
      .darkPalette()

  it('D1: razredni prepisi (`.dark .text-stone-600`) so vidni in imajo svojo vrednost', () => {
    expect(dp().classes.has('text-stone-600')).toBe(true)
    expect(dp().classes.get('text-stone-600')).not.toBeNull()
  })
  it('D2: žetonski prepisi (`.dark { --color-stone-100: … }`) so videni', () => {
    expect(dp().tokens.has('stone-100')).toBe(true)
    expect(dp().tokens.get('stone-100')).not.toBeNull()
  })
  it('D3: prepirek z alfo (`oklch(1 0 0 / 12%)`) je NEDOLOČLJIV in ne sme tiho vzeti svetle vrednosti', () => {
    expect(dp().tokens.get('stone-200')).toBeNull()
  })
  it('D4: vrednost IZVEN bloka `.dark` ne sme priti v temno paleto (fixture, ne domneva)', () => {
    const parse = (a11y as unknown as { parseDarkLayer?: (src: string) => { tokens: Map<string, number | null>; classes: Map<string, number | null> } })
      .parseDarkLayer
    expect(typeof parse).toBe('function')
    const sint = `
      :root { --color-stone-500: oklch(0.55 0.01 100); }
      .text-stone-500 { color: var(--color-stone-500); }
      .dark { --color-stone-700: oklch(0.87 0.004 95); }
      .dark .bg-white { background-color: oklch(0.235 0.004 95); }
    `
    const r = parse!(sint)
    expect(r.tokens.has('stone-700')).toBe(true)
    expect(r.tokens.has('stone-500')).toBe(false)
    expect(r.classes.has('bg-white')).toBe(true)
    expect(r.classes.has('text-stone-500')).toBe(false)
  })
  it('D5: razredni prepisi imajo prednost pred žetonskimi (`.dark .text-stone-600` != `--color-stone-600`)', () => {
    const byClass = dp().classes.get('text-stone-600')!
    const byToken = dp().tokens.get('stone-600')
    expect(byToken ?? byClass).toBe(byClass)
    expect(dp().tokens.has('stone-600')).toBe(false)
  })
  it('D6: variantni razredi ne smejo priti v temno paleto (fixture, ki ga regex sam ne zavrne)', () => {
    const parse = (a11y as unknown as { parseDarkLayer?: (src: string) => { tokens: Map<string, number | null>; classes: Map<string, number | null> } })
      .parseDarkLayer
    expect(typeof parse).toBe('function')
    const sint = `
      .dark .bg-white { background-color: oklch(0.235 0.004 95); }
      .dark .hover\\:bg-white { background-color: oklch(0.90 0 0); }
      .dark .bg-white\\:focus { background-color: oklch(0.11 0 0); }
    `
    const r = parse!(sint)
    expect(r.classes.has('bg-white')).toBe(true)
    expect(r.classes.has('hover:bg-white')).toBe(false)
    // `bg-white:focus` ima `bg-` predpono, zato ga preverjanje lastnosti NE zavrne —
    // edino varnostna plast za variantne razrede ga lahko drži stran od palete.
    expect(r.classes.has('bg-white:focus')).toBe(false)
    expect([...r.classes.keys()].filter((k) => k.includes(':'))).toEqual([])
  })
  it('D6b: v dejanski `.dark` plasti ni ključa z dvodišjem (realna datoteka, ne fixture)', () => {
    expect(dp().classes.has('bg-white')).toBe(true)
    expect([...dp().classes.keys()].filter((k) => k.includes(':'))).toEqual([])
    expect(dp().classes.has('hover:bg-white')).toBe(false)
  })
})

// ── §E — dejanske gostove rute ───────────────────────────────────────────────

describe('v1.179.0 §E — štiri dejanske gostove rute sta čisti v OBAH paletah', () => {
  const vs = lintGuestRoutes().filter((v) => v.rule === 'contrast')

  it('E1: noben kontrastni padec v nobenem načinu', () => {
    expect(vs.map((v) => `${v.file}:${v.line} ${v.message}`)).toEqual([])
  })
  it('E2: gate je na gostovih rutah res imel kaj meriti (sicer je E1 brezvreden)', () => {
    expect(GUEST_ROUTES.length).toBe(4)
    const src = GUEST_ROUTES.map((r) => readFileSync(r.path, 'utf8')).join('\n')
    expect(src.includes('text-stone-')).toBe(true)
  })
  it('E3: E1 ni zelen zaradi „nedoločljivo" — pari, izmerjeni na rutah, imajo v obeh načinih ŠTEVILKO', () => {
    // Par (fg, bg) so rute uporabljale pred posegom; če helper za katerega
    // vrne null, E1 ne trdi ničesar.
    for (const [fg, bg] of [
      ['stone-100', 'stone-800'],
      ['white', 'stone-900'],
      ['stone-400', 'stone-800'],
      ['stone-400', 'stone-900'],
      ['stone-800', 'white'],
      ['stone-500', 'green-50'],
      ['red-400', 'stone-900'],
    ] as [string, string][]) {
      const r = contrastBoth(fg, bg)
      expect(r.light, `svetlo ${fg}/${bg}`).not.toBeNull()
      expect(r.dark, `temno ${fg}/${bg}`).not.toBeNull()
    }
  })
  it('E4: paleti sta res DVE — na vsaj petih od enajstih parov se odločitev razlikuje', () => {
    const PROBES: [string, string][] = [
      ['stone-950', 'white'],
      ['stone-300', 'stone-900'],
      ['stone-900', 'amber-500'],
      ['stone-400', 'stone-800'],
      ['stone-500', 'green-50'],
      ['stone-600', 'white'],
      ['stone-100', 'stone-800'],
      ['stone-800', 'white'],
      ['red-400', 'stone-900'],
      ['stone-500', 'stone-50'],
      ['white', 'stone-900'],
    ]
    const diff = PROBES.filter(([f, b]) => {
      const r = contrastBoth(f, b)
      return r.light !== null && r.dark !== null && Math.abs(r.light - r.dark) > 1
    })
    expect(diff.length).toBeGreaterThanOrEqual(5)
  })
})
