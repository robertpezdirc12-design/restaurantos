/**
 * Issue #70 §1 (P1, v1.121.0) — POENOTENA oznaka stanja mize.
 *
 * VŽIVI vzrok (produkcija v1.119.0, demo): mize 1/2/3/6 so imele v DB
 * Table.status = 'occupied' BREZ aktivnega naročila (zastarelo demo stanje).
 * Nadzorna PLOŠČA (dashboard) je oznako izrisala iz tb.status → "Zasedena",
 * HANDHELD pa pogojno iz tb.activeOrder → "Na voljo" (barva ploščice je bila
 * celo oranžna!). Isti nabor podatkov, dve različni izpeljavi.
 *
 * REŠITEV: /api/tables (mapTable) je EDINI kanonični vir — status OCCUPIED
 * pomeni AKTIVNO naročilo; miza 'occupied' brez naročila se samodejno prikaže
 * kot DIRTY ("za pospraviti" — enak končni status, kot ga nastavita plačilo/
 * storno/preklic naročila). OZNaka v UI je potem ČISTA funkcija tb.status:
 * ta modul preslika kanonični status na i18n ključ, da handheld in tablica
 * uporabljata DOBESEDNO isto preslikavo (dashboard ima svojo stL tabelo z
 * istim statusnim slovarjem — FREE/OCCUPIED/RESERVED/DIRTY).
 *
 * Modul je ČIST (brez uvozov) — varen za client bundle.
 */

/** Kanonični status mize → i18n ključ oznake (vsi štirje statusi + fallback). */
export const TABLE_STATUS_LABEL_KEYS: Record<string, string> = {
  FREE: 'tables.available',
  OCCUPIED: 'tlb.occupied',
  RESERVED: 'tables.reserved',
  DIRTY: 'tables.clickClean',
}

/**
 * Issue #70 §1: i18n ključ oznake mize IZKLJUČNO iz kanonskega statusa
 * (kar vrne /api/tables). Neznan status → "Na voljo" (konzervativno).
 */
export function tableStatusLabelKey(status: string): string {
  return TABLE_STATUS_LABEL_KEYS[status] ?? 'tables.available'
}
