/**
 * Issue #7 (P1, v1.104.0) — KANONIČNI KATALOG 14 ZAKONSKO DOLOČENIH ALERGENOV.
 *
 * Uredba (EU) št. 1169/2011, Priloga II — obvezno označevanje za nepredpakirana
 * živila (restavracije vključno). To je ENOTEN VIR RESNICE za strukturirane kode:
 * InventoryItem.allergens (sestavina), izračun profila jedi (src/lib/allergen-profile.ts)
 * in posnetek na OrderItem (allergenSnapshot) hranijo IZKLJUČNO kode iz tega kataloga.
 *
 * Legacy prosto besedilo (MenuItem.allergens / Modifier.allergens, stari zapisi
 * "gluten, laktoza") se preslika prek ALIAS tabel (SL/HR/EN, brez diakritik) —
 * NEPORESLIKIVE oznake ostanejo vidne kot "unknown" in zahtevajo potrditev
 * osebja (nikoli se ne zavržejo in nikoli se ne zatruje "brez alergenov").
 *
 * Pure modul (brez DB) — varen za client bundle (QR/kiosk čipi).
 */

export type AllergenCode =
  | 'gluten'
  | 'crustaceans'
  | 'eggs'
  | 'fish'
  | 'peanuts'
  | 'soybeans'
  | 'milk'
  | 'nuts'
  | 'celery'
  | 'mustard'
  | 'sesame'
  | 'sulphites'
  | 'lupin'
  | 'molluscs'

export type AllergenLocale = 'sl' | 'hr' | 'en' | 'de' | 'it'

/** Kanonični vrstni red = Priloga II Uredbe 1169/2011 (razvrstitev po zaporedju). */
export const ALLERGEN_CODES: readonly AllergenCode[] = [
  'gluten',
  'crustaceans',
  'eggs',
  'fish',
  'peanuts',
  'soybeans',
  'milk',
  'nuts',
  'celery',
  'mustard',
  'sesame',
  'sulphites',
  'lupin',
  'molluscs',
] as const

const CODE_SET = new Set<string>(ALLERGEN_CODES)

export function isAllergenCode(code: unknown): code is AllergenCode {
  return typeof code === 'string' && CODE_SET.has(code)
}

/** Lokalizirane oznake (SL/HR/EN + DE/IT P3-21 v1.191.0) — enoten prikaz po vseh površinah (meni, QR, kiosk, KDS). */
export const ALLERGEN_LABELS: Record<AllergenLocale, Record<AllergenCode, string>> = {
  sl: {
    gluten: 'Gluten (pšenica, rž, ječmen, oves)',
    crustaceans: 'Raki',
    eggs: 'Jajca',
    fish: 'Ribe',
    peanuts: 'Arašidi',
    soybeans: 'Soja',
    milk: 'Mleko',
    nuts: 'Oreški',
    celery: 'Zeler',
    mustard: 'Gorčica',
    sesame: 'Sezam',
    sulphites: 'Sulfiti (žveplov dioksid)',
    lupin: 'Volčji bob',
    molluscs: 'Mehkužci',
  },
  hr: {
    gluten: 'Gluten (pšenica, raž, ječam, zob)',
    crustaceans: 'Rakovi',
    eggs: 'Jaja',
    fish: 'Riba',
    peanuts: 'Kikiriki',
    soybeans: 'Soja',
    milk: 'Mlijeko',
    nuts: 'Orašasti plodovi',
    celery: 'Celer',
    mustard: 'Gorušica',
    sesame: 'Sezam',
    sulphites: 'Sulfiti (sumporov dioksid)',
    lupin: 'Lupina',
    molluscs: 'Mekušci',
  },
  en: {
    gluten: 'Gluten (wheat, rye, barley, oats)',
    crustaceans: 'Crustaceans',
    eggs: 'Eggs',
    fish: 'Fish',
    peanuts: 'Peanuts',
    soybeans: 'Soybeans',
    milk: 'Milk',
    nuts: 'Nuts',
    celery: 'Celery',
    mustard: 'Mustard',
    sesame: 'Sesame',
    sulphites: 'Sulphites (sulphur dioxide)',
    lupin: 'Lupin',
    molluscs: 'Molluscs',
  },
  // P3-21 (v1.191.0): uradni izrazi iz Priloge II Uredbe (EU) 1169/2011 —
  // nemška in italijanska različica predpisa (deterministični EU termini)
  de: {
    gluten: 'Gluten (Weizen, Roggen, Gerste, Hafer)',
    crustaceans: 'Krebstiere',
    eggs: 'Eier',
    fish: 'Fisch',
    peanuts: 'Erdnüsse',
    soybeans: 'Sojabohnen',
    milk: 'Milch',
    nuts: 'Schalenfrüchte',
    celery: 'Sellerie',
    mustard: 'Senf',
    sesame: 'Sesamsamen',
    sulphites: 'Sulphite (Schwefeldioxid)',
    lupin: 'Lupinen',
    molluscs: 'Weichtiere',
  },
  it: {
    gluten: 'Glutine (frumento, segale, orzo, avena)',
    crustaceans: 'Crostacei',
    eggs: 'Uova',
    fish: 'Pesce',
    peanuts: 'Arachidi',
    soybeans: 'Soia',
    milk: 'Latte',
    nuts: 'Frutta a guscio',
    celery: 'Sedano',
    mustard: 'Senape',
    sesame: 'Semi di sesamo',
    sulphites: 'Solfiti (anidride solforosa)',
    lupin: 'Lupini',
    molluscs: 'Molluschi',
  },
}

