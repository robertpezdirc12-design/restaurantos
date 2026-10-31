/**
 * OSS-11 (v1.213.0) — TEME PO ZNAMKI — čisti sloj, 0 uvozov.
 *
 * Vzorec Gap analize (TastyIgniter themes): akcentna barva + logotip na ravni
 * BLAGOVNE ZNAMKE (Brand), ne lokacije — Org → Brand → Property → Location že
 * obstaja (Issue #11 §1), lokacija pripada brandi prek Location.propertyId →
 * Property.brandId (src/lib/tenant.ts chainForLocation). Ta sloj doda RAZRED
 * teme in njegovo deterministično validacijo; shranjevanje je ZERO DDL —
 * Integration vrstica (name='brand-themes', type='other') z config JSON
 * { [brandId]: { accent, logoUrl? } } (isti vzorec kot kiosk-upsell).
 *
 * Zakaj A-del: GAP OSS-11 je nosil oznako »B (oblikovna odločitev)« — ta val
 * sledi dokazanemu vzorcu N-27-3 (noge doplačil): KONFIGURACIJA pretvori
 * oblikovno odločitev v UPORABNIŠKI VHOD. Lastnik v UI izbere barvo/logotip
 * per znamka; sistem ga deterministično validira (SAMO hex, SAMO https) in
 * uporabi na gostovskih površinah. Brez nastavljene teme = izgled nespremenjen
 * (aditivni ključ `theme` v javnih odgovorih — absent = byte-identično).
 *
 * OSS-11 B-del (v1.214.0) — NALAGANJE LOGOTIPA KOT DATOTEKE (meja A-dela:
 * »logotip je URL (nalaganje datotek = ločena izdaja po OSS-2 vzorcu)« — ta
 * val JE ta izdaja): bajti živijo v LOČENI Integration vrstici
 * (name='brand-logos') kot base64 { [brandId]: { mime, data } } — ZERO DDL,
 * isti substrat kot teme. Vrstica 'brand-themes' OSTANE LAHKA (javne rute jo
 * berejo ob vsakem klicu): nosi samo ZASTAVICO `logoUploaded: true`, iz katere
 * čisti sloj IZPELJE pot do javne rute bajtov (`publicLogoPath`). Bajte streže
 * SAMO /api/public/brand-logo/[brandId] (tam se tudi ponovno preverijo —
 * magic bytes morajo soglašati z shranjenim mime, tudi če je vrstico kdo
 * ročno pokvaril; nosniff + allowlist brez SVG/HTML = ni inline izvedbe
 * tveganja, vzorec documents.ts). Naložena DATOTEKA PREMAGA URL (izrecna
 * prednostnost — deterministično; odstranitev datoteke vrne URL v veljavnost).
 *
 * Poštene meje (dokumentirane v GAP OSS-11):
 *  - barva je ENA per znamko (akcent) — polne palete/temni načini ostajajo
 *    odprta izboljšava (B-ostanek);
 *  - logotip je URL (https) ALI naložena datoteka (PNG/JPEG/WebP/GIF,
 *    ≤ 512 kB raw) — datoteka premaga URL, kadar obstaja;
 *  - logotip se prikaže SAMO z nastavljeno akcentno barvo (tema = barva +
 *    logotip kot celota — brez barve ni teme, v213 pogodba);
 *  - dashboard/POS osebja NE spreminjata barve (delovno orodje ostaja kamnito —
 *    razdejanje prepoznavnosti operativnih stanj ni marketinška površina).
 */

/** Integration row marker (name=..., type='other') — isti kontrakt kot kiosk-upsell. */
export const BRAND_THEMES_MARKER = 'brand-themes'

/** Integration row marker za shranjene BAJTE logotipov (ločena vrstica — težka). */
export const BRAND_LOGOS_MARKER = 'brand-logos'

/** Gornja meja znamk v configu (vratar pred neomejenom rastjo — vzorec MAX_UPSELL_ITEMS). */
export const BRAND_THEME_MAX = 200

/** Gornja meja ZAPISOV logotipov v shrambi bajtov (vratar, isti razred kot BRAND_THEME_MAX). */
export const BRAND_LOGO_MAX = 200

/** Gornja meja URL-ja logotipa. */
export const LOGO_URL_MAX = 500

/** Budget ENEGA logotipa: 512 kB RAW (base64 ≈ 698 kB) — documents.ts vzorec (1 MB), logotipi so manjši. */
export const MAX_LOGO_BYTES = 512_000

/** Skupni budget shrambe bajtov logotipov (vsota raw velikosti vseh znamk). */
export const MAX_LOGO_STORE_BYTES = 8_000_000

