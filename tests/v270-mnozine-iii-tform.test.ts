/**
 * v1.270.0 — MNOŽINSKE OBLIKE III: tForm + tN2 (VZORCI IZVEN »{n} {w}«)
 * (nadaljevanje v1.268.0 + v1.269.0 — preostali ključi iz ISKRENO ZUNAJ
 *  OBSEGA v269: oblike, ki se ne da sestaviti iz {w} delov.)
 *
 *  TRI NOVE MOŽNOSTI i18n PLASTI:
 *    · pluralForm(n) — JAVNI izvleček oblike števnika (1/2/34/n); nounKey ga
 *      deli za noun.* ključe, tForm za CELO-predložne variante — ENO mesto
 *      resnice (prej je obliko izračunaval samo nounKey interne).
 *    · tForm(locale, key, n, vars) — CELO-predložne množinske variante
 *      <key>.1/.2/.34/.n z milo degradacijo (.oblika → .n → osnovni ključ).
 *      Namenski primer: GLAGOLSKA soglasnost — »1 postavka ni poslana ·
 *      2 postavki nista poslani · 3 postavke niso poslane · 5 postavk ni
 *      poslanih« — nagiba se ne da sestaviti iz delov.
 *    · tN2(key, nounN, n, nounM, m) — predloga z DVEMA samostalnikoma in
 *      dvema številoma ({n}+{w} iz prvega para, {m}+{x} iz drugega).
 *
 *  PRETVORJENI KLJUČI (vsi iz v269 ZUNAJ OBSEGA):
 *    · hh.unpaidWarn — bazni ključ (rodilnik za VSE števnike, za 1/2/3
 *      napačno!) → 4 glagolske oblike .1/.2/.34/.n; handheld tF.
 *    · ent.rcCount — »{n} centrov · {m} postaj« → tN2(prihodCent, postaja);
 *      enterprise-tab.
 *    · kds.unconfirmedAllergens — n-od-m konstrukcija → tN2 z RODILNIŠKO
 *      paradigmo postavkaGen po »od {m}« (1 od 1 postavke · 2 od 3 postavk ·
 *      5 od 8 postavk); dashboard KDS.
 *    · crm.segments.eligible — pridevniška oblika upravicen → tN; crm-tab.
 *    · crm.seg.frequent — criterionNoun: 'obisk' (konfig nosi SAMO
 *      identifikator, beseda živi v slovarju — enak vzorec kot nounKey);
 *      lib/crm.ts + crm-tab generični renderer.
 *
 *  4 NOVI NOUN SKUPKI × 4 oblike × SL+HR (32 ključev): prihodCent
 *    (SESTAVLJENA zveza — preganja se celota; terminologija usklajena z
 *    rc.title v1.260), postaja, upravicen (PRIDEVNIK kot števni samostalnik),
 *    postavkaGen (RODILNIŠKA paradigma postavke za n-od-m). HR: prihodovni
 *    centar/centara, stanica, upravičen, stavki.
 *
 *  BUGFIX (pred zaprtjem vala, regresijsko pinjen spodaj v Č2): tForm sprva
 *    NI izpolnjeval {n} — klic tF('hh.unpaidWarn', 2) bi na handheldu
 *    izrisal literal »{n} postavki nista poslani v kuhinjo!«. Popravek
 *    { n, …vars } po vzorcu tN. Implementacijski commit je potoval brez
 *    testa — to testno telo je nastalo ob zaključku vala in bug je ulovilo
 *    branje implementacije pred pisanjem testov (lekcija: VRATA šele potem,
 *    ko testno telo obstaja).
 *
 *  Č1 · SLOVARJA: hh.unpaidWarn 4 oblike + 4 noun skupki × 4 (SL+HR pariteta),
 *    SL spot oblike (prihodkovna centra dvojina!, upravičena, postavkaGen
 *    rodilnik), HR terminologija (prihodovni centar/centara, stanica, stavki).
 *  Č2 · pluralForm + tForm: izvleček (robni primeri), vse 4 glagolske oblike,
 *    BUGFIX pin ({n} izpolnjen brez vars), mila degradacija, override vars.
 *  Č3 · tN2 + CRM: ent.rcCount kombinacije, kds.unconfirmedAllergens rodilnik,
 *    crm.segments.eligible pridevnik, crm.seg.frequent obisk.
 *  Č4 · MONTAŽA: klicna mesta (handheld tF, enterprise/dashboard tN2,
 *    crm-tab criterionNoun pot), i18n.tsx izvozi, crm.ts konfig.
 *  Ž · REGISTRI: verzija 1.270.0, i18n 4320/4320 (noun 88), AUDIT doc-truth
 *    (veriga 4157 → 4168 → 4188 → 4231 → 4250), worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { nounKey, pluralForm, t, tForm } from '../src/lib/i18n'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

/** tN brez Reacta — enaka sestava kot I18nProvider (w = t(nounKey(...))). */
function tN(locale: 'sl' | 'hr', key: string, noun: string, n: number, vars?: Record<string, string | number>): string {
  return t(locale, key, { n, w: t(locale, nounKey(noun, n)), ...vars })
}

