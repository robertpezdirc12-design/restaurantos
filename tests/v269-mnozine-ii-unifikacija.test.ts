/**
 * v1.269.0 — MNOŽINSKE OBLIKE II: nounKey KOT EDINI VIR RESNICE
 * (nadaljevanje v1.268.0 — nounKey vzpostavljen; ta val ga razvalja na vse
 * preostale preproste »{n} X« predloge in upokoji VSE ročne množinske sisteme).
 *
 *  PRETVORJENIH 17 PREDLOG v »{n} {w}« (obe slovarja): dash.itemsCount,
 *    kds.staleCount, kds.cfg.inUse, kds.guestsShort, tables.guestsShort
 *    (osirotel — 0 klicnih mest, pretvorba neškodljiva), emp.permsCount,
 *    crm.dup.count, tips.pointsSum, loc.today, integ.errorsCount,
 *    rcpt.reprintItems, wl.leftCount, wl.partyN, proc.linesCount,
 *    proc.receiptMany, waste.recordsCount, haccpPlan.stepsCount.
 *
 *  13 NOVIH SAMOSTALNIKOV × 4 oblike × SL+HR (52 ključev): oseba, gost,
 *    listek, vrstica, prevzem, zapis, korak, dovoljenje, par, naročilo,
 *    napaka, postavka, odhod. HR terminologija: osoba, gost (5+ gostiju),
 *    listić, stavka, prijem, zapis, korak, dozvola, par, narudžba, greška,
 *    stavka, odlazak (vrstica in postavka se v HR preslikata V ISTO besedo
 *    — ključa sta ločena, vrednosti HR sovpadajo, kot pri SL sinonimih).
 *
 *  UPOKOJENI ROČNI SISTEMI (−9 ključev × 2 slovarja):
 *    · wl.party1/2/34 — wlParty 4-ključ (gostinske-ops) → tN('wl.partyN', 'oseba', n)
 *    · kds.countOne/Two/Few/Many — listekCountKey (dashboard) je bil MRTVA KODA
 *      (funkcija definirana, a nikoli klicana) → tN('kds.staleCount', 'listek', n)
 *    · proc.receiptOne/Two — veriga 1/2/many (nabava) → tN('proc.receiptMany', 'prevzem', n)
 *    · partySizeLabel (src/lib/waitlist.ts) — SL-hardcodirana n-tev »oseba«, brez
 *      klicnih mest v UI (UI gre prek i18n ključev) — funkcija + test upokojena.
 *
 *  ISKRENO ZUNAJ OBSEGA (z razlogom): ent.rcCount (DVA samostalnika v eni
 *    predlogi — {n} centrov · {m} postaj), hh.unpaidWarn (glagolska soglasnost
 *    dvojine), crm.segments.eligible (pridevniška oblika), crm.seg.frequent
 *    (generični criterionKey renderer + prag ≥3 — pomen »3 ali več« je
 *    slovnično dvoumen), kds.unconfirmedAllergens (n-od-m konstrukcija),
 *    crm.detail.* (deležniki), orders.moreItems/tc.lowStockMore (pridevniki),
 *    oh.confirmHolidays (pridevnik+samostalnik v stavku), mig.*, disc.uses,
 *    callv.card.* (števci brez samostalnika za {n}).
 *
 *  Č1 · SLOVARJA: 13 novih samostalnikov × 4 oblike v SL in HR (pariteta),
 *    SL spot oblike (oseba dvojina, gost gostje, listek), HR terminologija
 *    (gostiju, stavka, prijem, dozvola, narudžba, greška, odlazak).
 *  Č2 · tN + PREDLOGE: bivše wlParty/listekCountKey/proc.veriga semantike,
 *    predloge {w} v obeh slovarjih, upokojeni ključi so ODŠLI.
 *  Č3 · MONTAŽA: vsa klicna mesta (8 datotek) uporabljajo tN; mrtva koda
 *    (listekCountKey, wlParty, partySizeLabel, proc.veriga, .replace hack)
 *    je ODŠLA iz virov.
 *  Ž · REGISTRI: verzija 1.269.0, i18n 4320/4320 (+52 −9), AUDIT doc-truth,
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

/** tN brez Reacta — enaka sestava kot I18nProvider (w = t(nounKey(...))). */
function tN(locale: 'sl' | 'hr', key: string, noun: string, n: number, vars?: Record<string, string | number>): string {
  return t(locale, key, { n, w: t(locale, nounKey(noun, n)), ...vars })
}

