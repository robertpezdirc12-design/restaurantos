/**
 * v1.251.0 (PRIMERJAVA-VMESNIKOV-2026 §25) — ČRTNA KODA RAČUNA (Code128-B).
 *
 * Toast januar 2026 (»Look up checks by scanning the receipt barcode« —
 * »now available to all Toast POS locations«): gost prinese račun nazaj
 * (vračilo/storno, tip, poizvedba), osebje SKENIRA črtno kodo z računa in
 * dokument se odpre — brez ročnega iskanja po seznamu zadnjih 100.
 *
 * Vsebina kode = receiptNumber (npr. »2026-11-42-BLG001«) — številka je ŽE
 * natisnjena človeku berljivo na računu, zato je ročni vnos (poškodovana
 * koda / brez skenerja) enostavna vrsta istega niza. Številka je unikatna
 * per lokacija (@@unique([locationId, receiptNumber])), skeniranje pa teče
 * v uporabnikovem lokacijskem obsegu — enako kot seznam računov.
 *
 * Pravila (ista kot src/lib/ean.ts, OSS-9):
 *  - ČIST determinističen sloj: 0 odvisnosti, 0 I/O, 0 AI — samo funkcije.
 *  - Code128-B: nabor ASCII 32–126 (številke, črke, pomišljaj — vse, kar
 *    format leto-mesec-seq-premises nosi). Start B (104) + podatki +
 *    kontrolna vsota (mod 103) + stop (106, 13 modulov).
 *  - Širine so v MODULIH (1 modul = najmanjša črta); klicalec jih skalerira
 *    na fizično širino (SVG viewBox).
 */

/** Code128 vzorci širin 0–106 (vsak 6 širin: črta, presledek, …; vsota 11 modulov).
 *  Vrednosti 0–94 = znaki Code B (ASCII − 32), 103/104/105 = start A/B/C,
 *  106 = stop (7 elementov, 13 modulov — posebej spodaj). */
const PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '231111',
]

/** Stop vzorec: 7 elementov (2,3,3,1,1,1,2) = 13 modulov — terminacijska črta. */
const STOP_PATTERN = '2331112'

/** Start B (vrednost 104) — nabor ASCII 32–126 brez preklopov. */
const START_B = 104
/** Stop (vrednost 106). */
const STOP = 106

/** Največja dolžina vhoda (varovalo pred nesmiselnim tiskom čez 80 mm). */
export const CODE128_MAX_INPUT = 48

/** Preveri, ali znak sodi v nabor Code128-B (ASCII 32–126). */
function code128bChar(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return c >= 32 && c <= 126
}

export interface Code128Bars {
  /** Zaporedje širin v modulih: črta, presledek, črta, … (vedno liho število,
   *  začne in konča s črto — skupaj z startom, kontrolno vsoto in stopom). */
  widths: number[]
  /** Skupno število modulov ČRTE (brez presledkov) — neodvisno od scalinga. */
  totalModules: number
}

/**
 * Code128-B enkodiranje: start B + znaki (ASCII − 32) + kontrolna vsota + stop.
 * Vrne null za prazen vhod, prekratek/predolg vhod ali znak izven nabora
 * (npr. č/š/ž) — klicalec črtno kodo tiho izpusti (tisk računa NIKOLI ne sme
 * pasti zaradi naključne številke, §18 print disciplina).
 */
export function encodeCode128b(input: string): Code128Bars | null {
  const s = String(input ?? '')
  if (s.length === 0 || s.length > CODE128_MAX_INPUT) return null
  for (const ch of s) {
    if (!code128bChar(ch)) return null
  }
  // vrednosti simbolov: start B + (ASCII − 32) po znaku
  const values: number[] = [START_B]
  for (const ch of s) values.push(ch.charCodeAt(0) - 32)
  // kontrolna vsota: start + Σ (pozicija od 1 × vrednost), mod 103
  let sum = START_B
  for (let i = 1; i < values.length; i++) sum += i * values[i]
  values.push(sum % 103)
  // širine: vsak vzorec razširi v 6 (stop v 7) širin
  const widths: number[] = []
  for (const v of values) {
    for (const d of PATTERNS[v]) widths.push(Number(d))
  }
  for (const d of STOP_PATTERN) widths.push(Number(d))
  // dokaz v testih: vsak vzorec razen stopa sešteje v 11, stop v 13
  const totalModules = widths.reduce((a, b) => a + b, 0)
  return { widths, totalModules }
}

/** Trenutna črta v zaporedju (lihi indeks = presledek) — pomoč za SVG. */
export function isBarElement(index: number): boolean {
  return index % 2 === 0
}

/**
 * Normalizacija vnosa skenerja/ročnega vnosa za iskanje računa.
 * Skener = tipkovnica (keyboard wedge): vpiše kodo + Enter; ročni vnos lahko
 * nosi vodilne/sledilne presledke ali presledke znotraj (npr. prenos iz
 * računa s prelomom). VELIKOST SE OHRANI — številka računa je zapisana
 * točno takšna, kot je natisnjena (premises del je lahko mešan), iskanje
 * same poskuša variante velikosti (glej /api/furs/lookup).
 */
export function normalizeReceiptScan(input: string): string {
  return String(input ?? '')
    .trim()
    .replace(/\s+/g, '')
}

/**
 * Variante za iskanje po velikosti črk: [kot-je-vpišano, velike, male].
 * Odpravi odstopanje velikosti premises oznake (ročni vnos po spominu);
 * podvojene vrednosti v SQL IN so neškodljive.
 */
export function receiptScanVariants(normalized: string): string[] {
  const raw = String(normalized ?? '')
  return [raw, raw.toUpperCase(), raw.toLowerCase()]
}

/** Tihi prostor (quiet zone) na vsako stran črtne kode — spec zahteva 10 modulov. */
export const CODE128_QUIET_MODULES = 10
