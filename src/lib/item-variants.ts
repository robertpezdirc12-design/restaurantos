/**
 * OSS-10 (v1.209.0) — VARIANTE ARTIKLOV (velikosti/nivoji) — čisti sloj, 0 uvozov.
 *
 * Vzorec Gap analize (OrderRestro planned »variants — sizes/levels«): varianta
 * NI nov model, temveč DETERMINISTIČNA uporaba obstoječega mehanizma skupin
 * opcij (ModifierGroup.required + maxSelect) — 0 DDL, ker stolpci obstajajo od
 * začetka (shema v1.0): obvezna skupina z NATANČNO eno izbiro = velikost/nivo
 * (»0,5 L«, »nivo pikantnosti 2«), prosta skupina = dodatki (»brez čebule«).
 *
 * Zakaj je to varianta in ne »samo modifikator«: gost jo IZBERE v gostovskih
 * tokovih (kiosk/QR/mobilni — uveljavljanje že v src/lib/modifiers.ts), strežnik
 * jo validira, cena doplačila se zlije v ceno vrstice (ops.ts), KDS jo vidi kot
 * detail naloge — ta sloj doda tisto, kar je manjkalo: RAZRED in SESTAVLJENO
 * PRIKAZNO IME (kuhinja na listu, kiosk v košarici), da »0,5 L« ne živi le v
 * ločenih podvrsticah, ampak postane del enolične opisne vrstice postavke.
 *
 * Poštena meja (dokumentirana v GAP analizi, OSS-10 vrstica): POS dashboard še
 * brez izbire opcij (le gostovski tokovi), poročila grupirajo po osnovnem imenu
 * artikla (razcep po varianti ostaja naslednji val), OrderItem.modifiersJson
 * ostaja '[]' (posnetek živi v OrderItemModifier vrsticah).
 */

/** Oblika skupine opcij, ki jo sloj potrebuje za razred (podmnožina ModifierGroup). */
export interface VariantGroupShape {
  required: boolean
  maxSelect: number | null
}

/**
 * Varianta = obvezna skupina z NATANČNO eno izbiro.
 * Prosta skupina (required=false ALI maxSelect≠1) NI varianta — dodatki se
 * seštevajo, velikost se ZAMENJUJE. Točno ta kontrakt uveljavlja predloga
 * »varianta« v admin kartici (required=true, minSelect=1, maxSelect=1).
 */
export function isVariantGroup(g: VariantGroupShape): boolean {
  return g.required === true && g.maxSelect === 1
}

/** Gornja meja imena skupine/opcije — enaka diskretnosti kot ostala polja menija. */
export const VARIANT_NAME_MAX = 120

/**
 * Prikazno ime postavke z izbranimi opcijami: »Pizza · 0,5 L, brez čebule«.
 * Fail-soft po vzorcu ostalih čistih slojev: NIKOLI ne meče — neznani vhod
 * (null/undefined/ne-niz) → osnovno ime ali 'Artikel' (enako mapOrderItem);
 * brez opcij ali z vsemi praznimi → osnovno ime NESPREMENJENO (nič se ne laže);
 * podvojeni/prazni nizi opcij se odstranijo; ločilo ' · ' ne Pride v navzkrižje
 * z obstoječimi imeni (menus POST že prepoveduje podvojena prikazna imena).
 */
export function orderItemDisplayName(
  itemName: unknown,
  optionNames?: readonly unknown[] | null,
): string {
  const base = typeof itemName === 'string' ? itemName.trim() : ''
  const name = base || 'Artikel'
  if (!Array.isArray(optionNames)) return name
  const opts = [...new Set(
    optionNames
      .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      .map((o) => o.trim()),
  )]
  if (opts.length === 0) return name
  return `${name} · ${opts.join(', ')}`
}