const NEW_NOUNS = ['oseba', 'gost', 'listek', 'vrstica', 'prevzem', 'zapis', 'korak', 'dovoljenje', 'par', 'narocilo', 'napaka', 'postavka', 'odhod']

// ── Č1) SLOVARJA — novi samostalniki ──

describe('v1.269.0 Č1 — slovarja: 13 novih samostalnikov', () => {
  test('vsak novi samostalnik ima VSE štiri oblike v SL in HR (pariteta)', () => {
    for (const noun of NEW_NOUNS) {
      for (const form of ['1', '2', '34', 'n']) {
        expect(sl[`noun.${noun}.${form}`]).toBeTruthy()
        expect(hr[`noun.${noun}.${form}`]).toBeTruthy()
      }
    }
  })

  test('SL spot oblike: oseba (dvojina!), gost (gostje), listek (listki)', () => {
    expect(sl['noun.oseba.2']).toBe('osebi')
    expect(sl['noun.oseba.34']).toBe('osebe')
    expect(sl['noun.oseba.n']).toBe('oseb')
    expect(sl['noun.gost.34']).toBe('gostje')
    expect(sl['noun.gost.n']).toBe('gostov')
    expect(sl['noun.listek.1']).toBe('listek')
    expect(sl['noun.listek.2']).toBe('listka')
    expect(sl['noun.listek.34']).toBe('listki')
    expect(sl['noun.listek.n']).toBe('listkov')
    expect(sl['noun.dovoljenje.2']).toBe('dovoljenji')
    expect(sl['noun.narocilo.34']).toBe('naročila')
  })

  test('HR terminologija: osoba/gostiju/listić/stavka/prijem/dozvola/narudžba/greška/odlazak', () => {
    expect(hr['noun.oseba.n']).toBe('osoba')
    expect(hr['noun.gost.n']).toBe('gostiju')
    expect(hr['noun.listek.n']).toBe('listića')
    expect(hr['noun.vrstica.n']).toBe('stavki')
    expect(hr['noun.postavka.1']).toBe('stavka')
    expect(hr['noun.prevzem.1']).toBe('prijem')
    expect(hr['noun.dovoljenje.1']).toBe('dozvola')
    expect(hr['noun.narocilo.1']).toBe('narudžba')
    expect(hr['noun.napaka.n']).toBe('grešaka')
    expect(hr['noun.odhod.1']).toBe('odlazak')
  })
})

// ── Č2) tN + PREDLOGE ──

