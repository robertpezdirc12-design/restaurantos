/**
 * Testi error boundaries (50) — statični regresijski vzorec (kot display test).
 *
 * Acceptance:
 *  - error.tsx: 'use client', role="alert", reset(), dvojezična besedila, digest pogojen;
 *  - global-error.tsx: lasten <html><body> (zahteva Next.js), brez kontekstov, reset();
 *  - not-found.tsx: branded 404, povezava na "/", dvojezična;
 *  - samozadostnost: boundaries NE uporabljajo I18nProvider/useGuestT (crash-vzročna
 *    odvisnost je lahko prav tam — besedila so statična SL+HR).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(join(import.meta.dir, '../src/app', p), 'utf8')

describe('error boundaries (50)', () => {
  test('error.tsx — klient, alert, reset, dvojezično, digest pogojen', () => {
    const s = read('error.tsx')
    expect(s).toContain("'use client'")
    expect(s).toContain('role="alert"')
    expect(s).toContain('reset()') // uporablja reset (onClick={reset})
    expect(s).toContain('Ups — prišlo je do napake')
    expect(s).toContain('došlo je do greške') // HR sekundarno
    expect(s).toContain('error.digest &&') // digest SAMO kadar obstaja
    expect(s).toContain('console.error') // dejstvo o napaki opazljivo
    // samozadostnost: brez crash-vzročnih odvisnosti
    expect(s).not.toContain('useGuestT')
    expect(s).not.toContain('I18nProvider')
  })

  test('global-error.tsx — lasten html/body, brez kontekstov', () => {
    const s = read('global-error.tsx')
    expect(s).toContain("'use client'")
    expect(s).toContain('<html')
    expect(s).toContain('<body')
    expect(s).toContain('globals.css')
    expect(s).toContain('role="alert"')
    expect(s).toContain('Napaka aplikacije')
    expect(s).toContain('Greška aplikacije')
    expect(s).not.toContain('useGuestT')
    expect(s).not.toContain('ThemeProvider')
  })

  test('not-found.tsx — branded 404 s povezavo na začetek', () => {
    const s = read('not-found.tsx')
    expect(s).toContain('404')
    expect(s).toContain('Stran ne obstaja')
    expect(s).toContain('Stranica ne postoji')
    expect(s).toContain('href="/"')
    expect(s).not.toContain("'use client'") // server component
  })
})