/** tN2 brez Reacta — enaka sestava kot I18nProvider ({n}+{w}, {m}+{x}). */
function tN2(locale: 'sl' | 'hr', key: string, nounN: string, n: number, nounM: string, m: number): string {
  return t(locale, key, { n, w: t(locale, nounKey(nounN, n)), m, x: t(locale, nounKey(nounM, m)) })
}

const NEW_NOUNS = ['prihodCent', 'postaja', 'upravicen', 'postavkaGen']

// ── Č1) SLOVARJA — hh.unpaidWarn + 4 novi noun skupki ──

describe('v1.270.0 Č1 — slovarja: hh.unpaidWarn + 4 novi samostalniki', () => {
  test('hh.unpaidWarn ima VSE štiri oblike v SL in HR (bazni ključ upokojen)', () => {
    for (const form of ['1', '2', '34', 'n']) {
      expect(sl[`hh.unpaidWarn.${form}`]).toBeTruthy()
      expect(hr[`hh.unpaidWarn.${form}`]).toBeTruthy()
    }
    expect(sl['hh.unpaidWarn']).toBeUndefined()
    expect(hr['hh.unpaidWarn']).toBeUndefined()
  })

  test('SL glagolska soglasnost: ni poslana / nista poslani / niso poslane / ni poslanih', () => {
    expect(sl['hh.unpaidWarn.1']).toBe('{n} postavka ni poslana v kuhinjo!')
    expect(sl['hh.unpaidWarn.2']).toBe('{n} postavki nista poslani v kuhinjo!')
    expect(sl['hh.unpaidWarn.34']).toBe('{n} postavke niso poslane v kuhinjo!')
    expect(sl['hh.unpaidWarn.n']).toBe('{n} postavk ni poslanih v kuhinjo!')
  })

  test('HR: nije poslana / nisu poslane (2–4) / nije poslano (5+)', () => {
    expect(hr['hh.unpaidWarn.1']).toBe('{n} stavka nije poslana u kuhinju!')
    expect(hr['hh.unpaidWarn.2']).toBe('{n} stavke nisu poslane u kuhinju!')
    expect(hr['hh.unpaidWarn.34']).toBe('{n} stavke nisu poslane u kuhinju!')
    expect(hr['hh.unpaidWarn.n']).toBe('{n} stavki nije poslano u kuhinju!')
  })

  test('vsak novi samostalnik ima VSE štiri oblike v SL in HR (pariteta)', () => {
    for (const noun of NEW_NOUNS) {
      for (const form of ['1', '2', '34', 'n']) {
        expect(sl[`noun.${noun}.${form}`]).toBeTruthy()
        expect(hr[`noun.${noun}.${form}`]).toBeTruthy()
      }
    }
  })

  test('SL spot oblike: prihodkovna centra (dvojina!), upravičena, postavkaGen rodilnik', () => {
    expect(sl['noun.prihodCent.1']).toBe('prihodkovni center')
    expect(sl['noun.prihodCent.2']).toBe('prihodkovna centra')
    expect(sl['noun.prihodCent.34']).toBe('prihodkovni centri')
    expect(sl['noun.prihodCent.n']).toBe('prihodkovnih centrov')
    expect(sl['noun.postaja.2']).toBe('postaji')
    expect(sl['noun.postaja.34']).toBe('postaje')
    expect(sl['noun.upravicen.1']).toBe('upravičen')
    expect(sl['noun.upravicen.2']).toBe('upravičena')
    expect(sl['noun.upravicen.34']).toBe('upravičeni')
    expect(sl['noun.upravicen.n']).toBe('upravičenih')
    // rodilniška paradigma po »od {m}«: 1 od 1 postavke · 2 od 3 postavk
    expect(sl['noun.postavkaGen.1']).toBe('postavke')
    expect(sl['noun.postavkaGen.2']).toBe('postavk')
    expect(sl['noun.postavkaGen.34']).toBe('postavk')
    expect(sl['noun.postavkaGen.n']).toBe('postavk')
  })

  test('HR terminologija: prihodovni centar/centara, stanica, upravičen, stavki', () => {
    expect(hr['noun.prihodCent.1']).toBe('prihodovni centar')
    expect(hr['noun.prihodCent.2']).toBe('prihodovna centara')
    expect(hr['noun.prihodCent.34']).toBe('prihodovna centara')
    expect(hr['noun.prihodCent.n']).toBe('prihodovnih centara')
    expect(hr['noun.postaja.1']).toBe('stanica')
    expect(hr['noun.postaja.2']).toBe('stanice')
    expect(hr['noun.postaja.n']).toBe('stanica')
    expect(hr['noun.upravicen.n']).toBe('upravičenih')
    expect(hr['noun.postavkaGen.1']).toBe('stavke')
    expect(hr['noun.postavkaGen.n']).toBe('stavki')
  })
})

