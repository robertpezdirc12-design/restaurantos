/**
 * ISSUE #73 audit-15 (v1.137.0) — podvojena prikazna imena artiklov.
 *
 * Problem (iz revizije): ploščice hitre prodaje z GOLIMI imeni prilagodb
 * (»Z gobami«, »S piščancem«) brez starša in podvojenimi imeni z različnima
 * cenama (»Bolognese 10,90 €« / »12,50 €«). Napačen tap v naglici =
 * izgubljen račun.
 *
 * Odločitev po reviziji:
 *  1. POŠILJAVNA stran (UI): ploščica »jed · različica · velikost« —
 *     jed = kategorija (overline v mešanem pogledu), različica = ime,
 *     velikost je del imena (»0,5 l«). V košari so dvoumna imena (isti
 *     niz na več artiklih) razločena s kontekstom kategorije.
 *  2. VNOSNA stran (API): prikazno ime je V KATEGORIJI EDINSTVENO —
 *     POST/PATCH zavrneta (409) normalizirano podvojeno ime.
 *     Podvojeno ime ČEZ kategorije je dovoljeno po zasnovi (»Bolognese«
 *     kot testenina in pica sta legitimna različna artikla) — njuno
 *     razločevanje v UI pokriva točka 1.
 *
 * Ena normalizacija za OBE strani (API primerja VNOS, UI primerja
 * prikaz): trim + collapse presledkov + lowercase. »Bolognese « in
 * »bolognese« sta isto prikazno ime.
 */

/** Normalizirano prikazno ime artikla (trim + en presledek + lowercase). */
export function normItemName(raw: string): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Vrstica z imenom artikla (id + ime + cena za sporočilo napake). */
export type ItemNameRow = { id: string; name: string; price: number | string }

/**
 * Vrne obstoječi artikel, katerega prikazno ime se (normalizirano) UJEMA s
 * kandidatom — sicer null. `excludeId` izpusti artikel sam (PATCH preimenovanje).
 */
export function findDuplicateDisplayName<T extends ItemNameRow>(
  rows: readonly T[],
  candidate: string,
  excludeId?: string,
): T | null {
  const n = normItemName(candidate)
  if (!n) return null
  return rows.find((r) => r.id !== excludeId && normItemName(r.name) === n) ?? null
}

/** Sporočilo napake za 409 (vnosna varovalka) — slovensko, z dokazom kolizije. */
export function dupItemNameMessage(dupe: ItemNameRow): string {
  const price = Number(dupe.price)
  const priceLbl = Number.isFinite(price) ? price.toFixed(2).replace('.', ',') : '—'
  return `Artikel s tem imenom že obstaja v tej kategoriji (»${dupe.name}«, ${priceLbl} €). Prikazno ime mora biti v kategoriji edinstveno — podvojeni ploščici v naročilnem toku povzročata napačen izbor.`
}
