# Design spec: vizualna prenova „temna lupina" — v1.166.0

Datum: 2026-10-21 · Stanje: odobren s strani lastnika (smer Toast-slog, pristop 2) ·
Obseg: ena izdaja v1.166.0 · Status: čaka na izvedbeni načrt (writing-plans)

## 1. Kontekst in cilj

RestaurantOS je funkcionalno na ravni ali nad najboljšimi restavracijskimi POS
sistemi (Toast, Square, Lightspeed), vendar vizualno zaostaja: uporablja
tovarniško shadcn paleto (skoraj črna primarna, siva nevtralna skala, `stone`
razredi po app kodi) in nima prepoznavne identitete. V manifestu že obstaja
nakazana znamka (`themeColor: #047857`, emerald), ki pa ni nikoli prišla v
vmesnik.

**Cilj:** dvigniti vizualno raven na raven ali nad Toast/Square/Lightspeed s
smerjo **„temna lupina"** — temen okvir (stranska vrstica + glava) okoli svetle
delovne površine, poudarki v emerald barvi znamke, v obeh načinih (svetli/temni).

## 2. Obseg

### V obsegu

1. Barvni sistem in tokeni v `src/app/globals.css`.
2. Poliranje komponentne knjižnice `src/components/ui/` (48 komponent).
3. Lupina: sidebar + glava + mobilna navigacija (`src/components/dashboard-nav.tsx`,
   glava v `src/app/dashboard/page.tsx`, glave KDS/handheld/tablica/kiosk).
4. Poliranje hero zaslonov: POS mize, KDS board, handheld kartice, pregledna plošča.
5. Stražni test tokenov (mutacijsko dokazan).
6. Izdajni ritual v1.166.0 v celoti.

### Izven obsega (zavestno NE)

- Prestrukturiranje postavitev 27 zavihkov (samo vizualna plast).
- Novi logotipi ali asseti; če lastnik priskrbi svoj asset, gre vmes tak kot je.
- PWA namestitev / HTTPS (obseg R2).
- Native aplikacije, certificirana strojna oprema.
- Predelava vseh zaslonov — samo hero zasloni.
- Migracije podatkovne sheme (noben DDL), nobene API spremembe.

## 3. Design odločitve (odobrene 2026-10-21)

### 3.1 Barvni sistem in tokeni (`src/app/globals.css`)

- **Blagovna barva — emerald.** `--primary` preide iz skoraj-črne
  `oklch(0.205 0 0)` v emerald `oklch(0.596 0.145 163.225)` (≈ Tailwind
  emerald-600 `#059669`; usklajeno z obstoječim `themeColor #047857`).
  `--primary-foreground` ostane bel. Emerald vodi gumbe, aktivna stanja,
  fokusne obroče in grafno paleto.
- **Semantična plast lupine `--shell-*`:** `--shell` (ozadje lupine, oglje
  `oklch(0.205 0.015 250)`), `--shell-foreground` (skoraj bela
  `oklch(0.97 0.005 250)`), `--shell-muted` (zamolklo `oklch(0.62 0.015 250)`),
  `--shell-border` (bel z nizko alfo), `--shell-active` (emerald-tonirana
  podlaga aktivne postavke). **Lupina je temna v obeh načinih** — to je
  enoznačna odločitev: svetli/temni način spreminja samo delovno površino
  (vsebino), okvir ostane oglje.
- **Nevtralna skala** dobi hladen odtenek (hue ≈ 250) za globino: svetla
  površina skoraj bela, kartice z rahlim robom (`oklch(0.92 0.004 250)`) in
  mehko senco; temni način ohrani `.dark` blok z enakim hladnim odtenkom.
- **Statusne barve** (success/amber/destructive) ostanejo po pomenu,
  uskladijo se z znamko; `--chart-1..5` dobi emerald osnovo.
