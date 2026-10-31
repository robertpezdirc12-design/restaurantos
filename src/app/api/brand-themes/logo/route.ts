/**
 * OSS-11 B-del (v1.214.0) — NALAGANJE LOGOTIPA KOT DATOTEKE — admin rute.
 *
 * POST   /api/brand-themes/logo  { brandId, mimeType, contentBase64 }
 *        → validacija čistega sloja (allowlist PNG/JPEG/WebP/GIF + magic-byte
 *          preverjanje — mime ni zaupan, ampak preverjen) → zapis v Integration
 *          vrstico 'brand-logos' (read-modify-write: vnosi DRUGIH znamk —
 *          tudi tujih organizacij — se ohranijo) + zastavica logoUploaded v
 *          vrstici 'brand-themes', če znamka ima akcentno temo. Revizija
 *          BRAND_LOGO_UPDATED.
 * DELETE /api/brand-themes/logo?brandId=… → odstrani bajte + POČISTI
 *          zastavico (URL logotipa spet pride v veljavnost — reverzibilno).
 *          Revizija BRAND_LOGO_REMOVED.
 *
 * Dovoljenje: settings.manage (ista raven kot /api/brand-themes). Obseg =
 * znamke LASTNE organizacije (bootstrap break-glass); znamka izven obsega →
 * 403 (izrecno, ne tiho). Fail-closed brez organizacijske verige — enako kot
 * GET/PUT tem.
 *
 * Meje (poštene, dokumentirane v GAP): 512 kB raw na logotip, 8 MB skupaj,
 * 200 zapisov (vratarja); zapisa (bajti, zastavica) nista transakcijsko
 * atomarna — razpad je fail-soft v OBEH smerih (bajti brez zastavice =
 * nedejavjen logotip; zastavica brez bajtov = javna ruta 404 → BrandLogo se
 * skrije) in naslednji PUT teme razpad popravi (normalizacija iz bajtov).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jparse, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { scopedBrandIds } from '@/lib/brand-themes-server'
import {
  BRAND_THEMES_MARKER,
  BRAND_LOGOS_MARKER,
  validateLogoUpload,
  sanitizeBrandThemeConfig,
  sanitizeBrandLogoConfig,
  logoStoreTotalBytes,
  logoBase64SizeBytes,
  BRAND_LOGO_MAX,
  MAX_LOGO_STORE_BYTES,
  type BrandLogoConfig,
} from '@/lib/brand-themes'

export const dynamic = 'force-dynamic'

/** Read-modify-write shrambe bajtov (ohrani vnose vseh ostalih znamk). */
async function writeLogoStore(next: BrandLogoConfig): Promise<void> {
  const cfgJson = JSON.stringify(next)
  const existing = await db.integration.findFirst({ where: { name: BRAND_LOGOS_MARKER, type: 'other' } })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: cfgJson } })
  } else {
    await db.integration.create({
      data: {
        id: `brand-logos-${Date.now().toString(36)}`,
        name: BRAND_LOGOS_MARKER,
        type: 'other',
        provider: 'internal',
        config: cfgJson,
        isActive: true,
        syncEnabled: false,
      },
    })
  }
}