/** Nastavitev teme za ENO znamko, kot je shranjena v config JSON. */
export interface BrandThemeSetting {
  accent: string
  logoUrl?: string
  /** true = za to znamko obstaja NALOŽEN logotip (bajti v brand-logos vrstici) — pot izpelje themeForBrand. */
  logoUploaded?: true
}

/** Config oblika v Integration vrstici: ključ = Brand.id. */
export interface BrandThemeConfig {
  [brandId: string]: BrandThemeSetting
}

/** En shranjen logotip (base64 MIME vsebina) v brand-logos vrstici. */
export interface BrandLogoSetting {
  mime: string
  data: string
}

/** Config oblika shrambe bajtov: ključ = Brand.id. */
export interface BrandLogoConfig {
  [brandId: string]: BrandLogoSetting
}

/** Pogled teme, ki gre do javnih odgovorov in UI (textOn izpeljan, ne shranjen). */
export interface BrandThemeView {
  accent: string
  textOn: string
  logoUrl: string | null
}

/**
 * Čista: sprejme SAMO hex barvo (#RGB ali #RRGGBB), normalizira na #rrggbb.
 * Imena barv, rgb()/hsl() in vsi drugi nizi so ZAVRNJENI (deterministično,
 * brez CSS vstavljanja — hex ne more nositi ničesar drugega kot barvo).
 * Garbage → null (fail-soft, klicatelj ključ izpusti).
 */
export function parseAccentColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (!s.startsWith('#')) return null
  const hex = s.slice(1)
  if (hex.length === 3) {
    if (!/^[0-9a-f]{3}$/.test(hex)) return null
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
  }
  if (hex.length === 6) {
    if (!/^[0-9a-f]{6}$/.test(hex)) return null
    return `#${hex}`
  }
  return null
}

/** Relativna svetilnost sRGB kanala (WCAG 2.x): linearnizacija + gama razširitev. */
function channelLum(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/**
 * Čista: črnilo (#000000 ali #ffffff) z VIŠJO kontrastnostjo na akcentu
 * (WCAG 2.x relativna svetilnost; prag 4.5 ni uporabljen kot veto — izbere se
 * vedno boljši od obeh, sicer bi temne blagovne znamke dobile neberljiv tekst).
 * Izrecno determinističen izbor: izenačeni primeri (popolnoma srednja sivina)
 * padejo na #ffffff (isti rezultat na vseh okoljih — brez locale/okoljske
 * odvisnosti, kot je pravilo v v212 agregaciji izrecno uveljavljeno).
 */
export function textOnAccent(accent: string): string {
  const hex = parseAccentColor(accent)
  if (!hex) return '#000000'
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const l = 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b)
  const contrastOnWhite = 1.05 / (l + 0.05)
  const contrastOnBlack = (l + 0.05) / 0.05
  return contrastOnWhite >= contrastOnBlack ? '#ffffff' : '#000000'
}

/** Čista: https URL logotipa ali null (http, data:, js:, presledki, kontrolni znaki → null). */
export function sanitizeLogoUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > LOGO_URL_MAX) return null
  if (!s.startsWith('https://')) return null
  // presledki/kontrolni znaki v URL niso veljavni in so preprost znak garbage vnosa
  if (/[\s\u0000-\u001f]/.test(s)) return null
  return s
}

/** Čista: validen id kandidat (trim, ne-prazen) — ista disciplina kot cleanId v upsell. */
function cleanBrandId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s : null
}

/**
 * Čista: sanitizacija poljubnega payloada v BrandThemeConfig.
 *  - ne-objektni vhod (string/array/null/…) → {};
 *  - neznani brandId (ni v validBrandIds) so odvrženi — null pomeni »obstojnost
 *    ne preverjaj« (javno branje vrstice brez DB poizvedbe; VREDNOSTI se vseeno
 *    validirajo — fail-soft ostaja);
 *  - neveljaven accent → vnos odvržen; manjkajoč/neveljaven logoUrl → ključ izpuščen;
 *  - max BRAND_THEME_MAX znamk, vrstni red po PRVEM pojavu (deterministično).
 */
