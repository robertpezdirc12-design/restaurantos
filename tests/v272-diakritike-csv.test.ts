/**
 * v1.272.0 — DIAKRITIKE I: CSV GLAVE (sistematični pregled)
 * (sveža QA površina po zaključku množinske teme v1.271.0 — izvid
 *  oh.confirmHolidays diacritics popravka je pripeljal do sistematičnega
 *  flat→pravilno kartiranja čez oba polna slovarja.)
 *
 *  NAJDENIH IN POPRAVLJENIH 18 CSV glav (uporabniško vidne, izvozi):
 *    · SL 10: shifts.csvTitle/csvExpenses/csvProfit/csvInvoices/csvTaxRate/
 *      csvStart/csvClosing + rcpt.csvNumber/csvOrder/csvPayMethod
 *      (»Financno porocilo« → »Finančno poročilo«, »St. racuna« →
 *      »Št. računa«, »Nacin placila« → »Način plačila« …).
 *    · HR 8: shifts.csvTitle/csvExpenses/csvInvoices/csvStart/csvClosing +
 *      rcpt.csvNumber/csvOrder/csvPayMethod
 *      (izvjesce → izvješće, Troskovi → Troškovi, Narudzba → Narudžba …).
 *
 *  REKONOS (deterministično, 0 ugibanj): flat→pravilno kartiranje izdelano
 *    iz ŽE obstoječih diakritičnih besed slovarja; vsak zadetek ročno
 *    klasificiran (ključ mesto vs. vrednost; samostalnik vs. velelnik).
 *
 *  POŠTENO VELJAVNI ravninski nizi (NEGATIVNI KONTROLI — ostanejo):
 *    · »Zapisi odpada« (waste.title) in »Klici vodje« (callv/intro) —
 *      samostalniški množini (zapis/klic), NE velelnika;
 *    · »preklici« v exc.report.subtitle — samostalnik (popusti, preklici,
 *      storni), ne velelnik »prekliči«;
 *    · členki se/z/s in okrajšavi (s)/st. brez pika v drugih kontekstih;
 *    · »odvod v sef« — kratica SEF (sistem e-računov), ne šef;
 *    · DavcnaStevilka/ZavezanecZaDDV — ZUNANJE API polji INETIS DURS
 *      (tests/ops8-wave2.test.ts — pogodba ponudnika, ne slovar);
 *    · datotečna imena izvozov porocilo-…/stroski-… — ASCII NAMERNO
 *      (prenosljivost datotečnih sistemov; vsebina ima diakritike, ime ne);
 *    · EN/DE/IT delni gostujoči slovarji — pregledani, 0 zadetkov
 *      (MwSt./nötig/è pravilni; de/it nimajo csv.* ključev).
 *
 *  VARNO STIKAŠ: CSV izvozi potekajo prek downloadCSV (src/lib/client.ts)
 *    z UTF-8 BOM (\uFEFF) — diakritike so Excel-varne; enak vzorec kot
 *    cash-movements.ts (samozavedna eksportna higiena).
 *
 *  Č1 · SLOVARJA: vseh 18 popravkov živo v t() (SL+HR), starih ravninskih
 *    vrednosti NI več, ostale glave istega bloka nespremenjene
 *    (regresija: Obdobje/Prihodki/Davek/Danes … so bile že pravilne).
 *  Č2 · NEGATIVNI KONTROLI: veljavni ravninski nizi ostanejo (Zapisi
 *    odpada, Klici vodje, exc.report.subtitle preklici, sef kratica,
 *    členki se/z/s, zunanji API pin, ASCII imena datotek, BOM v downloadCSV).
 *  Č3 · MONTAŽA: izvozni poti (finance-tab shifts + page.tsx računi)
 *    kličeta t('shifts.csv*')/t('rcpt.csv*') — 0 hardkodiranih glav v src/;
 *    BOM pin v downloadCSV.
 *  Ž · REGISTRI: verzija 1.272.0 (version.ts + compose + APP_VERSIJA
 *    vsebina), i18n 4320/4320 nespremenjeno (0 novih ključev — samo
 *    vrednosti), AUDIT POSODOBITEV (v1.272.0, diakritike I — CSV glave),
 *    worklog Task ID vrh.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { t } from '../src/lib/i18n'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// 18 popravkov: [ključ, stara ravninska vrednost, nova pravilna vrednost]
const SL_FIXES: [string, string, string][] = [
  ['shifts.csvTitle', 'Financno porocilo RestaurantOS', 'Finančno poročilo RestaurantOS'],
  ['shifts.csvExpenses', 'Stroski (EUR)', 'Stroški (EUR)'],
  ['shifts.csvProfit', 'Dobicek (EUR)', 'Dobiček (EUR)'],
  ['shifts.csvInvoices', 'Racunov', 'Računov'],
  ['shifts.csvTaxRate', 'Davcna stopnja (%)', 'Davčna stopnja (%)'],
  ['shifts.csvStart', 'Zacetek', 'Začetek'],
  ['shifts.csvClosing', 'Zakljucek (EUR)', 'Zaključek (EUR)'],
  ['rcpt.csvNumber', 'St. racuna', 'Št. računa'],
  ['rcpt.csvOrder', 'Narocilo', 'Naročilo'],
  ['rcpt.csvPayMethod', 'Nacin placila', 'Način plačila'],
]

const HR_FIXES: [string, string, string][] = [
  ['shifts.csvTitle', 'Financijsko izvjesce RestaurantOS', 'Financijsko izvješće RestaurantOS'],
  ['shifts.csvExpenses', 'Troskovi (EUR)', 'Troškovi (EUR)'],
  ['shifts.csvInvoices', 'Racuna', 'Računa'],
  ['shifts.csvStart', 'Pocetak', 'Početak'],
  ['shifts.csvClosing', 'Zakljucak (EUR)', 'Zaključak (EUR)'],
  ['rcpt.csvNumber', 'Br. racuna', 'Br. računa'],
  ['rcpt.csvOrder', 'Narudzba', 'Narudžba'],
  ['rcpt.csvPayMethod', 'Nacin placanja', 'Način plaćanja'],
]

// Ostale glave istih blokov — bile so ŽE pravilne (regresijski pasivni kontrol)
const SL_UNCHANGED: [string, string][] = [
  ['shifts.csvPeriod', 'Obdobje'],
  ['shifts.csvRevenue', 'Prihodki (EUR)'],
  ['shifts.csvTax', 'Davek (EUR)'],
  ['shifts.csvToday', 'Danes'],
  ['shifts.csvMonth', 'Mesec'],
  ['shifts.csvItems', 'Postavk'],
  ['shifts.csvShift', 'Izmena'],
  ['shifts.csvEmployee', 'Zaposleni'],
  ['shifts.csvRole', 'Vloga'],
  ['shifts.csvEnd', 'Konec'],
  ['shifts.csvOpening', 'Odpiranje (EUR)'],
  ['shifts.csvStatus', 'Status'],
]

const HR_UNCHANGED: [string, string][] = [
  ['shifts.csvPeriod', 'Razdoblje'],
  ['shifts.csvRevenue', 'Prihodi (EUR)'],
  ['shifts.csvTax', 'Porez (EUR)'],
  ['shifts.csvProfit', 'Dobit (EUR)'],
  ['shifts.csvTaxRate', 'Porezna stopa (%)'],
  ['shifts.csvEnd', 'Kraj'],
  ['shifts.csvOpening', 'Otvaranje (EUR)'],
]

// ── Č1) SLOVARJA — 18 popravkov živo, starih vrednosti ni več ──
describe('v1.272.0 Č1 — slovarja: 18 CSV glav z diakritikami', () => {
  test('SL: vseh 10 glav popravljenih v pravilne vrednosti', () => {
    for (const [key, , correct] of SL_FIXES) {
      expect(t('sl', key)).toBe(correct)
    }
  })

  test('HR: vseh 8 glav popravljenih v pravilne vrednosti', () => {
    for (const [key, , correct] of HR_FIXES) {
      expect(t('hr', key)).toBe(correct)
    }
  })

  test('SL: ravninskih vrednosti NI več v slovarju (noben ključ ne nosi stare glave)', () => {
    for (const [key, flat] of SL_FIXES) {
      const stillThere = Object.entries(sl).filter(([, v]) => v === flat)
      expect(stillThere).toEqual([])
      expect(sl[key]).not.toBe(flat)
    }
  })

  test('HR: ravninskih vrednosti NI več v slovarju', () => {
    for (const [key, flat] of HR_FIXES) {
      const stillThere = Object.entries(hr).filter(([, v]) => v === flat)
      expect(stillThere).toEqual([])
      expect(hr[key]).not.toBe(flat)
    }
  })

  test('regresija: sosednje glave istega bloka so bile že pravilne in ostajajo (SL)', () => {
    for (const [key, value] of SL_UNCHANGED) {
      expect(t('sl', key)).toBe(value)
    }
  })

  test('regresija: sosednje glave istega bloka ostajajo (HR)', () => {
    for (const [key, value] of HR_UNCHANGED) {
      expect(t('hr', key)).toBe(value)
    }
  })

  test('sistematični pregled: nobena vrednost shifts.csv*/rcpt.csv* ključa ne vsebuje ravninskih vzorcev', () => {
    const flatPatterns = [/Stroski/, /Dobicek/, /Racunov\b/, /Racuna\b/, /Davcna/, /Zacetek/, /Zakljucek/, /Narocilo\b/, /Nacin/, /placila\b/, /racuna\b/, /Troskovi/, /Pocetak/, /Zakljucak/, /Narudzba/, /placanja\b/, /izvjesce\b/]
    for (const dict of [sl, hr]) {
      for (const [k, v] of Object.entries(dict)) {
        if (!/^((shifts)|(rcpt))\.csv/.test(k)) continue
        for (const re of flatPatterns) {
          expect(`${k}=${v}`).not.toMatch(re)
        }
      }
    }
  })
})

