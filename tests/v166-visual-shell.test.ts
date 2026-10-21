/**
 * v1.166.0 — vizualna prenova „temna lupina" (spec:
 * docs/superpowers/specs/2026-10-21-vizualna-prenova-temna-lupina-design.md).
 *
 *  A. BLAGOVNI ŽETONI: --primary je emerald v OBEH načinih, --ring sledi,
 *     grafična paleta je emerald-sidrana.
 *  B. LUPINA: --sidebar-* je oglje v OBEH načinih, vijolični tovarniški
 *     --sidebar-primary ne sme preostati.
 *  C. REGIJE: lupina je obarvana lokalno (region-ski žetoni), ne prek
 *     preimenovanja razredov.
 *  D. RAZREDI LUPINE v TSX: glava / steber / mobilna vrstica / predal.
 *  E. INVARIANTE: --radius 10px, tabular-nums, 0 DDL, pritrjene celote.
 *
 * Čisto source-pin (vzorec issue69): brez DB fiksur, brez API klicev.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'

const src = (p: string): string => readFileSync(join(process.cwd(), 'src', p), 'utf8')
const css = (): string => src('app/globals.css')

/** oklch(L C H) → {L,C,H}; test meritve POMEN žetona, ne njegovega zapisa. */
const oklch = (s: string): { L: number; C: number; H: number } | null => {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s)
  return m ? { L: +m[1], C: +m[2], H: +m[3] } : null
}
/** Vrednost žetona, kot jo VIDI brauzer: zadnjič deklarirana v bloku
    `selector { … }` po vrsti vira (enaka specifičnost ⇒ source order).
    Pazljivo: --primary je deklariran SAMO v tovarniškem bloku, --ring pa
    tudi v polish bloku (195) — helper mora presneti VSE bloke, ne samo
    zadnjega, sicer test laže. */
const tokenIn = (cssText: string, selector: string, token: string): string | null => {
  const blockRe = new RegExp(`^${selector}\\s*\\{([\\s\\S]*?)^\\}`, 'gm')
  const declRe = new RegExp(`--${token}:\\s*([^;]+);`, 'g')
  let last: string | null = null
  for (const b of cssText.matchAll(blockRe)) {
    for (const m of b[1].matchAll(declRe)) last = m[1].trim()
  }
  return last
}
const isEmerald = (v: string | null): boolean => {
  const o = v ? oklch(v) : null
  return !!o && o.C >= 0.1 && o.H >= 150 && o.H <= 180
}
const isCharcoal = (v: string | null): boolean => {
  const o = v ? oklch(v) : null
  return !!o && o.L <= 0.3
}
/** Izlusuje blok lupine (seznamski selektor + telo). SIDRO IMENUJE VSE PET
    regij (tri lupine + dva portala) — če ga ni, helper POSTRŽE: zaporni
    testi ne smejo tiho uspeti na praznem nizu. */
const shellBlock = (d: string): string => {
  const anchor = '[data-region="dashboard-header"],\n[data-region="dashboard-sidebar"],\n[data-region="dashboard-mobile-nav"],\n[data-region="nav-drawer"],\n[data-region="location-select"] {'
  const start = d.indexOf(anchor)
  if (start < 0) throw new Error('lupinski žetonski blok ni najden po sidru — zaporni testi ne smejo tiho uspeti')
  return d.slice(start, d.indexOf('}', start))
}
/** oklch → linearni sRGB Y (relativni svetlostni delež, Ottossonova matrika).
    WCAG zahteva Y, ne L — L je perceptualna, ne sorazmerna. */
