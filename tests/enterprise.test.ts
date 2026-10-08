/**
 * Issue #11 §1 — enterprise hierarhija (faza 1): čista logika obsega brez DB.
 */
import { describe, it, expect } from 'bun:test'
import { enterpriseAllows, roleSpansEnterprise, type EnterpriseChain } from '@/lib/enterprise'

const chain = (locationId: string, propertyId: string, brandId: string, organizationId: string): EnterpriseChain => ({
  locationId, propertyId, brandId, organizationId,
})

const L1 = chain('loc-1', 'prop-1', 'brand-1', 'org-1')
const L2 = chain('loc-2', 'prop-1', 'brand-1', 'org-1') // ista property, druga lokacija
const L3 = chain('loc-3', 'prop-2', 'brand-1', 'org-1') // ista org, druga property
const L4 = chain('loc-4', 'prop-3', 'brand-2', 'org-2') // druga organizacija

describe('roleSpansEnterprise (Issue #11 §1)', () => {
  it('enterprise vloge prečkajo lokacije', () => {
    for (const r of ['group_owner', 'org_admin', 'owner', 'admin', 'property_manager']) {
      expect(roleSpansEnterprise(r)).toBe(true)
    }
  })

  it('lokacijske vloge ne prečkajo', () => {
    for (const r of ['waiter', 'staff', 'bar', 'chef', 'kitchen', 'manager', 'warehouse', 'accounting']) {
      expect(roleSpansEnterprise(r)).toBe(false)
    }
  })
})

describe('enterpriseAllows (Issue #11 §1)', () => {
  it('ista lokacija → dovoljeno za VSE vloge', () => {
    for (const role of ['waiter', 'chef', 'group_owner', 'owner']) {
      expect(enterpriseAllows({ role, loc: 'loc-1' }, L1, chain('loc-1', 'prop-1', 'brand-1', 'org-1'))).toBe(true)
    }
  })

  it('lokacijska vloga na drugi lokaciji → zavrnjeno (tudi isti property)', () => {
    expect(enterpriseAllows({ role: 'waiter', loc: 'loc-1' }, L2, chain('loc-1', 'prop-1', 'brand-1', 'org-1'))).toBe(false)
    expect(enterpriseAllows({ role: 'manager', loc: 'loc-1' }, L3, chain('loc-1', 'prop-1', 'brand-1', 'org-1'))).toBe(false)
  })

  it('org vloge: prekok lokacij znotraj iste org, ne čez organizacije', () => {
    const user = { role: 'group_owner', loc: 'loc-1' }
    const uc = chain('loc-1', 'prop-1', 'brand-1', 'org-1')
    expect(enterpriseAllows(user, L2, uc)).toBe(true)
    expect(enterpriseAllows(user, L3, uc)).toBe(true)
    expect(enterpriseAllows(user, L4, uc)).toBe(false)
  })

  it('property_manager: samo isti property', () => {
    const user = { role: 'property_manager', loc: 'loc-1' }
    const uc = chain('loc-1', 'prop-1', 'brand-1', 'org-1')
    expect(enterpriseAllows(user, L2, uc)).toBe(true)  // isti property
    expect(enterpriseAllows(user, L3, uc)).toBe(false) // druga property
  })

  it('fail-closed: brez verige (null) ni dostopa', () => {
    expect(enterpriseAllows({ role: 'group_owner', loc: null }, L1, null)).toBe(false)
    expect(enterpriseAllows({ role: 'owner', loc: 'loc-1' }, L1, null)).toBe(false)
  })

  it('fail-closed: vir brez povezave v drevo ni dostopen prek org prekloka', () => {
    const user = { role: 'org_admin', loc: 'loc-1' }
    const uc = chain('loc-1', 'prop-1', 'brand-1', 'org-1')
    const orphan: EnterpriseChain = { locationId: 'loc-9', propertyId: null, brandId: null, organizationId: null }
    expect(enterpriseAllows(user, orphan, uc)).toBe(false)
  })

  it('legacy drevo brez Organization: pade na property primerjavo', () => {
    const user = { role: 'owner', loc: 'loc-1' }
    const uc: EnterpriseChain = { locationId: 'loc-1', propertyId: 'prop-1', brandId: null, organizationId: null }
    const sameProp: EnterpriseChain = { locationId: 'loc-2', propertyId: 'prop-1', brandId: null, organizationId: null }
    const otherProp: EnterpriseChain = { locationId: 'loc-3', propertyId: 'prop-2', brandId: null, organizationId: null }
    expect(enterpriseAllows(user, sameProp, uc)).toBe(true)
    expect(enterpriseAllows(user, otherProp, uc)).toBe(false)
  })
})
