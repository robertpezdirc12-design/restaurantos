import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_VERSION } from '../src/lib/version'

/**
 * v1.231.0 — ZAPRTJE C-SEZNAMA BENCHMARK VALA 3 (docs/PRIMERJAVA-VMESNIKOV-2026.md):
 *
 * 1. INVENTURA S ČITALNIKOM (§5 zadnja funkcionalna vrzel — zaloge 22/22;
 *    Toast Inventory »count by scan«): skener = tipkovnica (koda + Enter) v
 *    novem polju nad seznamom štetja (samo DRAFT). Točen EAN zadetek
 *    (normalizeEan obeh strani) šteje +1 na vrstici popisa; beseda = filter.
 * 2. SAMODEJNA DODELITEV MIZE REZERVACIJI (§4 — restavracija 20/22;
 *    OpenTable/Toast vzorec): gumb »Dodeli« — najmanjša prosta miza po
 *    številu oseb, brez prekrivanja z aktivnimi rezervacijami.
 * 3. P4 POPRAVEK VNOSA BLAGAJNE (QA-val #10 dokumentirano): minus in nesmisel
 *    nista več tiho sprejeta (−10 → 10; »1.2.3« → NaN → 0).
 */

const read = (p: string) => readFileSync(p, 'utf8')
const zaloga = read('src/components/tabs/zaloga-tab.tsx')
const finance = read('src/components/tabs/finance-tab.tsx')
const dash = read('src/app/dashboard/page.tsx')
const sl = read('src/lib/i18n/sl.ts')
const hr = read('src/lib/i18n/hr.ts')
const wl = read('worklog.md')
const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
const prd = read('docs/PRD-LOKALNA-BAZA.md')

describe('v1.231.0 A — inventura s čitalnikom (zaloga-tab)', () => {
  test('A1: tip StocktakeItem vrstice nosi inventoryItemId (povezava sken → vrstica popisa)', () => {
    expect(zaloga).toContain('id: string; inventoryItemId: string; name: string; unit: string; expectedQty: number')
  })

  test('A2: skener polje (koda + Enter) nad seznamom štetja, samo v DRAFT, s sidrom st-scan', () => {
    expect(zaloga).toContain('data-region="st-scan"')
    expect(zaloga).toContain("if (e.key === 'Enter') { e.preventDefault(); handleStScanEnter() }")
    expect(zaloga).toContain("stOpen.status === 'DRAFT' && (")
  })

  test('A3: EAN zadetek šteje +1 (normalizeEan obeh strani), toast potrdi, poudarek vrstice', () => {
    expect(zaloga).toContain('const norm = normalizeEan(raw)')
    expect(zaloga).toContain("items.find((it) => (it.ean || '').toUpperCase() === norm)")
    expect(zaloga).toContain("stOpen.items.find((l) => l.inventoryItemId === hit.id)")
    expect(zaloga).toContain("Number.isFinite(curNum) ? String(curNum + 1) : '1'")
    expect(zaloga).toContain("toast({ title: t('st.scanCounted', { name: hit.name, n: next }) })")
    expect(zaloga).toContain('ring-2 ring-emerald-500 border-emerald-500')
  })

  test('A4: artikel izven snapshot-a (dodan po odprtju popisa) dobi jasno opozorilo, ne tihega padca', () => {
    expect(zaloga).toContain("t('st.scanNotInTake', { name: hit.name })")
  })

  test('A5: prosta beseda = filter seznama (+ počisti gumb, iskren prazen stan s sidrom)', () => {
    expect(zaloga).toContain('setStFilter(raw)')
    expect(zaloga).toContain("t('st.filterActive', { q: stFilter })")
    expect(zaloga).toContain("t('st.filterClear')")
    expect(zaloga).toContain('data-region="st-scan-nohit"')
    expect(zaloga).toContain("t('st.scanNoHit', { q: stFilter })")
  })

  test('A6: števje ostaja lokalno do Shrani (isti PATCH pot kot ročno štetje)', () => {
    expect(zaloga).toContain('setStInputs((prev) => ({ ...prev, [line.id]: next }))')
    expect(zaloga).toContain('stAction(\'PATCH\', `/api/stocktakes/${stOpen?.id}`')
  })

  test('A7: i18n SL/HR — vsi novi st.* ključi', () => {
    for (const k of ['st.scanLabel', 'st.scanHint', 'st.scanCounted', 'st.scanNotInTake', 'st.scanNoHit', 'st.filterClear', 'st.filterActive']) {
      expect(sl).toContain(`'${k}':`)
      expect(hr).toContain(`'${k}':`)
    }
  })
})

