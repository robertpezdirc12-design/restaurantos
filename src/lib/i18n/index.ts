/**
 * Dvojezičnost SL/HR (issue #1 triage) + DELNI EN za goste (P1-5) — CENTRALNI i18n SISTEM.
 *
 * Zasnova (po triage odločitvi):
 *  - centralno prek `t()` — brez hardcodiranih besedil v kritičnih tokovih;
 *  - SL = izvorni jezik (vrednosti = prvotna besedila, §18); HR = polni paritetni slovar;
 *  - preklop iz aplikacije brez reload-a (React context — src/components/i18n.tsx);
 *  - persistenca: localStorage (preživi ponovno odprtje + prijavo), privzeto 'sl';
 *  - fiskalizacija NI prevodna funkcija: SI (FURS) in HR (Fiskalizacija 2.0) tokova
 *    se ločita po državi lokacije — glej src/lib/fiscal/.
 *
 * Ta inkrement (postopno, po triage): infrastruktura + POS/kritični tokovi
 * (prijava, glava, zavihki, mize, naročila, KDS, plačilo, natisnjen račun).
 * Preostali moduli sledijo v naslednjem inkrementu — nekritična besedila ostanejo
 * SL (izvorno) dokler niso prenesena v slovar.
 */

import { sl } from './sl'
import { hr } from './hr'
import { en } from './en'

export type Locale = 'sl' | 'hr' | 'en'

export const LOCALES: Locale[] = ['sl', 'hr', 'en']
export const DEFAULT_LOCALE: Locale = 'sl'

/** localStorage ključ — jezik preživi ponovno odprtje aplikacije (triage zahteva). */
export const LOCALE_STORAGE_KEY = 'restaurantos.locale'

const DICTS: Record<Locale, Record<string, string>> = { sl, hr, en }

/**
 * EN je NAMERNO DELNI slovar (P1-5): pokriva SAMO gostujoče površine
 * ('guest.*' + 'pay.*' — QR meni, kiosk, display, javna plačilna povezava).
 * Dashboard/osebje ostaja SL/HR; manjkajoč ključ v EN → t() vrne SL vrednost
 * (fallback en → sl, isti varovalni vzorec kot manjkajoč HR ključ).
 * Pokritost teh dveh predpon uveljavlja tests/i18n-guest.test.ts.
 */
export const EN_GUEST_PREFIXES = ['guest.', 'pay.', 'resv.public.'] as const

/**
 * 'sl-SI' | 'sl' | 'hr-HR' | 'hr' | 'en' | 'en-US' | nepoznano → normaliziran Locale
 * (fallback sl). EN je gostovski jezik (P1-5): angleški brskalnik → javne strani
 * se takoj izrišejo v EN; dashboard t() samodejno pade na SL vsebino.
 */
export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== 'string') return DEFAULT_LOCALE
  const v = value.trim().toLowerCase()
  if (v === 'hr' || v.startsWith('hr-')) return 'hr'
  if (v === 'sl' || v.startsWith('sl-')) return 'sl'
  if (v === 'en' || v.startsWith('en-')) return 'en'
  return DEFAULT_LOCALE
}

/** Preveri, ali je vrednost veljaven Locale (za varno branje iz shrambe). */
export function isLocale(value: unknown): value is Locale {
  return value === 'sl' || value === 'hr' || value === 'en'
}

/** Prevod ključa. Manjkajoč ključ (hr/en) → SL fallback → še vedno manjka → vrne ključ (vidljivost, test ga zazna). EN je delne — dashboard ključi se v EN izrišejo iz SL slovarja. */
export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[locale] ?? DICTS[DEFAULT_LOCALE]
  let out = dict[key]
  if (out === undefined) out = DICTS[DEFAULT_LOCALE][key]
  if (out === undefined) return key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(String(v))
    }
  }
  return out
}

/** Pariteta slovarjev SL↔HR (za teste in diagnostiko): ključi, ki manjkajo v enem od obeh. EN je namerno delne — gl. enGuestGaps(). */
export function dictionaryGaps(): { missingInHr: string[]; missingInSl: string[] } {
  const missingInHr: string[] = []
  const missingInSl: string[] = []
  for (const k of Object.keys(sl)) if (!(k in hr)) missingInHr.push(k)
  for (const k of Object.keys(hr)) if (!(k in sl)) missingInSl.push(k)
  return { missingInHr, missingInSl }
}

/**
 * Pokritost delnega EN slovarja (P1-5): KLJUČI predpon EN_GUEST_PREFIXES iz SL,
 * ki manjkajo v EN. Prazno = polna pokritost gostovskih površin v angleščini.
 * (Zrcelni test: tests/i18n-guest.test.ts zahteva [].)
 */
export function enGuestGaps(): string[] {
  const enKeys = new Set(Object.keys(en))
  return Object.keys(sl)
    .filter((k) => EN_GUEST_PREFIXES.some((p) => k.startsWith(p)) && !enKeys.has(k))
    .sort()
}

/** Prazne vrednosti v slovarjih so napaka (prevod brez vsebine = mešanica jezikov). */
export function emptyValues(): { locale: Locale; keys: string[] }[] {
  const out: { locale: Locale; keys: string[] }[] = []
  for (const locale of LOCALES) {
    const keys = Object.entries(DICTS[locale]).filter(([, v]) => !v || v.trim() === '').map(([k]) => k)
    if (keys.length > 0) out.push({ locale, keys })
  }
  return out
}

/**
 * Fiskalna oznaka stanja za natisnjen račun — po državi (fiskalizacija ni prevodna
 * funkcija; oznaka tokom pa je, ker gre za uporabniški izhod).
 */
export function fiscalStatusLabel(locale: Locale, country: string, status: string, verified: boolean): string {
  const c = (country || 'SI').toUpperCase()
  if (c === 'HR') {
    if (verified) return t(locale, 'receipt.hrVerified')
    switch ((status || '').toLowerCase()) {
      case 'pending': return t(locale, 'receipt.hrPending')
      case 'failed': return t(locale, 'receipt.hrFailed')
      case 'none': return t(locale, 'receipt.hrNone')
      default: return t(locale, 'receipt.hrStatus', { status: status || '—' })
    }
  }
  if (verified) return t(locale, 'receipt.fursVerified')
  switch ((status || '').toLowerCase()) {
    case 'pending': return t(locale, 'receipt.fursPending')
    case 'failed': return t(locale, 'receipt.fursFailed')
    case 'none': return t(locale, 'receipt.fursNone')
    default: return t(locale, 'receipt.fursStatus', { status: status || '—' })
  }
}
