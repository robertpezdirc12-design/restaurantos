/**
 * Issue #11 §1 — GET /api/enterprise: enterprise drevo (Organization → Brand →
 * Property → Location → RevenueCenter/Workstation) z uporabnikovim obsegom.
 * POST /api/enterprise: ustvarjanje enterprise entitet (org/brand/property;
 * link location → property prek PATCH /api/locations/[id] v naslednjem inkrementu,
 * tu preprosto podprto: { kind: 'link-location', propertyId, locationId }).
 *
 * Faza 1 — minimalen, varen podaljšek: obstoječe Location ostane operativno sidro (§18).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid } from '@/lib/map'
import { enterpriseAllows, type EnterpriseChain } from '@/lib/enterprise'
import { chainForLocation, isBootstrapAdmin } from '@/lib/tenant'

export const dynamic = 'force-dynamic'

/** Preprost slug iz imena (lowercase, ASCII, pomišljaji). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const userChain = await chainForLocation(user.loc)
  const orgs = await db.organization.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, slug: true, isActive: true,
      Brand: {
        select: {
          id: true, name: true, isActive: true,
          Property: {
            select: {
              id: true, name: true, city: true, country: true, isActive: true,
              Location: { select: { id: true, name: true, code: true, type: true, isActive: true } },
              RevenueCenter: { select: { id: true, name: true, code: true, isActive: true } },
              Workstation: { select: { id: true, name: true, kind: true, isActive: true } },
            },
          },
        },
      },
    },
  })

  // Issue #12 §1 — tenant scope: brez bootstrapa uporabnik vidi SAMO svojo organizacijo
  // (prej: vsi orgi za vse — cross-tenant read uhajanje). Bootstrap = break-glass.
  const myOrgId = isBootstrapAdmin(user) ? null : (userChain?.organizationId ?? null)
  const visibleOrgs = myOrgId ? orgs.filter((o) => o.id === myOrgId) : orgs

  return ok({
    myScope: userChain,
    organizations: visibleOrgs.map((o) => ({
      id: o.id, name: o.name, slug: o.slug, isActive: o.isActive,
      brands: o.Brand.map((b) => ({
        id: b.id, name: b.name, isActive: b.isActive,
        properties: b.Property.map((p) => ({
          id: p.id, name: p.name, city: p.city, country: p.country, isActive: p.isActive,
          locations: p.Location,
          revenueCenters: p.RevenueCenter,
          workstations: p.Workstation,
          // obseg: sme uporabnik videti ta property? (isti location / isti property / ista org)
          inScope: enterpriseAllows(user, {
            organizationId: o.id, brandId: b.id, propertyId: p.id,
            locationId: p.Location[0]?.id ?? null,
          }, userChain),
        })),
      })),
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  const kind = String(body?.kind || '').trim()
  const name = String(body?.name || '').trim()

  // Issue #12 §1 — tenant scope za mutacije: bootstrap = break-glass; ostali smejo
  // upravljati SAMO znotraj svoje organizacije (cross-org → 403, fail-closed).
  const bootstrap = isBootstrapAdmin(user)
  const userChain = bootstrap ? null : await chainForLocation(user.loc)
  const userOrgId = userChain?.organizationId ?? null

  if (kind === 'organization') {
    // Kreiranje organizacije = platformna operacija (SaaS onboarding) — bootstrap break-glass.
    if (!bootstrap) return fail('Kreiranje organizacij je rezervirano za platformnega administratorja.', 403)
    if (!name) return fail('Naziv organizacije je obvezen.', 400)
    const slug = String(body?.slug || slugify(name)).slice(0, 60)
    if (!slug) return fail('Slug je obvezen.', 400)
    const exists = await db.organization.findUnique({ where: { slug } })
    if (exists) return fail('Organizacija s tem slug-om že obstaja.', 409)
    const org = await db.organization.create({ data: { id: nid(), name: name.slice(0, 120), slug } })
    return ok({ organization: { id: org.id, name: org.name, slug: org.slug } }, 201)
  }

  if (kind === 'brand') {
    const organizationId = String(body?.organizationId || '')
    if (!name || !organizationId) return fail('Naziv in organizacija sta obvezna.', 400)
    const org = await db.organization.findUnique({ where: { id: organizationId } })
    if (!org) return fail('Organizacija ne obstaja.', 404)
    if (!bootstrap && userOrgId !== organizationId) return fail('Tuja organizacija — dostop zavrnjen.', 403)
    const brand = await db.brand.create({ data: { id: nid(), organizationId, name: name.slice(0, 120) } })
    return ok({ brand: { id: brand.id, name: brand.name, organizationId } }, 201)
  }

  if (kind === 'property') {
    const brandId = String(body?.brandId || '')
    if (!name || !brandId) return fail('Naziv in blagovna znamka sta obvezna.', 400)
    const brand = await db.brand.findUnique({ where: { id: brandId } })
    if (!brand) return fail('Blagovna znamka ne obstaja.', 404)
    if (!bootstrap && userOrgId !== brand.organizationId) return fail('Tuja organizacija — dostop zavrnjen.', 403)
    const property = await db.property.create({
      data: {
        id: nid(), brandId, name: name.slice(0, 120),
        address: String(body?.address || '').slice(0, 200),
        city: String(body?.city || '').slice(0, 80),
        country: String(body?.country || 'SI').slice(0, 2).toUpperCase(),
      },
    })
    return ok({ property: { id: property.id, name: property.name, brandId } }, 201)
  }

  if (kind === 'link-location') {
    const propertyId = String(body?.propertyId || '')
    const locationId = String(body?.locationId || '')
    if (!propertyId || !locationId) return fail('propertyId in locationId sta obvezna.', 400)
    const property = await db.property.findUnique({
      where: { id: propertyId },
      select: { id: true, brandId: true, Brand: { select: { organizationId: true } } },
    })
    if (!property) return fail('Property ne obstaja.', 404)
    const location = await db.location.findUnique({
      where: { id: locationId },
      select: { id: true, propertyId: true, Property: { select: { Brand: { select: { organizationId: true } } } } },
    })
    if (!location) return fail('Lokacija ne obstaja.', 404)
    // Issue #12 §1 — cross-tenant zapora: property IN lokacija morata biti v ORGANIZACIJI
    // uporabnika (ali v legacy drevesu brez org — brand/property primerjava). Fail-closed.
    const targetOrg = property.Brand?.organizationId ?? null
    const locationOrg = location.Property?.Brand?.organizationId ?? null
    if (!bootstrap) {
      if (!userOrgId) return fail('Uporabnik ni vezan v organizacijsko drevo — povezava zavrnjena.', 403)
      if (targetOrg && targetOrg !== userOrgId) return fail('Property pripada drugi organizaciji — povezava zavrnjena.', 403)
      if (locationOrg && locationOrg !== userOrgId) return fail('Lokacija pripada drugi organizaciji — povezava zavrnjena.', 403)
      if (!targetOrg && userChain?.brandId && property.brandId !== userChain.brandId) {
        return fail('Property pripada drugi blagovni znamki — povezava zavrnjena.', 403)
      }
    }
    await db.location.update({ where: { id: locationId }, data: { propertyId } })
    return ok({ linked: true, propertyId, locationId })
  }

  return fail('Neznan kind (organization | brand | property | link-location).', 400)
}
