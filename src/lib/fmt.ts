/**
 * v1.277.0 — ČISTI FORMATIRNO-MNOŽINSKI SLOJ (0 uvozov; strežniško + odjemalsko varen).
 *
 * Doktrina issue #71 (»ena funkcija = ena oblika«) je do v1.276 živela v
 * src/lib/client.ts — modulu z 'use client', ki ga API rute NE MOREJO uvažati.
 * Zato so potisna telesa in fail() napake v api/ izpisovale zneske s PIKO
 * (»12.50 €«) ob sosednji UI vejici (»12,50 €«) — ista družina nedoslednosti
 * kot v1.272/v1.273/v1.275 (diakritiki) in v1.276 (decimalna ločila), a na
 * backend površini, ki je bila izven takratnega skena (»src/components +
 * src/app BREZ api/«).
 *
 * Ta modul je sedaj EDINI vir resnice za oblike števil in množinske izbire;
 * client.ts in i18n/index.ts ga le re-izvozita (vsi obstoječi uvozi in
 * testni pini v276/v270/issue71 ostanejo zeleni, ker se uvozne poti ne
 * spreminjajo). 0 uvozov po konvenciji čistih slojev (equipment.ts,
 * documents.ts, order-hold.ts).
 *
 * ICU opomba (lekcija v1.276): skupinjenje tisočic za 'sl-SI' je odvisno od
 * CLDR različice prevajalnika (CI ubuntu Bun: BREZ groupanja »1234,50«;
 * peskovnik: Z ločilom »1.234,50«). Decimalna VEJICA in U+00A0 pred € sta
 * stabilni v obeh — testi za >1000 uporabljajo tolerančne regexe.
 */

export const fmtEUR = (n: number) =>
  new Intl.NumberFormat('sl-SI', { style: 'currency', currency: 'EUR' }).format(n)

/**
 * Issue #71 audit-12: ENOTNO oblikovanje števil za vse izpise meritev/vrednosti
 * (HACCP temperature, DDV stopnje, recepture …) — sl-SI decimalna VEJICA
 * (»4,2 °C«, »9,5 %«), ne pika. Ena sama funkcija = ena sama oblika.
 */
export const fmtNumSI = (n: number, opts?: { min?: number; max?: number; unit?: string }) =>
  `${new Intl.NumberFormat('sl-SI', {
    ...(opts?.min != null ? { minimumFractionDigits: opts.min } : {}),
    maximumFractionDigits: opts?.max ?? 2,
  }).format(n)}${opts?.unit ?? ''}`

/**
 * v1.276.0: fiksno število decimalnk po vzorcu toFixed(N), a v sl-SI obliki
 * (vejica + ločilo tisočic) — »12,50«, ne »12.50«. min === max === N nadomesti
 * surove `${n.toFixed(N)}` izpise (ista doktrina issue #71: ena funkcija =
 * ena oblika; surovi toFixed izpiše PIKO ob sosednjih vejicah).
 */
export const fmtFixedSI = (n: number, digits: number, unit?: string) =>
  `${new Intl.NumberFormat('sl-SI', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)}${unit ?? ''}`

/**
 * QA-val v1.270.0 — oblika za števnik kot samostojna funkcija (eno samo mesto
 * resnice). nounKey jo deli za noun.* ključe; tForm() pa za CELO-predložne
 * variante (hh.unpaidWarn.1/.2/.34/.n — kjer se z besedo preobrača tudi
 * GLAGOL: »1 postavka ni poslana · 2 postavki nista poslani · 3 postavke
 * niso poslane · 5 postavk ni poslanih«; nagiba se ne da sestaviti iz delov).
 *
 * (Preseljeno iz src/lib/i18n/index.ts v v1.277.0 — i18n ga re-izvozi;
 * eno samo mesto resnice, strežniško dostopno brez vlečenja slovarjev.)
 */