export function sanitizeBrandThemeConfig(
  raw: unknown,
  validBrandIds: Set<string> | null,
): BrandThemeConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: BrandThemeConfig = {}
  let kept = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= BRAND_THEME_MAX) break
    const brandId = cleanBrandId(key)
    if (!brandId) continue
    if (validBrandIds && !validBrandIds.has(brandId)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const rec = value as Record<string, unknown>
    const accent = parseAccentColor(rec.accent)
    if (!accent) continue
    const setting: BrandThemeSetting = { accent }
    const logoUrl = sanitizeLogoUrl(rec.logoUrl)
    if (logoUrl) setting.logoUrl = logoUrl
    // B-del (v1.214.0): zastavica naloženega logotipa — SAMO dobesedno true
    // ostaja (ostale vrednosti so garbage in, izpustijo se fail-soft).
    if (rec.logoUploaded === true) setting.logoUploaded = true
    out[brandId] = setting
    kept += 1
  }
  return out
}

/**
 * Pot do javne rute bajtov logotipa (izpelje jo čisti sloj — strežniška pot,
 * NIKOLI uporabniški vhod, zato ni sanitizacijskih vrat).<br>
 * B-del (v1.214.0): encodeURIComponent — brandId je lahko kateri koli niz.
 */
export function publicLogoPath(brandId: string): string {
  return `/api/public/brand-logo/${encodeURIComponent(brandId)}`
}

/**
 * Čista: tema za ENO znamko ali null (ni nastavljena = UI ostane nespremenjen).
 * textOn je IZPELJAN ob vsakem branju — v configu NI shranjen (ena resnica o
 * barvi, izpeljava je čista funkcija, ne drug shranjen podatek, ki bi lahko
 * razpadel od accent-a).
 *
 * B-del (v1.214.0) — izbor logotipa je DETERMINISTIČNA prednostnost:
 *   logoUploaded === true → javna pot bajtov (NALOŽENA DATOTEKA PREMJAGA URL);
 *   sicer → sanitiziran https URL (če obstaja);
 *   sicer → null (površina logotip ne nariše).
 * Oba vira sta v isti vrstici — zastavica in URL ne moreta razpasti drug od
 * drugega pri tem branju; ob odstranitvi datoteke zastavica pade in URL spet
 * velja (poštena reverzibilnost, brez tihe izgube vira).
 */
export function themeForBrand(config: BrandThemeConfig, brandId: string | null | undefined): BrandThemeView | null {
  if (!brandId) return null
  const setting = config?.[brandId]
  if (!setting) return null
  const accent = parseAccentColor(setting.accent)
  if (!accent) return null
  const logoUrl = setting.logoUploaded === true
    ? publicLogoPath(brandId)
    : sanitizeLogoUrl(setting.logoUrl)
  return {
    accent,
    textOn: textOnAccent(accent),
    logoUrl,
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * OSS-11 B-del (v1.214.0) — NALAGANJE LOGOTIPA KOT DATOTEKE (čisti del).
 *
 * Vzorec documents.ts (OSS-2): base64 vnos (FileReader.readAsDataURL izhod,
 * data: predpona se odreže), ČIST alphabet + dolžina % 4 == 0, velikost
 * IZRAČUNANA iz dolžine (brez dekodiranja pri validaciji), MIME allowlist.
 *
 * NAD vzorcem documents: mime ni ZAUPAN, ampak PREVERJEN — magic-byte prepoznavanje
 * (detectImageMime) mora soglašati z zahtevanim mime. Logotip se gostom riše
 * INLINE (<img>), zato bajti res morajo biti slika; SVG/HTML nista na listi in
 * ju prepoznavanje bajtov sploh ne prepozna (fail-closed na obeh vratih).
 * ──────────────────────────────────────────────────────────────────────────── */

/** MIME allowlist logotipov — BREZ SVG (skriptni vektor) in brez vseh ne-slik (documents vzorec). */
export const LOGO_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

const LOGO_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** Odreže `data:…;base64,` predpono (FileReader.readAsDataURL izhod) — čist input. */
export function stripLogoDataUrl(v: string): string {
  const m = /^data:[^;]*;base64,/i.exec(v)
  return m ? v.slice(m[0].length) : v
}

/** Veljaven čist base64 logotipa (brez data: URL predpone). */
export function isValidLogoBase64(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (s.length === 0 || s.length % 4 !== 0) return false
  return LOGO_B64_RE.test(s)
}

/** Poštena ocena raw velikosti iz base64 dolžine (documents.ts enaka aritmetika). */
export function logoBase64SizeBytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/**
 * Magic-byte prepoznavanje slike (deterministično, brez hevristike):
 * PNG (89 50 4E 47 0D 0A 1A 0A), JPEG (FF D8 FF), GIF (GIF87a/GIF89a),
 * WebP (RIFF…WEBP). Neznano → null (klicatelj zavrne — datoteka je vse, kar
 * je trdila, samo če bajti to tudi so).
 */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 12) return null
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  if (png) return 'image/png'
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (jpg) return 'image/jpeg'
  const gif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61 // GIF87a / GIF89a
  if (gif) return 'image/gif'
  const webp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 // RIFF
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  if (webp) return 'image/webp'
  return null
}

