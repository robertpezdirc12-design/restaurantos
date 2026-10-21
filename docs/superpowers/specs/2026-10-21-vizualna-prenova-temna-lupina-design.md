# Design spec: vizualna prenova „temna lupina" — v1.166.0

Datum: 2026-10-21 · Stanje: odobren s strani lastnika (smer Toast-slog, pristop 2) ·
Obseg: ena izdaja v1.166.0 · Status: čaka na izvedbeni načrt (writing-plans)

## 1. Kontekst in cilj

RestaurantOS je funkcionalno na ravni ali nad najboljšimi restavracijskimi POS
sistemi (Toast, Square, Lightspeed), vizualno pa zaostaja v **doslednosti**, ne
v odsotnosti znamke. Presentacijski sloj „RestaurantOS visual polish — 2026-10"
(`src/app/globals.css` od vrstice 193) že pokriva nekaj: nevtralne površine so
žemljene na emerald hue 155 (`--background`, `--border`), fokusni obroč,
`::selection` in glava handheld zaslona so emerald, aktivna navigacijska postavka
je `border-emerald-700 bg-emerald-50`. Kar manjka, je tri:
(1) **primarna barva ni znamka** — `--primary` je tovarniško skoraj črna
`oklch(0.205 0 0)` v svetlem in skoraj bela `oklch(0.922 0 0)` v temnem načinu,
zato vsi primarni gumbi (`button.tsx` → `bg-primary text-primary-foreground`)
izgledajo nevtralno in ne prepoznavno;
(2) **lupina je svetla** — sidebar (`bg-white`), glava (`bg-white border-b
border-stone-200`) in mobilna vrstica so beli, torej se ne razlikujejo od
delovne površine;
(3) **paleta ni enotna** — `.dark` ima vijoličen `--sidebar-primary:
oklch(0.488 0.243 264.376)`, `--chart-1..5` so tovarniški.

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
  `--primary-foreground` ostane bel. V temnem načinu `--primary` NE sme ostati
  skoraj bel `oklch(0.922 0 0)` (tovarniška inverzija) — enak emerald,
  nekoliko poglobljen, da `text-primary` na temni podlagi ostane AA.
  Emerald vodi gumbe, aktivna stanja, fokusne obroče in grafno paleto.
- **Lupina uporabi ŽE OBSTOJEČO družino `--sidebar-*`** (`globals.css`
  vrstice 76–83 v `:root` in 110–117 v `.dark`; `@theme inline` jih že
  preslikava v `--color-sidebar*`, vrstice 11–18, zato razredi `bg-sidebar`,
  `text-sidebar-foreground`, `border-sidebar-border`, `bg-sidebar-accent`
  delujejo brez nove kaskade). Novih `--shell-*` tokenov NE uvajamo —
  drugačen vir resnice bi podvojil obstoječega. Vrednosti:
  `--sidebar` = oglje `oklch(0.24 0.012 240)` v **obeh** načinih,
  `--sidebar-foreground` = `oklch(0.96 0.004 240)`, `--sidebar-accent` =
  emerald-tonirano oglje `oklch(0.32 0.03 165)`, `--sidebar-accent-foreground`
  = skoraj bela, `--sidebar-border` = `oklch(1 0 0 / 12%)`, `--sidebar-ring` =
  emerald, `--sidebar-primary` = emerald (odpravi tovarniški vijolično
  `oklch(0.488 0.243 264.376)`), `--sidebar-primary-foreground` = bela.
  Zamolklo besedilo lupine uporabi `text-sidebar-foreground/65` — brez
  dodatnega tokena. **Lupina je temna v obeh načinih** — enoznačna odločitev:
  preklapljalec spremeni samo delovno površino, okvir ostane oglje.
  Edini potrošnik `--sidebar-*` danes je `src/components/ui/sidebar.tsx`
  (shadcn primitiv, ki ga app koda NE uvaža — preverjeno z grepom); preusmeritev
  je varna in nima stranskih učinkov.
- **Nevtralna skala** obstoječega presentacijskega sloja (hue 155) ostane —
  ni je treba hladiti, ker je že usklajena z emerald znamko; kartice ohranijo
  obstoječo mehko senco in `:not([class*="border-"])` varovalko (v1.131.0 F).
- **Statusne barve** (success/amber/destructive) ostanejo po pomenu;
  `--chart-1..5` dobi emerald osnovo (trenutno tovarniška mešanica rdeče/modre).
