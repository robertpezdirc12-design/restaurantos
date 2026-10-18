/**
 * Issue #73 (v1.138.0) — audit-10 + audit-11: navigacijski model dashboarda.
 *
 * audit-10: pod 1024 px je ostajalo pet ikoničnih zavihkov (27 v gumbu ⋮ brez
 * oznake) — uporabnik ni videl, kaj aplikacija zna. Popravilo: stranski steber
 * s skupinami + iskalnik zavihkov (≥ lg), mobilna spodnja vrstica z 4–5 zavihki
 * DEJANSKE vloge uporabika + predal »Več« s celotnim drevesom.
 *
 * audit-11: besednjak je zdaj EN vir — komponente NE izumljajo lastnih imen
 * zavihkov (vsi naslovi so t(`tabs.${id}`) iz i18n slovarjev; preimenovanja
 * »Analiza menija«, »Razpored delovnih ur«, »Odprtost lokala«, »Smene« itn.
 * živijo v src/lib/i18n/{sl,hr}.ts).
 *
 * Ta lib je izvorna resnica za skupine zavihkov, vloge mobilne vrstice in
 * normalizacijo iskanja. DASHBOARD_TABS (id → ikona) živi v page.tsx
 * (tests/rbac-p2.test.ts N8 pogodba: vsak id ima izrecen vnos v TAB_PERM).
 */

import { tabHasPerm } from './tab-permissions'

/** Skupine stranskega stebra (Toast/Square vzorec, issue #71 audit-10). */
export const NAV_GROUP_KEYS = ['ops', 'guests', 'finance', 'staff', 'system'] as const
export type NavGroupKeyT = (typeof NAV_GROUP_KEYS)[number]

/** i18n ključi naslovov skupin (enoten besednjak — SL/HR slovarja). */
export const NAV_GROUP_LABEL_KEY: Record<NavGroupKeyT, string> = {
  ops: 'tabs.groupOps', guests: 'tabs.groupGuests', finance: 'tabs.groupFinance', staff: 'tabs.groupStaff', system: 'tabs.groupSystem',
}

/**
 * Zavihek → skupina. VSI zavihki iz DASHBOARD_TABS imajo vnos (fail-safe za
 * prihodnje: neznan id pade v »ops«). Prej je bilo zemljevid samo za zavihke
 * iz menija »Več«; stranski steber razstavlja VSE razdelke.
 */
export const NAV_GROUP_OF: Record<string, NavGroupKeyT> = {
  pregled: 'ops', mize: 'ops', narocila: 'ops', prodaja: 'ops', kuhinja: 'ops',
  meni: 'ops', rezervacije: 'ops', dostava: 'ops', cakalna: 'ops',
  zvestoba: 'guests', mnenja: 'guests', crm: 'guests', darilne: 'guests',
  racuni: 'finance', obracun: 'finance', stroski: 'finance', napitnine: 'finance',
  zaloge: 'finance', nabava: 'finance', odpad: 'finance', prenosi: 'finance',
  inzeniring: 'finance', popusti: 'finance',
  zaposleni: 'staff', izmene: 'staff', delovnicas: 'staff', urnik: 'staff', odpiralnicas: 'staff', haccp: 'staff',
  nastavitve: 'system', integracije: 'system', enterprise: 'system',
}

/** Skupina zavihka (neznan id → 'ops', fail-safe kot prej v meniju Več). */
export function navGroupOf(tabId: string): NavGroupKeyT {
  return NAV_GROUP_OF[tabId] ?? 'ops'
}

/**
 * Zavihki, ki se v stranskem stebri in predalu izrisujejo IZVEN skupin —
 * »Pregled« je domov (nad vsemi skupinami), ker ni del naročanja.
 */
export const NAV_STANDALONE_TABS = ['pregled'] as const

/**
 * audit-10: mobilna spodnja vrstica — 4–5 zavihkov, ki jih vloga DEJANSKO
 * potrebuje (ne splošni nabor). Dovoljenja vedno premagajo vlogo
 * (mobileTabsForRole filtrira s tabHasPerm — backend neodvisno).
 * Usklajeno z landingTab (začetni zavihek = prvi pristajalni zavihek vloge).
 */
export const MOBILE_ROLE_TABS: Record<string, string[]> = {
  OWNER: ['pregled', 'mize', 'racuni', 'zaposleni', 'nastavitve'],
  ADMIN: ['pregled', 'mize', 'racuni', 'zaposleni', 'nastavitve'],
  GROUP_OWNER: ['pregled', 'mize', 'racuni', 'zaposleni', 'nastavitve'],
  ORG_ADMIN: ['pregled', 'mize', 'racuni', 'zaposleni', 'nastavitve'],
  PROPERTY_MANAGER: ['pregled', 'mize', 'racuni', 'zaposleni', 'nastavitve'],
  MANAGER: ['pregled', 'mize', 'racuni', 'zaposleni', 'izmene'],
  KITCHEN: ['pregled', 'kuhinja', 'narocila', 'delovnicas', 'urnik'],
  CHEF: ['pregled', 'kuhinja', 'narocila', 'delovnicas', 'urnik'],
  BAR: ['pregled', 'prodaja', 'mize', 'narocila', 'izmene'],
  WAITER: ['pregled', 'mize', 'narocila', 'rezervacije', 'cakalna'],
  STAFF: ['pregled', 'mize', 'narocila', 'rezervacije', 'cakalna'],
  CLEANER: ['pregled', 'haccp', 'delovnicas', 'urnik'],
  WAREHOUSE: ['pregled', 'zaloge', 'nabava', 'prenosi', 'odpad'],
  ACCOUNTING: ['pregled', 'racuni', 'stroski', 'obracun', 'napitnine'],
}

/** Neznana/nedodeljena vloga → splošni nabor (enak prejšnji primarni vrstici). */
export const MOBILE_FALLBACK_TABS = ['pregled', 'mize', 'narocila', 'prodaja', 'kuhinja']

/**
 * Zavihki mobilne spodnje vrstice za vlogo: nabor vloge, filtriran z
 * tabHasPerm (UI gating; backend uveljavlja neodvisno). Če ostane < 2
 * uporabnih zavihkov (npr. prazna dovoljenja pred nalaganjem), pade na
 * dovoljene splošne oz. samo 'pregled' — nikoli prazna vrstica.
 */
export function mobileTabsForRole(
  uiRole: string | null | undefined,
  ctx: { canManage: boolean; perms: string[] },
): string[] {
  const role = (uiRole || '').toUpperCase()
  const wanted = MOBILE_ROLE_TABS[role] ?? MOBILE_FALLBACK_TABS
  const allowed = wanted.filter((v) => tabHasPerm(v, ctx))
  if (allowed.length >= 2) return allowed
  const fallback = MOBILE_FALLBACK_TABS.filter((v) => tabHasPerm(v, ctx))
  return fallback.length > 0 ? fallback : ['pregled']
}

/**
 * Iskanje po naslovih zavihkov brez diakritike: poizvedba »racuni« najde
 * »Računi«, »smene« najde »Smene«, »pronadi« najde HR »Pronađi« (č/ć/š/ž/đ se
 * normalizirajo v osnovne črke — đ je sestavljena črka, NFD je ne razstavi).
 * Uporabno tudi za iskanje po id-jih (angleški vzdevki: »crm«, »haccp«).
 */
export function normNavText(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}