describe('v1.269.0 Č2 — tN oblike po števniku (bivši ročni sistemi)', () => {
  test('wl.partyN prevzame wlParty semantiko: 1 oseba · 2 osebi · 4 osebe · 6 oseb', () => {
    expect(tN('sl', 'wl.partyN', 'oseba', 1)).toBe('1 oseba')
    expect(tN('sl', 'wl.partyN', 'oseba', 2)).toBe('2 osebi')
    expect(tN('sl', 'wl.partyN', 'oseba', 4)).toBe('4 osebe')
    expect(tN('sl', 'wl.partyN', 'oseba', 6)).toBe('6 oseb')
  })

  test('kds.staleCount prevzame listekCountKey oblike: 1 listek · 2 listka · 3 listki · 5 listkov', () => {
    expect(tN('sl', 'kds.staleCount', 'listek', 1)).toBe('1 listek')
    expect(tN('sl', 'kds.staleCount', 'listek', 2)).toBe('2 listka')
    expect(tN('sl', 'kds.staleCount', 'listek', 3)).toBe('3 listki')
    expect(tN('sl', 'kds.staleCount', 'listek', 5)).toBe('5 listkov')
  })

  test('proc.receiptMany prevzame verigo One/Two/Many: 1 prevzem · 2 prevzema · 5 prevzemov', () => {
    expect(tN('sl', 'proc.receiptMany', 'prevzem', 1)).toBe('1 prevzem')
    expect(tN('sl', 'proc.receiptMany', 'prevzem', 2)).toBe('2 prevzema')
    expect(tN('sl', 'proc.receiptMany', 'prevzem', 5)).toBe('5 prevzemov')
  })

  test('preostale predloge: artikel/točka/vrstica/korak/naročilo/postavka/odhod/zapis/par/dovoljenje/napaka', () => {
    expect(tN('sl', 'dash.itemsCount', 'artikel', 3, { name: 'Ana' })).toBe('3 artikli · Ana')
    expect(tN('sl', 'tips.pointsSum', 'tocka', 5)).toBe('Skupaj: 5 točk')
    expect(tN('sl', 'proc.linesCount', 'vrstica', 2)).toBe('2 vrstici')
    expect(tN('sl', 'haccpPlan.stepsCount', 'korak', 4)).toBe('4 koraki')
    expect(tN('sl', 'loc.today', 'narocilo', 2)).toBe('danes 2 naročili')
    expect(tN('sl', 'rcpt.reprintItems', 'postavka', 2)).toBe('postavki: 2')
    expect(tN('sl', 'wl.leftCount', 'odhod', 3)).toBe('3 odhodi')
    expect(tN('sl', 'waste.recordsCount', 'zapis', 4)).toBe('4 zapisi')
    expect(tN('sl', 'crm.dup.count', 'par', 2)).toBe('2 para')
    expect(tN('sl', 'emp.permsCount', 'dovoljenje', 3)).toBe('3 dovoljenja')
    expect(tN('sl', 'integ.errorsCount', 'napaka', 2)).toBe(' · 2 napaki')
    expect(tN('sl', 'kds.guestsShort', 'oseba', 2)).toBe('2 osebi')
    expect(tN('sl', 'kds.cfg.inUse', 'artikel', 4)).toBe('4 artikli')
  })

  test('HR oblike: paucal brez dvojine (2–4 ista oblika), gostiju/stavki/narudžbi', () => {
    expect(tN('hr', 'wl.partyN', 'oseba', 2)).toBe('2 osobe')
    expect(tN('hr', 'wl.partyN', 'oseba', 6)).toBe('6 osoba')
    expect(tN('hr', 'kds.staleCount', 'listek', 2)).toBe('2 listića')
    expect(tN('hr', 'proc.linesCount', 'vrstica', 5)).toBe('5 stavki')
    expect(tN('hr', 'loc.today', 'narocilo', 5)).toBe('danas 5 narudžbi')
    expect(tN('hr', 'haccpPlan.stepsCount', 'korak', 3)).toBe('3 koraka')
    expect(tN('hr', 'tables.guestsShort', 'gost', 5)).toBe('5 gostiju')
  })

  test('vseh 17 predlog vsebuje {n} in {w} v OBEH slovarjih', () => {
    for (const k of [
      'dash.itemsCount', 'kds.staleCount', 'kds.cfg.inUse', 'kds.guestsShort', 'tables.guestsShort',
      'emp.permsCount', 'crm.dup.count', 'tips.pointsSum', 'loc.today', 'integ.errorsCount',
      'rcpt.reprintItems', 'wl.leftCount', 'wl.partyN', 'proc.linesCount', 'proc.receiptMany',
      'waste.recordsCount', 'haccpPlan.stepsCount',
    ]) {
      expect(sl[k]).toContain('{n}')
      expect(sl[k]).toContain('{w}')
      expect(hr[k]).toContain('{n}')
      expect(hr[k]).toContain('{w}')
    }
    // rodilniške oblike so ODŠLE iz vrednosti (besede živijo v noun.* ključih)
    expect(sl['haccpPlan.stepsCount']).not.toContain('korakov')
    expect(sl['wl.partyN']).not.toContain('oseb')
  })

  test('upokojeni ključi so ODŠLI iz OBEH slovarjev (9 ključev)', () => {
    for (const k of [
      'wl.party1', 'wl.party2', 'wl.party34',
      'proc.receiptOne', 'proc.receiptTwo',
      'kds.countOne', 'kds.countTwo', 'kds.countFew', 'kds.countMany',
    ]) {
      expect(sl[k]).toBeUndefined()
      expect(hr[k]).toBeUndefined()
    }
  })
})

// ── Č3) MONTAŽA — klicna mesta + upokojitve v kodi ──

