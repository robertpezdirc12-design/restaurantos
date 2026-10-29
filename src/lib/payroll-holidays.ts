/**
 * P3 #19 (v1.192.0) — zakonsko brezdelovni dnevi (prazniki) SI/HR, ČISTI sloj.
 *
 * NAMEN: doplačilne osnove obračuna (docs/TRZNA-VRZELI-2026.md §4 #19) potrebujejo
 * minute, delane na državni praznik. To zahteva seznam praznikov — ta je za SI in
 * HR DETERMINISTIČEN (fiksni datumi + Velika noč po Gregorijanskem algoritmu,
 * čista aritmetika, brez I/O in brez AI). Biro potrdi odstotke — ta modul daje
 * SAMO datumsko osnovo po uradnih koledarjih.
 *
 * VZOREC (payroll.ts): vse funkcije PURE, brez DB in brez I/O — ruta in testi
 * kličejo brez baze. Datumi so lokalni koledarski dnevi 'YYYY-MM-DD' (isti format
 * kot localDateKey v payroll.ts — osnova za združevanje po dnevih je ISTA).
 *
 * MEJE (iskreno, kot noga izvoza): seznam pokriva uradne redne praznike SI/HR
 * (stanje koledarjev 2026; HR dan državnosti 30. 5. in dan spomina 18. 11. od
 * 2020). Ne zajema letalnih vzorcev (npr. odločitve o dodatnih prostih dnevih
 * po državnih zborih) — če lokacija dela po izjemi, biro osnovo potrdi/ popravi.
 * Neznana država → PRAZEN seznam (fail-safe: nedeljske/nočne osnove ostanejo,
 * prazniška kategorija je prazna, ne izmišljamo si praznikov).
 */

/** Velika noč (velikonočna nedelja) — Anonymous Gregorian algorithm (Meeus/
 * Jones/Butcher), čista celoštevilska aritmetika, veljaven 1583–4099. */
export function easterSundayISO(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** datum 'YYYY-MM-DD' + n dni → 'YYYY-MM-DD' (čisto UTC aritmetika — koledarski
 * dnevi brez časa, zato DST ne more vstopiti). */
export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/** Fiksni prazniki države (brez velike noči) — 'MM-DD' nizi. */
const FIXED: Record<string, string[]> = {
  SI: [
    '01-01', '01-02', // novo leto (2 dni)
    '02-08', // Prešernov dan, slovenski kulturni praznik
    '04-27', // dan upora proti okupatorju
    '05-01', '05-02', // praznik dela (2 dni)
    '06-25', // dan državnosti
    '08-15', // Marijino vnebovzetje
    '10-31', // dan reformacije
    '11-01', // dan spomina na mrtve
    '12-25', '12-26', // božič + dan samostojnosti in enotnosti
  ],
  HR: [
    '01-01', // Nova godina
    '01-06', // Bogojavljenje (Sveta tri kralja)
    '05-01', // Praznik rada
    '05-30', // Dan državnosti (od 2020)
    '06-22', // Dan antifašistične borbe
    '08-05', // Dan pobjede i domovinske zahvalnosti i dan hrvatskih branitelja
    '08-15', // Velika Gospa
    '11-01', // Svi sveti
    '11-18', // Dan sjećanja na žrtve Domovinskog rata (od 2020)
    '12-25', '12-26', // Božić + Sveti Stjepan
  ],
}

/** Uradni redni prazniki države za leto → sortirani 'YYYY-MM-DD'. Neznana
 * država → [] (fail-safe — dokumentirano na vrhu modula). */
export function statutoryHolidays(year: number, country: string): string[] {
  const fixed = FIXED[country]
  if (!fixed) return []
  const easter = easterSundayISO(year)
  const easterMonday = addDaysISO(easter, 1)
  if (country === 'HR') {
    // Božje telo = velikonočna nedelja + 60 dni (ponedljivi praznik HR)
    const corpusChristi = addDaysISO(easter, 60)
    return [...fixed.map((md) => `${year}-${md}`), easter, easterMonday, corpusChristi].sort()
  }
  return [...fixed.map((md) => `${year}-${md}`), easter, easterMonday].sort()
}

/** Nadzorna množica praznikov za lokalno obdobje [fromISO, toISO] (vključno)
 * → Set za O(1) pogled. Pokrije prehod čez leto (obdobje ≤ 62 dni ⇒ ≤ 2 leti):
 * vsebuje VSE redne praznikov obeh dotaknjenih let — dnevi izven obdobja se
 * seveda nikoli ne bodo ujemale z delavno izmeno, kar je neškodljivo in
 * dokumentirano. */
export function holidaysInRange(fromISO: string, toISO: string, country: string): Set<string> {
  const y1 = Number(fromISO.slice(0, 4))
  const y2 = Number(toISO.slice(0, 4))
  const out = new Set<string>()
  for (let y = y1; y <= y2; y++) for (const d of statutoryHolidays(y, country)) out.add(d)
  return out
}