- **`--radius: 10px` (issue #74) in `.dark` varianta ostaneta nedotaknjena.**
  Številke za POS (zneski, količine) dobijo `tabular-nums` tam, kjer so zdaj
  proporcionalne.

Kaskada: Tailwind 4 `@theme` preslikava (`--color-*: var(--*)`) ostane —
spremenijo se samo vrednosti v `:root`/`.dark` in dodajo `--shell-*`, zato
vse obstoječe uporabe razredov (npr. `bg-primary`, `border-border`) delujejo
brez spremembe kode.

### 3.2 Komponentna knjižnica (`src/components/ui/`)

Pravilo: **samo tokeni in razredi, API komponent se ne sme spremeniti.**

- `button.tsx`: primarni = emerald z belim tekstom; sekundarni/outline/ghost
  usklajeni; focus-visible obroč emerald.
- `badge.tsx`: mehke obarvane podlage (emerald/amber/rdeča/modra) za statusne
  različice; nevtralna ostane.
- `card.tsx`: subtilen rob + mehkejša senca; `tabs.tsx`: aktivna kartica z
  emerald poudarkom; `table.tsx`: glava z rahlo podlago, hover vrstice.
- `dialog.tsx`, `sheet.tsx`, `select.tsx`, `input.tsx`, `textarea.tsx`:
  enotna senca in emerald fokusni obroč; brez sprememb velikosti in vedenja.
- Ostale komponente (menu, popover, dropdown …): prevzamejo novo paleto
  samodejno prek tokenov; ročni popravki le, če tokeni ne zadoščajo.

### 3.3 Lupina

- `dashboard-nav.tsx` — `DashboardSidebar`: oglje ozadje (`--shell`), besedilo
  `--shell-foreground`, neaktivne postavke `--shell-muted`, aktivna postavka =
  emerald oznaka (levi rob + `--shell-active` podlaga), hover stanja, na vrhu
  znak „RestaurantOS" z emerald oznako, na dnu verzija. `MobileBottomNav` in
  `MobileNavDrawer`: ista lupina, emerald aktivna postavka.
- Glava v `src/app/dashboard/page.tsx` (danes `bg-white border-b
  border-stone-200 shadow-sm`): preide na `--shell` v obeh načinih;
  `ThemeToggle` ostane v glavi in preklaplja vsebinski način.
- Glave KDS, handheld in tablice: enako temna (oglje) glava, da je znamka
  prepoznavna povsod. KDS in kiosk sta že temna zaslona (`bg-stone-900`) —
  uskladita se z novo paleto, lupine ne dobita.
- Preostale `stone`/`bg-white` uporabe v app kodi (body v `layout.tsx`,
  quickjump navigacije ipd.) preidejo na semantične tokene; brez strukturnih
  sprememb, brez overlay panelov (navigacija ostane top-bar + zamenjava pogleda).

### 3.4 Hero zasloni (poliranje, ne predelava)

- **POS mize** (`ops-cards`): kartice miz z barvnim statusnim robom
  (zasedena/rezervirana/prosta), večje dotične površine, zneski `tabular-nums`.
- **KDS board**: kartice naročil z emerald statusno črto, usklajene z novo
  paleto (zaslon je že temen — prebarvamo, ne prestavimo).
- **Handheld kartice** (`kds-tap-card`): jasnejša hierarhija statusov, večji
  gumbi.
- **Pregledna plošča**: KPI kartice z emerald poudarki, grafi na `--chart-*`
  paleti.
- Postavitve in podatkovni tokovi ostanejo nespremenjeni.

### 3.5 Dostopnost

- Kontrast AA (WCAG 1.4.3) za besedilo lupine in vsebine v obeh načinih.
- Fokusni obroči vidni in enotni (WCAG 2.4.7); pinč-povečava ostane dovoljena
  (naloga #11 — `maximumScale` se ne uvaja nazaj).
- `aria` oznake in struktura se ne spreminjajo (issue #75 pin-i ostanejo).

## 4. Merila sprejema (A1–A7)

- **A1 — Testi:** celoten suite (trenutno 3078 testov / 158 datotek) zelen po
  prenovi; nič obstoječega ne sme pasti zaradi vizualnih sprememb.
- **A2 — Stražni test tokenov (nov, mutacijsko dokazan):** test prebere
  `src/app/globals.css` in zahteva (a) emerald `--primary` (oklch z odtenkom
  ≈163 in kromatiko ≥ 0.1), (b) prisotnost `--shell-*` tokenov, (c) obstoj
  `.dark` bloka. Test mora biti viden, da PADE ob vrnitvi na sivo paleto
  (mutacija: `--primary` nazaj na `oklch(0.205 0 0)`).
- **A3 — Nedotaknjeno:** pin `--radius: 10px` (issue #74), testi issue #75 in
  CSS-strukturni testi (issue #69 §D: quickjump + `.dark` selektorji,
  reduced-motion; v1.131.0 F: `:not([class*="border-"])` varovalka) ostanejo
  zeleni brez popravkov — preverjeno 2026-10-21: noben obstoječi test ne
  pin-a vrednosti barvne palete, vsi berejo le selektorje/strukturo.
- **A4 — Lupina:** temen okvir v svetlem IN temnem načinu; `ThemeToggle`
  preklaplja vsebinski način; noben zaslon ne izgubi navigacije.
- **A5 — Kontrast/fokus:** ročni pregled AA kontrasta lupine + vsebin;
  fokusni obroči vidni na tipkovnici.
- **A6 — Vizualni pregled lokalno:** screenshots (dashboard/POS/KDS/handheld;
  svetli + temni) pregledani na lokalnem zagonu PRED objavo; primerjava z
  referenčnimi POS vzorci (Toast/Square/Lightspeed). Lastnik dobi žive URL-je
  v pregled.
- **A7 — Ritual izdaje:** typecheck 0 · eslint 0 · `git diff --check` 0 ·
  secrets-scan 0 · schema-drift 0 · 6 pinov na `1.166.0` · worklog vnos ·
  FIX/TEST/DOCS commiti · push GitHub + GitLab mirror (ali evidentirana
  blokada) · Vercel deploy preverjen (`/api/health` = verzija + commit) ·
  `bun scripts/sync-check.ts` SYNCED · CI zelen · zaključni DOCS commit.

## 5. Testiranje

- Stražni test (A2) po TDD: RED pred implementacijo tokenov, nato mutacijski
  dokaz (mutacija sive palete → test pade → revert mutacije → zelen).
- Celoten suite kot regresijska varovalka po vsakem sklopu sprememb.
- Ročni/vizualni pregled na lokalnem zagonu (A6) pred objavo.

## 6. Tveganja in omilitve

| Tveganje | Omilitev |
|---|---|
| Širok doseg (48 ui komponent, vsi zasloni) | Spremembe le tokeni/razredi; API nespremenjen; suite kot varovalka po vsakem sklopu |
| Raztreseni `stone`/`bg-white` razredi v app kodi | Sistematičen prehod na semantične tokene; preostali trdi razredi so sprejemljivi, če ne kvarijo kontrasta |
| Dark-mode regresije (next-themes) | `.dark` blok se ohranja; ročni preklop + screenshoti obeh načinov |
| KDS/handheld/kiosk so tematsko samosvoji | Uskladitev z novo paleto brez prestavljanja postavitev |
| Vercel build / CI | Vizualne spremembe ne dotikajo build pipeline; CI gate preveri |

## 7. Zgodovina odločitev

- 2026-10-21 — lastnik izbral smer **Toast-slog: temna lupina** (iz ponujenih
  štirih) in potrdil **pristop 2** (oblikovni sistem + lupina + hero zasloni)
  ter celoten design po sekcijah 1–6.