/** Oznaka kode v izbranih jezikih (neznana koda → surova vrednost). */
export function allergenLabel(code: string, locale: AllergenLocale): string {
  const table = ALLERGEN_LABELS[locale]
  return isAllergenCode(code) ? table[code] : code
}

/** Oznake množice kod (kanonični vrstni red, ločene z vejico). */
export function allergenLabels(codes: string[], locale: AllergenLocale): string {
  const ordered = ALLERGEN_CODES.filter((c) => codes.includes(c))
  const extra = codes.filter((c) => !isAllergenCode(c))
  return [...ordered, ...extra].map((c) => allergenLabel(c, locale)).join(', ')
}

/* ────────── preslikava legacy prostega besedila → kanonične kode ────────── */

/** Odstrani diakritike + male črke + trim ("Mleko v prahu" → "mleko v prahu"). */
export function normalizeAllergenLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim()
}

/**
 * Alias tabele (ključi so normalizirane oblike). Pokrivajo pogoste SL/HR/EN
 * zapisane oznake iz obstoječih prostih nizov ("gluten", "laktoza", "pšenica").
 */
const ALIASES: Record<string, AllergenCode> = {
  // gluten / žita
  gluten: 'gluten', pscenica: 'gluten', pscenico: 'gluten', pscenicna: 'gluten', psceno: 'gluten',
  wheat: 'gluten', rz: 'gluten', rye: 'gluten', jecmen: 'gluten', jecam: 'gluten', barley: 'gluten',
  oves: 'gluten', zob: 'gluten', oats: 'gluten', spelta: 'gluten', kamut: 'gluten',
  moka: 'gluten', moki: 'gluten', brasno: 'gluten', flour: 'gluten', testenine: 'gluten',
  kruh: 'gluten', pasta: 'gluten', zdrob: 'gluten',
  // raki
  raki: 'crustaceans', rak: 'crustaceans', rakovi: 'crustaceans', kozice: 'crustaceans',
  kozica: 'crustaceans', scampi: 'crustaceans', jastog: 'crustaceans', lobster: 'crustaceans',
  shrimp: 'crustaceans', klapavica: 'crustaceans',
  // jajca
  jajca: 'eggs', jajce: 'eggs', jaja: 'eggs', jajcni: 'eggs', jajc: 'eggs', egg: 'eggs',
  eggs: 'eggs', rumenjak: 'eggs', beljak: 'eggs', majoneza: 'eggs', mayonnaise: 'eggs',
  // ribe
  ribe: 'fish', riba: 'fish', fish: 'fish', tuna: 'fish', losos: 'fish', salmon: 'fish',
  incun: 'fish', anchovy: 'fish', sardela: 'fish', sardine: 'fish', skusa: 'fish',
  mackerel: 'fish', ribji: 'fish', jegulja: 'fish', lososov: 'fish',
  // arašidi
  arasidi: 'peanuts', arasid: 'peanuts', arasidovo: 'peanuts', kikiriki: 'peanuts',
  peanut: 'peanuts', peanuts: 'peanuts', groundnut: 'peanuts', arasidova: 'peanuts',
  // soja
  soja: 'soybeans', sojin: 'soybeans', sojino: 'soybeans', soy: 'soybeans',
  soybeans: 'soybeans', tofu: 'soybeans', sojina: 'soybeans', sojine: 'soybeans',
  // mleko
  mleko: 'milk', mleka: 'milk', mlijeko: 'milk', mlecni: 'milk', mlijecni: 'milk',
  milk: 'milk', laktoza: 'milk', lactose: 'milk', smetana: 'milk', cream: 'milk',
  maslo: 'milk', butter: 'milk', sir: 'milk', cheese: 'milk', jogurt: 'milk',
  yogurt: 'milk', kefir: 'milk', skuta: 'milk', mascarpone: 'milk', ricotta: 'milk',
  // oreški
  oreski: 'nuts', oreh: 'nuts', orehi: 'nuts', oresast: 'nuts', nuts: 'nuts',
  mandelj: 'nuts', mandeljni: 'nuts', mandlji: 'nuts', almond: 'nuts', almonds: 'nuts',
  lesnik: 'nuts', lesniki: 'nuts', hazelnut: 'nuts', lesnikova: 'nuts', lesnikovi: 'nuts',
  orah: 'nuts', orechov: 'nuts', walnut: 'nuts', pistacija: 'nuts', pistachio: 'nuts',
  indijski: 'nuts', cashew: 'nuts', makadamija: 'nuts', macadamia: 'nuts',
  brazilski: 'nuts', pekani: 'nuts', pecan: 'nuts', nutella: 'nuts',
  // zeler
  zeler: 'celery', celer: 'celery', celery: 'celery', zelerev: 'celery',
  // gorčica
  gorcica: 'mustard', gorcico: 'mustard', gorcne: 'mustard', gorusica: 'mustard',
  gorusice: 'mustard', mustard: 'mustard', gorcnega: 'mustard',
  // sezam
  sezam: 'sesame', sezama: 'sesame', sesame: 'sesame', tahini: 'sesame',
  sezamovo: 'sesame', sezamova: 'sesame',
  // sulfiti
  sulfiti: 'sulphites', sulfit: 'sulphites', sulfidi: 'sulphites', sulphites: 'sulphites',
  sulfites: 'sulphites', zveplov: 'sulphites', sumporov: 'sulphites', so2: 'sulphites',
  sulphur: 'sulphites', sulfur: 'sulphites',
  // volčji bob
  volcji: 'lupin', bob: 'lupin', lupin: 'lupin', lupina: 'lupin',
  lupini: 'lupin',
  // mehkužci
  mehkuzci: 'molluscs', mekusc: 'molluscs', molluscs: 'molluscs', skoljke: 'molluscs',
  skoljka: 'molluscs', dagnje: 'molluscs', mussel: 'molluscs', mussels: 'molluscs',
  lignj: 'molluscs', lignji: 'molluscs', squid: 'molluscs', hobotnica: 'molluscs',
  octopus: 'molluscs', polz: 'molluscs', polzi: 'molluscs', kalamari: 'molluscs',
  lignje: 'molluscs', hobotnice: 'molluscs',
}

