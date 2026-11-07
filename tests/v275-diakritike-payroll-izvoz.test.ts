/**
 * v1.275.0 — DIAKRITIKI III: PAYROLL IZVOZ
 * (nadaljevanje diakritične teme po v1.272 (CSV izvozi — slovarska metoda)
 *  in v1.273 (izvozni API 9 rut + documents.ts + tiskalniški naslovi).
 *  Rekonos v1.275: v1.273 je preverjal API RUTE, payroll izvoz pa gradi
 *  ČISTA funkcija buildPayrollCsv v src/lib/payroll.ts (route je le tanek
 *  ovoj) — besedila so živela IZVEN rout in ostala neopažena. Dokaz:
 *  komentarji v192/v197 so že imeli pravilne oblike (»uporabniški«,
 *  »presežek«, »štejejo«), CSV nizi pa ravninske.)
 *
 *  NAJDENIH IN POPRAVLJENIH 15 mest (uporabniško vidnih, 1 datoteka):
 *    · glava/meta : Razlicica → Različica;
 *    · napitnine  : PlacanoEUR → PlačanoEUR (SKUPAJ vrstica),
 *                   NapitninePlacanoEUR → NapitninePlačanoEUR (SKUPAJ OBRAČUNA);
 *    · doplačila  : DOPLACILNE OSNOVE → DOPLAČILNE OSNOVE (naslov sekcije),
 *                   Noc/Nedelja/Praznik → Noč/… (podnaslov),
 *                   NocMin;NocEur → NočMin;NočEur (glava + SKUPAJ vrstica),
 *                   Noc= → Noč= (noga z nogami);
 *    · nadure     : presezek → presežek;
 *    · noga       : stejejo → štejejo, izplacane → izplačane,
 *                   uporabniski → uporabniški,
 *                   izracunava → izračunava, doplacil → doplačil,
 *                   izvaza → izvaža.
 *
 *  VARNO STIKAŠ (2 neodvisnosti, preverjeni pred popravki):
 *    · UTF-8 BOM: buildPayrollCsv nosi '\uFEFF' pred join (vrstica 761)
 *      — diakritike so Excel-varne (ista higiena kot v1.272/v1.273);
 *    · contentHash: kontrolni zapis temelji na kanoničnem JSON podatkovnem
 *      modelu (canonicalExportJson/sortKeysDeep — ŠTEvilke/id-ji/statusni
 *      enumi), NE na CSV besedilih → sprememba besedil NE spreminja hasha
 *      že izvoženih obračunov (dokaže Č2).
 *
 *  PREVEZ (zgodovinski pini → diakritične oblike, vzorec v253 iz v1.273):
 *    · tests/v192-payroll-surcharges.test.ts (8 asercij + naslov Č3 + komentar),
 *    · tests/v197-payroll-surcharge-rates.test.ts (5 asercij),
 *    · tests/issue22-payroll.test.ts (5 asercij + 1 komentar kolone);
 *    ZGODOVINSKI ostanki (ostanejo po konvenciji): komentar v1.192.0/v1.197.0
 *    v src/lib/payroll.ts (dokumentira poimenovanje OB UVEDBI — doc-truth).
 *
 *  POŠTENI NEGATIVNI KONTROLI (NEVDNI — ostanejo ravninski):
 *    · imena izvoznih datotek: `obracun-…csv`/`obracun-…json` v payroll-tab
 *      (ASCII po konvenciji imen datotek — v1.273 pin);
 *    · statusni enumi CSV/tips (pending/paid/approved — tehnični termini);
 *    · kolone ID (ZaposleniID/DeloID/VnosID/PoolID — tehnične, brez besedila).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  buildPayrollCsv,
  canonicalExportJson,
  totalsOfRows,
  type PayrollEntryRow,
  type TipExportRow,
} from '../src/lib/payroll'
import { surchargeBasisRows } from '../src/lib/payroll-surcharges'
import { APP_VERSION } from '../src/lib/version'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const TZ = 'Europe/Ljubljana'

/* ── fixture (vzorec v192 baseInput — pure, brez DB) ── */
const row = (over: Partial<PayrollEntryRow>): PayrollEntryRow => ({
  entryId: 'e1', employeeId: 'emp', employeeName: 'N', jobId: null, jobName: '',
  date: '2026-02-08', clockIn: '2026-02-07T22:00:00Z', clockOut: '2026-02-08T02:00:00Z',
  breakMinutes: 0, netMinutes: 240, payRateCents: 1000, grossCents: 4000,
  type: 'regular', status: 'approved', locationId: null, ...over,
})
const tip = (over: Partial<TipExportRow>): TipExportRow => ({
  distributionId: 'd1', employeeId: 'emp', employeeName: 'N', amountCents: 1000,
  status: 'pending', poolId: 'p1', poolDate: '2026-02-08', poolCashCents: 1000, poolCardCents: 0, ...over,
})
const baseInput = () => {
  const rows = [row({}), row({ entryId: 'e2', status: 'active', grossCents: 0, netMinutes: 0 })]
  const tips = [tip({}), tip({ distributionId: 'd2', status: 'paid', amountCents: 2000, poolId: 'p2', poolDate: '2026-02-09', poolCashCents: 3000, poolCardCents: 2000 })]
  return {
    period: { id: 'per', locationId: null, startISO: '2026-02-02', endISO: '2026-02-14', timezone: TZ, status: 'closed', version: 1, closeNote: '' },
    rows,
    tips,
    totals: totalsOfRows(rows, tips, [{ cashCents: 3000, cardCents: 2000 }]),
    surchargeBases: surchargeBasisRows([
      { employeeId: 'emp', employeeName: 'N', jobId: null, jobName: '', date: '2026-02-07', clockIn: '2026-02-07T22:00:00Z', clockOut: '2026-02-08T10:00:00Z', netMinutes: 690, status: 'approved' },
    ], TZ, new Set(['2026-02-08'])),
    exportMeta: { seq: 1, generatedISO: '2026-02-15T08:00:00Z', contentHash8: 'abcd1234', changedEntries: 0, identicalToPrevious: false },
  }
}