// ── Č2) pluralForm + tForm ──

describe('v1.270.0 Č2 — pluralForm (izvleček) + tForm (glagolska soglasnost)', () => {
  test('pluralForm: 1→1, 2→2, 3/4→34, 5+/0/negativne→n; |n| in trunc', () => {
    expect(pluralForm(1)).toBe('1')
    expect(pluralForm(2)).toBe('2')
    expect(pluralForm(3)).toBe('34')
    expect(pluralForm(4)).toBe('34')
    expect(pluralForm(5)).toBe('n')
    expect(pluralForm(0)).toBe('n')
    expect(pluralForm(21)).toBe('n')
    expect(pluralForm(-2)).toBe('2')
    expect(pluralForm(-5)).toBe('n')
    expect(pluralForm(2.7)).toBe('2')
    expect(pluralForm(NaN)).toBe('n')
    expect(pluralForm(Infinity)).toBe('n')
  })

  test('pluralForm je izvleček nounKey-ja (eno mesto resnice)', () => {
    expect(nounKey('mesto', 1)).toBe('noun.mesto.1')
    expect(nounKey('mesto', 2)).toBe('noun.mesto.2')
    expect(nounKey('mesto', 4)).toBe('noun.mesto.34')
    expect(nounKey('mesto', 6)).toBe('noun.mesto.n')
  })

  test('tForm: hh.unpaidWarn vseh 12 GLAGOLSKIH oblik SL (1/2/3/4/5/21 × povratne)', () => {
    expect(tForm('sl', 'hh.unpaidWarn', 1)).toBe('1 postavka ni poslana v kuhinjo!')
    expect(tForm('sl', 'hh.unpaidWarn', 2)).toBe('2 postavki nista poslani v kuhinjo!')
    expect(tForm('sl', 'hh.unpaidWarn', 3)).toBe('3 postavke niso poslane v kuhinjo!')
    expect(tForm('sl', 'hh.unpaidWarn', 4)).toBe('4 postavke niso poslane v kuhinjo!')
    expect(tForm('sl', 'hh.unpaidWarn', 5)).toBe('5 postavk ni poslanih v kuhinjo!')
    expect(tForm('sl', 'hh.unpaidWarn', 21)).toBe('21 postavk ni poslanih v kuhinjo!')
  })

  test('REGRESIJSKI PIN (BUGFIX): {n} se izpolni BREZ vars — prej bi bil literal {n}', () => {
    // bug: tForm je izpisal »{n} postavki nista poslani v kuhinjo!« (handheld)
    expect(tForm('sl', 'hh.unpaidWarn', 2)).not.toContain('{n}')
    expect(tForm('sl', 'hh.unpaidWarn', 2)).not.toContain('{')
    expect(tForm('hr', 'hh.unpaidWarn', 2)).toBe('2 stavke nisu poslane u kuhinju!')
    expect(tForm('hr', 'hh.unpaidWarn', 5)).toBe('5 stavki nije poslano u kuhinju!')
  })

  test('tForm mila degradacija: manjkajoča oblika → .n → osnovni ključ', () => {
    // kds.staleCount nima .2 ne .n oblike → osnovna predloga (fallback, vidljivo)
    expect(tForm('sl', 'kds.staleCount', 2)).toBe('2 {w}')
    // neznani ključ → t() vrne ključ (vidljivo, nikoli razbito)
    expect(tForm('sl', 'neobstojoc.kljuc', 2)).toBe('neobstojoc.kljuc')
  })

  test('tForm: klic lahko povozi {n} prek vars (vzorec tN — …vars nazadnje)', () => {
    expect(tForm('sl', 'hh.unpaidWarn', 2, { n: 7 })).toBe('7 postavki nista poslani v kuhinjo!')
  })
})

