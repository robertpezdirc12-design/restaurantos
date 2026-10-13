/**
 * Issue #2 §C (v1.87.1) — REGRESIJA: preklop jezika na gostujoči strani NI takoj
 * prevedel ŽE PRIKAZANE napake (strani so ob napaki shranile ŽE PREVEDENO
 * besedilo — prevod zamrznjen v jeziku trenutka napake; uporabnik vidi SL
 * napako tudi po preklopu na EN, dokler napaka ne izgine/pojavi se nova).
 *
 * Mehani/Popravek: useGuestApiError() (src/components/guest-i18n.tsx) — state
 * hrani SUROVI strežniški niz (SL vir) + fallback ključ; besedilo se IZRAČUNA
 * ob vsakem izrisu s trenutnim t() → preklop SL↔HR↔EN takoj prevede.
 *
 * Pokritje:
 *  1. funkcionalno: isti surov niz + drug jezik → DRUGO (pravilno) besedilo —
 *     to je EXAKTNO regresijski scenarij ("prikaži napako v SL, preklopi na
 *     HR/EN in dokazuj takojšnji prevod");
 *  2. strukturno: VSE 4 gostovske strani (pay, m, kiosk, display) uporabljajo
 *     useGuestApiError in NE klicajo guestApiErrorText v setState oz. ne
 *     shranjujejo prevedenega besedila napak;
 *  3. varnostne meje: neznan niz ostane surov pri vseh jezikih (brez sesutja).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t, type Locale } from '../src/lib/i18n'
import { guestApiErrorText } from '../src/components/guest-i18n'

// znani strežniški niz (javni API vrača SL vire)
const READ = (p: string) => readFileSync(join(import.meta.dir, p), 'utf8')

/** vezan prevajalnik (kot ga hook dobi iz useGuestT ob vsakem izrisu) */
const tOf = (l: Locale) => (k: string) => t(l, k)

const RAW = 'Povezava ne obstaja.'
const RAW2 = 'Račun se je spremenil — prosite osebje za novo povezavo.'

describe('guest i18n — takojšnji prevod ŽE PRIKAZANE napake (issue #2 §C)', () => {
  test('funkcionalno: isti surov niz, drug jezik → takoj drugo besedilo (SL → HR → EN)', () => {
    // stanje shranjuje SAMO surovi niz (kot useGuestApiError) — izris kliče
    // guestApiErrorText s TRENUTNIM jezikom ob vsakem renderju:
    const slText = guestApiErrorText(tOf('sl'), RAW, 'pay.notFound')
    const hrText = guestApiErrorText(tOf('hr'), RAW, 'pay.notFound')
    const enText = guestApiErrorText(tOf('en'), RAW, 'pay.notFound')
    expect(slText).toBe('Povezava ne obstaja ali je potekla.')
    expect(hrText).toBe('Poveznica ne postoji ili je istekla.')
    expect(enText).toBe('This link does not exist or has expired.')
    // RAZLIČNA besedila iz ISTEGA surovega niza = prevod NI zamrznjen
    expect(new Set([slText, hrText, enText]).size).toBe(3)
  })

  test('funkcionalno: P1-6 napaka (spremenjen račun) prav tako prevede v vseh jezikih', () => {
    expect(guestApiErrorText(tOf('sl'), RAW2, 'pay.errorRetry')).toBe(RAW2)
    expect(guestApiErrorText(tOf('en'), RAW2, 'pay.errorRetry')).toBe('The bill has changed — please ask staff for a new link.')
    expect(guestApiErrorText(tOf('hr'), RAW2, 'pay.errorRetry')).toBe('Račun se promijenio — zatražite novo poveznicu.')
  })

  test('neznan niz ostane surov v vseh jezikih (varna meja, brez sesutja)', () => {
    const unknown = 'Popolnoma nepoznan niz 123'
    for (const l of ['sl', 'hr', 'en'] as const) {
      expect(guestApiErrorText(tOf(l), unknown, 'pay.errorRetry')).toBe(unknown)
    }
  })

  test('strukturno: 4 gostovske strani uporabljajo useGuestApiError (ne zamrznjenih prevodov)', () => {
    const pages = [
      '../src/app/pay/[token]/page.tsx',
      '../src/app/m/[token]/page.tsx',
      '../src/app/kiosk/page.tsx',
      '../src/app/display/page.tsx',
    ]
    for (const p of pages) {
      const src = READ(p)
      expect(src.includes('useGuestApiError'), `${p} manjka useGuestApiError`).toBe(true)
      // prepovedani vzorci zamrznjenega prevoda (stara napaka §C):
      expect(src.includes('setError(guestApiErrorText('), `${p} zamrznjen prevod v setError`).toBe(false)
      expect(src.includes('setPayError(guestApiErrorText('), `${p} zamrznjen prevod v setPayError`).toBe(false)
      expect(src.includes('setFbError(guestApiErrorText('), `${p} zamrznjen prevod v setFbError`).toBe(false)
      // napake se shranjujejo kot SUROVI nizi (err.set(data?.error, …)):
      expect(src.includes('.set(data?.error,'), `${p} pričakujem err.set(data?.error, …)`).toBe(true)
    }
  })

  test('hook: izvoz uporablja guestApiErrorText ob IZRAČUNU (render), ne v callbacku', () => {
    const src = READ('../src/components/guest-i18n.tsx')
    expect(src.includes('export function useGuestApiError')).toBe(true)
    // besedilo je odvod stanja v telesu hooka (izračun ob vsakem izrisu):
    expect(src.includes("const text = error ? guestApiErrorText(t, error.raw, error.fallbackKey) : ''")).toBe(true)
  })
})

// tip helper (Locale kot vrednost za t() klice v testih)