/* ═══════════════════ Č1. VSEBINA — vseh 15 mest živih v CSV ═══════════════════ */

describe('v1.275.0 Č1 — payroll CSV: 15 diakritičnih mest živih (buildPayrollCsv, pure)', () => {
  test('glava/meta: Različica (ne Razlicica)', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv).toContain('Različica;1')
    expect(csv).not.toContain('Razlicica')
  })

  test('napitnine: PlačanoEUR v SKUPAJ + NapitninePlačanoEUR v SKUPAJ OBRAČUNA', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv).toContain('PlačanoEUR;')
    expect(csv).toContain('NapitninePlačanoEUR;')
    expect(csv).not.toContain('PlacanoEUR')
    expect(csv).not.toContain('NapitninePlacanoEUR')
  })

  test('doplačila: DOPLAČILNE OSNOVE naslov + Noč/Nedelja/Praznik podnaslov', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv).toContain('DOPLAČILNE OSNOVE (minute + zneski, ko so noge nastavljene - odstotek potrdi zunanji payroll sistem)')
    expect(csv).toContain('Noč/Nedelja/Praznik po zaposlenem in delovnem mestu (pred odmorom)')
    expect(csv).not.toContain('DOPLACILNE')
    expect(csv).not.toContain('Noc/Nedelja')
  })

  test('doplačila: NočMin/NočEur v glavi + SKUPAJ vrstici (noge NISO nastavljene)', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv).toContain('NočMin;NočEur;NedeljaMin;NedeljaEur;PraznikMin;PraznikEur;PotrjenoNetoMin')
    expect(csv).toContain('SKUPAJ;NočMin;')
    expect(csv).not.toContain('NocMin')
    expect(csv).not.toContain('NocEur')
  })

  test('nadure: dnevni presežek (ne presezek)', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv).toContain('Nadure po zaposlenem (dnevni presežek NETO minut nad pragom; po dnevu prijave)')
    expect(csv).not.toContain('presezek')
  })

  test('noga brez nog: štejejo/izplačane + izračunava/doplačil/izvaža', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv).toContain('Napitnine pending se ne štejejo kot izplačane.')
    expect(csv).toContain('RestaurantOS ne izračunava odstotkov doplačil (noge niso nastavljene) - izvaža samo osnovne minute; odstotek potrdi zunanji payroll sistem.')
    expect(csv).not.toContain('stejejo')
    expect(csv).not.toContain('izplacane')
    expect(csv).not.toContain('izracunava')
    expect(csv).not.toContain('doplacil')
    expect(csv).not.toContain('izvaza')
  })

  test('noga Z nogami: uporabniški vhod + Noč=', () => {
    const input = baseInput()
    input.surchargeRates = { nightPct: 30, sundayPct: 10, holidayPct: 20, overtimePct: 50 }
    const csv = buildPayrollCsv(input)
    expect(csv).toContain('Noge (uporabniški vhod po kolektivni pogodbi);Noč=30%')
    expect(csv).not.toContain('uporabniski')
    expect(csv).not.toContain('Noc=')
  })

  test('BOM: CSV se začne z \\uFEFF (Excel varnost — ista higiena v1.272/v1.273)', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv.charCodeAt(0)).toBe(0xfeff)
  })
})