// ── Č3) tN2 + CRM ključi ──

describe('v1.270.0 Č3 — tN2: predloge z dvema samostalnikoma + CRM', () => {
  test('ent.rcCount SL: 1 center · 1 postaja / 2 centra · 2 postaji / 3 centri · 4 postaje / 5 centrov · 6 postaj', () => {
    expect(tN2('sl', 'ent.rcCount', 'prihodCent', 1, 'postaja', 1)).toBe('1 prihodkovni center · 1 postaja')
    expect(tN2('sl', 'ent.rcCount', 'prihodCent', 2, 'postaja', 2)).toBe('2 prihodkovna centra · 2 postaji')
    expect(tN2('sl', 'ent.rcCount', 'prihodCent', 3, 'postaja', 4)).toBe('3 prihodkovni centri · 4 postaje')
    expect(tN2('sl', 'ent.rcCount', 'prihodCent', 5, 'postaja', 6)).toBe('5 prihodkovnih centrov · 6 postaj')
  })

  test('ent.rcCount HR: paucal (2–4 ista oblika), stanica', () => {
    expect(tN2('hr', 'ent.rcCount', 'prihodCent', 1, 'postaja', 1)).toBe('1 prihodovni centar · 1 stanica')
    expect(tN2('hr', 'ent.rcCount', 'prihodCent', 2, 'postaja', 3)).toBe('2 prihodovna centara · 3 stanice')
    expect(tN2('hr', 'ent.rcCount', 'prihodCent', 5, 'postaja', 6)).toBe('5 prihodovnih centara · 6 stanica')
  })

  test('kds.unconfirmedAllergens: n-od-m z RODILNIŠKO paradigmo po »od {m}«', () => {
    expect(tN2('sl', 'kds.unconfirmedAllergens', 'postavkaGen', 1, 'postavkaGen', 1)).toBe('1 od 1 postavke brez potrjenih alergenskih podatkov')
    expect(tN2('sl', 'kds.unconfirmedAllergens', 'postavkaGen', 2, 'postavkaGen', 3)).toBe('2 od 3 postavk brez potrjenih alergenskih podatkov')
    expect(tN2('sl', 'kds.unconfirmedAllergens', 'postavkaGen', 5, 'postavkaGen', 8)).toBe('5 od 8 postavk brez potrjenih alergenskih podatkov')
    expect(tN2('hr', 'kds.unconfirmedAllergens', 'postavkaGen', 2, 'postavkaGen', 3)).toBe('2 od 3 stavki bez potvrđenih alergenskih podataka')
  })

  test('crm.segments.eligible: pridevniški sklopek upravicen', () => {
    expect(tN('sl', 'crm.segments.eligible', 'upravicen', 1)).toBe('1 upravičen (soglasje + kontakt)')
    expect(tN('sl', 'crm.segments.eligible', 'upravicen', 2)).toBe('2 upravičena (soglasje + kontakt)')
    expect(tN('sl', 'crm.segments.eligible', 'upravicen', 5)).toBe('5 upravičenih (soglasje + kontakt)')
    expect(tN('hr', 'crm.segments.eligible', 'upravicen', 5)).toBe('5 upravičenih (suglasnost + kontakt)')
  })

  test('crm.seg.frequent: obisk (beseda živi v slovarju — criterionNoun ID)', () => {
    expect(tN('sl', 'crm.seg.frequent', 'obisk', 3)).toBe('Pogostni gostje (vsaj 3 obiski)')
    expect(tN('hr', 'crm.seg.frequent', 'obisk', 3)).toBe('Česti gosti (najmanje 3 posjeta)')
  })
})

