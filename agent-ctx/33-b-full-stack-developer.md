# Task 33-b — i18n gostov (SL/HR) na kiosk + QR meni straneh

Agent: full-stack-developer
Datum: 2026-10-11 (seja)
Status: ZAKLJUČENO

## Nalogа

Audit §65/§193: gostujoči strani (`/kiosk` in `/m/<token>`) sta bili hardkodirano slovenščini. Cilj: dvojezičnost SL/HR z izbiro jezika, brez odvisnosti od dashboard auth, s povezavo na obstoječo centralno i18n infrastrukturo.

## Urejene datoteke (ownership spoštovan)

| Datoteka | Sprememba |
|---|---|
| `src/components/guest-i18n.tsx` | NOVA — lahkoten 'use client' provider za goste |
| `src/app/kiosk/page.tsx` | vsi UI nizi → `t()`, toggle v glavi + na aktivaciji |
| `src/app/m/[token]/page.tsx` | vsi UI nizi → `t()`, toggle v sticky glavi, prevod statusov |
| `src/lib/i18n/sl.ts` | PRIPETO sekcijo `// ==== 33-b: gostujoče strani ====` (75 novih ključev, obstoječi ključi nedotaknjeni) |
| `src/lib/i18n/hr.ts` | paritetna sekcija (75 ključev, HR prevodi) |
| `tests/i18n-guest.test.ts` | NOVA — 14 testov |

## Arhitektura guest i18n (src/components/guest-i18n.tsx)

- **Mikro-store + `useSyncExternalStore`** (isti vzorec kot `src/components/i18n.tsx`, a samostojen modul — ni uvoza iz dashboard komponent, nič skupnega stanja, ni tveganja konfliktov z vzporednimi agenti): SSR snapshot `'sl'`, po hidraciji shranjena vrednost → brez hidracijskega razpada.
- **Isti localStorage ključ** `LOCALE_STORAGE_KEY = 'restaurantos.locale'` (uvožen iz `src/lib/i18n/index.ts`, ki NI bil spremenjen) → jezik je povezan z glavno aplikacijo; prvi obisk: `normalizeLocale(navigator.language)` (hrvaški brskalnik → HR).
- **Izvozi**: `GuestI18nProvider` (context), `useGuestT()` (deluje tudi brez providerja — fallback na store), `GuestLanguageToggle`, `guestStatusKey()`, `setGuestLocale()`.
- **`t()` diagnostika**: manjkajoč ključ v HR → SL vrednost (core `t()`); manjka povsod → ključ + `console.warn` samo v dev (`NODE_ENV !== 'production'`).
- **`GuestLanguageToggle`**: pill "SL | HR", `variant="dark"` (kiosk) / `"light"` (QR); `role="group"` + `aria-pressed` + `aria-label`; vsak gumb `h-[44px] min-w-[44px]` (≥44 px dotik); pravi `<button>` (tipkovnica dostopno). Postavitev: kiosk — v glavi poleg zaklepa, na aktivacijskem zaslonu fiksiran top-right; QR — v sticky glavi (desno), na error zaslonu fiksiran top-right.
- **`guestStatusKey()`**: javni API `/api/public/orders/status` vrača status kot fiksne SL nize (`GUEST_VISIBLE_ORDER_STATUS` v `src/lib/guest.ts` — ta datoteka NI bila moja, nisem je spreminjal). Preslikava `prejeto/v pripravi/pripravljeno/postreženo/plačano/preklicano` → `guest.status.*` + rezerva za surove enum vrednosti (open/in_progress/…). Nepoznan status → `null` (UI prikaže surovi niz, ne strmoglavi).

## Ključne odločitve

1. **Samostojen provider namesto reuse `src/components/i18n.tsx`**: obstoječi je sicer auth-free, a ni bil v mojem ownership-u; vzporedni agenti lahko urejajo dashboard i18n. Lasten mikro-store z istim localStorage ključem = ni skupnega stanja, ni konfliktov.
2. **Statusi naročil prevajani client-side** (preslikava nizov), ker je strežniška preslikava v `src/lib/guest.ts` izven ownership-a in bi zahtevala spremembo javnega API-ja (tveganje za vzporedne agente).
3. **Imena artikelov/kategorij/meni Restavracije NISO prevajana** (DB-driven, po navodilih); tudi strežniška sporočila napak (`data.error`) ostanejo, kot jih vrne API.
4. **QR glava**: toggle v sticky glavi (namesto fiksno čez vsebino) da ni prekrivanja z offline badge-om; `sticky top-[57px]` → `top-[70px]` (višja glava zaradi 44 px toggleja). Restavracija `truncate`, da dolgo ime ne polomi razporeditve.
5. **Kiosk**: preimnovan lokale `t` (token) → `val`/`tok` v `activate()`/`loadMenu()` (senca bi prevzrla prevajalno funkcijo → runtime crash). Na QR strani `tRef` (latest-t ref), da `loadMenu` (useCallback [token]) se NE znova sproži ob preklopu jezika — preklop brez reload-a podatkov.
6. **Enotna kopija**: '— plačilo na blagajni' (QR) in '· plačilo na blagajni' (kiosk) združeni v en ključ `guest.common.payAtCashier` = '· plačilo na blagajni'.

