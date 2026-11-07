/**
 * v1.268.0 — QA/POLISH VAL: NOGA PLOŠČICE MIZE + MNOŽINSKE OBLIKE
 * (raziskovalno okno Vol 17 prazno do pomladi 2027; B-kandidati čakajo
 * lastnika; po dnevniku v1.267.0 → QA/polish pregled odprtih zavihkov).
 *
 * Rekonos (demo baza, agent-browser, 33 zavihkov + 4 samostojni zasloni +
 * dialogi + temni način + SL/HR preklop + ukazna paleta — VSE brez napak
 * v konzoli) je ulovil DVE realni najdbi; vse VLM-vizualne zaznave so bile
 * preverjene z DOM-izmerami (4 od 5 lažno pozitivnih — heatmapa ima redke
 * podatke, »ni še podatkov« pripada Klicem vodje, KDS spodnja vrstica ne
 * prekriva (875 < 891), stranska navigacija je drsljiva po zasnovi):
 *
 *  NAJDBA A (vizualna/logična): ploščica mize FIKSNA višina h-32 (128 px)
 *    z overflow-hidden je obrezovala NOGO (mt-auto spodaj) pri polni
 *    zasedeni kartici z 👤 natakarjem (izmera scrollHeight 144 >
 *    clientHeight 128; VLM potrditev na temnem načinu). Nogov status je
 *    bil za zasedene/rezervirane mize ČISTI dvojnik telesa (tileStatusL
 *    zgoraj) — polnil je višino in obrezoval 👤/⏱ vrstici.
 *    POPRAVEK: h-32 → h-36 (fiksna višina VSEH stanj ohranjena — Issue
 *    #74 V-12) + noga nosi status SAMO kjer je unikaten (FREE: edini
 *    status na ploščici; DIRTY: navodilo klika); usajeni gost ostane
 *    SAMO v telesu (QA-val v1.220.0 — nogova kopija umaknjena).
 *
 *  NAJDBA B (i18n): množinske oblike samostalnikov so bile trdo kodirane
 *    v rodilniku množine (»4 mest«, »2 artiklov«, »3 računov« — SL pozna
 *    ednino/dvojino/množino/rodilnik; HR paucal 2–4). POPRAVEK: nounKey
 *    čisti pomočnik (vzorec wlParty — sedaj skupen) + 20 samostalniških
 *    ključev (5 samostalnikov × 4 oblike × SL+HR, popolna pariteta:
 *    mesto/artikel/račun/obisk/točka; HR terminologija mjesto/artikl/
 *    račun/posjet/bod) + tN v I18n kontekstu + 8 predlogov pretvorjenih
 *    v »{n} {w}« + vsa klicna mesta (dashboard, tablica, handheld,
 *    gostinske-ops, CRM, finance, backoffice, gostje).
 *    ISKRENO: dash.paidTodayInfo je osirotel ključ (brez klicnih mest —
 *    pretvorba neškodljiva, prihodnji klicniki dobijo pravo obliko);
 *    shifts.todayDetail brez podatkov zdaj iskreno »—« (prej »— računov ·
 *    davek —«); preostali »{n} X« ključi (hh.unpaidWarn — glagolska
 *    soglasnost; crm.segments.eligible — pridevnik) ostajajo pošteno
 *    zapisani kot vzorec prihodnjih valov.
 *
 *  Č1 · ČISTI SLOJ (nounKey): veje 1/2/3–4/5+, |negativ|, decimalne
 *    trunc, NaN/Infinity varno.
 *  Č2 · tN + SLOVARJA: oblike po števniku SL (dvojina!) in HR (paucal),
 *    terminologija bod/posjet, predloga z dodatnimi spremenljivkami
 *    (shifts.todayDetail), montaža vseh klicnih mest, brez ostankov
 *    starih klicev.
 *  Č3 · PLOŠČICA (FIX A): h-36 vseh stanj, nogov pogojni status, gost
 *    samo v telesu, 🔒 izraz pinned (issue70 nosi izrazni pin).
 *  Ž · REGISTRI: verzija 1.268.0, i18n 4320/4320 (+20 ključev),
 *    worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { nounKey, t } from '../src/lib/i18n'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) ČISTI SLOJ (nounKey) ──

describe('v1.268.0 Č1 — nounKey (čisti sloj)', () => {
  test('veje po števniku: 1 → .1, 2 → .2, 3–4 → .34, 5+ → .n', () => {
    expect(nounKey('mesto', 1)).toBe('noun.mesto.1')
    expect(nounKey('mesto', 2)).toBe('noun.mesto.2')
    expect(nounKey('mesto', 3)).toBe('noun.mesto.34')
    expect(nounKey('mesto', 4)).toBe('noun.mesto.34')
    expect(nounKey('mesto', 5)).toBe('noun.mesto.n')
    expect(nounKey('mesto', 100)).toBe('noun.mesto.n')
    expect(nounKey('mesto', 0)).toBe('noun.mesto.n')
  })

  test('|negativ| — števec nikoli ne pade v negativno vejo', () => {
    expect(nounKey('mesto', -1)).toBe('noun.mesto.1')
    expect(nounKey('mesto', -3)).toBe('noun.mesto.34')
    expect(nounKey('mesto', -7)).toBe('noun.mesto.n')
  })

  test('decimalne vrednosti trunc (2,9 oseba → dvojina, ne množina)', () => {
    expect(nounKey('mesto', 2.9)).toBe('noun.mesto.2')
    expect(nounKey('mesto', 4.7)).toBe('noun.mesto.34')
    expect(nounKey('mesto', 1.2)).toBe('noun.mesto.1')
  })

  test('NaN/Infinity varno → rodilnik množine (nikoli ne vrže)', () => {
    expect(nounKey('mesto', Number.NaN)).toBe('noun.mesto.n')
    expect(nounKey('mesto', Number.POSITIVE_INFINITY)).toBe('noun.mesto.n')
  })
})

// ── Č2) tN + SLOVARJA ──

/** tN brez Reacta — enaka sestava kot I18nProvider (w = t(nounKey(...))). */
function tN(locale: 'sl' | 'hr', key: string, noun: string, n: number, vars?: Record<string, string | number>): string {
  return t(locale, key, { n, w: t(locale, nounKey(noun, n)), ...vars })
}

