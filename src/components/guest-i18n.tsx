'use client'

/**
 * Petjezičnost SL/HR/EN/DE/IT za GOSTUJOČE strani (audit §65/§193 — 33-b; P1-5 EN;
 * P3-21 DE/IT v1.191.0).
 *
 * Kiosk (/kiosk) in QR meni (/m/<token>) NE hodita skozi dashboard (in njegov
 * I18nProvider), zato imata lahkoten samostojen provider — brez odvisnosti od
 * prijave/auth, a z ISTO infrastrukturo:
 *  - isti centralni slovar prek `t()` (src/lib/i18n/index.ts) — manjkajoč ključ
 *    v HR/EN/DE/IT → SL vrednost (EN/DE/IT so DELNI slovarji samo za gostovske
 *    predpone — dashboard ključi se izrišejo iz SL); manjka povsod → ključ +
 *    console.warn v dev;
 *  - isti localStorage ključ (LOCALE_STORAGE_KEY = 'restaurantos.locale') —
 *    izbira jezika je povezana z glavno aplikacijo (gost in osebje si delita
 *    nastavitev na isti napravi; kiosk terminal si jo zapomni med ponovitvami);
 *  - preklop BREZ reload-a (mikro-store + useSyncExternalStore, isti vzorec kot
 *    src/components/i18n.tsx — SSR snapshot 'sl', po hidraciji shranjena vrednost).
 *
 * Izvoz: GuestI18nProvider, useGuestT(), GuestLanguageToggle (prenosljiv pill
 * SL | HR | EN — varianti 'light' (QR/plačilo) in 'dark' (kiosk)), guestStatusKey() za
 * prevod statusov naročil, ki jih javni API vrne kot fiksne SL nize.
 */

import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  applyDocumentLang,
  isLocale,
  normalizeLocale,
  t as coreT,
  type Locale,
} from '@/lib/i18n'

// ── Mikro-store okoli localStorage (isti vzorec kot dashboard i18n) ──
let currentLocale: Locale = DEFAULT_LOCALE
let initialized = false
const listeners = new Set<() => void>()

function loadStoredLocale(): void {
  if (initialized) return
  initialized = true
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(saved)) {
      currentLocale = saved
    } else {
      // prvi obisk: jezik brskalnika (sl/hr/en/de/it) — hrvaški gost dobi HR,
      // angleški turist EN (P1-5), nemški/italijanski turist DE/IT (P3-21), privzeto sl
      currentLocale = normalizeLocale(navigator.language)
    }
  } catch { /* zasebni način/shramba onemogočena — ostane 'sl' */ }
  // WCAG 3.1.1/3.1.2 (v1.176.0): jezik dokumenta mora slediti dejansko izpisani
  // vsebini — sicer bralni zaslon angleški ali hrvaški meni bere po slovenskih
  // pravilih izgovarjave.
  applyDocumentLang(currentLocale)
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

/** Preklopi jezik gostujočih strani (in glavne aplikacije — isti ključ shrambe). */
export function setGuestLocale(l: Locale): void {
  loadStoredLocale()
  if (l === currentLocale) return
  currentLocale = l
  try { localStorage.setItem(LOCALE_STORAGE_KEY, l) } catch { /* ignoriraj */ }
  applyDocumentLang(l)
  listeners.forEach((cb) => cb())
}

/** Prevod z diagnostiko: manjkajoč ključ povsod → console.warn v dev (vidljivost). */
function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const out = coreT(locale, key, vars)
  if (process.env.NODE_ENV !== 'production' && out === key) {
    console.warn(`[guest-i18n] Manjkajoči i18n ključ: "${key}" (ni v SL/HR/EN/DE/IT slovarjih)`)
  }
  return out
}

// ── Context ──
interface GuestI18nValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const GuestI18nContext = createContext<GuestI18nValue | null>(null)

export function GuestI18nProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot)
  const setLocale = useCallback((l: Locale) => setGuestLocale(l), [])
  const value = useMemo<GuestI18nValue>(
    () => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale],
  )
  return <GuestI18nContext.Provider value={value}>{children}</GuestI18nContext.Provider>
}

