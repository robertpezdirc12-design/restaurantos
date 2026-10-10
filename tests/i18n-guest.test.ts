/**
 * Testi i18n za GOSTUJOČE strani (33-b — audit §65/§193: kiosk + QR meni).
 *
 * Acceptance:
 *  - pariteta SL/HR slovarjev za sekcijo 33-b ('guest.*' ključi — identičen set v obeh);
 *  - HR vrednosti niso prazne in se razlikujejo od SL (razen dokumentiranih skupnih izrazov);
 *  - preslikava statusov naročil (javni API vrača fiksne SL nize) v i18n ključe;
 *  - regresija: prevedena besedila se ne vrnejo v trdo kodirano obliko na
 *    gostujočih straneh (kiosk + QR meni), preklopnik jezika je prisoten.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../src/lib/i18n'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { guestStatusKey } from '../src/components/guest-i18n'

const GUEST_PREFIX = 'guest.'

function guestKeys(dict: Record<string, string>): string[] {
  return Object.keys(dict).filter((k) => k.startsWith(GUEST_PREFIX)).sort()
}

// Skupni izrazi, ki so v SL in HR vsebinsko identični (dokumentirane izjeme
// za zahtevo »hr se razlikuje od sl«): 'Hvala!', 'Dodaj', 'Aktiviraj kiosk',
// 'Hrana', 'Košarica', 'Tvoja košarica', 'Alergeni: …', '{label}: {n} od 5'.
const SHARED_EQUAL = new Set([
  'guest.common.thanks',
  'guest.common.add',
  'guest.common.status',
  'guest.kiosk.activate',
  'guest.menu.allergens',
  'guest.cart.button',
  'guest.cart.title',
  'guest.feedback.food',
  'guest.feedback.starAria',
])

describe('i18n gostov — pariteta slovarjev (sekcija 33-b)', () => {
  test('identičen set guest.* ključev v SL in HR', () => {
    const slKeys = guestKeys(sl)
    const hrKeys = guestKeys(hr)
    expect(slKeys.length).toBeGreaterThan(60) // sekcija obstaja in je korenita
    expect(hrKeys).toEqual(slKeys)
  })

  test('brez praznih vrednosti v guest.* (obe jezika)', () => {
    for (const [locale, dict] of [['sl', sl], ['hr', hr]] as const) {
      for (const k of guestKeys(dict)) {
        expect(dict[k]?.trim().length ?? 0).toBeGreaterThan(0)
        void locale
      }
    }
  })

  test('HR vrednosti se razlikujejo od SL (razen dokumentiranih skupnih izrazov)', () => {
    for (const k of guestKeys(sl)) {
      if (SHARED_EQUAL.has(k)) {
        expect(hr[k]).toBe(sl[k]) // izjema dokumentirana — mora ostati identična
        continue
      }
      expect(hr[k]).not.toBe(sl[k])
    }
  })

  test('dokumentirane izjeme so res identične v vsebini (ni praznih oznak)', () => {
    expect(sl['guest.common.thanks']).toBe('Hvala!')
    expect(hr['guest.common.thanks']).toBe('Hvala!')
    expect(sl['guest.common.add']).toBe('Dodaj')
    expect(hr['guest.common.add']).toBe('Dodaj')
    expect(sl['guest.feedback.food']).toBe('Hrana')
    expect(hr['guest.feedback.food']).toBe('Hrana')
    expect(sl['guest.cart.button']).toBe('Košarica')
    expect(hr['guest.cart.button']).toBe('Košarica')
  })

  test('HR ne vsebuje slovensko-specifičnih guest vrednosti (mešanica jezikov)', () => {
    const sloSpecific = ['V pripravi', 'Pripravljeno', 'Plačano', 'Preklicano', 'Skupaj', 'Znesek',
      'Miza', 'Naročilo', 'Oddaj', 'Pošlji mnenje', 'Vzdušje', 'Storitev', 'DDV', 'Opomba']
    for (const k of guestKeys(hr)) {
      for (const s of sloSpecific) {
        if (hr[k].trim() === s) throw new Error(`HR guest slovar vsebuje slovensko besedilo "${s}" (ključ ${k})`)
      }
    }
  })

  test('t() interpolacija na guest ključih (SL + HR)', () => {
    expect(t('sl', 'guest.menu.tableSelfOrder', { n: 9 })).toBe('Miza 9 · samopostrežno naročanje')
    expect(t('hr', 'guest.menu.tableSelfOrder', { n: 9 })).toBe('Stol 9 · samoposlužno naručivanje')
    expect(t('hr', 'guest.menu.orderDone', { n: 12 })).toBe('Narudžba #broj: 12')
    expect(t('sl', 'guest.menu.orderDone', { n: 12 })).toBe('Naročilo #številka: 12')
    expect(t('hr', 'guest.feedback.starAria', { label: 'Hrana', n: 4 })).toBe('Hrana: 4 od 5')
    expect(t('hr', 'guest.status.preparing')).toBe('U pripremi')
    expect(t('hr', 'guest.common.vat')).toBe('PDV')
    expect(t('hr', 'guest.kiosk.submit')).toBe('Pošalji')
    expect(t('sl', 'guest.kiosk.submit')).toBe('Oddaj')
  })
})

describe('i18n gostov — preslikava statusov (javni API vrača fiksne SL nize)', () => {
  test('GUEST_VISIBLE_ORDER_STATUS nizi → i18n ključi', () => {
    expect(guestStatusKey('prejeto')).toBe('guest.status.received')
    expect(guestStatusKey('v pripravi')).toBe('guest.status.preparing')
    expect(guestStatusKey('pripravljeno')).toBe('guest.status.ready')
    expect(guestStatusKey('postreženo')).toBe('guest.status.served')
    expect(guestStatusKey('plačano')).toBe('guest.status.paid')
    expect(guestStatusKey('preklicano')).toBe('guest.status.cancelled')
  })

  test('rezerva: surove enum vrednosti → isti ključi', () => {
    expect(guestStatusKey('open')).toBe('guest.status.received')
    expect(guestStatusKey('in_progress')).toBe('guest.status.preparing')
    expect(guestStatusKey('ready')).toBe('guest.status.ready')
    expect(guestStatusKey('served')).toBe('guest.status.served')
    expect(guestStatusKey('paid')).toBe('guest.status.paid')
    expect(guestStatusKey('cancelled')).toBe('guest.status.cancelled')
  })

  test('toleranca na velikost črk in presledke; nepoznan status → null', () => {
    expect(guestStatusKey('  Plačano  ')).toBe('guest.status.paid')
    expect(guestStatusKey('PAID')).toBe('guest.status.paid')
    expect(guestStatusKey('neznano stanje')).toBeNull()
    expect(guestStatusKey('')).toBeNull()
    expect(guestStatusKey(undefined as unknown as string)).toBeNull()
  })

  test('preslikani ključi obstajajo v obeh slovarjih (nikoli surov ključ v UI)', () => {
    for (const raw of ['prejeto', 'v pripravi', 'pripravljeno', 'postreženo', 'plačano', 'preklicano']) {
      const k = guestStatusKey(raw)
      expect(k).not.toBeNull()
      expect(sl[k as string]).toBeTruthy()
      expect(hr[k as string]).toBeTruthy()
    }
  })
})

describe('i18n gostov — regresija hardcodiranih besedil (kiosk + QR stran)', () => {
  const root = join(import.meta.dir, '..')
  const read = (p: string) => readFileSync(join(root, p), 'utf8')

  // [trdo kodirano besedilo, i18n ključ] — vrnitev v trdo kodirano obliko = regresija
  const perFile: Record<string, [string, string][]> = {
    'src/app/kiosk/page.tsx': [
      ['Kiosk aktivacija', 'guest.kiosk.title'],
      ['Vnesi ENKRATNO vpisno kodo', 'guest.kiosk.instructions'],
      ['Aktiviraj kiosk', 'guest.kiosk.activate'],
      ['Kiosk ni aktiviran.', 'guest.kiosk.notActivated'],
      ['Aktivacija ni uspela.', 'guest.kiosk.activationFailed'],
      ['Vnesi vpisno kodo (8 števk)', 'guest.kiosk.tokenHint'],
      ['Samopostrežni kiosk — izberi artikle', 'guest.kiosk.subtitle'],
      ['Tvoja številka naročila:', 'guest.kiosk.yourNumber'],
      ['Kiosk se samodejno ponastavi', 'guest.kiosk.autoReset'],
      ['Košarica je prazna — tapni artikel', 'guest.kiosk.cartEmpty'],
      ['npr. brez ledenika', 'guest.kiosk.notePlaceholder'],
      ['plačilo na blagajni', 'guest.common.payAtCashier'],
      ['Ni na voljo', 'guest.common.unavailable'],
      ['neobvezno', 'guest.common.optional'],
      ['Povezava ni dosegljiva.', 'guest.error.unreachable'],
      ['Naročila ni bilo mogoče oddati.', 'guest.error.orderFailed'],
      ['naročilo NI oddano.', 'guest.error.orderNotSubmitted'],
    ],
    'src/app/m/[token]/page.tsx': [
      ['Meni ni na voljo.', 'guest.menu.unavailable'],
      ['Nalagam meni', 'guest.menu.loading'],
      ['Poskusi znova', 'guest.common.retry'],
      ['samopostrežno naročanje', 'guest.menu.tableSelfOrder'],
      ['Brez povezave', 'guest.common.offline'],
      ['Naročilo #številka', 'guest.menu.orderDone'],
      ['Novo naročilo', 'guest.menu.newOrder'],
      ['Trenutno ni na voljo', 'guest.common.unavailableNow'],
      ['Kako je bilo? Pustite nam mnenje', 'guest.feedback.cta'],
      ['Vaše mnenje', 'guest.feedback.title'],
      ['Hvala za mnenje', 'guest.feedback.thanks'],
      ['Komentar (neobvezno)', 'guest.feedback.commentPlaceholder'],
      ['Ime (neobvezno)', 'guest.common.nameOptional'],
      ['Pošlji mnenje', 'guest.feedback.submit'],
      ['Mnenja ni bilo mogoče oddati.', 'guest.feedback.failed'],
      ['mnenje NI oddano.', 'guest.error.feedbackNotSubmitted'],
      ['Tvoja košarica', 'guest.cart.title'],
      ['Seznam brez DDV', 'guest.cart.vatExcl'],
      ['Za klic na ime', 'guest.cart.nameHint'],
      ['Oddaj naročilo', 'guest.cart.submit'],
      ['Oddajam …', 'guest.common.submitting'],
      ['brez doplačila', 'guest.common.noSurcharge'],
      ['Opomba kuhinji', 'guest.common.noteKitchen'],
      ['npr. brez čebule', 'guest.menu.notePlaceholder'],
      ['Alergeni:', 'guest.menu.allergens'],
      ['razpoložljivih artiklov', 'guest.menu.emptyCategory'],
      ['cene vsebujejo DDV', 'guest.menu.vatNote'],
    ],
  }

  for (const [file, pairs] of Object.entries(perFile)) {
    test(`${file}: vsi UI nizi prek t() (brez hardcodirane SL)`, () => {
      const src = read(file)
      for (const [hardcoded, key] of pairs) {
        expect(sl[key]).toBeTruthy() // ključ res obstaja v slovarju
        expect(src).not.toContain(hardcoded) // in ni več trdo kodiran
      }
    })
  }

  test('obe strani uporabljata GuestI18nProvider + useGuestT + GuestLanguageToggle', () => {
    for (const file of ['src/app/kiosk/page.tsx', 'src/app/m/[token]/page.tsx']) {
      const src = read(file)
      expect(src).toContain('GuestI18nProvider')
      expect(src).toContain('useGuestT')
      expect(src).toContain('GuestLanguageToggle')
    }
  })

  test('preklopnik jezika: dostopen (aria-pressed, role=group, 44px dotik), deli shrambo z glavno aplikacijo', () => {
    const src = read('src/components/guest-i18n.tsx')
    expect(src).toContain('aria-pressed')
    expect(src).toContain('role="group"')
    expect(src).toContain('min-w-[44px]')
    expect(src).toContain('LOCALE_STORAGE_KEY') // isti ključ localStorage kot dashboard
  })
})
