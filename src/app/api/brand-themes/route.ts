/**
 * OSS-11 (v1.213.0) — TEME PO ZNAMKI — admin CRUD (GET/PUT /api/brand-themes).
 *
 * GET  → { config: { [brandId]: { accent, logoUrl? } }, logos: { [brandId]:
 *        { mimeType, sizeBytes } } } — filtrirano na obseg klicalca (bootstrap
 *        = break-glass vidi vse; ostali SAMO znamke svoje organizacije — isti
 *        tenant vzorec kot /api/enterprise). `logos` (v1.214.0) je ADITIVNI
 *        ključ: metapodatki naloženih logotipov BREZ base64 vsebine (seznam
 *        ostane lahek — documents DTO vzorec).
 * PUT  { config } → sanitizacija proti ŽIVIM brand id-jem OBSEGA klicalca →
 *        Integration vrstica (name='brand-themes', type='other') upsert —
 *        ZERO DDL. Revizija: BRAND_THEME_UPDATED.
 *
 * Dovoljenje: settings.manage (raven upravljanja znamk v /api/enterprise POST).
 * Fail-closed: uporabnik brez organizacijske verige (in brez bootstrapa) NE sme
 * niti brati niti pisati — prazna validna množica bi sicer tiho POBRISALA config
 * tujih znamk (isti razlog, zakaj enterprise link-location zahteva verigo).
 *
 * v1.214.0 — POPRAVEK REALNE NAPAKE (merjeno, ne ugiban): PUT je doslej
 * NADOMESTIL celotno vrstico s samo vnosi klicalca — admin organizacije B bi
 * s shranitvijo TIHO POBRISAL teme organizacije A (obseg GET/PUT je bil
 * omejen na lastne znamke, vrstica pa GLOBALNA za vse orgije). Zdaj PUT
 * ZLIJE: vnosi znamk IZVEN obsega klicalca se nespremenjeno ohranijo
 * (niso njegovi za dotik), vnosi v obsegu se nadomestijo/dodajo. Isti
 * fail-closed razlog kot 403 — vrstica je skupna, obseg pa ni.
 *
 * v1.214.0 — NORMALIZACIJA ZASTAVICE logoUploaded: ob vsakem PUT se zastavice
 * naloženih logotipov ponovno izpeljejo iz DEJANSKE prisotnosti bajtov v
 * brand-logos vrstici (zapis POST/DELETE ju vzdržuje; PUT je točka popravila
 * morebitnega razpada — delno spodletelo pisanje se samo ozdravi ob naslednji
 * shranitvi teme).
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
  sanitizeBrandThemeConfig,
  sanitizeBrandLogoConfig,
  logoBase64SizeBytes,
  type BrandThemeConfig,
} from '@/lib/brand-themes'

export const dynamic = 'force-dynamic'

/** Surova (neobsegovana) shramba bajtov — za metapodatke in normalizacijo. */
async function rawLogoStore(): Promise<ReturnType<typeof sanitizeBrandLogoConfig>> {
  const row = await db.integration.findFirst({ where: { name: BRAND_LOGOS_MARKER, type: 'other' } })
  return sanitizeBrandLogoConfig(row ? jparse<unknown>(row.config, null) : null, null)
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

  // v1.214.0: metapodatki naloženih logotipov v obsegu klicalca (BREZ base64)
  const store = await rawLogoStore()
  const logos: Record<string, { mimeType: string; sizeBytes: number }> = {}
  for (const [brandId, rec] of Object.entries(store)) {
    if (!ids.has(brandId)) continue
    logos[brandId] = { mimeType: rec.mime, sizeBytes: logoBase64SizeBytes(rec.data) }
  }
  return ok({ config, logos })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const { ids, orgOk } = await scopedBrandIds(user)
  if (!orgOk) return fail('Uporabnik ni vezan v organizacijsko drevo — shranjevanje zavrnjeno.', 403)

  const body = await req.json().catch(() => null) as { config?: unknown } | null
  if (!body || typeof body !== 'object') return fail('Podatek config je obvezen.', 400)
  const incoming = sanitizeBrandThemeConfig(body.config, ids)

  // MERGE (v1.214.0): obstoječa vrstica lahko nosi teme Znamk IZVEN obsega
  // klicalca (druga organizacija/bootstrap) — te se OHRANIJO nespremenjene
  // (validacija vrednosti fail-soft, obstojnost se NE preverja — niso v
  // obsegu, brisanje bi bilo tuje lastnino). Vnosi v obsegu nadomestijo/addajo.
  const existing = await db.integration.findFirst({ where: { name: BRAND_THEMES_MARKER, type: 'other' } })
  const existingAll = sanitizeBrandThemeConfig(existing ? jparse<unknown>(existing.config, null) : null, null)
  const merged: BrandThemeConfig = {}
  for (const [brandId, setting] of Object.entries(existingAll)) {
    if (!ids.has(brandId)) merged[brandId] = setting
  }
  for (const [brandId, setting] of Object.entries(incoming)) {
    merged[brandId] = setting
  }

  // NORMALIZACIJA (v1.214.0): zastavica naloženega logotipa = DEJANSKA
  // prisotnost bajtov (PO vsaki mutaciji tem; popravi morebitni razpad).
  const store = await rawLogoStore()
  for (const [brandId, setting] of Object.entries(merged)) {
    if (store[brandId]) merged[brandId] = { ...setting, logoUploaded: true }
  }

  const cfgJson = JSON.stringify(merged)
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

  const details = { brands: Object.keys(merged).length, by: user.name }
  await writeAudit(db, { userId: user.sub, action: 'BRAND_THEME_UPDATED', entityType: 'Integration', entityId: existing?.id || BRAND_THEMES_MARKER, details: jstr(details) }).catch(() => null)

  return ok({ config: merged })
}