/**
 * Jezik + prevajalna funkcija za gostujoče strani.
 * Deluje tudi BREZ providerja (fallback na mikro-store) — provider je priporočen.
 */
export function useGuestT(): GuestI18nValue {
  const ctx = useContext(GuestI18nContext)
  const locale = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot)
  return useMemo(
    () => ctx ?? { locale, setLocale: setGuestLocale, t: (key, vars) => translate(locale, key, vars) },
    [ctx, locale],
  )
}

// ── SL | HR | EN | DE | IT preklopnik (prenosljiv med gostovskimi stranmi) ──

/**
 * Diskreten pill "SL | HR | EN | DE | IT" — fiksiran zgornji desni kot po izbiri strani
 * (kiosk: v glavi poleg zaklepa / na aktivaciji fiksiran; QR in /pay: v lepljivi
 * glavi). EN (P1-5): turistični trg SI/HR — angleški gost vidi lastni jezik.
 * DE/IT (P3-21, v1.191.0): nemško in italijansko govoreči gostje — največji
 * turistični skupini v SI za EN.
 * - `variant="dark"` za kiosk (temna ozadja), `"light"` za QR stran (svetla ozadja)
 * - aria-pressed + aria-label + tipkovnica dostopno (pravi <button> elementi)
 * - dotik: vsak gumb ≥ 44 px (h-[44px] min-w-[44px])
 */
