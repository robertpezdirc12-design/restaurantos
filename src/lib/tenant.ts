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
import { fail } from '@/lib/api'
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
 * Bootstrap admin gre skozi (break-glass). Uporabnik brez lokacije + ni bootstrap → 403
 * kadar vir ima znano org (centralna vloga MORA biti vezana v drevo za cross-location dostop).
 */
export async function assertTenantScope(
  user: AuthPayload,
  resourceChain: TenantChain | null
): Promise<TenantGuardResult> {
  if (isBootstrapAdmin(user)) return null
  const userChain = await chainForLocation(user.loc)
  if (!resourceChain) return null
  if (!userChain) return fail('Uporabnik ni vezan v organizacijsko drevo — dostop do vira zavrnjen.', 403)
  if (!tenantAllows(userChain, resourceChain)) {
    return fail('Vir pripada drugi organizaciji — dostop zavrnjen.', 403)
  }
  return null
}

/** org filter za sezname centralnih vlog (bootstrap vidi vse — break-glass). */
export async function orgFilterForUser(user: AuthPayload): Promise<string | null> {
  if (isBootstrapAdmin(user)) return null
  const chain = await chainForLocation(user.loc)
  return chain?.organizationId ?? null
}
