# Vizualna prenova „temna lupina" (v1.166.0) — izvedbeni načrt

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RestaurantOS dobí blagovno emerald paleto in temno ogljeno lupino (glava + stranski steber + mobilna spodnja vrstica) okoli svetle delovne površine, v svetlem IN temnem načinu, brez spremembe vedenja.

**Architecture:** Vse spremembe so na plasti **ŽETONOV** (`src/app/globals.css`) in **RAZREDOV** (`dashboard-nav.tsx`, glava v `dashboard/page.tsx`). Tailwind 4 `@theme inline` (globals.css:6–47) veže utilite na `var(--…)`, zato lokalna redeklaracija žetona na regiji obarva celotno poddrevje, ne da bi kadarkoli preimenovali razred. API komponent v `src/components/ui/` se ne sme spremeniti.

**Tech Stack:** Next.js 16 App Router · React 19 · Tailwind CSS 4 (oklch žetoni) · shadcn/ui (New York) · next-themes (`attribute="class"`) · Bun (`bun test`) · TypeScript 5.

**Spec:** [ros/docs/superpowers/specs/2026-10-21-vizualna-prenova-temna-lupina-design.md](file:///c:/Users/admin/Documents/Qoder/2026-10-19/94af14eb/ros/docs/superpowers/specs/2026-10-21-vizualna-prenova-temna-lupina-design.md)

## Global Constraints

- Izdaja = **v1.166.0** (pin v `src/lib/version.ts` + 6 testnih pinov, točno naštetih v Task 7).
- **0 DDL:** `SCHEMA_MIGRATIONS.length` mora ostati **30** (pritrjeno v `tests/stroski-ddl.test.ts:153`, `tests/migrations-console.test.ts:99`, `tests/issue24-labels.test.ts:826`, `tests/issue4-einvoices.test.ts:1026`, `tests/issue15-lot-governance.test.ts:637`, `tests/issue11-crm-admin.test.ts:126`, `tests/issue7-allergen-truth.test.ts:720`, `tests/issue69-visual-density.test.ts:328`). Nobena migracija, noben Prisma sprememba.
- **Brez vedenjskih sprememb:** brez novih stanj, handlerjev, API klicev, i18n ključev ali permission logike. Datotečna množica sprememb = CSS / Tailwind razredi / dekorativni `data-*` markerji (dovoljeno po vzorcu issue69 §F).
- **`--radius: 10px` (globals.css:52) je nedotakljiv** (issue #74 V-1); `prefers-reduced-motion` blok (globals.css ~305–316) nedotakljen; varovalka `:not([class*="border-"])` (globals.css:239–249) nedotakljena (issue #74 / v1.131.0 lekcija o preglasujočem pravilu).
- **Pritrjene celote morajo ostati bajt-identične** (sicer suite pade):
  - `tests/v141-toast-benchmark.test.ts:90` → `bg-white dark:bg-stone-800` in `:91` → `dark:hover:bg-stone-700`, `:94` → `dark:bg-stone-950/95`
  - `tests/issue69-visual-density.test.ts:178` → `sticky top-14 z-20 rounded-xl border border-stone-200 p-1.5 shadow-sm`
  - `tests/issue69-visual-density.test.ts:184` → `shrink-0 min-h-11 inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-700`
  - `tests/issue69-visual-density.test.ts:193` → `sticky top-[7.125rem] z-10 py-1.5 border-b border-stone-200 bg-stone-50/95 backdrop-blur`
  - `tests/issue69-visual-density.test.ts:199` → `bg-white p-3 md:p-2.5 flex items-center justify-between gap-2`
  - `tests/issue74-visual.test.ts:102–107` → regex `/^border-stone-200 border-l-/`
  - `tests/issue73-audit10-11.test.ts:145–146` → `data-region="dashboard-sidebar"` in `data-region="dashboard-mobile-nav"` (markerja same, ne razredi)
  - KDS glava listka: `tests/issue69-visual-density.test.ts` (statusni izpis) — `o.status === 'SENT' ? 'border-stone-300 bg-stone-50 text-stone-700'` in `o.status === 'PREPARED' || o.status === 'READY' ? 'border-emerald-300 bg-emerald-50 text-emerald-800'`
- **`statusColors` (`src/app/dashboard/page.tsx:166`) je nedotakljiv** — naloga #11 (WCAG 1.4.3) je ročno umerila svetlost; spreminjati je ne sme.
- **Kontrast AA (WCAG 1.4.3)** za vsak par ozadje/besedilo v lupini in vsebini; fokusni obroč (2.4.7) viden v obeh načinih.
- **Ni novih odvisnosti, ni sprememb `package.json`.**
- **Varnost:** nikoli ne zapisuj tokenov v datoteke, skripte, remote URL-je ali commite; izpis ukazov redči z `sed -E 's/(ghp|glpat|github_pat)_[A-Za-z0-9_-]+/[REDACTED]/g'`.
- **TDD:** vsak korak = najprej RED (test mora pasti zaradi manjkajoče spremembe, ne zaradi tipkarske napake), nato GREEN, nato **mutacijski dokaz** (pokvari implikacijo → test pade → povrni). Testi so source-pin (preberejo `src/` kot niz), brez DB fiksur — vzorec `tests/issue69-visual-density.test.ts:29–40`.
- Jezik: koda in dokumenti v **slovenščini**, poročila lastniku v slovenščini.

---

### Task 1: Blagovni tokeni — emerald `--primary` in grafična paleta

**Files:**
- Modify: `src/app/globals.css:59-60` (`--primary`, `--primary-foreground` v `:root`), `:70` (`--ring`), `:71-75` (`--chart-1..5`)
- Modify: `src/app/globals.css:93-94` (`.dark` `--primary`, `--primary-foreground`), `:105-109` (`.dark` `--chart-1..5`; tovarniški `--chart-1` je vijoličen `oklch(0.488 0.243 264.376)`)
- Modify: `src/app/globals.css:200` (polish `:root` `--ring`)
- Test: `tests/v166-visual-shell.test.ts` (ustvari ga ta task)

**Interfaces:**
- Produces: vrednosti žetonov, ki jih Task 3 podeduje po kaskadi (`--primary`, `--primary-foreground`, `--ring`, `--chart-1..5`). Task 2 in 4 predpostavljata `BRAND = oklch(0.508 0.118 165.612)` (Tailwind emerald-700 = `#047857` = `viewport.themeColor`).
- Konvencija za celoten načrt: žetoni, ki so **podvojjeni** v polish bloku (`--background`, `--card`, `--border`, `--ring`), se urejajo v polish bloku; žetoni, ki obstajajo **samo** v tovarniškem bloku (`--primary`, `--chart-*`, `--sidebar-*`), se urejajo na kraju samem. Nikoli na obeh mestih.

- [ ] **Step 1: Napiši RED test**

Ustvari `tests/v166-visual-shell.test.ts`:

```typescript
/**
 * v1.166.0 — vizualna prenova „temna lupina" (spec:
 * docs/superpowers/specs/2026-10-21-vizualna-prenova-temna-lupina-design.md).
 *
 *  A. BLAGOVNI ŽETONI: --primary je emerald v OBEH načinih, --ring sledi,
 *     grafična paleta je emerald-sidrana.
 *  B. LUPINA: --sidebar-* je oglje v OBEH načinih, vijolični tovarniški
 *     --sidebar-primary ne sme preostati.
 *  C. REGIJE: lupina je obarvana lokalno (region-ski žetoni), ne prek
 *     preimenovanja razredov.
 *  D. RAZREDI LUPINE v TSX: glava / steber / mobilna vrstica / predal.
 *  E. INVARIANTE: --radius 10px, tabular-nums, 0 DDL, pritrjene celote.
 *
 * Čisto source-pin (vzorec issue69): brez DB fiksur, brez API klicev.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'

const src = (p: string): string => readFileSync(join(process.cwd(), 'src', p), 'utf8')
const css = (): string => src('app/globals.css')

/** oklch(L C H) → {L,C,H}; test meritve POMEN žetona, ne njegovega zapisa. */
const oklch = (s: string): { L: number; C: number; H: number } | null => {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s)
  return m ? { L: +m[1], C: +m[2], H: +m[3] } : null
}
/** Vrednost žetona, kot jo VIDI brauzer: zadnjič deklarirana v bloku
    `selector { … }` po vrsti vira (enaka specifičnost ⇒ source order).
    Pazljivo: --primary je deklariran SAMO v tovarniškem bloku, --ring pa
    tudi v polish bloku (195) — helper mora presneti VSE bloke, ne samo
    zadnjega, sicer test laže. */
const tokenIn = (cssText: string, selector: string, token: string): string | null => {
  const blockRe = new RegExp(`^${selector}\\s*\\{([\\s\\S]*?)^\\}`, 'gm')
  const declRe = new RegExp(`--${token}:\\s*([^;]+);`, 'g')
  let last: string | null = null
  for (const b of cssText.matchAll(blockRe)) {
    for (const m of b[1].matchAll(declRe)) last = m[1].trim()
  }
  return last
}
const isEmerald = (v: string | null): boolean => {
  const o = v ? oklch(v) : null
  return !!o && o.C >= 0.1 && o.H >= 150 && o.H <= 180
}
const isCharcoal = (v: string | null): boolean => {
  const o = v ? oklch(v) : null
  return !!o && o.L <= 0.3
}

describe('v1.166.0 §A — blagovni žetoni', () => {
  it('--primary je emerald v svetlem načinu', () => {
    expect(isEmerald(tokenIn(css(), ':root', 'primary'))).toBe(true)
  })
  it('--primary je emerald v temnem načinu', () => {
    expect(isEmerald(tokenIn(css(), '\\.dark', 'primary'))).toBe(true)
  })
  it('--primary-foreground v svetlem načinu je bel (AA na emerald-700)', () => {
    const v = tokenIn(css(), ':root', 'primary-foreground')
    const o = v ? oklch(v) : null
    expect(o && o.L >= 0.95 && o.C <= 0.02).toBe(true)
  })
  it('--chart-1 je emerald (grafni znak znamke)', () => {
    expect(isEmerald(tokenIn(css(), ':root', 'chart-1'))).toBe(true)
  })
  it('--ring sledi znamki', () => {
    expect(isEmerald(tokenIn(css(), ':root', 'ring'))).toBe(true)
  })
})
```

- [ ] **Step 2: Zaženi test in poglej FAIL**

Run: `cd ros && bun test tests/v166-visual-shell.test.ts --timeout 20000`
Expected: 5 od 5 §A testov PADE („expected false to be true" za `--primary`, `--chart-1`, `--ring`; `--primary-foreground` je že bel in TIHO MORA OSTATI zelen — če pade, je napaka v parserju, ne v CSS). `--chart-1` tovarniško `oklch(0.646 0.222 41.116)` = oranžna → pade; `--ring` tovarniško `oklch(0.708 0 0)` in polish `oklch(0.62 0.13 160)` → zadnji blok je polish (160 = modro-zelena, C 0.13, H 160 → **že zmaga**). Če `--ring` test NE pade, je to potrjeno dejstvo: polish `:root:200` je že emerald — potem test obdrži kot invarianto in ta korak zabeleži »ring je bil že zelen, ni RED-a za ring«.

- [ ] **Step 3: GREEN — zamenjaj blagovne vrednosti**

`src/app/globals.css`, tovarniški `:root` blok (vrstice 59–75):

```css
  --primary: oklch(0.508 0.118 165.612);
  --primary-foreground: oklch(0.985 0 0);
```

`--ring` v tovarniškem `:root` (70) PUSTI nespremenjen (polish `:root:200` ga prepiše — konvencija „podvojeni žetoni se urejajo v polish bloku").

Grafična paleta v tovarniškem `:root` (71–75) — emerald osnova z razločno svetlostno lestvijo:

```css
  --chart-1: oklch(0.508 0.118 165.612);
  --chart-2: oklch(0.62 0.13 168);
  --chart-3: oklch(0.72 0.11 172);
  --chart-4: oklch(0.42 0.1 160);
  --chart-5: oklch(0.8 0.09 176);
```

`.dark` blok (93–94):

```css
  --primary: oklch(0.62 0.13 165);
  --primary-foreground: oklch(0.19 0.02 165);
```

`.dark` grafična paleta (vrstice 105–109, nadomesti vijolično osnovo) — emerald lestvika za temno platno:

```css
  --chart-1: oklch(0.62 0.13 165);
  --chart-2: oklch(0.72 0.12 168);
  --chart-3: oklch(0.52 0.11 160);
  --chart-4: oklch(0.8 0.1 175);
  --chart-5: oklch(0.42 0.09 155);
```

- [ ] **Step 4: Zaženi §A + celoten suite**

Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000 && bun test --timeout 20000`
Expected: §A zelen; celoten suite zelen (3078 testov) — noben obstoječi test ne pin-a barvne vrednosti (preverjeno z grepom `--primary|oklch` po `tests/`).

- [ ] **Step 5: Mutacijski dokaz**

Začasno vrni `--primary: oklch(0.205 0 0);` v tovarniški `:root`.
Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000`
Expected: **»--primary je emerald v svetlem načinu« PADE.** Povrni vrednost, ponovni zagon → zelen. Zabeleži oboje v poročilu (po vzorcu `verification-mutation-harness` iz spomina: nepreizkušen stražar ni stražar).

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css tests/v166-visual-shell.test.ts
git commit -m "FIX v1.166.0: blagovni žetoni — emerald --primary, --ring in grafična paleta"
```

---

### Task 2: Žetoni lupine — družina `--sidebar-*` v oglje

**Files:**
- Modify: `src/app/globals.css:76-83` (`:root` `--sidebar-*`)
- Modify: `src/app/globals.css:110-117` (`.dark` `--sidebar-*`)
- Test: `tests/v166-visual-shell.test.ts` (dodaj sekcijo §B)

**Interfaces:**
- Produces: `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring`. Task 4 jih porabi kot razrede `bg-sidebar`, `text-sidebar-foreground`, `border-sidebar-border`; `@theme inline` (globals.css:11–18) jih že preslikava v `--color-sidebar*`, zato noben nov žeton ni treba registrirati.
- Uporabnik danes: `src/components/ui/sidebar.tsx` (v kodi **nepoužitek** — `grep "ui/sidebar"` brez zadetkov), zato sprememba vrednosti ne more pokvariti nobenega zaslona.

- [ ] **Step 1: Napiši RED (§B)**

Dodaj na konec `tests/v166-visual-shell.test.ts` (orodji `oklch`, `tokenIn`, `isEmerald`, `isCharcoal` iz §A so že definirana):

```typescript
describe('v1.166.0 §B — žetoni lupine (oglje v obeh načinih)', () => {
  it('--sidebar je oglje v svetlem načinu', () => {
    expect(isCharcoal(tokenIn(css(), ':root', 'sidebar'))).toBe(true)
  })
  it('--sidebar je oglje v temnem načinu', () => {
    expect(isCharcoal(tokenIn(css(), '\\.dark', 'sidebar'))).toBe(true)
  })
  it('--sidebar-foreground je skoraj bel (AA besedilo na oglju)', () => {
    const v = tokenIn(css(), ':root', 'sidebar-foreground')
    const o = v ? oklch(v) : null
    expect(!!o && o.L >= 0.9).toBe(true)
  })
  it('vijolični tovarniški --sidebar_primary ne sme preostati', () => {
    // tovarniška vijolična = oklch(0.488 0.243 264.376) — hue ~264
    const o = oklch(tokenIn(css(), '\\.dark', 'sidebar-primary') ?? '')
    expect(!!o && o.H > 200 && o.H < 300).toBe(false)
  })
  it('--sidebar-accent je emerald-tonirana podlaga aktivne postavke', () => {
    const o = oklch(tokenIn(css(), ':root', 'sidebar-accent') ?? '')
    expect(!!o && o.H >= 150 && o.H <= 180 && o.L <= 0.4).toBe(true)
  })
})
```

- [ ] **Step 2: Zaženi in poglej FAIL**

Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000`
Expected: §B PADE na `--sidebar` (svetli `oklch(0.985 0 0)`, temni `oklch(0.205 0 0)` → svetli pade), na `--sidebar-accent` (`oklch(0.97 0 0)`) in na vijoličnem `--sidebar-primary`. `--sidebar-foreground` (0.985) lahko ostane zelen — to je obstoječa tovarniška vrednost in je pričakovana.

- [ ] **Step 3: GREEN — ogljena lupina**

`src/app/globals.css:76-83` (svetli način):

```css
  --sidebar: oklch(0.24 0.012 250);
  --sidebar-foreground: oklch(0.96 0.004 250);
  --sidebar-primary: oklch(0.508 0.118 165.612);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.32 0.03 165);
  --sidebar-accent-foreground: oklch(0.97 0.006 165);
  --sidebar-border: oklch(1 0 0 / 12%);
  --sidebar-ring: oklch(0.68 0.13 165);
```

`src/app/globals.css:110-117` (temni način — luknja je temnejša in hladnejša od vsebinskega `--background: oklch(0.16 0.008 155)` (318), da je okvir prepoznaven):

```css
  --sidebar: oklch(0.15 0.012 250);
  --sidebar-foreground: oklch(0.96 0.004 250);
  --sidebar-primary: oklch(0.62 0.13 165);
  --sidebar-primary-foreground: oklch(0.19 0.02 165);
  --sidebar-accent: oklch(0.3 0.035 165);
  --sidebar-accent-foreground: oklch(0.97 0.006 165);
  --sidebar-border: oklch(1 0 0 / 12%);
  --sidebar-ring: oklch(0.68 0.13 165);
```

- [ ] **Step 4: Zaženi §B + celoten suite**

Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000 && bun test --timeout 20000`
Expected: §B zelen; celoten suite zelen (nič ne bere `--sidebar-*`).

- [ ] **Step 5: Mutacijski dokaz**

Vrni `--sidebar: oklch(0.985 0 0);` (svetli) in `--sidebar-primary: oklch(0.488 0.243 264.376);` (temni).
Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000`
Expected: padeta oba testa (»oglje v svetlem načinu« in »vijolični … ne sme preostati«). Povrni → zelen.

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css tests/v166-visual-shell.test.ts
git commit -m "FIX v1.166.0: žetoni lupine — ogljena družina --sidebar-* v obeh načinih"
```

---

### Task 3: Regijski sloj lupine (CSS obarvanje, brez preimenovanja razredov)

**Files:**
- Modify: `src/app/globals.css` — nov blok na **konec datoteke** (za vrstico 789; OPOMBA o specifičnosti spodaj)
- Test: `tests/v166-visual-shell.test.ts` (dodaj sekcijo §C)

**Interfaces:**
- Consumes: `--sidebar-*` iz Task 2; `BRAND` iz Task 1.
- Produces: trije sidrski selektorji, na katerih visi celotna lupina: `[data-region="dashboard-header"]`, `[data-region="dashboard-sidebar"]`, `[data-region="dashboard-mobile-nav"]`. Task 4 jih najde že v TSX (glava `page.tsx:2204`, steber `dashboard-nav.tsx:186`, mobilna vrstica `dashboard-nav.tsx:218`) — nobenega novega sidra ni treba dodajati.
- **Mehanizem (dokazani v repozitoriju, ne izmišljen):** `@theme inline` (globals.css:35) definira `--color-primary: var(--primary)`, utilite pa se prevedejo v `background-color: var(--color-stone-50)` ipd. — zato redeklaracija `--color-stone-50` na predniku spremeni vse potomce. Repozitorij to že počne v `.dark` bloku na 143–146 in to dokumentira komentar na 766: »Tailwind bg-stone-50/95 se v temnem preslika prek žetona --color-stone-50«.
- **Specifičnost (lekcija v1.131.0 — nikoli ne preglasiti kaskade):** obstoječi temni remapi (`.dark .bg-white`, `.dark .text-stone-400`, `.dark .bg-emerald-50` …) so na 148–190 s specifičnostjo `(0,2,0)`. Naš blok `[data-region="…"] .bg-white` je ravno tako `(0,2,0)`, ZATO MORA BITI ZA 190 — na konec datoteke. Pred 190 bi temni remap zmagal in bi bila lupina v temnem načinu drugačna kot v svetlem.

- [ ] **Step 1: Napiši RED (§C)**

```typescript
/** Izlusuje blok lupine (seznamski selektor v treh vrsticah + telo). Vrne ''
    če blok ne obstaja — testi then PADejo, ne vržejo. */
const shellBlock = (d: string): string => {
  const anchor = '[data-region="dashboard-header"],\n[data-region="dashboard-sidebar"],\n[data-region="dashboard-mobile-nav"] {'
  const start = d.indexOf(anchor)
  return start < 0 ? '' : d.slice(start, d.indexOf('}', start))
}

describe('v1.166.0 §C — obarvanje lupine po regijah', () => {
  const d = css()
  it('regijski blok našteje vse tri regije lupine', () => {
    expect(shellBlock(d).length).toBeGreaterThan(0)
  })
  it('regije lokalno redeklarirajo vsebinske žetone (mehanizem @theme inline)', () => {
    const b = shellBlock(d)
    for (const t of ['--background', '--card', '--border', '--input', '--foreground', '--muted-foreground']) {
      expect(b).toContain(t)
    }
    expect(b).toContain('color-scheme: dark')
  })
  it('stone skala je v lupini premaknjena na lahka besedila', () => {
    expect(shellBlock(d)).toContain('--color-stone-400: oklch(0.72 0.010 250);')
    expect(shellBlock(d)).toContain('--color-stone-900: oklch(0.98 0.004 250);')
  })
  it('beli gumbi v lupini ne smejo ostati beli (oba načina) — eksplicitno pravilo', () => {
    expect(d).toContain('[data-region="dashboard-header"] .bg-white')
  })
  it('blok je POSTAVLJEN ZA temne remape (pri enaki (0,2,0) odloča vrstni red)', () => {
    expect(d.indexOf('[data-region="dashboard-header"] .bg-white'))
      .toBeGreaterThan(d.indexOf('.dark .bg-white'))
    expect(d.indexOf('[data-region="dashboard-header"],'))
      .toBeGreaterThan(d.indexOf('.dark .bg-emerald-50'))
  })
  it('--color-white je namenoma NEDOTAKNJEN (bel napis znamke + text-white na emerald)', () => {
    expect(d).not.toContain('--color-white')
  })
})
```

- [ ] **Step 2: Zaženi in poglej FAIL**

Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000`
Expected: §C PADE (noben od `[data-region="dashboard-*"]` CSS selektorjev ne obstaja; edini obstoječi je `[data-screen="dashboard"] > [data-region="dashboard-header"]` na 463, ki ne vseguje stebra in mobilne vrstice).

- [ ] **Step 3: GREEN — dodaj blok na konec `src/app/globals.css`**

```css

/* ── v1.166.0 TEMNA LUPINA ──────────────────────────────────────────────────
   Glava, stranski steber in mobilna spodnja vrstica so OGLJE v obeh načinih
   (spec §3.3). Mehanizem je lokalna redeklaracija žetonov na regiji, ker
   @theme inline (6–47) veže utilite na var(--…): noben TLORISNI razred se ne
   preimenuje, zato pritisnjeni testi (issue69 §D, v141 §D, issue74) ostanejo
   zelena. --color-white NAMERNO ni prepisan — bel je napis »RestaurantOS« in
   text-white na emerald znaku. Vrstni red je OBVEZEN za koncem datoteke:
   our [data-region] .x in .dark .x imata obe (0,2,0), odloča source order
   (lekcija v1.131.0 o preglasujočih pravilih). */
[data-region="dashboard-header"],
[data-region="dashboard-sidebar"],
[data-region="dashboard-mobile-nav"] {
  color-scheme: dark;
  /* vsebinski žetoni → oglje; ui/* komponente (Input bg-transparent +
     border-input, Button ghost hover:bg-accent, SelectTrigger) jih podedujejo */
  --background: oklch(0.24 0.012 250);
  --foreground: oklch(0.96 0.004 250);
  --card: oklch(0.28 0.014 250);
  --popover: oklch(0.28 0.014 250);
  --muted: oklch(0.33 0.016 250);
  --muted-foreground: oklch(0.78 0.008 250);
  --secondary: oklch(0.33 0.016 250);
  --secondary-foreground: oklch(0.96 0.004 250);
  --accent: oklch(0.32 0.03 165);
  --accent-foreground: oklch(0.97 0.006 165);
  --border: oklch(1 0 0 / 12%);
  --input: oklch(1 0 0 / 16%);
  --ring: oklch(0.68 0.13 165);
  /* hladna stone skala — lahka besedila na oglju (AA) in temni robovi */
  --color-stone-50: oklch(0.3 0.014 250);
  --color-stone-100: oklch(0.33 0.016 250);
  --color-stone-200: oklch(1 0 0 / 12%);
  --color-stone-300: oklch(1 0 0 / 18%);
  --color-stone-400: oklch(0.72 0.010 250);
  --color-stone-500: oklch(0.8 0.008 250);
  --color-stone-600: oklch(0.87 0.006 250);
  --color-stone-700: oklch(0.93 0.005 250);
  --color-stone-900: oklch(0.98 0.004 250);
  /* pastelni čipi (sync, mize, jezik) — then iz emerald/amber/red tint, ne
     iz bele ploščice; nasičene 700/800 ostanejo za besedilo na belem */
  --color-emerald-50: oklch(0.32 0.05 165);
  --color-emerald-100: oklch(0.36 0.06 165);
  --color-emerald-200: oklch(0.46 0.08 165);
  --color-emerald-900: oklch(0.92 0.06 165);
  --color-amber-50: oklch(0.32 0.05 78);
  --color-amber-200: oklch(0.48 0.08 78);
  --color-amber-700: oklch(0.85 0.11 82);
  --color-red-50: oklch(0.31 0.06 22);
  --color-red-100: oklch(0.34 0.07 22);
  --color-red-200: oklch(0.46 0.09 22);
  --color-red-300: oklch(0.52 0.1 22);
  --color-red-700: oklch(0.8 0.13 22);
  --color-red-800: oklch(0.85 0.12 22);
}
/* zrnca, ki NISO token-drivana: bg-white (glava sama je v Task 4 že bg-sidebar,
   tu ujame jezični preklopnik i18n.tsx:100 in PaletteButton command-palette.tsx)
   v OBEH načinih. (0,2,0) + končni vrstni red ⇒ zmaga nad .dark .bg-white. */
[data-region="dashboard-header"] .bg-white,
[data-region="dashboard-sidebar"] .bg-white,
[data-region="dashboard-mobile-nav"] .bg-white {
  background-color: oklch(0.3 0.014 250);
}
[data-region="dashboard-header"] .hover\:bg-white:hover,
[data-region="dashboard-sidebar"] .hover\:bg-white:hover {
  background-color: oklch(0.36 0.016 250);
}
/* sence: na oglju mehka črna, ne bleda all-green senca (236) */
[data-region="dashboard-sidebar"],
[data-region="dashboard-mobile-nav"] {
  box-shadow: 0 1px 0 oklch(0 0 0 / 24%);
}
```

- [ ] **Step 4: Zaženi §C + celoten suite**

Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000 && bun test --timeout 20000`
Expected: §C zelen; suite zelen.

- [ ] **Step 5: Mutacijski dokaz (dve mutaciji)**

(a) Premakni `[data-region="dashboard-header"] .bg-white` pravilo pred vrstico 148 → test »blok je POSTAVLJEN ZA temne remape« mora pastí. (b) Iz bloka izbriši `color-scheme: dark` in `--input` → testa §C/2 mora pasti. Povrni oboje → zelen.

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css tests/v166-visual-shell.test.ts
git commit -m "FIX v1.166.0: lupina obarvana po regijah (region-ski žetoni, brez preimenovanja razredov)"
```

---

### Task 4: Razredi lupine v TSX (steber, mobilna vrstica, glava, predal)

**Files:**
- Modify: `src/components/dashboard-nav.tsx:65-69` (NavItem stanji), `:187` (slog stebra), `:188` (rob iskalnega polja), `:220` (mobilna spodnja vrstica), `:232-236` (aktivno stanje mobilne vrstice), `:249` («Več» gumb), `:277` (`DrawerContent`)
- Modify: `src/app/dashboard/page.tsx:2204` (glava)
- Test: `tests/v166-visual-shell.test.ts` (dodaj sekcijo §D)

**Interfaces:**
- Consumes: žetoni Task 2 (`bg-sidebar`, `text-sidebar-foreground`, `border-sidebar-border` se morajo preslikati — `@theme inline` jih registrira že na 11–18) in regijski sloj Task 3.
- Produces: `data-region` markerji ostanejo IDENTIČNI (`dashboard-sidebar`, `dashboard-mobile-nav`, `dashboard-header`) — to so testna sidra (issue73:145–146) in CSS sidra Task 3.

- [ ] **Step 1: Napiši RED (§D)**

```typescript
describe('v1.166.0 §D — razredi lupine v TSX', () => {
  const nav = src('components/dashboard-nav.tsx')
  const d = src('app/dashboard/page.tsx')
  it(' stranski steber nosi oglje žetone, ne bele plošče', () => {
    expect(nav).toContain('border-r border-sidebar-border bg-sidebar text-sidebar-foreground')
    expect(nav).toContain('data-region="dashboard-sidebar"')
  })
  it('mobilna spodnja vrstica nosi oglje žetone', () => {
    expect(nav).toContain('border-t border-sidebar-border bg-sidebar text-sidebar-foreground pb-[env(safe-area-inset-bottom)] lg:hidden')
    expect(nav).toContain('data-region="dashboard-mobile-nav"')
  })
  it('glava dashboarda nosi oglje', () => {
    expect(d).toContain('data-region="dashboard-header" className="sticky top-0 z-20 bg-sidebar text-sidebar-foreground border-b border-sidebar-border')
  })
  it('predal »Več« je ogljen (prej je podedoval bg-background)', () => {
    expect(nav).toContain('DrawerContent className="max-h-[82vh] bg-sidebar text-sidebar-foreground"')
  })
  it('aktivna postavka: emerald rob + --sidebar-accent podlaga', () => {
    expect(nav).toContain("active\n          ? 'border-emerald-400 bg-sidebar-accent font-semibold text-sidebar-accent-foreground'")
  })
  it('neaktivna postavka: muted na oglju, hover iz žetona', () => {
    expect(nav).toContain('border-transparent font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground')
  })
  it('noben razred lupine ne sme vsebovati bg-white (preusmerjeno na žeton)', () => {
    expect(nav.slice(nav.indexOf('data-region="dashboard-sidebar"'), nav.indexOf('data-region="dashboard-mobile-nav"')))
      .not.toContain('bg-white')
  })
})
```

- [ ] **Step 2: Zaženi in poglej FAIL**

Run: `bun test tests/v166-visual-shell.test.ts -t "§D" --timeout 20000`
Expected: vseh 7 PADE (trenutno `bg-white`/`border-stone-200`/`bg-emerald-50`).

- [ ] **Step 3: GREEN — zamenjaj razrede (samo razrede, DOM nespremenjen)**

`src/components/dashboard-nav.tsx:65-69` — `NavItem`:

```tsx
      className={`flex w-full items-center gap-2.5 rounded-lg border-l-2 py-2 pl-2.5 pr-2 text-left text-sm transition ${
        active
          ? 'border-emerald-400 bg-sidebar-accent font-semibold text-sidebar-accent-foreground'
          : 'border-transparent font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
      }`}
```

`src/components/dashboard-nav.tsx:187-188` — `DashboardSidebar`:

```tsx
      <div className="sticky top-14 flex h-[calc(100vh-3.5rem)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="border-b border-sidebar-border p-3">
```

`src/components/dashboard-nav.tsx:220` — `MobileBottomNav`:

```tsx
      className="fixed inset-x-0 bottom-0 z-30 border-t border-sidebar-border bg-sidebar text-sidebar-foreground pb-[env(safe-area-inset-bottom)] lg:hidden"
```

`src/components/dashboard-nav.tsx:232-236` — aktivno stanje mobilne vrstice (emerald mora biti NA oglju svetlejši — 400, ne 700):

```tsx
                active ? 'text-emerald-300' : 'text-sidebar-foreground/60 hover:text-sidebar-foreground'
              }`}
            >
              {active && <span className="absolute inset-x-2 top-0 h-0.5 rounded-b bg-emerald-400" aria-hidden="true" />}
```

`src/components/dashboard-nav.tsx:249` — «Več» gumb:

```tsx
          className="flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-sidebar-foreground/60 transition hover:text-sidebar-foreground"
```

`src/components/dashboard-nav.tsx:277` — predal:

```tsx
      <DrawerContent className="max-h-[82vh] bg-sidebar text-sidebar-foreground">
```

`src/app/dashboard/page.tsx:2204` — glava:

```tsx
      <header data-region="dashboard-header" className="sticky top-0 z-20 bg-sidebar text-sidebar-foreground border-b border-sidebar-border shadow-sm">
```

- [ ] **Step 4: Preveri, da ni stranskih učinkov**

Run: `grep -n "stone-\|bg-white" src/components/dashboard-nav.tsx`
Expected: edini preostali `stone` so `text-stone-400` na skupinskih nadpisih (`:160`) in skupinski oznaki (`:73`) — ta dva sta znotraj regij lupine in ju Task 3 že prenese na lahki `--color-stone-400`. Pustí ju (preimenovanje bi bilo odvečno in ne varuje nobenega testa).

- [ ] **Step 5: Zaženi §D + celoten suite**

Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000 && bun test --timeout 20000`
Expected: §D zelen; celoten suite zelen. Če `issue73` ali `issue69` pasteta, je razlog gotovo spremenjen `data-region` marker ali pritisnjen niz iz Global Constraints — popravi razred, ne testa.

- [ ] **Step 6: Mutacijski dokaz**

Vrni glavi `bg-white border-b border-stone-200 shadow-sm`.
Run: `bun test tests/v166-visual-shell.test.ts -t "§D" --timeout 20000`
Expected: test »glava dashboarda nosi oglje« PADE. Povrni → zelen.

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard-nav.tsx src/app/dashboard/page.tsx tests/v166-visual-shell.test.ts
git commit -m "FIX v1.166.0: lupina v TSX — steber, glava, mobilna vrstica in predal na sidebar žetone"
```

---

### Task 5: Hero zasloni — samo sidra, ki dokazano obstajajo

**Files:**
- Modify: `src/app/globals.css` (pravila za `[data-component="kds-station-card"]` 526–546, `[data-screen="handheld-pos"] > [data-region="handheld-header"]` 500–504, `[data-region="kds-ticket"]`, nov `[data-region="pos-floor-plan"]`)
- Modify: `src/app/dashboard/page.tsx:2425` — dodaj EN marker `data-region="pos-floor-plan"` (dekorativni `data-*`, dovoljeno po issue69 §F)
- Test: `tests/v166-visual-shell.test.ts` (dodaj sekcijo §E)

**Interfaces:**
- Consumes: `BRAND` (Task 1) in regijski sloj (Task 3).
- Produces: `data-region="pos-floor-plan"` kot novo sidro za CSS in test.
- **NEDOTAKLJIVO — tri dejanske semanticne signalizacije, ne okras:**
  1. `statusColors` (`page.tsx:166`, WCAG umerjena po nalogi #11).
  2. **STAROSTNI ROB KDS LISTKA**: `page.tsx:3375` nosi `border-l-4 ${stale ? … : kdsAgeBorderCls(ageCls)}`, preslikava stopenj je na `page.tsx:341-342` (`border-l-emerald-600`, `border-l-amber-500`, `border-l-orange-600`, `border-l-rose-500`, …). CSS pravilo, ki nastavi `border-left` na `[data-region="kds-ticket"]`, bi ta signal **IZNILOČILO** — zato ga §E izrecno prepoveduje. Rdeča ostane rezervirana za zamudo (v1.141.0 odločitev).
  3. Alergijski `role="alert"` robovi `border-l-4 border-red-600` (`page.tsx:3438`, `:3453`, `:3529`).
- **Postavitev `background` pri handheld glavi je `background-image: linear-gradient(...)`** (`globals.css:501`), ne barva — zato jo znamka nadgradi prek `background-image`, ne prek `background-color` (slednja bi ostala pod gradientom in ne bi bila vidna).
- **Ni izmišljenih sidr:** `dashboard/page.tsx` ima natančno ta `data-region` nabor (dokazano z `grep -o`): `dashboard-header`, `kds-86board`, `kds-allday`, `kds-allergen-chip`, `kds-bump-all`, `kds-next-chip`, `kds-section-active`, `kds-section-stale`, `kds-ticket`, `kds-ticket-allergen-unconfirmed`, `kds-ticket-allergies`, `kds-ticket-header`, `kds-ticket-item`, `kds-ticket-items`, `kds-ticket-timer`, `kds-ticket-timer-row`, `menu-category`, `menu-category-header`, `menu-category-items`, `menu-quickjump`, `no-location-banner`, `settings-quickjump`, `settings-section`, `settings-section-header`. `data-component` v `page.tsx` NE obstaja — `kds-station-card` živi v `src/components/kds-station-board.tsx`.

- [ ] **Step 1: Napiši RED (§E)**

```typescript
describe('v1.166.0 §E — hero zasloni (samo dejanska sidra)', () => {
  const d = src('app/dashboard/page.tsx')
  const s = src('app/globals.css')
  const board = src('components/kds-station-board.tsx')
  it('KDS listek: dvignjen (senca + enoten rob), A BREZ posega v starostni rob', () => {
    expect(s).toContain('[data-region="kds-ticket"] {\n  box-shadow:')
    expect(s).not.toMatch(/\[data-region="kds-ticket"\]\s*\{[^}]*border-left/)
  })
  it('KDS postaja: glava kartice dobi emerald laso iz žetona znamke', () => {
    expect(board).toContain('data-component="kds-station-card"')
    expect(s).toContain('--emerald-hair: oklch(0.508 0.118 165.612 / 35%);')
  })
  it('handheld glava VEŽE NA ŽETON (--primary), ne na fiksno emerald vrednost', () => {
    expect(s).toContain('background-image: linear-gradient(110deg, var(--primary),')
  })
  it('PRODAJNI tloris dobi sidrski marker (en sam data-region, razredi enaki)', () => {
    expect(d).toContain('data-region="pos-floor-plan"')
  })
  it('tloris: enoten rob in senca prek sidra', () => {
    expect(s).toMatch(/\[data-region="pos-floor-plan"\]\s*\{\s*border-color: var\(--border\);/)
  })
  // ── invarianti (že zeleni; nikoli ju ne smeš «popraviti») ──
  it('statusColors NI dotaknjena (naloga #11 WCAG 1.4.3)', () => {
    expect(d).toContain("FREE: 'bg-emerald-700 text-white hover:bg-emerald-800'")
    expect(d).toContain("RESERVED: 'bg-white text-stone-900 border-2 border-dashed border-stone-500 hover:bg-stone-50 shadow-sm'")
  })
  it('starostni rob KDS listka ostane razred-drivana preslikava (page.tsx:3375)', () => {
    expect(d).toContain('border-l-4 ${stale ?')
    expect(d).toContain("'border-l-emerald-600', 'border-l-amber-500', 'border-l-orange-600', 'border-l-rose-500',")
  })
})
```

- [ ] **Step 2: Zaženi in poglej FAIL**

Run: `bun test tests/v166-visual-shell.test.ts -t "§E" --timeout 20000`
Expected: padere 1, 2, 3, 4, 5. Testa 6 in 7 (invarianti) morata TAKOJ ostati zelena — če katera pade, si stopil v obseg in moraš spremembo razveljaviti, NE pa spreminjati testa.

- [ ] **Step 3: GREEN — pravila na konec `src/app/globals.css` (za Task 3 blok)**

```css

/* ── v1.166.0 hero zasloni (poliranje, ne predelava — spec §3.4) ─────────── */
/* KDS listek: IZKLJUČNO dvig (senca, enoten rob). Zvezni se NE posega:
   border-l-4 nosi STAROST (page.tsx:3375 → kdsAgeBorderCls 341), rdeča pa je
   rezervirana za zamudo (v1.141.0). To pravilo ne sme nikoli vsebovati
   border-left — zato je §E test 1 zapisan kot negacija. */
[data-region="kds-ticket"] {
  box-shadow: 0 1px 2px oklch(0 0 0 / 18%), 0 10px 26px oklch(0 0 0 / 14%);
  border-radius: 0.625rem;
}
/* KDS postaje: glava kartice dobi emerald laso iz žetona znamke */
[data-component="kds-station-card"] [data-slot="card-header"] {
  --emerald-hair: oklch(0.508 0.118 165.612 / 35%);
  border-bottom: 1px solid var(--emerald-hair);
}
/* Natakarski handheld: chrome je že emerald (501), a s FIKSNIMI vrednostmi —
   veže se na žeton, da je znamka ena sama povsod. Kaskada: background-image
   (ne background-color), ker obstoječe pravilo uporablja gradient. */
[data-screen="handheld-pos"] > [data-region="handheld-header"] {
  background-image: linear-gradient(110deg, var(--primary), oklch(0.42 0.11 165));
}
.dark [data-screen="handheld-pos"] > [data-region="handheld-header"] {
  background-image: linear-gradient(110deg, oklch(0.42 0.11 165), var(--primary));
}
/* PRODAJNI tloris (nov sidrski marker): enoten rob/senca na obeh površinah */
[data-region="pos-floor-plan"] {
  border-color: var(--border);
  box-shadow: 0 1px 2px oklch(0.25 0.03 155 / 4%), 0 10px 28px oklch(0.25 0.03 155 / 5%);
}
```

`src/app/dashboard/page.tsx:2425-2430` — samo marker, razredi ostanejo beseda-besed enaki:

```tsx
              <div
                data-region="pos-floor-plan"
                className="relative w-full rounded-xl border border-stone-200 bg-stone-100/70 overflow-hidden touch-none"
                style={{ aspectRatio: '16 / 10' }}
                onPointerMove={planPointerMove}
                onPointerUp={planPointerUp}
              >
```

- [ ] **Step 4: Zaženi §E + celoten suite**

Run: `bun test tests/v166-visual-shell.test.ts --timeout 20000 && bun test --timeout 20000`
Expected: §E zelen; celoten suite zelen. KDS testi issue69/issue73/issue73-audit ostanejo zeleni — our pravilo ne sme nobenemu robu pisati `border-left`.

- [ ] **Step 5: Mutacijski dokaz (tri mutacije)**

(a) Naše `[data-region="kds-ticket"]` pravilo dodaj `border-left: 3px solid red;` → §E test 1 mora pastí (to je dokaz, da negacija res varuje starostni rob). (b) Izbriši `--emerald-hair` vrstico → test 2 pade. (c) Odstrani `data-region="pos-floor-plan"` iz TSX → testa 4 in 5 padeta. Povrni vse → zelen.

- [ ] **Step 6: Commit**

```bash
git add src/app/globals.css src/app/dashboard/page.tsx tests/v166-visual-shell.test.ts
git commit -m "FIX v1.166.0: hero zasloni — KDS dvig listka, emerald laso postaj, handheld in tloris na žetone znamke"
```

---

### Task 6: Živa vizualna verifikacija (merjenje, ne domneva)

**Files:**
- Without changes to source (this task only measures and takes screenshots); it can produce a FIX commit if measurement disproves an assumption
- Artifacts: screenshots in `.os-screenshots/v166/` (ignored directory, not committed)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: evidence for acceptance criteria A4 (shell dark in both modes), A5 (contrast/focus), A6 (local preview) and confirmation/refutation of the mechanism assumption from Task 3 (`--color-stone-*` scoping).

- [ ] **Step 1: Start the local run and log in**

```bash
cd ros && bun run local        # SQLite profile, DEMO_LOGIN_ENABLED=0
```
Open `http://localhost:3000`, log in with the local admin account. The browser is `browser-use` (or chrome-devtools) MCP, through Qoder Browser Connector.

- [ ] **Step 2: Measure the shell (the key assumption of the entire approach)**

Run via `evaluate_script` in the header, in LIGHT mode and in DARK mode:

```javascript
(() => {
  const h = document.querySelector('[data-region="dashboard-header"]')
  const s = document.querySelector('[data-region="dashboard-sidebar"]')
  const cs = (el) => el ? getComputedStyle(el) : null
  const H = cs(h), S = cs(s)
  const label = h?.querySelector('span.font-bold')
  const chip = document.querySelector('[data-region="dashboard-header"] .bg-emerald-50')
  const inner = s?.querySelector('[data-region="nav-search"] input')
  return {
    headerBg: H?.backgroundColor, sidebarBg: S?.backgroundColor,
    brandText: label ? getComputedStyle(label).color : null,
    chipBg: chip ? getComputedStyle(chip).backgroundColor : null,
    inputBorder: inner ? getComputedStyle(inner).borderColor : null,
    colorScheme: H?.colorScheme,
  }
})()
```

Expected: `headerBg`/`sidebarBg` = charcoal (relative RGB from L≈0.24 / L≈0.15), `brandText` = near white, `colorScheme` = `dark`. **If `chipBg` is still almost white, the token scoping did not propagate** (Tailwind generated a literal, not `var(--color-emerald-50)`) → then perform step 3 fallback and record in the commit message that the fallback was needed (this is the one assumption not provable via source-pin, explicitly flagged in spec §6).

- [ ] **Step 3: Fallback (only if step 2 disproves the scoping)**

Expand in `src/app/globals.css` the block of explicit utilities for the shell — copy the pattern of dark remaps (148–190) as `[data-region="dashboard-header"] .bg-emerald-50 { background-color: oklch(0.32 0.05 165); }` for all classes found inside the shell via `grep -o 'className=…'` (emerald/amber/red chips, `bg-stone-50/100`, `text-stone-*`). Add to the guard from §C a new `it()` that asserts, for each explicitly remapped class, the presence of the selector. Re-measure in the browser after each added rule.

- [ ] **Step 4: Contrast AA measurement**

For each of the pairs (shell background / shell text, shell background / muted text, emerald button / white text, chip background / chip text) compute the contrast and log it:

```javascript
(() => {
  const lum = (c) => { const [r,g,b] = c.match(/\d+(\.\d+)?/g).map(Number).map(v => v/255)
    .map(v => v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4); return 0.2126*r+0.7152*g+0.0722*b }
  const ratio = (a,b) => { const L1=lum(a), L2=lum(b); const [hi,lo]=L1>L2?[L1,L2]:[L2,L1]; return +((hi+0.05)/(lo+0.05)).toFixed(2) }
  const g = (sel, prop='color') => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null }
  return {
    brand: g('.bg-primary') && g('.text-primary-foreground') ? ratio(g('.bg-primary'), g('.text-primary-foreground')) : null,
    headerTitle: g('[data-region="dashboard-header"]') && g('[data-region="dashboard-header"] span.font-bold')
      ? ratio(g('[data-region="dashboard-header"]'), g('[data-region="dashboard-header"] span.font-bold')) : null,
  }
})()
```

Expected: all ≥ 4.5 (normal text) / ≥ 3.0 (large text ≥ 18.66 px bold). Record actual numbers in worklog; anything under AA → FIX commit before continuing.

- [ ] **Step 5: Keyboard focus + screenshots (light + dark)**

Tab through the header: every button shows a 3 px emerald outline (`:focus-visible` at 222–225). Photograph the dashboard (light), dashboard (dark), KDS board, handheld POS, mobile viewport 390 px (bottom bar) to `.os-screenshots/v166/`. Send the live URLs and one key screenshot to the owner for review (criterion A6) — per his preference: visible progress and his own live preview before publishing.

- [ ] **Step 6: Commit (only if fallback/FIX was needed)**

```bash
git add src/app/globals.css tests/v166-visual-shell.test.ts
git commit -m "FIX v1.166.0: uskladitev lupine po izmerjenem odstopanju žetonov v brskalniku"
```

---

### Task 7: Release ritual v1.166.0

**Files:**
- Modify: `src/lib/version.ts` (`APP_VERSION`)
- Modify: test pins (6): `tests/billing.test.ts:380`, `tests/issue10-labor-coverage.test.ts:1325`, `tests/issue11-crm-core.test.ts:738`, `tests/issue4-einvoices.test.ts:1023`, `tests/issue70-state-consistency.test.ts:481`, `tests/issue9-channel-sync.test.ts:497`
- Modify: `worklog.md` (repo root)

**Interfaces:**
- Produces: tag `v1.166.0`, GitHub `origin/main` + GitLab mirror, Vercel deployment, `/api/health` = `1.166.0`.

- [ ] **Step 1: Bump + pins**

`src/lib/version.ts`: `export const APP_VERSION = '1.166.0'`.
In the six files, replace `expect(APP_VERSION).toBe('1.165.0')` with `'1.166.0'` (no sed, use the Edit tool per file).

- [ ] **Step 2: Add §F invariant to the guard**

```typescript
describe('v1.166.0 §F — invariante (nikoli ne posei)', () => {
  const d = src('app/dashboard/page.tsx')
  const s = src('app/globals.css')
  it('--radius ostane 10px (issue #74 V-1)', () => { expect(s).toContain('--radius: 10px') })
  it('tabular-nums ostane globalno (issue #74 V-2)', () => { expect(s).toContain('font-variant-numeric: tabular-nums') })
  it('varovalka :not([class*="border-"]) ostane (v1.131.0)', () => { expect(s).toContain(':not([class*="border-"])') })
  it('reduced-motion blok ostane', () => { expect(s).toContain('prefers-reduced-motion') })
  it('0 DDL: SCHEMA_MIGRATIONS ostane 30', () => { expect(SCHEMA_MIGRATIONS.length).toBe(30) })
  it('lupina ne sme izgubiti navigacijskih sidr', () => {
    const vse = d + src('components/dashboard-nav.tsx')
    for (const r of ['dashboard-header', 'dashboard-sidebar', 'dashboard-mobile-nav']) {
      expect(vse).toContain(`data-region="${r}"`)
    }
  })
})
```

- [ ] **Step 3: Full gate (six zeros)**

```bash
bun test --timeout 20000 2>&1 | tail -20
bun run typecheck
bun run lint
git diff --check
bash scripts/check-secrets.sh
node scripts/check-schema-drift.cjs
```
Expected: suite 100 % green (expect ≈ 3078 + ~30 new tests), 0 type errors, 0 lints, no whitespace errors, 0 secrets, 0 drift.

- [ ] **Step 4: Worklog entry**

In `worklog.md` (repo root) above the latest entry, following the format of existing v1.16x.0 entries:

```markdown
## v1.166.0 — vizualna prenova »temna lupina« (2026-10-21)

**Kaj:** blagovna emerald paleta (--primary = emerald-700 #047857 = themeColor) in
temna ogljena lupina (glava + stranski steber + mobilna spodnja vrstica) okoli
svetle delovne površine, v obeh načinih. Hero zasloni (KDS listki, KDS postaje,
natakarski handheld, prodajni tloris) vezani na žetone znamke.
**Kako:** izključno žetoni v globals.css + regijsko obarvanje (@theme inline
veže utilite na var(--…)) + zamenjava razredov v lupini; nobenega TLORISNEGA
razreda v vsebini nismo preimenovali — pritisnjeni testi (issue69/v141/issue74)
ostanejo bajt-identični.
**Izvedba:** TDD, nova stražna datoteka tests/v166-visual-shell.test.ts (§A–§F),
vsak sklop mutacijsko dokazan.
**Merjenje v brskalniku:** <razmerja iz Task 6 + dokaz o prenosu žetonov>
**Obseg:** 0 DDL (SCHEMA_MIGRATIONS = 30), 0 API sprememb, komponentni API nespremenjen.
**Rezultat:** <število testov / zelen> · typecheck 0 · lint 0.
```

- [ ] **Step 5: Commits TEST + DOCS**

```bash
git add src/lib/version.ts tests/ worklog.md
git commit -m "TEST v1.166.0: bump verzije, pinov (6) in worklog za vizualno prenovo"
```

- [ ] **Step 6: Push GitHub + mirror**

```bash
git push origin HEAD 2>&1 | sed -E 's/(ghp|glpat|github_pat)_[A-Za-z0-9_-]+/[REDACTED]/g'
```
GitLab mirror (`robertpezdirc8/restaurantos`, project id 87573786): one-shot askpass push (the script may only reference `$GL_TOKEN`, never the token). If the token is 401, **do not retry** — record blockage in the closing commit (pending `063a98a..09e3a9f` from v1.165.0 + this release).

- [ ] **Step 7: Verify deployment**

```bash
curl -s https://<production-domain>/api/health | sed -E 's/(ghp|glpat|github_pat)_[A-Za-z0-9_-]+/[REDACTED]/g'
bun scripts/sync-check.ts
```
Expected: `version: 1.166.0`, `commit` = HEAD, `SYNCED`, CI green (GitHub Actions + GitLab pipeline, or record the runner quota blockage).

- [ ] **Step 8: Closing DOCS commit**

```bash
git add worklog.md
git commit -m "DOCS v1.166.0: zaključen izdajni ritual — GitHub + Vercel, GitLab <objavljen/blokiran>"
git push origin HEAD 2>&1 | sed -E 's/(ghp|glpat|github_pat)_[A-Za-z0-9_-]+/[REDACTED]/g'
```

---

## Self-review (izvedena ob pisanju)

1. **Pokritost spec:** §3.1 → Task 1+2; §3.2 (ui knjižnica prek žetonov, API nespremenjen) → Task 1/2/3 (knjižnice se ročno ne dotika noben task); §3.3 → Task 3+4; §3.4 → Task 5; §3.5 (AA/fokus) → Task 6; A1–A3 → Global Constraints + Task 7 step 3; A2 stražar → §A–§E (mutacijsko dokazani); A4 → Task 6 step 2; A5 → Task 6 step 4–5; A6 → Task 6 step 5; A7 → Task 7.
2. **Placeholders:** ni jih — vsak all block je vsebina, ki se izvrši. Edina izjema je delo `worklog.md` predloga v Task 7 step 4, kjer je `<razmerja iz Task 6>` zavedno prazno polje, ki ga izpolni izvedba (številke ob pisanju še ne obstajajo).
3. **Doslednost imen:** `BRAND = oklch(0.508 0.118 165.612)` je enak v Task 1, 2 in 5; sidra `dashboard-header|dashboard-sidebar|dashboard-mobile-nav|pos-floor-plan` so enaka v Task 3, 4, 5 in 7; helperji `oklch/tokenIn/isEmerald/isCharcoal/shellBlock` so definirani enkrat (Task 1 in Task 3) in v nadaljevanju samo poklicani. V §E in §F je lokalna konstanta `s` (CSS kot niz), da ne zasenči globalnega helperja `css()` — ne preimenuj ju.
4. **Popravki, ki jih je odkril pregled (zabeleženi, ker so bistveni):**
   - `tokenIn` je sprva prenašal samo zadnji blok `:root` — `--primary` pa je deklariran izključno v tovarniškem bloku (59), `--ring` pa v polish bloku (200). Test bi lažno padel tudi po pravilni izvedbi. Helper zdaj scanja VSE bloke in vzame zadnjo deklaracijo (to je kaskada).
   - Načrt je imel `border-left: 3px solid emerald` na `[data-region="kds-ticket"]`. To bi **uničilo starostni rob listka** (`page.tsx:3375` `border-l-4 ${stale ? … : kdsAgeBorderCls(ageCls)}`, lestvica na 341–342) in prekucnilo rdečo, ki je rezervirana za zamudo. Pravilo je preklicano; §E test 1 je zdaj NEGACIJA (CSS ne sme vsebovati `border-left` na tem sidru) in ima svoj mutacijski dokaz (Task 5 step 5a).
   - Handheld glava (`globals.css:501`) uporablja `background-image: linear-gradient`, ne barve — `background-color: var(--primary)` bi ostal pod gradientom (neviden). Popravljeno na gradient z žetonom + temno varianto.
   - `.dark --chart-1` je na vrstici **105** (vijolična `oklch(0.488 0.243 264.376)`), ne 101; reference na vrstice popravljene.
