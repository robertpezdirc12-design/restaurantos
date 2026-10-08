/**
 * Testi dvojezičnosti SL/HR (issue #1 triage — velik prečni sklop).
 *
 * Acceptance po triage:
 *  - »v prevodih ne sme ostajati mešanica jezikov ali manjkajoči ključi« → pariteta slovarjev;
 *  - »avtomatski testi zaznajo manjkajoče i18n ključe in hardcodirana uporabniška
 *    besedila v glavnih UI območjih« → sken kritičnih datotek za prevedene nize.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_LOCALE, LOCALES, dictionaryGaps, emptyValues, fiscalStatusLabel,
  isLocale, normalizeLocale, t,
} from '../src/lib/i18n'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

describe('i18n — slovarji', () => {
  test('pariteta: vsak ključ iz SL obstaja v HR (in obratno)', () => {
    const { missingInHr, missingInSl } = dictionaryGaps()
    expect(missingInHr).toEqual([])
    expect(missingInSl).toEqual([])
  })

  test('brez praznih vrednosti (prevod brez vsebine = mešanica jezikov)', () => {
    expect(emptyValues()).toEqual([])
  })

  test('vrednosti v HR niso slovenske besede iz SL slovarja (mešanica)', () => {
    // Preverimo znane slovensko-specifične vrednosti — v HR slovarju NE smejo obstajati
    // (nize z enako vsebino v obeh jezikih, kot 'Prijava'/'Bar', izključimo eksplicitno).
    const allowedSame = new Set([
      'common.app', 'login.title', 'login.submit', 'login.email', 'login.pin', 'login.devicePlaceholder',
      'login.deviceAnother', 'common.yes', 'common.no', 'common.saldo', 'lang.label',
      'tabs.haccp', 'tabs.kuhinja', 'tabs.rezervacije', 'tabs.racuni', 'tabs.dostava', 'tabs.nabava',
      'tabs.zaposleni', 'header.inactive', 'header.online', 'header.offline', 'header.logout',
      'dash.viewLabel', 'dash.locationFallback', 'tables.clickClean', 'tables.qrMenu', 'tables.qrAria',
      'tables.statusAria', 'payment.cash', 'payment.card', 'payment.mobile', 'payment.swap',
      'payment.search', 'payment.redeem', 'payment.discountLabel', 'payment.number', 'payment.eor',
      'payment.issue', 'payment.issuePos', 'payment.issuedSim', 'zones.bar', 'zones.patio', 'zones.private',
      'roles.ADMIN', 'roles.BAR', 'roles.KITCHEN', 'receipt.title', 'receipt.premises', 'receipt.register',
      'receipt.operator', 'receipt.copy', 'receipt.storno', 'receipt.zki', 'receipt.jir',
      'receipt.fursVerified', 'receipt.fursPending', 'receipt.fursFailed', 'receipt.fursNone', 'receipt.fursStatus',
      'login.reconstruction', 'payment.loyaltyEarned', 'payment.issued',
    ])
    const sloSpecific = ['Zasedena', 'Prosta', 'Shrani', 'Prekliči', 'Nalagam…', 'Iskanje', 'Napitnine',
      'Čakalna lista', 'Zaloge', 'Izmene', 'Stroški', 'Zvestoba', 'Mnenja', 'Nastavitve', 'Vse lokacije',
      'Sinhroniziram…', 'Osveži', 'Brez popusta', 'Odstrani', 'Za pospravit', 'Namig']
    for (const val of Object.values(hr)) {
      for (const s of sloSpecific) {
        // HR vrednost ne sme biti enaka slovensko-specifičnemu nizu (razen kot del daljšega besedila)
        if (val.trim() === s) throw new Error(`HR slovar vsebuje slovensko besedilo: "${s}"`)
      }
    }
    expect(allowedSame.size).toBeGreaterThan(0) // dokumentacijski smisel
  })
})

describe('i18n — t() in normalizacija', () => {
  test('privzeti jezik je sl', () => {
    expect(DEFAULT_LOCALE).toBe('sl')
    expect(LOCALES).toEqual(['sl', 'hr'])
  })

  test('t(sl) vrne natanko prvotna besedila (§18)', () => {
    expect(t('sl', 'tabs.mize')).toBe('Mize')
    expect(t('sl', 'status.FREE')).toBe('Prosta')
    expect(t('sl', 'login.subtitle')).toBe('Blagajna · naročila · mize · kuhinja')
  })

  test('t(hr) vrne hrvaške prevode', () => {
    expect(t('hr', 'tabs.mize')).toBe('Stolovi')
    expect(t('hr', 'status.FREE')).toBe('Slobodan')
    expect(t('hr', 'orders.none')).toBe('Nema aktivnih narudžbi.')
  })

  test('interpolacija spremenljivk', () => {
    expect(t('sl', 'tables.seats', { n: 4 })).toBe('4 mest')
    expect(t('hr', 'tables.seats', { n: 4 })).toBe('4 mjesta')
    expect(t('sl', 'dash.viewLabel', { name: 'Maribor' })).toBe('Pogled: Maribor')
    expect(t('hr', 'header.queued', { n: 3 })).toBe('3 u redu')
  })

  test('manjkajoč ključ → SL fallback → še vedno manjka → ključ', () => {
    expect(t('sl', 'nep obstojeci.kljuc')).toBe('nep obstojeci.kljuc')
    expect(t('hr', 'nep obstojeci.kljuc')).toBe('nep obstojeci.kljuc')
  })

  test('normalizeLocale: sl-SI/sl/hr-HR/hr/nepoznano', () => {
    expect(normalizeLocale('sl-SI')).toBe('sl')
    expect(normalizeLocale('sl')).toBe('sl')
    expect(normalizeLocale('hr-HR')).toBe('hr')
    expect(normalizeLocale('HR')).toBe('hr')
    expect(normalizeLocale('de-DE')).toBe('sl')
    expect(normalizeLocale(undefined)).toBe('sl')
    expect(normalizeLocale(42)).toBe('sl')
  })

  test('isLocale varno za branje iz shrambe', () => {
    expect(isLocale('hr')).toBe(true)
    expect(isLocale('de')).toBe(false)
    expect(isLocale(null)).toBe(false)
  })
})

describe('i18n — fiskalna oznaka stanja po državi (ni prevodna funkcija)', () => {
  test('SI tok — FURS oznake', () => {
    expect(fiscalStatusLabel('sl', 'SI', 'pending', false)).toBe(t('sl', 'receipt.fursPending'))
    expect(fiscalStatusLabel('hr', 'si', 'pending', false)).toBe(t('hr', 'receipt.fursPending'))
    expect(fiscalStatusLabel('hr', 'SI', 'none', true)).toBe(t('hr', 'receipt.fursVerified'))
  })

  test('HR tok — Fiskalizacija 2.0 oznake (ne glede na jezik UI)', () => {
    expect(fiscalStatusLabel('sl', 'HR', 'pending', false)).toBe(t('sl', 'receipt.hrPending'))
    expect(fiscalStatusLabel('hr', 'HR', 'pending', false)).toBe(t('hr', 'receipt.hrPending'))
    expect(fiscalStatusLabel('sl', 'HR', 'none', true)).toBe(t('sl', 'receipt.hrVerified'))
    expect(fiscalStatusLabel('hr', 'HR', 'weird', false)).toContain('Fiskalizacija')
  })
})

describe('i18n — regresija hardcodiranih besedil (glavna UI območja)', () => {
  const files = [
    '../src/app/page.tsx',
    '../src/app/dashboard/page.tsx',
  ]
  // Per-datotekni seznam prenesenih nizov: [trdo kodirano besedilo, ključ]
  // njihova vrnitev v trdo kodirano obliko = regresija (acceptance: testi zaznajo hardcodirana besedila).
  const perFile: Record<string, [string, string][]> = {
    '../src/app/page.tsx': [
      ['Blagajna · naročila · mize · kuhinja', 'login.subtitle'],
      ['Vpišite se s službenim računom in PIN kodo.', 'login.desc'],
      ['Aktiviraj napravo (kiosk/display)', 'login.device'],
      ['Vpisna koda (8 števk)', 'login.deviceCode'],
      ['Aktiviraj še eno napravo', 'login.deviceAnother'],
      ['Prijava ni uspela.', 'login.failed'],
      ['Povezava s strežnikom ni uspela.', 'login.connection'],
      ['RestavrantOS · FURS simulacija · EUR', 'login.footer'],
    ],
    '../src/app/dashboard/page.tsx': [
      ['Vse lokacije', 'header.allLocations'],
      ['Sinhronizir', 'header.syncing'], // 'Sinhroniziram…'
      ['Ni aktivnih naročil.', 'orders.none'],
      ['Vsa aktivna naročila', 'orders.allActive'],
      ['Klikni — očisti', 'tables.clickClean'],
      ['Kuhinjski list', 'kitchen.kitchenTicket'],
      ['Bar list', 'kitchen.barTicket'],
      ['Način plačila:', 'payment.method'],
      ['Brez popusta', 'payment.noDiscount'],
      ['Eno plačilo', 'payment.single'],
      ['ZA PLAČATI', 'payment.due'],
      ['Natisni račun', 'payment.print'],
      ['Odjava iz sistema?', 'logout.title'],
      ['Ostani', 'logout.stay'],
      ['Zasedene mize', 'dash.openTables'],
      ['Današnji promet', 'dash.todayRevenue'],
    ],
  }

  for (const file of files) {
    const abs = join(import.meta.dir, file)
    const src = readFileSync(abs, 'utf-8')
    const translated = perFile[file] || []
    test(`${file.split('/').pop()} — prevedena besedila so prek t(), ne trdo kodirana`, () => {
      for (const [text, key] of translated) {
        // uporaba ključa mora obstajati (ali dinamična sestava prefix.key)
        const prefix = key.split('.')[0]
        const used = src.includes(`'${key}'`) || src.includes(`\`${prefix}.${key.split('.')[1]}`)
        if (!used) throw new Error(`${file}: ključ ${key} ni uporabljen`)
        // hardcodirana različica ne sme obstajati (v JSX nizu ali atributu)
        const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const jsxHardcode = new RegExp(`>\\s*${esc}\\s*<`)
        const attrHardcode = new RegExp(`"[^"]*${esc}[^"]*"`)
        if (jsxHardcode.test(src) || attrHardcode.test(src)) {
          throw new Error(`${file}: trdo kodirano besedilo "${text}" (ključ ${key}) je še v UI`)
        }
      }
    })
  }

  test('prijava vsebuje LanguageToggle (preklop iz aplikacije, brez kode)', () => {
    const login = readFileSync(join(import.meta.dir, '../src/app/page.tsx'), 'utf-8')
    expect(login).toContain('LanguageToggle')
    expect(login).toContain('I18nProvider')
  })

  test('dashboard vsebuje preklopnik + provider', () => {
    const dash = readFileSync(join(import.meta.dir, '../src/app/dashboard/page.tsx'), 'utf-8')
    expect(dash).toContain('LanguageToggle')
    expect(dash).toContain('I18nProvider')
    expect(dash).toContain('useI18n')
  })
})
