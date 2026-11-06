import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_VERSION } from '../src/lib/version'

/**
 * JAVNI QA VAL #5 — POLIRANJE JAVNIH POVRŠIN (v1.228.0).
 *
 * Val je nastal iz E2E pregleda javnih gostujučih površin na demo profilu
 * (agent-browser, živi dev :3000, SQLite): javni rezervacijski widget /r/<token>
 * (ustvarjanje povezave prek UI, vklop, 5 jezikov, zaprt dan, zlata rezervacija
 * 19:00 → 201 + potrditev) in spletni portal /s/<token> (ustvarjanje povezave,
 * vklop, meni 16 kategorij, košarica, pošteno blokirana oddaja ob »Zaprto«).
 *
 * NAJDBA #1 (P2 — okno izbire dni drsi ob kliku): dayChips na /r/<token> so se
 * računali iz state.date = datuma ZADNJEGA strežniškega odgovora. Klik na
 * zadnji vidni dan (npr. 14. dan okna) je celotno 14-dnevno okno premaknil
 * naprej — izmerjeno: klik »Sob. 14. nov.« je prvo ponujeno dnevo prestavil
 * na 14. nov., dnevi 2.–13. nov. pa postali NEDOSEGLJIVI do osvežitve strani
 * (gost izgubi vse prejšnje dneve, vključno s tistimi, ki jih je ravnokar
 * gledal). POPRAVEK: okno je zasidrano na baseDate iz nalaganja BREZ
 * datumskega parametra (prvi load + gumb Osveži — slednji pravilno prerolja
 * sidro čez polnoč); klik dneva sidra NE spreminja. E2E DOKAZ: po popravku
 * klik »Sob. 14. nov.« pusti okvo Ned. 1. nov. → Sob. 14. nov. nespremenjeno,
 * izbrani dan pa ostane označen.
 *
 * Tu so zapečateni popravek (statika po vzorcu v219 — UI logika nima DOM
 * harnesa) + verzija + registri.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/* ── Č1 · #1 — sidro okna izbire dni (regresija) ────────────────────────── */

describe('v223 Č1 · okno izbire dni na /r/<token> ostaja zasidrano', () => {
  const page = read('src/app/r/[token]/page.tsx')

  test('dayChips se računajo iz baseDate (sidro), ne iz datuma zadnjega odgovora', () => {
    expect(page).toContain('addDaysKey(baseDate ?? state.date, i)')
    // hroščati vzorec (sidro brez zasilne vrednosti) mora biti ODSOTEN
    expect(page).not.toContain('addDaysKey(state.date, i)')
  })

  test('sidro se nastavi SAMO ob nalaganju brez datumskega parametra', () => {
    expect(page).toContain('if (!date) setBaseDate(s.date)')
    expect(page).toContain("const [baseDate, setBaseDate] = useState<string | null>(null)")
  })

  test('useMemo odvisnosti vključujejo baseDate (svežino sidra čezi render)', () => {
    expect(page).toContain('}, [state, locale, baseDate])')
  })
})

/* ── Č2 · javna plošča — poštena zaprtost (E2E predpostavke vala) ────────── */

describe('v223 Č2 · javni površini ostajata pošteni do zaprtja', () => {
  test('/s/<token> blokira oddajo naročila, ko je lokal zaprt (closedNow)', () => {
    const portal = read('src/app/s/[token]/page.tsx')
    expect(portal).toContain('closedNow ||')
  })

  test('/r/<token> za dan brez terminov pokaže besedilo, ne praznega odseka', () => {
    const resv = read('src/app/r/[token]/page.tsx')
    expect(resv).toContain("resv.public.noSlots")
  })
})

/* ── Č3 · verzija in registri ───────────────────────────────────────────── */

describe('v223 Č3 · verzija + dokumentacija', () => {
  test('verzija je dvignjena na 1.238.0 (version.ts + compose oznaka)', () => {
    expect(APP_VERSION).toBe('1.264.0')
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.264.0')
  })

  test('PRD nosi zapis QA-vala v1.227.0 (doc-truth)', () => {
    expect(read('docs/PRD-LOKALNA-BAZA.md')).toContain('QA-val v1.227.0')
  })

  test('worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.264.0-finalna-verifikacija')
  })
})