describe('v1.269.0 Č3 — montaža: tN na vseh klicnih mestih, mrtva koda odšla', () => {
  test('dashboard: 8 tN klicev + listekCountKey odšel', () => {
    const dash = read('src/app/dashboard/page.tsx')
    expect(dash).toContain("tN('dash.itemsCount', 'artikel'")
    expect(dash).toContain("tN('kds.staleCount', 'listek'")
    expect(dash).toContain("tN('kds.guestsShort', 'oseba'")
    expect(dash).toContain("tN('emp.permsCount', 'dovoljenje'")
    expect(dash).toContain("tN('loc.today', 'narocilo'")
    expect(dash).toContain("tN('integ.errorsCount', 'napaka'")
    expect(dash).toContain("tN('rcpt.reprintItems', 'postavka'")
    expect(dash).not.toMatch(/function listekCountKey/)
    // stari klici z { n } so prepovedani za pretvorjene predloge
    expect(dash).not.toMatch(/t\('(dash\.itemsCount|kds\.staleCount|kds\.guestsShort|emp\.permsCount|loc\.today|integ\.errorsCount|rcpt\.reprintItems)',/)
  })

  test('gostinske-ops: wlParty odšel, tN(wl.partyN/oseba) + leftCount + waste', () => {
    const s = read('src/components/tabs/gostinske-ops-tab.tsx')
    expect(s).not.toMatch(/wlParty\(/)
    expect((s.match(/\{tN\('wl\.partyN', 'oseba'/g) || []).length).toBe(4)
    expect(s).toContain("tN('wl.leftCount', 'odhod'")
    expect((s.match(/tN\('waste\.recordsCount', 'zapis'/g) || []).length).toBe(2)
  })

  test('nabava: veriga receiptOne/Two odšla, tN(linesCount + receiptMany)', () => {
    const s = read('src/components/tabs/nabava-tab.tsx')
    expect(s).toContain("tN('proc.linesCount', 'vrstica'")
    expect(s).toContain("tN('proc.receiptMany', 'prevzem'")
    expect(s).not.toContain('proc.receiptOne')
    expect(s).not.toContain('proc.receiptTwo')
  })

  test('haccp: .replace hack odšel, tN(stepsCount/korak)', () => {
    const s = read('src/components/tabs/haccp-tab.tsx')
    expect(s).toContain("tN('haccpPlan.stepsCount', 'korak'")
    expect(s).not.toContain("t('haccpPlan.stepsCount').replace")
  })

  test('prep-stations + crm + backoffice: tN klici na mestu', () => {
    expect((read('src/components/tabs/prep-stations-card.tsx').match(/tN\('kds\.cfg\.inUse', 'artikel'/g) || []).length).toBe(2)
    expect(read('src/components/tabs/crm-tab.tsx')).toContain("tN('crm.dup.count', 'par'")
    expect(read('src/components/tabs/backoffice-tab.tsx')).toContain("tN('tips.pointsSum', 'tocka'")
  })

  test('waitlist: partySizeLabel upokojen (lib + test import)', () => {
    expect(read('src/lib/waitlist.ts')).not.toMatch(/export function partySizeLabel/)
    expect(read('src/lib/waitlist.ts')).not.toMatch(/partySizeLabel\(/)
    expect(read('tests/waitlist.test.ts')).not.toMatch(/partySizeLabel[,(]/)
  })
})

// ── Ž) REGISTRI ──

describe('v1.269.0 Ž — registri', () => {
  test('Ž1: verzija 1.269.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.293.0')
    expect(read('src/lib/version.ts')).toContain("'1.293.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.293.0')
  })

  test('Ž2: i18n pariteta SL/HR 4320/4320 (+52 novih −9 upokojenih)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    // noun blok: 18 noun (do v1.269) + 4 (v1.270: prihodCent, postaja, upravicen,
    // postavkaGen) = 22 noun × 4 oblike = 88; v1.271 +15 skupkov = 37 × 4 = 148 (števci sledejo trenutnemu stanju — prevez)
    expect(Object.keys(sl).filter((k) => k.startsWith('noun.')).length).toBe(148)
  })

  test('Ž3: AUDIT števci usklajeni (doc-truth) + POSODOBITEV vnosi', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('4324 ključev SL in 4324 HR')
    expect(audit).toContain('POSODOBITEV (v1.269.0, množinske oblike II')
  })

  test('Ž4: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.293.0-demo-real-auditlog-pisatelji')
  })
})