export function GuestLanguageToggle({
  variant = 'light',
  className = '',
}: {
  variant?: 'light' | 'dark'
  className?: string
}) {
  const { locale, setLocale, t } = useGuestT()
  const shell =
    variant === 'dark'
      ? 'border-stone-700 bg-stone-800/90 text-stone-300'
      : 'border-stone-200 bg-white/95 text-stone-600'
  const active =
    variant === 'dark'
      ? 'bg-white text-stone-900 shadow-sm'
      : 'bg-stone-900 text-white shadow-sm'
  return (
    <div
      className={`inline-flex shrink-0 items-center rounded-full border p-0.5 text-xs font-semibold ${shell} ${className}`}
      role="group"
      aria-label={t('guest.lang.aria')}
    >
      {(['sl', 'hr', 'en', 'de', 'it'] as Locale[]).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          aria-label={t(`guest.lang.${l}`)}
          onClick={() => setLocale(l)}
          className={`h-[44px] min-w-[44px] rounded-full px-2.5 transition ${locale === l ? active : 'hover:opacity-80'}`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

// ── Statusi naročil za gosta ──

/**
 * Javni API (GET /api/public/orders/status) vrne status kot fiksni SL niz iz
 * GUEST_VISIBLE_ORDER_STATUS (src/lib/guest.ts) — npr. 'v pripravi', 'plačano'.
 * Preslikava v i18n ključe; kot varnostni rezervi sprejmemo tudi surove
 * enum vrednosti (open/in_progress/…), če API kdaj vrne tiste.
 * Nepoznan status → null (stran prikaže surovi niz — nikoli ne strmoglavi).
 */
const GUEST_STATUS_KEY_MAP: Record<string, string> = {
  // strežniški SL nizi (GUEST_VISIBLE_ORDER_STATUS)
  prejeto: 'guest.status.received',
  'v pripravi': 'guest.status.preparing',
  pripravljeno: 'guest.status.ready',
  postreženo: 'guest.status.served',
  plačano: 'guest.status.paid',
  preklicano: 'guest.status.cancelled',
  // surovi enum vrednosti (rezerva, če API vrne namesto njih)
  open: 'guest.status.received',
  in_progress: 'guest.status.preparing',
  ready: 'guest.status.ready',
  served: 'guest.status.served',
  paid: 'guest.status.paid',
  cancelled: 'guest.status.cancelled',
}

export function guestStatusKey(status: string): string | null {
  return GUEST_STATUS_KEY_MAP[(status || '').trim().toLowerCase()] ?? null
}

// ── Javne API napake za gosta ──

/**
 * Javni API-ji (src/app/api/public/**) vračajo napake kot fiksni SL nizi (fail()
 * helper) — gostova stran jih preslika v i18n ključe, da angleški/hrvaški gost
 * vidi napako v svojem jeziku (P1-5). Nepoznan niz → null (stran prikaže surovega
 * — nikoli ne strmoglavi; isti varovalni vzorec kot guestStatusKey()).
 * Upravljanje: nov fail() niz v javni ruti → dodaj preslikavo + ključ v slovarjih;
 * pokritost (vsi nizi iz API-jev imajo ključ) uveljavlja tests/i18n-guest.test.ts.
 */
const GUEST_API_ERROR_KEY_MAP: Record<string, string> = {
  // meni / identiteta
  'QR koda ni veljavna ali je naročanje po QR izklopljeno.': 'guest.error.qrInvalid',
  'QR koda ni veljavna.': 'guest.error.qrInvalid',
  'Neveljaven ali izklopljen QR token.': 'guest.error.qrInvalid',
  'Manjka QR token ali identiteta naprave.': 'guest.menu.unavailable',
  'Kiosk naprava ni registrirana.': 'guest.kiosk.notActivated',
  'Kiosk ni povezan z lokacijo.': 'guest.kiosk.notActivated',
  // oddaja naročila / povratne informacije
  'Naročila ni bilo mogoče varno oddati. Poskusi znova.': 'guest.error.orderNotSubmittedRetry',
  'Manjkajo podatki.': 'guest.error.orderFailed',
  'Manjka idempotency ključ (clientOperationId).': 'guest.error.orderFailed',
  'Manjkata qr in orderNumber.': 'guest.error.orderFailed',
  'Miza s to številko ne obstaja na lokaciji.': 'guest.error.orderFailed',
  'Naročilo s to številko ne obstaja na tej mizi.': 'guest.error.orderFailed',
  'Neveljavno telo zahteve.': 'guest.error.orderFailed',
  'Ocena je obvezna (1–5).': 'guest.error.ratingRequired',
  // omejevanje hitrosti (javne rute)
  'Preveč naročil naenkrat. Počakaj trenutek.': 'guest.error.rateLimited',
  'Preveč poskusov plačila. Počakajte trenutek.': 'guest.error.rateLimited',
  'Preveč zahtev. Počakajte trenutek.': 'guest.error.rateLimited',
  'Preveč zahtevkov.': 'guest.error.rateLimited',
  'Preveč zahtevkov. Poskusi čez minuto.': 'guest.error.rateLimited',
  // javna plačilna povezava (/api/public/pay)
  'Plačilne povezave trenutno niso aktivne — poskusite kmalu znova.': 'pay.errorPayLinkDown',
  'Plačilo še ni potrjeno.': 'pay.pending',
  'Potrditev seje ni na voljo.': 'pay.errorRetry',
  'Povezava je potekla. Prosimo, zaprosite osebje za novo.': 'pay.expiredNote',
  'Povezava je preklicana.': 'pay.revoked',
  'Povezava ne obstaja.': 'pay.notFound',
  'Naročilo je že plačano drugje.': 'pay.superseded',
  'Račun je že plačan.': 'pay.superseded',
  'Računa ni mogoče izračunati.': 'pay.errorRetry',
  'Seja ni bila ustvarjena.': 'pay.errorRetry',
  'Znesek seje se ne ujema s povezavo.': 'pay.errorRetry',
  'Plačilna seja ni veljavna za to povezavo.': 'pay.errorSessionInvalid',
  'Napitnina je izven dovoljenega obsega (0 do zneska računa).': 'pay.tipRange',
  'Napitnina je izven dovoljenega obsega (0 do zneska deleža).': 'pay.tipRange',
  'Račun se je spremenil — prosite osebje za novo povezavo.': 'pay.billChanged',
  'Nič ni več za plačilo prek te povezave.': 'pay.errorRetry',
  // Issue #3 §B (P2): Stripe verify fail-closed 502 — gost vidi pošteno sporočilo
  'Preverjanje plačila trenutno ni dosegljivo. Poskusite znova.': 'pay.errorVerifyUnavailable',
  // P1 #8 (v1.190.0): spletni portal za naročila (/s/<token>, /api/public/web-portal)
  'Spletna povezava ni veljavna ali je portal izklopljen.': 'web.store.linkInvalid',
  'Neznan način prevzema (pickup ali delivery).': 'web.store.orderFailed',
  'Prevzem osebno trenutno ni na voljo.': 'web.store.pickupOff',
  'Dostava trenutno ni na voljo.': 'web.store.deliveryOff',
  'Restavracija je trenutno zaprta — spletna naročila sprejemamo med odprtim.': 'web.store.closedNow',
  'Košarica je pod minimalnim zneskom spletnega naročila.': 'web.store.minOrder',
  'Manjka ime za prevzem.': 'web.store.nameRequired',
  'Manjka telefonska številka.': 'web.store.phoneRequired',
  'Manjka naslov za dostavo.': 'web.store.addressRequired',
  'Manjkajo parametri token, n in k.': 'web.store.trackInvalid',
  'Naročilo s temi podatki ni najdeno.': 'web.store.trackInvalid',
}

/** Znan SL niz iz javnega API-ja → i18n ključ; neznan → null (surovi prikaz). */
export function guestApiErrorKey(message: string): string | null {
  return GUEST_API_ERROR_KEY_MAP[(message || '').trim()] ?? null
}

/**
 * Besedilo napake za gosta (P1-5): znan API SL niz → preveden v trenutni jezik;
 * neznan niz → surovi prikaz (nikoli ne strmoglavi); manjkajoč → fallback ključ.
 */
export function guestApiErrorText(
  t: (key: string) => string,
  message: unknown,
  fallbackKey: string,
): string {
  if (typeof message === 'string' && message.trim() !== '') {
    const key = guestApiErrorKey(message)
    if (key) return t(key)
    return message
  }
  return t(fallbackKey)
}

/**
 * P1 (issue #2 §C, v1.87.1) — REGRESIJA: preklop jezika NI takoj prevedel ŽE
 * PRIKAZANE napake, ker je stran ob napaki shranila ŽE PREVEDENO besedilo v
 * state (prevod zamrznjen v jeziku ob trenutku napake).
 *
 * Rešitev: state hrani SUROVI strežniški niz (SL vir) + fallback ključ;
 * besedilo se IZRAČUNA ob vsakem izrisu (guestApiErrorText s trenutnim t) —
 * preklop SL↔HR↔EN sproži re-render → isti surovi niz se TAKOJ prevede.
 * Uporaba: const err = useGuestApiError(); err.set(data?.error, 'pay.errorRetry');
 * err.setKey('guest.error.unreachableRetry'); {err.text}.
 */
export interface GuestApiErrorState {
  /** surov SL niz javnega API-ja ('' → uporabi fallbackKey) */
  raw: string
  /** i18n ključ za neznan/prazen niz */
  fallbackKey: string
}

export function useGuestApiError(): {
  error: GuestApiErrorState | null
  /** izračunano ob izrisu — preklop jezika takoj spremeni prikazano besedilo */
  text: string
  set: (message: unknown, fallbackKey: string) => void
  setKey: (fallbackKey: string) => void
  clear: () => void
} {
  const { t } = useGuestT()
  const [error, setError] = useState<GuestApiErrorState | null>(null)
  const set = useCallback((message: unknown, fallbackKey: string) => {
    setError({ raw: typeof message === 'string' ? message : '', fallbackKey })
  }, [])
  const setKey = useCallback((fallbackKey: string) => {
    setError({ raw: '', fallbackKey })
  }, [])
  const clear = useCallback(() => setError(null), [])
  const text = error ? guestApiErrorText(t, error.raw, error.fallbackKey) : ''
  return { error, text, set, setKey, clear }
}

export type { GuestI18nValue }