describe('v1.231.0 B — samodejna dodelitev mize (dashboard)', () => {
  test('B1: ReservationT nosi tableId/duration/locationId (API jih je pošiljal že prej — mapa v lib/map.ts)', () => {
    /* v1.245.0 (§19): + tableIds (kombinacijske rezervacije — aditivno). */
    expect(dash).toContain('source?: string | null; tableId?: string | null; tableIds?: string[]; locationId?: string | null }')
  })

  test('B2: autoAssignTable — najmanjša miza po sedežih, brez prekrivanja aktivnih rezervacij', () => {
    expect(dash).toContain('function autoAssignTable()')
    // zavirajo samo aktivne (preklicane in »ni prišel« ne)
    expect(dash).toContain("r.status !== 'CANCELLED' && r.status !== 'NO_SHOW'")
    // okno prekrivanja = datum + trajanje obeh rezervacij
    expect(dash).toContain('const e = s + ((r.duration ?? 120) * 60_000)')
    expect(dash).toContain('return s < end && start < e')
    /* v1.245.0 (§19): iskanje kandidatov je preraslo v ČISTI helper
       seatCandidatesForParty (lib/table-combos) — enojne mize + registrirane
       kombinacije, sedeži ≥ osebe, najmanjša zmaga; isti vir delijo UI in testi. */
    expect(dash).toContain('seatCandidatesForParty({')
    expect(dash).toContain('combos: tableCombos, party: newRes.guests')
  })

  test('B3: gumb Dodeli v rezervacijskem dialogu s sidrom + namigom', () => {
    expect(dash).toContain('data-region="resv-auto-assign"')
    expect(dash).toContain('onClick={autoAssignTable}')
    expect(dash).toContain("t('resv.autoAssignHint')")
    expect(dash).toContain('<Wand2')
  })

  test('B4: brez časa rezervacije → jasen toast (ne tihega ugibanja); brez kandidata → pošteno sporočilo', () => {
    expect(dash).toContain("t('resv.autoAssignNeedTime')")
    expect(dash).toContain("t('resv.autoAssignNone', { n: newRes.guests })")
    /* v1.245.0: kandidat je SeatCandidate (label/seats) — enojna miza ali
       kombinacija (Miza 5+6); toast comboAutoOk za kombinacije. */
    expect(dash).toContain("t('resv.autoAssignOk', { table: pick.label, seats: pick.seats })")
    expect(dash).toContain("t('resv.comboAutoOk', { table: pick.label, seats: pick.seats })")
  })

  test('B5: mize v izbirniku kažejo število sedežev (podatek za odločitev)', () => {
    // QA-val v1.268.0: sedeži tečejo prek tN (množinska oblika po števniku — »2 mesti«, ne »2 mest«)
    expect(dash).toContain("{tb.name} · {tN('tables.seats', 'mesto', tb.seats)}")
  })

  test('B6: i18n SL/HR — vsi novi resv.autoAssign* ključi', () => {
    for (const k of ['resv.autoAssign', 'resv.autoAssignHint', 'resv.autoAssignNeedTime', 'resv.autoAssignNone', 'resv.autoAssignOk']) {
      expect(sl).toContain(`'${k}':`)
      expect(hr).toContain(`'${k}':`)
    }
  })
})