describe('v1.268.0 Č2 — tN oblike po števniku', () => {
  test('SL mesto: 1 mesto · 2 mesti · 4 mesta · 6 mest (dvojina!)', () => {
    expect(tN('sl', 'tables.seats', 'mesto', 1)).toBe('1 mesto')
    expect(tN('sl', 'tables.seats', 'mesto', 2)).toBe('2 mesti')
    expect(tN('sl', 'tables.seats', 'mesto', 4)).toBe('4 mesta')
    expect(tN('sl', 'tables.seats', 'mesto', 6)).toBe('6 mest')
  })

  test('HR mjesto: 1 mjesto · 2 mjesta · 4 mjesta · 6 mjesta (paucal, brez dvojine)', () => {
    expect(tN('hr', 'tables.seats', 'mesto', 1)).toBe('1 mjesto')
    expect(tN('hr', 'tables.seats', 'mesto', 2)).toBe('2 mjesta')
    expect(tN('hr', 'tables.seats', 'mesto', 4)).toBe('4 mjesta')
    expect(tN('hr', 'tables.seats', 'mesto', 6)).toBe('6 mjesta')
  })

  test('SL artikel: 1 artikel · 2 artikla · 4 artikli · 5 artiklov (kategorije menija)', () => {
    expect(tN('sl', 'menu.catCount', 'artikel', 1)).toBe('1 artikel')
    expect(tN('sl', 'menu.catCount', 'artikel', 2)).toBe('2 artikla')
    expect(tN('sl', 'menu.catCount', 'artikel', 4)).toBe('4 artikli')
    expect(tN('sl', 'menu.catCount', 'artikel', 5)).toBe('5 artiklov')
    expect(tN('sl', 'dost.itemsCount', 'artikel', 3)).toBe('3 artikli')
  })

  test('SL račun/obisk/točka — vse štiri oblike', () => {
    expect(tN('sl', 'shifts.todayDetail', 'racun', 3, { tax: '2,00 €' })).toBe('3 računi · davek 2,00 €')
    expect(tN('sl', 'crm.guests.visits', 'obisk', 2)).toBe('2 obiska')
    expect(tN('sl', 'payment.pointsOf', 'tocka', 1)).toBe('1 točka')
    expect(tN('sl', 'loy.visitsSuffix', 'tocka', 5)).toBe('5 točk skupaj')
  })

  test('HR terminologija: točka → bod, obisk → posjet (ISTI ID ključa)', () => {
    expect(tN('hr', 'payment.pointsOf', 'tocka', 1)).toBe('1 bod')
    expect(tN('hr', 'payment.pointsOf', 'tocka', 2)).toBe('2 boda')
    expect(tN('hr', 'payment.pointsOf', 'tocka', 5)).toBe('5 bodova')
    expect(tN('hr', 'crm.guests.visits', 'obisk', 3)).toBe('3 posjeta')
    expect(tN('hr', 'loy.visitsSuffix', 'tocka', 7)).toBe('7 bodova ukupno')
  })

  test('montaža: vsa klicna mesta uporabljajo tN (8 datotek, 0 ostankov starih klicev)', () => {
    const dash = read('src/app/dashboard/page.tsx')
    expect(dash).toContain("tN('tables.seats', 'mesto', tb.seats)")
    expect(dash).toContain("tN('menu.catCount', 'artikel', g.items.length)")
    expect(dash).toContain("tN('payment.pointsOf', 'tocka', loyaltySel.pointsBalance)")
    for (const f of [
      'src/app/tablica/page.tsx',
      'src/app/handheld/page.tsx',
      'src/components/tabs/gostinske-ops-tab.tsx',
      'src/components/tabs/crm-tab.tsx',
      'src/components/tabs/finance-tab.tsx',
      'src/components/tabs/backoffice-tab.tsx',
      'src/components/tabs/gostje-tab.tsx',
    ]) {
      const s = read(f)
      expect(s).toContain('tN(')
      // stari klici z { n } brez { w } so ZDAJ prepovedani za pretvorjene predloge
      expect(s).not.toMatch(/t\('(tables\.seats|menu\.catCount|shifts\.todayDetail|crm\.guests\.visits|payment\.pointsOf|loy\.visitsSuffix|dost\.itemsCount)',/)
    }
  })

  test('I18nProvider ponuja tN (kontekst + privzeta vrednost)', () => {
    const c = read('src/components/i18n.tsx')
    expect(c).toContain('tN: (key: string, noun: string, n: number')
    expect(c).toContain("tN: (key, noun, n, vars) => coreT(locale, key, { n, w: coreT(locale, nounKey(noun, n)), ...vars })")
    expect(c).toContain('nounKey')
  })

  test('predloge so »{n} {w}« v OBEH slovarjih (8 predlogov)', () => {
    for (const k of [
      'tables.seats', 'menu.catCount', 'dash.paidTodayInfo', 'shifts.todayDetail',
      'crm.guests.visits', 'payment.pointsOf', 'loy.visitsSuffix', 'dost.itemsCount',
    ]) {
      expect(sl[k]).toContain('{n} {w}')
      expect(hr[k]).toContain('{n} {w}')
    }
    // rodilniške oblike so ODŠLE iz vrednosti (besede živijo v noun.* ključih)
    expect(sl['tables.seats']).not.toContain('mest')
    expect(sl['menu.catCount']).not.toContain('artiklov')
  })
})

// ── Č3) PLOŠČICA MIZE (FIX A) ──

describe('v1.268.0 Č3 — ploščica mize: višina + dedup noge', () => {
  test('fiksna višina h-40 vseh stanj (Issue #74 V-12 ohranjen; h-32 odšel)', () => {
    const dash = read('src/app/dashboard/page.tsx')
    expect(dash).toContain('flex h-40 w-full flex-col rounded-xl p-3')
    expect(dash).not.toContain('flex h-32 w-full flex-col')
  })

  test('noga nosi status SAMO za FREE/DIRTY (unikatna vsebina)', () => {
    const dash = read('src/app/dashboard/page.tsx')
    expect(dash).toContain("{(tb.status === 'FREE' || tb.status === 'DIRTY') &&")
    // zasedena/rezervirana ga imata v telesu — dvojnik v nogi bi spet obrezoval 👤/⏱
    expect(dash).toContain("tb.heldOrderId && !tb.activeOrder ? stL('HOLD') : stL(tb.status)")
  })

  test('usajeni gost SAMO v telesu (nogova kopija umaknjena)', () => {
    const dash = read('src/app/dashboard/page.tsx')
    const bodyGost = dash.indexOf("seatedGuestL(tb) && <p className=")
    const nogGost = dash.indexOf("seatedGuestL(tb) && <span className=")
    expect(bodyGost).toBeGreaterThan(-1)
    expect(nogGost).toBe(-1)
  })
})

// ── Ž) REGISTRI ──

describe('v1.268.0 Ž — registri', () => {
  test('Ž1: verzija 1.268.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.278.0')
    expect(read('src/lib/version.ts')).toContain("'1.278.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.278.0')
  })

  test('Ž2: i18n pariteta SL/HR 4320/4320 (+20 ključev vala)', () => {
    for (const noun of ['mesto', 'artikel', 'racun', 'obisk', 'tocka']) {
      for (const form of ['1', '2', '34', 'n']) {
        expect(sl[`noun.${noun}.${form}`]).toBeTruthy()
        expect(hr[`noun.${noun}.${form}`]).toBeTruthy()
      }
    }
    expect(Object.keys(sl).length).toBe(4320)
    expect(Object.keys(hr).length).toBe(4320)
  })

  test('Ž3: AUDIT števci usklajeni (doc-truth)', () => {
    expect(read('docs/RESTAURANTOS-AUDIT.md')).toContain('4320 ključev SL in 4320 HR')
  })

  test('Ž4: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.278.0-lib-nizi')
  })
})
