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
