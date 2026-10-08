import { describe, it, expect } from 'bun:test'
import { tenantAllows, type TenantChain } from '@/lib/tenant'
import { enterpriseAllows, type EnterpriseChain } from '@/lib/enterprise'

/**
 * Issue #12 §1/§7 — tenant isolation testi (čista logika, brez DB).
 * Scenariji iz issue-ja: tenant A → lastni podatki; tenant A → tenant B = DENY;
 * forged tenant/location ID = DENY; legacy (nevezani) podatki = obstoječe vedenje.
 */

const chain = (o: Partial<TenantChain>): TenantChain => ({
  organizationId: null, brandId: null, propertyId: null, locationId: null, ...o,
})

describe('tenant isolation — tenantAllows (cross-org zapora)', () => {
  it('tenant A → lastni podatki: dovoljeno', () => {
    const a1 = chain({ organizationId: 'orgA', brandId: 'bA', propertyId: 'pA', locationId: 'lA1' })
    const a2 = chain({ organizationId: 'orgA', brandId: 'bA', propertyId: 'pA', locationId: 'lA2' })
    expect(tenantAllows(a1, a2)).toBe(true)
  })
  it('tenant A → tenant B READ: DENY (različni orgi)', () => {
    const a = chain({ organizationId: 'orgA', brandId: 'bA', propertyId: 'pA', locationId: 'lA' })
    const b = chain({ organizationId: 'orgB', brandId: 'bB', propertyId: 'pB', locationId: 'lB' })
    expect(tenantAllows(a, b)).toBe(false)
  })
  it('tenant A → tenant B WRITE: DENY (isti primer, mutacija gre čez isto varovalko)', () => {
    const a = chain({ organizationId: 'orgA' })
    const b = chain({ organizationId: 'orgB' })
    expect(tenantAllows(a, b)).toBe(false)
  })
  it('forged tenant ID: vir z izmisljenim org (orgC) → DENY', () => {
    const a = chain({ organizationId: 'orgA', brandId: 'bA', propertyId: 'pA' })
    const forged = chain({ organizationId: 'orgC', brandId: 'bA', propertyId: 'pA', locationId: 'lA' })
    expect(tenantAllows(a, forged)).toBe(false)
  })
  it('forged location ID znotraj tuje org → DENY (org prevlada nad lokacijo)', () => {
    const a = chain({ organizationId: 'orgA', locationId: 'lA' })
    const forged = chain({ organizationId: 'orgB', locationId: 'lA' }) // ukradena locationId v tuji org
    expect(tenantAllows(a, forged)).toBe(false)
  })

  it('legacy: uporabnik brez verige → obstoječe vedenje (lokacijski sloj varuje)', () => {
    const resource = chain({ organizationId: 'orgB', locationId: 'lB' })
    expect(tenantAllows(null, resource)).toBe(true)
  })
  it('legacy: vir brez verige → obstoječe vedenje (migracijsko varno)', () => {
    const user = chain({ organizationId: 'orgA', locationId: 'lA' })
    expect(tenantAllows(user, null)).toBe(true)
  })
  it('legacy: orga neznani, isti brand → dovoljeno', () => {
    const u = chain({ brandId: 'b1', propertyId: 'p1' })
    const r = chain({ brandId: 'b1', propertyId: 'p2' })
    expect(tenantAllows(u, r)).toBe(true)
  })
  it('legacy: orga neznani, različni brandi → DENY (brand je naslednja meja)', () => {
    const u = chain({ brandId: 'b1', propertyId: 'p1' })
    const r = chain({ brandId: 'b2', propertyId: 'p2' })
    expect(tenantAllows(u, r)).toBe(false)
  })
  it('legacy: orgi+brandi neznani, isti property → dovoljeno', () => {
    const u = chain({ propertyId: 'p1' })
    const r = chain({ propertyId: 'p1', locationId: 'l2' })
    expect(tenantAllows(u, r)).toBe(true)
  })
  it('brez vsake primerjave (obe prazni) → legacy passthrough', () => {
    expect(tenantAllows(chain({}), chain({}))).toBe(true)
  })
})

describe('tenant isolation — enterpriseAllows ohranja hierarhična pravila (#11 regresija guard)', () => {
  const user = { role: 'group_owner', loc: 'lA1' as string | null }
  it('group_owner čez lokacije ISTE org: dovoljeno', () => {
    const userChain: EnterpriseChain = chain({ organizationId: 'orgA', locationId: 'lA1' })
    const resource: EnterpriseChain = chain({ organizationId: 'orgA', locationId: 'lA2' })
    expect(enterpriseAllows(user, resource, userChain)).toBe(true)
  })
  it('group_owner na TUJO org: zavrnjeno (cross-tenant)', () => {
    const userChain: EnterpriseChain = chain({ organizationId: 'orgA', locationId: 'lA1' })
    const resource: EnterpriseChain = chain({ organizationId: 'orgB', locationId: 'lB1' })
    expect(enterpriseAllows(user, resource, userChain)).toBe(false)
  })
  it('waiter na tujo lokacijo: zavrnjeno (lokacijska vloga)', () => {
    const waiter = { role: 'waiter', loc: 'lA1' as string | null }
    const userChain: EnterpriseChain = chain({ organizationId: 'orgA', locationId: 'lA1' })
    const resource: EnterpriseChain = chain({ organizationId: 'orgA', locationId: 'lA2' })
    expect(enterpriseAllows(waiter, resource, userChain)).toBe(false)
  })
  it('fail-closed: uporabnik brez verige → zavrnjeno', () => {
    const resource: EnterpriseChain = chain({ organizationId: 'orgA', locationId: 'lA1' })
    expect(enterpriseAllows(user, resource, null)).toBe(false)
  })
})