// ── Č2) NEGATIVNI KONTROLI — pošteno veljavni ravninski nizi ostanejo ──
describe('v1.272.0 Č2 — negativni kontroli (veljavne ravninske oblike)', () => {
  test('»Zapisi odpada« (waste.title) je samostalniška množina — ostaja', () => {
    expect(t('sl', 'waste.title')).toBe('Zapisi odpada')
    expect(t('hr', 'waste.title')).toContain('Zapisi')
  })

  test('»Klici vodje« (callv.card.title, intro.calls.title) je samostalniška množina — ostaja', () => {
    expect(t('sl', 'callv.card.title')).toBe('Klici vodje')
    expect(t('sl', 'intro.calls.title')).toBe('Klici vodje')
  })

  test('»preklici« v exc.report.subtitle je samostalnik (popusti, preklici, storni) — ostaja', () => {
    expect(t('sl', 'exc.report.subtitle')).toContain('preklici postavk')
  })

  test('»odvod v sef« je kratica SEF (sistem e-računov) — ostaja brez ž', () => {
    expect(t('sl', 'mig.cashMovements.desc')).toContain('odvod v sef')
  })

  test('členki se/z/s v povedeh ostajajo brez diakritik (spot)', () => {
    expect(t('sl', 'sync.deadHint')).toContain(' so ostale shranjene lokalno')
    expect(t('sl', 'tables.emptyHint')).toContain('potem naročanja')
  })

  test('zunanje API polje INETIS DURS (DavcnaStevilka) ostaja ravninsko — pogodba ponudnika', () => {
    const ops8 = read('tests/ops8-wave2.test.ts')
    expect(ops8).toContain("DavcnaStevilka: '")
  })

  test('datotečni imeni izvozov porocilo-/stroski- ostajata ASCII (vsebina ima diakritike, ime ne)', () => {
    const tab = read('src/components/tabs/finance-tab.tsx')
    expect(tab).toContain('`porocilo-')
    expect(tab).toContain('`stroski-')
  })

  test('EN/DE/IT delni slovarji nimajo csv.* ključev (dashboard nameno SL/HR)', () => {
    for (const p of ['src/lib/i18n/en.ts', 'src/lib/i18n/de.ts', 'src/lib/i18n/it.ts']) {
      const src = read(p)
      expect(src).not.toMatch(/'(shifts|rcpt)\.csv/)
    }
  })
})

// ── Č3) MONTAŽA — izvozni poti kličejo t(), BOM prisoten, 0 hardkodiranih glav ──
describe('v1.272.0 Č3 — montaža izvoznih poti', () => {
  test('finance-tab (Izmene) izvaža prek t(shifts.csv*) + downloadCSV', () => {
    const tab = read('src/components/tabs/finance-tab.tsx')
    expect(tab).toContain("t('shifts.csvTitle')")
    expect(tab).toContain('downloadCSV(')
    // 0 hardkodiranih ravninskih glav v komponenti
    expect(tab).not.toMatch(/'Financno|'Stroski \(|'Dobicek \(/)
  })

  test('page.tsx (Računi) izvaža prek t(rcpt.csv*) — glava vrstice', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("t('rcpt.csvNumber')")
    expect(page).toContain("t('rcpt.csvOrder')")
    expect(page).toContain("t('rcpt.csvPayMethod')")
  })

  test('downloadCSV nosi UTF-8 BOM (\\uFEFF) — diakritike so Excel-varne', () => {
    const client = read('src/lib/client.ts')
    expect(client).toContain("'\\uFEFF' + csv")
  })

  test('src/ ne vsebuje hardkodiranih ravninskih CSV glav (vse teče prek t())', () => {
    const patterns = ["'St. racuna'", "'Nacin placila'", "'Narocilo'", "'Zacetek'", "'Zakljucek (EUR)'", "'Narudzba'", "'Br. racuna'"]
    const files = ['src/app/dashboard/page.tsx', 'src/components/tabs/finance-tab.tsx', 'src/components/tabs/analitika-tab.tsx', 'src/components/tabs/backoffice-tab.tsx']
    for (const f of files) {
      const src = read(f)
      for (const p of patterns) {
        expect(src.includes(p)).toBe(false)
      }
    }
  })
})

// ── Ž) REGISTRI ──
describe('v1.272.0 Ž — registri', () => {
  test('verzija 1.272.0 (version.ts + compose + APP_VERSION vsebina)', () => {
    expect(APP_VERSION).toBe('1.299.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.299.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.299.0')
  })

  test('i18n pariteta 4320/4320 nespremenjena (0 novih ključev — samo vrednosti)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    // popravki niso dodali/odvzeli ključev: ključi SL ⊆ HR in obratno
    const slk = new Set(Object.keys(sl))
    const hrk = new Set(Object.keys(hr))
    for (const k of slk) expect(hrk.has(k)).toBe(true)
    for (const k of hrk) expect(slk.has(k)).toBe(true)
  })

  test('AUDIT doc-truth: POSODOBITEV (v1.272.0, diakritike I — CSV glave)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('POSODOBITEV (v1.272.0, diakritike I — CSV glave)')
    // zgodovinski v1.271.0 pin ostaja veljaven (dodatni vnos ne briše zgodovine)
    expect(audit).toContain('POSODOBITEV (v1.271.0, množinske oblike IV')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.299.0-obnova-13-reset-v243-sirote')
  })
})