const oklchToY = (v: string): number | null => {
  const o = oklch(v)
  if (!o) return null
  const aC = (o.H * Math.PI) / 180
  const A = o.C * Math.cos(aC)
  const B = o.C * Math.sin(aC)
  const l_ = o.L + 0.3963377774 * A + 0.2158037573 * B
  const m_ = o.L - 0.1055613458 * A - 0.0638541728 * B
  const s_ = o.L - 0.0894841775 * A - 1.291485548 * B
  const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3]
  return (
    0.2126 * (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * (-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * (-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  )
}
const ratio = (a: string, b: string): number => {
  const ya = oklchToY(a)
  const yb = oklchToY(b)
  if (ya === null || yb === null) return 0
  return (Math.max(ya, yb) + 0.05) / (Math.min(ya, yb) + 0.05)
}

describe('v1.166.0 §A — blagovni žetoni', () => {
  it('--primary je emerald v svetlem načinu', () => {
    expect(isEmerald(tokenIn(css(), ':root', 'primary'))).toBe(true)
  })
  it('--primary je emerald v temnem načinu', () => {
    expect(isEmerald(tokenIn(css(), '\\.dark', 'primary'))).toBe(true)
  })
  it('--primary-foreground v svetlem načinu je bel (AA na emerald-700)', () => {
    const v = tokenIn(css(), ':root', 'primary-foreground')
    const o = v ? oklch(v) : null
    expect(o && o.L >= 0.95 && o.C <= 0.02).toBe(true)
  })
  it('--chart-1 je emerald (grafni znak znamke)', () => {
    expect(isEmerald(tokenIn(css(), ':root', 'chart-1'))).toBe(true)
  })
  it('--ring sledi znamki', () => {
    expect(isEmerald(tokenIn(css(), ':root', 'ring'))).toBe(true)
  })
})

describe('v1.166.0 §B — žetoni lupine (oglje v obeh načinih)', () => {
  it('--sidebar je oglje v svetlem načinu', () => {
    expect(isCharcoal(tokenIn(css(), ':root', 'sidebar'))).toBe(true)
  })
  it('--sidebar je oglje v temnem načinu', () => {
    expect(isCharcoal(tokenIn(css(), '\\.dark', 'sidebar'))).toBe(true)
  })
  it('--sidebar-foreground je skoraj bel (AA besedilo na oglju)', () => {
    const v = tokenIn(css(), ':root', 'sidebar-foreground')
    const o = v ? oklch(v) : null
    expect(!!o && o.L >= 0.9).toBe(true)
  })
  it('vijolični tovarniški --sidebar-primary ne sme preostati', () => {
    // tovarniška vijolična = oklch(0.488 0.243 264.376) — hue ~264
    const o = oklch(tokenIn(css(), '\\.dark', 'sidebar-primary') ?? '')
    expect(!!o && o.H > 200 && o.H < 300).toBe(false)
  })
  it('--sidebar-accent je emerald-tonirana podlaga aktivne postavke', () => {
    const o = oklch(tokenIn(css(), ':root', 'sidebar-accent') ?? '')
    expect(!!o && o.H >= 150 && o.H <= 180 && o.L <= 0.4).toBe(true)
  })
  // I-1 (pregled Task 2): zgornja straža je NEGATIVNA (vijolična ne sme ostati) —
  // če žeton popolnoma izgine, negativni test še vedno uspe. Zato še pozitivni par.
  it('--sidebar-primary je emerald v temnem načinu (I-1, pozitivni par)', () => {
    expect(isEmerald(tokenIn(css(), '\\.dark', 'sidebar-primary'))).toBe(true)
  })
  // I-2 (pregled Task 2): isCharcoal() meri SAMO svetlost — vijolično oglje bi
  // zgrešilo oba obstoječa testa. Hladna družina oglja = hue 240–260 IN C ≤ 0.02.
  it('--sidebar je hladno oglje (hue 240–260, C ≤ 0.02) v OBEH blokih (I-2)', () => {
    for (const sel of [':root', '\\.dark']) {
      const o = oklch(tokenIn(css(), sel, 'sidebar') ?? '')
      expect(!!o && o.H >= 240 && o.H <= 260 && o.C <= 0.02).toBe(true)
    }
  })
})

describe('v1.166.0 §C — obarvanje lupine po regijah', () => {
  const d = css()
  it('regijski blok našteje vse tri regije lupine', () => {
    expect(shellBlock(d).length).toBeGreaterThan(0)
  })
  it('regije lokalno redeklarirajo vsebinske žetone (mehanizem @theme inline)', () => {
    const b = shellBlock(d)
    for (const t of ['--background', '--card', '--border', '--input', '--foreground', '--muted-foreground']) {
      expect(b).toContain(t)
    }
    expect(b).toContain('color-scheme: dark')
  })
  it('stone skala je v lupini premaknjena na lahka besedila', () => {
    expect(shellBlock(d)).toContain('--color-stone-400: oklch(0.72 0.010 250);')
    expect(shellBlock(d)).toContain('--color-stone-900: oklch(0.98 0.004 250);')
  })
  it('beli gumbi v lupini ne smejo ostati beli (oba načina) — eksplicitno pravilo', () => {
    expect(d).toContain('[data-region="dashboard-header"] .bg-white')
  })
  it('blok je POSTAVLJEN ZA temne remape (pri enaki (0,2,0) odloča vrstni red)', () => {
    expect(d.indexOf('[data-region="dashboard-header"] .bg-white'))
      .toBeGreaterThan(d.indexOf('.dark .bg-white'))
    expect(d.indexOf('[data-region="dashboard-header"],'))
      .toBeGreaterThan(d.indexOf('.dark .bg-emerald-50'))
  })
  it('--color-white je namenoma NEDOTAKNJEN (bel napis znamke + text-white na emerald)', () => {
    expect(d).not.toContain('--color-white')
  })
  it('mobilna regija pobarva SAMI SEBE (descendant granula ne ujame ownega elementa)', () => {
    // (0,1,0) izven @layer ⇒ premaga slojeno .bg-white utilito. Ta oblika preživi
    // Task 4 preimenovanje razreda, zato je to pravo sidro — ne niz razreda.
    expect(css()).toMatch(/\[data-region="dashboard-mobile-nav"\]\s*\{[^}]*background-color:[^}]*\}/)
  })
  it('bel razred NA elementu regije je nevtraliziran (self-matching selektor)', () => {
    expect(css()).toContain('[data-region="dashboard-mobile-nav"].bg-white')
  })
  it('self-matching granula leži ZA `.dark .bg-white` (sicer temni način vrne površino hue-95)', () => {
    // Obe pravili sta (0,2,0) in NESLOJENI → vrstni red je edini odločevalec.
    // Sidro je niz SKUPAJ z `{`, da ga ne morela zadovoljiti omemba v komentarju.
    const d = css()
    expect(d.indexOf('[data-region="dashboard-mobile-nav"].bg-white {'))
      .toBeGreaterThan(d.indexOf('.dark .bg-white {'))
  })
  it('emerald besedilo se invertira, žeton --color-emerald-700 ostane (pikca znamke!)', () => {
    const d = css()
    for (const r of ['dashboard-header', 'dashboard-sidebar', 'dashboard-mobile-nav']) {
      expect(d).toContain(`[data-region="${r}"] .text-emerald-700`)
    }
    expect(shellBlock(d)).not.toContain('--color-emerald-700')
    const rule = d.slice(d.indexOf('[data-region="dashboard-header"] .text-emerald-700'))
    const o = oklch(/color:\s*([^;]+);/.exec(rule)?.[1] ?? '')
    expect(!!o && o.L >= 0.7 && o.H >= 150 && o.H <= 180).toBe(true)
  })
  it('lupina pokriva hover\:bg-white v vseh treh regijah', () => {
    const d = css()
    for (const r of ['dashboard-header', 'dashboard-sidebar', 'dashboard-mobile-nav']) {
      expect(d).toContain(`[data-region="${r}"] .hover\\:bg-white:hover`)
    }
  })
  it('regijski žetoni so ZA vsemi tremi .dark bloki (enaka specifičnost → vrstni red odloča)', () => {
    const d = css()
    expect(d.indexOf('[data-region="dashboard-header"],')).toBeGreaterThan(d.lastIndexOf('.dark {'))
  })
  it('regijski blok ne redefinira --primary ali --sidebar (oba deduje po načinu)', () => {
    const b = shellBlock(css())
    expect(b).not.toContain('--primary:')
    expect(b).not.toContain('--sidebar:')
  })
})