// ── Č4) MONTAŽA — klicna mesta ──

describe('v1.270.0 Č4 — montaža: tF/tN2/criterionNoun na klicnih mestih', () => {
  test('handheld: tF(hh.unpaidWarn) brez ročnih vars (BUGFIX pot)', () => {
    expect(read('src/app/handheld/page.tsx')).toContain("tF('hh.unpaidWarn', pendingCount)")
  })

  test('i18n.tsx: tF + tN2 v kontekstu (default snapshot + provider)', () => {
    const s = read('src/components/i18n.tsx')
    expect((s.match(/coreTForm\(/g) || []).length).toBe(2)
    expect(s).toContain('tN2: (key, nounN, n, nounM, m, vars)')
  })

  test('enterprise-tab: tN2(ent.rcCount, prihodCent, …, postaja, …)', () => {
    expect(read('src/components/tabs/enterprise-tab.tsx')).toContain("tN2('ent.rcCount', 'prihodCent'")
  })

  test('dashboard KDS: tN2(kds.unconfirmedAllergens, postavkaGen, …) — obakrat postavkaGen', () => {
    expect(read('src/app/dashboard/page.tsx')).toContain("tN2('kds.unconfirmedAllergens', 'postavkaGen', unconfirmedCount, 'postavkaGen', items.length)")
  })

  test('crm: criterionNoun pot — lib nosi ID, UI generični renderer, eligible posebej', () => {
    expect(read('src/lib/crm.ts')).toContain("criterionNoun: 'obisk'")
    const tab = read('src/components/tabs/crm-tab.tsx')
    expect(tab).toContain('s.criterionNoun')
    expect(tab).toContain('tN(s.criterionKey, s.criterionNoun')
    expect(tab).toContain("tN('crm.segments.eligible', 'upravicen'")
  })

  test('index.ts: pluralForm + tForm javna izvoza (izvleček iz nounKey; PREVEZ v1.277 — pluralForm živi v čistem sloju fmt.ts, i18n re-izvozi)', () => {
    const s = read('src/lib/i18n/index.ts')
    // v1.277.0 prevez: pluralForm preseljena v čisti sloj '../fmt' (0 uvozov,
    // strežniško varna — API rute za backend množine, ne da bi vlekle slovarje);
    // javni API '../src/lib/i18n' ohranjen prek re-izvoza (to pogodbo pini ta test).
    expect(s).toContain("export { pluralForm } from '../fmt'")
    expect(s).toContain('export function tForm(')
    // definicija pripeta na novem mestu resnice:
    expect(read('src/lib/fmt.ts')).toContain('export function pluralForm(')
  })
})

// ── Ž) REGISTRI ──

describe('v1.270.0 Ž — registri', () => {
  test('Ž1: verzija 1.270.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.279.0')
    expect(read('src/lib/version.ts')).toContain("'1.279.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.279.0')
  })

  test('Ž2: i18n pariteta SL/HR 4320/4320 (noun 148 = 37 skupkov × 4)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    expect(Object.keys(sl).filter((k) => k.startsWith('noun.')).length).toBe(148)
  })

  test('Ž3: AUDIT doc-truth — veriga stanj 4157 → 4168 → 4188 → 4231 → 4250', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('4324 ključev SL in 4324 HR')
    expect(audit).toContain('POSODOBITEV (v1.270.0, množinske oblike III')
    expect(audit).toContain('4231 → 4250')
    // zgodovinski vnosi nosijo SVOJE stanje (popravki doc-truth v1.270.0 —
    // prej sta v267/v268 napačno nosili končno stanje v269)
    expect(audit).toContain('4157 → 4168')
    expect(audit).toContain('4168 → 4188')
    expect(audit).toContain('4188 → 4231')
  })

  test('Ž4: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.279.0-revizija-produkcije')
  })
})
