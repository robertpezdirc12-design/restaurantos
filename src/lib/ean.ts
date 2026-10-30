/**
 * OSS-9 (v1.202.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — EAN / črtne
 * kode pri nabavi. Čist determinističen sloj: 0 odvisnosti, 0 I/O, 0 AI —
 * samo funkcije (pravilo lastnika: »samo skripte«).
 *
 * Kontekst: dobaviteljeve črtne kode so dveh vrst — (a) GS1 standardne
 * (EAN-13 / EAN-8 / UPC-A, preverljiv kontrolni modul-10) in (b) interne
 * alphanumeric kode dobavitelja. Vnosa ZARADI kontrolne številke nikoli ne
 * blokiramo (interne kode niso GS1) — izračun je opozorilo v UI + dokaz v
 * testih. Zaloga InventoryItem.ean: prazen niz = artikel brez EAN.
 */

/** Največja dolžina kode (GS1 najdaljša standardna = 13; interne do 48). */
export const EAN_MAX_LEN = 48
/** Najmanjša dolžina kode (prazno = brez EAN; koda < 3 je napaka vnosa). */
export const EAN_MIN_LEN = 3

/**
 * Normalizacija vnosa skenerja/ročnega vnosa. Skener = tipkovnica (keyboard
 * wedge): vpiše kodo + Enter. Trim, vsi presledki ven (EAN nikoli ne vsebuje
 * presledkov; naključni presledek pri ročnem vnosu je pogosta napaka),
 * uppercase (alphanumeric interne kode — velikost ne sme ločevati dveh
 * zapisov iste kode). Vrne '' za prazen vnos.
 */
export function normalizeEan(input: string): string {
  return String(input ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase()
}

export type EanFormatError = 'too_short' | 'too_long' | 'bad_chars'

/**
 * Validacija oblike (po normalizaciji). Dovoljeni znaki: številke, črke,
 * pomišljaj in podčrtaj (interne kode). Prazno = brez EAN (veljavno).
 * Striktno: brez presledkov, brez ločil — koda se vpiše ENOJNO.
 */
export function validateEanFormat(ean: string): { ok: boolean; error?: EanFormatError } {
  const code = String(ean ?? '')
  if (code === '') return { ok: true }
  if (code.length < EAN_MIN_LEN) return { ok: false, error: 'too_short' }
  if (code.length > EAN_MAX_LEN) return { ok: false, error: 'too_long' }
  if (!/^[0-9A-Z_-]+$/.test(code)) return { ok: false, error: 'bad_chars' }
  return { ok: true }
}

/**
 * GS1 mod-10 kontrolna številka (EAN-13/EAN-8/UPC-A — isti algoritem, splošno
 * po pravilu »od desne brez zadnje števke, uteži izmenično 3,1,3,1…«).
 * Vrne null, če vhod ni čisto številčen ali prekratek od 2 števk.
 */
export function gs1CheckDigit(payloadDigits: string): number | null {
  const digits = String(payloadDigits ?? '')
  if (!/^[0-9]+$/.test(digits) || digits.length < 2) return null
  let sum = 0
  // obišči od zadaj naprej; prva (najdesnejša) dobi utež 3, naslednja 1, …
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i])
    sum += i % 2 === 0 ? d * 3 : d * 1
  }
  return (10 - (sum % 10)) % 10
}

export type EanKind = 'ean13' | 'ean8' | 'upca' | 'code'

/**
 * Klasifikacija normalizirane kode: GS1 oblike (13/8/12 števk) dobi kind in
 * checkValid=true/false; vse ostalo je 'code' (interne koda) z checkValid=null.
 */
export function classifyEan(code: string): { kind: EanKind; checkValid: boolean | null } {
  const c = String(code ?? '')
  if (/^[0-9]{13}$/.test(c)) {
    const check = gs1CheckDigit(c.slice(0, 12))
    return { kind: 'ean13', checkValid: check === null ? null : check === Number(c[12]) }
  }
  if (/^[0-9]{8}$/.test(c)) {
    const check = gs1CheckDigit(c.slice(0, 7))
    return { kind: 'ean8', checkValid: check === null ? null : check === Number(c[7]) }
  }
  if (/^[0-9]{12}$/.test(c)) {
    const check = gs1CheckDigit(c.slice(0, 11))
    return { kind: 'upca', checkValid: check === null ? null : check === Number(c[11]) }
  }
  return { kind: 'code', checkValid: null }
}
