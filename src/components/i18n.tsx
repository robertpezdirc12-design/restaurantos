'use client'

/**
 * Dvojezičnost SL/HR (issue #1 triage) — React wiring za centralni i18n.
 *
 * - `I18nProvider` — context { locale, setLocale, t } (preklop BREZ reload-a:
 *   le re-render, stanje podatkov ostane — triage zahteva »brez izgube trenutnega dela«);
 * - persistenca: localStorage `restaurantos.locale` (preživi ponovno odprtje + prijavo),
 *   privzeto 'sl' (izvorni jezik aplikacije — §18);
 * - `LanguageToggle` — SL | HR preklopnik (deluje na prijavi in v glavi dashboarda).
 *
 * Higiena: `useSyncExternalStore` — SSR/hidracija uporabita strežniški snapshot ('sl'),
 * po hidraciji se preklopi na shranjeno vrednost (brez setState-v-effect in brez
 * hidracijskega razpada).
 */

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, isLocale, normalizeLocale, t as coreT, type Locale } from '@/lib/i18n'

// ── Mikro-store okoli localStorage (isti vzorec kot offline queue) ──
let currentLocale: Locale = DEFAULT_LOCALE
let initialized = false
const listeners = new Set<() => void>()

function loadStoredLocale(): void {
  if (initialized) return
  initialized = true
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(saved)) { currentLocale = saved; return }
    // prvi obisk: jezik brskalnika (sl/hr), privzeto sl
    currentLocale = normalizeLocale(navigator.language)
  } catch { /* zasebni način/shramba onemogočena — ostane 'sl' */ }
}

function subscribe(cb: () => void): () => void {
  loadStoredLocale() // varno tudi ob pozni naročnini
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getClientSnapshot(): Locale {
  loadStoredLocale()
  return currentLocale
}

function getServerSnapshot(): Locale {
  return DEFAULT_LOCALE
}

export function setStoredLocale(l: Locale): void {
  loadStoredLocale()
  if (l === currentLocale) return
  currentLocale = l
  try { localStorage.setItem(LOCALE_STORAGE_KEY, l) } catch { /* ignoriraj */ }
  listeners.forEach((cb) => cb())
}

// ── Provider ──
interface I18nContextValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key, vars) => coreT(DEFAULT_LOCALE, key, vars),
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot)

  const setLocale = useCallback((l: Locale) => setStoredLocale(l), [])

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: (key, vars) => coreT(locale, key, vars) }),
    [locale, setLocale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

/**
 * SL | HR preklopnik — segmentiran gumb, deluje na prijavi in v glavi.
 * EN (P1-5) je NAMERNO izven dashboard izbire: če je shranjen 'en' (nastavil ga
 * je gost na isti napravi — skupni LOCALE_STORAGE_KEY), se vsebina še vedno izriše
 * iz SL slovarja (t() fallback) in je SL poudarjen kot aktiven; osebje z enim
 * klikom preklopi nazaj na sl/hr.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n()
  return (
    <div
      className={`os-language-toggle inline-flex items-center rounded-lg border border-stone-200 bg-white p-0.5 text-xs font-semibold ${className || ''}`}
      role="group"
      aria-label={t('lang.aria')}
    >
      {(['sl', 'hr'] as Locale[]).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l || (locale === 'en' && l === 'sl')}
          aria-label={t(`lang.${l}`)}
          onClick={() => setLocale(l)}
          className={`rounded-md px-2 py-1 transition ${
            locale === l || (locale === 'en' && l === 'sl')
              ? 'bg-emerald-700 text-white shadow-sm'
              : 'text-stone-600 hover:text-stone-900'
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
