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
 * Poštene meje (dokumentirane v GAP OSS-11):
 *  - barva je ENA per znamka (akcent) — polne palete/temni načini ostajajo
 *    odprta izboljšava (B-ostanek);
 *  - logotip je URL (https) — nalaganje datotek je ločena izdaja (OSS-2 vzorec);
 *  - dashboard/POS osebja NE spreminjata barve (delovno orodje ostaja kamnito —
 *    razdejanje prepoznavnosti operativnih stanj ni marketinška površina).
 */

/** Integration row marker (name=..., type='other') — isti kontrakt kot kiosk-upsell. */
export const BRAND_THEMES_MARKER = 'brand-themes'

/** Gornja meja znamk v configu (vratar pred neomejenom rastjo — vzorec MAX_UPSELL_ITEMS). */
export const BRAND_THEME_MAX = 200

/** Gornja meja URL-ja logotipa. */
export const LOGO_URL_MAX = 500

/** Nastavitev teme za ENO znamko, kot je shranjena v config JSON. */
export interface BrandThemeSetting {
  accent: string
  logoUrl?: string
}

/** Config oblika v Integration vrstici: ključ = Brand.id. */
export interface BrandThemeConfig {
  [brandId: string]: BrandThemeSetting
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
    const logoUrl = sanitizeLogoUrl(rec.logoUrl)
    const setting: BrandThemeSetting = logoUrl ? { accent, logoUrl } : { accent }
    out[brandId] = setting
    kept += 1
  }
  return out
}

/**
 * Čista: tema za ENO znamko ali null (ni nastavljena = UI ostane nespremenjen).
 * textOn je IZPELJAN ob vsakem branju — v configu NI shranjen (ena resnica o
 * barvi, izpeljava je čista funkcija, ne drug shranjen podatek, ki bi lahko
 * razpadel od accent-a).
 */
export function themeForBrand(config: BrandThemeConfig, brandId: string | null | undefined): BrandThemeView | null {
  if (!brandId) return null
  const setting = config?.[brandId]
  if (!setting) return null
  const accent = parseAccentColor(setting.accent)
  if (!accent) return null
  return {
    accent,
    textOn: textOnAccent(accent),
    logoUrl: sanitizeLogoUrl(setting.logoUrl),
  }
}
