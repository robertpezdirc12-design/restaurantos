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
 * config JSON { [brandId]: { accent, logoUrl? } } — zapis skozi
 * PUT /api/brand-themes (sanitizacija proti ŽIVIM brand id-jem obsega).
 */
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import { chainForLocation } from '@/lib/tenant'
import {
  BRAND_THEMES_MARKER,
  sanitizeBrandThemeConfig,
  themeForBrand,
  type BrandThemeConfig,
  type BrandThemeView,
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
 */
export async function brandThemeForLocation(locationId: string | null | undefined): Promise<BrandThemeView | null> {
  if (!locationId) return null
  const chain = await chainForLocation(locationId)
  if (!chain?.brandId) return null
  const config = await loadBrandThemeConfig()
  return themeForBrand(config, chain.brandId)
}