- **`--radius: 10px` (issue #74) in struktura `.dark` bloka ostaneta
  nedotaknjena.** Številke za POS že danes uporabljajo `tabular-nums` —
  `html { font-variant-numeric: tabular-nums }` je globalen (issue #74 V-2,
  `globals.css:215`), zato tu NI dela; naloga je samo, da se ta deklaracija pri
  prenovi ne izgubi (pinned v stražnem testu).

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

- `dashboard-nav.tsx` — `DashboardSidebar` (vrstica 188 danes
  `border-r border-stone-200 bg-white`): `bg-sidebar text-sidebar-foreground
  border-sidebar-border`; neaktivna postavka `text-sidebar-foreground/70` +
  `hover:bg-sidebar-accent`; aktivna postavka = emerald levi rob +
  `bg-sidebar-accent`; iskalnik in group labela prevzameta lupino.
  `MobileBottomNav` (vrstica 212 `bg-white border-t border-stone-200`) in
  `MobileNavDrawer`: ista lupina, emerald aktivna postavka.
- Glava v `src/app/dashboard/page.tsx` (vrstica 2204 danes `bg-white border-b
  border-stone-200 shadow-sm`): `bg-sidebar text-sidebar-foreground
  border-b border-sidebar-border`; `ThemeToggle` ostane v glavi in preklaplja
  vsebinski način.
- **Mehanizem za notranje kontrole glave** (Select sprožilec, inputi, ghost
  gumbi, popover, pastelni statusni čipi): lupinske regije lokalno
  **redeclarirajo tokenne spremenljivke** (`--background`, `--card`, `--popover`,
  `--border`, `--input`, `--foreground`, `--muted`, `--muted-foreground`,
  `--secondary`, `--accent`, `--accent-foreground`, `color-scheme: dark`).
  To deluje, ker `@theme inline` (vrstice 5–46) utility veže na `var(--…)` —
  vrednost se reši na elementu, podedovanem iz regije. Zato ni neede prepisovati
  razredov vnotraj glave. Samo trdo kodirane `stone`/pastelne utility, ki
  obstajajo v glavi/stranski vrstici, se preslikajo z nekaj eksplicitnimi
  pravili v regijskem bloku (isti idiom kot `.dark .bg-white` blok,
  vrstice 141–190).
- Glave KDS, handheld in tablice: uskladijo se z temperirano paleto (brez
  preimenovanja regij). KDS in kiosk sta že temna zaslona (`bg-stone-900`) —
  uskladita se z novo paleto, lupine ne dobita.
- Preostale `stone`/`bg-white` uporabe V VSEBINI ostanejo (`.dark` remap blok
  jih že pokriva v temnem načinu; presentacijski sloj hue 155 jih usklajuje v
  svetlem). Prenova jih NE preimenuje — s tem pade tveganje za source-pin teste
  (`issue69-visual-density.test.ts:199`, `v141-toast-benchmark.test.ts:90`).
  Strukturnih sprememb ni, overlay panelov ni (navigacija ostane top-bar +
  zamenjava pogleda).

### 3.4 Hero zasloni (poliranje, ne predelava)

Sidra so **obstoječi** `data-*` atributi in obstoječe preslikave; nič se ne
izumlja (prej napačno napisana `ops-cards` / `kds-tap-card` sidra v specu ne
obstojajo):

- **POS mize** (`dashboard/page.tsx:2476` in `:2517`, barva gre iz
  `statusColors` na `page.tsx:166`): `statusColors` je **namerno temnjen**
  seznam (naloga #11 — WCAG 1.4.3, na sončni tablici) in ga prenova
  **NE spreminja**. Poliranje = enoten rob/senca/fokus in subtilen `ring` na
  aktivni ploščici, izvedeno v `globals.css` na obstoječih selectorjih.
- **KDS board** (`data-component="kds-station-card"`, `kds-station-board.tsx`
  + `globals.css:526+`): kartice obstajajo, glava listka je namensko nevtralna
  (issue #69 §: rdeča SAMO za zamudo) — statusnih barv ne spreminjamo;
  uskladi se podlaga/rob s paleto.
- **Handheld** (`data-screen="handheld-pos"`, `globals.css:497`): glava je že
  emerald gradient — ostane, uskladi se temni način.
- **Pregledna plošča**: KPI kartice prevzamejo novo paleto prek
  `--chart-1..5` in `bg-card`; postavitve se ne dotikajo.
- Zneski že danes uporabljajo `tabular-nums` (globalno, issue #74 V-2 +
  npr. `page.tsx:2483`) — nic za delati.
- Postavitve in podatkovni tokovi ostanejo nespremenjeni; noben niz razredov,
  ki ga pin-a source-pin test (`issue69-visual-density.test.ts`,
  `v141-toast-benchmark.test.ts`, `issue74-visual.test.ts`), se ne sme
  preimenovati.

### 3.5 Dostopnost

- Kontrast AA (WCAG 1.4.3) za besedilo lupine in vsebine v obeh načinih.
- Fokusni obroči vidni in enotni (WCAG 2.4.7); pinč-povečava ostane dovoljena
  (naloga #11 — `maximumScale` se ne uvaja nazaj).
- `aria` oznake in struktura se ne spreminjajo (issue #75 pin-i ostanejo).

## 4. Merila sprejema (A1–A7)

- **A1 — Testi:** celoten suite (trenutno 3078 testov / 158 datotek) zelen po
  prenovi; nič obstoječega ne sme pasti zaradi vizualnih sprememb.
- **A2 — Stražni test tokenov in lupine (nov, mutacijsko dokazan):** test bere
  `src/app/globals.css` in `src/components/dashboard-nav.tsx` in zahteva
  (a) `--primary` je emerald (oklch s kromatiko ≥ 0.1 in odtenkom ≈ 163) v
  `:root` IN v `.dark` (brez tovarniške inverzije),
  (b) `--sidebar` je oglje (L ≤ 0.30) v **obeh** blokih,
  (c) vijolični `--sidebar-primary: oklch(0.488 0.243 264.376)` je odstranjen,
  (d) `--chart-1` je emerald,
  (e) globalni `font-variant-numeric: tabular-nums` je še vedno prisoten,
  (f) `--radius: 10px` je še vedno prisoten,
  (g) `DashboardSidebar`/`MobileBottomNav` use `bg-sidebar`,
  (h) regijski bloki za lupino obstajajo. Test mora biti viden, da PADE za
  vsako od mutacij a–h (siva paleta nazaj, svetel sidebar, vijolična
  `--sidebar-primary`, izbrisan `tabular-nums`, izbris `--radius`).
- **A3 — Nedotaknjeno:** pin `--radius: 10px` (issue #74), testi issue #75 in
  CSS-strukturni testi (issue #69 §D: quickjump + `.dark` selektorji,
  reduced-motion; v1.131.0 F: `:not([class*="border-"])` varovalka) ostanejo
  zeleni brez popravkov — preverjeno 2026-10-21: noben obstoječi test ne
  pin-a vrednosti barvne palete, vsi berejo le selektorje/strukturo.
  **Konkretni nizi, ki smejo ostati črkovani enako** (source-pin teste najdemo
  z grepom): `'bg-white dark:bg-stone-800'` in `'dark:bg-stone-950/95'`
  (v141 §D), `'bg-white p-3 md:p-2.5 flex items-center justify-between gap-2'`
  (issue69:199), `'sticky top-14 z-20 rounded-xl border border-stone-200 p-1.5
  shadow-sm'` (issue69:178), `border-stone-200 border-l-*` (issue74:102),
  `data-region="dashboard-sidebar"` (issue73:145), `statusColors` (naloga #11 —
  WCAG-temnjena familija). Posledično se lupina gradi na **novih** selectorjih
  in tokenih, ne na preimenovanju obstoječih razredov.
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
| Raztreseni `stone`/`bg-white` razredi v app kodi | Lupina se zgradi na **regijskih** blokih (`[data-region="dashboard-header"]` …) in lokalni redeclaraciji tokenov, ne na prepisovanju razredov po komponentah — tako ostanejo source-pin testi (issue69 / v141 / issue74) zeleni; preostali trdi razredi so sprejemljivi, če ne kvarijo kontrasta |
| `bg-white` v glavi/stranski vrstici je videti bel na črni lupini | Regijski blok eksplicitno preslika `bg-white`/`text-stone-*`/pastelne čipe znotraj lupine (isti idiom kot `.dark` blok, `globals.css:141–190`); v stražnem testu pin-an |
| Širitev obsega („še en zaslon\") | Hero zasloni so zaprto ime-novan seznam (3.4); karkoli drugega gre v naslednjo izdajo |
| Dark-mode regresije (next-themes) | `.dark` blok se ohranja; ročni preklop + screenshoti obeh načinov |
| KDS/handheld/kiosk so tematsko samosvoji | Uskladitev z novo paleto brez prestavljanja postavitev |
| Vercel build / CI | Vizualne spremembe ne dotikajo build pipeline; CI gate preveri |

## 7. Zgodovina odločitev

- 2026-10-21 — lastnik izbral smer **Toast-slog: temna lupina** (iz ponujenih
  štirih) in potrdil **pristop 2** (oblikovni sistem + lupina + hero zasloni)
  ter celoten design po sekcijah 1–6.
- 2026-10-21 — **samopregled spec-a ob branju `globals.css` v celoti**: tri
  trditve so bile napačne in so popravljene. (1) „tovarniška shadcn paleta brez
  identitete" — ne drži, presentacijski sloj `RestaurantOS visual polish` že
  obstaja (`globals.css:193+`, emerald hue 155, emerald ring/selection/fokus,
  emerald handheld glava); pravi mankajoči kos je `--primary` (skoraj črna /
  skoraj bela) in svetla lupina. (2) „`--shell-*` tokeni" — izumljeni; že
  obstaja družina `--sidebar-*`, ki je preslikana v `@theme inline`, zato jo
  prenova uporabi namesto novih tokenov. (3) „zneski potrebujejo
  `tabular-nums`" — že globalno (`globals.css:215`, issue #74 V-2).
  Učinek: obseg se je realno zmanjšal (manj kode, manj tveganja za source-pin
  teste), merilo A2 pa je postalo mutacijsko dokazljivo na konkretnih vrednostih.
- 2026-10-21 — sidri hero zaslonov popravljena na dejanska (`statusColors`
  `page.tsx:166`, `data-component="kds-station-card"`,
  `data-screen="handheld-pos"`); `ops-cards`/`kds-tap-card` v kodi ne obstajata.
