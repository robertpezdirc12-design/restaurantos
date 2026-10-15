/**
 * Testi i18n za GOSTUJOČE strani (33-b — audit §65/§193: kiosk + QR meni;
 * 49 — customer display, zadnji ostanek audit §137).
 *
 * Acceptance:
 *  - pariteta SL/HR slovarjev za sekcijo 33-b ('guest.*' ključi — identičen set v obeh);
 *  - HR vrednosti niso prazne in se razlikujejo od SL (razen dokumentiranih skupnih izrazov);
 *  - preslikava statusov naročil (javni API vrača fiksne SL nize) v i18n ključe;
 *  - regresija: prevedena besedila se ne vrnejo v trdo kodirano obliko na
 *    gostujočih straneh (kiosk + QR meni + display), preklopnik jezika je prisoten;
 *  - EN (P1-5): delni angleški slovar pokriva 100 % 'guest.*' + 'pay.*' ključev
 *    (QR meni, kiosk, display, javna plačilna povezava) — turistični trg SI/HR.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t, enGuestGaps } from '../src/lib/i18n'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { en } from '../src/lib/i18n/en'
import { guestStatusKey, guestApiErrorKey, guestApiErrorText } from '../src/components/guest-i18n'

const GUEST_PREFIX = 'guest.'

function guestKeys(dict: Record<string, string>): string[] {
  return Object.keys(dict).filter((k) => k.startsWith(GUEST_PREFIX)).sort()
}

// Skupni izrazi, ki so v SL in HR vsebinsko identični (dokumentirane izjeme
// za zahtevo »hr se razlikuje od sl«): 'Hvala!', 'Dodaj', 'Aktiviraj kiosk',
// 'Hrana', 'Košarica', 'Tvoja košarica', 'Alergeni: …', 'Alergeni' (OPS-9 v1.76.0
// — naslov filtra je v obeh jezikih naravno enak), '{label}: {n} od 5'
// ter display izrazi, ki so v obeh jezikih naravno enaki (49).
const SHARED_EQUAL = new Set([
  'guest.common.thanks',
  'guest.common.add',
  'guest.common.status',
  'guest.kiosk.activate',
  'guest.menu.allergens',
  'guest.menu.allergenFilter',
  'guest.cart.button',
  'guest.cart.title',
  'guest.feedback.food',
  'guest.feedback.starAria',
  'guest.display.title',
  'guest.display.showScreen',
  'guest.display.connect',
  'guest.display.online',
  'guest.display.unpair',
  'guest.display.welcome',
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
    // display interpolacija (49)
    expect(t('sl', 'guest.display.vatRate', { rate: 9.5 })).toBe('DDV 9.5 %')
    expect(t('hr', 'guest.display.vatRate', { rate: 9.5 })).toBe('PDV 9.5 %')
    expect(t('sl', 'guest.display.orderNo', { n: 12 })).toBe('Naročilo #12')
    expect(t('hr', 'guest.display.orderNo', { n: 12 })).toBe('Narudžba #12')
  })

  test('display stran je integrirana z guest-i18n (49 — regresija trdo kodiranih)', () => {
    const page = readFileSync(join(import.meta.dir, '../src/app/display/page.tsx'), 'utf8')
    expect(page).toContain('GuestI18nProvider')
    expect(page).toContain('useGuestT')
    expect(page).toContain('GuestLanguageToggle')
    // nobenih novih trdo kodiranih uporabniških nizov (izjeme: tehnični nizi)
    for (const slOnly of ['Dobrodošli!', 'SKUPAJ', 'Uživajte v obroku!', 'Čakam na podatke POS-a']) {
      expect(page).not.toContain(`"${slOnly}`)
      expect(page).not.toContain(`'${slOnly}`)
    }
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

  test('vse gostovske strani uporabljajo GuestI18nProvider + useGuestT + GuestLanguageToggle', () => {
    for (const file of [
      'src/app/kiosk/page.tsx',
      'src/app/m/[token]/page.tsx',
      'src/app/display/page.tsx', // 49
      'src/app/pay/[token]/page.tsx', // P0-2 v1.85.0
    ]) {
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
    expect(src).toContain("['sl', 'hr', 'en']") // P1-5: trije jeziki za gosta
  })
})

// ─── P1-5: ANGLEŠČINA ZA GOSTE (delni slovar) ───

describe('i18n gostov — angleščina (P1-5, TRZNA-VRZELI §4)', () => {
  // Ključi, kjer je SL vrednost že angleška (neprevedljiva oznaka)
  const SHARED_WITH_SL = new Set(['guest.display.title']) // 'Customer display' v obeh

  test('pokritost: 100 % guest.* + pay.* ključev iz SL obstaja v EN', () => {
    expect(enGuestGaps()).toEqual([]) // centralna uveljavljava (src/lib/i18n/index.ts)
    // in enak set v obeh jezikih — noben EN-only ali SL-only gostovski ključ
    const slKeys = Object.keys(sl).filter((k) => k.startsWith('guest.') || k.startsWith('pay.') || k.startsWith('resv.public.')).sort()
    const enKeys = Object.keys(en).filter((k) => k.startsWith('guest.') || k.startsWith('pay.') || k.startsWith('resv.public.')).sort()
    expect(enKeys).toEqual(slKeys)
    expect(enKeys.length).toBeGreaterThan(130) // korenitost: vse 4 javne strani + plačilo
  })

  test('EN vrednosti niso prazne (prevod brez vsebine = mešanica jezikov)', () => {
    for (const [k, v] of Object.entries(en)) {
      if (!v || v.trim() === '') throw new Error(`EN slovar ima prazno vrednost: "${k}"`)
    }
  })

  test('EN vrednosti so resnično angleške (niso SL besedila, razen dokumentiranih)', () => {
    for (const k of Object.keys(en)) {
      if (SHARED_WITH_SL.has(k)) continue
      if (en[k] === sl[k]) throw new Error(`EN vrednost identična SL (neprevedeno): "${k}"`)
    }
  })

  test('zlati prevodi — QR meni / plačilo / statusi / display', () => {
    expect(t('en', 'pay.title')).toBe('Bill payment')
    expect(t('en', 'pay.totalDue')).toBe('Amount due')
    expect(t('en', 'pay.tipCustom')).toBe('Custom (€)')
    expect(t('en', 'guest.menu.selfOrder')).toBe('Self-service ordering')
    expect(t('en', 'guest.cart.submit')).toBe('Submit order')
    expect(t('en', 'guest.status.preparing')).toBe('Preparing')
    expect(t('en', 'guest.display.enjoy')).toBe('Enjoy your meal!')
    expect(t('en', 'guest.kiosk.yourNumber')).toBe('Your order number:')
  })

  test('interpolacija spremenljivk deluje v EN', () => {
    expect(t('en', 'guest.menu.tableSelfOrder', { n: 5 })).toBe('Table 5 · self-service ordering')
    expect(t('en', 'guest.display.orderNo', { n: 12 })).toBe('Order #12')
    expect(t('en', 'guest.feedback.starAria', { label: 'Food', n: 4 })).toBe('Food: 4 of 5')
  })

  test('fallback veriga: dashboard ključ v EN vrne SL (delna pokritost je varna)', () => {
    expect(t('en', 'common.save')).toBe(sl['common.save'])
    expect(t('en', 'tabs.overview')).toBe(sl['tabs.overview'] ?? t('sl', 'tabs.overview'))
  })

  test('jezikovni ključi preklopnika: vsi trije jeziki imajo imena', () => {
    expect(t('en', 'guest.lang.sl')).toBe('Slovenian')
    expect(t('en', 'guest.lang.hr')).toBe('Croatian')
    expect(t('en', 'guest.lang.en')).toBe('English')
    expect(sl['guest.lang.en']).toBe('Angleščina') // dodan tudi v SL/HR slovarja
    expect(hr['guest.lang.en']).toBe('Engleski')
  })
})


// ─── P1-5: preslikava javnih API napak (SL nizi → i18n) ───

describe('i18n gostov — javne API napake prevedene (P1-5)', () => {
  // SL nizi fail() iz vseh javnih rut (→ rg fail\( v src/app/api/public)
  const KNOWN = [
    'QR koda ni veljavna ali je naročanje po QR izklopljeno.',
    'QR koda ni veljavna.',
    'Neveljaven ali izklopljen QR token.',
    'Manjka QR token ali identiteta naprave.',
    'Kiosk naprava ni registrirana.',
    'Kiosk ni povezan z lokacijo.',
    'Naročila ni bilo mogoče varno oddati. Poskusi znova.',
    'Manjkajo podatki.',
    'Manjka idempotency ključ (clientOperationId).',
    'Manjkata qr in orderNumber.',
    'Miza s to številko ne obstaja na lokaciji.',
    'Naročilo s to številko ne obstaja na tej mizi.',
    'Neveljavno telo zahteve.',
    'Ocena je obvezna (1–5).',
    'Preveč naročil naenkrat. Počakaj trenutek.',
    'Preveč poskusov plačila. Počakajte trenutek.',
    'Preveč zahtev. Počakajte trenutek.',
    'Preveč zahtevkov.',
    'Preveč zahtevkov. Poskusi čez minuto.',
    'Plačilne povezave trenutno niso aktivne — poskusite kmalu znova.',
    'Plačilo še ni potrjeno.',
    'Potrditev seje ni na voljo.',
    'Povezava je potekla. Prosimo, zaprosite osebje za novo.',
    'Povezava je preklicana.',
    'Povezava ne obstaja.',
    'Naročilo je že plačano drugje.',
    'Račun je že plačan.',
    'Računa ni mogoče izračunati.',
    'Seja ni bila ustvarjena.',
    'Znesek seje se ne ujema s povezavo.',
    'Napitnina je izven dovoljenega obsega (0 do zneska računa).',
  ]

  test('vsak znan SL niz javnega API-ja ima preslikavo v i18n ključ', () => {
    for (const msg of KNOWN) {
      const key = guestApiErrorKey(msg)
      if (!key) throw new Error(`API niz brez preslikave: "${msg}"`)
    }
    expect(KNOWN.length).toBeGreaterThanOrEqual(31)
  })

  test('preslikovani ključi resnično obstajajo v VSEH treh slovarjih (SL/HR/EN)', () => {
    for (const msg of KNOWN) {
      const key = guestApiErrorKey(msg)!
      expect(sl[key]).toBeTruthy()
      expect(hr[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
  })

  test('nepoznan niz → null (surovi prikaz, nikoli ne strmoglavi)', () => {
    expect(guestApiErrorKey('Nepričakovana interna napaka')).toBeNull()
    expect(guestApiErrorKey('')).toBeNull()
    expect(guestApiErrorKey('   ')).toBeNull()
  })

  test('guestApiErrorText: znan niz → EN prevod; neznan → surov; manjka → fallback', () => {
    const en = (key: string) => t('en', key)
    expect(guestApiErrorText(en, 'QR koda ni veljavna ali je naročanje po QR izklopljeno.', 'guest.menu.unavailable'))
      .toBe('QR code is not valid or self-ordering is disabled.')
    expect(guestApiErrorText(en, 'Plačilne povezave trenutno niso aktivne — poskusite kmalu znova.', 'pay.errorRetry'))
      .toBe('Payment links are currently unavailable — please try again soon.')
    expect(guestApiErrorText(en, 'Nepoznana napaka', 'guest.menu.unavailable')).toBe('Nepoznana napaka')
    expect(guestApiErrorText(en, undefined, 'guest.menu.unavailable')).toBe('Menu is not available.')
    expect(guestApiErrorText(en, null, 'guest.menu.unavailable')).toBe('Menu is not available.')
  })

  test('regresija: gostovske strani uporabljajo guestApiErrorText/useGuestApiError (ne surovega data.error)', () => {
    const { readFileSync } = require('node:fs')
    for (const file of [
      'src/app/m/[token]/page.tsx',
      'src/app/pay/[token]/page.tsx',
      'src/app/kiosk/page.tsx',
      'src/app/display/page.tsx',
    ]) {
      const src = readFileSync(file, 'utf-8')
      // v1.87.1 (issue #2 §C): strani uporabljajo useGuestApiError() — hook, ki
      // internally kliče guestApiErrorText ob vsakem izrisu (močnejša pogodba:
      // besedilo se izračuna s trenutnim jezikom, ne zamrznjeni prevod)
      expect(src.includes('useGuestApiError') || src.includes('guestApiErrorText')).toBe(true)
      // stari vzorec surovega prikaza ne sme več obstajati
      if (/data\.error \|\|/.test(src)) throw new Error(`surovi data.error prikaz ostaja: ${file}`)
    }
  })
})