## Novi ključi (75, sekcija `// ==== 33-b ====` v OBEH slovarjih)

- `guest.lang.*` (3): aria/sl/hr
- `guest.common.*` (17): thanks, amount, payAtCashier, unavailable, unavailableNow, optional, note, noteKitchen, add, retry, close, sending, submitting, offline, total, vat, nameOptional, noSurcharge, status
- `guest.error.*` (6): unreachable, unreachableRetry, orderFailed, orderNotSubmitted, orderNotSubmittedRetry, feedbackNotSubmitted
- `guest.status.*` (6): received, preparing, ready, served, paid, cancelled
- `guest.kiosk.*` (14): title, instructions, tokenPlaceholder, activate, notActivated, activationFailed, tokenHint, subtitle, lockTitle, yourNumber, autoReset, cartEmpty, notePlaceholder, submit
- `guest.menu.*` (10): loading, unavailable, tableSelfOrder, selfOrder, allergens, emptyCategory, vatNote, notePlaceholder, orderDone, newOrder
- `guest.cart.*` (7): button, title, itemOne, itemMany, nameHint, submit, vatExcl
- `guest.feedback.*` (11): cta, title, overall, food, service, atmosphere, starAria, commentPlaceholder, thanks, submit, failed

## Testi (tests/i18n-guest.test.ts — 14, vse zeleno)

- pariteta: identičen set `guest.*` ključev v SL in HR (>60); brez praznih vrednosti
- HR ≠ SL za vse ključe RAZEN dokumentiranega `SHARED_EQUAL` (skupni izrazi: 'Hvala!', 'Dodaj', 'Status', 'Aktiviraj kiosk', 'Alergeni: {allergens}', 'Košarica', 'Tvoja košarica', 'Hrana', '{label}: {n} od 5' — hrvaščina ima iste besede)
- HR ne vsebuje slovensko-specifičnih vrednosti ('V pripravi', 'Skupaj', 'DDV', 'Miza', …)
- `t()` interpolacija SL + HR (miza/stol, orderDone, starAria)
- `guestStatusKey()`: 6 SL nizov + 6 enum rezerv + toleranca velikosti črk/presledkov + nepoznan → null + ključi obstojijo v obeh slovarjih
- regresija hardcodiranih besedil: 17 nizov (kiosk) + 27 nizov (QR) NE sme biti več v source-u; obe strani vsebujeta Provider/useGuestT/Toggle; toggle a11y (aria-pressed, role=group, min-w-[44px]) in `LOCALE_STORAGE_KEY` (skupna shramba)

## Verifikacija

- `bunx tsc --noEmit` → **EXIT 0** (opomba: med sejo je bil `src/app/api/furs/route.ts` ~4 min sintaktično pokvarjen od vzporednega agenta — 13 napak izključno tam + 1 v `.next/dev/types/validator.ts` (posledica istega); mojih datotek ni bilo med napakami; na koncu drevo čisto)
- `bun run lint` → **EXIT 0** (med sejo 1 parsing error v tujem furs route, po popravku vzporednega agenta čisto)
- `bun test tests/i18n-guest.test.ts` → **14/14 pass** (377 expect)
- `bun test tests/i18n.test.ts` (globalna pariteta) → **17/17 pass** — dodani ključi ne prelamejo obstoječe uveljavitve
- izoliran transpile: `bun build` kiosk + QR strani → OK (ker je med sejo bil celoten dev compile down zaraj tujega furs)
- Dev strežnik: bil je down v času zaključka (sistemski restart; NISEM ga poganjal sam — po navodilih). Zadnji logi (pred downom) so pokazovali 500 za VSE rute zgolj zaraj tujega pokvarjenega furs route-a; moji file-i so bili brez napak. Celoten `bun test` NISEM poganjal (deljena baza — po navodilih).

## PASTI ZA NASLEDNJE

1. **`src/lib/guest.ts` GUEST_VISIBLE_ORDER_STATUS vrača SL nize** — če se bo to spremenilo v i18n/enum (priporočljivo: API naj vrača enum, ne SL besedila), potem odstrani SL-polovico preslikave v `GUEST_STATUS_KEY_MAP` (enum rezerva že deluje).
2. **Sporočila napak javnih API-jev** (`/api/public/menu`, `/api/public/orders`, …) so še hardkodirana SL na strežniku — gost v HR vidi strežniška sporočila SL (fallback `data.error`). Popolna HR-pariteta zahteva i18n na javnih API rutah (izven 33-b ownership-a).
3. **`useGuestT()` brez providerja** deluje (fallback na store) — a strani naj ostanejo zavite v `GuestI18nProvider` (konvencija).
4. Novi ključi MORAJO ostati v sekciji z oznako `// ==== 33-b ====` — testi iščejo po `guest.` prefiksu, a paritetni test celotnega slovarja (`tests/i18n.test.ts`) uveljavlja globalno SL/HR simetrijo.
