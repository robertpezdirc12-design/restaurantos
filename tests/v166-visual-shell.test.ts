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
/** Izlusuje blok lupine (seznamski selektor v treh vrsticah + telo). Vrne ''
    če blok ne obstaja — testi then PADejo, ne vržejo. */
const shellBlock = (d: string): string => {
  const anchor = '[data-region="dashboard-header"],\n[data-region="dashboard-sidebar"],\n[data-region="dashboard-mobile-nav"] {'
  const start = d.indexOf(anchor)
  return start < 0 ? '' : d.slice(start, d.indexOf('}', start))
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
})