/** Dvigni/spusti zastavico logoUploaded v vrstici tem (read-modify-write, fail-soft). */
async function setThemeLogoFlag(brandId: string, uploaded: boolean): Promise<boolean> {
  const row = await db.integration.findFirst({ where: { name: BRAND_THEMES_MARKER, type: 'other' } })
  const config = sanitizeBrandThemeConfig(row ? jparse<unknown>(row.config, null) : null, null)
  const setting = config[brandId]
  if (!setting) return false // ni akcentne teme — logotip je shranjen, a neizkazan (pošteno sporočeno)
  const next = { ...setting }
  if (uploaded) next.logoUploaded = true
  else delete next.logoUploaded
  const merged = { ...config, [brandId]: next }
  const cfgJson = JSON.stringify(merged)
  if (row) {
    await db.integration.update({ where: { id: row.id }, data: { config: cfgJson } })
  } else if (uploaded) {
    await db.integration.create({
      data: {
        id: `brand-themes-${Date.now().toString(36)}`,
        name: BRAND_THEMES_MARKER,
        type: 'other',
        provider: 'internal',
        config: cfgJson,
        isActive: true,
        syncEnabled: false,
      },
    })
  }
  return true
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const { ids, orgOk } = await scopedBrandIds(user)
  if (!orgOk) return fail('Uporabnik ni vezan v organizacijsko drevo — nalaganje zavrnjeno.', 403)

  const body = await req.json().catch(() => null) as { brandId?: unknown; mimeType?: unknown; contentBase64?: unknown } | null
  const brandId = typeof body?.brandId === 'string' ? body.brandId.trim() : ''
  if (!brandId) return fail('Podatek brandId je obvezen.', 400)
  if (!ids.has(brandId)) return fail('Znamka ni v obsegu vaše organizacije.', 403)

  const parsed = validateLogoUpload(body?.mimeType, body?.contentBase64)
  if (!parsed.ok) return fail(parsed.error, 400)
  const { mime, data, sizeBytes } = parsed.value

  // read-modify-write: obstoječa shramba (fail-soft sanitizirana), nov vnos
  const row = await db.integration.findFirst({ where: { name: BRAND_LOGOS_MARKER, type: 'other' } })
  const store = sanitizeBrandLogoConfig(row ? jparse<unknown>(row.config, null) : null, null)
  const replacing = store[brandId] ? logoBase64SizeBytes(store[brandId].data) : 0
  if (!store[brandId] && Object.keys(store).length >= BRAND_LOGO_MAX) {
    return fail(`Shramba logotipov je polna (največ ${BRAND_LOGO_MAX} zapisov).`, 400)
  }
  const nextTotal = logoStoreTotalBytes(store) - replacing + sizeBytes
  if (nextTotal > MAX_LOGO_STORE_BYTES) {
    return fail(`Skupna velikost logotipov presega omejitev ${Math.round(MAX_LOGO_STORE_BYTES / 1_000_000)} MB.`, 400)
  }
  store[brandId] = { mime, data }
  await writeLogoStore(store)

  // zastavica (ne-atomarno za vrstico tem — razpad fail-soft, PUT popravi)
  const themeActive = await setThemeLogoFlag(brandId, true)

  await writeAudit(db, {
    userId: user.sub,
    action: 'BRAND_LOGO_UPDATED',
    entityType: 'Integration',
    entityId: BRAND_LOGOS_MARKER,
    details: jstr({ brandId, mimeType: mime, sizeBytes, by: user.name }),
  }).catch(() => null)

  return ok({ brandId, mimeType: mime, sizeBytes, themeActive })
}

export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const { ids, orgOk } = await scopedBrandIds(user)
  if (!orgOk) return fail('Uporabnik ni vezan v organizacijsko drevo — brisanje zavrnjeno.', 403)

  const brandId = req.nextUrl.searchParams.get('brandId')?.trim() ?? ''
  if (!brandId) return fail('Parameter brandId je obvezen.', 400)
  if (!ids.has(brandId)) return fail('Znamka ni v obsegu vaše organizacije.', 403)

  const row = await db.integration.findFirst({ where: { name: BRAND_LOGOS_MARKER, type: 'other' } })
  const store = sanitizeBrandLogoConfig(row ? jparse<unknown>(row.config, null) : null, null)
  if (!store[brandId]) return fail('Logotip za to znamko ni naložen.', 404)
  delete store[brandId]
  await writeLogoStore(store)

  // POČISTI zastavico — URL logotipa (če je nastavljen) spet pride v veljavnost
  await setThemeLogoFlag(brandId, false)

  await writeAudit(db, {
    userId: user.sub,
    action: 'BRAND_LOGO_REMOVED',
    entityType: 'Integration',
    entityId: BRAND_LOGOS_MARKER,
    details: jstr({ brandId, by: user.name }),
  }).catch(() => null)

  return ok({ brandId, removed: true })
}