describe('v1.166.0 §D — razredi lupine v TSX', () => {
  const nav = src('components/dashboard-nav.tsx')
  const d = src('app/dashboard/page.tsx')
  it(' stranski steber nosi oglje žetone, ne bele plošče', () => {
    expect(nav).toContain('border-r border-sidebar-border bg-sidebar text-sidebar-foreground')
    expect(nav).toContain('data-region="dashboard-sidebar"')
  })
  it('mobilna spodnja vrstica nosi oglje žetone', () => {
    expect(nav).toContain('border-t border-sidebar-border bg-sidebar text-sidebar-foreground pb-[env(safe-area-inset-bottom)] lg:hidden')
    expect(nav).toContain('data-region="dashboard-mobile-nav"')
  })
  it('glava dashboarda nosi oglje', () => {
    expect(d).toContain('data-region="dashboard-header" className="sticky top-0 z-20 bg-sidebar text-sidebar-foreground border-b border-sidebar-border')
  })
  it('predal »Več« je ogljen (prej je podedoval bg-background)', () => {
    // R-7: sidro zdaj vsebuje lastni regijski marker — brez njega je predal
    // ogljen samo na korenu, otroki pa ostanejo na svetlih žetonih.
    expect(nav).toContain('DrawerContent data-region="nav-drawer" className="max-h-[82vh] bg-sidebar text-sidebar-foreground"')
  })
  it('aktivna postavka: emerald rob + --sidebar-accent podlaga', () => {
    expect(nav).toContain("active\n          ? 'border-emerald-400 bg-sidebar-accent font-semibold text-sidebar-accent-foreground'")
  })
  it('neaktivna postavka: muted na oglju, hover iz žetona', () => {
    expect(nav).toContain('border-transparent font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground')
  })
  it('noben razred lupine ne sme vsebovati bg-white (preusmerjeno na žeton)', () => {
    expect(nav.slice(nav.indexOf('data-region="dashboard-sidebar"'), nav.indexOf('data-region="dashboard-mobile-nav"')))
      .not.toContain('bg-white')
  })
  it('spuščeni seznam pogledov v glavi je ogljen (portal, P-4)', () => {
    expect(d).toContain('<SelectContent data-region="location-select" className="bg-sidebar text-sidebar-foreground">')
  })
  it('AA helper: oklch(0.145 0 0) na oklch(0.24 0.012 250) = 1,20:1 (kontrolna točka regresije)', () => {
    expect(ratio('oklch(0.145 0 0)', 'oklch(0.24 0.012 250)')).toBeCloseTo(1.2, 1)
  })
  it('predal in padec lokacij sta OWNI regiji (brez markerja regijski žetoni do njunih otrok ne sežejo)', () => {
    expect(src('components/dashboard-nav.tsx')).toContain('<DrawerContent data-region="nav-drawer" className="max-h-[82vh] bg-sidebar text-sidebar-foreground">')
    expect(src('app/dashboard/page.tsx')).toContain('<SelectContent data-region="location-select" className="bg-sidebar text-sidebar-foreground">')
  })
  it('regijski žetonski blok pokriva OBA portala (berem seznam selektorjev, ne helperjev reza)', () => {
    // shellBlock() SEČE OD SIDRA NAPREJ in sidro že našteje vseh pet regionov ⇒
    // `toContain` čez njegov rez bi bil tautologija (review Task 4, Minor 1).
    const d = css()
    const at = d.indexOf('[data-region="dashboard-header"],\n[data-region="dashboard-sidebar"]')
    expect(at).toBeGreaterThanOrEqual(0)
    const list = d.slice(at, d.indexOf('{', at))
    expect(list).toContain('[data-region="nav-drawer"]')
    expect(list).toContain('[data-region="location-select"]')
  })
  it('AA na portalu: regijski --foreground in --muted-foreground na regijski --background ≥ 4,5:1', () => {
    const b = shellBlock(css())
    const bg = /--background:\s*([^;]+);/.exec(b)?.[1]?.trim() ?? ''
    for (const tok of ['--foreground', '--muted-foreground', '--color-stone-500']) {
      const v = new RegExp(`${tok}:\\s*([^;]+);`).exec(b)?.[1]?.trim() ?? ''
      expect(ratio(v, bg)).toBeGreaterThanOrEqual(4.5)
    }
    // --popover JE PODLAGA (0,28), ne besedilo: par surface↔surface (1,13:1) nima
    // AA smisla, brief ga je uvrstil napačno. Preverjeno je tisto, kar AA res
    // ogroža — v portalu sme stati samo temna površina, ki nosi regijski
    // --foreground ≥ 4,5:1 (sicer `bg-popover` vanj vrne belo kartico).
    const popover = /--popover:\s*([^;]+);/.exec(b)?.[1]?.trim() ?? ''
    const fg = /--foreground:\s*([^;]+);/.exec(b)?.[1]?.trim() ?? ''
    expect(isCharcoal(popover)).toBe(true)
    expect(ratio(fg, popover)).toBeGreaterThanOrEqual(4.5)
  })
})
