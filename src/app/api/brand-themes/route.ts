/**
 * OSS-11 (v1.213.0) — TEME PO ZNAMKI — admin CRUD (GET/PUT /api/brand-themes).
 *
 * GET  → { config: { [brandId]: { accent, logoUrl? } } } — filtrirano na obseg
 *        klicalca (bootstrap = break-glass vidi vse; ostali SAMO znamke svoje
 *        organizacije — isti tenant vzorec kot /api/enterprise).
 * PUT  { config } → sanitizacija proti ŽIVIM brand id-jem OBSEGA klicalca →
 *        Integration vrstica (name='brand-themes', type='other') upsert —
 *        ZERO DDL. Revizija: BRAND_THEME_UPDATED.
 *
 * Dovoljenje: settings.manage (raven upravljanja znamk v /api/enterprise POST).
 * Fail-closed: uporabnik brez organizacijske verige (in brez bootstrapa) NE sme
 * niti brati niti pisati — prazna validna množica bi sicer tiho POBRISALA config
 * tujih znamk (isti razlog, zakaj enterprise link-location zahteva verigo).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jparse, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { isBootstrapAdmin, chainForLocation } from '@/lib/tenant'
import type { AuthPayload } from '@/lib/auth'
import {
  BRAND_THEMES_MARKER,
  sanitizeBrandThemeConfig,
  type BrandThemeConfig,
} from '@/lib/brand-themes'

export const dynamic = 'force-dynamic'

/** Brand id-ji v obsegu klicalca: bootstrap = VSI, ostali = znamke njegove organizacije. */
async function scopedBrandIds(user: AuthPayload): Promise<{ ids: Set<string>; orgOk: boolean }> {
  if (isBootstrapAdmin(user)) {
    const rows = await db.brand.findMany({ select: { id: true } })
    return { ids: new Set(rows.map((r) => r.id)), orgOk: true }
  }
  const chain = await chainForLocation(user.loc)
  if (!chain?.organizationId) return { ids: new Set(), orgOk: false }
  const rows = await db.brand.findMany({ where: { organizationId: chain.organizationId }, select: { id: true } })
  return { ids: new Set(rows.map((r) => r.id)), orgOk: true }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const { ids, orgOk } = await scopedBrandIds(user)
  if (!orgOk) return fail('Uporabnik ni vezan v organizacijsko drevo — teme niso dosegljive.', 403)

  const row = await db.integration.findFirst({ where: { name: BRAND_THEMES_MARKER, type: 'other' } })
  // jparse: config je SQLite String / Postgres Json — ista vrata za obe klienta
  // (lekcija typecheck-prod v1.211.0 — surovi JSON.parse bi padel na Postgresu)
  const config = sanitizeBrandThemeConfig(row ? jparse<unknown>(row.config, null) : null, ids)
  return ok({ config })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const { ids, orgOk } = await scopedBrandIds(user)
  if (!orgOk) return fail('Uporabnik ni vezan v organizacijsko drevo — shranjevanje zavrnjeno.', 403)

  const body = await req.json().catch(() => null) as { config?: unknown } | null
  if (!body || typeof body !== 'object') return fail('Podatek config je obvezen.', 400)
  const config: BrandThemeConfig = sanitizeBrandThemeConfig(body.config, ids)

  const cfgJson = JSON.stringify(config)
  const existing = await db.integration.findFirst({ where: { name: BRAND_THEMES_MARKER, type: 'other' } })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: cfgJson } })
  } else {
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

  const details = { brands: Object.keys(config).length, by: user.name }
  await writeAudit(db, { userId: user.sub, action: 'BRAND_THEME_UPDATED', entityType: 'Integration', entityId: existing?.id || BRAND_THEMES_MARKER, details: jstr(details) }).catch(() => null)

  return ok({ config })
}