/** Besede, ki se pri razdelavi na besede preskočijo (nikoli same ne nosijo kode). */
const STOP_WORDS = new Set([
  'brez', 'ne', 'vsebuje', 'vsebovati', 'z', 's', 'in', 'ali', 'with', 'and', 'or',
  'no', 'without', 'free', 'containing', 'contains', 'may', 'lahko', 'v', 'na', 'the', 'of',
  'prahu', 'iz', 'za', 'ovo', 'jih', 'ter', 'oz', 'oz.',
])

/** Negativne predpone — "brez glutena" NI alergen, ampak izjava o odsotnosti. */
const NEGATIVE_PREFIXES = ['brez ', 'ne vsebuje', 'without ', 'no ', 'free ']

/**
 * Preslikava ene legacy oznake v kanonično kodo.
 * 1. cela normalizirana oznaka (natančna),
 * 2. besede ≥ 4 znake brez stop-besed (prva zadeta),
 * 3. sicer null (nepreslikljiva → "unknown", zahteva potrditev osebja).
 * Negativne izjave ("brez glutena") → null (izrecno, brez ugibanja).
 */
export function labelToAllergenCode(label: string): AllergenCode | null {
  const norm = normalizeAllergenLabel(String(label || ''))
  if (!norm) return null
  for (const neg of NEGATIVE_PREFIXES) {
    if (norm.startsWith(neg)) return null
  }
  const direct = ALIASES[norm]
  if (direct) return direct
  if (CODE_SET.has(norm)) return norm as AllergenCode
  for (const word of norm.split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue
    const hit = ALIASES[word] ?? (CODE_SET.has(word) ? (word as AllergenCode) : null)
    if (hit) return hit
  }
  return null
}

