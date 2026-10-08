/**
 * Issue #11 §1 — enterprise hierarhija: hierarhična dovoljenja (faza 1, čista logika).
 *
 * Drevo: Organization → Brand → Property → Location (obstoječa Location ostane
 * operativno sidro) → RevenueCenter/Workstation. Uporabnik ima primarno `loc`
 * (Location). Hierarhični preklok dovoli dostop do virov NAD lokacijo SAMO vlogam,
 * ki pokrivajo enterprise obseg, in SAMO znotraj iste organizacije/property-ja.
 *
 * Pravila (deterministično, testabilno brez DB — veriga pride kot parameter):
 *  - isti locationId → dovoljeno (lokacijski dostop, nespremenjeno vedenje §18);
 *  - vloge z enterprise obsegom (group_owner/org_admin/owner/admin = org nivo,
 *    property_manager = property nivo) → dovoljeno, če veriga vira deli
 *    organizationId oz. propertyId z verigo uporabnika;
 *  - lokacijske vloge (waiter/staff/bar/chef/kitchen/manager/warehouse/accounting)
 *    → SAMO lastna lokacija;
 *  - manjkajoča veriga (vir/uporabnik ni vezan v drevo) → fail-closed (ni dovoljeno).
 */

export interface EnterpriseChain {
  organizationId: string | null
  brandId: string | null
  propertyId: string | null
  locationId: string | null
}

export const ENTERPRISE_ORG_ROLES = ['group_owner', 'org_admin', 'owner', 'admin'] as const
export const ENTERPRISE_PROPERTY_ROLES = ['property_manager'] as const

/** Vloge, ki smejo prečkati lokacije znotraj enterprise drevesa (org oz. property nivo). */
export function roleSpansEnterprise(role: string): boolean {
  const r = (role || '').toLowerCase()
  return (ENTERPRISE_ORG_ROLES as readonly string[]).includes(r)
    || (ENTERPRISE_PROPERTY_ROLES as readonly string[]).includes(r)
}

function sameLocation(a: EnterpriseChain, b: EnterpriseChain): boolean {
  return Boolean(a.locationId && b.locationId && a.locationId === b.locationId)
}

/**
 * Hierarhična preverba: sme uporabnik (z vlogo + svojo verigo) dostopati do vira z dano verigo?
 * userChain == null pomeni: uporabnik nima lokacije/verige (bootstrap admin — klicatelj
 * ta primer rešuje ločeno, tu je fail-closed).
 */
export function enterpriseAllows(
  user: { role: string; loc: string | null },
  resource: EnterpriseChain,
  userChain: EnterpriseChain | null,
): boolean {
  if (!userChain) return false
  if (sameLocation(userChain, resource)) return true
  if (!roleSpansEnterprise(user.role)) return false
  const r = user.role.toLowerCase()
  // property nivo: samo isti property (in pod njim)
  if ((ENTERPRISE_PROPERTY_ROLES as readonly string[]).includes(r)) {
    return Boolean(userChain.propertyId && resource.propertyId && userChain.propertyId === resource.propertyId)
  }
  // org nivo: ista organizacija (ali vsaj ista brand/property, če org ni znan — legacy podatki)
  if (userChain.organizationId && resource.organizationId) {
    return userChain.organizationId === resource.organizationId
  }
  // legacy drevo brez Organization: pade na brand/property primerjavo
  if (userChain.brandId && resource.brandId) return userChain.brandId === resource.brandId
  if (userChain.propertyId && resource.propertyId) return userChain.propertyId === resource.propertyId
  return false
}