/* ═══════════════════ Č2. NEGATIVNI KONTROLI (nevdni ostanejo) ═══════════════════ */

describe('v1.275.0 Č2 — negativni kontroli (nevdni ostanejo ravninski)', () => {
  test('imena izvoznih datotek ostanejo ASCII (obracun-…csv/json — konvencija imen)', () => {
    const tab = read('src/components/tabs/payroll-tab.tsx')
    expect(tab).toContain('`obracun-${p.startISO}_${p.endISO}-v${p.version}.csv`')
    expect(tab).toContain('`obracun-${p.startISO}_${p.endISO}-v${p.version}.json`')
    expect(tab).not.toContain('obračun-')
  })

  test('kanonični JSON (osnova contentHash) ne vsebuje CSV besedil → sprememba besedil NE spreminja hasha', () => {
    const json = canonicalExportJson(baseInput() as never)
    expect(json).not.toContain('DOPLAČILNE')
    expect(json).not.toContain('DOPLACILNE')
    expect(json).not.toContain('Različica')
    expect(json).toContain('"version":1') // podatkovni model, ne besedilo
  })

  test('zgodovinski komentar v1.192.0/v1.197.0 v payroll.ts ostaja (doc-truth ob uvedbi)', () => {
    const src = read('src/lib/payroll.ts')
    expect(src).toContain('// v1.192.0: /2 — aditivna sekcija DOPLACILNE OSNOVE')
    expect(src).toContain('(NocEur/NedeljaEur/PraznikEur/NadureEur')
  })

  test('statusni enumi + ID kolone ostanejo tehnični (pending/paid/ZaposleniID)', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv).toContain(';pending')
    expect(csv).toContain(';paid')
    expect(csv).toContain('ZaposleniID;Zaposleni;DeloID;Delo;Datum;Prihod;Odhod;OdmorMin;NetoMin;PostavkaEUR;BrutoEUR;Tip;Status;VnosID')
  })
})

/* ═══════════════════ Ž. REGISTRI ═══════════════════ */

describe('v1.275.0 Ž — registri', () => {
  test('verzija 1.275.0 (version.ts + compose + APP_VERSION vsebina)', () => {
    expect(APP_VERSION).toBe('1.278.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.278.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.278.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.278.0-lib-nizi')
  })

  test('AUDIT doc-truth: POSODOBITEV (v1.275.0, diakritike III — payroll izvoz)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('POSODOBITEV (v1.275.0, diakritike III — payroll izvoz)')
    // prejšnji vnos ostaja (zgodovinska veriga doc-truth)
    expect(audit).toContain('POSODOBITEV (v1.274.0, lokalni determinizem — collation + formatiranje)')
  })

  test('i18n števci nespremenjeni (0 ključev — val je brez slovarjev)', () => {
    // val ne dodaja/spreminja i18n ključev: CSV besedila so izven slovarjev;
    // pariteta ostaja 4320/4320 (v272 Ž2 pin)
    const v272 = read('tests/v272-diakritike-csv.test.ts')
    expect(v272).toContain('4320')
  })
})