/**
 * Tolerantno branje alergenske vrednosti (stari prosti niz / JSON niz / array):
 * vrne kanonične kode + nepreslikljive oznake (unknown — vidne, nikoli zavržene).
 * Ne meče nikoli; vrstni rezultat = kanonični vrstni red kataloga.
 */
export function parseAllergenCodes(raw: unknown): { codes: AllergenCode[]; unknown: string[] } {
  let labels: string[] = []
  if (Array.isArray(raw)) {
    labels = raw.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
  } else if (typeof raw === 'string') {
    const s = raw.trim()
    if (s.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(s)
        if (Array.isArray(parsed)) {
          labels = parsed.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
        }
      } catch {
        /* padec na ločilno razčlembo */
      }
    }
    if (labels.length === 0 && s) {
      labels = s.split(/[,;/|]/).map((x) => x.trim()).filter(Boolean)
    }
  }
  const codeSet = new Set<AllergenCode>()
  const unknown: string[] = []
  const seenUnknown = new Set<string>()
  for (const label of labels) {
    const code = labelToAllergenCode(label)
    if (code) codeSet.add(code)
    else {
      const key = normalizeAllergenLabel(label)
      if (!seenUnknown.has(key)) {
        seenUnknown.add(key)
        unknown.push(label.slice(0, 80))
      }
    }
  }
  const codes = ALLERGEN_CODES.filter((c) => codeSet.has(c))
  return { codes, unknown }
}

/**
 * STRICT validacija za PISNE poti (samo kanonične kode smejo v strukturirane
 * stolpce). Vrne { codes, invalid } — invalid neprazna → klicatelj zavrne z 400.
 */
export function sanitizeAllergenCodeList(raw: unknown): { codes: AllergenCode[]; invalid: unknown[] } {
  if (!Array.isArray(raw)) return { codes: [], invalid: [raw] }
  const codes: AllergenCode[] = []
  const invalid: unknown[] = []
  for (const x of raw) {
    if (isAllergenCode(x)) {
      if (!codes.includes(x)) codes.push(x)
    } else {
      invalid.push(x)
    }
  }
  return { codes: ALLERGEN_CODES.filter((c) => codes.includes(c)), invalid }
}