export function pluralForm(n: number): '1' | '2' | '34' | 'n' {
  const v = Math.abs(Math.trunc(n))
  if (!Number.isFinite(v)) return 'n'
  if (v === 1) return '1'
  if (v === 2) return '2'
  if (v === 3 || v === 4) return '34'
  return 'n'
}

/**
 * v1.277.0 — slovenske množinske besede za BACKEND nize (OPS-8 konvencija:
 * backend besedila so SL literali, ne slovarski ključi — kot orderWord v
 * hourly-email.ts, v1.206, le posplošen). Besede za racun/vrstica/postavka/
 * oseba so IDENTIČNE slovarskim noun.<id>.* vrednostim (src/lib/i18n/sl.ts)
 * in se morajo z njimi usklajevati; kos in dan v slovarjih ne obstajata
 * (backend specifična; v1.278.0 dan za reservation-slots maxAdvanceDays).
 * HR push telesa so izven obsega (današnja stanja: vsa push
 * telesa so SL literali).
 *
 *   1 račun · 2 računa · 3 računi · 5 računov
 *   1 vrstica · 2 vrstici · 3 vrstice · 5 vrstic
 *   1 postavka · 2 postavki · 3 postavke · 5 postavk
 *   1 kos · 2 kosa · 3 kosi · 5 kosov
 *   1 oseba · 2 osebi · 3 osebe · 5 oseb
 *   1 dan · 2 dneva · 3 dni · 5 dni   (3/4 in 5+ oblika sta isti »dni«)
 */
export const SL_NOUNS = {
  racun: ['račun', 'računa', 'računi', 'računov'],
  vrstica: ['vrstica', 'vrstici', 'vrstice', 'vrstic'],
  postavka: ['postavka', 'postavki', 'postavke', 'postavk'],
  kos: ['kos', 'kosa', 'kosi', 'kosov'],
  oseba: ['oseba', 'osebi', 'osebe', 'oseb'],
  dan: ['dan', 'dneva', 'dni', 'dni'],
} as const

export type SlNounId = keyof typeof SL_NOUNS

/** Samo beseda v pravilni obliki za števnik n (»3 računi« → slNoun vrne »računi«). */
export function slNoun(n: number, noun: SlNounId): string {
  const words = SL_NOUNS[noun]
  const form = pluralForm(n)
  return form === '1' ? words[0] : form === '2' ? words[1] : form === '34' ? words[2] : words[3]
}

/**
 * Cel števnik z besedo: »1 račun«, »2 računa«, »3 računi«, »5 računov«.
 * Številka gre skozi sl-SI formatiranje (ločilo tisočic za velike števce),
 * beseda skozi slNoun. Za potisna telesa v api/ (»12 računov« namesto
 * trdo kodiranega rodilnika za vse števnike).
 */
export function slCount(n: number, noun: SlNounId): string {
  return `${new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 0 }).format(n)} ${slNoun(n, noun)}`
}

/**
 * Časovni žig kartice naročila (v1.279.0, revizija produkcije v1.278.0 — najdba 2):
 * naročila, ustvarjena DANES, nosijo samo uro (»07:28«); naročila iz prejšnjih
 * dni nosijo DATUM pred uro (»31. 10. 07:28«) — brez datuma je več dni staro
 * demo/zastarelo naročilo na seznamu videti kot današnje (doktrina issue #70 §2:
 * zastarelo NE izgine, a mora biti prepoznavno; KDS ima ločo od v1.121.0).
 *
 * Ročna konstrukcija DD. MM. HH:MM (ne toLocaleString) — DETERMINISTIČNO v vseh
 * okoljih (lekcija v1.276 CI-fix: ICU runnerjev se razlikujejo v groupanju
 * tisočic; datum ima enako past). Sl in HR oblika sta identični.
 * `now` parameter je namenjen testom (deterministični »danes«).
 */
export function fmtStampSI(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return time
  return `${p(d.getDate())}. ${p(d.getMonth() + 1)}. ${time}`
}