/** Dekodiranje base64 → bajti (atob je global na Bun/Node16+/brskalnikih — 0 uvozov ohranjenih). */
export function decodeBase64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  if (!isValidLogoBase64(b64)) return null
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export interface ParsedLogoUpload {
  /** kanonični (s pipanjem soglašajoči) mime */
  mime: string
  /** čist base64 (brez data: predpone) za shranjevanje */
  data: string
  sizeBytes: number
}

export type LogoUploadResult = { ok: true; value: ParsedLogoUpload } | { ok: false; error: string }

/**
 * Parse + validacija nalaganja logotipa (POST /api/brand-themes/logo telo).
 * Zahtevani mime mora biti iz allowliste IN bajti morajo z vonjavo soglašati
 * z njim (prepričevalna lažna datoteka ne gre skozi). Vrača čist base64,
 * kanonični mime in pošteno velikost.
 */
export function validateLogoUpload(mime: unknown, contentBase64: unknown): LogoUploadResult {
  if (typeof mime !== 'string' || !(LOGO_MIME_ALLOWLIST as readonly string[]).includes(mime)) {
    return { ok: false, error: 'Vrsta datoteke ni dovoljena (PNG, JPEG, WebP, GIF).' }
  }
  if (typeof contentBase64 !== 'string' || contentBase64.trim() === '') {
    return { ok: false, error: 'Vsebina datoteke (base64) je obvezna.' }
  }
  const data = stripLogoDataUrl(contentBase64.trim())
  if (!isValidLogoBase64(data)) {
    return { ok: false, error: 'Vsebina ni veljaven base64.' }
  }
  const sizeBytes = logoBase64SizeBytes(data)
  if (sizeBytes === 0) {
    return { ok: false, error: 'Datoteka je prazna.' }
  }
  if (sizeBytes > MAX_LOGO_BYTES) {
    return { ok: false, error: `Logotip presega omejitev ${Math.round(MAX_LOGO_BYTES / 1000)} kB.` }
  }
  const bytes = decodeBase64ToBytes(data)
  if (!bytes) return { ok: false, error: 'Vsebina ni bila moč prebrati.' }
  const sniffed = detectImageMime(bytes)
  if (!sniffed) {
    return { ok: false, error: 'Vsebina ni prepoznana kot slika (PNG, JPEG, WebP, GIF).' }
  }
  if (sniffed !== mime) {
    return { ok: false, error: `Vrsta datoteke ne ustreza vsebini (${sniffed}).` }
  }
  return { ok: true, value: { mime: sniffed, data, sizeBytes } }
}

/**
 * Čista: sanitizacija shrambe bajtov logotipov ob BRANJU (fail-soft — ročno
 * pokvarjena vrstica ne sme podreti niti branja teme):
 *  - ne-objektni vhod → {};
 *  - neznani brandId odvržen (validBrandIds=null = brez obstojnostne poizvedbe);
 *  - mime izven allowliste / neveljaven base64 / velikost nad budgetom → vnos odvržen;
 *  - max BRAND_LOGO_MAX zapisov, vrstni red po prvem pojavu (deterministično).
 */
export function sanitizeBrandLogoConfig(
  raw: unknown,
  validBrandIds: Set<string> | null,
): BrandLogoConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: BrandLogoConfig = {}
  let kept = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= BRAND_LOGO_MAX) break
    const brandId = cleanBrandId(key)
    if (!brandId) continue
    if (validBrandIds && !validBrandIds.has(brandId)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const rec = value as Record<string, unknown>
    if (typeof rec.mime !== 'string' || !(LOGO_MIME_ALLOWLIST as readonly string[]).includes(rec.mime)) continue
    if (typeof rec.data !== 'string' || !isValidLogoBase64(rec.data)) continue
    if (logoBase64SizeBytes(rec.data) > MAX_LOGO_BYTES) continue
    out[brandId] = { mime: rec.mime, data: rec.data }
    kept += 1
  }
  return out
}

/** Skupna raw velikost vseh shranjenih logotipov (izračunana iz dolžin — brez dekodiranja). */
export function logoStoreTotalBytes(store: BrandLogoConfig): number {
  let total = 0
  for (const rec of Object.values(store)) total += logoBase64SizeBytes(rec.data)
  return total
}
