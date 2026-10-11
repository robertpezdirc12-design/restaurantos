/**
 * Issue #12 §1 — SaaS tenant boundary.
 *
 * Cilj: `Tenant/Organization → Brand → Property → Location → Device/User`.
 * Location je operativno sidro (§18 — obstoječe vedenje se ne lomi) in pripada
 * TOČNO eni organizaciji prek Location.propertyId → Property.brandId → Brand.organizationId.
 *
 * Pravilo (deterministično, migracijsko varno):
 *  - če sta org uporabnika IN org vira OBÉ znani in RAZLIČNI → cross-tenant DENY;
 *  - če je org uporabnika ali vira neznana (legacy/nevezani podatki) → obstoječe
 *    lokacijsko vedenje (assertResourceLocation/locationScope) ostane edina varovalka;
 *  - bootstrap admin (sub='bootstrap', brez Employee vrstice) ostane break-glass
 *    za obnovo dostopa — izrecno dokumentirano v docs/TENANT-ISOLATION.md.
 *
 * Zakaj tako: fail-closed na neznane org bi TRENUTNO produkcijo (lokacije brez
 * propertyId) odrezal od centralnih vlog — to bi bila regresija (§0 AI pravilo 6/10).
 * Ko so podatki povezani v drevo, je meja stroga.
 */

import { db } from '@/lib/db'
import { assertResourceLocation, fail, isCentralRole } from '@/lib/api'
import type { NextResponse } from 'next/server'
import type { AuthPayload } from '@/lib/auth'

export interface TenantChain {
  organizationId: string | null
  brandId: string | null
  propertyId: string | null
  locationId: string | null
}

/** Bootstrap admin = break-glass (brez Employee vrstice; obnova dostopa prek env). */
export function isBootstrapAdmin(user: AuthPayload): boolean {
  return user.role === 'ADMIN' && user.sub === 'bootstrap'
}

/** Veriga lokacije: Location → Property → Brand → Organization (null, če ni vezana). */
export async function chainForLocation(locationId: string | null | undefined): Promise<TenantChain | null> {
  if (!locationId) return null
  const loc = await db.location.findUnique({
    where: { id: locationId },
    select: {
      id: true,
      Property: { select: { id: true, brandId: true, Brand: { select: { id: true, organizationId: true } } } },
    },
  })
  if (!loc) return null
  return {
    locationId: loc.id,
    propertyId: loc.Property?.id ?? null,
    brandId: loc.Property?.brandId ?? null,
    organizationId: loc.Property?.Brand?.organizationId ?? null,
  }
}

/**
 * Čista jedro (testabilno brez DB): sme uporabnik z userChain dostopati do vira z resourceChain?
 *  - userChain ali resourceChain manjka → true (legacy — ni s čim primerjati, lokacijski sloj varuje);
 *  - obe orgi znani → enaka org; različna orga → false (cross-tenant);
 *  - orga neznana (null) na eni strani → pade na brand/property primerjavo če obstajata,
 *    sicer true (legacy).
 */
export function tenantAllows(userChain: TenantChain | null, resourceChain: TenantChain | null): boolean {
  if (!userChain || !resourceChain) return true
  if (userChain.organizationId && resourceChain.organizationId) {
    return userChain.organizationId === resourceChain.organizationId
  }
  if (userChain.brandId && resourceChain.brandId) return userChain.brandId === resourceChain.brandId
  if (userChain.propertyId && resourceChain.propertyId) {
    return userChain.propertyId === resourceChain.propertyId
  }
  return true
}

export type TenantGuardResult = NextResponse | null

/**
 * API varovalka (fail-closed na različne org): 403 če je vir v TUJI organizaciji.
 * Bootstrap admin gre skozi (break-glass).
 *
 * MIGRACIJSKO VARNO (v1.53.0 — uskladitev z oglavjem datoteke + docs/TENANT-ISOLATION.md
 * + čistim jedrom `tenantAllows`, ki za neznano verigo vrača true): neznana veriga
 * uporabnika ALI vira (legacy/nevezani podatki) → pass — lokacijski sloj
 * (assertResourceLocation/locationScope) ostane edina varovalka. Prejšnja strožja
 * veja (`!userChain → 403`) je bila v nasprotju z dokumentacijo in bi nevezane
 * produkcije lokacije odrezala od centralnih vlog (regresija, §0 AI pravilo 6/10).
 */
export async function assertTenantScope(
  user: AuthPayload,
  resourceChain: TenantChain | null
): Promise<TenantGuardResult> {
  if (isBootstrapAdmin(user)) return null
  if (!resourceChain) return null
  const userChain = await chainForLocation(user.loc)
  if (!userChain) return null
  if (!tenantAllows(userChain, resourceChain)) {
    return fail('Vir pripada drugi organizaciji — dostop zavrnjen.', 403)
  }
  return null
}

/**
 * Org meja za CENTRALNE vloge (audit P1 — priklic assertTenantScope v rutah):
 * staff/enterprise vloge so že pokrite z lokacijskim oziroma enterprise slojem,
 * zato ta funkcija zanje takoj vrne null (brez DB poizvedb).
 * Centralni uporabnik z znano org ne sme brati/pisati virov tuje org — 403.
 * Migracijsko varno: neznana veriga (uporabnik ali vir) → null (lokacijski sloj varuje).
 */
export async function assertOrgScope(
  user: AuthPayload,
  resourceLocationId: string | null | undefined
): Promise<TenantGuardResult> {
  if (!isCentralRole(user)) return null
  if (isBootstrapAdmin(user)) return null
  if (!resourceLocationId) return null
  const [userChain, resourceChain] = await Promise.all([
    chainForLocation(user.loc),
    chainForLocation(resourceLocationId),
  ])
  if (!userChain || !resourceChain) return null
  if (!tenantAllows(userChain, resourceChain)) {
    return fail('Vir pripada drugi organizaciji — dostop zavrnjen.', 403)
  }
  return null
}

/**
 * Združena varovalka za točkovne rute (branje/posodabljanje/brisanje na vire z lokacijo):
 *  1. assertResourceLocation — lokacijski sloj (staff = izključno svoja lokacija, fail-closed);
 *  2. assertOrgScope — org meja za centralne vloge (403 na tujo organizacijo).
 * Nadomesti gole `assertResourceLocation` klice v rutah (v1.53.0, mehanično povezano).
 */
export async function guardResource(
  user: AuthPayload,
  resourceLocationId: string | null | undefined
): Promise<TenantGuardResult> {
  const local = assertResourceLocation(user, resourceLocationId)
  if (local) return local
  return assertOrgScope(user, resourceLocationId)
}

/** org filter za sezname centralnih vlog (bootstrap vidi vse — break-glass). */
export async function orgFilterForUser(user: AuthPayload): Promise<string | null> {
  if (isBootstrapAdmin(user)) return null
  const chain = await chainForLocation(user.loc)
  return chain?.organizationId ?? null
}