describe('v1.231.0 C — P4 popravek vnosa blagajne (finance-tab)', () => {
  test('C1: poskus minusa ni več tih — minus OSTANE v polju, opozorilo vztraja (sidro cash-warn)', () => {
    expect(finance).toContain("cleaned.includes('-') ? t('shifts.cashNegative') : ''")
    expect(finance).toContain('data-region="cash-warn"')
    // minus je namerno dovoljen znak (poštena povratna informacija, ne tiho brisanje)
    expect(finance).toContain(".replace(/[^-\\d.,]/g, '')")
  })

  test('C2: klient validira PRED pošiljanjem — NaN/negativno → toast, brez klica API (konec Number(cash) || 0)', () => {
    expect(finance).toContain('function parseCashInput')
    expect(finance).toContain("if (!Number.isFinite(n)) return { ok: false, n: 0, err: t('shifts.cashInvalid') }")
    expect(finance).toContain("if (n < 0) return { ok: false, n: 0, err: t('shifts.cashNegative') }")
    expect(finance).toContain('const p = parseCashInput(cash)')
    expect(finance).toContain('closingCash: p.n')
    expect(finance).toContain('openingCash: p.n')
    // hroščasta oblika iz rimskega v1.228 QA #10 je ODSOTNA
    expect(finance).not.toContain('closingCash: Number(cash) || 0')
    expect(finance).not.toContain('openingCash: Number(cash) || 0')
  })

  test('C3: strežniška validacija ostaja nespremenjena (parseDrawerCash — gotovina ne more biti negativna)', () => {
    const shiftsRoute = read('src/app/api/shifts/route.ts')
    expect(shiftsRoute).toContain('gotovina ne more biti negativna')
    expect(shiftsRoute).toContain("parseDrawerCash(body.closingCash, 'Končno gotovinsko stanje')")
  })

  test('C4: i18n SL/HR — shifts.cashNegative/cashInvalid', () => {
    for (const k of ['shifts.cashNegative', 'shifts.cashInvalid']) {
      expect(sl).toContain(`'${k}':`)
      expect(hr).toContain(`'${k}':`)
    }
  })
})

describe('v1.231.0 Ž — verzija + dokumenti + registri', () => {
  test('Ž1: verzija je dvignjena na 1.238.0 (version.ts + compose oznaka)', () => {
    expect(APP_VERSION).toBe('1.296.0')
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.296.0')
  })

  test('Ž2: dokument PRIMERJAVA nosi val v1.231.0 (zaloge 22/22, restavracija 20/22)', () => {
    expect(doc).toContain('Val v1.231.0')
    expect(doc).toContain('| Zaloge | 22/22 |')
    /* ZAVESTNA SPREMEMBA PINA (v1.233.0): dokument je ŽIV sledilnik — seštevek
       restavracije je zdaj 22/22 (overlay v1.232.0 + urejevalnik con v1.233.0);
       zgodovina vala v1.231 (§9) ostaja nedotaknjena. */
    expect(doc).toContain('| Restavracija | 22/22 |')
    expect(doc).toContain('**v1.231**')
  })

  test('Ž3: PRD §8 R4b nosi BENCHMARK-VAL v1.231.0 vrstico (doc-truth)', () => {
    expect(prd).toContain('BENCHMARK-VAL v1.231.0')
    expect(prd).toContain('INVENTURA S ČITALNIKOM')
    expect(prd).toContain('SAMODEJNA DODELITEV MIZE REZERVACIJI')
  })

  test('Ž4: worklog vrh nosi Task ID v1.231.0 nad prejšnjim valom', () => {
    expect(wl.slice(0, 400)).toContain('Task ID: v1.296.0-nadzorni-val-stabilnosti')
    expect(wl.indexOf('Task ID: v1.231.0')).toBeLessThan(wl.indexOf('Task ID: v1.230.0'))
  })
})
