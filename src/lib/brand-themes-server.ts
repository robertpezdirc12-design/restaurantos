/**
 * OSS-11 (v1.213.0) — TEME PO ZNAMKI — strežniški sloj (DB + veriga).
 *
 * Ločitev po vzorcu upsell.ts / kiosk-upsell route: čisti sloj je v
 * brand-themes.ts (0 uvozov), DB dostop živi TUKAJ. Trije javni končniki
 * (menu, web-portal, pay, reservations) si delijo EN VIR resnice o temi
 * lokacije: Location → Property → Brand (chainForLocation) → config v
 * Integration vrstici → validiran pogled (parseAccentColor ob branju —
 * vrstica je lahko tudi ročno pokvarjena, fail-soft).
 *
 * ZERO DDL: shranjevanje = Integration(name='brand-themes', type='other'),
 * config JSON { [brandId]: { accent, logoUrl?, logoUploaded? } } — zapis skozi
 * PUT /api/brand-themes (sanitizacija proti ŽIVIM brand id-jem obsega).
 *
 * OSS-11 B-del (v1.214.0) — NALAGANJE LOGOTIPA: bajti živijo v LOČENI vrstici
 * Integration(name='brand-logos') kot base64 { [brandId]: { mime, data } }.
 * Vrstica 'brand-themes' ostane LAHKA — nosi samo zastavico logoUploaded, iz
 * katere čisti sloj izpelje pot (`publicLogoPath`); javne rute TEMA zato ne
 * berejo težke vrstice NIČ (bajte streže samo /api/public/brand-logo/[brandId],
 * kjer se ob vsakem odgovoru bajti PONOVNO preverijo z magic bytes —
 * obramba v globino, tudi nad ročno pokvarjeno vrstico).
 *
 * scopedBrandIds (v1.214.0, izluščeno iz admin rute — ena resnica obsega za
 * obe ruti /api/brand-themes*): bootstrap = VSI, ostali = znamke svoje
 * organizacije (chainForLocation → organizationId → db.brand.findMany).
 */
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import { chainForLocation, isBootstrapAdmin } from '@/lib/tenant'
import type { AuthPayload } from '@/lib/auth'
import {
  BRAND_THEMES_MARKER,
  BRAND_LOGOS_MARKER,
  sanitizeBrandThemeConfig,
  sanitizeBrandLogoConfig,
  themeForBrand,
  decodeBase64ToBytes,
  detectImageMime,
  type BrandThemeConfig,
  type BrandThemeView,
  type BrandLogoConfig,
} from '@/lib/brand-themes'

/** Surova config oblika iz Integration vrstice (vrednosti validirane ob branju). */
export async function loadBrandThemeConfig(): Promise<BrandThemeConfig> {
  const row = await db.integration.findFirst({ where: { name: BRAND_THEMES_MARKER, type: 'other' } })
  if (!row) return {}
  // validBrandIds = null → obstojnost znamk NE preverjamo (javno branje brez
  // dodatne poizvedbe); oblika + vrednosti se vseeno sanitizirajo (fail-soft).
  return sanitizeBrandThemeConfig(jparse<unknown>(row.config, null), null)
}

/**
 * Tema lokacije (prek verige do znamke) ali null — javni odgovori ključ `theme`
 * vstavijo SAMO, ko je ta neskončna null (absent = byte-identičen odgovor).
 * (B-del: logotip je ŽE del teme — zastavica logoUploaded v isti vrstici;
 * težka shramba bajtov se tu NE bere.)
 */
export async function brandThemeForLocation(locationId: string | null | undefined): Promise<BrandThemeView | null> {
  if (!locationId) return null
  const chain = await chainForLocation(locationId)
  if (!chain?.brandId) return null
  const config = await loadBrandThemeConfig()
  return themeForBrand(config, chain.brandId)
}

/** Surova shramba bajtov logotipov iz Integration vrstice (fail-soft sanitizirana). */
export async function loadBrandLogoConfig(): Promise<BrandLogoConfig> {
  const row = await db.integration.findFirst({ where: { name: BRAND_LOGOS_MARKER, type: 'other' } })
  if (!row) return {}
  // enaka disciplina kot teme: null = brez obstojnostne poizvedbe (javno branje)
  return sanitizeBrandLogoConfig(jparse<unknown>(row.config, null), null)
}

/**
 * Bajti ENEGA logotipa za javno rutu — z OBRAMBO V GLOBINO: shranjeni base64
 * se dekodira in magic-byte prepoznavanje mora soglašati s shranjenim mime.
 * Neujemanje (ročno pokvarjena vrstica) → null → ruta odgovori 404 (gostovska
 * stran logotip tiho skrije — BrandLogo onError; nič se ne laže).
 */
export async function brandLogoBytesForBrand(brandId: string): Promise<{ mime: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const store = await loadBrandLogoConfig()
  const rec = store[brandId]
  if (!rec) return null
  const bytes = decodeBase64ToBytes(rec.data)
  if (!bytes) return null
  const sniffed = detectImageMime(bytes)
  if (!sniffed || sniffed !== rec.mime) return null
  return { mime: sniffed, bytes }
}

/**
 * Brand id-ji v obsegu klicalca: bootstrap = VSI (break-glass), ostali =
 * znamke njegove organizacije. orgOk=false → klicatelj ni vezan v drevo
 * (rute odgovorijo fail-closed 403 — prazna množica bi sicer tiho pobrisala
 * config tujih znamk; isti razlog kot enterprise link-location).
 */
export async function scopedBrandIds(user: AuthPayload): Promise<{ ids: Set<string>; orgOk: boolean }> {
  if (isBootstrapAdmin(user)) {
    const rows = await db.brand.findMany({ select: { id: true } })
    return { ids: new Set(rows.map((r) => r.id)), orgOk: true }
  }
  const chain = await chainForLocation(user.loc)
  if (!chain?.organizationId) return { ids: new Set(), orgOk: false }
  const rows = await db.brand.findMany({ where: { organizationId: chain.organizationId }, select: { id: true } })
  return { ids: new Set(rows.map((r) => r.id)), orgOk: true }
}
