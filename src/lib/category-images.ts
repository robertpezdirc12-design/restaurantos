/**
 * ISSUE #74 V-7 (v1.135.0): fotografije artiklov na POS ploščicah.
 *
 * Merjena napaka v produkciji 1.132.0: `document.querySelectorAll('img').length`
 * na Hitri prodaji → 0 — vse ploščice so bile bele kartice z imenom in ceno.
 * Referenca (Square/Toast): vsaka ploščica nosi fotografijo.
 *
 * Dokler ni per-artikel fotografij v bazi, preslikava KATEGORIJA → slika
 * (10 kategorij, public/img/cat/*.jpg) da vsaki ploščici vizualno identiteto;
 * ploščice brez kategorije dobijo default.jpg. Čista preslikava niza — skupna
 * za dashboard (hitra prodaja) in handheld (isti vzorec).
 */

/** Vrstni red je POMENSKOVEN: specifičnejše pred splošnejšimi (kava pred pijačami). */
export const CATEGORY_IMAGE_RULES: { keys: string[]; img: string }[] = [
  { keys: ['kava', 'espresso', 'coffee'], img: '/img/cat/coffee.jpg' },
  { keys: ['pivo', 'beer'], img: '/img/cat/beer.jpg' },
  { keys: ['vino', 'vina', 'cviček', 'wine', 'penin', 'šampanj', 'champagn', 'sparkling'], img: '/img/cat/wine.jpg' },
  { keys: ['koktajl', 'cocktail'], img: '/img/cat/cocktails.jpg' },
  { keys: ['sok', 'cola', 'soft', 'brezalkohol', 'bezalkohol', 'pijač', 'pijac', 'pića', 'piće', 'mineralk', 'water'], img: '/img/cat/soft-drinks.jpg' },
  { keys: ['juh', 'supa', 'soup', 'sala', 'salat', 'solat'], img: '/img/cat/soup-salad.jpg' },
  { keys: ['slad', 'slastic', 'palačink', 'rezin', 'dessert', 'tort'], img: '/img/cat/desserts.jpg' },
  { keys: ['predjed', 'prigriz', 'starter', 'snack', 'tapas'], img: '/img/cat/starters.jpg' },
  { keys: ['jedi', 'jela', 'jelo', 'meso', 'žar', 'burger', 'pica', 'pizz', 'testenin', 'rižot', 'rib', 'klobas', 'burek', 'pečen'], img: '/img/cat/main.jpg' },
]

export const CATEGORY_IMAGE_DEFAULT = '/img/cat/default.jpg'

/**
 * Preslikava IMENA KATEGORIJE → URL fotografije (čista preslikava, testirljiva).
 * Male črke; prvi zadetek po VRSTNEM REDU pravil zmaga; brez zadetka → default.
 */
export function categoryImageForCategory(categoryName: string | null | undefined): string {
  const n = (categoryName ?? '').toLowerCase()
  if (n) {
    for (const rule of CATEGORY_IMAGE_RULES) {
      if (rule.keys.some((k) => n.includes(k))) return rule.img
    }
  }
  return CATEGORY_IMAGE_DEFAULT
}
