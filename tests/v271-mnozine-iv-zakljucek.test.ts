/**
 * v1.271.0 — MNOŽINSKE OBLIKE IV: ZAKLJUČEK TEME
 * (nadaljevanje v1.268/v1.269/v1.270 — zadnji ključi iz ISKRENO ZUNAJ OBSEGA
 *  seznamov: deležniki, pridevniki, samostalniki in sestavljene zveze.)
 *
 *  PRETVORJENI KLJUČI (po vzorcih »{n} {w}« / »{w}: {n}« iz v1.268/269):
 *    · DELEŽNIKI (nežni spol — 1 poslano · 2 poslani · 3–4 poslana · 5+
 *      poslanih): crm.detail.sent/failed/skipped, hh.unfired; odjavljen je
 *      MOŠKI (predpostavljen gost — crm.toast.previewUnsub);
 *      hh.orderBarReady je ŽENSKI (predpostavljena postavka — ista domena
 *      kot hh.unpaidWarn v1.270: 1 pripravljena · 2 pripravljeni · 3–4
 *      pripravljene · 5+ pripravljenih).
 *    · PRIDEVNIKI (MOŠKI — predpostavljen artikel): orders.moreItems
 *      (ostal: ＋ 1 ostali · ＋ 2 ostala · ＋ 3 ostali · ＋ 5 ostalih),
 *      tc.lowStockMore (drug).
 *    · SAMOSTALNIKI: crm.detail.eligible (redak — SL vrstica / HR redak,
 *      ločeno od noun.vrstica/stavka iz v1.269 po vzorcu vrstica/postavka),
 *      crm.detail.unsub (odjava), disc.uses/disc.unlimited (uporaba),
 *      eslog.lines (delí obstoječi noun.vrstica).
 *    · SESTAVLJENE ZVEZE (pridevnik+samostalnik se preganjata skupaj —
 *      vzorec prihodCent v1.270): oh.confirmHolidays (praznikSL — »Dodam
 *      3 slovenske praznike za 2027«), mig.appliedToast (apliciranaMigracija),
 *      crm.detail.repeat (ponovenNakup), cmv.voidedCount
 *      (razveljavitvenPremik).
 *    · tF CELO-predložne oblike (glagolska soglasnost, vzorec hh.unpaidWarn
 *      v1.270): mig.pendingBanner — 1 migracija čaka · 2 migraciji čakata ·
 *      3–4 migracije čakajo · 5+ migracij čaka.
 *    · RAZCEPLJENI SESTAVLJENI TRAKI (več števcev v eni predlogi ni skladno
 *      z nounKey — ločena mesta se sestavijo z » · « v klicnem mestu):
 *      crm.campaigns.stats → statsEligible/Sent/Failed/Unsub,
 *      crm.toast.previewDetail → previewEligible/previewUnsub/previewNoContact,
 *      crm.toast.dispatchDetail → dispatchSent/Failed/Skipped.
 *    · DIACRITICS: oh.confirmHolidays »Obstojeci datumi se preskocijo« →
 *      »Obstoječi datumi se preskočijo« (SL).
 *
 *  15 NOVIH NOUN SKUPKOV × 4 oblike × SL+HR (60 ključev; blok sedaj 37
 *    skupkov/148 ključev): redak, poslan, neuspesen, izpuscen, neposlan,
 *    odjavljen, pripravljen, ostal, drug, odjava, uporaba,
 *    apliciranaMigracija, praznikSL, ponovenNakup, razveljavitvenPremik.
 *
 *  POŠTENO ZUNAJ (invariantno — dokumentirano v AUDITU): header.queued
 *    »v vrsti«, hh.orderBar »na računu«, hh.orderBarPrep »v pripravi«,
 *    mig.partialToast »({n} ok)«, callv.card.* (min/×/# oznake) — števci
 *    brez pregibne besede; za njih ni kaj pregibati.
 *
 *  Č1 · SLOVARJA: 15 novih skupkov × 4 oblike (SL+HR pariteta), SL spot
 *    oblike (dvojina poslani!, pripravljeni fem, ostala/druga masc, odjavi,
 *    uporabi, vrstici), HR terminologija (redak/retka/redaka, poslana
 *    paucal, pripremljene fem paucal, Primijenjene migracije, slovenskih
 *    praznika, ponovljenih kupnji), upokojene sestavljene predloge
 *    undefined, mig.pendingBanner 4 tF oblike.
 *  Č2 · PREDLOGE + sestava: vse pretvorjene predloge v obeh slovarjih,
 *    tN sestava po števnikih (poslano/poslani/poslana/poslanih živo),
 *    tF mig.pendingBanner 4 glagolske oblike, oh.confirmHolidays cel stavek
 *    z {year} + diacritics pin, razcepljeni trakovi, HR paucal spot.
 *  Č3 · MONTAŽA: 8 datotek (handheld ×2, dashboard, urniki ×3 komponente,
 *    enterprise tN+tF, crm-tab toast/campaigns/detail, cash-movements,
 *    nabava eslog) — novi tN/tF klici prisotni, stari t() klici odšli.
 *  Ž · REGISTRI: verzija 1.271.0, i18n 4320/4320 (noun 148 = 37 × 4),
 *    AUDIT doc-truth (4250 → 4320), worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { nounKey, t, tForm } from '../src/lib/i18n'
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

const NEW_NOUNS = [
  'redak', 'poslan', 'neuspesen', 'izpuscen', 'neposlan', 'odjavljen',
  'pripravljen', 'ostal', 'drug', 'odjava', 'uporaba',
  'apliciranaMigracija', 'praznikSL', 'ponovenNakup', 'razveljavitvenPremik',
]

const RETIRED_KEYS = ['crm.campaigns.stats', 'crm.toast.previewDetail', 'crm.toast.dispatchDetail']

// ── Č1) SLOVARJA — 15 novih noun skupkov + upokojitve ──

describe('v1.271.0 Č1 — slovarja: 15 novih skupkov + upokojitve', () => {
  test('vsak novi skupnik ima VSE štiri oblike v SL in HR (pariteta)', () => {
    for (const noun of NEW_NOUNS) {
      for (const form of ['1', '2', '34', 'n']) {
        expect(sl[`noun.${noun}.${form}`]).toBeTruthy()
        expect(hr[`noun.${noun}.${form}`]).toBeTruthy()
      }
    }
  })

  test('SL spot oblike: deležniška dvojina poslani, fem pripravljeni, masc ostala/druga', () => {
    expect(sl['noun.poslan.2']).toBe('poslani')
    expect(sl['noun.poslan.34']).toBe('poslana')
    expect(sl['noun.neuspesen.1']).toBe('neuspešno')
    expect(sl['noun.izpuscen.34']).toBe('izpuščena')
    expect(sl['noun.neposlan.2']).toBe('neposlani')
    expect(sl['noun.pripravljen.1']).toBe('pripravljena')
    expect(sl['noun.pripravljen.2']).toBe('pripravljeni')
    expect(sl['noun.pripravljen.34']).toBe('pripravljene')
    expect(sl['noun.ostal.2']).toBe('ostala')
    expect(sl['noun.drug.2']).toBe('druga')
    expect(sl['noun.odjava.2']).toBe('odjavi')
    expect(sl['noun.uporaba.2']).toBe('uporabi')
    expect(sl['noun.redak.2']).toBe('vrstici')
    expect(sl['noun.odjavljen.1']).toBe('odjavljen')
  })

  test('SL sestavljene zveze se preganjajo kot celota (vzorec prihodCent)', () => {
    expect(sl['noun.praznikSL.1']).toBe('slovenski praznik')
    expect(sl['noun.praznikSL.2']).toBe('slovenska praznika')
    expect(sl['noun.praznikSL.34']).toBe('slovenski prazniki')
    expect(sl['noun.praznikSL.n']).toBe('slovenskih praznikov')
    expect(sl['noun.apliciranaMigracija.2']).toBe('Aplicirani migraciji')
    expect(sl['noun.apliciranaMigracija.n']).toBe('Apliciranih migracij')
    expect(sl['noun.ponovenNakup.1']).toBe('ponoven nakup')
    expect(sl['noun.ponovenNakup.34']).toBe('ponovni nakupi')
    expect(sl['noun.razveljavitvenPremik.2']).toBe('razveljavitveno obračunana premika')
    expect(sl['noun.razveljavitvenPremik.n']).toBe('razveljavitveno obračunanih premikov')
  })

  test('HR terminologija: redak/retka/redaka, paucal poslana, fem pripremljene', () => {
    expect(hr['noun.redak.1']).toBe('redak')
    expect(hr['noun.redak.2']).toBe('retka')
    expect(hr['noun.redak.n']).toBe('redaka')
    expect(hr['noun.poslan.2']).toBe('poslana')
    expect(hr['noun.neuspesen.1']).toBe('neuspješno')
    expect(hr['noun.izpuscen.1']).toBe('izostavljeno')
    expect(hr['noun.pripravljen.2']).toBe('pripremljene')
    expect(hr['noun.ostal.2']).toBe('ostala')
    expect(hr['noun.drug.2']).toBe('druga')
    expect(hr['noun.odjava.n']).toBe('odjava')
    expect(hr['noun.uporaba.n']).toBe('uporaba')
    expect(hr['noun.apliciranaMigracija.1']).toBe('Primijenjena migracija')
    expect(hr['noun.apliciranaMigracija.34']).toBe('Primijenjene migracije')
    expect(hr['noun.praznikSL.n']).toBe('slovenskih praznika')
    expect(hr['noun.ponovenNakup.n']).toBe('ponovljenih kupnji')
    expect(hr['noun.razveljavitvenPremik.n']).toBe('poništavajuće obračunatih premica')
  })

  test('mig.pendingBanner ima VSE štiri tF oblike v SL in HR (bazni ključ upokojen)', () => {
    for (const form of ['1', '2', '34', 'n']) {
      expect(sl[`mig.pendingBanner.${form}`]).toBeTruthy()
      expect(hr[`mig.pendingBanner.${form}`]).toBeTruthy()
    }
    expect(sl['mig.pendingBanner']).toBeUndefined()
    expect(hr['mig.pendingBanner']).toBeUndefined()
  })

  test('SL glagolska soglasnost: čaka / čakata / čakajo / čaka', () => {
    expect(sl['mig.pendingBanner.1']).toBe('{n} migracija čaka na DDL korak na strežniku.')
    expect(sl['mig.pendingBanner.2']).toBe('{n} migraciji čakata na DDL korak na strežniku.')
    expect(sl['mig.pendingBanner.34']).toBe('{n} migracije čakajo na DDL korak na strežniku.')
    expect(sl['mig.pendingBanner.n']).toBe('{n} migracij čaka na DDL korak na strežniku.')
  })

  test('HR: čeka (1) / čekaju (2–4) / čeka (5+)', () => {
    expect(hr['mig.pendingBanner.1']).toBe('{n} migracija čeka DDL korak na serveru.')
    expect(hr['mig.pendingBanner.2']).toBe('{n} migracije čekaju DDL korak na serveru.')
    expect(hr['mig.pendingBanner.34']).toBe('{n} migracije čekaju DDL korak na serveru.')
    expect(hr['mig.pendingBanner.n']).toBe('{n} migracija čeka DDL korak na serveru.')
  })

  test('upokojene sestavljene predloge so undefined v obeh slovarjih', () => {
    for (const key of RETIRED_KEYS) {
      expect(sl[key]).toBeUndefined()
      expect(hr[key]).toBeUndefined()
    }
  })
})

// ── Č2) PREDLOGE + SESTAVA po števnikih ──

describe('v1.271.0 Č2 — predloge in sestava', () => {
  test('vse pretvorjene predloge nosijo {n}+{w} (ali {w}: {n}) v OBEH slovarjih', () => {
    const both = [
      'hh.unfired', 'hh.orderBarReady', 'orders.moreItems', 'mig.appliedToast',
      'disc.uses',
      'crm.campaigns.statsEligible', 'crm.campaigns.statsSent', 'crm.campaigns.statsFailed', 'crm.campaigns.statsUnsub',
      'crm.detail.eligible', 'crm.detail.sent', 'crm.detail.failed', 'crm.detail.unsub',
      'crm.toast.previewEligible', 'crm.toast.previewUnsub',
      'crm.toast.dispatchSent', 'crm.toast.dispatchFailed', 'crm.toast.dispatchSkipped',
      'eslog.lines',
    ]
    for (const key of both) {
      expect(sl[key]).toContain('{n}')
      expect(sl[key]).toContain('{w}')
      expect(hr[key]).toBe(sl[key])
    }
    // te predloge imajo jezikovno različne okvirje — pin oblike ločeno
    expect(sl['cmv.voidedCount']).toBe('{n} {w} (kompenzacijski zapisi vidni)')
    expect(hr['cmv.voidedCount']).toBe('{n} {w} (kompenzacijski zapisi vidljivi)')
    expect(sl['crm.detail.skipped']).toBe('{w} (ni soglasja): {n}')
    expect(hr['crm.detail.skipped']).toBe('{w} (nema suglasnosti): {n}')
    expect(sl['tc.lowStockMore']).toBe('… in še {n} {w}')
    expect(hr['tc.lowStockMore']).toBe('… i još {n} {w}')
    expect(sl['disc.unlimited']).toBe('{w}: {n} (neomejeno)')
    expect(hr['disc.unlimited']).toBe('{w}: {n} (neograničeno)')
    expect(sl['disc.uses']).toBe('{w} {n}/{m}')
    expect(sl['crm.toast.previewNoContact']).toBe('brez kontakta: {m}')
    expect(hr['crm.toast.previewNoContact']).toBe('bez kontakta: {m}')
  })

  test('oh.confirmHolidays: {w} zveza + DIACRITICS popravek (Obstoječi/preskočijo)', () => {
    expect(sl['oh.confirmHolidays']).toBe('Dodam {n} {w} za {year} (zaprti dnevi)? Obstoječi datumi se preskočijo.')
    expect(sl['oh.confirmHolidays']).not.toContain('Obstojeci')
    expect(sl['oh.confirmHolidays']).not.toContain('preskocijo')
    expect(hr['oh.confirmHolidays']).toBe('Dodam {n} {w} za {year} (zatvoreni dani)? Postojeći datumi se preskoče.')
    // cel stavek po števnikih (praznikSL se preganja kot celota)
    expect(tN('sl', 'oh.confirmHolidays', 'praznikSL', 1, { year: 2027 })).toBe('Dodam 1 slovenski praznik za 2027 (zaprti dnevi)? Obstoječi datumi se preskočijo.')
    expect(tN('sl', 'oh.confirmHolidays', 'praznikSL', 2, { year: 2027 })).toContain('2 slovenska praznika')
    expect(tN('sl', 'oh.confirmHolidays', 'praznikSL', 3, { year: 2027 })).toContain('3 slovenski prazniki')
    expect(tN('sl', 'oh.confirmHolidays', 'praznikSL', 12, { year: 2027 })).toContain('12 slovenskih praznikov')
    expect(tN('hr', 'oh.confirmHolidays', 'praznikSL', 12, { year: 2027 })).toContain('12 slovenskih praznika')
  })

  test('deležniška sestava crm.detail.sent: poslano/poslani/poslana/poslanih', () => {
    expect(tN('sl', 'crm.detail.sent', 'poslan', 1)).toBe('poslano: 1')
    expect(tN('sl', 'crm.detail.sent', 'poslan', 2)).toBe('poslani: 2')
    expect(tN('sl', 'crm.detail.sent', 'poslan', 3)).toBe('poslana: 3')
    expect(tN('sl', 'crm.detail.sent', 'poslan', 5)).toBe('poslanih: 5')
    expect(tN('sl', 'crm.detail.sent', 'poslan', 21)).toBe('poslanih: 21')
    expect(tN('hr', 'crm.detail.sent', 'poslan', 3)).toBe('poslana: 3')
  })

  test('ostali/drugi (masc, predpostavljen artikel) — orders.moreItems + tc.lowStockMore', () => {
    expect(tN('sl', 'orders.moreItems', 'ostal', 1)).toBe('＋ 1 ostali')
    expect(tN('sl', 'orders.moreItems', 'ostal', 2)).toBe('＋ 2 ostala')
    expect(tN('sl', 'orders.moreItems', 'ostal', 4)).toBe('＋ 4 ostali')
    expect(tN('sl', 'orders.moreItems', 'ostal', 7)).toBe('＋ 7 ostalih')
    expect(tN('sl', 'tc.lowStockMore', 'drug', 2)).toBe('… in še 2 druga')
    expect(tN('sl', 'tc.lowStockMore', 'drug', 3)).toBe('… in še 3 drugi')
    expect(tN('hr', 'tc.lowStockMore', 'drug', 2)).toBe('… i još 2 druga')
    expect(tN('hr', 'orders.moreItems', 'ostal', 3)).toBe('＋ 3 ostala')
  })

  test('hh.orderBarReady ŽENSKI (postavka — domena hh.unpaidWarn) + hh.unfired nežni', () => {
    expect(tN('sl', 'hh.orderBarReady', 'pripravljen', 1)).toBe('1 pripravljena')
    expect(tN('sl', 'hh.orderBarReady', 'pripravljen', 2)).toBe('2 pripravljeni')
    expect(tN('sl', 'hh.orderBarReady', 'pripravljen', 4)).toBe('4 pripravljene')
    expect(tN('sl', 'hh.orderBarReady', 'pripravljen', 6)).toBe('6 pripravljenih')
    expect(tN('hr', 'hh.orderBarReady', 'pripravljen', 2)).toBe('2 pripremljene')
    expect(tN('sl', 'hh.unfired', 'neposlan', 2)).toBe('2 neposlani')
    expect(tN('sl', 'hh.unfired', 'neposlan', 5)).toBe('5 neposlanih')
  })

  test('tF mig.pendingBanner — glagolska soglasnost živo (1/2/3/5/21)', () => {
    expect(tForm('sl', 'mig.pendingBanner', 1)).toBe('1 migracija čaka na DDL korak na strežniku.')
    expect(tForm('sl', 'mig.pendingBanner', 2)).toBe('2 migraciji čakata na DDL korak na strežniku.')
    expect(tForm('sl', 'mig.pendingBanner', 3)).toBe('3 migracije čakajo na DDL korak na strežniku.')
    expect(tForm('sl', 'mig.pendingBanner', 5)).toBe('5 migracij čaka na DDL korak na strežniku.')
    expect(tForm('sl', 'mig.pendingBanner', 21)).toBe('21 migracij čaka na DDL korak na strežniku.')
    expect(tForm('hr', 'mig.pendingBanner', 2)).toBe('2 migracije čekaju DDL korak na serveru.')
    expect(tForm('hr', 'mig.pendingBanner', 5)).toBe('5 migracija čeka DDL korak na serveru.')
    // {n} izpolnjen tudi brez vars (regresijski pin bugfixa v1.270)
    expect(tForm('sl', 'mig.pendingBanner', 2)).not.toContain('{')
  })

  test('disc.uses/uporaba števci in eslog.lines na obstoječem noun.vrstica', () => {
    expect(tN('sl', 'disc.uses', 'uporaba', 1, { m: 10 })).toBe('uporaba 1/10')
    expect(tN('sl', 'disc.uses', 'uporaba', 2, { m: 10 })).toBe('uporabi 2/10')
    expect(tN('sl', 'disc.uses', 'uporaba', 3, { m: 10 })).toBe('uporabe 3/10')
    expect(tN('sl', 'disc.uses', 'uporaba', 5, { m: 10 })).toBe('uporab 5/10')
    expect(tN('sl', 'disc.unlimited', 'uporaba', 2)).toBe('uporabi: 2 (neomejeno)')
    expect(tN('hr', 'disc.unlimited', 'uporaba', 5)).toBe('uporaba: 5 (neograničeno)')
    expect(tN('sl', 'eslog.lines', 'vrstica', 1)).toBe('1 vrstica')
    expect(tN('sl', 'eslog.lines', 'vrstica', 2)).toBe('2 vrstici')
    expect(tN('sl', 'eslog.lines', 'vrstica', 3)).toBe('3 vrstice')
    expect(tN('sl', 'eslog.lines', 'vrstica', 8)).toBe('8 vrstic')
    expect(tN('hr', 'eslog.lines', 'vrstica', 8)).toBe('8 stavki')
  })

  test('redak (CRM vrstica) + odjava + ponovenNakup + razveljavitvenPremik sestava', () => {
    expect(tN('sl', 'crm.detail.eligible', 'redak', 1)).toBe('vrstica: 1')
    expect(tN('sl', 'crm.detail.eligible', 'redak', 2)).toBe('vrstici: 2')
    expect(tN('sl', 'crm.detail.eligible', 'redak', 5)).toBe('vrstic: 5')
    expect(tN('hr', 'crm.detail.eligible', 'redak', 2)).toBe('retka: 2')
    expect(tN('hr', 'crm.detail.eligible', 'redak', 5)).toBe('redaka: 5')
    expect(tN('sl', 'crm.detail.unsub', 'odjava', 2)).toBe('odjavi: 2')
    expect(tN('sl', 'crm.detail.unsub', 'odjava', 5)).toBe('odjav: 5')
    expect(tN('sl', 'crm.detail.repeat', 'ponovenNakup', 2, { days: 30 })).toBe('2 ponovna nakupa prejemnikov v 30 dneh po pošiljanju')
    expect(tN('sl', 'crm.detail.repeat', 'ponovenNakup', 5, { days: 30 })).toBe('5 ponovnih nakupov prejemnikov v 30 dneh po pošiljanju')
    expect(tN('sl', 'cmv.voidedCount', 'razveljavitvenPremik', 1)).toBe('1 razveljavitveno obračunan premik (kompenzacijski zapisi vidni)')
    expect(tN('sl', 'cmv.voidedCount', 'razveljavitvenPremik', 2)).toBe('2 razveljavitveno obračunana premika (kompenzacijski zapisi vidni)')
    expect(tN('sl', 'cmv.voidedCount', 'razveljavitvenPremik', 5)).toBe('5 razveljavitveno obračunanih premikov (kompenzacijski zapisi vidni)')
    expect(tN('hr', 'cmv.voidedCount', 'razveljavitvenPremik', 5)).toBe('5 poništavajuće obračunatih premica (kompenzacijski zapisi vidljivi)')
  })

  test('mig.appliedToast sestavljena zveza + toast trakci razcepa', () => {
    expect(tN('sl', 'mig.appliedToast', 'apliciranaMigracija', 1)).toBe('Aplicirana migracija: 1')
    expect(tN('sl', 'mig.appliedToast', 'apliciranaMigracija', 2)).toBe('Aplicirani migraciji: 2')
    expect(tN('sl', 'mig.appliedToast', 'apliciranaMigracija', 3)).toBe('Aplicirane migracije: 3')
    expect(tN('sl', 'mig.appliedToast', 'apliciranaMigracija', 5)).toBe('Apliciranih migracij: 5')
    expect(tN('hr', 'mig.appliedToast', 'apliciranaMigracija', 3)).toBe('Primijenjene migracije: 3')
    // razcepljeni trak: sestava z » · « v klicnem mestu (pin oblike vseh delov)
    expect(tN('sl', 'crm.campaigns.statsEligible', 'upravicen', 2)).toBe('upravičena: 2')
    expect(tN('sl', 'crm.campaigns.statsUnsub', 'odjava', 5)).toBe('odjav: 5')
    expect(tN('sl', 'crm.toast.previewUnsub', 'odjavljen', 3)).toBe('odjavljeni: 3')
    expect(t('sl', 'crm.toast.previewNoContact', { m: 4 })).toBe('brez kontakta: 4')
  })
})

// ── Č3) MONTAŽA — klicna mesta ──

describe('v1.271.0 Č3 — montaža klicnih mest (8 datotek)', () => {
  test('handheld: hh.unfired + hh.orderBarReady prek tN (stari t() odšli)', () => {
    const hh = read('src/app/handheld/page.tsx')
    expect(hh).toContain("tN('hh.unfired', 'neposlan', pend)")
    expect(hh).toContain("tN('hh.orderBarReady', 'pripravljen', readyCount)")
    expect(hh).not.toContain("t('hh.unfired', { n: pend })")
    expect(hh).not.toContain("t('hh.orderBarReady', { n: readyCount })")
  })

  test('dashboard: orders.moreItems prek tN', () => {
    const d = read('src/app/dashboard/page.tsx')
    expect(d).toContain("tN('orders.moreItems', 'ostal', rest)")
    expect(d).not.toContain("t('orders.moreItems', { n: rest })")
  })

  test('urniki: 3 komponente — lowStockMore/confirmHolidays/disc.* prek tN', () => {
    const u = read('src/components/tabs/urniki-tab.tsx')
    expect(u).toContain("tN('tc.lowStockMore', 'drug', clockInStock.count - clockInStock.items.length)")
    expect(u).toContain("tN('oh.confirmHolidays', 'praznikSL', data.holidays.length, { year: data.holidaysYear })")
    expect(u).toContain("tN('disc.uses', 'uporaba', d.currentUses, { m: d.maxUses })")
    expect(u).toContain("tN('disc.unlimited', 'uporaba', d.currentUses)")
    expect(u.match(/const \{ t, tN \} = useI18n\(\)/g)?.length).toBe(3)
    expect(u).not.toContain("t('oh.confirmHolidays', { n:")
    expect(u).not.toContain("t('disc.uses', { n:")
  })

  test('enterprise: mig.appliedToast prek tN + pendingBanner prek tF', () => {
    const e = read('src/components/tabs/enterprise-tab.tsx')
    expect(e).toContain("tN('mig.appliedToast', 'apliciranaMigracija', okN)")
    expect(e).toContain("tF('mig.pendingBanner', pending.length)")
    expect(e).toContain('const { t, tN, tF } = useI18n()')
    expect(e).not.toContain("t('mig.appliedToast', { n: okN })")
    expect(e).not.toContain("t('mig.pendingBanner', { n: pending.length })")
  })

  test('crm-tab: toast trakci razcepljeni (join » · «), campaigns 4× tN, detail 6× tN', () => {
    const c = read('src/components/tabs/crm-tab.tsx')
    expect(c).toContain("tN('crm.toast.previewEligible', 'upravicen', res.audience.eligible ?? 0)")
    expect(c).toContain("tN('crm.toast.previewUnsub', 'odjavljen', res.audience.suppressed ?? 0)")
    expect(c).toContain("tN('crm.toast.dispatchSent', 'poslan', res.dispatch.sent ?? 0)")
    expect(c).toContain("tN('crm.toast.dispatchSkipped', 'izpuscen', res.dispatch.skipped ?? 0)")
    expect(c.match(/\]\.join\(' · '\)/g)?.length).toBe(2)
    expect(c).toContain("tN('crm.campaigns.statsEligible', 'upravicen', c.eligibleCount)}")
    expect(c).toContain("tN('crm.campaigns.statsUnsub', 'odjava', c.unsubscribedCount)}")
    expect(c).toContain("tN('crm.detail.eligible', 'redak', detail.performance.sentToProvider")
    expect(c).toContain("tN('crm.detail.sent', 'poslan', detail.performance.sentToProvider)")
    expect(c).toContain("tN('crm.detail.failed', 'neuspesen', detail.performance.failed)")
    expect(c).toContain("tN('crm.detail.skipped', 'izpuscen', detail.performance.skipped)")
    expect(c).toContain("tN('crm.detail.unsub', 'odjava', detail.performance.unsubscribed)")
    expect(c).toContain("tN('crm.detail.repeat', 'ponovenNakup', detail.performance.repeatOrders, { days: detail.performance.windowDays })")
    expect(c).not.toContain("t('crm.campaigns.stats', {")
    expect(c).not.toContain("t('crm.toast.previewDetail'")
    expect(c).not.toContain("t('crm.toast.dispatchDetail'")
    expect(c).not.toContain("t('crm.detail.sent', { n:")
  })

  test('cash-movements + nabava: voidedCount razveljavitvenPremik, eslog.lines vrstica', () => {
    const cmv = read('src/components/tabs/cash-movements-card.tsx')
    expect(cmv).toContain("tN('cmv.voidedCount', 'razveljavitvenPremik', data.summary.voidedCount)")
    expect(cmv).not.toContain("t('cmv.voidedCount', { n:")
    const n = read('src/components/tabs/nabava-tab.tsx')
    expect(n).toContain("tN('eslog.lines', 'vrstica', eslogResult.lines)")
    expect(n).not.toContain("t('eslog.lines', { n:")
  })
})

// ── Ž) REGISTRI ──

describe('v1.271.0 Ž — registri', () => {
  test('Ž1: verzija 1.271.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.282.0')
    expect(read('src/lib/version.ts')).toContain("'1.282.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.282.0')
  })

  test('Ž2: i18n pariteta SL/HR 4320/4320 (noun 148 = 37 skupkov × 4; neto +70)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    expect(Object.keys(sl).filter((k) => k.startsWith('noun.')).length).toBe(148)
  })

  test('Ž3: AUDIT doc-truth — veriga stanj 4231 → 4250 → 4320', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('4324 ključev SL in 4324 HR')
    expect(audit).toContain('POSODOBITEV (v1.271.0, množinske oblike IV')
    expect(audit).toContain('4250 → 4320')
    // zgodovinski vnosi nosijo SVOJE stanje (doc-truth od v1.270)
    expect(audit).toContain('4231 → 4250')
    expect(audit).toContain('4188 → 4231')
  })

  test('Ž4: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.282.0-email-determinizem')
  })
})
